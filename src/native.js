import { spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import readline from "node:readline";
import { buildCliExecSpec, resolveCodexCli } from "../bin/platform.js";
import { withDatabase } from "./sqlite.js";

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANTIGRAVITY_ID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rmWithRetry(targetPath, { recursive = false, attempts = 4 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (!existsSync(targetPath)) return;
    try {
      rmSync(targetPath, { recursive, force: true });
      if (!existsSync(targetPath)) return;
    } catch (err) {
      const retryable = ["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"].includes(err?.code);
      if (!retryable || i === attempts - 1) throw err;
    }
    await sleep(100 * (i + 1));
  }
}

// T3's nativeThreadRef is the conversation identity; providerSessionId may be shared.
export function nativeEndpoints(dbPath, ids) {
  return withDatabase(dbPath, { readOnly: true }, (db) => {
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_provider_threads'"
      )
      .get();
    if (!table) {
      return ids.map((threadId) => ({
        threadId,
        status: "unverified",
        reason: "Native mapping table unavailable",
      }));
    }

    const rows = db
      .prepare(
        "SELECT thread_id, payload_json FROM orchestration_v2_projection_provider_threads"
      )
      .all();
    const threads = db
      .prepare(
        "SELECT thread_id, deleted_at, payload_json FROM orchestration_v2_projection_threads"
      )
      .all();

    const parsedThreads = new Map(
      threads.map((r) => [r.thread_id, JSON.parse(r.payload_json || "{}")])
    );
    const live = new Set(
      threads
        .filter((r) => !r.deleted_at && !ids.includes(r.thread_id))
        .map((r) => r.thread_id)
    );
    const parents = new Map(
      threads.map((r) => [
        r.thread_id,
        parsedThreads.get(r.thread_id)?.lineage?.parentThreadId,
      ])
    );

    const hasRetainedDescendant = (id) =>
      [...live].some((child) => {
        const visited = new Set();
        for (
          let parent = parents.get(child);
          parent && !visited.has(parent);
          parent = parents.get(parent)
        ) {
          if (parent === id) return true;
          visited.add(parent);
        }
        return false;
      });

    const mapped = rows.map((r) => ({
      threadId: r.thread_id,
      ...JSON.parse(r.payload_json),
    }));

    const result = [];
    for (const threadId of ids) {
      let matches = mapped.filter((r) => r.threadId === threadId);
      const tPayload = parsedThreads.get(threadId);
      const worktreePath = tPayload?.worktreePath || null;

      if (!matches.length) {
        const imported = /^import:([^:]+):([0-9a-f-]{36})$/i.exec(threadId);
        if (imported) {
          matches = [
            {
              threadId,
              driver: imported[1],
              nativeThreadRef: {
                driver: imported[1],
                nativeId: imported[2],
                strength: "strong",
              },
            },
          ];
        } else if (tPayload && !tPayload.activeProviderThreadId) {
          result.push({
            threadId,
            status: "no_native_session",
            reason: "Thread never bound a standalone native conversation",
          });
          continue;
        } else {
          result.push({
            threadId,
            status: "unverified",
            reason: "No verified native mapping",
          });
          continue;
        }
      }

      for (const r of matches) {
        const provider = r.nativeThreadRef?.driver ?? r.driver;
        const nativeId = r.nativeThreadRef?.nativeId;
        const endpoint = { threadId, provider, nativeId };
        if (worktreePath) endpoint.worktreePath = worktreePath;

        if (!nativeId || r.nativeThreadRef?.strength !== "strong") {
          Object.assign(endpoint, {
            status: "unverified",
            reason: "No strong native identity",
          });
        } else if (
          mapped.some(
            (other) =>
              live.has(other.threadId) &&
              other.nativeThreadRef?.nativeId === nativeId &&
              (other.nativeThreadRef?.driver ?? other.driver) === provider
          )
        ) {
          Object.assign(endpoint, {
            status: "blocked",
            reason: "Native conversation is used by a retained T3 thread",
          });
        } else if (hasRetainedDescendant(threadId)) {
          Object.assign(endpoint, {
            status: "blocked",
            reason: "Native deletion may cascade into a retained descendant",
          });
        } else {
          endpoint.status = "ready";
        }

        if (
          !result.some(
            (e) => nativeId && e.nativeId === nativeId && e.provider === provider
          )
        ) {
          result.push(endpoint);
        }
      }
    }
    return result;
  });
}

function findMatchingFilesRecursive(dirPath, needle) {
  if (!existsSync(dirPath)) return [];
  const hits = [];
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.includes(needle)) {
        hits.push(full);
      }
    }
  }
  return hits;
}

function verifyCodexLocalStorageGone(nativeId, codexHome) {
  if (!codexHome || !existsSync(codexHome)) {
    return { gone: true };
  }
  let entries = [];
  try {
    entries = readdirSync(codexHome);
  } catch {
    return { gone: true };
  }

  for (const name of entries) {
    if (!/^state_\d+\.sqlite$/i.test(name)) continue;
    const sqlitePath = join(codexHome, name);
    try {
      const count = withDatabase(sqlitePath, { readOnly: true }, (db) => {
        const hasThreads = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='threads'")
          .get();
        if (!hasThreads) return 0;
        const row = db
          .prepare("SELECT count(*) AS c FROM threads WHERE id = ?")
          .get(nativeId);
        return Number(row?.c ?? 0);
      });
      if (count > 0) {
        return { gone: false, detail: `Row still exists in ${name}` };
      }
    } catch {
      // Ignore transient lock while verifying; caller retries if needed.
    }
  }

  for (const sub of ["sessions", "archived_sessions"]) {
    const hits = findMatchingFilesRecursive(join(codexHome, sub), nativeId);
    if (hits.length > 0) {
      return { gone: false, detail: `Rollout file still exists: ${hits[0]}` };
    }
  }

  return { gone: true };
}

export async function deleteCodex(
  nativeId,
  {
    command = "codex",
    env = process.env,
    platform = process.platform,
    homedir = os.homedir(),
    maxAttempts = 8,
    retryDelayMs = 600,
  } = {}
) {
  if (!CANONICAL_UUID_RE.test(nativeId)) {
    return { status: "unverified", reason: "Invalid native UUID" };
  }

  const codexHome = resolve(env.CODEX_HOME || join(homedir, ".codex"));
  const resolvedCli = resolveCodexCli(command, { env, platform, homedir });
  const spec = buildCliExecSpec(resolvedCli, ["app-server", "--stdio"], {
    platform,
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });

  const child = spawn(spec.file, spec.args, {
    stdio: spec.options.stdio,
    windowsVerbatimArguments: spec.options.windowsVerbatimArguments,
    windowsHide: spec.options.windowsHide,
    env,
  });

  const pending = new Map();
  let seq = 0;
  const lines = readline.createInterface({ input: child.stdout });
  const fail = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("exit", () => fail(new Error("Native app-server exited")));
  lines.on("line", (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      return;
    }
    const item = pending.get(response.id);
    if (item) {
      pending.delete(response.id);
      item.resolve(response);
    }
  });

  const call = (method, params) =>
    new Promise((resolveCall, rejectCall) => {
      const id = ++seq;
      pending.set(id, { resolve: resolveCall, reject: rejectCall });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });

  const timer = setTimeout(() => {
    fail(new Error("Native delete timed out"));
    child.kill();
  }, 30000);

  try {
    const init = await call("initialize", {
      clientInfo: { name: "t3-session-cleanup", version: "1.8.0" },
    });
    if (init.error) throw new Error(init.error.message);

    const preRead = await call("thread/read", {
      threadId: nativeId,
      includeTurns: false,
    });
    const preMsg = preRead.error?.message ?? "";
    if (
      preMsg.includes(nativeId) &&
      /no rollout found|not found/i.test(preMsg) &&
      verifyCodexLocalStorageGone(nativeId, codexHome).gone
    ) {
      return {
        status: "already_deleted",
        verification: preMsg,
      };
    }

    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const deleted = await call("thread/delete", { threadId: nativeId });
      if (!deleted.error) {
        lastErr = null;
        break;
      }
      const errMsg = deleted.error.message ?? "Unknown Codex delete error";
      if (/no rollout found|not found/i.test(errMsg)) {
        lastErr = null;
        break;
      }
      lastErr = errMsg;
      if (/active writer|locked|busy/i.test(errMsg) && attempt < maxAttempts) {
        try {
          await call("thread/archive", { threadId: nativeId });
        } catch {
          // Best-effort release hint before backoff retry.
        }
        await sleep(retryDelayMs);
        continue;
      }
      return { status: "failed", reason: errMsg };
    }

    if (lastErr) {
      return { status: "failed", reason: lastErr };
    }

    const check = await call("thread/read", {
      threadId: nativeId,
      includeTurns: false,
    });
    const message = check.error?.message ?? "";
    const missingRpc =
      message.includes(nativeId) && /no rollout found|not found/i.test(message);

    let diskCheck = verifyCodexLocalStorageGone(nativeId, codexHome);
    for (let i = 0; !diskCheck.gone && i < 4; i += 1) {
      await sleep(150);
      diskCheck = verifyCodexLocalStorageGone(nativeId, codexHome);
    }

    if (missingRpc && diskCheck.gone) {
      return {
        status: "deleted",
        verification: `${message}; absent from local Codex SQLite and rollout dirs`,
      };
    }
    return {
      status: "unverified",
      verification: !missingRpc
        ? message || "Native conversation still readable"
        : diskCheck.detail,
    };
  } catch (error) {
    return { status: "failed", reason: error.message };
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.destroy();
    child.kill();
  }
}

function isScratchWorktree(worktreePath, scratchRoot) {
  if (!worktreePath || !scratchRoot) return false;
  const resolvedWt = resolve(worktreePath);
  const resolvedScratch = resolve(scratchRoot);
  return (
    dirname(resolvedWt) === resolvedScratch ||
    resolvedWt.startsWith(`${resolvedScratch}${sep}`)
  );
}

export async function deleteClaude(
  nativeId,
  {
    env = process.env,
    homedir = os.homedir(),
    scratchRoot = null,
    worktreePath = null,
    sdk = null,
  } = {}
) {
  if (sdk) {
    try {
      const before = await sdk.getSessionInfo(nativeId);
      if (!before) {
        return {
          status: "already_deleted",
          verification: "Absent from local Claude SDK session lookup",
        };
      }
      await sdk.deleteSession(nativeId);
      const after = await sdk.getSessionInfo(nativeId);
      return {
        status: after ? "failed" : "deleted",
        verification: after
          ? "Local session still exists"
          : "Absent from local Claude SDK session lookup",
      };
    } catch (error) {
      return { status: "failed", reason: error.message };
    }
  }

  if (!CANONICAL_UUID_RE.test(nativeId)) {
    return { status: "unverified", reason: "Invalid native UUID" };
  }

  try {
    const claudeDir = resolve(env.CLAUDE_CONFIG_DIR || join(homedir, ".claude"));
    const projectsRoot = join(claudeDir, "projects");
    let foundAny = false;
    const candidateScratchProjDirs = new Set();

    if (isScratchWorktree(worktreePath, scratchRoot)) {
      const encoded = resolve(worktreePath).replace(/[^a-zA-Z0-9]/g, "-");
      candidateScratchProjDirs.add(join(projectsRoot, encoded));
    }

    if (existsSync(projectsRoot)) {
      for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const projDir = join(projectsRoot, entry.name);
        const jsonlFile = join(projDir, `${nativeId}.jsonl`);
        const sidecarDir = join(projDir, nativeId);
        const hasJsonl = existsSync(jsonlFile);
        const hasSidecar = existsSync(sidecarDir);
        if (hasJsonl || hasSidecar) {
          foundAny = true;
          if (hasJsonl) await rmWithRetry(jsonlFile);
          if (hasSidecar) await rmWithRetry(sidecarDir, { recursive: true });
          if (
            isScratchWorktree(worktreePath, scratchRoot) ||
            entry.name.includes("-t3-scratch-")
          ) {
            candidateScratchProjDirs.add(projDir);
          }
        }
      }
    }

    for (const auxSub of ["session-env", "file-history"]) {
      const auxTarget = join(claudeDir, auxSub, nativeId);
      if (existsSync(auxTarget)) {
        foundAny = true;
        const isDir = lstatSync(auxTarget).isDirectory();
        await rmWithRetry(auxTarget, { recursive: isDir });
      }
    }

    for (const projDir of candidateScratchProjDirs) {
      if (!existsSync(projDir)) continue;
      try {
        const remaining = readdirSync(projDir);
        const hasOtherSessions = remaining.some((f) => f.endsWith(".jsonl"));
        if (!hasOtherSessions) {
          await rmWithRetry(projDir, { recursive: true });
        }
      } catch {
        // Ignore non-fatal empty scratch project directory pruning errors.
      }
    }

    let stillPresent = false;
    if (existsSync(projectsRoot)) {
      for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const projDir = join(projectsRoot, entry.name);
        if (
          existsSync(join(projDir, `${nativeId}.jsonl`)) ||
          existsSync(join(projDir, nativeId))
        ) {
          stillPresent = true;
          break;
        }
      }
    }

    if (!foundAny) {
      return {
        status: "already_deleted",
        verification: "Absent from local Claude projects storage",
      };
    }
    return {
      status: stillPresent ? "failed" : "deleted",
      verification: stillPresent
        ? "Claude session files still exist on disk"
        : "Removed and verified absent from local Claude storage",
    };
  } catch (error) {
    return { status: "failed", reason: error.message };
  }
}

function collectAntigravityAcpRoots({ dbPath, userdataDir, env, homedir }) {
  const roots = new Set();
  const ud =
    userdataDir ||
    (dbPath
      ? dirname(resolve(dbPath))
      : join(resolve(env.T3CODE_HOME || join(homedir, ".t3")), "userdata"));
  const providersRoot = join(ud, "providers", "antigravity");
  if (existsSync(providersRoot)) {
    for (const entry of readdirSync(providersRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const acp = join(providersRoot, entry.name, "antigravity-acp");
      if (existsSync(acp)) roots.add(acp);
    }
  }
  const standalone = join(homedir, ".gemini", "antigravity");
  if (existsSync(standalone)) {
    roots.add(standalone);
  }
  return [...roots];
}

function collectAntigravityConversationTree(initialId, acpRoots) {
  const ids = new Set([initialId]);
  const queue = [initialId];

  while (queue.length > 0) {
    const cid = queue.shift();
    for (const root of acpRoots) {
      const transcriptPath = join(
        root,
        "brain",
        cid,
        ".system_generated",
        "logs",
        "transcript.jsonl"
      );
      if (!existsSync(transcriptPath)) continue;
      try {
        const raw = readFileSync(transcriptPath, "utf8");
        for (const line of raw.split("\n")) {
          if (!line.includes("INVOKE_SUBAGENT") && !line.includes("invoke_subagent")) {
            continue;
          }
          const regex = /\\?"conversationId\\?"\s*:\s*\\?"([0-9a-f-]{32,36})\\?"/gi;
          let m;
          while ((m = regex.exec(line)) !== null) {
            const subId = m[1];
            if (ANTIGRAVITY_ID_RE.test(subId) && !ids.has(subId)) {
              ids.add(subId);
              queue.push(subId);
            }
          }
        }
      } catch {
        // Ignore unreadable transcript while collecting subagents.
      }
    }
  }

  return [...ids];
}

export async function deleteAntigravity(
  nativeId,
  {
    dbPath = null,
    userdataDir = null,
    env = process.env,
    homedir = os.homedir(),
  } = {}
) {
  if (!ANTIGRAVITY_ID_RE.test(nativeId)) {
    return {
      status: "unverified",
      reason: "Invalid Antigravity conversation ID",
    };
  }

  try {
    const acpRoots = collectAntigravityAcpRoots({
      dbPath,
      userdataDir,
      env,
      homedir,
    });
    const allIds = collectAntigravityConversationTree(nativeId, acpRoots);
    let foundAny = false;

    for (const root of acpRoots) {
      const convDir = join(root, "conversations");
      if (existsSync(convDir)) {
        for (const entry of readdirSync(convDir)) {
          if (allIds.some((cid) => entry === cid || entry.startsWith(`${cid}.`))) {
            foundAny = true;
            const full = join(convDir, entry);
            const isDir = lstatSync(full).isDirectory();
            await rmWithRetry(full, { recursive: isDir });
          }
        }
      }

      for (const cid of allIds) {
        const brainDir = join(root, "brain", cid);
        if (existsSync(brainDir)) {
          foundAny = true;
          await rmWithRetry(brainDir, { recursive: true });
        }
      }
    }

    let remaining = null;
    for (const root of acpRoots) {
      const convDir = join(root, "conversations");
      if (existsSync(convDir)) {
        const hit = readdirSync(convDir).find((entry) =>
          allIds.some((cid) => entry === cid || entry.startsWith(`${cid}.`))
        );
        if (hit) {
          remaining = join(convDir, hit);
          break;
        }
      }
      for (const cid of allIds) {
        const brainDir = join(root, "brain", cid);
        if (existsSync(brainDir)) {
          remaining = brainDir;
          break;
        }
      }
      if (remaining) break;
    }

    if (!foundAny) {
      return {
        status: "already_deleted",
        verification: "Absent from local Antigravity conversations and brain directories",
      };
    }
    return {
      status: remaining ? "failed" : "deleted",
      verification: remaining
        ? `Antigravity artifact still exists: ${remaining}`
        : `Removed and verified absent (${allIds.length} conversation/subagent ID(s))`,
    };
  } catch (error) {
    return { status: "failed", reason: error.message };
  }
}

export async function deleteNativeEndpoints(
  endpoints,
  {
    dbPath = null,
    codexDelete = deleteCodex,
    claudeDelete = deleteClaude,
    antigravityDelete = deleteAntigravity,
  } = {}
) {
  const scratchRoot = dbPath ? resolve(dirname(dirname(dbPath)), "scratch") : null;
  const results = [];
  for (const endpoint of endpoints) {
    if (endpoint.status !== "ready") {
      results.push(endpoint);
      continue;
    }
    let result;
    if (endpoint.provider === "codex") {
      result = await codexDelete(endpoint.nativeId);
    } else if (["claude", "claudeAgent"].includes(endpoint.provider)) {
      result = await claudeDelete(endpoint.nativeId, {
        scratchRoot,
        worktreePath: endpoint.worktreePath ?? null,
      });
    } else if (endpoint.provider === "antigravity") {
      result = await antigravityDelete(endpoint.nativeId, { dbPath });
    } else {
      result = {
        status: "unsupported",
        reason: `No verified per-conversation delete adapter for ${endpoint.provider}`,
      };
    }
    results.push({ ...endpoint, ...result });
  }
  return {
    complete: results.every((r) =>
      ["deleted", "already_deleted", "no_native_session"].includes(r.status)
    ),
    endpoints: results,
  };
}
