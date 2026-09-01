import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  serializePluginBackendChannelDataEnvelope,
  serializePluginBackendChannelOpenEnvelope,
  serializePluginBackendChannelReadyEnvelope,
} from "../shared/pluginBackendProtocol.js";
import {
  bridgePluginBackendChannelSockets,
  bridgeSockets,
  createBoundedTextWebSocketSender,
  createBufferedSender,
} from "./webSocketBridge.js";

const servers = new Set<WebSocketServer>();
const sockets = new Set<WebSocket>();

afterEach(async () => {
  for (const socket of sockets) closeSocket(socket);
  await Promise.all(Array.from(servers, closeSocketServer));
  sockets.clear();
  servers.clear();
});

describe("bridgeSockets", () => {
  it("forwards messages in both directions while sockets are open", async () => {
    const clientSide = await createSocketPair();
    const upstreamSide = await createSocketPair();
    bridgeSockets(clientSide.bridgeSocket, upstreamSide.bridgeSocket);

    const forwardedToUpstream = nextMessage(upstreamSide.peerSocket);
    clientSide.peerSocket.send("to-upstream");
    await expect(forwardedToUpstream).resolves.toBe("to-upstream");

    const forwardedToClient = nextMessage(clientSide.peerSocket);
    upstreamSide.peerSocket.send("to-client");
    await expect(forwardedToClient).resolves.toBe("to-client");
  });

  it("propagates close and error events to the opposite socket", async () => {
    const closeCaseClientSide = await createSocketPair();
    const closeCaseUpstreamSide = await createSocketPair();
    bridgeSockets(closeCaseClientSide.bridgeSocket, closeCaseUpstreamSide.bridgeSocket);

    const upstreamClosed = nextClose(closeCaseUpstreamSide.peerSocket);
    closeCaseClientSide.peerSocket.close();
    await upstreamClosed;

    const errorCaseClientSide = await createSocketPair();
    const errorCaseUpstreamSide = await createSocketPair();
    bridgeSockets(errorCaseClientSide.bridgeSocket, errorCaseUpstreamSide.bridgeSocket);

    const clientClosed = nextClose(errorCaseClientSide.peerSocket);
    errorCaseUpstreamSide.bridgeSocket.emit("error", new Error("upstream failed"));
    await clientClosed;
  });
});

describe("bounded plugin backend channel bridge", () => {
  it("validates and forwards host envelopes in both directions", async () => {
    const clientSide = await createSocketPair();
    const upstreamSide = await createSocketPair();
    bridgePluginBackendChannelSockets(clientSide.bridgeSocket, upstreamSide.bridgeSocket);

    const open = serializePluginBackendChannelOpenEnvelope("server-r1", { terminalId: "t1" });
    const forwardedOpen = nextMessage(upstreamSide.peerSocket);
    clientSide.peerSocket.send(open);
    await expect(forwardedOpen).resolves.toBe(open);

    const ready = serializePluginBackendChannelReadyEnvelope();
    const forwardedReady = nextMessage(clientSide.peerSocket);
    upstreamSide.peerSocket.send(ready);
    await expect(forwardedReady).resolves.toBe(ready);
  });

  it("drains bridged frames before propagating a clean upstream close", async () => {
    const clientSide = await createSocketPair();
    const upstreamSide = await createSocketPair();
    const onClosed = vi.fn();
    bridgePluginBackendChannelSockets(clientSide.bridgeSocket, upstreamSide.bridgeSocket, { onClosed });
    const messages = socketMessages(clientSide.peerSocket);
    const closed = nextClose(clientSide.peerSocket);
    const first = serializePluginBackendChannelDataEnvelope({ sequence: 1 });
    const second = serializePluginBackendChannelDataEnvelope({ sequence: 2 });

    upstreamSide.peerSocket.send(first);
    upstreamSide.peerSocket.send(second, () => { upstreamSide.peerSocket.close(1000, "complete"); });

    await expect(messages.next()).resolves.toBe(first);
    await expect(messages.next()).resolves.toBe(second);
    await closed;
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("closes both directions for binary or invalid-direction frames", async () => {
    const binaryClientSide = await createSocketPair();
    const binaryUpstreamSide = await createSocketPair();
    bridgePluginBackendChannelSockets(binaryClientSide.bridgeSocket, binaryUpstreamSide.bridgeSocket);
    const clientClosed = nextClose(binaryClientSide.peerSocket);
    const upstreamClosed = nextClose(binaryUpstreamSide.peerSocket);
    binaryClientSide.peerSocket.send(Buffer.from("binary"), { binary: true });
    await Promise.all([clientClosed, upstreamClosed]);

    const invalidClientSide = await createSocketPair();
    const invalidUpstreamSide = await createSocketPair();
    bridgePluginBackendChannelSockets(invalidClientSide.bridgeSocket, invalidUpstreamSide.bridgeSocket);
    const invalidClosed = nextClose(invalidClientSide.peerSocket);
    invalidUpstreamSide.peerSocket.send(serializePluginBackendChannelOpenEnvelope("server-r1", null));
    await invalidClosed;
  });

  it("rejects sender queue overflow while a socket is connecting", async () => {
    const socketServer = createServer();
    await waitForListening(socketServer);
    const client = new WebSocket(serverUrl(socketServer));
    sockets.add(client);
    const onOverflow = vi.fn();
    const send = createBoundedTextWebSocketSender(client, { maxFrames: 1, maxBytes: 1024, onOverflow });

    send("first");
    expect(() => { send("second"); }).toThrow("queue limit");
    expect(onOverflow).toHaveBeenCalledOnce();
  });
});

describe("createBufferedSender", () => {
  it("queues messages while a WebSocket is still connecting", async () => {
    const socketServer = createServer();
    const connected = new Promise<WebSocket>((resolve) => {
      socketServer.once("connection", (socket) => {
        sockets.add(socket);
        resolve(socket);
      });
    });
    await waitForListening(socketServer);

    const client = new WebSocket(serverUrl(socketServer));
    sockets.add(client);
    const send = createBufferedSender(client);
    send("queued-before-open");

    const serverSocket = await connected;
    await expect(nextMessage(serverSocket)).resolves.toBe("queued-before-open");
    closeSocket(client);
    closeSocket(serverSocket);
  });
});

interface SocketPair {
  bridgeSocket: WebSocket;
  peerSocket: WebSocket;
}

async function createSocketPair(): Promise<SocketPair> {
  const socketServer = createServer();
  const connected = new Promise<WebSocket>((resolve) => {
    socketServer.once("connection", (socket) => {
      sockets.add(socket);
      resolve(socket);
    });
  });
  await waitForListening(socketServer);

  const peerSocket = new WebSocket(serverUrl(socketServer));
  sockets.add(peerSocket);
  const opened = nextOpen(peerSocket);
  const bridgeSocket = await connected;
  await opened;

  return { bridgeSocket, peerSocket };
}

function createServer(): WebSocketServer {
  const socketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.add(socketServer);
  return socketServer;
}

function closeSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.on("error", () => undefined);
    socket.terminate();
  } else if (socket.readyState === WebSocket.OPEN) socket.close();
}

function closeSocketServer(socketServer: WebSocketServer): Promise<void> {
  return new Promise<void>((resolve) => {
    socketServer.close(() => { resolve(); });
  });
}

function waitForListening(socketServer: WebSocketServer): Promise<void> {
  if (socketServer.address() !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socketServer.once("error", reject);
    socketServer.once("listening", () => {
      socketServer.off("error", reject);
      resolve();
    });
  });
}

function serverUrl(socketServer: WebSocketServer): string {
  const address = socketServer.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${String(address.port)}`;
}

function nextOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", () => {
      socket.off("error", reject);
      resolve();
    });
  });
}

function nextClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once("close", () => { resolve(); });
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("message", (data) => {
      resolve(rawDataToString(data));
    });
  });
}

function socketMessages(socket: WebSocket): { next(): Promise<string> } {
  const queued: string[] = [];
  const waiters: ((value: string) => void)[] = [];
  socket.on("message", (data) => {
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

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}
