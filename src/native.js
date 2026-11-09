import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

async function rmWithRetry(targetPath, { recursive = false, attempts = 6 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (!existsSync(targetPath)) return;
    try {
      rmSync(targetPath, { recursive, force: true });
      if (!existsSync(targetPath)) return;
    } catch (err) {
      const retryable = ["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"].includes(err?.code);
      if (!retryable || i === attempts - 1) throw err;
    }
    await sleep(150 * (i + 1));
  }
}

function hasTable(db, tableName) {
  return Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(tableName)
  );
}

// T3's nativeThreadRef is the conversation identity; providerSessionId may be shared.
export function nativeEndpoints(dbPath, ids) {
  return withDatabase(dbPath, { readOnly: true }, (db) => {
    if (!hasTable(db, "orchestration_v2_projection_provider_threads")) {
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

    const parentMap = new Map();
    for (const r of threads) {
      const pl = parsedThreads.get(r.thread_id) || {};
      const p = pl.lineage?.parentThreadId || pl.delegatedFrom?.threadId || null;
      if (p) parentMap.set(r.thread_id, p);
    }
    if (hasTable(db, "orchestration_v2_projection_subagents")) {
      const subRows = db
        .prepare(
          "SELECT thread_id, child_thread_id FROM orchestration_v2_projection_subagents WHERE child_thread_id IS NOT NULL"
        )
        .all();
      for (const s of subRows) {
        if (s.child_thread_id && s.thread_id && !parentMap.has(s.child_thread_id)) {
          parentMap.set(s.child_thread_id, s.thread_id);
        }
      }
    }

    const hasRetainedDescendant = (id) =>
      [...live].some((child) => {
        const visited = new Set();
        for (
          let parent = parentMap.get(child);
          parent && !visited.has(parent);
          parent = parentMap.get(parent)
        ) {
          if (parent === id) return true;
          visited.add(parent);
        }
        return false;
      });

    const mapped = rows.map((r) => ({
      threadId: r.thread_id,
      ...JSON.parse(r.payload_json || "{}"),
    }));

    const protectedAntigravityNativeIds = new Set(
      mapped
        .filter(
          (other) =>
            live.has(other.threadId) &&
            (other.nativeThreadRef?.driver ?? other.driver) === "antigravity" &&
            other.nativeThreadRef?.nativeId
        )
        .map((other) => other.nativeThreadRef.nativeId)
    );
    const protectedCodexNativeIds = new Set(
      mapped
        .filter(
          (other) =>
            live.has(other.threadId) &&
            (other.nativeThreadRef?.driver ?? other.driver) === "codex" &&
            other.nativeThreadRef?.nativeId
        )
        .map((other) => other.nativeThreadRef.nativeId)
    );

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
        if (provider === "antigravity" && protectedAntigravityNativeIds.size > 0) {
          endpoint.protectedNativeIds = [...protectedAntigravityNativeIds];
        }
        if (provider === "codex" && protectedCodexNativeIds.size > 0) {
          endpoint.protectedNativeIds = [...protectedCodexNativeIds];
        }

        if (!nativeId) {
          Object.assign(endpoint, {
            status: "no_native_session",
            reason: "Provider thread ended before binding a native conversation ID",
          });
        } else if (r.nativeThreadRef?.strength !== "strong") {
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

function findMatchingFilesRecursive(dirPath, needles) {
  if (!existsSync(dirPath)) return [];
  const needleList = Array.isArray(needles) ? needles : [needles];
  if (needleList.length === 0) return [];
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
      } else if (needleList.some((n) => entry.name.includes(n))) {
        hits.push(full);
      }
    }
  }
  return hits;
}

export function discoverCodexSqliteFiles(codexHome) {
  if (!codexHome || !existsSync(codexHome)) return [];
  const files = new Set();
  for (const dir of [codexHome, join(codexHome, "sqlite")]) {
    if (!existsSync(dir)) continue;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (/\.(sqlite|db)$/i.test(entry.name)) {
        files.add(join(dir, entry.name));
      }
    }
  }
  return [...files];
}

export function collectCodexConversationTree(
  initialIds,
  codexHome,
  protectedIds = new Set()
) {
  const startList = Array.isArray(initialIds) ? initialIds : [initialIds];
  const ids = new Set(startList.filter((id) => CANONICAL_UUID_RE.test(id)));
  const queue = [...ids];
  const sqliteFiles = discoverCodexSqliteFiles(codexHome);

  while (queue.length > 0) {
    const currentId = queue.shift();
    for (const sqlitePath of sqliteFiles) {
      try {
        withDatabase(sqlitePath, { readOnly: true }, (db) => {
          if (!hasTable(db, "thread_spawn_edges")) return;
          const rows = db
            .prepare(
              "SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ?"
            )
            .all(currentId);
          for (const r of rows) {
            const childId = r?.child_thread_id;
            if (
              childId &&
              CANONICAL_UUID_RE.test(childId) &&
              !protectedIds.has(childId) &&
              !ids.has(childId)
            ) {
              ids.add(childId);
              queue.push(childId);
            }
          }
        });
      } catch {
        // Ignore locked/unreadable db during tree expansion; verification catches issues.
      }
    }
  }
  return [...ids];
}

const CODEX_THREAD_ID_TABLES = [
  "logs",
  "thread_dynamic_tools",
  "thread_attachments",
  "guardian_review_feedback",
  "thread_read_receipts",
  "thread_items",
  "thread_turns",
  "thread_realtime_items",
  "thread_history_projection_state",
  "thread_goal_continuation_deferrals",
  "thread_goals",
  "queued_items",
  "queued_thread_revisions",
  // ~/.codex/sqlite/codex.db catalog and UI tables:
  "local_thread_catalog",
  "thread_timeline_ledger",
  "local_thread_catalog_scan_entries",
  "inbox_items",
  "automation_runs",
  "live_visualization_suggestions",
  "active_chat_turns",
];

function purgeCodexSessionIndex(targetIdSet, codexHome) {
  const indexPath = join(codexHome, "session_index.jsonl");
  if (!existsSync(indexPath)) return;
  const raw = readFileSync(indexPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const kept = [];
  let changed = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const rowId = parsed?.id ?? parsed?.thread_id ?? parsed?.session_id;
      if (rowId && targetIdSet.has(rowId)) {
        changed = true;
        continue;
      }
    } catch {
      // Preserve unparseable lines untouched.
    }
    kept.push(line);
  }

  if (changed) {
    const tmpPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
    const output = kept.length > 0 ? `${kept.join("\n")}\n` : "";
    writeFileSync(tmpPath, output, "utf8");
    renameSync(tmpPath, indexPath);
  }
}

export function purgeCodexLocalStorage(nativeIds, codexHome, { protectedIds = new Set() } = {}) {
  if (typeof codexHome !== "string" || !codexHome || !existsSync(codexHome)) return [];
  const allIds = collectCodexConversationTree(nativeIds, codexHome, protectedIds);
  if (allIds.length === 0) return [];
  const targetIdSet = new Set(allIds);
  const sqliteFiles = discoverCodexSqliteFiles(codexHome);
  const rolloutPaths = new Set();

  for (const sqlitePath of sqliteFiles) {
    try {
      withDatabase(sqlitePath, { readOnly: false }, (db) => {
        db.exec("PRAGMA busy_timeout = 5000;");
        if (hasTable(db, "threads")) {
          const stmt = db.prepare("SELECT rollout_path FROM threads WHERE id = ?");
          for (const id of allIds) {
            for (const r of stmt.all(id)) {
              if (r?.rollout_path) rolloutPaths.add(r.rollout_path);
            }
          }
        }
        db.exec("BEGIN IMMEDIATE;");
        try {
          for (const tbl of CODEX_THREAD_ID_TABLES) {
            if (hasTable(db, tbl)) {
              const delStmt = db.prepare(`DELETE FROM "${tbl}" WHERE thread_id = ?`);
              for (const id of allIds) {
                delStmt.run(id);
              }
            }
          }
          if (hasTable(db, "automations")) {
            const cols = db
              .prepare('PRAGMA table_info("automations")')
              .all()
              .map((c) => c.name);
            if (cols.includes("target_thread_id")) {
              const autoStmt = db.prepare(
                'DELETE FROM "automations" WHERE target_thread_id = ?'
              );
              for (const id of allIds) {
                autoStmt.run(id);
              }
            }
          }
          if (hasTable(db, "thread_spawn_edges")) {
            const edgeStmt = db.prepare(
              "DELETE FROM thread_spawn_edges WHERE parent_thread_id = ? OR child_thread_id = ?"
            );
            for (const id of allIds) {
              edgeStmt.run(id, id);
            }
          }
          if (hasTable(db, "threads")) {
            const threadStmt = db.prepare("DELETE FROM threads WHERE id = ?");
            for (const id of allIds) {
              threadStmt.run(id);
            }
          }
          db.exec("COMMIT;");
        } catch (err) {
          try {
            db.exec("ROLLBACK;");
          } catch {
            // Ignore rollback error
          }
          throw err;
        }
      });
    } catch {
      // Verification step below strictly validates zero residual rows.
    }
  }

  try {
    purgeCodexSessionIndex(targetIdSet, codexHome);
  } catch {
    // Verified below
  }

  for (const p of rolloutPaths) {
    try {
      rmSync(p, { force: true });
    } catch {
      // Verified below
    }
  }

  for (const sub of ["sessions", "archived_sessions", "thread-writer-locks"]) {
    const hits = findMatchingFilesRecursive(join(codexHome, sub), allIds);
    for (const hit of hits) {
      try {
        rmSync(hit, { force: true });
      } catch {
        // Verified below
      }
    }
  }

  return allIds;
}

export function verifyCodexLocalStorageGone(nativeIds, codexHome) {
  if (typeof codexHome !== "string" || !codexHome || !existsSync(codexHome)) {
    return { gone: true };
  }
  const idList = Array.isArray(nativeIds) ? nativeIds : [nativeIds];
  if (idList.length === 0) return { gone: true };
  const targetIdSet = new Set(idList);
  const sqliteFiles = discoverCodexSqliteFiles(codexHome);

  for (const sqlitePath of sqliteFiles) {
    try {
      const checkResult = withDatabase(sqlitePath, { readOnly: true }, (db) => {
        if (hasTable(db, "threads")) {
          const stmt = db.prepare("SELECT count(*) AS c FROM threads WHERE id = ?");
          for (const id of idList) {
            if (Number(stmt.get(id)?.c ?? 0) > 0) {
              return {
                gone: false,
                detail: `Row still exists in ${sqlitePath} (threads: ${id})`,
              };
            }
          }
        }
        if (hasTable(db, "local_thread_catalog")) {
          const stmt = db.prepare(
            "SELECT count(*) AS c FROM local_thread_catalog WHERE thread_id = ?"
          );
          for (const id of idList) {
            if (Number(stmt.get(id)?.c ?? 0) > 0) {
              return {
                gone: false,
                detail: `Row still exists in ${sqlitePath} (local_thread_catalog: ${id})`,
              };
            }
          }
        }
        if (hasTable(db, "thread_spawn_edges")) {
          const stmt = db.prepare(
            "SELECT count(*) AS c FROM thread_spawn_edges WHERE parent_thread_id = ? OR child_thread_id = ?"
          );
          for (const id of idList) {
            if (Number(stmt.get(id, id)?.c ?? 0) > 0) {
              return {
                gone: false,
                detail: `Spawn edge still exists in ${sqlitePath} (thread_spawn_edges: ${id})`,
              };
            }
          }
        }
        return { gone: true };
      });
      if (!checkResult.gone) return checkResult;
    } catch (err) {
      return {
        gone: false,
        detail: `SQLite verification error on ${sqlitePath}: ${err.message}`,
      };
    }
  }

  const indexPath = join(codexHome, "session_index.jsonl");
  if (existsSync(indexPath)) {
    try {
      const raw = readFileSync(indexPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const rowId = parsed?.id ?? parsed?.thread_id ?? parsed?.session_id;
          if (rowId && targetIdSet.has(rowId)) {
            return {
              gone: false,
              detail: `Entry still exists in session_index.jsonl (${rowId})`,
            };
          }
        } catch {
          // Ignore malformed line
        }
      }
    } catch (err) {
      return {
        gone: false,
        detail: `Failed to verify session_index.jsonl: ${err.message}`,
      };
    }
  }

  for (const sub of ["sessions", "archived_sessions"]) {
    const hits = findMatchingFilesRecursive(join(codexHome, sub), idList);
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
    maxAttempts = 2,
    retryDelayMs = 250,
    protectedNativeIds = [],
  } = {}
) {
  if (!CANONICAL_UUID_RE.test(nativeId)) {
    return { status: "unverified", reason: "Invalid native UUID" };
  }

  const codexHome = resolve(env.CODEX_HOME || join(homedir, ".codex"));
  const protectedSet = new Set(protectedNativeIds);
  const targetIds = collectCodexConversationTree([nativeId], codexHome, protectedSet);

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
      clientInfo: { name: "t3-session-cleanup", version: "1.9.0" },
    });
    if (init.error) throw new Error(init.error.message);

    const preRead = await call("thread/read", {
      threadId: nativeId,
      includeTurns: false,
    });
    const preMsg = preRead.error?.message ?? "";
    const preDisk = verifyCodexLocalStorageGone(targetIds, codexHome);
    if (
      preMsg.includes(nativeId) &&
      /no rollout found|not found|thread not loaded/i.test(preMsg) &&
      preDisk.gone
    ) {
      return {
        status: "already_deleted",
        verification: preMsg,
      };
    }

    let lastErr = null;
    for (const tid of targetIds) {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const deleted = await call("thread/delete", { threadId: tid });
        if (!deleted.error) {
          lastErr = null;
          break;
        }
        const errMsg = deleted.error.message ?? "Unknown Codex delete error";
        if (/no rollout found|not found|thread not loaded/i.test(errMsg)) {
          lastErr = null;
          break;
        }
        lastErr = errMsg;
        if (/active writer|locked|busy/i.test(errMsg)) {
          if (attempt < maxAttempts) {
            await sleep(retryDelayMs);
            continue;
          }
          break;
        }
        return { status: "failed", reason: errMsg };
      }
    }

    // Always purge local SQLite (state_*.sqlite + sqlite/codex.db), session_index.jsonl,
    // thread_spawn_edges, and rollout files so UI catalog entries never linger.
    purgeCodexLocalStorage(targetIds, codexHome, { protectedIds: protectedSet });
    const diskAfterPurge = verifyCodexLocalStorageGone(targetIds, codexHome);

    if (lastErr && /active writer|locked|busy/i.test(lastErr)) {
      if (diskAfterPurge.gone) {
        return {
          status: "deleted",
          verification:
            "Purged directly from local Codex SQLite (including codex.db), session_index.jsonl, and rollout dirs while app-server writer lock awaits idle eviction",
        };
      }
      return { status: "failed", reason: `${lastErr} (${diskAfterPurge.detail})` };
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
      message.includes(nativeId) &&
      /no rollout found|not found|thread not loaded/i.test(message);

    if (missingRpc && diskAfterPurge.gone) {
      return {
        status: "deleted",
        verification: `${message}; absent from local Codex SQLite (state_*.sqlite & codex.db), session_index.jsonl, and rollout dirs`,
      };
    }
    return {
      status: "unverified",
      verification: !missingRpc
        ? message || "Native conversation still readable"
        : diskAfterPurge.detail,
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
            entry.name.includes("-t3-scratch-") ||
            entry.name.includes("-t3-worktrees-")
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

function collectAntigravityConversationTree(
  initialId,
  acpRoots,
  protectedIds = new Set()
) {
  if (protectedIds.has(initialId)) return [];
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
            if (
              ANTIGRAVITY_ID_RE.test(subId) &&
              !protectedIds.has(subId) &&
              !ids.has(subId)
            ) {
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
    protectedNativeIds = [],
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
    const protectedSet = new Set(protectedNativeIds);
    const allIds = collectAntigravityConversationTree(
      nativeId,
      acpRoots,
      protectedSet
    );
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
      result = await codexDelete(endpoint.nativeId, {
        protectedNativeIds: endpoint.protectedNativeIds ?? [],
      });
    } else if (["claude", "claudeAgent"].includes(endpoint.provider)) {
      result = await claudeDelete(endpoint.nativeId, {
        scratchRoot,
        worktreePath: endpoint.worktreePath ?? null,
      });
    } else if (endpoint.provider === "antigravity") {
      result = await antigravityDelete(endpoint.nativeId, {
        dbPath,
        protectedNativeIds: endpoint.protectedNativeIds ?? [],
      });
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
