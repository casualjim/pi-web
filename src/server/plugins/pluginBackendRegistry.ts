import { isAbsolute, resolve } from "node:path";
import type {
  JsonObject,
  JsonValue,
  PairedPluginRequestContext,
  PairedPluginWorkspace,
  ProjectInput,
  WorkspaceProviderMetadata,
} from "../../server-plugin-api.js";
import { isPiWebPluginId } from "../../shared/pluginIds.js";
import {
  cloneBoundedPluginBackendJson,
  PLUGIN_BACKEND_DISPATCH_TIMEOUT_MS,
  PLUGIN_BACKEND_REQUEST_TIMEOUT_MS,
  PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES,
  requirePluginBackendOperation,
  requirePluginBackendRevision,
} from "../../shared/pluginBackendProtocol.js";
import type { WorkspaceListing } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";
import type {
  ServerPluginHealthInspection,
  ServerPluginPairedBackendContribution,
} from "./serverPluginRuntime.js";
import {
  PluginBackendRequestError,
  type PluginBackendRequest,
  type WorkspaceProviderRegistry,
} from "../workspaces/workspaceProviderRegistry.js";

export interface PluginBackendRegistryOptions {
  /** Healthy direct contributions from one immutable server-plugin snapshot. */
  contributions: readonly ServerPluginPairedBackendContribution[];
  /** Authoritative workspace resolver and legacy owner-backed request fallback. */
  workspaces: Pick<WorkspaceProviderRegistry, "resolve" | "request">;
  callbackTimeoutMs?: number;
  dispatchTimeoutMs?: number;
}

/** Keep active paired backends whose bounded startup health is not unhealthy. */
export function eligiblePluginBackendContributions(
  contributions: readonly ServerPluginPairedBackendContribution[],
  inspections: readonly ServerPluginHealthInspection[],
): readonly ServerPluginPairedBackendContribution[] {
  const healthByPluginId = new Map(inspections.map(({ pluginId, health }) => [pluginId, health.status]));
  return Object.freeze(contributions.filter(({ pluginId }) => {
    const status = healthByPluginId.get(pluginId);
    return status === "healthy" || status === "degraded";
  }));
}

/**
 * Dispatches a browser plugin only to its revision-matched server entry. Direct
 * paired backends may address any host-resolved workspace; older provider
 * backends retain their owner-only behavior through the explicit fallback.
 */
export class PluginBackendRegistry {
  private readonly contributions: readonly ServerPluginPairedBackendContribution[];
  private readonly callbackTimeoutMs: number;
  private readonly dispatchTimeoutMs: number;

  constructor(private readonly options: PluginBackendRegistryOptions) {
    this.contributions = snapshotContributions(options.contributions);
    this.callbackTimeoutMs = positiveInteger(
      options.callbackTimeoutMs,
      PLUGIN_BACKEND_REQUEST_TIMEOUT_MS,
      "callbackTimeoutMs",
    );
    this.dispatchTimeoutMs = positiveInteger(
      options.dispatchTimeoutMs,
      PLUGIN_BACKEND_DISPATCH_TIMEOUT_MS,
      "dispatchTimeoutMs",
    );
  }

  async request(request: PluginBackendRequest, signal?: AbortSignal): Promise<JsonValue> {
    try {
      return await runBoundedPluginBackendOperation(
        request.pluginId,
        "dispatch",
        this.dispatchTimeoutMs,
        (dispatchSignal) => this.dispatch(request, dispatchSignal),
        signal,
      );
    } catch (error) {
      if (signal?.aborted === true) {
        throw backendError(
          "request-cancelled",
          499,
          `Server plugin ${request.pluginId} backend request was cancelled`,
          error,
        );
      }
      if (error instanceof PluginBackendTimeoutError) {
        throw backendError("request-timeout", 504, boundedErrorMessage(error), error);
      }
      throw error;
    }
  }

  private async dispatch(request: PluginBackendRequest, dispatchSignal: AbortSignal): Promise<JsonValue> {
    const pluginId = parsePluginId(request.pluginId);
    const operation = parseOperation(request.operation);
    const moduleRevision = parseRevision(request.moduleRevision, operation);
    const input = parseInput(request.input, pluginId, operation);
    const contribution = this.contributions.find((candidate) => candidate.pluginId === pluginId);

    if (contribution === undefined) {
      return await this.options.workspaces.request({
        ...request,
        pluginId,
        moduleRevision,
        operation,
        input,
      }, dispatchSignal);
    }
    if (contribution.moduleRevision !== moduleRevision) {
      throw backendError(
        "stale-plugin-revision",
        409,
        `Server plugin ${pluginId} backend revision is stale for operation ${operation}; reload after the session daemon restarts`,
      );
    }
    if (request.workspaceId === "") {
      throw backendError(
        "workspace-not-found",
        404,
        `Workspace not found for server plugin ${pluginId} operation ${operation}`,
      );
    }

    const project = snapshotProject(request.project);
    let target: WorkspaceListing | undefined;
    try {
      const resolution = await this.options.workspaces.resolve(request.project, dispatchSignal);
      target = resolution.workspaces.find((workspace) => workspace.id === request.workspaceId);
    } catch (error) {
      if (dispatchSignal.aborted) throw abortError(dispatchSignal);
      throw backendError(
        "resolution-failed",
        502,
        `Server plugin ${pluginId} could not resolve workspace scope for operation ${operation}: ${boundedErrorMessage(error)}`,
        error,
      );
    }
    if (target === undefined) {
      throw backendError(
        "workspace-not-found",
        404,
        `Workspace ${request.workspaceId} is stale or unavailable for server plugin ${pluginId} operation ${operation}`,
      );
    }

    let workspace: PairedPluginWorkspace;
    try {
      workspace = snapshotWorkspace(target, project.id);
    } catch (error) {
      throw backendError(
        "invalid-scope",
        502,
        `Server plugin ${pluginId} received an invalid host workspace scope for operation ${operation}: ${boundedErrorMessage(error)}`,
        error,
      );
    }
    const context: PairedPluginRequestContext = Object.freeze({
      project,
      workspace,
      operation,
      input,
      signal: dispatchSignal,
    });
    let result: unknown;
    try {
      result = await runBoundedPluginBackendOperation(
        pluginId,
        operation,
        this.callbackTimeoutMs,
        (callbackSignal) => contribution.backend.request(Object.freeze({ ...context, signal: callbackSignal })),
        dispatchSignal,
      );
    } catch (error) {
      if (dispatchSignal.aborted) throw abortError(dispatchSignal);
      if (error instanceof PluginBackendTimeoutError) {
        throw backendError("request-timeout", 504, boundedErrorMessage(error), error);
      }
      throw backendError(
        "request-failed",
        502,
        `Server plugin ${pluginId} operation ${operation} failed: ${boundedErrorMessage(error)}`,
        error,
      );
    }

    try {
      return cloneBoundedPluginBackendJson(
        result,
        `Server plugin ${pluginId} operation ${operation} result`,
        PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES,
      );
    } catch (error) {
      throw backendError("invalid-result", 502, boundedErrorMessage(error), error);
    }
  }
}

function snapshotContributions(
  contributions: readonly ServerPluginPairedBackendContribution[],
): readonly ServerPluginPairedBackendContribution[] {
  const sorted = [...contributions].sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]?.pluginId === sorted[index]?.pluginId) {
      throw new Error(`Duplicate paired plugin backend contribution: ${String(sorted[index]?.pluginId)}`);
    }
  }
  return Object.freeze(sorted);
}

function parsePluginId(value: string): string {
  if (!isPiWebPluginId(value)) {
    throw backendError("inactive-plugin", 409, `Server plugin is not active: ${value}`);
  }
  return value;
}

function parseOperation(value: string): string {
  try {
    return requirePluginBackendOperation(value);
  } catch (error) {
    throw backendError("invalid-operation", 400, boundedErrorMessage(error), error);
  }
}

function parseRevision(value: string, operation: string): string {
  try {
    return requirePluginBackendRevision(value);
  } catch (error) {
    throw backendError(
      "stale-plugin-revision",
      409,
      `Plugin backend revision is unavailable for operation ${operation}: ${boundedErrorMessage(error)}`,
      error,
    );
  }
}

function parseInput(value: unknown, pluginId: string, operation: string): JsonValue {
  try {
    return cloneBoundedPluginBackendJson(value, `Server plugin ${pluginId} operation ${operation} input`);
  } catch (error) {
    throw backendError("invalid-input", 400, boundedErrorMessage(error), error);
  }
}

function snapshotProject(project: Project): ProjectInput {
  if (typeof project.id !== "string" || project.id === "") {
    throw backendError("invalid-scope", 500, "Project id must be a non-empty string");
  }
  if (typeof project.name !== "string" || project.name === "") {
    throw backendError("invalid-scope", 500, "Project name must be a non-empty string");
  }
  if (!isAbsolute(project.path)) {
    throw backendError("invalid-scope", 500, "Project path must be absolute");
  }
  return Object.freeze({ id: project.id, name: project.name, path: resolve(project.path) });
}

function snapshotWorkspace(workspace: WorkspaceListing, projectId: string): PairedPluginWorkspace {
  if (workspace.id === "") throw new Error("Workspace id must be non-empty");
  if (workspace.projectId !== projectId) throw new Error("Workspace project scope does not match the resolved project");
  if (!isAbsolute(workspace.path)) throw new Error("Workspace path must be absolute");
  if (workspace.label === "") throw new Error("Workspace label must be non-empty");
  const provider = workspace.provider === undefined ? undefined : snapshotProvider(workspace.provider);
  return Object.freeze({
    id: workspace.id,
    projectId: workspace.projectId,
    path: resolve(workspace.path),
    label: workspace.label,
    isMain: workspace.isMain,
    ...(provider === undefined ? {} : { provider }),
  });
}

function snapshotProvider(provider: WorkspaceProviderMetadata): WorkspaceProviderMetadata {
  if (!isPiWebPluginId(provider.pluginId)) throw new Error("Workspace provider plugin id is invalid");
  const metadata = provider.metadata === undefined
    ? undefined
    : cloneJsonObject(provider.metadata, "Workspace provider public metadata");
  return Object.freeze({
    pluginId: provider.pluginId,
    capabilities: Object.freeze({ ...provider.capabilities }),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function cloneJsonObject(value: JsonObject, label: string): JsonObject {
  const cloned = cloneBoundedPluginBackendJson(value, label);
  if (!isJsonObject(cloned)) throw new Error(`${label} must be a JSON object`);
  return cloned;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function runBoundedPluginBackendOperation<T>(
  pluginId: string,
  operation: string,
  timeoutMs: number,
  callback: (signal: AbortSignal) => T | Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = (): void => {
    if (parentSignal !== undefined && !controller.signal.aborted) {
      controller.abort(abortError(parentSignal));
    }
  };
  if (parentSignal?.aborted === true) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const timeoutError = new PluginBackendTimeoutError(
    `Server plugin ${pluginId} operation ${operation} timed out after ${String(timeoutMs)}ms`,
  );
  const timeout = setTimeout(() => { controller.abort(timeoutError); }, timeoutMs);
  timeout.unref();
  const deadline = controller.signal.aborted
    ? Promise.reject(abortError(controller.signal))
    : new Promise<never>((_resolve, rejectPromise) => {
        controller.signal.addEventListener("abort", () => { rejectPromise(abortError(controller.signal)); }, { once: true });
      });
  const result = controller.signal.aborted
    ? new Promise<T>(() => { /* An existing cancellation already won. */ })
    : Promise.resolve().then(() => callback(controller.signal));
  try {
    return await Promise.race([result, deadline]);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
    if (!controller.signal.aborted) {
      controller.abort(new DOMException("Plugin backend operation completed", "AbortError"));
    }
  }
}

function backendError(
  code: ConstructorParameters<typeof PluginBackendRequestError>[0],
  statusCode: number,
  message: string,
  cause?: unknown,
): PluginBackendRequestError {
  return new PluginBackendRequestError(code, statusCode, message, cause === undefined ? {} : { cause });
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("Plugin backend operation aborted", { cause: reason });
}

function positiveInteger(value: number | undefined, fallback: number, key: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`${key} must be a positive integer`);
  return resolved;
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 2_048 ? message : `${message.slice(0, 2_045)}...`;
}

class PluginBackendTimeoutError extends Error {
  override name = "TimeoutError";
}
