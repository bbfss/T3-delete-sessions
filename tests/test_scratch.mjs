import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectWorktreesForThreads, removeDeletedScratch } from "../src/cleaner.js";
import { callTool } from "../src/server.js";
import os from "node:os";

test("removes whole deleted scratch including hidden directories, preserves shared and external workspaces", () => {
  const root = mkdtempSync(join(tmpdir(), "t3-scratch-test-"));
  try {
    mkdirSync(join(root, "userdata"));
    const dbPath = join(root, "userdata", "statev2.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,deleted_at TEXT,payload_json TEXT)"
    );
    const insert = db.prepare(
      "INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?)"
    );
    for (const [id, path, deleted] of [
      ["a", "scratch/a", "yes"],
      ["b", "scratch/b", "yes"],
      ["c", "scratch/b", null],
      ["d", "project", "yes"],
    ]) {
      const dir = join(root, path);
      mkdirSync(join(dir, ".agents", "skills"), { recursive: true });
      insert.run(id, deleted, JSON.stringify({ worktreePath: dir }));
    }
    db.close();
    removeDeletedScratch(dbPath, ["a", "b", "d"]);
    assert.equal(existsSync(join(root, "scratch/a")), false);
    assert.equal(existsSync(join(root, "scratch/b")), true);
    assert.equal(existsSync(join(root, "project")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git-enabled scratch and isolated worktree directories require explicit confirmation while project roots are always protected", () => {
  const root = mkdtempSync(join(tmpdir(), "t3-git-wt-test-"));
  try {
    mkdirSync(join(root, "userdata"));
    const dbPath = join(root, "userdata", "statev2.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,deleted_at TEXT,payload_json TEXT);
      CREATE TABLE projection_projects(project_id TEXT, workspace_root TEXT, deleted_at TEXT);
    `);

    const scratchGitDir = join(root, "scratch", "git-scratch");
    mkdirSync(join(scratchGitDir, ".git"), { recursive: true });

    const isolatedWtDir = join(root, "worktrees", "repo", "wt-1");
    mkdirSync(isolatedWtDir, { recursive: true });
    writeFileSync(join(isolatedWtDir, ".git"), "gitdir: /tmp/fake/.git/worktrees/wt-1\n");

    const mainProjectDir = join(root, "main-project");
    mkdirSync(join(mainProjectDir, ".git"), { recursive: true });

    db.prepare("INSERT INTO projection_projects VALUES ('p1', ?, NULL)").run(
      mainProjectDir
    );
    const ins = db.prepare(
      "INSERT INTO orchestration_v2_projection_threads VALUES (?, 'yes', ?)"
    );
    ins.run("t-scratch-git", JSON.stringify({ worktreePath: scratchGitDir }));
    ins.run("t-wt", JSON.stringify({ worktreePath: isolatedWtDir }));
    ins.run("t-main", JSON.stringify({ worktreePath: mainProjectDir }));
    db.close();

    const inspected = inspectWorktreesForThreads(dbPath, [
      "t-scratch-git",
      "t-wt",
      "t-main",
    ]);
    const reqConfirm = inspected.filter((x) => x.requiresConfirmation);
    assert.equal(reqConfirm.length, 2);

    // Without confirmRemoveGitWorktrees: both git scratch and isolated worktree are retained
    const resUnconfirmed = removeDeletedScratch(
      dbPath,
      ["t-scratch-git", "t-wt", "t-main"],
      { confirmRemoveGitWorktrees: false }
    );
    assert.equal(existsSync(scratchGitDir), true);
    assert.equal(existsSync(isolatedWtDir), true);
    assert.equal(existsSync(mainProjectDir), true);
    assert.ok(resUnconfirmed.every((r) => r.status === "retained_git"));

    // With confirmRemoveGitWorktrees=true: git scratch and isolated worktree are removed, main project is still preserved
    const resConfirmed = removeDeletedScratch(
      dbPath,
      ["t-scratch-git", "t-wt", "t-main"],
      { confirmRemoveGitWorktrees: true }
    );
    assert.equal(existsSync(scratchGitDir), false);
    assert.equal(existsSync(isolatedWtDir), false);
    assert.equal(existsSync(mainProjectDir), true);
    assert.ok(resConfirmed.every((r) => r.status === "removed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite auto-discovery builds remote_then_local plan and blocks single-host delete until remote receipts arrive", async () => {
  const root = mkdtempSync(join(tmpdir(), "t3-remote-auto-"));
  try {
    mkdirSync(join(root, "userdata"));
    const dbPath = join(root, "userdata", "statev2.sqlite");
    writeFileSync(join(root, "userdata", "environment-id"), "env-mac\n");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE orchestration_v2_projection_threads(
        thread_id TEXT PRIMARY KEY,
        title TEXT,
        default_provider TEXT,
        created_at TEXT,
        updated_at TEXT,
        archived_at TEXT,
        deleted_at TEXT,
        payload_json TEXT
      );
      CREATE TABLE orchestration_v2_projection_subagents(
        subagent_id TEXT,
        thread_id TEXT,
        child_thread_id TEXT,
        driver TEXT,
        payload_json TEXT
      );
    `);
    const insT = db.prepare(
      "INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, 'codex', 'now', 'now', NULL, NULL, ?)"
    );
    insT.run("parent-1", "Parent", JSON.stringify({}));
    insT.run(
      "local-child-1",
      "Local Child",
      JSON.stringify({ lineage: { parentThreadId: "parent-1" } })
    );

    db.prepare(
      "INSERT INTO orchestration_v2_projection_subagents VALUES (?, ?, NULL, 'remote', ?)"
    ).run(
      "sub-rem-1",
      "parent-1",
      JSON.stringify({
        id: "sub-rem-1",
        threadId: "parent-1",
        driver: "remote",
        title: "Remote Task on Legion",
        remoteChild: {
          environmentId: "env-legion-win",
          threadId: "remote-thread-99",
          label: "黄十七联想拯救者",
        },
      })
    );
    db.close();

    const config = { db: dbPath, t3Url: "http://127.0.0.1:3773", t3Cli: "t3" };
    // Auto-build cross-device plan without passing manual registry!
    const plan = await callTool(
      "plan_cross_device_cleanup",
      { current_thread_id: "parent-1" },
      config
    );
    assert.equal(plan.order, "remote_then_local");
    assert.equal(plan.steps.length, 2);
    assert.equal(plan.steps[0].phase, "remote");
    assert.equal(plan.steps[0].environment_id, "env-legion-win");
    assert.equal(plan.steps[0].thread_id, "remote-thread-99");
    assert.equal(plan.steps[1].phase, "local");
    assert.equal(plan.steps[1].thread_id, "local-child-1");

    // Calling delete_subsessions(dry_run=false) without remote_receipts is blocked!
    const blocked = await callTool(
      "delete_subsessions",
      {
        target_host: os.hostname(),
        db_path: dbPath,
        thread_id: "parent-1",
        dry_run: false,
      },
      config
    );
    assert.equal(blocked.status, "blocked_by_remote_descendants");
    assert.equal(blocked.pendingRemoteChildren.length, 1);
    assert.equal(blocked.pendingRemoteChildren[0].environmentId, "env-legion-win");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removeDeletedScratch clears read-only files and schedules detached reaper on transient Windows EPERM lock", async () => {
  const { chmodSync, readFileSync } = await import("node:fs");
  const { forceRemoveDirectorySync } = await import("../src/cleaner.js");
  const { runDetachedScratchReaper, spawnDetachedScratchReaper } = await import(
    "../src/self-delete.js"
  );

  const root = mkdtempSync(join(tmpdir(), "t3-scratch-eperm-"));
  try {
    mkdirSync(join(root, "userdata"));
    const dbPath = join(root, "userdata", "statev2.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,deleted_at TEXT,payload_json TEXT)"
    );

    const roDir = join(root, "scratch", "readonly-dir");
    mkdirSync(join(roDir, ".gemini"), { recursive: true });
    const roFile = join(roDir, ".gemini", "locked.txt");
    writeFileSync(roFile, "readonly");
    chmodSync(roFile, 0o444);

    const epermDir = join(root, "scratch", "eperm-dir");
    mkdirSync(epermDir, { recursive: true });

    const ins = db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?)");
    ins.run("t-ro", "yes", JSON.stringify({ worktreePath: roDir }));
    ins.run("t-eperm", "yes", JSON.stringify({ worktreePath: epermDir }));
    db.close();

    // 1. Read-only file inside scratch directory is cleared and removed synchronously
    const roRes = removeDeletedScratch(dbPath, ["t-ro"]);
    assert.equal(roRes[0].status, "removed");
    assert.equal(existsSync(roDir), false);

    // 2. Simulated transient Windows EPERM CWD lock schedules detached scratch reaper instead of failing
    let spawnedReaperJob = null;
    const epermRes = removeDeletedScratch(dbPath, ["t-eperm"], {
      platform: "win32",
      rmSyncFn: () => {
        const err = new Error("EPERM: operation not permitted, rmdir");
        err.code = "EPERM";
        throw err;
      },
      spawnSyncFn: () => ({ status: 1 }),
      spawnScratchReaperFn: (dirs) => {
        const out = spawnDetachedScratchReaper(dirs, {
          platform: "win32",
          stateBaseDir: join(root, "state"),
          delaysMs: [10, 20],
          spawnSyncFn: () => ({ status: 0, stdout: "88888\r\n" }),
          spawnFn: () => {
            throw new Error("unexpected fallback");
          },
        });
        spawnedReaperJob = out;
        return out;
      },
    });
    assert.equal(epermRes.length, 1);
    assert.equal(epermRes[0].status, "scheduled_deferred_remove");
    assert.equal(epermRes[0].reaperPid, 88888);
    assert.ok(existsSync(epermDir));

    // 3. When the detached reaper runs after handle closes, it removes the scratch directory and records receipt
    let attempts = 0;
    const reaperReceipt = await runDetachedScratchReaper(
      spawnedReaperJob.job_path,
      (dir) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("EPERM: still shutting down");
        }
        return forceRemoveDirectorySync(dir);
      },
      { sleepFn: async () => {} }
    );
    assert.equal(reaperReceipt.status, "completed");
    assert.equal(existsSync(epermDir), false);
    const saved = JSON.parse(readFileSync(spawnedReaperJob.receipt_path, "utf8"));
    assert.equal(saved.status, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
