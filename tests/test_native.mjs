import test from "node:test";
import assert from "node:assert/strict";
import {
  deleteAntigravity,
  deleteClaude,
  deleteNativeEndpoints,
  nativeEndpoints,
} from "../src/native.js";
import { withDatabase } from "../src/sqlite.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("writer failure and unknown providers prevent native completion", async () => {
  const r = await deleteNativeEndpoints(
    [
      { provider: "codex", nativeId: "a", status: "ready" },
      { provider: "futureProvider", nativeId: "b", status: "ready" },
    ],
    { codexDelete: async () => ({ status: "failed", reason: "active writer" }) }
  );
  assert.equal(r.complete, false);
  assert.deepEqual(
    r.endpoints.map((e) => e.status),
    ["failed", "unsupported"]
  );
});

test("retained native endpoint never reaches deletion", async () => {
  let calls = 0;
  const r = await deleteNativeEndpoints(
    [{ provider: "codex", nativeId: "a", status: "blocked" }],
    {
      codexDelete: async () => {
        calls += 1;
      },
    }
  );
  assert.equal(calls, 0);
  assert.equal(r.complete, false);
});

test("official native identities are deduplicated, shared live conversations protected, and unstarted threads marked no_native_session", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-cleanup-"));
  const path = join(dir, "test.sqlite");
  try {
    writeFileSync(path, "");
    withDatabase(path, { readOnly: false }, (db) => {
      db.exec(
        "CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,deleted_at TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_provider_threads(thread_id TEXT,payload_json TEXT)"
      );
      for (const id of ["target", "retained"]) {
        db.prepare(
          "INSERT INTO orchestration_v2_projection_threads VALUES (?,NULL,?)"
        ).run(id, JSON.stringify({ activeProviderThreadId: "pt-1" }));
        db.prepare(
          "INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?)"
        ).run(
          id,
          JSON.stringify({
            driver: "codex",
            providerSessionId: "shared",
            nativeThreadRef: {
              driver: "codex",
              nativeId: "real-id",
              strength: "strong",
            },
          })
        );
      }
      db.prepare(
        "INSERT INTO orchestration_v2_projection_threads VALUES (?,NULL,?)"
      ).run("empty-thread", JSON.stringify({ activeProviderThreadId: null }));
    });
    const r = nativeEndpoints(path, ["target"]);
    assert.equal(r[0].nativeId, "real-id");
    assert.equal(r[0].status, "blocked");

    const all = nativeEndpoints(path, ["target", "retained", "empty-thread"]);
    assert.equal(all.length, 2);
    assert.equal(all[0].status, "ready");
    assert.equal(all[1].status, "no_native_session");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zero-dependency Claude deletion removes jsonl, sidecar/subagents, session-env, file-history, and empty scratch project dir while preserving non-scratch project dir", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-zero-dep-"));
  try {
    const claudeDir = join(root, ".claude");
    const scratchRoot = join(root, ".t3", "scratch");
    const scratchWt = join(scratchRoot, "2026-11-09-test-scratch");
    const userWt = join(root, "Documents", "MyRepo");

    const scratchEncoded = scratchWt.replace(/[^a-zA-Z0-9]/g, "-");
    const userEncoded = userWt.replace(/[^a-zA-Z0-9]/g, "-");

    const uuid1 = "11111111-2222-3333-4444-555555555555";
    const uuid2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    // Scratch project with 1 Claude session + sidecar subagents + memory
    const scratchProj = join(claudeDir, "projects", scratchEncoded);
    mkdirSync(join(scratchProj, uuid1, "subagents"), { recursive: true });
    mkdirSync(join(scratchProj, "memory"), { recursive: true });
    writeFileSync(join(scratchProj, `${uuid1}.jsonl`), "{}\n");
    writeFileSync(join(scratchProj, uuid1, "subagents", "sub1.jsonl"), "{}\n");
    mkdirSync(join(claudeDir, "session-env", uuid1), { recursive: true });
    mkdirSync(join(claudeDir, "file-history", uuid1), { recursive: true });

    // Non-scratch user project with 1 Claude session + memory
    const userProj = join(claudeDir, "projects", userEncoded);
    mkdirSync(join(userProj, "memory"), { recursive: true });
    writeFileSync(join(userProj, `${uuid2}.jsonl`), "{}\n");
    writeFileSync(join(userProj, "memory", "MEMORY.md"), "keep");

    const env = { CLAUDE_CONFIG_DIR: claudeDir };
    const res1 = await deleteClaude(uuid1, {
      env,
      homedir: root,
      scratchRoot,
      worktreePath: scratchWt,
    });
    assert.equal(res1.status, "deleted");
    assert.equal(existsSync(join(scratchProj, `${uuid1}.jsonl`)), false);
    assert.equal(existsSync(scratchProj), false); // Empty scratch project folder pruned!
    assert.equal(existsSync(join(claudeDir, "session-env", uuid1)), false);
    assert.equal(existsSync(join(claudeDir, "file-history", uuid1)), false);

    const res1Again = await deleteClaude(uuid1, { env, homedir: root });
    assert.equal(res1Again.status, "already_deleted");

    const res2 = await deleteClaude(uuid2, {
      env,
      homedir: root,
      scratchRoot,
      worktreePath: userWt,
    });
    assert.equal(res2.status, "deleted");
    assert.equal(existsSync(join(userProj, `${uuid2}.jsonl`)), false);
    assert.equal(existsSync(join(userProj, "memory", "MEMORY.md")), true); // Non-scratch project preserved!
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Antigravity deletion removes conversation db/wal/meta, brain dir, and recursively discovered subagent brains", async () => {
  const root = mkdtempSync(join(tmpdir(), "agy-native-"));
  try {
    const dbPath = join(root, "userdata", "statev2.sqlite");
    const acp = join(
      root,
      "userdata",
      "providers",
      "antigravity",
      "hash123",
      "antigravity-acp"
    );
    const parentId = "5021e591-ca5e-498e-8f30-fa4605445601";
    const subId = "a7c22a5ad1d886098bf9d842308fd77b";
    const unrelatedId = "99999999-ca5e-498e-8f30-fa4605445601";

    mkdirSync(join(acp, "conversations"), { recursive: true });
    for (const ext of [".db", ".db-wal", ".db-shm", ".meta"]) {
      writeFileSync(join(acp, "conversations", `${parentId}${ext}`), "x");
      writeFileSync(join(acp, "conversations", `${unrelatedId}${ext}`), "y");
    }
    mkdirSync(join(acp, "brain", parentId, ".system_generated", "logs"), {
      recursive: true,
    });
    writeFileSync(
      join(acp, "brain", parentId, ".system_generated", "logs", "transcript.jsonl"),
      JSON.stringify({
        type: "INVOKE_SUBAGENT",
        content: `Created subagent: {"conversationId": "${subId}"}`,
      }) + "\n"
    );
    mkdirSync(join(acp, "brain", subId, ".system_generated", "logs"), {
      recursive: true,
    });
    mkdirSync(join(acp, "brain", unrelatedId), { recursive: true });

    const del = await deleteAntigravity(parentId, { dbPath, homedir: root });
    assert.equal(del.status, "deleted");
    assert.equal(existsSync(join(acp, "conversations", `${parentId}.db`)), false);
    assert.equal(existsSync(join(acp, "conversations", `${parentId}.meta`)), false);
    assert.equal(existsSync(join(acp, "brain", parentId)), false);
    assert.equal(existsSync(join(acp, "brain", subId)), false);

    // Unrelated Antigravity conversation is untouched
    assert.equal(existsSync(join(acp, "conversations", `${unrelatedId}.db`)), true);
    assert.equal(existsSync(join(acp, "brain", unrelatedId)), true);

    const again = await deleteAntigravity(parentId, { dbPath, homedir: root });
    assert.equal(again.status, "already_deleted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
