import { randomUUID } from "node:crypto";
import { withDatabase, withTransaction } from "./sqlite.js";

export function findDescendantTree(db, rootThreadId) {
  const stmt = db.prepare(`
    SELECT thread_id, title, default_provider, created_at, archived_at, deleted_at, payload_json
    FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL
      AND (
        json_extract(payload_json, '$.lineage.parentThreadId') = ?
        OR json_extract(payload_json, '$.delegatedFrom.threadId') = ?
        OR thread_id IN (
            SELECT child_thread_id FROM orchestration_v2_projection_subagents
            WHERE thread_id = ? AND child_thread_id IS NOT NULL
        )
      )
  `);

  const visited = new Set();
  const treeNodes = [];

  function traverse(parentId, depth) {
    const children = stmt.all(parentId, parentId, parentId);
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

export function scanOrphanSessions(db) {
  const rows = db
    .prepare(`
      WITH all_threads AS (
          SELECT
              thread_id, title, default_provider, deleted_at, archived_at, created_at,
              json_extract(payload_json, '$.lineage.parentThreadId') as parent_id,
              json_extract(payload_json, '$.delegatedFrom.threadId') as delegated_parent_id,
              json_extract(payload_json, '$.worktreePath') as worktree_path,
              payload_json
          FROM orchestration_v2_projection_threads
      )
      SELECT
          t.thread_id, t.title, t.default_provider,
          COALESCE(t.parent_id, t.delegated_parent_id) as parent_id,
          p.title as parent_title, p.deleted_at as parent_deleted_at,
          t.worktree_path, t.payload_json
      FROM all_threads t
      LEFT JOIN all_threads p ON p.thread_id = COALESCE(t.parent_id, t.delegated_parent_id)
      WHERE (t.parent_id IS NOT NULL OR t.delegated_parent_id IS NOT NULL)
        AND t.deleted_at IS NULL
        AND (p.thread_id IS NULL OR p.deleted_at IS NOT NULL)
      ORDER BY t.created_at DESC
    `)
    .all();
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
  return withDatabase(dbPath, { readOnly: dryRun }, (db) => {
    const roots = scanOrphanSessions(db);
    const orphans = [];
    const seen = new Set();
    for (const root of roots) {
      for (const row of [...findDescendantTree(db, root.thread_id), root]) {
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
  { keepParent = true, dryRun = true, action = "delete" } = {}
) {
  return withDatabase(dbPath, { readOnly: dryRun }, (db) => {
    const targetRow = db
      .prepare(
        "SELECT thread_id, title, deleted_at, archived_at, payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?"
      )
      .get(threadId);
    if (!targetRow || targetRow.deleted_at != null) {
      throw new Error(`Session ${threadId} not found in database.`);
    }

    const descendants = findDescendantTree(db, threadId).filter((d) =>
      action === "archive" ? d.archived_at == null : true
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
