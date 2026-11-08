import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import { delimiter, join, win32 } from "node:path";

export const PYTHON_PROBE_CODE =
  "import sys, sqlite3; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)";

export function findPathKey(env, platform = process.platform) {
  return (
    Object.keys(env).find((key) => key.toLowerCase() === "path") ||
    (platform === "win32" ? "Path" : "PATH")
  );
}

export function isWindowsAppsStub(filePath) {
  return /[\\/]microsoft[\\/]windowsapps[\\/]/i.test(filePath);
}

function stripOuterQuotes(entry) {
  const trimmed = entry.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function preparePythonEnv(
  baseEnv,
  command,
  {
    platform = process.platform,
    execPath = process.execPath,
    fsOps = { existsSync },
  } = {}
) {
  const env = { ...baseEnv };
  const pathKey = findPathKey(env, platform);
  const sep = platform === "win32" ? ";" : delimiter;

  if (platform === "win32" && win32.isAbsolute(command)) {
    const pyDir = win32.dirname(command);
    const extraDirs = [
      pyDir,
      win32.join(pyDir, "Library", "bin"),
      win32.join(pyDir, "DLLs"),
      win32.join(pyDir, "Scripts"),
    ].filter((dir) => fsOps.existsSync(dir));

    if (extraDirs.length > 0) {
      const existing = (env[pathKey] || "")
        .split(";")
        .map(stripOuterQuotes)
        .filter(Boolean);
      const seen = new Set(existing.map((d) => d.toLowerCase()));
      const prepended = [];
      for (const dir of extraDirs) {
        const key = dir.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          prepended.push(dir);
        }
      }
      if (prepended.length > 0) {
        env[pathKey] = [...prepended, ...(env[pathKey] ? [env[pathKey]] : [])].join(sep);
      }
    }
  }

  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  if (!env.T3_NODE_EXECUTABLE && execPath) {
    env.T3_NODE_EXECUTABLE = execPath;
  }
  return env;
}

export function collectPythonCandidates({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  fsOps = { existsSync, readdirSync },
} = {}) {
  const explicit = env.T3_DELETE_SESSIONS_PYTHON?.trim();
  if (explicit) {
    return [{ command: explicit, prefixArgs: [], explicit: true }];
  }

  if (platform !== "win32") {
    return [
      { command: "python3", prefixArgs: [] },
      { command: "python", prefixArgs: [] },
    ];
  }

  const candidates = [];
  const seen = new Set();
  const add = (command, prefixArgs = []) => {
    if (!command) return;
    const key = `${command.toLowerCase()}\0${prefixArgs.join("\0")}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ command, prefixArgs });
  };

  const pathKey = findPathKey(env, "win32");
  const pathDirs = (env[pathKey] || "")
    .split(";")
    .map(stripOuterQuotes)
    .filter(Boolean);

  for (const dir of pathDirs) {
    if (isWindowsAppsStub(`${dir}\\`)) continue;
    for (const exe of ["python.exe", "python3.exe"]) {
      const full = win32.join(dir, exe);
      if (fsOps.existsSync(full)) {
        add(full);
      }
    }
  }

  add("python", []);
  add("py", ["-3"]);
  add("python3", []);

  const userHome = env.USERPROFILE || homedir;
  const directRoots = [
    env.CONDA_PREFIX,
    env.CONDA_EXE ? win32.dirname(win32.dirname(env.CONDA_EXE)) : null,
    env.PYTHONHOME,
    userHome ? win32.join(userHome, "anaconda3") : null,
    userHome ? win32.join(userHome, "miniconda3") : null,
    userHome ? win32.join(userHome, "miniforge3") : null,
    env.PROGRAMDATA ? win32.join(env.PROGRAMDATA, "anaconda3") : null,
    env.PROGRAMDATA ? win32.join(env.PROGRAMDATA, "miniconda3") : null,
  ].filter(Boolean);

  const localProgramsPython = env.LOCALAPPDATA
    ? win32.join(env.LOCALAPPDATA, "Programs", "Python")
    : userHome
      ? win32.join(userHome, "AppData", "Local", "Programs", "Python")
      : null;

  if (localProgramsPython && fsOps.existsSync(localProgramsPython)) {
    try {
      const subdirs = fsOps
        .readdirSync(localProgramsPython)
        .filter((name) => /^Python3\d+/i.test(String(name)))
        .map(String)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const sub of subdirs) {
        directRoots.push(win32.join(localProgramsPython, sub));
      }
    } catch {
      // Ignore unreadable optional fallback directories.
    }
  }

  for (const root of directRoots) {
    const exe = win32.join(root, "python.exe");
    if (!isWindowsAppsStub(exe) && fsOps.existsSync(exe)) {
      add(exe);
    }
  }

  return candidates;
}

function defaultProbe(command, args, env) {
  return spawnSync(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
    windowsHide: true,
  });
}

export function resolvePython({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  execPath = process.execPath,
  fsOps = { existsSync, readdirSync },
  probe = defaultProbe,
} = {}) {
  const candidates = collectPythonCandidates({ env, platform, homedir, fsOps });
  const failures = [];

  for (const candidate of candidates) {
    const candidateEnv = preparePythonEnv(env, candidate.command, {
      platform,
      execPath,
      fsOps,
    });
    const probeArgs = [...candidate.prefixArgs, "-c", PYTHON_PROBE_CODE];
    const res = probe(candidate.command, probeArgs, candidateEnv);
    if (res && !res.error && res.status === 0) {
      return {
        command: candidate.command,
        prefixArgs: candidate.prefixArgs,
        env: candidateEnv,
      };
    }
    const label = [candidate.command, ...candidate.prefixArgs].join(" ");
    const reason = res?.error
      ? res.error.code || res.error.message
      : `exit ${res?.status ?? "unknown"}`;
    failures.push(`${label} (${reason})`);
  }

  throw new Error(
    `Unable to locate a working Python 3.8+ with sqlite3 for t3-delete-sessions. Tried: ${failures.join(", ")}. Set T3_DELETE_SESSIONS_PYTHON to a valid python executable.`
  );
}

export function buildCliExecSpec(
  cli,
  args,
  { platform = process.platform, env = process.env } = {}
) {
  if (!cli || typeof cli !== "string") {
    throw new Error("T3 CLI path is required");
  }
  const allTokens = [cli, ...args];
  if (platform === "win32" && !/\.(exe|com)$/i.test(cli)) {
    for (const token of allTokens) {
      if (typeof token !== "string" || /[\r\n\0"]/.test(token)) {
        throw new Error("Unsafe character in Windows T3 CLI invocation");
      }
    }
    const quoted = allTokens.map((token) => `"${token.replace(/%/g, "%%")}"`);
    const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
    return {
      file: comspec,
      args: ["/d", "/v:off", "/s", "/c", `"${quoted.join(" ")}"`],
      options: {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsVerbatimArguments: true,
        windowsHide: true,
      },
    };
  }

  return {
    file: cli,
    args,
    options: {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  };
}

export function execT3Cli(
  cli,
  args,
  {
    platform = process.platform,
    env = process.env,
    execFileSyncImpl = execFileSync,
  } = {}
) {
  const spec = buildCliExecSpec(cli, args, { platform, env });
  return execFileSyncImpl(spec.file, spec.args, spec.options);
}
