import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import os from "node:os";
import { delimiter, extname, isAbsolute, join, win32 } from "node:path";

export function findPathKey(env, platform = process.platform) {
  return (
    Object.keys(env).find((key) => key.toLowerCase() === "path") ||
    (platform === "win32" ? "Path" : "PATH")
  );
}

function stripOuterQuotes(entry) {
  const trimmed = entry.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isExecutableFile(filePath, platform, fsOps) {
  if (!fsOps.existsSync(filePath)) {
    return false;
  }
  if (platform === "win32") {
    return true;
  }
  try {
    fsOps.accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function whichCommand(
  cmd,
  {
    env = process.env,
    platform = process.platform,
    extraDirs = [],
    fsOps = { existsSync, accessSync },
  } = {}
) {
  if (!cmd) return null;
  const pathMod = platform === "win32" ? win32 : { join, isAbsolute, extname };

  if (pathMod.isAbsolute(cmd) || /[\\/]/.test(cmd)) {
    return isExecutableFile(cmd, platform, fsOps) ? cmd : null;
  }

  const pathKey = findPathKey(env, platform);
  const sep = platform === "win32" ? ";" : delimiter;
  const rawDirs = (env[pathKey] || "")
    .split(sep)
    .map(stripOuterQuotes)
    .filter(Boolean);
  const searchDirs = [...rawDirs, ...extraDirs.filter(Boolean)];

  const extensions =
    platform === "win32"
      ? pathMod.extname(cmd)
        ? [""]
        : (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .filter(Boolean)
      : [""];

  for (const dir of searchDirs) {
    for (const ext of extensions) {
      const candidate = pathMod.join(dir, `${cmd}${ext}`);
      if (isExecutableFile(candidate, platform, fsOps)) {
        return candidate;
      }
      if (platform === "win32" && ext) {
        const lowerCandidate = pathMod.join(dir, `${cmd}${ext.toLowerCase()}`);
        if (lowerCandidate !== candidate && isExecutableFile(lowerCandidate, platform, fsOps)) {
          return lowerCandidate;
        }
      }
    }
  }
  return null;
}

export function resolveT3Cli(
  cliArg = "t3",
  {
    env = process.env,
    platform = process.platform,
    homedir = os.homedir(),
    fsOps = { existsSync, accessSync },
  } = {}
) {
  const pathMod = platform === "win32" ? win32 : { join };
  const extraDirs =
    cliArg === "t3" && homedir ? [pathMod.join(homedir, ".local", "bin")] : [];
  return (
    whichCommand(cliArg, { env, platform, extraDirs, fsOps }) || cliArg
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
