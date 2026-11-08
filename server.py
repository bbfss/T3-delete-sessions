#!/usr/bin/env python3
"""MCP session cleanup through a running T3 server or an offline database."""
import argparse
import json
import socket
import sys
import subprocess
import sqlite3
import os
import shutil
from pathlib import Path
from cleaner import clean_family, clean_orphans
from family import plan_cleanup, execute_step


def tool_definitions():
    common = {
        "target_host": {"type": "string", "description": "Exact hostname returned by inspect_target."},
        "db_path": {"type": "string", "description": "Absolute database path returned by inspect_target."},
        "dry_run": {"type": "boolean", "default": True},
        "offline_confirmed": {"type": "boolean", "default": False,
                              "description": "True only for an offline snapshot or a database whose T3 server is stopped."},
    }
    result = [{"name": "inspect_target", "description": "Show this MCP process's machine, configured database and write mode. Does not delete anything.",
               "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}}]
    for name in ("delete_family", "delete_subsessions", "delete_orphans"):
        properties = dict(common)
        required = ["target_host", "db_path"]
        if name != "delete_orphans":
            properties["thread_id"] = {"type": "string", "minLength": 1}
            required.append("thread_id")
        if name == "delete_family":
            properties["keep_parent"] = {"type": "boolean", "default": True}
        if name == "delete_orphans":
            properties["archive_only"] = {"type": "boolean", "default": False}
        result.append({"name": name, "description": "Preview by default. In online mode, stop and clean selected threads through T3 official commands. Offline mode requires explicit opt-in. Preserves provider files and worktrees.",
                       "inputSchema": {"type": "object", "properties": properties, "required": required,
                                       "additionalProperties": False}})
    result.extend([
        {"name": "plan_cross_device_cleanup", "description": "Plan current-thread descendants: all remote endpoints must finish before any local deletion. Registry must contain verified T3 identities and parent edges.",
         "inputSchema": {"type": "object", "properties": {
             "registry": {"type": "object"}, "anchor_node_id": {"type": "string"},
             "current_environment_id": {"type": "string"}, "current_thread_id": {"type": "string"}},
             "required": ["registry", "anchor_node_id", "current_environment_id", "current_thread_id"]}},
        {"name": "execute_cleanup_step", "description": "Execute one planned endpoint on its owning machine. Remote success receipts are mandatory before local deletion. Current coordinator and worker are protected. Defaults to preview.",
         "inputSchema": {"type": "object", "properties": {
             "plan": {"type": "object"}, "node_id": {"type": "string"},
             "receipts": {"type": "array", "items": {"type": "object"}},
             "worker_thread_id": {"type": "string"}, "dry_run": {"type": "boolean", "default": True}},
             "required": ["plan", "node_id", "receipts", "worker_thread_id"]}}
    ])
    return result


def call_tool(name, args, config):
    if name == "plan_cross_device_cleanup":
        return plan_cleanup(args['registry'], args['anchor_node_id'], args['current_environment_id'], args['current_thread_id'])
    if name == "execute_cleanup_step":
        if not config.db or not args.get('worker_thread_id'):
            raise ValueError('Configured database and exact worker_thread_id required')
        if type(args.get('dry_run', True)) is not bool:
            raise ValueError('dry_run must be a boolean')
        return execute_step(args['plan'], args['node_id'], args['receipts'], config,
                            args['worker_thread_id'], args.get('dry_run', True))
    target = {"hostname": socket.gethostname(), "db_path": str(config.db) if config.db else None,
              "offline_writes_enabled": config.allow_offline_writes,
              "t3_url": getattr(config, "t3_url", None),
              "native_files": "preserved", "worktrees": "preserved"}
    if config.db:
        identity_file = config.db.parent / 'environment-id'
        target['environment_id'] = identity_file.read_text().strip() if identity_file.exists() else None
    if name == "inspect_target":
        return target
    definition = next((t for t in tool_definitions() if t["name"] == name), None)
    if definition is None:
        raise ValueError(f"Unknown tool: {name}")
    schema = definition["inputSchema"]
    if not isinstance(args, dict) or set(args) - set(schema["properties"]):
        raise ValueError("Unknown or invalid arguments")
    for key in schema["required"]:
        if not isinstance(args.get(key), str) or not args[key].strip():
            raise ValueError(f"Explicit {key} is required; no session or machine is inferred")
    for key, value in args.items():
        if schema["properties"][key]["type"] == "boolean" and type(value) is not bool:
            raise ValueError(f"{key} must be a boolean")
    if config.db is None:
        raise ValueError("No database configured. Start this server with --db /absolute/path/to/offline.sqlite")
    supplied_path = Path(args["db_path"])
    if args["target_host"] != target["hostname"] or not supplied_path.is_absolute() or supplied_path.resolve() != config.db:
        raise ValueError("Target mismatch: call inspect_target on the intended machine first")
    dry_run = args.get("dry_run", True)
    if not dry_run and not getattr(config, "t3_url", None) and not (config.allow_offline_writes and args.get("offline_confirmed") is True):
        raise ValueError("Writes require --allow-offline-writes and offline_confirmed=true. Use the official T3 API for a running server.")
    if name == "delete_orphans":
        result = clean_orphans(config.db, dry_run=True if getattr(config, "t3_url", None) else dry_run, action="archive" if args.get("archive_only") else "delete")
    else:
        result = clean_family(args["thread_id"], config.db, dry_run=True if getattr(config, "t3_url", None) else dry_run,
                              keep_parent=True if name == "delete_subsessions" else args.get("keep_parent", True))
    if getattr(config, "t3_url", None) and not dry_run:
        ids = [r["threadId"] for r in result.get("orphans", result.get("children", []))]
        if result.get("parentSelected"):
            ids.append(args["thread_id"])
        action = "archive" if args.get("archive_only") else "delete"
        commands = []
        for tid in ids:
            commands.extend([{"type": "thread.stop", "threadId": tid},
                             {"type": "thread." + action, "threadId": tid}])
        if commands:
            proc = subprocess.run(["node", str(Path(__file__).parent / "bin/t3-rpc.js")],
                input=json.dumps({"cli": config.t3_cli, "baseDir": str(config.db.parent.parent),
                                  "url": config.t3_url, "commands": commands}),
                text=True, capture_output=True, timeout=40)
            if proc.returncode:
                raise RuntimeError("T3 command failed; some earlier commands may have completed: " + proc.stderr[-1500:])
            with sqlite3.connect(config.db.resolve().as_uri() + "?mode=ro", uri=True) as conn:
                for tid in ids:
                    row = conn.execute("SELECT " + ("archived_at" if action == "archive" else "deleted_at") +
                                       " FROM orchestration_v2_projection_threads WHERE thread_id=?", (tid,)).fetchone()
                    if row is None or row[0] is None:
                        raise RuntimeError("T3 did not confirm the requested state for " + tid)
        result["status"] = "completed_via_t3"
        result["parentDeleted"] = bool(result.get("parentSelected")) and action == "delete"
        for item in result.get("orphans", result.get("children", [])):
            item.pop("dryRun", None)
    return {"target": target, **result}


def handle_rpc(config):
    for line in sys.stdin:
        try:
            req = json.loads(line)
            if "id" not in req:
                continue
            method = req.get("method")
            if method == "initialize":
                result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                          "serverInfo": {"name": "t3-delete-sessions-mcp", "version": "1.3.0"}}
            elif method == "tools/list":
                result = {"tools": tool_definitions()}
            elif method == "ping":
                result = {}
            elif method == "tools/call":
                try:
                    params = req.get("params", {})
                    data = call_tool(params.get("name"), params.get("arguments", {}), config)
                    result = {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}]}
                except Exception as exc:
                    result = {"isError": True, "content": [{"type": "text", "text": str(exc)}]}
            else:
                print(json.dumps({"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32601, "message": "Unknown method"}}), flush=True)
                continue
            print(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}), flush=True)
        except (ValueError, TypeError) as exc:
            print(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(exc)}}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, help="Explicit absolute path to the target T3 database")
    parser.add_argument("--allow-offline-writes", action="store_true")
    parser.add_argument("--t3-url", help="Running T3 URL for official online deletion")
    parser.add_argument("--t3-cli", default="t3", help="T3 CLI on this machine")
    parser.add_argument("--auto-local", action="store_true", help="Use this host's running T3 runtime metadata; no session ID inference")
    parser.add_argument("--call", help="Call one tool and exit")
    parser.add_argument("--arguments-file", help="JSON tool arguments file, or - for stdin")
    config = parser.parse_args()
    if config.auto_local:
        if config.db or config.t3_url:
            parser.error("--auto-local cannot be combined with --db or --t3-url")
        base = Path(os.environ.get('T3CODE_HOME', str(Path.home() / '.t3'))).resolve()
        runtime = json.loads((base / 'userdata/server-runtime.json').read_text())
        config.db = base / 'userdata/statev2.sqlite'
        config.t3_url = runtime['origin']
        config.t3_cli = shutil.which(config.t3_cli) or config.t3_cli
    if config.db:
        if not config.db.is_absolute():
            parser.error("--db must be absolute")
        config.db = config.db.resolve()
    if config.call:
        if not config.arguments_file:
            parser.error("--call requires --arguments-file (use - for stdin)")
        args = json.loads(sys.stdin.read() if config.arguments_file == '-' else Path(config.arguments_file).read_text())
        try:
            print(json.dumps(call_tool(config.call, args, config), ensure_ascii=False))
        except Exception as exc:
            print(json.dumps({'status': 'failed', 'reason': str(exc)}, ensure_ascii=False))
            sys.exit(1)
    else:
        handle_rpc(config)
