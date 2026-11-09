import { existsSync, rmSync, lstatSync, readFileSync } from "node:fs";
import { dirname, resolve, sep, join } from "node:path";
import { randomUUID } from "node:crypto";
import { withDatabase, withTransaction } from "./sqlite.js";

export function readLocalEnvironmentId(dbPath) {
  if (!dbPath) return null;
  const identityFile = join(dirname(resolve(dbPath)), "environment-id");
  if (!existsSync(identityFile)) return null;
  try {
    return readFileSync(identityFile, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function findDescendantTree(
  db,
  rootThreadId,
  { localEnvironmentId = null } = {}
) {
  const stmt = db.prepare(`
    SELECT thread_id, title, default_provider, created_at, archived_at, deleted_at, payload_json
    FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL
      AND (
        json_extract(payload_json, '$.lineage.parentThreadId') = ?
        OR (
          json_extract(payload_json, '$.delegatedFrom.threadId') = ?
          AND (
            json_extract(payload_json, '$.delegatedFrom.environmentId') IS NULL
            OR (? IS NOT NULL AND json_extract(payload_json, '$.delegatedFrom.environmentId') = ?)
          )
        )
        OR thread_id IN (
            SELECT child_thread_id FROM orchestration_v2_projection_subagents
            WHERE thread_id = ? AND child_thread_id IS NOT NULL
        )
      )
  `);

  const visited = new Set();
  const treeNodes = [];

  function traverse(parentId, depth) {
    const children = stmt.all(
      parentId,
      parentId,
      localEnvironmentId,
      localEnvironmentId,
      parentId
    );
    for (const child of children) {
      const cid = child.thread_id;
      if (visited.has(cid) || cid === rootThreadId) {
        continue;
      }
      visited.add(cid);
      traverse(cid, depth + 1);
      treeNodes.push({ depth, node: { ...child } });
    }
  }

  traverse(rootThreadId, 1);
  treeNodes.sort((a, b) => b.depth - a.depth);
  return treeNodes.map((entry) => entry.node);
}

export function scanOrphanSessions(db, { localEnvironmentId = null } = {}) {
  const rows = db
    .prepare(`
      WITH all_threads AS (
          SELECT
              thread_id, title, default_provider, deleted_at, archived_at, created_at,
              json_extract(payload_json, '$.lineage.parentThreadId') as parent_id,
              CASE
                WHEN json_extract(payload_json, '$.delegatedFrom.threadId') IS NOT NULL
                 AND (
                   json_extract(payload_json, '$.delegatedFrom.environmentId') IS NULL
                   OR (? IS NOT NULL AND json_extract(payload_json, '$.delegatedFrom.environmentId') = ?)
                 )
                THEN json_extract(payload_json, '$.delegatedFrom.threadId')
                ELSE NULL
              END as local_delegated_parent_id,
              json_extract(payload_json, '$.worktreePath') as worktree_path,
              payload_json
          FROM orchestration_v2_projection_threads
      )
      SELECT
          t.thread_id, t.title, t.default_provider,
          COALESCE(t.parent_id, t.local_delegated_parent_id) as parent_id,
          p.title as parent_title, p.deleted_at as parent_deleted_at,
          t.worktree_path, t.payload_json
      FROM all_threads t
      LEFT JOIN all_threads p ON p.thread_id = COALESCE(t.parent_id, t.local_delegated_parent_id)
      WHERE (t.parent_id IS NOT NULL OR t.local_delegated_parent_id IS NOT NULL)
        AND t.deleted_at IS NULL
        AND (p.thread_id IS NULL OR p.deleted_at IS NOT NULL)
      ORDER BY t.created_at DESC
    `)
    .all(localEnvironmentId, localEnvironmentId);
  return rows.map((row) => ({ ...row }));
}

export function markThreadDeleted(
  db,
  threadId,
  payloadJsonStr,
  { action = "delete", dryRun = false } = {}
) {
  const nowIso = new Date().toISOString();
  const payload = JSON.parse(payloadJsonStr);

  let col;
  let eventType;
  if (action === "delete") {
    payload.deletedAt = nowIso;
    col = "deleted_at";
    eventType = "thread.deleted";
  } else {
    payload.archivedAt = nowIso;
    col = "archived_at";
    eventType = "thread.archived";
  }

  payload.updatedAt = nowIso;
  const updatedPayloadStr = JSON.stringify(payload);

  if (dryRun) {
    return;
  }

  db.prepare(
    `UPDATE orchestration_v2_projection_threads
     SET ${col} = ?, updated_at = ?, payload_json = ?
     WHERE thread_id = ?`
  ).run(nowIso, nowIso, updatedPayloadStr, threadId);

  const verRow = db
    .prepare(
      `SELECT COALESCE(MAX(stream_version), 0) + 1 as next_ver
       FROM orchestration_events
       WHERE aggregate_kind = 'thread' AND stream_id = ?`
    )
    .get(threadId);
  const nextStreamVersion = verRow ? Number(verRow.next_ver) : 1;

  const eventId = `event:thread:${threadId}:cleaner:${randomUUID()}`;
  const commandId = `cmd:cleaner:${randomUUID()}`;
  db.prepare(
    `INSERT INTO orchestration_events (
        event_id,
        aggregate_kind,
        stream_id,
        stream_version,
        event_type,
        occurred_at,
        command_id,
        actor_kind,
        payload_json,
        metadata_json,
        application_event_version
     ) VALUES (?, 'thread', ?, ?, ?, ?, ?, 'server', ?, '{}', 2)`
  ).run(eventId, threadId, nextStreamVersion, eventType, nowIso, commandId, updatedPayloadStr);
}

export function cleanOrphans(dbPath, { dryRun = true, action = "delete" } = {}) {
  const localEnvironmentId = readLocalEnvironmentId(dbPath);
  return withDatabase(dbPath, { readOnly: dryRun }, (db) => {
    const roots = scanOrphanSessions(db, { localEnvironmentId });
    const orphans = [];
    const seen = new Set();
    for (const root of roots) {
      for (const row of [
        ...findDescendantTree(db, root.thread_id, { localEnvironmentId }),
        root,
      ]) {
        if (!seen.has(row.thread_id)) {
          seen.add(row.thread_id);
          orphans.push(row);
        }
      }
    }
    if (orphans.length === 0) {
      return { status: "clean", count: 0, orphans: [] };
    }

    const results = [];
    if (!dryRun) {
      withTransaction(db, () => {
        for (const o of orphans) {
          markThreadDeleted(db, o.thread_id, o.payload_json, { action });
          results.push({ threadId: o.thread_id, title: o.title });
        }
      });
    } else {
      for (const o of orphans) {
        results.push({ threadId: o.thread_id, title: o.title, dryRun: true });
      }
    }

    return {
      status: dryRun ? "preview" : "updated_offline_database",
      count: results.length,
      orphans: results,
    };
  });
}

export function cleanFamily(
  threadId,
  dbPath,
  { keepParent = false, dryRun = true, action = "delete" } = {}
) {
  const localEnvironmentId = readLocalEnvironmentId(dbPath);
  return withDatabase(dbPath, { readOnly: dryRun }, (db) => {
    const targetRow = db
      .prepare(
        "SELECT thread_id, title, deleted_at, archived_at, payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?"
      )
      .get(threadId);
    if (!targetRow || targetRow.deleted_at != null) {
      throw new Error(`Session ${threadId} not found in database.`);
    }

    const descendants = findDescendantTree(db, threadId, { localEnvironmentId }).filter(
      (d) => (action === "archive" ? d.archived_at == null : true)
    );
    let processedChildren = [];
    let parentProcessed = false;

    if (!dryRun) {
      withTransaction(db, () => {
        for (const d of descendants) {
          markThreadDeleted(db, d.thread_id, d.payload_json, { action });
          processedChildren.push({ threadId: d.thread_id, title: d.title });
        }
        if (!keepParent && (action !== "archive" || targetRow.archived_at == null)) {
          markThreadDeleted(db, threadId, targetRow.payload_json, { action });
          parentProcessed = true;
        }
      });
    } else {
      processedChildren = descendants.map((d) => ({
        threadId: d.thread_id,
        title: d.title,
        dryRun: true,
      }));
    }

    return {
      status: dryRun ? "preview" : "updated_offline_database",
      action,
      parentThreadId: threadId,
      parentDeleted: parentProcessed && action === "delete",
      parentArchived: parentProcessed && action === "archive",
      parentSelected: !keepParent && (action !== "archive" || targetRow.archived_at == null),
      childrenCount: processedChildren.length,
      children: processedChildren,
    };
  });
}

// Remove only T3-owned exclusive scratch directories after confirmed online deletion.
export function removeDeletedScratch(dbPath, ids) {
  const root = resolve(dirname(dirname(dbPath)), "scratch");
  return withDatabase(dbPath, { readOnly: true }, (db) => {
    const rows = db
      .prepare(
        "SELECT thread_id, deleted_at, payload_json FROM orchestration_v2_projection_threads"
      )
      .all();
    const paths = rows.map((row) => ({
      ...row,
      path: JSON.parse(row.payload_json || "{}").worktreePath,
    }));
    const seenDirs = new Set();
    const results = [];
    for (const row of paths.filter(
      (row) => ids.includes(row.thread_id) && row.deleted_at
    )) {
      if (!row.path || dirname(resolve(row.path)) !== root) continue;
      const directory = resolve(row.path);
      if (seenDirs.has(directory)) continue;
      seenDirs.add(directory);

      if (
        paths.some(
          (other) =>
            !other.deleted_at &&
            other.path &&
            (resolve(other.path) === directory ||
              resolve(other.path).startsWith(directory + sep))
        )
      ) {
        results.push({ path: directory, status: "retained_shared" });
        continue;
      }
      if (existsSync(join(directory, ".git"))) {
        results.push({ path: directory, status: "retained_git" });
        continue;
      }
      if (existsSync(directory)) {
        if (lstatSync(directory).isSymbolicLink()) continue;
        rmSync(directory, { recursive: true, force: true });
      }
      results.push({
        path: directory,
        status: existsSync(directory) ? "failed" : "removed",
      });
    }
    return results;
  });
}
