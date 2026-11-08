#!/usr/bin/env python3
import sys
import json
import os
from pathlib import Path
from cleaner import clean_orphans, clean_family, DEFAULT_DB_PATH, get_db_connection, detect_current_session

def handle_rpc():
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue

        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params", {})

        if method == "initialize":
            res = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "tools": {}
                    },
                    "serverInfo": {
                        "name": "t3-delete-sessions-mcp",
                        "version": "1.0.0"
                    }
                }
            }
            sys.stdout.write(json.dumps(res) + "\n")
            sys.stdout.flush()

        elif method == "tools/list":
            tools = [
                {
                    "name": "delete_orphans",
                    "description": "Scan and purge all orphan sessions in T3 (sessions whose parent session was deleted, preventing them from bubbling up).",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "dry_run": {
                                "type": "boolean",
                                "description": "Preview orphan sessions without deleting (default false)"
                            },
                            "archive_only": {
                                "type": "boolean",
                                "description": "Archive instead of permanently deleting (default false)"
                            }
                        }
                    }
                },
                {
                    "name": "delete_family",
                    "description": "Cascade delete a target session and all its child/subagent sessions bottom-up (completely purges the session family tree).",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "thread_id": {
                                "type": "string",
                                "description": "The root session/thread ID to delete. If omitted, attempts to auto-detect current session."
                            },
                            "keep_parent": {
                                "type": "boolean",
                                "description": "If true, only deletes subagent/child sessions while keeping the parent active (default false)."
                            },
                            "dry_run": {
                                "type": "boolean",
                                "description": "Preview without deleting (default false)"
                            }
                        }
                    }
                },
                {
                    "name": "delete_subsessions",
                    "description": "Delete all child/subagent sessions under the current or specified session, keeping the parent session active.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "thread_id": {
                                "type": "string",
                                "description": "The parent session ID. If omitted, attempts to auto-detect current session."
                            },
                            "dry_run": {
                                "type": "boolean",
                                "description": "Preview without deleting (default false)"
                            }
                        }
                    }
                }
            ]
            res = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "tools": tools
                }
            }
            sys.stdout.write(json.dumps(res) + "\n")
            sys.stdout.flush()

        elif method == "tools/call":
            tool_name = params.get("name")
            args = params.get("arguments", {})
            try:
                if tool_name == "delete_orphans":
                    result = clean_orphans(
                        dry_run=args.get("dry_run", False),
                        action="archive" if args.get("archive_only") else "delete"
                    )
                elif tool_name == "delete_family":
                    tid = args.get("thread_id")
                    if not tid:
                        conn = get_db_connection(DEFAULT_DB_PATH)
                        tid = detect_current_session(conn, os.getcwd())
                    result = clean_family(
                        thread_id=tid,
                        keep_parent=args.get("keep_parent", False),
                        dry_run=args.get("dry_run", False)
                    )
                elif tool_name == "delete_subsessions":
                    tid = args.get("thread_id")
                    if not tid:
                        conn = get_db_connection(DEFAULT_DB_PATH)
                        tid = detect_current_session(conn, os.getcwd())
                    result = clean_family(
                        thread_id=tid,
                        keep_parent=True,
                        dry_run=args.get("dry_run", False)
                    )
                else:
                    raise ValueError(f"Unknown tool: {tool_name}")

                res = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [
                            {
                                "type": "text",
                                "text": json.dumps(result, indent=2, ensure_ascii=False)
                            }
                        ]
                    }
                }
            except Exception as e:
                res = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "isError": True,
                    "error": {
                        "code": -32000,
                        "message": str(e)
                    }
                }
            sys.stdout.write(json.dumps(res) + "\n")
            sys.stdout.flush()

if __name__ == "__main__":
    handle_rpc()
