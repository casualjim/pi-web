import { WebSocket } from "ws";
import {
  boundedPluginBackendChannelCloseReason,
  PLUGIN_BACKEND_CHANNEL_MAX_PER_PLUGIN,
  PLUGIN_BACKEND_CHANNEL_MAX_PER_PLUGIN_WORKSPACE,
  PLUGIN_BACKEND_CHANNEL_MAX_TOTAL,
  PLUGIN_BACKEND_CHANNEL_OPEN_TIMEOUT_MS,
  serializePluginBackendChannelErrorEnvelope,
} from "../../shared/pluginBackendProtocol.js";

export interface PluginBackendChannelProxyScope {
  readonly authorityId: string;
  readonly pluginId: string;
  readonly projectId: string;
  readonly workspaceId: string;
}

export interface PluginBackendChannelProxyAdmissionPoolOptions {
  openTimeoutMs?: number;
  maxTotal?: number;
  maxPerPlugin?: number;
  maxPerPluginWorkspace?: number;
}

export interface PluginBackendChannelProxyLease {
  readonly active: boolean;
  /** Resolves when setup fails, the client disconnects, or bridge cleanup completes. */
  readonly released: Promise<void>;
  /** Attach the outbound socket while its WebSocket handshake is still bounded. */
  attachUpstream(upstream: WebSocket): boolean;
  /** Transfer close/error cleanup to the bounded bridge after its listeners exist. */
  bridgeStarted(): void;
  fail(code: number, reason: string): void;
  release(): void;
}

export class PluginBackendChannelProxyAdmissionError extends Error {
  override name = "PluginBackendChannelProxyAdmissionError";

  constructor(
    readonly code: string,
    readonly closeCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Browser/API-process admission is intentionally separate from sessiond's
 * authoritative plugin admission. It bounds sockets while an upstream daemon
 * or federated WebSocket has not completed its own upgrade yet.
 */
export class PluginBackendChannelProxyAdmissionPool {
  private readonly openTimeoutMs: number;
  private readonly maxTotal: number;
  private readonly maxPerPlugin: number;
  private readonly maxPerPluginWorkspace: number;
  private total = 0;
  private readonly byPlugin = new Map<string, number>();
  private readonly byPluginWorkspace = new Map<string, number>();

  constructor(options: PluginBackendChannelProxyAdmissionPoolOptions = {}) {
    this.openTimeoutMs = positiveInteger(options.openTimeoutMs, PLUGIN_BACKEND_CHANNEL_OPEN_TIMEOUT_MS, "openTimeoutMs");
    this.maxTotal = positiveInteger(options.maxTotal, PLUGIN_BACKEND_CHANNEL_MAX_TOTAL, "maxTotal");
    this.maxPerPlugin = positiveInteger(options.maxPerPlugin, PLUGIN_BACKEND_CHANNEL_MAX_PER_PLUGIN, "maxPerPlugin");
    this.maxPerPluginWorkspace = positiveInteger(
      options.maxPerPluginWorkspace,
      PLUGIN_BACKEND_CHANNEL_MAX_PER_PLUGIN_WORKSPACE,
      "maxPerPluginWorkspace",
    );
  }

  get activeCount(): number {
    return this.total;
  }

  admit(client: WebSocket, scope: PluginBackendChannelProxyScope): PluginBackendChannelProxyLease {
    const pluginCount = this.byPlugin.get(scope.pluginId) ?? 0;
    const workspaceKey = proxyWorkspaceKey(scope);
    const workspaceCount = this.byPluginWorkspace.get(workspaceKey) ?? 0;
    if (this.total >= this.maxTotal || pluginCount >= this.maxPerPlugin || workspaceCount >= this.maxPerPluginWorkspace) {
      throw new PluginBackendChannelProxyAdmissionError(
        "admission-denied",
        1013,
        `Server plugin ${scope.pluginId} channel proxy admission limit was reached`,
      );
    }

    this.total += 1;
    this.byPlugin.set(scope.pluginId, pluginCount + 1);
    this.byPluginWorkspace.set(workspaceKey, workspaceCount + 1);
    let counted = true;
    return new ManagedPluginBackendChannelProxyLease(client, this.openTimeoutMs, () => {
      if (!counted) return;
      counted = false;
      this.total -= 1;
      decrementCount(this.byPlugin, scope.pluginId);
      decrementCount(this.byPluginWorkspace, workspaceKey);
    });
  }
}

const poolsByOwner = new WeakMap<object, PluginBackendChannelProxyAdmissionPool>();

/** Share one aggregate proxy limit across local and federated channel routes. */
export function pluginBackendChannelProxyAdmissionPool(owner: object): PluginBackendChannelProxyAdmissionPool {
  const existing = poolsByOwner.get(owner);
  if (existing !== undefined) return existing;
  const created = new PluginBackendChannelProxyAdmissionPool();
  poolsByOwner.set(owner, created);
  return created;
}

/** Send one protocol-attributed rejection before the bounded close. */
export function rejectPluginBackendChannelProxyAdmission(
  socket: WebSocket,
  error: PluginBackendChannelProxyAdmissionError,
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    closeProxySocket(socket, error.closeCode, error.message);
    return;
  }
  try {
    socket.send(serializePluginBackendChannelErrorEnvelope(error.code, error.message), { binary: false });
  } catch {
    // The bounded close below remains authoritative when the error frame cannot be queued.
  }
  closeProxySocket(socket, error.closeCode, error.message);
}

class ManagedPluginBackendChannelProxyLease implements PluginBackendChannelProxyLease {
  private isActive = true;
  private upstream: WebSocket | undefined;
  private resolveReleased: () => void = () => undefined;
  readonly released = new Promise<void>((resolve) => { this.resolveReleased = resolve; });
  private readonly timer: ReturnType<typeof setTimeout>;

  private readonly onClientSetupClosed = (): void => {
    const upstream = this.upstream;
    this.release();
    if (upstream !== undefined) closeProxySocket(upstream, 1001, "Plugin backend channel client disconnected during proxy setup");
  };

  private readonly onUpstreamSetupClosed = (): void => {
    this.release();
    closeProxySocket(this.client, 1011, "Plugin backend channel upstream disconnected during proxy setup");
  };

  private readonly onUpstreamOpen = (): void => {
    clearTimeout(this.timer);
  };

  constructor(
    private readonly client: WebSocket,
    openTimeoutMs: number,
    private readonly releaseCount: () => void,
  ) {
    client.once("close", this.onClientSetupClosed);
    client.once("error", this.onClientSetupClosed);
    this.timer = setTimeout(() => {
      this.fail(1011, `Plugin backend channel proxy handshake timed out after ${String(openTimeoutMs)}ms`);
    }, openTimeoutMs);
    this.timer.unref();
  }

  get active(): boolean {
    return this.isActive;
  }

  attachUpstream(upstream: WebSocket): boolean {
    if (!this.isActive) {
      closeProxySocket(upstream, 1001, "Plugin backend channel proxy setup was cancelled");
      return false;
    }
    this.upstream = upstream;
    if (upstream.readyState === WebSocket.OPEN) {
      clearTimeout(this.timer);
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      upstream.once("open", this.onUpstreamOpen);
    } else {
      this.fail(1011, "Plugin backend channel upstream was not available");
      return false;
    }
    upstream.once("close", this.onUpstreamSetupClosed);
    upstream.once("error", this.onUpstreamSetupClosed);
    return true;
  }

  bridgeStarted(): void {
    if (!this.isActive) return;
    this.client.off("close", this.onClientSetupClosed);
    this.client.off("error", this.onClientSetupClosed);
    this.upstream?.off("close", this.onUpstreamSetupClosed);
    this.upstream?.off("error", this.onUpstreamSetupClosed);
  }

  fail(code: number, reason: string): void {
    if (!this.isActive) return;
    const upstream = this.upstream;
    this.release();
    closeProxySocket(this.client, code, reason);
    if (upstream !== undefined) closeProxySocket(upstream, code, reason);
  }

  release(): void {
    if (!this.isActive) return;
    this.isActive = false;
    clearTimeout(this.timer);
    this.client.off("close", this.onClientSetupClosed);
    this.client.off("error", this.onClientSetupClosed);
    if (this.upstream !== undefined) {
      this.upstream.off("open", this.onUpstreamOpen);
      this.upstream.off("close", this.onUpstreamSetupClosed);
      this.upstream.off("error", this.onUpstreamSetupClosed);
    }
    this.releaseCount();
    this.resolveReleased();
  }
}

function closeProxySocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
    return;
  }
  if (socket.readyState === WebSocket.OPEN) socket.close(code, boundedPluginBackendChannelCloseReason(reason));
}

function proxyWorkspaceKey(scope: PluginBackendChannelProxyScope): string {
  return JSON.stringify([scope.authorityId, scope.pluginId, scope.projectId, scope.workspaceId]);
}

function decrementCount(counts: Map<string, number>, key: string): void {
  const count = counts.get(key);
  if (count === undefined || count <= 1) counts.delete(key);
  else counts.set(key, count - 1);
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`${label} must be a positive integer`);
  return resolved;
}
