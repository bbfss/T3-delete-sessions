import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withDatabase } from "./sqlite.js";

const DEFAULT_CLI_PATH = fileURLToPath(new URL("../bin/cli.js", import.meta.url));

export function defaultCleanupStateDir({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || join(homedir, "AppData", "Local");
    return join(localAppData, "session-family-cleanup");
  }
  const xdgState = env.XDG_STATE_HOME || join(homedir, ".local", "state");
  return join(xdgState, "session-family-cleanup");
}

function writeJsonAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}

function quoteWindowsArg(arg) {
  const s = String(arg);
  if (!/[\s"]/u.test(s)) return s;
  return `"${s.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/gu, "$1$1")}"`;
}

function launchDetachedCliProcess(
  cliArgs,
  {
    platform = process.platform,
    nodePath = process.execPath,
    cliPath = DEFAULT_CLI_PATH,
    spawnFn = spawn,
    spawnSyncFn = spawnSync,
  } = {}
) {
  const safeCwd = os.tmpdir();
  let pid = null;
  let launcher = "detached_spawn";

  if (platform === "win32") {
    const cmdLine = [nodePath, cliPath, ...cliArgs].map(quoteWindowsArg).join(" ");
    const psScript = [
      `$cmd = ${JSON.stringify(cmdLine)}`,
      `$cwd = ${JSON.stringify(safeCwd)}`,
      `$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $cwd }`,
      `if ($null -eq $res -or $res.ReturnValue -ne 0) { exit 1 }`,
      `Write-Output $res.ProcessId`,
    ].join("; ");
    const encoded = Buffer.from(psScript, "utf16le").toString("base64");
    const cim = spawnSyncFn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        encoded,
      ],
      { cwd: safeCwd, windowsHide: true, encoding: "utf8", timeout: 8000 }
    );
    const parsedPid = Number.parseInt(String(cim?.stdout ?? "").trim(), 10);
    if (cim && cim.status === 0 && Number.isFinite(parsedPid) && parsedPid > 0) {
      pid = parsedPid;
      launcher = "win32_wmi_process";
    }
  }

  if (pid === null) {
    const child = spawnFn(nodePath, [cliPath, ...cliArgs], {
      cwd: safeCwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    pid = child.pid ?? null;
  }

  return { pid, launcher };
}

export function spawnDetachedSelfDelete(
  payload,
  {
    platform = process.platform,
    nodePath = process.execPath,
    cliPath = DEFAULT_CLI_PATH,
    stateBaseDir = defaultCleanupStateDir({ platform }),
    spawnFn = spawn,
    spawnSyncFn = spawnSync,
  } = {}
) {
  const action = payload.action === "archive" ? "archive" : "delete";
  const hash = createHash("sha256")
    .update(String(payload.thread_id))
    .digest("hex")
    .slice(0, 12);
  const stamp = Date.now();
  const subDir = action === "archive" ? "self-archive" : "self-delete";
  const dir = join(stateBaseDir, subDir);
  const receiptPath = join(dir, `receipt-${hash}-${stamp}.json`);
  const jobPath = join(dir, `job-${hash}-${stamp}.json`);

  const delayMs = payload.delay_ms ?? 1500;
  const postSettleDelayMs = Math.max(0, Number(payload.post_settle_delay_ms ?? 0));
  const initialReceipt = {
    status: "scheduled",
    action,
    scheduledAt: new Date(stamp).toISOString(),
    delayMs,
    ...(postSettleDelayMs > 0 ? { postSettleDelayMs } : {}),
    target_host: payload.target_host,
    db_path: payload.db_path,
    thread_id: payload.thread_id,
    receipt_path: receiptPath,
  };
  writeJsonAtomic(receiptPath, initialReceipt);
  writeJsonAtomic(jobPath, {
    ...payload,
    action,
    delay_ms: delayMs,
    ...(postSettleDelayMs > 0 ? { post_settle_delay_ms: postSettleDelayMs } : {}),
    receipt_path: receiptPath,
  });

  const { pid, launcher } = launchDetachedCliProcess(["--detached-worker", jobPath], {
    platform,
    nodePath,
    cliPath,
    spawnFn,
    spawnSyncFn,
  });

  writeJsonAtomic(receiptPath, {
    ...initialReceipt,
    pid,
    launcher,
  });

  return {
    action,
    receipt_path: receiptPath,
    job_path: jobPath,
    pid,
    launcher,
    delay_ms: delayMs,
  };
}

export function spawnDetachedScratchReaper(
  directories,
  {
    platform = process.platform,
    nodePath = process.execPath,
    cliPath = DEFAULT_CLI_PATH,
    stateBaseDir = defaultCleanupStateDir({ platform }),
    delaysMs = [1500, 3000, 6000, 12000, 20000],
    spawnFn = spawn,
    spawnSyncFn = spawnSync,
  } = {}
) {
  const uniqueDirs = [...new Set((directories || []).filter(Boolean))];
  const hash = createHash("sha256")
    .update(uniqueDirs.join("\0"))
    .digest("hex")
    .slice(0, 12);
  const stamp = Date.now();
  const dir = join(stateBaseDir, "scratch-reaper");
  const receiptPath = join(dir, `receipt-${hash}-${stamp}.json`);
  const jobPath = join(dir, `job-${hash}-${stamp}.json`);

  const initialReceipt = {
    status: "scheduled",
    scheduledAt: new Date(stamp).toISOString(),
    directories: uniqueDirs,
    delaysMs,
    receipt_path: receiptPath,
  };
  writeJsonAtomic(receiptPath, initialReceipt);
  writeJsonAtomic(jobPath, {
    directories: uniqueDirs,
    delays_ms: delaysMs,
    receipt_path: receiptPath,
  });

  const { pid, launcher } = launchDetachedCliProcess(["--reap-scratch", jobPath], {
    platform,
    nodePath,
    cliPath,
    spawnFn,
    spawnSyncFn,
  });

  writeJsonAtomic(receiptPath, {
    ...initialReceipt,
    pid,
    launcher,
  });

  return {
    receipt_path: receiptPath,
    job_path: jobPath,
    pid,
    launcher,
    directories: uniqueDirs,
  };
}

export async function runDetachedScratchReaper(
  jobPath,
  removeDirFn,
  { sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}
) {
  try {
    process.on("SIGHUP", () => {});
  } catch {
    // Ignore on platforms without SIGHUP
  }
  try {
    process.chdir(os.tmpdir());
  } catch {
    // Best-effort CWD release
  }

  const job = JSON.parse(readFileSync(jobPath, "utf8"));
  const targets = Array.isArray(job.directories) ? [...job.directories] : [];
  const delays =
    Array.isArray(job.delays_ms) && job.delays_ms.length > 0
      ? job.delays_ms
      : [1500, 3000, 6000, 12000, 20000];

  let pending = targets.filter((d) => existsSync(d));
  const lastErrors = new Map();

  for (const delay of delays) {
    if (pending.length === 0) break;
    if (delay > 0) {
      await sleepFn(Number(delay));
    }
    const stillPending = [];
    for (const dir of pending) {
      if (!existsSync(dir)) continue;
      try {
        const res = await removeDirFn(dir);
        if (existsSync(dir)) {
          if (res?.error) lastErrors.set(dir, String(res.error));
          stillPending.push(dir);
        }
      } catch (err) {
        lastErrors.set(dir, String(err?.message || err));
        if (existsSync(dir)) stillPending.push(dir);
      }
    }
    pending = stillPending;
  }

  const removed = targets.filter((d) => !existsSync(d));
  const remaining = targets
    .filter((d) => existsSync(d))
    .map((d) => ({ path: d, reason: lastErrors.get(d) || "Directory still locked" }));

  const receipt = {
    status: remaining.length === 0 ? "completed" : "incomplete",
    completedAt: new Date().toISOString(),
    removed,
    remaining,
  };
  if (job.receipt_path) {
    writeJsonAtomic(job.receipt_path, receipt);
  }
  return receipt;
}

const ACTIVE_THREAD_RUN_STATUSES = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
]);

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "cancelled",
  "interrupted",
  "failed",
]);

function hasActiveProviderTurn(dbPath, threadId) {
  if (!dbPath || !existsSync(dbPath)) return false;
  try {
    return withDatabase(dbPath, { readOnly: true }, (db) => {
      const runsTable = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_runs'"
        )
        .get();
      if (runsTable) {
        const activeRun = db
          .prepare(
            "SELECT status, completed_at FROM orchestration_v2_projection_runs WHERE thread_id = ? AND completed_at IS NULL LIMIT 5"
          )
          .all(threadId)
          .some((r) => r.status && !TERMINAL_RUN_STATUSES.has(r.status));
        if (activeRun) return true;
      }

      const threadTable = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_threads'"
        )
        .get();
      if (threadTable) {
        const trow = db
          .prepare(
            "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?"
          )
          .get(threadId);
        if (trow?.payload_json) {
          const tStatus = JSON.parse(trow.payload_json || "{}").status;
          if (tStatus && ACTIVE_THREAD_RUN_STATUSES.has(tStatus)) {
            return true;
          }
        }
      }

      const table = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_provider_threads'"
        )
        .get();
      if (!table) return false;
      const rows = db
        .prepare(
          "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ?"
        )
        .all(threadId);
      return rows.some((r) => {
        const status = JSON.parse(r.payload_json || "{}").status;
        return status && status !== "idle" && status !== "not_loaded";
      });
    });
  } catch {
    return false;
  }
}

export async function runDetachedWorker(
  jobPath,
  executeFn,
  {
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    sweepExtraScratchFn = null,
  } = {}
) {
  try {
    process.on("SIGHUP", () => {});
  } catch {
    // Ignore on platforms without SIGHUP
  }
  try {
    process.chdir(os.tmpdir());
  } catch {
    // Best-effort CWD release
  }

  const job = JSON.parse(readFileSync(jobPath, "utf8"));
  const action = job.action === "archive" ? "archive" : "delete";
  const delayMs = Math.max(0, Number(job.delay_ms ?? 1500));
  if (delayMs > 0) {
    await sleepFn(delayMs);
  }

  for (let i = 0; i < 80 && hasActiveProviderTurn(job.db_path, job.thread_id); i += 1) {
    await sleepFn(300);
  }
  const postSettleDelayMs = Math.max(0, Number(job.post_settle_delay_ms ?? 0));
  if (postSettleDelayMs > 0) {
    await sleepFn(postSettleDelayMs);
  }

  try {
    const execArgs = {
      target_host: job.target_host,
      db_path: job.db_path,
      thread_id: job.thread_id,
      keep_parent: false,
      dry_run: false,
    };
    if (typeof job.confirm_remove_git_worktrees === "boolean") {
      execArgs.confirm_remove_git_worktrees = job.confirm_remove_git_worktrees;
    }
    if (Array.isArray(job.remote_receipts)) {
      execArgs.remote_receipts = job.remote_receipts;
    }
    const result = await executeFn(execArgs, job.config, action);
    let extraScratchSweep = null;
    if (
      action === "delete" &&
      typeof sweepExtraScratchFn === "function" &&
      Array.isArray(job.extra_scratch_thread_ids) &&
      job.extra_scratch_thread_ids.length > 0
    ) {
      try {
        extraScratchSweep = await sweepExtraScratchFn(job.db_path, job.extra_scratch_thread_ids, {
          confirmRemoveGitWorktrees: Boolean(job.confirm_remove_git_worktrees),
        });
      } catch {
        // Ignore secondary sweep error
      }
    }
    const receipt = {
      status: result.status ?? "completed_via_t3",
      action,
      completedAt: new Date().toISOString(),
      thread_id: job.thread_id,
      parentDeleted: Boolean(result.parentDeleted),
      parentArchived: Boolean(result.parentArchived),
      childrenDeleted:
        action === "delete" && Array.isArray(result.children) ? result.children.length : 0,
      childrenArchived:
        action === "archive" && Array.isArray(result.children) ? result.children.length : 0,
      result,
      ...(extraScratchSweep ? { extraScratchSweep } : {}),
    };
    writeJsonAtomic(job.receipt_path, receipt);
    return receipt;
  } catch (err) {
    const failure = {
      status: "failed",
      action,
      failedAt: new Date().toISOString(),
      thread_id: job.thread_id,
      reason: String(err?.message || err),
    };
    writeJsonAtomic(job.receipt_path, failure);
    throw err;
  }
}
