import { spawnSync } from "node:child_process";
import { existsSync, rmSync, lstatSync, readFileSync } from "node:fs";
import { dirname, resolve, sep, join } from "node:path";
import { randomUUID } from "node:crypto";
import { withDatabase, withTransaction } from "./sqlite.js";

function hasTable(db, tableName) {
  return Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(tableName)
  );
}

function hasColumn(db, tableName, colName) {
  if (!hasTable(db, tableName)) return false;
  return db
    .prepare(`PRAGMA table_info("${tableName}")`)
    .all()
    .some((c) => c.name === colName);
}

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
  { localEnvironmentId = null, includeDeleted = false } = {}
) {
  const hasSubagents = hasTable(db, "orchestration_v2_projection_subagents");
  const threadCols = new Set(
    db
      .prepare('PRAGMA table_info("orchestration_v2_projection_threads")')
      .all()
      .map((c) => c.name)
  );
  const selectFields = [
    "thread_id",
    threadCols.has("title") ? "title" : "NULL AS title",
    threadCols.has("default_provider")
      ? "default_provider"
      : "NULL AS default_provider",
    threadCols.has("created_at") ? "created_at" : "NULL AS created_at",
    threadCols.has("archived_at") ? "archived_at" : "NULL AS archived_at",
    threadCols.has("deleted_at") ? "deleted_at" : "NULL AS deleted_at",
    threadCols.has("payload_json") ? "payload_json" : "'{}' AS payload_json",
  ].join(", ");

  const deletedFilter = includeDeleted ? "" : "WHERE deleted_at IS NULL AND (";
  const whereOpen = includeDeleted ? "WHERE (" : deletedFilter;

  const subagentClause = hasSubagents
    ? `OR thread_id IN (
          SELECT child_thread_id FROM orchestration_v2_projection_subagents
          WHERE thread_id = ? AND child_thread_id IS NOT NULL
       )`
    : "";

  const stmt = db.prepare(`
    SELECT ${selectFields}
    FROM orchestration_v2_projection_threads
    ${whereOpen}
        json_extract(payload_json, '$.lineage.parentThreadId') = ?
        OR (
          json_extract(payload_json, '$.delegatedFrom.threadId') = ?
          AND (
            json_extract(payload_json, '$.delegatedFrom.environmentId') IS NULL
            OR (? IS NOT NULL AND json_extract(payload_json, '$.delegatedFrom.environmentId') = ?)
          )
        )
        ${subagentClause}
      )
  `);

  const visited = new Set();
  const treeNodes = [];

  function traverse(parentId, depth) {
    const params = hasSubagents
      ? [parentId, parentId, localEnvironmentId, localEnvironmentId, parentId]
      : [parentId, parentId, localEnvironmentId, localEnvironmentId];
    const children = stmt.all(...params);
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

export function findRemoteDelegatedChildren(
  db,
  threadIds,
  { localEnvironmentId = null } = {}
) {
  if (!Array.isArray(threadIds) || threadIds.length === 0) return [];
  if (!hasTable(db, "orchestration_v2_projection_subagents")) return [];
  if (!hasColumn(db, "orchestration_v2_projection_subagents", "payload_json")) {
    return [];
  }

  const seen = new Set();
  const remoteTargets = [];
  const stmt = db.prepare(
    "SELECT thread_id, payload_json FROM orchestration_v2_projection_subagents WHERE thread_id = ?"
  );

  for (const tid of threadIds) {
    const rows = stmt.all(tid);
    for (const row of rows) {
      let payload;
      try {
        payload = JSON.parse(row.payload_json || "{}");
      } catch {
        continue;
      }
      const rc = payload?.remoteChild;
      if (!rc || !rc.environmentId || !rc.threadId) continue;
      if (localEnvironmentId && rc.environmentId === localEnvironmentId) continue;
      const key = `${rc.environmentId}\0${rc.threadId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      remoteTargets.push({
        parentThreadId: tid,
        subagentId: payload.id ?? null,
        environmentId: rc.environmentId,
        threadId: rc.threadId,
        label: rc.label ?? null,
        title: payload.title ?? null,
        status: payload.status ?? null,
      });
    }
  }
  return remoteTargets;
}

export function buildAutoRegistryFromDb(
  dbPath,
  anchorThreadId,
  currentEnvironmentId
) {
  const localEnv = currentEnvironmentId || readLocalEnvironmentId(dbPath) || "local";
  return withDatabase(dbPath, { readOnly: true }, (db) => {
    const allThreads = db
      .prepare(
        "SELECT thread_id, title, deleted_at, archived_at, payload_json FROM orchestration_v2_projection_threads"
      )
      .all();
    const byId = new Map(allThreads.map((r) => [r.thread_id, r]));
    if (!byId.has(anchorThreadId)) {
      throw new Error(`Session ${anchorThreadId} not found in database.`);
    }

    const parentOf = new Map();
    for (const r of allThreads) {
      const pl = JSON.parse(r.payload_json || "{}");
      const p =
        pl.lineage?.parentThreadId ||
        (pl.delegatedFrom?.threadId &&
        (!pl.delegatedFrom?.environmentId ||
          pl.delegatedFrom.environmentId === localEnv)
          ? pl.delegatedFrom.threadId
          : null);
      if (p && byId.has(p)) {
        parentOf.set(r.thread_id, p);
      }
    }

    if (hasTable(db, "orchestration_v2_projection_subagents")) {
      const subRows = db
        .prepare(
          "SELECT thread_id, child_thread_id FROM orchestration_v2_projection_subagents WHERE child_thread_id IS NOT NULL"
        )
        .all();
      for (const s of subRows) {
        if (
          s.child_thread_id &&
          s.thread_id &&
          byId.has(s.child_thread_id) &&
          byId.has(s.thread_id) &&
          !parentOf.has(s.child_thread_id)
        ) {
          parentOf.set(s.child_thread_id, s.thread_id);
        }
      }
    }

    // Walk up to the local root of anchorThreadId
    let rootThreadId = anchorThreadId;
    const visitedUp = new Set([rootThreadId]);
    while (parentOf.has(rootThreadId)) {
      const nextParent = parentOf.get(rootThreadId);
      if (!nextParent || visitedUp.has(nextParent)) break;
      visitedUp.add(nextParent);
      rootThreadId = nextParent;
    }

    const descendants = findDescendantTree(db, rootThreadId, {
      localEnvironmentId: localEnv,
    });
    const localClusterIds = [
      rootThreadId,
      ...descendants.map((d) => d.thread_id),
    ];
    const uniqueLocalIds = [...new Set(localClusterIds)];

    const nodes = [];
    for (const tid of uniqueLocalIds) {
      nodes.push({
        nodeId: tid,
        parentNodeId: tid === rootThreadId ? null : (parentOf.get(tid) ?? rootThreadId),
        t3: {
          environmentId: localEnv,
          threadId: tid,
        },
      });
    }

    const remotes = findRemoteDelegatedChildren(db, uniqueLocalIds, {
      localEnvironmentId: localEnv,
    });
    for (const rem of remotes) {
      const remoteNodeId = `remote:${rem.environmentId}:${rem.threadId}`;
      nodes.push({
        nodeId: remoteNodeId,
        parentNodeId: rem.parentThreadId,
        label: rem.label ?? null,
        title: rem.title ?? null,
        t3: {
          environmentId: rem.environmentId,
          threadId: rem.threadId,
        },
      });
    }

    return {
      anchorNodeId: anchorThreadId,
      currentEnvironmentId: localEnv,
      registry: { nodes },
    };
  });
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
    const allDescendantsIncludingDeleted =
      action === "delete"
        ? findDescendantTree(db, threadId, {
            localEnvironmentId,
            includeDeleted: true,
          })
        : descendants;
    const deletedDescendantIds = allDescendantsIncludingDeleted
      .filter((d) => d.deleted_at != null)
      .map((d) => d.thread_id);

    const clusterIds = [
      ...allDescendantsIncludingDeleted.map((d) => d.thread_id),
      threadId,
    ];
    const remoteChildren = findRemoteDelegatedChildren(db, clusterIds, {
      localEnvironmentId,
    });

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

    const selectedIdsForInspection = [
      ...descendants.map((d) => d.thread_id),
      ...deletedDescendantIds,
      ...(!keepParent ? [threadId] : []),
    ];
    const worktreeInspection = inspectWorktreesForThreads(
      dbPath,
      selectedIdsForInspection,
      { existingDb: db }
    );
    const worktreeConfirmationsRequired = worktreeInspection.filter(
      (w) => w.requiresConfirmation
    );

    const response = {
      status: dryRun ? "preview" : "updated_offline_database",
      action,
      parentThreadId: threadId,
      parentDeleted: parentProcessed && action === "delete",
      parentArchived: parentProcessed && action === "archive",
      parentSelected: !keepParent && (action !== "archive" || targetRow.archived_at == null),
      childrenCount: processedChildren.length,
      children: processedChildren,
    };
    if (deletedDescendantIds.length > 0) {
      response.previouslyDeletedChildrenIds = deletedDescendantIds;
    }
    if (remoteChildren.length > 0) {
      response.remoteChildren = remoteChildren;
    }
    if (worktreeConfirmationsRequired.length > 0) {
      response.worktreeConfirmationsRequired = worktreeConfirmationsRequired;
    }
    return response;
  });
}

function checkGitDirtyStatus(directory) {
  try {
    const res = spawnSync("git", ["-C", directory, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    if (res.status === 0) {
      return Boolean(String(res.stdout || "").trim());
    }
  } catch {
    // Ignore git invocation error
  }
  return false;
}

function removeGitLinkedWorktree(directory) {
  const dotGit = join(directory, ".git");
  if (existsSync(dotGit)) {
    try {
      const stat = lstatSync(dotGit);
      if (stat.isFile()) {
        const content = readFileSync(dotGit, "utf8").trim();
        const m = /^gitdir:\s*(.+)$/i.exec(content);
        if (m) {
          const gitDir = resolve(directory, m[1].trim());
          const commonRepoGitDir = dirname(dirname(gitDir));
          spawnSync(
            "git",
            ["--git-dir", commonRepoGitDir, "worktree", "remove", "--force", directory],
            { encoding: "utf8", timeout: 5000, windowsHide: true }
          );
        }
      }
    } catch {
      // Fallback to rmSync below
    }
  }
  if (existsSync(directory)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function inspectWorktreesForThreads(
  dbPath,
  ids,
  { existingDb = null } = {}
) {
  if (!dbPath || !Array.isArray(ids) || ids.length === 0) return [];
  const t3Base = resolve(dirname(dirname(resolve(dbPath))));
  const scratchRoot = resolve(t3Base, "scratch");
  const worktreesRoot = resolve(t3Base, "worktrees");

  const runInspect = (db) => {
    const rows = db
      .prepare(
        "SELECT thread_id, deleted_at, payload_json FROM orchestration_v2_projection_threads"
      )
      .all();
    const projectRoots = new Set();
    if (hasTable(db, "projection_projects")) {
      const projRows = db
        .prepare("SELECT workspace_root, deleted_at FROM projection_projects")
        .all();
      for (const p of projRows) {
        if (p.workspace_root && !p.deleted_at) {
          projectRoots.add(resolve(p.workspace_root));
        }
      }
    }

    const idSet = new Set(ids);
    const paths = rows.map((row) => ({
      ...row,
      path: JSON.parse(row.payload_json || "{}").worktreePath,
    }));

    const seenDirs = new Set();
    const results = [];

    for (const row of paths.filter((r) => idSet.has(r.thread_id))) {
      if (!row.path) continue;
      const directory = resolve(row.path);
      if (seenDirs.has(directory)) continue;
      seenDirs.add(directory);

      const isUnderScratch =
        dirname(directory) === scratchRoot ||
        directory.startsWith(`${scratchRoot}${sep}`);
      const isUnderManagedWorktrees =
        dirname(directory) === worktreesRoot ||
        directory.startsWith(`${worktreesRoot}${sep}`);

      const sharedWithLive = paths.some(
        (other) =>
          !idSet.has(other.thread_id) &&
          !other.deleted_at &&
          other.path &&
          (resolve(other.path) === directory ||
            resolve(other.path).startsWith(`${directory}${sep}`))
      );

      const dotGitPath = join(directory, ".git");
      const hasDotGit = existsSync(dotGitPath);
      const isLinkedWorktree =
        hasDotGit &&
        (() => {
          try {
            return lstatSync(dotGitPath).isFile();
          } catch {
            return false;
          }
        })();

      if (projectRoots.has(directory)) {
        results.push({
          threadId: row.thread_id,
          path: directory,
          kind: "project_root",
          requiresConfirmation: false,
          status: "retained_project_root",
        });
        continue;
      }

      if (sharedWithLive) {
        results.push({
          threadId: row.thread_id,
          path: directory,
          kind: "shared",
          requiresConfirmation: false,
          status: "retained_shared",
        });
        continue;
      }

      if (isUnderScratch) {
        if (hasDotGit) {
          results.push({
            threadId: row.thread_id,
            path: directory,
            kind: isLinkedWorktree ? "scratch_linked_worktree" : "scratch_git",
            hasUncommittedChanges: checkGitDirtyStatus(directory),
            requiresConfirmation: true,
          });
        } else {
          results.push({
            threadId: row.thread_id,
            path: directory,
            kind: "exclusive_scratch",
            requiresConfirmation: false,
          });
        }
        continue;
      }

      if (isUnderManagedWorktrees || isLinkedWorktree) {
        results.push({
          threadId: row.thread_id,
          path: directory,
          kind: "isolated_git_worktree",
          hasUncommittedChanges: checkGitDirtyStatus(directory),
          requiresConfirmation: true,
        });
        continue;
      }

      // External non-worktree directory (e.g., user repository): always preserve.
      results.push({
        threadId: row.thread_id,
        path: directory,
        kind: "external_workspace",
        requiresConfirmation: false,
        status: "retained_external_workspace",
      });
    }

    return results;
  };

  if (existingDb) return runInspect(existingDb);
  return withDatabase(dbPath, { readOnly: true }, runInspect);
}

// Remove T3-owned exclusive scratch directories (and confirmed git/worktree directories) after online deletion.
export function removeDeletedScratch(
  dbPath,
  ids,
  { confirmRemoveGitWorktrees = false } = {}
) {
  const t3Base = resolve(dirname(dirname(resolve(dbPath))));
  const root = resolve(t3Base, "scratch");
  const worktreesRoot = resolve(t3Base, "worktrees");

  return withDatabase(dbPath, { readOnly: true }, (db) => {
    const rows = db
      .prepare(
        "SELECT thread_id, deleted_at, payload_json FROM orchestration_v2_projection_threads"
      )
      .all();
    const projectRoots = new Set();
    if (hasTable(db, "projection_projects")) {
      const projRows = db
        .prepare("SELECT workspace_root, deleted_at FROM projection_projects")
        .all();
      for (const p of projRows) {
        if (p.workspace_root && !p.deleted_at) {
          projectRoots.add(resolve(p.workspace_root));
        }
      }
    }

    const paths = rows.map((row) => ({
      ...row,
      path: JSON.parse(row.payload_json || "{}").worktreePath,
    }));
    const seenDirs = new Set();
    const results = [];

    for (const row of paths.filter(
      (row) => ids.includes(row.thread_id) && row.deleted_at
    )) {
      if (!row.path) continue;
      const directory = resolve(row.path);
      if (seenDirs.has(directory)) continue;

      const isUnderScratch = dirname(directory) === root;
      const isUnderManagedWorktrees =
        dirname(directory) === worktreesRoot ||
        directory.startsWith(`${worktreesRoot}${sep}`);
      const dotGitPath = join(directory, ".git");
      const hasDotGit = existsSync(dotGitPath);
      const isLinkedWorktree =
        hasDotGit &&
        (() => {
          try {
            return lstatSync(dotGitPath).isFile();
          } catch {
            return false;
          }
        })();

      if (!isUnderScratch && !isUnderManagedWorktrees && !isLinkedWorktree) {
        continue;
      }
      seenDirs.add(directory);

      if (projectRoots.has(directory)) {
        results.push({ path: directory, status: "retained_project_root" });
        continue;
      }

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

      if (hasDotGit || isUnderManagedWorktrees || isLinkedWorktree) {
        if (!confirmRemoveGitWorktrees) {
          results.push({
            path: directory,
            status: "retained_git",
            requiresConfirmation: true,
          });
          continue;
        }
        if (existsSync(directory)) {
          if (lstatSync(directory).isSymbolicLink()) continue;
          removeGitLinkedWorktree(directory);
        }
        results.push({
          path: directory,
          status: existsSync(directory) ? "failed" : "removed",
        });
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
