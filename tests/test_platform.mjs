import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCliExecSpec,
  collectPythonCandidates,
  resolvePython,
} from "../bin/platform.js";

test("skips WindowsApps python3 stub and selects working Anaconda python with DLL paths", () => {
  const existing = new Set([
    "C:\\Users\\bbfss\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe",
    "C:\\Users\\bbfss\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
    "E:\\anaconda3\\python.exe",
    "E:\\anaconda3\\Library\\bin",
    "E:\\anaconda3\\DLLs",
  ]);
  const env = {
    Path: 'C:\\Users\\bbfss\\AppData\\Local\\Microsoft\\WindowsApps;"E:\\anaconda3"',
    USERPROFILE: "C:\\Users\\bbfss",
  };
  const fsOps = {
    existsSync: (p) => existing.has(p),
    readdirSync: () => [],
  };

  const candidates = collectPythonCandidates({
    env,
    platform: "win32",
    homedir: "C:\\Users\\bbfss",
    fsOps,
  });
  assert.equal(candidates[0].command, "E:\\anaconda3\\python.exe");
  assert.ok(
    !candidates.some((c) => /windowsapps/i.test(c.command)),
    "WindowsApps stub directory must not be added as explicit path candidate"
  );

  const resolved = resolvePython({
    env,
    platform: "win32",
    homedir: "C:\\Users\\bbfss",
    execPath: "C:\\Users\\bbfss\\AppData\\Local\\nodejs\\node.exe",
    fsOps,
    probe: (cmd, _args, probeEnv) => {
      if (cmd === "E:\\anaconda3\\python.exe") {
        assert.ok(probeEnv.Path.includes("E:\\anaconda3\\Library\\bin"));
        return { status: 0 };
      }
      return { status: 1 };
    },
  });

  assert.equal(resolved.command, "E:\\anaconda3\\python.exe");
  assert.deepEqual(resolved.prefixArgs, []);
  assert.equal(resolved.env.PYTHONUTF8, "1");
  assert.equal(resolved.env.PYTHONIOENCODING, "utf-8");
  assert.equal(
    resolved.env.T3_NODE_EXECUTABLE,
    "C:\\Users\\bbfss\\AppData\\Local\\nodejs\\node.exe"
  );
  assert.equal(
    Object.keys(resolved.env).filter((k) => k.toLowerCase() === "path").length,
    1,
    "Must preserve single Path key without creating duplicate PATH on Windows"
  );
});

test("falls back to py -3 when python and python3 commands fail on Windows", () => {
  const resolved = resolvePython({
    env: { Path: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\bbfss" },
    platform: "win32",
    homedir: "C:\\Users\\bbfss",
    fsOps: { existsSync: () => false, readdirSync: () => [] },
    probe: (cmd, args) => {
      if (cmd === "python" || cmd === "python3") return { status: 9009 };
      if (cmd === "py" && args[0] === "-3") return { status: 0 };
      return { status: 1 };
    },
  });

  assert.equal(resolved.command, "py");
  assert.deepEqual(resolved.prefixArgs, ["-3"]);
});

test("honors explicit T3_DELETE_SESSIONS_PYTHON without silent fallback", () => {
  assert.throws(
    () =>
      resolvePython({
        env: { T3_DELETE_SESSIONS_PYTHON: "D:\\missing\\python.exe" },
        platform: "win32",
        probe: () => ({ error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) }),
      }),
    /D:\\missing\\python\.exe/
  );
});

test("wraps Windows .cmd T3 CLI through cmd.exe with verbatim quoting", () => {
  const spec = buildCliExecSpec(
    "C:\\Users\\bbfss\\.local\\bin\\t3.cmd",
    ["auth", "session", "issue", "--base-dir", "C:\\Users\\bbfss\\.t3", "--ttl", "5m", "--token-only"],
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
      buildCliExecSpec("C:\\Users\\bbfss\\.local\\bin\\t3.cmd", ["--base-dir", 'C:\\bad"path'], {
        platform: "win32",
      }),
    /Unsafe character/
  );
});
