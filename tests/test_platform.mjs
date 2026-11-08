import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { buildCliExecSpec, resolveT3Cli } from "../bin/platform.js";
import { createFrameReader, dispatchT3Commands } from "../src/ws-rpc.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function makeServerFrame(opcode, payloadBuf, fin = true) {
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.from([(fin ? 0x80 : 0x00) | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = (fin ? 0x80 : 0x00) | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = (fin ? 0x80 : 0x00) | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuf]);
}

test("resolves t3.cmd from ~/.local/bin when missing from Windows PATH", () => {
  const existing = new Set(["C:\\Users\\bbfss\\.local\\bin\\t3.cmd"]);
  const resolved = resolveT3Cli("t3", {
    env: { Path: "C:\\Windows\\System32", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    platform: "win32",
    homedir: "C:\\Users\\bbfss",
    fsOps: { existsSync: (p) => existing.has(p), accessSync: () => {} },
  });
  assert.equal(resolved, "C:\\Users\\bbfss\\.local\\bin\\t3.cmd");
});

test("wraps Windows .cmd T3 CLI through cmd.exe with verbatim quoting", () => {
  const spec = buildCliExecSpec(
    "C:\\Users\\bbfss\\.local\\bin\\t3.cmd",
    [
      "auth",
      "session",
      "issue",
      "--base-dir",
      "C:\\Users\\bbfss\\.t3",
      "--ttl",
      "5m",
      "--token-only",
    ],
    { platform: "win32", env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" } }
  );

  assert.equal(spec.file, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(spec.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
  assert.equal(
    spec.args[4],
    '""C:\\Users\\bbfss\\.local\\bin\\t3.cmd" "auth" "session" "issue" "--base-dir" "C:\\Users\\bbfss\\.t3" "--ttl" "5m" "--token-only""'
  );
  assert.equal(spec.options.windowsVerbatimArguments, true);
});

test("executes .exe directly on Windows and POSIX binaries directly on macOS/Linux", () => {
  const winExe = buildCliExecSpec("C:\\Program Files\\T3\\t3.exe", ["auth"], {
    platform: "win32",
  });
  assert.equal(winExe.file, "C:\\Program Files\\T3\\t3.exe");
  assert.deepEqual(winExe.args, ["auth"]);

  const posix = buildCliExecSpec("/usr/local/bin/t3", ["auth"], {
    platform: "darwin",
  });
  assert.equal(posix.file, "/usr/local/bin/t3");
  assert.deepEqual(posix.args, ["auth"]);
});

test("rejects unsafe characters in Windows cmd.exe CLI arguments", () => {
  assert.throws(
    () =>
      buildCliExecSpec(
        "C:\\Users\\bbfss\\.local\\bin\\t3.cmd",
        ["--base-dir", 'C:\\bad"path'],
        { platform: "win32" }
      ),
    /Unsafe character/
  );
});

test("zero-dependency WebSocket client handles auth, ping/pong, fragmentation, and multi-command RPC", async (t) => {
  const receivedCommands = [];
  let pongReceived = false;
  let seenAuth = null;

  const server = http.createServer();
  server.on("upgrade", (req, socket) => {
    seenAuth = req.headers.authorization;
    assert.equal(
      new URL(req.url, "http://127.0.0.1").searchParams.get("orchestrationProtocol"),
      "2"
    );
    const accept = createHash("sha1")
      .update(req.headers["sec-websocket-key"] + WS_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    const reader = createFrameReader({
      onPing: () => {},
      onClose: () => socket.end(),
      onError: (err) => {
        throw err;
      },
      onTextMessage: (raw) => {
        const msg = JSON.parse(raw);
        receivedCommands.push(msg.payload.type);
        // Send an interleaved Ping frame + fragmented >200-byte response split byte-by-byte
        socket.write(makeServerFrame(0x09, Buffer.from("ping-check")));
        const replyJson = JSON.stringify({
          _tag: "Exit",
          requestId: msg.id,
          exit: {
            _tag: "Success",
            value: { ok: true, id: msg.id, pad: "x".repeat(220) },
          },
        });
        const replyBuf = Buffer.from(replyJson, "utf8");
        const part1 = makeServerFrame(0x01, replyBuf.subarray(0, 70), false);
        const part2 = makeServerFrame(0x00, replyBuf.subarray(70), true);
        socket.write(part1.subarray(0, 5));
        socket.write(Buffer.concat([part1.subarray(5), part2]));
      },
    });

    socket.on("data", (chunk) => {
      // Check if client sent a masked pong frame (0x8a)
      if ((chunk[0] & 0x0f) === 0x0a) {
        pongReceived = true;
      }
      reader(chunk);
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const { port } = server.address();

  const results = await dispatchT3Commands({
    cli: "t3",
    baseDir: "/tmp/fake-t3",
    url: `http://127.0.0.1:${port}`,
    commands: [
      { type: "thread.stop", threadId: "t1" },
      { type: "thread.delete", threadId: "t1" },
    ],
    issueToken: () => "token-xyz",
  });

  assert.equal(seenAuth, "Bearer token-xyz");
  assert.deepEqual(receivedCommands, ["thread.stop", "thread.delete"]);
  assert.equal(results.length, 2);
  assert.equal(results[0].id, "0");
  assert.equal(results[1].id, "1");
  assert.equal(pongReceived, true);
});
