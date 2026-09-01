import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { boundedPluginBackendChannelCloseReason, PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES, PLUGIN_BACKEND_CHANNEL_ROUTE_PATH } from "../../shared/pluginBackendProtocol.js";
import { bridgePluginBackendChannelSockets } from "../webSocketBridge.js";
import {
  PluginBackendChannelProxyAdmissionError,
  type PluginBackendChannelProxyAdmissionPool,
  type PluginBackendChannelProxyLease,
  pluginBackendChannelProxyAdmissionPool,
  rejectPluginBackendChannelProxyAdmission,
} from "./pluginBackendChannelProxyAdmission.js";

interface PluginBackendChannelProxyParams {
  pluginId: string;
  projectId: string;
  workspaceId: string;
  operation: string;
}

export interface PluginBackendChannelProxyDaemon {
  connectWebSocket(path: string, options?: { maxPayload?: number }): WebSocket;
}

/** Browser-facing local route; session ownership stays in sessiond while this hop bounds transport resources. */
export function registerPluginBackendChannelProxyRoutes(
  app: FastifyInstance,
  daemon: PluginBackendChannelProxyDaemon,
  prefix = "/api",
  admissions: PluginBackendChannelProxyAdmissionPool = pluginBackendChannelProxyAdmissionPool(app),
): void {
  app.get<{ Params: PluginBackendChannelProxyParams }>(
    `${prefix}${PLUGIN_BACKEND_CHANNEL_ROUTE_PATH}`,
    { websocket: true },
    (socket, request) => {
      let lease: PluginBackendChannelProxyLease;
      try {
        lease = admissions.admit(socket, {
          authorityId: "local",
          pluginId: request.params.pluginId,
          projectId: request.params.projectId,
          workspaceId: request.params.workspaceId,
        });
      } catch (error) {
        if (error instanceof PluginBackendChannelProxyAdmissionError) {
          rejectPluginBackendChannelProxyAdmission(socket, error);
          return;
        }
        closeSocket(socket, `Plugin backend channel admission failed: ${errorMessage(error)}`);
        return;
      }

      try {
        const upstream = daemon.connectWebSocket(
          daemonPluginBackendChannelPath(request.params),
          { maxPayload: PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES },
        );
        if (!lease.attachUpstream(upstream)) return;
        bridgePluginBackendChannelSockets(socket, upstream, { onClosed: () => { lease.release(); } });
        lease.bridgeStarted();
      } catch (error) {
        lease.fail(1011, `Session daemon unavailable: ${errorMessage(error)}`);
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
