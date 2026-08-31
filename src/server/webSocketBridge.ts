import { WebSocket, type Data, type RawData } from "ws";
import {
  boundedPluginBackendChannelCloseReason,
  parsePluginBackendChannelClientEnvelope,
  parsePluginBackendChannelServerEnvelope,
  PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_BYTES,
  PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES,
  utf8ByteLength,
} from "../shared/pluginBackendProtocol.js";

export function bridgeSockets(client: WebSocket, upstream: WebSocket): void {
  const sendToClient = createBufferedSender(client);
  const sendToUpstream = createBufferedSender(upstream);
  client.on("message", (data) => { sendToUpstream(data); });
  upstream.on("message", (data) => { sendToClient(data); });
  client.on("close", () => { upstream.close(); });
  upstream.on("close", () => { client.close(); });
  upstream.on("error", () => { client.close(); });
  client.on("error", () => { upstream.close(); });
}

export function createBufferedSender(socket: WebSocket): (data: Data) => void {
  const queue: Data[] = [];
  const flush = () => {
    while (socket.readyState === WebSocket.OPEN) {
      const data = queue.shift();
      if (data === undefined) return;
      socket.send(data);
    }
  };
  socket.on("open", flush);
  return (data) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(data);
      return;
    }
    if (socket.readyState === WebSocket.CONNECTING) queue.push(data);
  };
}

export interface BoundedTextWebSocketSenderOptions {
  maxFrames?: number;
  maxBytes?: number;
  onOverflow?: (error: Error) => void;
}

/** One-at-a-time sender whose connecting and socket-write queue is explicitly bounded. */
export function createBoundedTextWebSocketSender(
  socket: WebSocket,
  options: BoundedTextWebSocketSenderOptions = {},
): (text: string) => void {
  const maxFrames = options.maxFrames ?? PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES;
  const maxBytes = options.maxBytes ?? PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_BYTES;
  const queue: { text: string; bytes: number }[] = [];
  let queuedBytes = 0;
  let sending = false;
  let failed = false;

  const fail = (error: Error): void => {
    if (!failed) {
      failed = true;
      options.onOverflow?.(error);
    }
  };
  const flush = (): void => {
    if (sending || failed || socket.readyState !== WebSocket.OPEN) return;
    const frame = queue[0];
    if (frame === undefined) return;
    sending = true;
    try {
      socket.send(frame.text, { binary: false }, (error) => {
        sending = false;
        if (queue[0] === frame) {
          queue.shift();
          queuedBytes -= frame.bytes;
        }
        if (error) {
          fail(new Error(`Plugin backend channel socket send failed: ${error.message}`, { cause: error }));
          return;
        }
        flush();
      });
    } catch (error) {
      sending = false;
      if (queue[0] === frame) {
        queue.shift();
        queuedBytes -= frame.bytes;
      }
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  socket.on("open", flush);
  return (text: string): void => {
    if (failed || (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING)) {
      throw new Error("Plugin backend channel socket is not open");
    }
    const bytes = utf8ByteLength(text);
    if (queue.length >= maxFrames || queuedBytes + bytes > maxBytes) {
      const error = new Error("Plugin backend channel socket queue limit was exceeded");
      fail(error);
      throw error;
    }
    queue.push({ text, bytes });
    queuedBytes += bytes;
    flush();
  };
}

export interface PluginBackendChannelBridgeOptions {
  /** Already validated client frames captured while an asynchronous upstream was resolved. */
  initialClientFrames?: readonly string[];
}

/** Validate and boundedly bridge generic channel envelopes without reading plugin data semantics. */
export function bridgePluginBackendChannelSockets(
  client: WebSocket,
  upstream: WebSocket,
  options: PluginBackendChannelBridgeOptions = {},
): void {
  let closing = false;
  const isClosing = (): boolean => closing;
  const fail = (code: number, reason: string): void => {
    if (closing) return;
    closing = true;
    closeWebSocket(client, code, reason);
    closeWebSocket(upstream, code, reason);
  };
  const sendToClient = createBoundedTextWebSocketSender(client, {
    onOverflow: (error) => { fail(1013, error.message); },
  });
  const sendToUpstream = createBoundedTextWebSocketSender(upstream, {
    onOverflow: (error) => { fail(1013, error.message); },
  });

  const forwardClientText = (text: string): void => {
    parsePluginBackendChannelClientEnvelope(text);
    sendToUpstream(text);
  };
  client.on("message", (data, isBinary) => {
    try {
      if (isBinary) throw new BinaryPluginBackendChannelFrameError();
      forwardClientText(decodeTextWebSocketFrame(data));
    } catch (error) {
      fail(error instanceof BinaryPluginBackendChannelFrameError ? 1003 : 1008, bridgeErrorMessage(error));
    }
  });
  upstream.on("message", (data, isBinary) => {
    try {
      if (isBinary) throw new BinaryPluginBackendChannelFrameError();
      const text = decodeTextWebSocketFrame(data);
      parsePluginBackendChannelServerEnvelope(text);
      sendToClient(text);
    } catch (error) {
      fail(error instanceof BinaryPluginBackendChannelFrameError ? 1003 : 1008, bridgeErrorMessage(error));
    }
  });
  client.once("close", (code, reason) => {
    if (!closing) {
      closing = true;
      closeWebSocket(upstream, transferableCloseCode(code), decodeCloseReason(reason));
    }
  });
  upstream.once("close", (code, reason) => {
    if (!closing) {
      closing = true;
      closeWebSocket(client, transferableCloseCode(code), decodeCloseReason(reason));
    }
  });
  client.once("error", (error) => { fail(1011, `Plugin backend channel client transport failed: ${bridgeErrorMessage(error)}`); });
  upstream.once("error", (error) => { fail(1011, `Plugin backend channel upstream transport failed: ${bridgeErrorMessage(error)}`); });

  for (const text of options.initialClientFrames ?? []) {
    if (isClosing()) break;
    try {
      forwardClientText(text);
    } catch (error) {
      fail(1008, bridgeErrorMessage(error));
    }
  }
}

function decodeTextWebSocketFrame(data: RawData): string {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : Array.isArray(data)
        ? Buffer.concat(data)
        : data;
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function decodeCloseReason(reason: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(reason);
  } catch {
    return "Invalid close reason";
  }
}

function transferableCloseCode(code: number): number {
  return code === 1000 || (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006)
    ? code
    : 1011;
}

function closeWebSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
    return;
  }
  if (socket.readyState === WebSocket.OPEN) socket.close(code, boundedPluginBackendChannelCloseReason(reason));
}

function bridgeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundedPluginBackendChannelCloseReason(message);
}

class BinaryPluginBackendChannelFrameError extends Error {
  constructor() {
    super("Plugin backend channels accept text JSON frames only");
  }
}
