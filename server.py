#!/usr/bin/env python3
"""MCP interface for inspecting and maintaining an offline T3 database."""
import argparse
import json
import socket
import sys
from pathlib import Path
from cleaner import clean_family, clean_orphans


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
        result.append({"name": name, "description": "Preview by default. Explicit offline database maintenance only; preserves native provider files and worktrees. No live UI broadcast.",
                       "inputSchema": {"type": "object", "properties": properties, "required": required,
                                       "additionalProperties": False}})
    return result


def call_tool(name, args, config):
    target = {"hostname": socket.gethostname(), "db_path": str(config.db) if config.db else None,
              "offline_writes_enabled": config.allow_offline_writes,
              "native_files": "preserved", "worktrees": "preserved"}
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
    if not dry_run and not (config.allow_offline_writes and args.get("offline_confirmed") is True):
        raise ValueError("Writes require --allow-offline-writes and offline_confirmed=true. Use the official T3 API for a running server.")
    if name == "delete_orphans":
        result = clean_orphans(config.db, dry_run=dry_run, action="archive" if args.get("archive_only") else "delete")
    else:
        result = clean_family(args["thread_id"], config.db, dry_run=dry_run,
                              keep_parent=True if name == "delete_subsessions" else args.get("keep_parent", True))
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
                          "serverInfo": {"name": "t3-delete-sessions-mcp", "version": "1.1.0"}}
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
    parser.add_argument("--db", type=Path, help="Explicit absolute path; no default production database")
    parser.add_argument("--allow-offline-writes", action="store_true")
    config = parser.parse_args()
    if config.db:
        if not config.db.is_absolute():
            parser.error("--db must be absolute")
        config.db = config.db.resolve()
    handle_rpc(config)
