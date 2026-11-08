import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeStep, planCleanup } from "../src/family.js";
import { normalizeDbPath, withDatabase } from "../src/sqlite.js";

function makeRegistry() {
  return {
    nodes: [
      {
        nodeId: "root",
        parentNodeId: null,
        t3: { environmentId: "mac", threadId: "current" },
      },
      {
        nodeId: "local",
        parentNodeId: "root",
        t3: { environmentId: "mac", threadId: "local-child" },
      },
      {
        nodeId: "remote",
        parentNodeId: "local",
        t3: { environmentId: "win", threadId: "remote-child" },
      },
      {
        nodeId: "grand",
        parentNodeId: "remote",
        t3: { environmentId: "vps", threadId: "grandchild" },
      },
    ],
  };
}

function makeTempEnv(envId = "mac") {
  const dir = mkdtempSync(join(os.tmpdir(), "t3-family-test-"));
  const db = normalizeDbPath(join(dir, "statev2.sqlite"));
  writeFileSync(join(dir, "environment-id"), envId, "utf8");
  writeFileSync(db, "");
  return {
    dir,
    db,
    config: { db, t3Url: "http://127.0.0.1:3773", t3Cli: "t3" },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("remote then local postorder", () => {
  const plan = planCleanup(makeRegistry(), "root", "mac", "current");
  assert.deepEqual(
    plan.steps.map((s) => s.node_id),
    ["grand", "remote", "local"]
  );
  assert.deepEqual(plan.protected, [
    { environment_id: "mac", thread_id: "current" },
  ]);
});

test("local blocked without all remote receipts", async (t) => {
  const env = makeTempEnv();
  t.after(env.cleanup);
  const plan = planCleanup(makeRegistry(), "root", "mac", "current");
  let called = false;
  const result = await executeStep(plan, "local", [], env.config, "current", false, {
    dispatchFn: async () => {
      called = true;
    },
  });
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.pending, ["grand", "remote"]);
  assert.equal(called, false);
});

test("failed, wrong-environment, and preview receipts do not unlock local", async (t) => {
  const env = makeTempEnv();
  t.after(env.cleanup);
  const plan = planCleanup(makeRegistry(), "root", "mac", "current");

  for (const [status, targetEnv] of [
    ["failed", "vps"],
    ["ready", "vps"],
    ["deleted", "mac"],
  ]) {
    const receipts = [
      { ...plan.steps[0], status, environment_id: targetEnv },
      { ...plan.steps[1], status: "deleted" },
    ];
    const result = await executeStep(
      plan,
      "local",
      receipts,
      env.config,
      "current",
      false
    );
    assert.equal(result.status, "blocked");
  }
});

test("worker cannot delete itself", async (t) => {
  const env = makeTempEnv();
  t.after(env.cleanup);
  const plan = planCleanup(makeRegistry(), "root", "mac", "current");
  await assert.rejects(
    () => executeStep(plan, "local", [], env.config, "local-child", false),
    /current\/coordinator/
  );
});

test("wrong machine rejected", async (t) => {
  const env = makeTempEnv();
  t.after(env.cleanup);
  const plan = planCleanup(makeRegistry(), "root", "mac", "current");
  await assert.rejects(
    () => executeStep(plan, "remote", [], env.config, "current", false),
    /another T3 environment/
  );
});

test("remote delegating back locally conflicts", () => {
  const r = makeRegistry();
  r.nodes[3].t3.environmentId = "mac";
  assert.throws(() => planCleanup(r, "root", "mac", "current"), /conflicts/);
});

test("unresolved endpoint blocks plan", () => {
  const r = makeRegistry();
  r.nodes[2].t3.environmentId = null;
  assert.throws(() => planCleanup(r, "root", "mac", "current"), /Unresolved/);
});

test("protected alias rejected", () => {
  const r = makeRegistry();
  r.nodes[2].t3 = r.nodes[0].t3;
  assert.throws(() => planCleanup(r, "root", "mac", "current"), /protected/);
});

test("deleted retry is verified without commands", async (t) => {
  const env = makeTempEnv();
  t.after(env.cleanup);
  withDatabase(env.db, { readOnly: false }, (conn) => {
    conn.exec(
      "CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT, deleted_at TEXT); INSERT INTO orchestration_v2_projection_threads VALUES('local-child', 'done');"
    );
  });
  const plan = planCleanup(makeRegistry(), "root", "mac", "current");
  const receipts = plan.steps
    .filter((s) => s.phase === "remote")
    .map((s) => ({ ...s, status: "deleted" }));

  let called = false;
  const result = await executeStep(
    plan,
    "local",
    receipts,
    env.config,
    "current",
    false,
    {
      dispatchFn: async () => {
        called = true;
      },
    }
  );
  assert.equal(result.status, "already_deleted");
  assert.equal(called, false);
});

function makeSubtreeRegistry() {
  const edges = [
    ["grand", null],
    ["parent", "grand"],
    ["current", "parent"],
    ["kept", "current"],
    ["sibling", "parent"],
    ["sibling-child", "sibling"],
    ["uncle", "grand"],
    ["other", null],
  ];
  return {
    nodes: edges.map(([n, p]) => ({
      nodeId: n,
      parentNodeId: p,
      t3: { environmentId: "mac", threadId: n },
    })),
  };
}

test("preserve_current_subtree removes all ancestors and other branches", () => {
  const plan = planCleanup(
    makeSubtreeRegistry(),
    "current",
    "mac",
    "current",
    "preserve_current_subtree"
  );
  assert.deepEqual(
    new Set(plan.steps.map((s) => s.node_id)),
    new Set(["grand", "parent", "sibling", "sibling-child", "uncle"])
  );
  assert.deepEqual(
    new Set(plan.protected.map((s) => s.thread_id)),
    new Set(["current", "kept"])
  );
  assert.equal(plan.steps.at(-1).node_id, "grand");
  assert.deepEqual(
    new Set(plan.steps.filter((s) => s.ancestor).map((s) => s.node_id)),
    new Set(["grand", "parent"])
  );
});

test("current root means nothing to delete", () => {
  const plan = planCleanup(
    makeSubtreeRegistry(),
    "grand",
    "mac",
    "grand",
    "preserve_current_subtree"
  );
  assert.deepEqual(plan.steps, []);
});

test("unknown ancestor is not an implied root", () => {
  const r = makeSubtreeRegistry();
  r.nodes[0].parentNodeId = "missing";
  assert.throws(
    () => planCleanup(r, "current", "mac", "current", "preserve_current_subtree"),
    /Unresolved ancestor/
  );
});

test("preserved remote descendants do not enter delete barrier", () => {
  const r = makeSubtreeRegistry();
  r.nodes[3].t3.environmentId = "win";
  const plan = planCleanup(
    r,
    "current",
    "mac",
    "current",
    "preserve_current_subtree"
  );
  assert.ok(plan.steps.every((s) => s.phase === "local"));
  assert.ok(
    plan.protected.some(
      (p) => p.environment_id === "win" && p.thread_id === "kept"
    )
  );
});

test("side chat cascade is blocked", async (t) => {
  const env = makeTempEnv();
  t.after(env.cleanup);

  const r = {
    nodes: [
      {
        nodeId: "parent",
        parentNodeId: null,
        t3: { environmentId: "mac", threadId: "parent" },
      },
      {
        nodeId: "current",
        parentNodeId: "parent",
        t3: { environmentId: "mac", threadId: "current" },
      },
    ],
  };
  const plan = planCleanup(
    r,
    "current",
    "mac",
    "current",
    "preserve_current_subtree"
  );

  withDatabase(env.db, { readOnly: false }, (conn) => {
    conn.exec(`
      CREATE TABLE orchestration_v2_projection_threads(
        thread_id TEXT,
        title TEXT,
        default_provider TEXT,
        created_at TEXT,
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
      "INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, 'codex', 'now', NULL, NULL, ?)"
    );
    ins.run("parent", "parent", JSON.stringify({}));
    ins.run(
      "current",
      "current",
      JSON.stringify({ lineage: { parentThreadId: "parent", sideChat: true } })
    );
  });

  let called = false;
  const result = await executeStep(plan, "parent", [], env.config, "current", false, {
    dispatchFn: async () => {
      called = true;
    },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /side chat/);
  assert.equal(called, false);
});
