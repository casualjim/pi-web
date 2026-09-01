import type { FastifyInstance, FastifyReply } from "fastify";
import type { RawData } from "ws";
import type {
  TerminalCommandRunFilter,
  TerminalCommandRunStatus,
} from "../../shared/apiTypes.js";
import { normalizeRequestCwd } from "../workingDirectory.js";
import {
  RequiredTerminalUnavailableError,
  type LegacyTerminalRouteService,
  type RunTerminalCommandOptions,
  type TerminalWorkspaceScope,
} from "./requiredTerminalService.js";
import { parseTerminalSize } from "./terminalSize.js";

export type TerminalRouteService = LegacyTerminalRouteService;

export function registerTerminalRoutes(app: FastifyInstance, terminals: TerminalRouteService, prefix = ""): void {
  app.get<{ Querystring: TerminalScopeQuery }>(`${prefix}/terminals`, (request, reply) => {
    try {
      return terminals.list(parseScope(request.query));
    } catch (error) {
      return sendTerminalError(reply, error);
    }
  });

  app.post<{ Body: TerminalCreateBody }>(`${prefix}/terminals`, (request, reply) => {
    try {
      const scope = parseScope(request.body);
      return terminals.create({
        ...scope,
        ...(request.body.name === undefined ? {} : { name: request.body.name }),
        ...(request.body.cols === undefined ? {} : { cols: request.body.cols }),
        ...(request.body.rows === undefined ? {} : { rows: request.body.rows }),
      });
    } catch (error) {
      return sendTerminalError(reply, error);
    }
  });

  app.delete<{ Querystring: TerminalScopeQuery }>(`${prefix}/terminals`, (request, reply) => {
    try {
      terminals.closeAll(parseScope(request.query));
      return { closed: true };
    } catch (error) {
      return sendTerminalError(reply, error);
    }
  });

  app.post<{ Body: RunTerminalCommandOptions }>(`${prefix}/terminal-command-runs`, (request, reply) => {
    try {
      return terminals.runCommand({ ...request.body, cwd: normalizeRequestCwd(request.body.cwd) });
    } catch (error) {
      return sendTerminalError(reply, error);
    }
  });

  app.get<{ Querystring: TerminalCommandRunQuery }>(`${prefix}/terminal-command-runs`, (request, reply) => {
    try {
      return terminals.listCommandRuns(parseCommandRunFilter(request.query));
    } catch (error) {
      return sendTerminalError(reply, error);
    }
  });

  app.post<{ Params: { runId: string } }>(`${prefix}/terminal-command-runs/:runId/cancel`, (request, reply) => {
    try {
      return terminals.cancelCommandRun(request.params.runId);
    } catch (error) {
      return sendTerminalError(reply, error);
    }
  });

  app.get<{ Params: { runId: string } }>(`${prefix}/terminal-command-runs/:runId`, (request, reply) => {
    try {
      const run = terminals.getCommandRun(request.params.runId);
      if (run === undefined) return reply.code(404).send({ error: "Terminal command run not found" });
      return run;
    } catch (error) {
      return sendTerminalError(reply, error);
    }
  });

  app.post<{ Params: { terminalId: string }; Body: TerminalScopeBody }>(`${prefix}/terminals/:terminalId/continue`, (request, reply) => {
    try {
      return terminals.continue(parseScope(request.body), request.params.terminalId);
    } catch (error) {
      return sendTerminalError(reply, error);
    }
  });

  app.delete<{ Params: { terminalId: string }; Querystring: TerminalScopeQuery }>(`${prefix}/terminals/:terminalId`, (request, reply) => {
    try {
      terminals.close(parseScope(request.query), request.params.terminalId);
      return { closed: true };
    } catch (error) {
      return sendTerminalError(reply, error);
    }
  });

  app.get<{
    Params: { terminalId: string };
    Querystring: TerminalScopeQuery & { cols?: string; rows?: string };
  }>(`${prefix}/terminals/:terminalId/socket`, { websocket: true }, (socket, request) => {
    let detach: () => void = () => undefined;
    try {
      const scope = parseScope(request.query);
      const initialSize = parseTerminalSize(request.query.cols, request.query.rows);
      if (initialSize !== undefined) terminals.resize(scope, request.params.terminalId, initialSize.cols, initialSize.rows);
      detach = terminals.attach(scope, request.params.terminalId, {
        output: (data, replay) => { socket.send(JSON.stringify({ type: "output", data, replay })); },
        exit: (exitCode) => { socket.send(JSON.stringify({ type: "exit", exitCode })); },
        closed: () => { socket.close(1000, "Terminal closed"); },
      });
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", message: errorMessage(error) }));
      socket.close();
      return;
    }

    const close = (): void => { detach(); };
    socket.on("message", (data) => {
      try {
        const scope = parseScope(request.query);
        const message = parseClientMessage(data);
        if (message.type === "input") terminals.write(scope, request.params.terminalId, message.data);
        if (message.type === "resize") terminals.resize(scope, request.params.terminalId, message.cols, message.rows);
      } catch (error) {
        socket.send(JSON.stringify({ type: "error", message: errorMessage(error) }));
      }
    });
    socket.on("close", close);
    socket.on("error", close);
  });
}

type ClientTerminalMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

interface TerminalScopeBody {
  projectId: string;
  workspaceId: string;
  cwd: string;
}

interface TerminalCreateBody extends TerminalScopeBody {
  name?: string;
  cols?: number;
  rows?: number;
}

interface TerminalScopeQuery {
  projectId?: string;
  workspaceId?: string;
  cwd?: string;
}

interface TerminalCommandRunQuery {
  projectId?: string;
  workspaceId?: string;
  terminalId?: string;
  statuses?: string;
  metadata?: string;
}

function parseScope(value: TerminalScopeQuery | TerminalScopeBody): TerminalWorkspaceScope {
  if (value.projectId === undefined || value.projectId === "") throw new Error("projectId is required");
  if (value.workspaceId === undefined || value.workspaceId === "") throw new Error("workspaceId is required");
  if (value.cwd === undefined || value.cwd === "") throw new Error("cwd is required");
  return {
    projectId: value.projectId,
    workspaceId: value.workspaceId,
    cwd: normalizeRequestCwd(value.cwd),
  };
}

function parseCommandRunFilter(query: TerminalCommandRunQuery): TerminalCommandRunFilter {
  const metadata = query.metadata === undefined || query.metadata === "" ? undefined : parseMetadataFilter(query.metadata);
  const statuses = query.statuses === undefined || query.statuses === "" ? undefined : query.statuses.split(",").filter((status) => status !== "").map(parseCommandRunStatus);
  return {
    ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
    ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }),
    ...(query.terminalId === undefined ? {} : { terminalId: query.terminalId }),
    ...(statuses === undefined ? {} : { statuses }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function parseCommandRunStatus(value: string): TerminalCommandRunStatus {
  if (value !== "queued" && value !== "running" && value !== "succeeded" && value !== "failed") throw new Error(`Invalid command run status: ${value}`);
  return value;
}

function parseMetadataFilter(value: string): Record<string, string> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("metadata filter must be an object");
  return Object.fromEntries(Object.entries(parsed).map(([key, metadataValue]) => {
    if (typeof metadataValue !== "string") throw new Error(`metadata filter value must be a string: ${key}`);
    return [key, metadataValue];
  }));
}

function parseClientMessage(data: RawData): ClientTerminalMessage {
  const value: unknown = JSON.parse(rawDataToString(data));
  if (!isRecord(value) || typeof value["type"] !== "string") throw new Error("Invalid terminal message");
  if (value["type"] === "input" && typeof value["data"] === "string") return { type: "input", data: value["data"] };
  if (value["type"] === "resize" && typeof value["cols"] === "number" && typeof value["rows"] === "number") return { type: "resize", cols: value["cols"], rows: value["rows"] };
  throw new Error("Invalid terminal message");
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

function sendTerminalError(reply: FastifyReply, error: unknown): FastifyReply {
  const statusCode = error instanceof RequiredTerminalUnavailableError ? 503 : 400;
  return reply.code(statusCode).send({ error: errorMessage(error) });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
