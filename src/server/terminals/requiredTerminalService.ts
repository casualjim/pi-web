import type {
  TerminalCommandRun,
  TerminalCommandRunFilter,
  TerminalInfo,
  TerminalUiEvent,
} from "../../shared/apiTypes.js";

export interface TerminalWorkspaceScope {
  projectId: string;
  workspaceId: string;
  cwd: string;
}

export interface CreateTerminalOptions extends TerminalWorkspaceScope {
  name?: string;
  cols?: number;
  rows?: number;
}

export interface RunTerminalCommandOptions extends TerminalWorkspaceScope {
  origin: string;
  title: string;
  command: string;
  metadata?: unknown;
  cols?: number;
  rows?: number;
}

export interface RequiredTerminalActivitySink {
  updateTerminal(terminal: Pick<TerminalInfo, "id" | "cwd" | "exited">): void;
  removeTerminal(terminalId: string, cwd?: string): void;
  publish(event: TerminalUiEvent): void;
}

/** Temporary adapter for the legacy Terminal HTTP/WebSocket routes. */
export interface LegacyTerminalRouteService {
  list(scope: TerminalWorkspaceScope): TerminalInfo[];
  create(options: CreateTerminalOptions): TerminalInfo;
  closeForCwd(cwd: string): void;
  closeAll(scope: TerminalWorkspaceScope): void;
  close(scope: TerminalWorkspaceScope, id: string): void;
  attach(
    scope: TerminalWorkspaceScope,
    id: string,
    handlers: {
      output(data: string, replay: boolean): void;
      exit(exitCode: number | undefined): void;
      closed?(): void;
    },
  ): () => void;
  write(scope: TerminalWorkspaceScope, id: string, data: string): void;
  resize(scope: TerminalWorkspaceScope, id: string, cols: number, rows: number): void;
  continue(scope: TerminalWorkspaceScope, id: string): TerminalInfo;
  runCommand(options: RunTerminalCommandOptions): TerminalCommandRun;
  listCommandRuns(filter?: TerminalCommandRunFilter): TerminalCommandRun[];
  getCommandRun(runId: string): TerminalCommandRun | undefined;
  cancelCommandRun(runId: string): TerminalCommandRun;
}

/**
 * Hard-coded composition port supplied only by the required bundled Terminal
 * server entry. `legacyRoutes` exists only until browser transport cutover.
 */
export interface RequiredTerminalService {
  closeForCwd(cwd: string): void;
  runCommand(options: RunTerminalCommandOptions): TerminalCommandRun;
  bindActivitySink(sink: RequiredTerminalActivitySink): void;
  readonly legacyRoutes: LegacyTerminalRouteService;
}

export class RequiredTerminalUnavailableError extends Error {
  override name = "RequiredTerminalUnavailableError";
}

export function snapshotRequiredTerminalService(value: unknown): RequiredTerminalService {
  if (!isRequiredTerminalService(value)) {
    throw new Error("Required Terminal server activation must expose a valid requiredTerminalService");
  }
  const legacyRoutes = snapshotLegacyRoutes(value.legacyRoutes);
  const closeForCwd = value.closeForCwd.bind(value);
  const runCommand = value.runCommand.bind(value);
  const bindActivitySink = value.bindActivitySink.bind(value);
  return Object.freeze({
    closeForCwd: (cwd: string) => { closeForCwd(cwd); },
    runCommand: (options: RunTerminalCommandOptions) => runCommand(options),
    bindActivitySink: (sink: RequiredTerminalActivitySink) => {
      bindActivitySink(Object.freeze({
        updateTerminal: (terminal: Pick<TerminalInfo, "id" | "cwd" | "exited">) => { sink.updateTerminal(terminal); },
        removeTerminal: (terminalId: string, cwd?: string) => { sink.removeTerminal(terminalId, cwd); },
        publish: (event: TerminalUiEvent) => { sink.publish(event); },
      }));
    },
    legacyRoutes,
  });
}

export function unavailableRequiredTerminalService(): RequiredTerminalService {
  const unavailable = (): never => {
    throw new RequiredTerminalUnavailableError(
      "Terminal is unavailable while server-plugin safe start is set to none",
    );
  };
  const legacyRoutes: LegacyTerminalRouteService = Object.freeze({
    list: unavailable,
    create: unavailable,
    closeForCwd: unavailable,
    closeAll: unavailable,
    close: unavailable,
    attach: unavailable,
    write: unavailable,
    resize: unavailable,
    continue: unavailable,
    runCommand: unavailable,
    listCommandRuns: unavailable,
    getCommandRun: unavailable,
    cancelCommandRun: unavailable,
  });
  return Object.freeze({
    closeForCwd: unavailable,
    runCommand: unavailable,
    bindActivitySink: () => undefined,
    legacyRoutes,
  });
}

function snapshotLegacyRoutes(routes: LegacyTerminalRouteService): LegacyTerminalRouteService {
  const list = routes.list.bind(routes);
  const create = routes.create.bind(routes);
  const closeForCwd = routes.closeForCwd.bind(routes);
  const closeAll = routes.closeAll.bind(routes);
  const close = routes.close.bind(routes);
  const attach = routes.attach.bind(routes);
  const write = routes.write.bind(routes);
  const resize = routes.resize.bind(routes);
  const continueTerminal = routes.continue.bind(routes);
  const runCommand = routes.runCommand.bind(routes);
  const listCommandRuns = routes.listCommandRuns.bind(routes);
  const getCommandRun = routes.getCommandRun.bind(routes);
  const cancelCommandRun = routes.cancelCommandRun.bind(routes);
  return Object.freeze({
    list,
    create,
    closeForCwd,
    closeAll,
    close,
    attach,
    write,
    resize,
    continue: continueTerminal,
    runCommand,
    listCommandRuns,
    getCommandRun,
    cancelCommandRun,
  });
}

function isRequiredTerminalService(value: unknown): value is RequiredTerminalService {
  return isRecord(value)
    && typeof value["closeForCwd"] === "function"
    && typeof value["runCommand"] === "function"
    && typeof value["bindActivitySink"] === "function"
    && isLegacyTerminalRouteService(value["legacyRoutes"]);
}

function isLegacyTerminalRouteService(value: unknown): value is LegacyTerminalRouteService {
  if (!isRecord(value)) return false;
  return [
    "list",
    "create",
    "closeForCwd",
    "closeAll",
    "close",
    "attach",
    "write",
    "resize",
    "continue",
    "runCommand",
    "listCommandRuns",
    "getCommandRun",
    "cancelCommandRun",
  ].every((key) => typeof value[key] === "function");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
