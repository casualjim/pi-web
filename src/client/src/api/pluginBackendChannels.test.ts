import { WebSocket as NodeWebSocket, WebSocketServer, type RawData } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parsePluginBackendChannelClientEnvelope,
  serializePluginBackendChannelDataEnvelope,
  serializePluginBackendChannelErrorEnvelope,
  serializePluginBackendChannelReadyEnvelope,
} from "../../../shared/pluginBackendProtocol";
import {
  openPluginBackendChannel,
  pluginBackendChannelPath,
  pluginBackendChannelUrl,
  type PluginBackendRequestTarget,
} from "./pluginBackends";

const target: PluginBackendRequestTarget = {
  pluginId: "terminal.tools",
  backendRevision: "server-r7",
  machineId: "remote / one",
  projectId: "project / one",
  workspaceId: "workspace #1",
};

let server: WebSocketServer;
let serverSockets: NodeWebSocket[];

beforeEach(async () => {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  serverSockets = [];
  server.on("connection", (socket) => { serverSockets.push(socket); });
  await waitForListening(server);
  vi.stubGlobal("WebSocket", NodeWebSocket);
  vi.stubGlobal("document", { baseURI: `${httpServerUrl(server)}/nested/` });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const socket of serverSockets) socket.terminate();
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
});

describe("browser plugin backend channel helper", () => {
  it("builds encoded local and federated paths and resolves the WebSocket URL once", () => {
    expect(pluginBackendChannelPath({ ...target, machineId: "local" }, "terminal.attach")).toBe(
      "api/plugin-backends/terminal.tools/projects/project%20%2F%20one/workspaces/workspace%20%231/channels/terminal.attach",
    );
    expect(pluginBackendChannelPath(target, "terminal.attach")).toBe(
      "api/machines/remote%20%2F%20one/plugin-backends/terminal.tools/projects/project%20%2F%20one/workspaces/workspace%20%231/channels/terminal.attach",
    );
    expect(pluginBackendChannelUrl(target, "terminal.attach", {
      viteBaseUrl: "./",
      documentBaseUrl: "https://pi.example.test/test/ai/",
    })).toBe(
      "wss://pi.example.test/test/ai/api/machines/remote%20%2F%20one/plugin-backends/terminal.tools/projects/project%20%2F%20one/workspaces/workspace%20%231/channels/terminal.attach",
    );
  });

  it("waits for ready, exchanges bounded JSON frames, and reports attributed closure", async () => {
    const connected = nextConnection(server);
    const observedData: unknown[] = [];
    const opened = openPluginBackendChannel(
      { ...target, machineId: "local" },
      "terminal.attach",
      { terminalId: "t1" },
      { onData: (data) => { observedData.push(data); } },
    );
    const serverSocket = await connected;
    const messages = socketMessages(serverSocket);

    expect(parsePluginBackendChannelClientEnvelope(await messages.next())).toEqual({
      version: 1,
      kind: "open",
      revision: "server-r7",
      input: { terminalId: "t1" },
    });
    serverSocket.send(serializePluginBackendChannelReadyEnvelope());
    const channel = await opened;
    serverSocket.send(serializePluginBackendChannelDataEnvelope({ type: "output", data: "hello" }));
    await vi.waitFor(() => { expect(observedData).toEqual([{ type: "output", data: "hello" }]); });

    channel.send({ type: "input", data: "pwd\n" });
    expect(parsePluginBackendChannelClientEnvelope(await messages.next())).toEqual({
      version: 1,
      kind: "data",
      data: { type: "input", data: "pwd\n" },
    });

    serverSocket.send(serializePluginBackendChannelErrorEnvelope("receive-failed", "PTY input failed"));
    await expect(channel.closed).resolves.toMatchObject({
      code: 1000,
      error: { code: "receive-failed", message: "PTY input failed" },
    });
    expect(() => { channel.send(null); }).toThrow("not open");
  });

  it("cancels an opening channel and rejects invalid outbound data before sending", async () => {
    const connected = nextConnection(server);
    const controller = new AbortController();
    const opened = openPluginBackendChannel(
      { ...target, machineId: "local" },
      "terminal.attach",
      null,
      { signal: controller.signal, onData: () => undefined },
    );
    const serverSocket = await connected;
    const messages = socketMessages(serverSocket);
    await messages.next();
    controller.abort(new DOMException("Panel disconnected", "AbortError"));

    await expect(opened).rejects.toMatchObject({ name: "AbortError", message: "Panel disconnected" });
  });
});

function nextConnection(webSocketServer: WebSocketServer): Promise<NodeWebSocket> {
  return new Promise((resolve) => { webSocketServer.once("connection", resolve); });
}

function socketMessages(socket: NodeWebSocket): { next(): Promise<string> } {
  const queued: string[] = [];
  const waiters: ((value: string) => void)[] = [];
  socket.on("message", (data, isBinary) => {
    if (isBinary) throw new Error("Expected text frame");
    const value = rawDataToString(data);
    const waiter = waiters.shift();
    if (waiter === undefined) queued.push(value);
    else waiter(value);
  });
  return {
    next: () => {
      const value = queued.shift();
      return value === undefined
        ? new Promise<string>((resolve) => { waiters.push(resolve); })
        : Promise.resolve(value);
    },
  };
}

function waitForListening(webSocketServer: WebSocketServer): Promise<void> {
  if (webSocketServer.address() !== null) return Promise.resolve();
  return new Promise((resolve) => { webSocketServer.once("listening", () => { resolve(); }); });
}

function httpServerUrl(webSocketServer: WebSocketServer): string {
  const address = webSocketServer.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `http://127.0.0.1:${String(address.port)}`;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}
