import assert from "node:assert/strict";
import { realpathSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDetachedWorker, spawnDetachedSelfDelete } from "../src/self-delete.js";
import { callTool, parseCliArgs } from "../src/server.js";
import { normalizeDbPath, withDatabase } from "../src/sqlite.js";

function createSelfDeleteFixture() {
  const root = realpathSync(mkdtempSync(join(os.tmpdir(), "t3-self-del-")));
  mkdirSync(join(root, "userdata"), { recursive: true });
  const db = normalizeDbPath(join(root, "userdata", "statev2.sqlite"));
  writeFileSync(db, "");
  withDatabase(db, { readOnly: false }, (conn) => {
    conn.exec(`
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
        thread_id TEXT,
        child_thread_id TEXT
      );
    `);
    const ins = conn.prepare(
      "INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, 'antigravity', 'now', 'now', NULL, NULL, ?)"
    );
    ins.run("root-1", "Root", JSON.stringify({ lineage: { parentThreadId: null } }));
    ins.run(
      "child-1",
      "Child",
      JSON.stringify({ lineage: { parentThreadId: "root-1" } })
    );
  });
  return { root, db };
}

test("schedule_delete_family previews and schedules detached deletion", async () => {
  const { root, db } = createSelfDeleteFixture();
  try {
    await assert.rejects(
      () =>
        callTool(
          "schedule_delete_family",
          { target_host: os.hostname(), db_path: db, thread_id: "root-1", dry_run: true },
          { db }
        ),
      /requires a running online T3 server/
    );

    const preview = await callTool(
      "schedule_delete_family",
      { target_host: os.hostname(), db_path: db, thread_id: "root-1", dry_run: true },
      { db, t3Url: "http://127.0.0.1:3773" }
    );
    assert.equal(preview.parentSelected, true);
    assert.equal(preview.children.length, 1);
    assert.equal(preview.children[0].threadId, "child-1");

    let capturedPayload = null;
    const scheduled = await callTool(
      "schedule_delete_family",
      {
        target_host: os.hostname(),
        db_path: db,
        thread_id: "root-1",
        delay_ms: 800,
        dry_run: false,
      },
      { db, t3Url: "http://127.0.0.1:3773", t3Cli: "t3" },
      {
        spawnSelfDeleteFn: (payload) => {
          capturedPayload = payload;
          return {
            receipt_path: join(root, "receipt.json"),
            job_path: join(root, "job.json"),
            pid: 42424,
            launcher: "mock",
            delay_ms: payload.delay_ms,
          };
        },
      }
    );
    assert.equal(scheduled.status, "scheduled_detached_delete");
    assert.equal(scheduled.pid, 42424);
    assert.equal(capturedPayload.delay_ms, 800);
    assert.equal(capturedPayload.thread_id, "root-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("spawnDetachedSelfDelete supports win32 WMI launcher and runDetachedWorker writes verified receipt", async () => {
  const { root, db } = createSelfDeleteFixture();
  try {
    const scheduled = spawnDetachedSelfDelete(
      {
        target_host: os.hostname(),
        db_path: db,
        thread_id: "root-1",
        delay_ms: 200,
        config: { db, t3Url: "http://127.0.0.1:3773", t3Cli: "t3" },
      },
      {
        platform: "win32",
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        cliPath: "C:\\Users\\test\\cli.js",
        stateBaseDir: join(root, "state"),
        spawnSyncFn: () => ({ status: 0, stdout: "51515\r\n" }),
        spawnFn: () => {
          throw new Error("should not use fallback when WMI succeeds");
        },
      }
    );
    assert.equal(scheduled.pid, 51515);
    assert.equal(scheduled.launcher, "win32_wmi_process");

    const initial = JSON.parse(readFileSync(scheduled.receipt_path, "utf8"));
    assert.equal(initial.status, "scheduled");
    assert.equal(initial.pid, 51515);

    const parsed = parseCliArgs(["--detached-worker", scheduled.job_path]);
    assert.equal(parsed.detachedWorker, scheduled.job_path);

    let sleptMs = 0;
    const finalReceipt = await runDetachedWorker(
      scheduled.job_path,
      async (args, jobConfig) =>
        callTool("delete_family", args, jobConfig, {
          dispatchFn: async ({ commands }) => {
            assert.deepEqual(
              commands.map((c) => `${c.type}:${c.threadId}`),
              [
                "thread.stop:child-1",
                "thread.delete:child-1",
                "thread.stop:root-1",
                "thread.delete:root-1",
              ]
            );
            withDatabase(db, { readOnly: false }, (conn) => {
              conn
                .prepare(
                  "UPDATE orchestration_v2_projection_threads SET deleted_at = 'now' WHERE thread_id IN ('child-1', 'root-1')"
                )
                .run();
            });
          },
        }),
      {
        sleepFn: async (ms) => {
          sleptMs = ms;
        },
      }
    );

    assert.equal(sleptMs, 200);
    assert.equal(finalReceipt.status, "incomplete_native");
    assert.equal(finalReceipt.parentDeleted, true);
    assert.equal(finalReceipt.childrenDeleted, 1);

    const onDisk = JSON.parse(readFileSync(scheduled.receipt_path, "utf8"));
    assert.equal(onDisk.status, "incomplete_native");
    assert.equal(onDisk.parentDeleted, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("symmetric archive tools (archive_subsessions, schedule_archive_family, and cross-device archive) work end-to-end", async () => {
  const { root, db } = createSelfDeleteFixture();
  try {
    writeFileSync(join(root, "userdata", "environment-id"), "env-local\n", "utf8");

    const subPreview = await callTool(
      "archive_subsessions",
      { target_host: os.hostname(), db_path: db, thread_id: "root-1", dry_run: true },
      { db, t3Url: "http://127.0.0.1:3773" }
    );
    assert.equal(subPreview.action, "archive");
    assert.equal(subPreview.parentSelected, false);
    assert.equal(subPreview.childrenCount, 1);

    const scheduled = spawnDetachedSelfDelete(
      {
        action: "archive",
        target_host: os.hostname(),
        db_path: db,
        thread_id: "root-1",
        delay_ms: 200,
        config: { db, t3Url: "http://127.0.0.1:3773", t3Cli: "t3" },
      },
      {
        platform: "darwin",
        stateBaseDir: join(root, "state"),
        spawnFn: () => ({ pid: 61616, unref() {} }),
      }
    );
    assert.equal(scheduled.action, "archive");
    assert.match(scheduled.receipt_path, /self-archive/);

    const archiveReceipt = await runDetachedWorker(
      scheduled.job_path,
      async (args, jobConfig, jobAction) =>
        callTool(
          jobAction === "archive" ? "archive_family" : "delete_family",
          args,
          jobConfig,
          {
            dispatchFn: async ({ commands }) => {
              assert.deepEqual(
                commands.map((c) => `${c.type}:${c.threadId}`),
                [
                  "thread.stop:child-1",
                  "thread.archive:child-1",
                  "thread.stop:root-1",
                  "thread.archive:root-1",
                ]
              );
              withDatabase(db, { readOnly: false }, (conn) => {
                conn
                  .prepare(
                    "UPDATE orchestration_v2_projection_threads SET archived_at = 'now' WHERE thread_id IN ('child-1', 'root-1')"
                  )
                  .run();
              });
            },
          }
        ),
      { sleepFn: async () => {} }
    );
    assert.equal(archiveReceipt.status, "completed_via_t3");
    assert.equal(archiveReceipt.action, "archive");
    assert.equal(archiveReceipt.parentArchived, true);
    assert.equal(archiveReceipt.parentDeleted, false);
    assert.equal(archiveReceipt.childrenArchived, 1);

    // Reset archived_at on child-1 and test cross-device plan + execute_cleanup_step with action='archive'
    withDatabase(db, { readOnly: false }, (conn) => {
      conn
        .prepare("UPDATE orchestration_v2_projection_threads SET archived_at = NULL")
        .run();
    });

    const plan = await callTool("plan_cross_device_cleanup", {
      registry: {
        nodes: [
          {
            nodeId: "root",
            parentNodeId: null,
            t3: { environmentId: "env-local", threadId: "root-1" },
          },
          {
            nodeId: "c1",
            parentNodeId: "root",
            t3: { environmentId: "env-local", threadId: "child-1" },
          },
        ],
      },
      anchor_node_id: "root",
      current_environment_id: "env-local",
      current_thread_id: "root-1",
      scope: "descendants_only",
      action: "archive",
    });
    assert.equal(plan.action, "archive");

    const stepRes = await callTool(
      "execute_cleanup_step",
      {
        plan,
        node_id: "c1",
        receipts: [],
        worker_thread_id: "worker-1",
        dry_run: false,
      },
      { db, t3Url: "http://127.0.0.1:3773" },
      {
        dispatchFn: async ({ commands }) => {
          assert.deepEqual(
            commands.map((c) => `${c.type}:${c.threadId}`),
            ["thread.stop:child-1", "thread.archive:child-1"]
          );
          withDatabase(db, { readOnly: false }, (conn) => {
            conn
              .prepare(
                "UPDATE orchestration_v2_projection_threads SET archived_at = 'now' WHERE thread_id = 'child-1'"
              )
              .run();
          });
        },
      }
    );
    assert.equal(stepRes.status, "archived");
    assert.equal(stepRes.action, "archive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const tool of ["delete_family", "delete_subsessions", "delete_orphans", "archive_family"]) {
  test(`${tool} removes exclusive deleted scratch directories while archive and retained parents preserve theirs`, async () => {
    const { root, db } = createSelfDeleteFixture();
    try {
      withDatabase(db, { readOnly: false }, (conn) => {
        for (const id of ["root-1", "child-1"]) {
          const dir = join(root, "scratch", id);
          mkdirSync(join(dir, ".agents", "skills"), { recursive: true });
          conn
            .prepare(
              "UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.worktreePath', ?) WHERE thread_id = ?"
            )
            .run(dir, id);
        }
        if (tool === "delete_orphans") {
          conn.exec(
            "UPDATE orchestration_v2_projection_threads SET deleted_at='before' WHERE thread_id='root-1'"
          );
        }
      });
      await callTool(
        tool,
        {
          target_host: os.hostname(),
          db_path: db,
          ...(tool.endsWith("family")
            ? { thread_id: "root-1" }
            : tool.endsWith("subsessions")
              ? { thread_id: "root-1" }
              : {}),
          dry_run: false,
        },
        { db, t3Url: "http://localhost:3773" },
        {
          dispatchFn: async ({ commands }) =>
            withDatabase(db, { readOnly: false }, (conn) => {
              for (const cmd of commands) {
                const col =
                  cmd.type === "thread.delete"
                    ? "deleted_at"
                    : cmd.type === "thread.archive"
                      ? "archived_at"
                      : null;
                if (col) {
                  conn
                    .prepare(
                      `UPDATE orchestration_v2_projection_threads SET ${col}='now' WHERE thread_id=?`
                    )
                    .run(cmd.threadId);
                }
              }
            }),
        }
      );
      if (tool === "archive_family") {
        assert.equal(existsSync(join(root, "scratch", "child-1")), true);
        assert.equal(existsSync(join(root, "scratch", "root-1")), true);
      } else if (tool === "delete_subsessions" || tool === "delete_orphans") {
        assert.equal(existsSync(join(root, "scratch", "child-1")), false);
        // In delete_subsessions root-1 is alive; in delete_orphans root-1 was not in ids
        assert.equal(existsSync(join(root, "scratch", "root-1")), true);
      } else {
        // delete_family (default keep_parent=false) removes both!
        assert.equal(existsSync(join(root, "scratch", "child-1")), false);
        assert.equal(existsSync(join(root, "scratch", "root-1")), false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("delete_orphans with clean_deleted_parent_residuals=true purges scratch of right-click-deleted parent even with 0 live local orphans", async () => {
  const { root, db } = createSelfDeleteFixture();
  try {
    withDatabase(db, { readOnly: false }, (conn) => {
      conn.exec(`
        ALTER TABLE orchestration_v2_projection_subagents ADD COLUMN payload_json TEXT;
        CREATE TABLE orchestration_v2_projection_provider_threads(
          thread_id TEXT,
          payload_json TEXT
        );
        DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'child-1';
      `);
      const rootScratch = join(root, "scratch", "root-1");
      mkdirSync(join(rootScratch, ".agents"), { recursive: true });
      conn
        .prepare(
          "UPDATE orchestration_v2_projection_threads SET deleted_at='before', payload_json = json_set(payload_json, '$.worktreePath', ?) WHERE thread_id = 'root-1'"
        )
        .run(rootScratch);
      conn
        .prepare("INSERT INTO orchestration_v2_projection_subagents (thread_id, child_thread_id, payload_json) VALUES (?, NULL, ?)")
        .run("root-1", JSON.stringify({ remoteChild: { environmentId: "env-win", threadId: "win-c1" } }));
    });

    const res = await callTool(
      "delete_orphans",
      {
        target_host: os.hostname(),
        db_path: db,
        clean_deleted_parent_residuals: true,
        dry_run: false,
      },
      { db, t3Url: "http://localhost:3773" },
      { dispatchFn: async () => {} }
    );
    assert.equal(res.status, "completed");
    assert.equal(res.count, 0);
    assert.equal(existsSync(join(root, "scratch", "root-1")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDetachedWorker waits for orchestration_v2_projection_threads running status and post_settle_delay_ms", async () => {
  const { root, db } = createSelfDeleteFixture();
  try {
    withDatabase(db, { readOnly: false }, (conn) => {
      conn.exec("DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'child-1';");
      conn
        .prepare("UPDATE orchestration_v2_projection_threads SET payload_json = ? WHERE thread_id = 'root-1'")
        .run(JSON.stringify({ status: "running", lineage: { parentThreadId: null } }));
    });

    const jobPath = join(root, "job-settle.json");
    const receiptPath = join(root, "receipt-settle.json");
    writeFileSync(
      jobPath,
      JSON.stringify({
        action: "delete",
        target_host: os.hostname(),
        db_path: db,
        thread_id: "root-1",
        delay_ms: 100,
        post_settle_delay_ms: 4500,
        receipt_path: receiptPath,
        config: { db, t3Url: "http://127.0.0.1:3773" },
      }),
      "utf8"
    );

    const sleeps = [];
    const receipt = await runDetachedWorker(
      jobPath,
      async () => ({ status: "completed", native: { complete: true } }),
      {
        sleepFn: async (ms) => {
          sleeps.push(ms);
          if (ms === 300) {
            withDatabase(db, { readOnly: false }, (conn) => {
              conn
                .prepare("UPDATE orchestration_v2_projection_threads SET payload_json = ? WHERE thread_id = 'root-1'")
                .run(JSON.stringify({ status: "ready", lineage: { parentThreadId: null } }));
            });
          }
        },
      }
    );

    assert.equal(receipt.status, "completed");
    assert.deepEqual(sleeps, [100, 300, 4500]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("v1.9.4 schedule_delete_family accepts workerSelfCleanup in remote_receipts so coordinator can self-delete after dispatching remote cleanup_worker", async () => {
  const { root, db } = createSelfDeleteFixture();
  try {
    writeFileSync(join(root, "userdata", "environment-id"), "env-mac\n", "utf8");
    withDatabase(db, { readOnly: false }, (conn) => {
      conn.exec("ALTER TABLE orchestration_v2_projection_subagents ADD COLUMN payload_json TEXT;");
      conn.exec("DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'child-1';");
      // Coordinator root-1 spawned a remote cleanup_worker 'worker-win-1' on 'env-win'
      conn
        .prepare("INSERT INTO orchestration_v2_projection_subagents (thread_id, child_thread_id, payload_json) VALUES (?, NULL, ?)")
        .run(
          "root-1",
          JSON.stringify({ remoteChild: { environmentId: "env-win", threadId: "worker-win-1" } })
        );
    });

    // Without receipts -> blocked_by_remote_descendants
    const blocked = await callTool(
      "schedule_delete_family",
      {
        target_host: os.hostname(),
        db_path: db,
        thread_id: "root-1",
        remote_receipts: [],
        dry_run: false,
      },
      { db, t3Url: "http://127.0.0.1:3773" },
      { spawnSelfDeleteFn: () => ({ pid: 12345, receipt_path: "/tmp/r.json" }) }
    );
    assert.equal(blocked.status, "blocked_by_remote_descendants");

    // With step receipt from worker-win-1 cleaning orphan-win-99 (containing workerSelfCleanup for worker-win-1) -> scheduled_detached_delete!
    const scheduled = await callTool(
      "schedule_delete_family",
      {
        target_host: os.hostname(),
        db_path: db,
        thread_id: "root-1",
        remote_receipts: [
          {
            environment_id: "env-win",
            thread_id: "orphan-win-99",
            status: "deleted",
            workerSelfCleanup: {
              status: "scheduled",
              action: "delete",
              thread_id: "worker-win-1",
            },
          },
        ],
        dry_run: false,
      },
      { db, t3Url: "http://127.0.0.1:3773" },
      { spawnSelfDeleteFn: () => ({ pid: 12345, receipt_path: "/tmp/r.json" }) }
    );
    assert.equal(scheduled.status, "scheduled_detached_delete");
    assert.equal(scheduled.pid, 12345);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("v1.9.4 runDetachedWorker waits on orchestration_v2_projection_runs active run and ignores not_loaded provider_threads", async () => {
  const { root, db } = createSelfDeleteFixture();
  try {
    withDatabase(db, { readOnly: false }, (conn) => {
      conn.exec(`
        DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'child-1';
        CREATE TABLE orchestration_v2_projection_runs(
          run_id TEXT PRIMARY KEY,
          thread_id TEXT,
          status TEXT,
          completed_at TEXT
        );
        CREATE TABLE orchestration_v2_projection_provider_threads(
          thread_id TEXT,
          payload_json TEXT
        );
      `);
      conn
        .prepare("INSERT INTO orchestration_v2_projection_runs VALUES ('run-1', 'root-1', 'running', NULL)")
        .run();
      conn
        .prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES ('root-1', ?)")
        .run(JSON.stringify({ status: "not_loaded" }));
    });

    const jobPath = join(root, "job-runs.json");
    const receiptPath = join(root, "receipt-runs.json");
    writeFileSync(
      jobPath,
      JSON.stringify({
        action: "delete",
        target_host: os.hostname(),
        db_path: db,
        thread_id: "root-1",
        delay_ms: 50,
        receipt_path: receiptPath,
        config: { db, t3Url: "http://127.0.0.1:3773" },
      }),
      "utf8"
    );

    const sleeps = [];
    const receipt = await runDetachedWorker(
      jobPath,
      async () => ({ status: "completed", native: { complete: true } }),
      {
        sleepFn: async (ms) => {
          sleeps.push(ms);
          if (ms === 300) {
            withDatabase(db, { readOnly: false }, (conn) => {
              conn.exec(
                "UPDATE orchestration_v2_projection_runs SET status = 'completed', completed_at = 'now' WHERE run_id = 'run-1'"
              );
            });
          }
        },
      }
    );

    assert.equal(receipt.status, "completed");
    // Polled exactly once (300ms) for run-1 to finish, and did NOT loop 80 times on provider_threads 'not_loaded'!
    assert.deepEqual(sleeps, [50, 300]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
