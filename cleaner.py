import os
import sys
import json
import sqlite3
import argparse
import datetime
import uuid
import shutil
import subprocess
from pathlib import Path

DEFAULT_DB_PATH = Path.home() / ".t3" / "userdata" / "statev2.sqlite"
DEFAULT_SCRATCH_DIR = Path.home() / ".t3" / "scratch"


def get_db_connection(db_path: Path) -> sqlite3.Connection:
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found at {db_path}")
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    return conn


def detect_current_session(conn: sqlite3.Connection, cwd: str) -> str:
    """Infer current session thread_id based on working directory or scratch path."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT thread_id, title, payload_json FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL AND json_extract(payload_json, '$.worktreePath') = ?
        ORDER BY updated_at DESC LIMIT 1
        """,
        (cwd,),
    )
    row = cur.fetchone()
    if row:
        return row["thread_id"]

    for part in Path(cwd).parts:
        if part.startswith("2026-") and "-session-" in part:
            suffix = part.split("-session-")[-1]
            cur.execute(
                """
                SELECT thread_id FROM orchestration_v2_projection_threads
                WHERE deleted_at IS NULL AND thread_id LIKE ?
                LIMIT 1
                """,
                (f"%{suffix}%",),
            )
            match = cur.fetchone()
            if match:
                return match["thread_id"]

    cur.execute(
        """
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL
        ORDER BY updated_at DESC LIMIT 1
        """
    )
    latest = cur.fetchone()
    if latest:
        return latest["thread_id"]
    raise RuntimeError("Could not automatically determine the current session ID.")


def find_descendant_tree(conn: sqlite3.Connection, root_thread_id: str):
    """
    Find all direct and indirect descendants of root_thread_id.
    Includes:
    1. Subagents via lineage.parentThreadId
    2. Subagents recorded in orchestration_v2_projection_subagents
    3. Delegated tasks via delegatedFrom.threadId
    4. Side chats via contextTransfers (fork where source = parent)
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


def cleanup_provider_native_session(conn: sqlite3.Connection, thread_id: str):
    """
    Clean up underlying provider files/sessions:
    1. Codex native sessions (via codex delete)
    2. Antigravity native conversation DBs and brain artifact directories
    3. Claude / other provider cache/session files
    """
    cur = conn.cursor()
    cur.execute(
        "SELECT driver, provider_thread_id, provider_session_id FROM orchestration_v2_projection_provider_threads WHERE thread_id = ?",
        (thread_id,)
    )
    rows = cur.fetchall()
    targets_to_purge = set()

    for row in rows:
        driver = row["driver"]
        ptid = row["provider_thread_id"] or ""
        psid = row["provider_session_id"] or ""

        # 1. Clean Codex
        if driver == "codex":
            raw_id = ptid.split("native-thread:")[-1] if "native-thread:" in ptid else ptid
            if raw_id:
                try:
                    subprocess.run(["codex", "delete", raw_id, "--force"], capture_output=True, timeout=5)
                except Exception:
                    pass

        # 2. Extract UUIDs for local folder cleanup
        for cand in [thread_id, ptid, psid]:
            for part in cand.replace("%3A", ":").split(":"):
                if len(part) == 36 and part.count("-") == 4:
                    targets_to_purge.add(part)

    # 3. Clean Antigravity conversation DBs and brain folder
    # Located in ~/.t3/userdata/providers/antigravity/.../{conversations,brain}
    providers_dir = Path.home() / ".t3" / "userdata" / "providers"
    for target_uuid in targets_to_purge:
        for item in providers_dir.glob(f"**/{target_uuid}*"):
            try:
                if item.is_dir():
                    shutil.rmtree(item, ignore_errors=True)
                else:
                    item.unlink(missing_ok=True)
            except Exception:
                pass


def mark_thread_deleted(
    conn: sqlite3.Connection,
    thread_id: str,
    payload_json_str: str,
    action: str = "delete",
    dry_run: bool = False,
):
    """
    Mark a thread deleted (or archived) safely in both:
    1. orchestration_v2_projection_threads
    2. orchestration_events (Event Sourcing append)
    3. Underlying provider session cleanup
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

    # 2. Append Event to orchestration_events
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

    # 3. Clean native provider sessions
    cleanup_provider_native_session(conn, thread_id)


def purge_worktree(worktree_path: str, dry_run: bool = False):
    """Safely purge scratch worktree if it resides in ~/.t3/scratch/."""
    if not worktree_path:
        return None
    p = Path(worktree_path).resolve()
    scratch_root = DEFAULT_SCRATCH_DIR.resolve()
    try:
        p.relative_to(scratch_root)
    except ValueError:
        return f"Skipped (outside scratch: {p})"

    if not p.exists():
        return "Already gone"

    if dry_run:
        return f"Would remove: {p}"

    try:
        shutil.rmtree(p)
        return f"Removed: {p}"
    except Exception as e:
        return f"Failed to remove {p}: {e}"


def clean_orphans(db_path=DEFAULT_DB_PATH, dry_run=False, action="delete", purge_scratch=True):
    conn = get_db_connection(db_path)
    orphans = scan_orphan_sessions(conn)
    if not orphans:
        return {"status": "clean", "count": 0, "orphans": []}

    results = []
    if not dry_run:
        with conn:
            for o in orphans:
                mark_thread_deleted(conn, o["thread_id"], o["payload_json"], action=action)
                wt_status = None
                if purge_scratch and o.get("worktree_path"):
                    wt_status = purge_worktree(o["worktree_path"], dry_run=False)
                results.append({"threadId": o["thread_id"], "title": o["title"], "worktree": wt_status})
    else:
        for o in orphans:
            results.append({"threadId": o["thread_id"], "title": o["title"], "dryRun": True})

    return {"status": "success", "count": len(results), "orphans": results}


def clean_family(thread_id, db_path=DEFAULT_DB_PATH, keep_parent=False, dry_run=False, action="delete", purge_scratch=True):
    conn = get_db_connection(db_path)
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
                wt = json.loads(d["payload_json"]).get("worktreePath")
                if purge_scratch and wt:
                    purge_worktree(wt, dry_run=False)
                deleted_children.append({"threadId": d["thread_id"], "title": d["title"]})

            parent_deleted = False
            if not keep_parent:
                mark_thread_deleted(conn, thread_id, target_row["payload_json"], action=action)
                t_wt = json.loads(target_row["payload_json"]).get("worktreePath")
                if purge_scratch and t_wt:
                    purge_worktree(t_wt, dry_run=False)
                parent_deleted = True
    else:
        deleted_children = [{"threadId": d["thread_id"], "title": d["title"], "dryRun": True} for d in descendants]
        parent_deleted = not keep_parent

    return {
        "status": "success",
        "parentThreadId": thread_id,
        "parentDeleted": parent_deleted,
        "childrenCount": len(deleted_children),
        "children": deleted_children
    }
