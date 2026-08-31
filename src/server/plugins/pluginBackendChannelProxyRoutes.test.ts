import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  serializePluginBackendChannelOpenEnvelope,
  serializePluginBackendChannelReadyEnvelope,
} from "../../shared/pluginBackendProtocol.js";
import { registerPluginBackendChannelProxyRoutes } from "./pluginBackendChannelProxyRoutes.js";

let app: FastifyInstance;
let upstream: WebSocketServer;
let sockets: WebSocket[];

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await waitForListening(upstream);
  sockets = [];
});

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  await app.close();
  await new Promise<void>((resolve) => { upstream.close(() => { resolve(); }); });
});

describe("local plugin backend channel proxy", () => {
  it("encodes the daemon path and boundedly bridges channel host envelopes", async () => {
    const paths: string[] = [];
    const upstreamConnected = new Promise<WebSocket>((resolve) => {
      upstream.once("connection", (socket) => {
        sockets.push(socket);
        resolve(socket);
      });
    });
    registerPluginBackendChannelProxyRoutes(app, {
      connectWebSocket(path) {
        paths.push(path);
        const socket = new WebSocket(`${webSocketServerUrl(upstream)}${path}`);
        sockets.push(socket);
        return socket;
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const browser = new WebSocket(`${fastifyServerUrl(app)}/api/plugin-backends/terminal.tools/projects/project%20one/workspaces/workspace%20one/channels/terminal.attach`);
    sockets.push(browser);
    const upstreamSocket = await upstreamConnected;
    await waitForOpen(browser);
    const open = serializePluginBackendChannelOpenEnvelope("server-r1", null);
    const forwardedOpen = nextMessage(upstreamSocket);
    browser.send(open);
    await expect(forwardedOpen).resolves.toBe(open);

    const ready = serializePluginBackendChannelReadyEnvelope();
    const forwardedReady = nextMessage(browser);
    upstreamSocket.send(ready);
    await expect(forwardedReady).resolves.toBe(ready);
    expect(paths).toEqual([
      "/plugin-backends/terminal.tools/projects/project%20one/workspaces/workspace%20one/channels/terminal.attach",
    ]);
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
