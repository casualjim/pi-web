import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { boundedPluginBackendChannelCloseReason, PLUGIN_BACKEND_CHANNEL_ROUTE_PATH } from "../../shared/pluginBackendProtocol.js";
import { bridgePluginBackendChannelSockets } from "../webSocketBridge.js";

interface PluginBackendChannelProxyParams {
  pluginId: string;
  projectId: string;
  workspaceId: string;
  operation: string;
}

export interface PluginBackendChannelProxyDaemon {
  connectWebSocket(path: string): WebSocket;
}

/** Browser-facing local channel route; scope and lifetime ownership stay in sessiond. */
export function registerPluginBackendChannelProxyRoutes(
  app: FastifyInstance,
  daemon: PluginBackendChannelProxyDaemon,
  prefix = "/api",
): void {
  app.get<{ Params: PluginBackendChannelProxyParams }>(
    `${prefix}${PLUGIN_BACKEND_CHANNEL_ROUTE_PATH}`,
    { websocket: true },
    (socket, request) => {
      try {
        bridgePluginBackendChannelSockets(socket, daemon.connectWebSocket(daemonPluginBackendChannelPath(request.params)));
      } catch (error) {
        closeSocket(socket, `Session daemon unavailable: ${errorMessage(error)}`);
      }
    },
  );
}

function daemonPluginBackendChannelPath(params: PluginBackendChannelProxyParams): string {
  return [
    "/plugin-backends",
    encodeURIComponent(params.pluginId),
    "projects",
    encodeURIComponent(params.projectId),
    "workspaces",
    encodeURIComponent(params.workspaceId),
    "channels",
    encodeURIComponent(params.operation),
  ].join("/");
}

function closeSocket(socket: WebSocket, reason: string): void {
  if (socket.readyState === WebSocket.OPEN) socket.close(1011, boundedPluginBackendChannelCloseReason(reason));
  else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
