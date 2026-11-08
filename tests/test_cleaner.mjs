import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callTool, SERVER_VERSION } from "../src/server.js";
import { normalizeDbPath, withDatabase } from "../src/sqlite.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliJs = join(__dirname, "..", "bin", "cli.js");

function createFixture() {
  const root = mkdtempSync(join(os.tmpdir(), "t3-cleaner-test-"));
  const db = normalizeDbPath(join(root, "test.sqlite"));
  const artifact = join(root, "scratch", "important.txt");
  mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, "keep", "utf8");

  const config = { db, allowOfflineWrites: true };
  const args = { target_host: os.hostname(), db_path: db };

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
      CREATE TABLE orchestration_events(
        event_id TEXT,
        aggregate_kind TEXT,
        stream_id TEXT,
        stream_version INTEGER,
        event_type TEXT,
        occurred_at TEXT,
        command_id TEXT,
        actor_kind TEXT,
        payload_json TEXT,
        metadata_json TEXT,
        application_event_version INTEGER
      );
    `);
    const ins = conn.prepare(
      "INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, 'codex', 'now', 'now', NULL, NULL, ?)"
    );
    for (const [tid, parent] of [
      ["parent", null],
      ["child", "parent"],
      ["grandchild", "child"],
      ["unrelated", null],
    ]) {
      const payload = { worktreePath: dirname(artifact) };
      if (parent) {
        payload.lineage = { parentThreadId: parent };
      }
      ins.run(tid, tid, JSON.stringify(payload));
    }
  });

  const deleted = () =>
    withDatabase(db, { readOnly: true }, (conn) =>
      conn
        .prepare(
          "SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL ORDER BY thread_id"
        )
        .all()
        .map((r) => r.thread_id)
    );

  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, db, artifact, config, args, deleted, cleanup };
}

test("default preview preserves everything", async (t) => {
  const f = createFixture();
  t.after(f.cleanup);

  const result = await callTool(
    "delete_family",
    { ...f.args, thread_id: "parent" },
    f.config
  );
  assert.equal(result.status, "preview");
  assert.equal(result.parentDeleted, false);
  assert.deepEqual(
    result.children.map((x) => x.threadId),
    ["grandchild", "child"]
  );
  assert.deepEqual(f.deleted(), []);
});

test("missing id never selects recent session", async (t) => {
  const f = createFixture();
  t.after(f.cleanup);

  await assert.rejects(() => callTool("delete_family", f.args, f.config), /Explicit thread_id/);
  assert.deepEqual(f.deleted(), []);
});

test("wrong machine or database is rejected", async (t) => {
  const f = createFixture();
  t.after(f.cleanup);

  for (const bad of [
    { ...f.args, target_host: "other-machine" },
    { ...f.args, db_path: join(f.root, "other.sqlite") },
  ]) {
    await assert.rejects(
      () =>
        callTool(
          "delete_orphans",
          { ...bad, dry_run: false, offline_confirmed: true },
          f.config
        ),
      /Target mismatch/
    );
  }
  assert.deepEqual(f.deleted(), []);
});

test("write requires both offline gates", async (t) => {
  const f = createFixture();
  t.after(f.cleanup);

  for (const [enabled, confirmed] of [
    [false, true],
    [true, false],
  ]) {
    f.config.allowOfflineWrites = enabled;
    await assert.rejects(
      () =>
        callTool(
          "delete_family",
          {
            ...f.args,
            thread_id: "parent",
            dry_run: false,
            offline_confirmed: confirmed,
          },
          f.config
        ),
      /Writes require --allow-offline-writes/
    );
  }
  assert.deepEqual(f.deleted(), []);
});

test("descendants only and files preserved", async (t) => {
  const f = createFixture();
  t.after(f.cleanup);

  const result = await callTool(
    "delete_subsessions",
    { ...f.args, thread_id: "parent", dry_run: false, offline_confirmed: true },
    f.config
  );
  assert.equal(result.parentDeleted, false);
  assert.deepEqual(f.deleted(), ["child", "grandchild"]);
  assert.equal(readFileSync(f.artifact, "utf8"), "keep");
});

test("orphan cleanup includes grandchildren", async (t) => {
  const f = createFixture();
  t.after(f.cleanup);

  withDatabase(f.db, { readOnly: false }, (conn) => {
    conn.exec(
      "UPDATE orchestration_v2_projection_threads SET deleted_at='before' WHERE thread_id='parent'"
    );
  });
  const result = await callTool(
    "delete_orphans",
    { ...f.args, dry_run: false, offline_confirmed: true },
    f.config
  );
  assert.equal(result.count, 2);
  assert.deepEqual(f.deleted(), ["child", "grandchild", "parent"]);
});

test("archive preserves files and deleted state", async (t) => {
  const f = createFixture();
  t.after(f.cleanup);

  withDatabase(f.db, { readOnly: false }, (conn) => {
    conn.exec(
      "UPDATE orchestration_v2_projection_threads SET deleted_at='before' WHERE thread_id='parent'"
    );
  });
  await callTool(
    "delete_orphans",
    {
      ...f.args,
      dry_run: false,
      offline_confirmed: true,
      archive_only: true,
    },
    f.config
  );
  assert.deepEqual(f.deleted(), ["parent"]);
  assert.equal(readFileSync(f.artifact, "utf8"), "keep");
  const archivedCount = withDatabase(f.db, { readOnly: true }, (conn) =>
    Number(
      conn
        .prepare(
          "SELECT count(*) AS c FROM orchestration_v2_projection_threads WHERE archived_at IS NOT NULL"
        )
        .get().c
    )
  );
  assert.equal(archivedCount, 2);
});

test("failed event insert rolls back projection", async (t) => {
  const f = createFixture();
  t.after(f.cleanup);

  withDatabase(f.db, { readOnly: false }, (conn) => {
    conn.exec("DROP TABLE orchestration_events");
  });
  await assert.rejects(() =>
    callTool(
      "delete_subsessions",
      { ...f.args, thread_id: "parent", dry_run: false, offline_confirmed: true },
      f.config
    )
  );
  assert.deepEqual(f.deleted(), []);
});

test("non-boolean dry_run rejected", async (t) => {
  const f = createFixture();
  t.after(f.cleanup);

  await assert.rejects(
    () =>
      callTool(
        "delete_family",
        { ...f.args, thread_id: "parent", dry_run: "false" },
        f.config
      ),
    /dry_run must be a boolean/
  );
});

test("CLI runs with empty PATH (zero Python dependency) and clean UTF-8 stdio", (t) => {
  const f = createFixture();
  t.after(f.cleanup);

  withDatabase(f.db, { readOnly: false }, (conn) => {
    conn.exec(
      "UPDATE orchestration_v2_projection_threads SET title='中文子会话' WHERE thread_id='child'"
    );
  });

  const initReq = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
  const unconfiguredCall = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "delete_family",
      arguments: { ...f.args, thread_id: "parent", dry_run: false },
    },
  };
  const unconfProc = spawnSync(process.execPath, [cliJs], {
    input: `${JSON.stringify(initReq)}\n${JSON.stringify(unconfiguredCall)}\n`,
    encoding: "utf8",
    env: { PATH: "" },
  });
  assert.equal(unconfProc.status, 0);
  assert.equal(unconfProc.stderr, "");
  const unconfLines = unconfProc.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(unconfLines[0].result.serverInfo.version, SERVER_VERSION);
  assert.equal(unconfLines[1].result.isError, true);
  assert.deepEqual(f.deleted(), []);

  const previewCall = {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "delete_family",
      arguments: { ...f.args, thread_id: "parent", dry_run: true },
    },
  };
  const confProc = spawnSync(process.execPath, [cliJs, "--db", f.db], {
    input: `${JSON.stringify(previewCall)}\n`,
    encoding: "utf8",
    env: { PATH: "" },
  });
  assert.equal(confProc.status, 0);
  assert.equal(confProc.stderr, "");
  const payload = JSON.parse(JSON.parse(confProc.stdout.trim()).result.content[0].text);
  assert.deepEqual(
    payload.children.map((x) => x.title),
    ["grandchild", "中文子会话"]
  );
});
