import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parsePluginBackendChannelServerEnvelope,
  PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES,
  serializePluginBackendChannelOpenEnvelope,
  serializePluginBackendChannelReadyEnvelope,
} from "../../shared/pluginBackendProtocol.js";
import { PluginBackendChannelProxyAdmissionPool } from "../plugins/pluginBackendChannelProxyAdmission.js";
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
    const connections: { path: string; maxPayload: number | undefined }[] = [];
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
      connectWebSocket(path, options) {
        connections.push({ path, maxPayload: options?.maxPayload });
        const socket = new WebSocket(`${webSocketServerUrl(remoteServer)}${path}`, options);
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
    expect(connections).toEqual([{
      path: "/api/plugin-backends/terminal/projects/p%201/workspaces/w%201/channels/terminal.attach",
      maxPayload: PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES,
    }]);
  });

  it("reserves federation admission before resolving the remote client", async () => {
    const admissions = new PluginBackendChannelProxyAdmissionPool({ maxTotal: 1, openTimeoutMs: 1_000 });
    let remoteClientCalls = 0;
    let resolveRemoteClientCalled: (() => void) | undefined;
    const remoteClientCalled = new Promise<void>((resolve) => { resolveRemoteClientCalled = resolve; });
    const unresolved = new Promise<MachineClient | undefined>(() => { /* Keep remote lookup pending. */ });
    registerMachineProxyRoutes(app, {
      remoteClient() {
        remoteClientCalls += 1;
        resolveRemoteClientCalled?.();
        return unresolved;
      },
    }, admissions);
    await app.listen({ host: "127.0.0.1", port: 0 });

    const first = new WebSocket(`${fastifyServerUrl(app)}/api/machines/remote/plugin-backends/terminal/projects/p/workspaces/w/channels/attach`);
    sockets.push(first);
    await waitForOpen(first);
    await remoteClientCalled;
    expect(admissions.activeCount).toBe(1);

    const second = new WebSocket(`${fastifyServerUrl(app)}/api/machines/remote/plugin-backends/terminal/projects/p/workspaces/w/channels/attach`);
    sockets.push(second);
    const errorFrame = nextMessage(second).then((text) => parsePluginBackendChannelServerEnvelope(text));
    const rejected = nextClose(second);
    await waitForOpen(second);
    await expect(errorFrame).resolves.toMatchObject({ kind: "error", code: "admission-denied" });
    await expect(rejected).resolves.toMatchObject({ code: 1006 });
    expect(remoteClientCalls).toBe(1);
    expect(admissions.activeCount).toBe(1);

    const firstClosed = nextClose(first);
    first.close();
    await firstClosed;
    expect(admissions.activeCount).toBe(0);
  });

  it("accounts the invalid local-machine channel alias through physical teardown", async () => {
    const admissions = new PluginBackendChannelProxyAdmissionPool({ maxTotal: 1 });
    const remoteClient = vi.fn(() => Promise.resolve(undefined));
    registerMachineProxyRoutes(app, { remoteClient }, admissions);
    await app.listen({ host: "127.0.0.1", port: 0 });

    const browser = new WebSocket(`${fastifyServerUrl(app)}/api/machines/local/plugin-backends/terminal/projects/p/workspaces/w/channels/attach`);
    sockets.push(browser);
    const closed = nextClose(browser);
    await waitForOpen(browser);
    await vi.waitFor(() => { expect(admissions.activeCount).toBe(1); });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    await vi.waitFor(() => { expect(admissions.activeCount).toBe(0); });
    expect(remoteClient).not.toHaveBeenCalled();
  });

  it("times out unresolved federation setup and releases its admission", async () => {
    const admissions = new PluginBackendChannelProxyAdmissionPool({ openTimeoutMs: 30 });
    registerMachineProxyRoutes(app, {
      remoteClient: () => new Promise<MachineClient | undefined>(() => { /* Keep remote lookup pending. */ }),
    }, admissions);
    await app.listen({ host: "127.0.0.1", port: 0 });

    const browser = new WebSocket(`${fastifyServerUrl(app)}/api/machines/remote/plugin-backends/terminal/projects/p/workspaces/w/channels/attach`);
    sockets.push(browser);
    const closed = nextClose(browser);
    await waitForOpen(browser);
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    await vi.waitFor(() => { expect(admissions.activeCount).toBe(0); });
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

function nextClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString("utf8") });
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
