import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  const initialReceipt = {
    status: "scheduled",
    action,
    scheduledAt: new Date(stamp).toISOString(),
    delayMs,
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
    receipt_path: receiptPath,
  });

  let pid = null;
  let launcher = "detached_spawn";

  if (platform === "win32") {
    const cmdLine = [nodePath, cliPath, "--detached-worker", jobPath]
      .map(quoteWindowsArg)
      .join(" ");
    const psScript = [
      `$cmd = ${JSON.stringify(cmdLine)}`,
      `$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }`,
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
      { windowsHide: true, encoding: "utf8", timeout: 8000 }
    );
    const parsedPid = Number.parseInt(String(cim?.stdout ?? "").trim(), 10);
    if (cim && cim.status === 0 && Number.isFinite(parsedPid) && parsedPid > 0) {
      pid = parsedPid;
      launcher = "win32_wmi_process";
    }
  }

  if (pid === null) {
    const child = spawnFn(nodePath, [cliPath, "--detached-worker", jobPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    pid = child.pid ?? null;
  }

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

export async function runDetachedWorker(
  jobPath,
  executeFn,
  { sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}
) {
  try {
    process.on("SIGHUP", () => {});
  } catch {
    // Ignore on platforms without SIGHUP
  }

  const job = JSON.parse(readFileSync(jobPath, "utf8"));
  const action = job.action === "archive" ? "archive" : "delete";
  const delayMs = Math.max(0, Number(job.delay_ms ?? 1500));
  if (delayMs > 0) {
    await sleepFn(delayMs);
  }

  try {
    const result = await executeFn(
      {
        target_host: job.target_host,
        db_path: job.db_path,
        thread_id: job.thread_id,
        keep_parent: false,
        dry_run: false,
      },
      job.config,
      action
    );
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
