import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  serializePluginBackendChannelOpenEnvelope,
  serializePluginBackendChannelReadyEnvelope,
} from "../../shared/pluginBackendProtocol.js";
import type { MachineClient } from "./machineClient.js";
import { registerMachineProxyRoutes } from "./machineProxyRoutes.js";

let app: FastifyInstance;
let remoteServer: WebSocketServer;
let sockets: WebSocket[];

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  remoteServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await waitForListening(remoteServer);
  sockets = [];
});

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  await app.close();
  await new Promise<void>((resolve) => { remoteServer.close(() => { resolve(); }); });
});

describe("machine plugin backend channel proxy", () => {
  it("forwards the sole generic federated channel route with bounded host envelopes", async () => {
    const paths: string[] = [];
    let resolveRemoteOpen: ((value: string) => void) | undefined;
    const remoteOpen = new Promise<string>((resolve) => { resolveRemoteOpen = resolve; });
    const remoteConnected = new Promise<WebSocket>((resolve) => {
      remoteServer.once("connection", (socket) => {
        sockets.push(socket);
        socket.once("message", (data, isBinary) => {
          if (isBinary) throw new Error("Expected text frame");
          resolveRemoteOpen?.(rawDataToString(data));
        });
        resolve(socket);
      });
    });
    const client: MachineClient = {
      request: () => Promise.reject(new Error("HTTP not expected")),
      requestJson: () => Promise.reject(new Error("HTTP not expected")),
      connectWebSocket(path) {
        paths.push(path);
        const socket = new WebSocket(`${webSocketServerUrl(remoteServer)}${path}`);
        sockets.push(socket);
        return socket;
      },
    };
    let resolveRemoteClient: ((value: MachineClient | undefined) => void) | undefined;
    const remoteClient = new Promise<MachineClient | undefined>((resolve) => { resolveRemoteClient = resolve; });
    registerMachineProxyRoutes(app, { remoteClient: () => remoteClient });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const browser = new WebSocket(`${fastifyServerUrl(app)}/api/machines/remote%20one/plugin-backends/terminal/projects/p%201/workspaces/w%201/channels/terminal.attach`);
    sockets.push(browser);
    await waitForOpen(browser);

    const open = serializePluginBackendChannelOpenEnvelope("terminal-r1", null);
    browser.send(open);
    resolveRemoteClient?.(client);
    const remote = await remoteConnected;
    await expect(remoteOpen).resolves.toBe(open);
    const ready = serializePluginBackendChannelReadyEnvelope();
    const browserReady = nextMessage(browser);
    remote.send(ready);
    await expect(browserReady).resolves.toBe(ready);
    expect(paths).toEqual(["/api/plugin-backends/terminal/projects/p%201/workspaces/w%201/channels/terminal.attach"]);
  });
});

function waitForListening(server: WebSocketServer): Promise<void> {
  if (server.address() !== null) return Promise.resolve();
  return new Promise((resolve) => { server.once("listening", () => { resolve(); }); });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", () => { resolve(); });
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("message", (data, isBinary) => {
      if (isBinary) throw new Error("Expected text frame");
      resolve(rawDataToString(data));
    });
  });
}

function webSocketServerUrl(server: WebSocketServer): string {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${String(address.port)}`;
}

function fastifyServerUrl(instance: FastifyInstance): string {
  const address = instance.server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${String(address.port)}`;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}
