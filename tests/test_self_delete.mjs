import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDetachedWorker, spawnDetachedSelfDelete } from "../src/self-delete.js";
import { callTool, parseCliArgs } from "../src/server.js";
import { normalizeDbPath, withDatabase } from "../src/sqlite.js";

function createSelfDeleteFixture() {
  const root = mkdtempSync(join(os.tmpdir(), "t3-self-del-"));
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
    assert.equal(finalReceipt.status, "completed_via_t3");
    assert.equal(finalReceipt.parentDeleted, true);
    assert.equal(finalReceipt.childrenDeleted, 1);

    const onDisk = JSON.parse(readFileSync(scheduled.receipt_path, "utf8"));
    assert.equal(onDisk.status, "completed_via_t3");
    assert.equal(onDisk.parentDeleted, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
