import type { FastifyInstance } from "fastify";
import { WebSocket, type RawData } from "ws";
import type { JsonValue } from "../../shared/apiTypes.js";
import { isPiWebPluginId } from "../../shared/pluginIds.js";
import {
  boundedPluginBackendChannelCloseReason,
  parsePluginBackendChannelClientEnvelope,
  PLUGIN_BACKEND_CHANNEL_ERROR_MESSAGE_MAX_BYTES,
  PLUGIN_BACKEND_CHANNEL_OPEN_TIMEOUT_MS,
  PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_BYTES,
  PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES,
  PLUGIN_BACKEND_CHANNEL_ROUTE_PATH,
  requirePluginBackendOperation,
  serializePluginBackendChannelDataEnvelope,
  serializePluginBackendChannelErrorEnvelope,
  serializePluginBackendChannelReadyEnvelope,
  utf8ByteLength,
} from "../../shared/pluginBackendProtocol.js";
import {
  PluginBackendChannelError,
  type PluginBackendChannelSession,
  type PluginBackendChannelTransport,
} from "../plugins/pluginBackendRegistry.js";
import { createBoundedTextWebSocketSender } from "../webSocketBridge.js";
import type { Project } from "../types.js";
import type { PluginBackendProjectReader } from "./pluginBackendRoutes.js";

interface PluginBackendChannelRouteParams {
  pluginId: string;
  projectId: string;
  workspaceId: string;
  operation: string;
}

export interface PluginBackendChannelDispatcher {
  openChannel(
    request: {
      pluginId: string;
      moduleRevision: string;
      project: Project;
      workspaceId: string;
      operation: string;
      input: unknown;
    },
    transport: PluginBackendChannelTransport,
    signal?: AbortSignal,
  ): Promise<PluginBackendChannelSession>;
}

export interface PluginBackendChannelRouteDependencies {
  projects: PluginBackendProjectReader;
  backends: PluginBackendChannelDispatcher;
}

/** Sessiond-owned endpoint for one scoped, revision-paired plugin channel. */
export function registerPluginBackendChannelRoutes(
  app: FastifyInstance,
  dependencies: PluginBackendChannelRouteDependencies,
  prefix = "",
): void {
  app.get<{ Params: PluginBackendChannelRouteParams }>(
    `${prefix}${PLUGIN_BACKEND_CHANNEL_ROUTE_PATH}`,
    { websocket: true },
    (socket, request) => {
      const controller = new PluginBackendChannelSocketController(socket, request.params, dependencies, app.log);
      controller.start();
    },
  );
}

class PluginBackendChannelSocketController {
  private readonly lifetime = new AbortController();
  private readonly writer: ChannelRouteWriter;
  private readonly handshakeTimer: ReturnType<typeof setTimeout>;
  private state: "awaiting-open" | "opening" | "ready" | "closed" = "awaiting-open";
  private session: PluginBackendChannelSession | undefined;
  private readonly incoming: PendingIncomingFrame[] = [];
  private incomingBytes = 0;
  private draining = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly params: PluginBackendChannelRouteParams,
    private readonly dependencies: PluginBackendChannelRouteDependencies,
    private readonly logger: { error(details: Record<string, unknown>, message: string): void },
  ) {
    this.writer = new ChannelRouteWriter(socket, (error) => {
      void this.fail("queue-overflow", boundedErrorMessage(error), 1013);
    });
    this.handshakeTimer = setTimeout(() => {
      void this.fail("open-timeout", "Plugin backend channel open handshake timed out", 1011);
    }, PLUGIN_BACKEND_CHANNEL_OPEN_TIMEOUT_MS);
    this.handshakeTimer.unref();
  }

  start(): void {
    this.socket.on("message", (data, isBinary) => {
      this.onMessage(data, isBinary);
    });
    this.socket.once("close", (code, reason) => {
      void this.onClosed(code, decodeCloseReason(reason));
    });
    this.socket.once("error", (error) => {
      void this.fail("transport-error", `Plugin backend channel transport failed: ${boundedErrorMessage(error)}`, 1011);
    });

    try {
      if (!isPiWebPluginId(this.params.pluginId)) throw new Error(`Invalid PI WEB plugin id: ${this.params.pluginId}`);
      this.params.operation = requirePluginBackendOperation(this.params.operation);
      if (this.params.projectId === "") throw new Error("Project id is required");
      if (this.params.workspaceId === "") throw new Error("Workspace id is required");
    } catch (error) {
      void this.fail("invalid-request", boundedErrorMessage(error), 1008);
    }
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (this.state === "closed") return;
    if (isBinary) {
      void this.fail("binary-frame", "Plugin backend channels accept text JSON frames only", 1003);
      return;
    }

    let text: string;
    let envelope: ReturnType<typeof parsePluginBackendChannelClientEnvelope>;
    try {
      text = decodeTextFrame(data);
      envelope = parsePluginBackendChannelClientEnvelope(text);
    } catch (error) {
      void this.fail("invalid-frame", boundedErrorMessage(error), 1008);
      return;
    }

    if (this.state === "awaiting-open") {
      if (envelope.kind !== "open") {
        void this.fail("open-required", "The first plugin backend channel frame must be an open envelope", 1008);
        return;
      }
      this.state = "opening";
      void this.open(envelope.revision, envelope.input);
      return;
    }
    if (this.state !== "ready" || envelope.kind !== "data") {
      void this.fail("unexpected-frame", "Plugin backend channel data is allowed only after the ready envelope", 1008);
      return;
    }
    this.enqueueIncoming(envelope.data, utf8ByteLength(text));
  }

  private async open(revision: string, input: JsonValue): Promise<void> {
    try {
      const project = await this.dependencies.projects.requireProject(this.params.projectId);
      const session = await this.dependencies.backends.openChannel({
        pluginId: this.params.pluginId,
        moduleRevision: revision,
        project,
        workspaceId: this.params.workspaceId,
        operation: this.params.operation,
        input,
      }, this.writer, this.lifetime.signal);
      this.session = session;
      if (this.state === "closed") {
        await session.close(1001, "Browser disconnected during channel open");
        return;
      }
      clearTimeout(this.handshakeTimer);
      this.state = "ready";
      this.writer.ready();
    } catch (error) {
      if (this.state === "closed") return;
      if (error instanceof PluginBackendChannelError) {
        await this.fail(error.code, error.message, error.closeCode);
        return;
      }
      const projectMissing = error instanceof Error && error.message === "Project not found";
      await this.fail(
        projectMissing ? "project-not-found" : "open-failed",
        projectMissing ? "Project not found" : `Plugin backend channel failed to open: ${boundedErrorMessage(error)}`,
        projectMissing ? 1008 : 1011,
      );
    }
  }

  private enqueueIncoming(data: JsonValue, bytes: number): void {
    if (this.incoming.length >= PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES || this.incomingBytes + bytes > PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_BYTES) {
      void this.fail("queue-overflow", "Plugin backend channel browser queue limit was exceeded", 1013);
      return;
    }
    this.incoming.push({ data, bytes });
    this.incomingBytes += bytes;
    if (!this.draining) void this.drainIncoming();
  }

  private async drainIncoming(): Promise<void> {
    this.draining = true;
    try {
      while (this.state === "ready") {
        const next = this.incoming[0];
        if (next === undefined) return;
        try {
          await this.session?.receive(next.data);
        } catch (error) {
          if (error instanceof PluginBackendChannelError) await this.fail(error.code, error.message, error.closeCode);
          else await this.fail("receive-failed", boundedErrorMessage(error), 1011);
          return;
        } finally {
          if (this.incoming[0] === next) {
            this.incoming.shift();
            this.incomingBytes -= next.bytes;
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async fail(code: string, message: string, closeCode: number): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    clearTimeout(this.handshakeTimer);
    if (!this.lifetime.signal.aborted) this.lifetime.abort(new Error(message));
    this.writer.sendError(code, message);
    this.incoming.length = 0;
    this.incomingBytes = 0;
    try {
      await this.session?.close(closeCode, message);
    } catch (error) {
      this.logger.error({ err: error, pluginId: this.params.pluginId, operation: this.params.operation }, "plugin backend channel cleanup failed after transport failure");
    } finally {
      this.writer.close(closeCode, message);
    }
  }

  private async onClosed(code: number, reason: string): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    clearTimeout(this.handshakeTimer);
    if (!this.lifetime.signal.aborted) this.lifetime.abort(new DOMException(reason || "Browser disconnected", "AbortError"));
    this.incoming.length = 0;
    this.incomingBytes = 0;
    try {
      await this.session?.close(code, reason || "Browser disconnected");
    } catch (error) {
      this.logger.error({ err: error, pluginId: this.params.pluginId, operation: this.params.operation }, "plugin backend channel cleanup failed after disconnect");
    }
  }
}

interface PendingIncomingFrame {
  data: JsonValue;
  bytes: number;
}

class ChannelRouteWriter implements PluginBackendChannelTransport {
  private readonly sender: ReturnType<typeof createBoundedTextWebSocketSender>;
  private readonly pending: { text: string; bytes: number }[] = [];
  private pendingBytes = 0;
  private isReady = false;
  private closed = false;

  constructor(private readonly socket: WebSocket, onFailure: (error: unknown) => void) {
    this.sender = createBoundedTextWebSocketSender(socket, { onOverflow: onFailure });
  }

  send(data: JsonValue): void {
    const text = serializePluginBackendChannelDataEnvelope(data);
    if (this.closed) throw new Error("Plugin backend channel transport is closed");
    if (this.isReady) {
      this.sender(text);
      return;
    }
    const bytes = utf8ByteLength(text);
    const readyBytes = utf8ByteLength(serializePluginBackendChannelReadyEnvelope());
    if (this.pending.length >= PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES - 1 || this.pendingBytes + bytes + readyBytes > PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_BYTES) {
      throw new Error("Plugin backend channel plugin queue limit was exceeded");
    }
    this.pending.push({ text, bytes });
    this.pendingBytes += bytes;
  }

  sendError(code: string, message: string): void {
    if (this.closed) return;
    this.pending.length = 0;
    this.pendingBytes = 0;
    try {
      this.sender(serializePluginBackendChannelErrorEnvelope(code, boundedChannelErrorMessage(message)));
    } catch {
      // A closing or overflowing transport cannot carry another attributed envelope.
    }
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    closeSocket(this.socket, code, reason);
  }

  ready(): void {
    if (this.closed || this.isReady) return;
    this.isReady = true;
    this.sender(serializePluginBackendChannelReadyEnvelope());
    for (const frame of this.pending) this.sender(frame.text);
    this.pending.length = 0;
    this.pendingBytes = 0;
  }
}

function decodeTextFrame(data: RawData): string {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : Array.isArray(data)
        ? Buffer.concat(data)
        : data;
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function decodeCloseReason(reason: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(reason);
  } catch {
    return "Invalid close reason";
  }
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) return;
  const boundedReason = boundedPluginBackendChannelCloseReason(reason);
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.once("open", () => { socket.close(code, boundedReason); });
    return;
  }
  socket.close(code, boundedReason);
}

function boundedChannelErrorMessage(value: string): string {
  if (utf8ByteLength(value) <= PLUGIN_BACKEND_CHANNEL_ERROR_MESSAGE_MAX_BYTES) return value || "Plugin backend channel failed";
  let output = "";
  for (const character of value) {
    if (utf8ByteLength(`${output}${character}`) > PLUGIN_BACKEND_CHANNEL_ERROR_MESSAGE_MAX_BYTES) break;
    output += character;
  }
  return output || "Plugin backend channel failed";
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundedChannelErrorMessage(message);
}
