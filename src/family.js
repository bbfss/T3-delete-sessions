import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findDescendantTree } from "./cleaner.js";
import { withDatabase } from "./sqlite.js";
import { dispatchT3Commands } from "./ws-rpc.js";

export function planCleanup(
  registry,
  anchorNodeId,
  currentEnvironmentId,
  currentThreadId,
  scope = "descendants_only"
) {
  if (scope !== "descendants_only" && scope !== "preserve_current_subtree") {
    throw new Error("Unknown cleanup scope");
  }
  const rawNodes = registry?.nodes;
  if (!Array.isArray(rawNodes)) {
    throw new Error("Registry nodes array is required");
  }

  const nodes = new Map();
  for (const n of rawNodes) {
    nodes.set(n.nodeId, n);
  }
  if (nodes.size !== rawNodes.length) {
    throw new Error("Duplicate registry node IDs");
  }
  if (!nodes.has(anchorNodeId)) {
    throw new Error("Anchor is absent from the registry");
  }

  const anchor = nodes.get(anchorNodeId);
  const anchorT3 = anchor?.t3;
  if (
    !anchorT3 ||
    anchorT3.environmentId !== currentEnvironmentId ||
    anchorT3.threadId !== currentThreadId
  ) {
    throw new Error("Anchor must match the invoking environment and thread");
  }

  const children = new Map();
  for (const key of nodes.keys()) {
    children.set(key, []);
  }
  for (const [key, n] of nodes.entries()) {
    if (n.parentNodeId != null && children.has(n.parentNodeId)) {
      children.get(n.parentNodeId).push(key);
    }
  }

  function postorder(rootKey) {
    const visiting = new Set();
    const visited = new Set();
    const ordered = [];
    function walk(key) {
      if (visiting.has(key)) {
        throw new Error("Cycle in session registry");
      }
      if (visited.has(key)) {
        return;
      }
      visiting.add(key);
      for (const childKey of children.get(key)) {
        walk(childKey);
      }
      visiting.delete(key);
      visited.add(key);
      ordered.push(key);
    }
    walk(rootKey);
    return ordered;
  }

  let root = anchorNodeId;
  const ancestors = new Set();
  if (scope === "preserve_current_subtree") {
    while (nodes.get(root).parentNodeId != null) {
      const parent = nodes.get(root).parentNodeId;
      if (!nodes.has(parent)) {
        throw new Error(`Unresolved ancestor ${parent}`);
      }
      if (ancestors.has(parent) || parent === anchorNodeId) {
        throw new Error("Cycle in session registry");
      }
      ancestors.add(parent);
      root = parent;
    }
  }

  const protectedIds =
    scope === "preserve_current_subtree"
      ? new Set(postorder(anchorNodeId))
      : new Set([anchorNodeId]);

  const protectedList = [];
  const protectedEndpoints = new Set();
  for (const key of [...protectedIds].sort()) {
    const endpoint = nodes.get(key).t3 || {};
    if (!endpoint.environmentId || !endpoint.threadId) {
      throw new Error(`Unresolved protected endpoint for node ${key}`);
    }
    protectedList.push({
      environment_id: endpoint.environmentId,
      thread_id: endpoint.threadId,
    });
    protectedEndpoints.add(`${endpoint.environmentId}\0${endpoint.threadId}`);
  }

  const ordered = postorder(root).filter((key) => !protectedIds.has(key));
  const selected = new Set(ordered);
  const steps = [];
  const endpoints = new Set();

  for (const key of ordered) {
    const endpoint = nodes.get(key).t3 || {};
    const env = endpoint.environmentId;
    const tid = endpoint.threadId;
    if (!env || !tid) {
      throw new Error(`Unresolved environment/thread for node ${key}`);
    }
    const pairKey = `${env}\0${tid}`;
    if (protectedEndpoints.has(pairKey)) {
      throw new Error("A target aliases a protected thread");
    }
    if (endpoints.has(pairKey)) {
      throw new Error("Multiple registry nodes alias the same endpoint");
    }
    endpoints.add(pairKey);

    const step = {
      node_id: key,
      environment_id: env,
      thread_id: tid,
      phase: env === currentEnvironmentId ? "local" : "remote",
      depends_on: children.get(key).filter((c) => selected.has(c)),
    };
    if (ancestors.has(key)) {
      step.ancestor = true;
    }
    steps.push(step);
  }

  const byId = new Map(steps.map((s) => [s.node_id, s]));
  for (const step of steps) {
    if (
      step.phase === "remote" &&
      step.depends_on.some((c) => byId.get(c).phase === "local")
    ) {
      throw new Error(
        `Remote-first order conflicts with a remote node delegating back locally: ${step.node_id}`
      );
    }
  }

  steps.sort((a, b) => Number(a.phase === "local") - Number(b.phase === "local"));

  return {
    scope,
    order: "remote_then_local",
    anchor_node_id: anchorNodeId,
    family_root_node_id: root,
    protected: protectedList,
    steps,
  };
}

export async function executeStep(
  plan,
  nodeId,
  receipts,
  config,
  workerThreadId,
  dryRun = true,
  { dispatchFn = dispatchT3Commands } = {}
) {
  if (
    !plan ||
    (plan.scope !== "descendants_only" && plan.scope !== "preserve_current_subtree") ||
    plan.order !== "remote_then_local"
  ) {
    throw new Error("Expected a supported remote-first plan");
  }

  const steps = new Map(plan.steps.map((s) => [s.node_id, s]));
  const step = steps.get(nodeId);
  if (!step) {
    throw new Error(`Unknown plan node_id: ${nodeId}`);
  }

  const dbPath = String(config.db);
  const env = readFileSync(join(dirname(dbPath), "environment-id"), "utf8").trim();
  if (step.environment_id !== env) {
    throw new Error("Step belongs to another T3 environment");
  }

  const protectedPairs = new Set(
    plan.protected.map((p) => `${p.environment_id}\0${p.thread_id}`)
  );
  protectedPairs.add(`${env}\0${workerThreadId}`);
  if (protectedPairs.has(`${env}\0${step.thread_id}`)) {
    throw new Error("Cannot stop or delete the current/coordinator thread");
  }

  function confirmed(key) {
    const expected = steps.get(key);
    return receipts.some(
      (r) =>
        r?.node_id === key &&
        r?.environment_id === expected.environment_id &&
        r?.thread_id === expected.thread_id &&
        (r?.status === "deleted" || r?.status === "already_deleted")
    );
  }

  const required = [...step.depends_on];
  if (step.phase === "local") {
    for (const s of steps.values()) {
      if (s.phase === "remote") {
        required.push(s.node_id);
      }
    }
  }
  const missing = [...new Set(required.filter((key) => !confirmed(key)))].sort();
  if (missing.length > 0) {
    return { ...step, status: "blocked", pending: missing };
  }

  const t3Url = config.t3Url ?? config.t3_url;
  const t3Cli = config.t3Cli ?? config.t3_cli ?? "t3";
  if (!t3Url) {
    throw new Error("Cross-device cleanup requires official online T3 commands");
  }

  const tid = step.thread_id;
  const precheck = withDatabase(dbPath, { readOnly: true }, (db) => {
    const row = db
      .prepare(
        "SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ?"
      )
      .get(tid);
    if (!row) {
      return {
        ...step,
        status: "unverified",
        reason: "Thread not found in this environment",
      };
    }
    if (row.deleted_at) {
      return { ...step, status: "already_deleted" };
    }
    const descendants = findDescendantTree(db, tid);
    for (const d of descendants) {
      const lineage = JSON.parse(d.payload_json).lineage || {};
      if (
        protectedPairs.has(`${env}\0${d.thread_id}`) &&
        lineage.sideChat === true &&
        lineage.parentThreadId === tid
      ) {
        return {
          ...step,
          status: "blocked",
          reason:
            "T3 would cascade-delete a protected side chat; a supported detach operation is required",
        };
      }
    }
    const remaining = descendants.filter(
      (d) => !protectedPairs.has(`${env}\0${d.thread_id}`)
    );
    if (remaining.length > 0) {
      return {
        ...step,
        status: "blocked",
        reason: "Live local descendants remain; refresh the plan",
        remaining: remaining.map((d) => d.thread_id),
      };
    }
    return null;
  });

  if (precheck) {
    return precheck;
  }
  if (dryRun) {
    return { ...step, status: "ready" };
  }

  const commands = [{ type: "thread.delete", threadId: tid }];
  if (!step.ancestor) {
    commands.unshift({
      type: "thread.stop",
      threadId: tid,
      stopDelegatedTasks: false,
    });
  }

  try {
    await dispatchFn({
      cli: t3Cli,
      baseDir: dirname(dirname(dbPath)),
      url: t3Url,
      commands,
    });
  } catch (err) {
    return {
      ...step,
      status: "failed",
      reason: String(err?.message || err).slice(-1500),
    };
  }

  return withDatabase(dbPath, { readOnly: true }, (db) => {
    const row = db
      .prepare(
        "SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ?"
      )
      .get(tid);
    for (const item of plan.protected) {
      if (item.environment_id !== env) {
        continue;
      }
      const kept = db
        .prepare(
          "SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ?"
        )
        .get(item.thread_id);
      if (!kept || kept.deleted_at != null) {
        return {
          ...step,
          status: "failed",
          reason: "Protected thread preservation could not be verified",
          protected_thread_id: item.thread_id,
        };
      }
    }
    return {
      ...step,
      status: row && row.deleted_at ? "deleted" : "unverified",
    };
  });
}
