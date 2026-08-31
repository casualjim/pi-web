import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import type { JsonValue } from "../../server-plugin-api.js";
import {
  parsePluginBackendChannelServerEnvelope,
  serializePluginBackendChannelDataEnvelope,
  serializePluginBackendChannelOpenEnvelope,
} from "../../shared/pluginBackendProtocol.js";
import { PluginBackendRegistry } from "../plugins/pluginBackendRegistry.js";
import type { ServerPluginPairedBackendContribution } from "../plugins/serverPluginRuntime.js";
import type { Project } from "../types.js";
import { WorkspaceProviderRegistry } from "../workspaces/workspaceProviderRegistry.js";
import { registerPluginBackendChannelRoutes } from "./pluginBackendChannelRoutes.js";

const project: Project = {
  id: "project one",
  name: "Project",
  path: "/repo",
  createdAt: "2026-08-02T00:00:00.000Z",
};

let app: FastifyInstance;
let sockets: WebSocket[];

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  sockets = [];
});

afterEach(async () => {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
  }
  await app.close();
});

describe("session daemon plugin backend channels", () => {
  it("opens after scope resolution, preserves ready ordering, exchanges data, and cleans up once", async () => {
    const workspaces = workspaceRegistry();
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected workspace");
    const received: JsonValue[] = [];
    const close = vi.fn();
    const registry = new PluginBackendRegistry({
      contributions: [contribution(({ send }) => {
        send({ type: "output", data: "replay" });
        return {
          receive: (data) => { received.push(data); },
          close,
        };
      })],
      workspaces,
    });
    registerPluginBackendChannelRoutes(app, { projects: projectReader(), backends: registry });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const socket = connect(workspaceId);
    const messages = socketMessages(socket);
    await waitForOpen(socket);
    socket.send(serializePluginBackendChannelOpenEnvelope("terminal-r1", { terminalId: "t1" }));

    expect(parsePluginBackendChannelServerEnvelope(await messages.next())).toEqual({ version: 1, kind: "ready" });
    expect(parsePluginBackendChannelServerEnvelope(await messages.next())).toEqual({
      version: 1,
      kind: "data",
      data: { type: "output", data: "replay" },
    });
    socket.send(serializePluginBackendChannelDataEnvelope({ type: "input", data: "pwd\n" }));
    await vi.waitFor(() => { expect(received).toEqual([{ type: "input", data: "pwd\n" }]); });

    const closed = nextClose(socket);
    socket.close(1000, "panel closed");
    await closed;
    await vi.waitFor(() => { expect(registry.activeChannelCount()).toBe(0); });
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: 1000, reason: "panel closed" }));
  });

  it("attributes stale revisions, plugin receive failures, and binary input before closing", async () => {
    const workspaces = workspaceRegistry();
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected workspace");
    const registry = new PluginBackendRegistry({
      contributions: [contribution(() => ({ receive: () => { throw new Error("input exploded"); } }))],
      workspaces,
    });
    registerPluginBackendChannelRoutes(app, { projects: projectReader(), backends: registry });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const stale = connect(workspaceId);
    const staleMessages = socketMessages(stale);
    await waitForOpen(stale);
    stale.send(serializePluginBackendChannelOpenEnvelope("old", null));
    expect(parsePluginBackendChannelServerEnvelope(await staleMessages.next())).toMatchObject({
      kind: "error",
      code: "stale-plugin-revision",
    });
    await nextClose(stale);

    const failed = connect(workspaceId);
    const failedMessages = socketMessages(failed);
    await waitForOpen(failed);
    failed.send(serializePluginBackendChannelOpenEnvelope("terminal-r1", null));
    expect(parsePluginBackendChannelServerEnvelope(await failedMessages.next())).toMatchObject({ kind: "ready" });
    failed.send(serializePluginBackendChannelDataEnvelope({ type: "input" }));
    const receiveFailure = parsePluginBackendChannelServerEnvelope(await failedMessages.next());
    expect(receiveFailure).toMatchObject({ kind: "error", code: "receive-failed" });
    if (receiveFailure.kind !== "error") throw new Error("Expected receive failure envelope");
    expect(receiveFailure.message).toContain("input exploded");
    await nextClose(failed);

    const binary = connect(workspaceId);
    const binaryMessages = socketMessages(binary);
    await waitForOpen(binary);
    binary.send(Buffer.from("not text"), { binary: true });
    expect(parsePluginBackendChannelServerEnvelope(await binaryMessages.next())).toMatchObject({
      kind: "error",
      code: "binary-frame",
    });
    await nextClose(binary);
  });
});

function contribution(
  openChannel: NonNullable<ServerPluginPairedBackendContribution["backend"]["openChannel"]>,
): ServerPluginPairedBackendContribution {
  return {
    pluginId: "terminal",
    pluginName: "Terminal",
    packageRoot: "/plugins/terminal",
    source: "fixture",
    scope: "bundled",
    moduleRevision: "terminal-r1",
    backend: { version: 1, request: () => null, openChannel },
  };
}

function workspaceRegistry(): WorkspaceProviderRegistry {
  return new WorkspaceProviderRegistry({
    contributions: [],
    logger: { warn: vi.fn() },
    pathInspector: () => true,
  });
}

function projectReader() {
  return {
    requireProject: (projectId: string) => projectId === project.id
      ? Promise.resolve(project)
      : Promise.reject(new Error("Project not found")),
  };
}

function connect(workspaceId: string): WebSocket {
  const socket = new WebSocket(`${serverUrl(app)}/plugin-backends/terminal/projects/${encodeURIComponent(project.id)}/workspaces/${encodeURIComponent(workspaceId)}/channels/terminal.attach`);
  sockets.push(socket);
  return socket;
}

function socketMessages(socket: WebSocket): { next(): Promise<string> } {
  const queued: string[] = [];
  const waiters: ((value: string) => void)[] = [];
  socket.on("message", (data, isBinary) => {
    if (isBinary) throw new Error("Expected text channel frame");
    const text = rawDataToString(data);
    const waiter = waiters.shift();
    if (waiter === undefined) queued.push(text);
    else waiter(text);
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

function serverUrl(instance: FastifyInstance): string {
  const address = instance.server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${String(address.port)}`;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", () => { resolve(); });
    socket.once("error", reject);
  });
}

function nextClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve({ code: 1006, reason: "already closed" });
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => { resolve({ code, reason: rawDataToString(reason) }); });
  });
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}
