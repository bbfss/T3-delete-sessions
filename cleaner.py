import json
import os
import shutil
import sqlite3
import datetime
import uuid
from pathlib import Path
from contextlib import closing


def sqlite_uri(db_path: Path, mode: str = "rw") -> str:
    resolved = db_path.resolve() if hasattr(db_path, "resolve") else db_path
    raw = str(resolved)
    if raw.startswith("\\\\?\\") and not raw.startswith("\\\\?\\UNC\\"):
        resolved = type(resolved)(raw[4:])
    return f"{resolved.as_uri()}?mode={mode}"


def node_executable() -> str:
    return os.environ.get("T3_NODE_EXECUTABLE") or shutil.which("node") or "node"


def get_db_connection(db_path: Path) -> sqlite3.Connection:
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found at {db_path}")
    conn = sqlite3.connect(sqlite_uri(db_path, "rw"), uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def find_descendant_tree(conn: sqlite3.Connection, root_thread_id: str):
    """
    Find all direct and indirect descendants of root_thread_id.
    Includes:
    1. Subagents via lineage.parentThreadId
    2. Subagents recorded in orchestration_v2_projection_subagents
    3. Delegated tasks via delegatedFrom.threadId
    Returns: strictly ordered post-order traversal list (deepest children first).
    """
    cur = conn.cursor()
    visited = set()
    tree_nodes = []

    def traverse(parent_id, depth):
        cur.execute(
            """
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
            """,
            (parent_id, parent_id, parent_id),
        )
        children = cur.fetchall()
        for child in children:
            cid = child["thread_id"]
            if cid in visited or cid == root_thread_id:
                continue
            visited.add(cid)
            traverse(cid, depth + 1)
            tree_nodes.append((depth, dict(child)))

    traverse(root_thread_id, 1)
    tree_nodes.sort(key=lambda x: x[0], reverse=True)
    return [node[1] for node in tree_nodes]


def scan_orphan_sessions(conn: sqlite3.Connection):
    """
    Scan all sessions where parentThreadId or delegatedFrom.threadId exists,
    but the parent thread is either deleted or no longer exists in DB.
    """
    cur = conn.cursor()
    cur.execute(
        """
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
        """
    )
    return [dict(r) for r in cur.fetchall()]


def mark_thread_deleted(
    conn: sqlite3.Connection,
    thread_id: str,
    payload_json_str: str,
    action: str = "delete",
    dry_run: bool = False,
):
    """
    Update an offline database snapshot in both:
    1. orchestration_v2_projection_threads
    2. orchestration_events (Event Sourcing append)
    """
    now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    payload = json.loads(payload_json_str)

    if action == "delete":
        payload["deletedAt"] = now_iso
        col = "deleted_at"
        event_type = "thread.deleted"
    else:
        payload["archivedAt"] = now_iso
        col = "archived_at"
        event_type = "thread.archived"

    payload["updatedAt"] = now_iso
    updated_payload_str = json.dumps(payload, ensure_ascii=False)

    if dry_run:
        return

    cur = conn.cursor()

    # 1. Update projection
    cur.execute(
        f"""
        UPDATE orchestration_v2_projection_threads
        SET {col} = ?, updated_at = ?, payload_json = ?
        WHERE thread_id = ?
        """,
        (now_iso, now_iso, updated_payload_str, thread_id),
    )

    # Append a local event record; this does not broadcast a live T3 event.
    cur.execute(
        """
        SELECT COALESCE(MAX(stream_version), 0) + 1 as next_ver
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ?
        """,
        (thread_id,),
    )
    row = cur.fetchone()
    next_stream_version = row["next_ver"] if row else 1

    event_id = f"event:thread:{thread_id}:cleaner:{uuid.uuid4()}"
    cur.execute(
        """
        INSERT INTO orchestration_events (
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
        ) VALUES (?, 'thread', ?, ?, ?, ?, ?, 'server', ?, '{}', 2)
        """,
        (
            event_id,
            thread_id,
            next_stream_version,
            event_type,
            now_iso,
            f"cmd:cleaner:{uuid.uuid4()}",
            updated_payload_str,
        ),
    )

def clean_orphans(db_path, dry_run=True, action="delete"):
    with closing(get_db_connection(Path(db_path))) as conn:
        roots = scan_orphan_sessions(conn)
        orphans = []
        seen = set()
        for root in roots:
            for row in find_descendant_tree(conn, root["thread_id"]) + [root]:
                if row["thread_id"] not in seen:
                    seen.add(row["thread_id"])
                    orphans.append(row)
        if not orphans:
            return {"status": "clean", "count": 0, "orphans": []}

        results = []
        if not dry_run:
            with conn:
                for o in orphans:
                    mark_thread_deleted(conn, o["thread_id"], o["payload_json"], action=action)
                    results.append({"threadId": o["thread_id"], "title": o["title"]})
        else:
            for o in orphans:
                results.append({"threadId": o["thread_id"], "title": o["title"], "dryRun": True})

        return {"status": "preview" if dry_run else "updated_offline_database", "count": len(results), "orphans": results}


def clean_family(thread_id, db_path, keep_parent=True, dry_run=True, action="delete"):
    with closing(get_db_connection(Path(db_path))) as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT thread_id, title, payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?",
            (thread_id,),
        )
        target_row = cur.fetchone()
        if not target_row:
            raise ValueError(f"Session {thread_id} not found in database.")

        descendants = find_descendant_tree(conn, thread_id)
        deleted_children = []

        if not dry_run:
            with conn:
                for d in descendants:
                    mark_thread_deleted(conn, d["thread_id"], d["payload_json"], action=action)
                    deleted_children.append({"threadId": d["thread_id"], "title": d["title"]})

                parent_deleted = False
                if not keep_parent:
                    mark_thread_deleted(conn, thread_id, target_row["payload_json"], action=action)
                    parent_deleted = True
        else:
            deleted_children = [{"threadId": d["thread_id"], "title": d["title"], "dryRun": True} for d in descendants]
            parent_deleted = False

        return {
            "status": "preview" if dry_run else "updated_offline_database",
            "parentThreadId": thread_id,
            "parentDeleted": parent_deleted and action == "delete",
            "parentSelected": not keep_parent,
            "childrenCount": len(deleted_children),
            "children": deleted_children
        }
