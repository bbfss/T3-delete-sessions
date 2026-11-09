import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { execT3Cli } from "../bin/platform.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function encodeWebSocketFrame(opcode, payloadBuffer, maskBytes = randomBytes(4)) {
  const len = payloadBuffer.length;
  let headerLen = 2;
  if (len >= 126 && len < 65536) {
    headerLen = 4;
  } else if (len >= 65536) {
    headerLen = 10;
  }

  const frame = Buffer.allocUnsafe(headerLen + 4 + len);
  frame[0] = 0x80 | (opcode & 0x0f);
  if (len < 126) {
    frame[1] = 0x80 | len;
  } else if (len < 65536) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
  }

  maskBytes.copy(frame, headerLen, 0, 4);
  const payloadStart = headerLen + 4;
  for (let i = 0; i < len; i += 1) {
    frame[payloadStart + i] = payloadBuffer[i] ^ maskBytes[i & 3];
  }
  return frame;
}

export function createFrameReader({ onTextMessage, onPing, onClose, onError }) {
  let buf = Buffer.alloc(0);
  let fragments = [];

  return function push(chunk) {
    if (!chunk || chunk.length === 0) return;
    buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);

    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const rsv = (buf[0] >> 4) & 0x07;
      const opcode = buf[0] & 0x0f;
      if (rsv !== 0) {
        onError(new Error("Unsupported WebSocket extension bits"));
        return;
      }

      const masked = (buf[1] & 0x80) !== 0;
      let payloadLen = buf[1] & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buf.length < offset + 2) return;
        payloadLen = buf.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (buf.length < offset + 8) return;
        const bigLen = buf.readBigUInt64BE(offset);
        if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) {
          onError(new Error("WebSocket frame exceeds maximum safe length"));
          return;
        }
        payloadLen = Number(bigLen);
        offset += 8;
      }

      let mask = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        mask = buf.subarray(offset, offset + 4);
        offset += 4;
      }

      if (buf.length < offset + payloadLen) {
        return;
      }

      const payload = Buffer.from(buf.subarray(offset, offset + payloadLen));
      if (mask) {
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] ^= mask[i & 3];
        }
      }
      buf = buf.subarray(offset + payloadLen);

      if (opcode === 0x09) {
        onPing?.(payload);
      } else if (opcode === 0x0a) {
        // Ignore unsolicited pong frames.
      } else if (opcode === 0x08) {
        onClose?.(payload);
        return;
      } else if (opcode === 0x01 || opcode === 0x02 || opcode === 0x00) {
        if (opcode !== 0x00 && fragments.length > 0) {
          onError(new Error("Unexpected new data frame before continuation finished"));
          return;
        }
        if (opcode === 0x00 && fragments.length === 0) {
          onError(new Error("Unexpected WebSocket continuation frame"));
          return;
        }
        fragments.push(payload);
        if (fin) {
          const full = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
          fragments = [];
          onTextMessage(full.toString("utf8"));
        }
      } else {
        onError(new Error(`Unsupported WebSocket opcode: ${opcode}`));
        return;
      }
    }
  };
}

export function dispatchT3CommandsOverWs(
  { url, token, commands, timeoutMs = 30000, stopToDeleteSettleMs = 250 }
) {
  if (!commands || commands.length === 0) {
    return Promise.resolve([]);
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const targetUrl = new URL("/ws", url);
    const isSecure = targetUrl.protocol === "https:" || targetUrl.protocol === "wss:";
    targetUrl.protocol = isSecure ? "https:" : "http:";
    targetUrl.searchParams.set("orchestrationProtocol", "2");

    const secKey = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1")
      .update(secKey + WS_GUID)
      .digest("base64");

    let settled = false;
    let activeSocket = null;
    let req = null;

    const timer = setTimeout(() => {
      fail(new Error("T3 command timed out; inspect target state before retrying"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      if (activeSocket && !activeSocket.destroyed) {
        try {
          activeSocket.write(encodeWebSocketFrame(0x08, Buffer.alloc(0)));
        } catch {
          // Ignore close frame write errors during teardown.
        }
        activeSocket.destroy();
      }
      if (req && !req.destroyed) {
        req.destroy();
      }
    }

    function succeed(value) {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(err instanceof Error ? err : new Error(String(err)));
    }

    const transport = isSecure ? https : http;
    req = transport.request(targetUrl, {
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": secKey,
        Authorization: `Bearer ${token}`,
      },
    });

    req.on("error", fail);
    req.on("response", (res) => {
      res.resume();
      fail(new Error(`T3 WebSocket upgrade rejected with HTTP ${res.statusCode}`));
    });

    req.on("upgrade", (res, socket, head) => {
      activeSocket = socket;
      if (res.headers["sec-websocket-accept"] !== expectedAccept) {
        fail(new Error("Invalid Sec-WebSocket-Accept header from T3 server"));
        return;
      }

      let index = 0;
      const results = [];

      function sendNext() {
        if (settled || socket.destroyed) return;
        const payload = JSON.stringify({
          _tag: "Request",
          id: String(index),
          tag: "orchestration.dispatchCommand",
          payload: { commandId: randomUUID(), ...commands[index] },
          headers: [],
        });
        socket.write(encodeWebSocketFrame(0x01, Buffer.from(payload, "utf8")));
      }

      const feed = createFrameReader({
        onPing: (pingPayload) => {
          if (!socket.destroyed) {
            socket.write(encodeWebSocketFrame(0x0a, pingPayload));
          }
        },
        onClose: () => {
          fail(new Error("T3 WebSocket closed before commands completed"));
        },
        onError: fail,
        onTextMessage: (raw) => {
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (err) {
            fail(err);
            return;
          }
          for (const msg of [parsed].flat()) {
            if (msg._tag !== "Exit" || msg.requestId !== String(index)) {
              continue;
            }
            if (msg.exit?._tag !== "Success") {
              fail(new Error(JSON.stringify(msg.exit)));
              return;
            }
            results.push(msg.exit.value);
            const prevType = commands[index]?.type;
            index += 1;
            if (index < commands.length) {
              const nextType = commands[index]?.type;
              if (
                stopToDeleteSettleMs > 0 &&
                prevType === "thread.stop" &&
                (nextType === "thread.delete" || nextType === "thread.archive")
              ) {
                setTimeout(sendNext, stopToDeleteSettleMs);
              } else {
                sendNext();
              }
            } else {
              succeed(results);
              return;
            }
          }
        },
      });

      socket.on("error", fail);
      socket.on("end", () => {
        if (!settled) {
          fail(new Error("T3 WebSocket connection ended prematurely"));
        }
      });

      sendNext();
      if (head && head.length > 0) {
        feed(head);
      }
      socket.on("data", feed);
    });

    req.end();
  });
}

export async function dispatchT3Commands({
  cli,
  baseDir,
  url,
  commands,
  timeoutMs = 30000,
  issueToken = null,
}) {
  if (!commands || commands.length === 0) {
    return [];
  }
  if (issueToken) {
    const token = issueToken(cli, baseDir);
    return dispatchT3CommandsOverWs({ url, token, commands, timeoutMs });
  }
  let sessionId = null;
  let token = null;
  const raw = execT3Cli(cli, [
    "auth",
    "session",
    "issue",
    "--base-dir",
    baseDir,
    "--ttl",
    "5m",
    "--json",
  ]).trim();
  try {
    const parsed = JSON.parse(raw);
    sessionId = parsed?.sessionId || null;
    token = parsed?.token || null;
  } catch {
    token = raw;
  }
  if (!token) {
    throw new Error("Failed to issue T3 bearer session token");
  }
  try {
    return await dispatchT3CommandsOverWs({ url, token, commands, timeoutMs });
  } finally {
    if (sessionId) {
      try {
        execT3Cli(cli, ["auth", "session", "revoke", sessionId, "--base-dir", baseDir]);
      } catch {
        // Best-effort revocation; short 5m TTL still bounds lifetime.
      }
    }
  }
}
