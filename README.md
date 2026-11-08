# T3-delete-sessions (MCP & CLI)

A comprehensive, deterministic session cascading cleaner and orphan purger for **T3 Code**.

## Features

- **Cascade Delete (`delete_family`)**: Deletes a parent session along with all of its child subagents and delegated sessions bottom-up (post-order traversal). Prevents child sessions from popping up in the sidebar.
- **Orphan Purger (`delete_orphans`)**: Scans the entire T3 database for sessions whose parent session was deleted, and purges or archives them in bulk.
- **Subagent Cleaner (`delete_subsessions`)**: Cleans up all subagent tasks under the current session while preserving the current session for continuous work.
- **Multi-layer Cleanup**:
  - Updates `orchestration_v2_projection_threads`
  - Appends official Event Sourcing domain events (`orchestration_events`)
  - Cleans up underlying provider sessions (Codex, Antigravity, etc.)
  - Safely purges temporary scratch worktrees in `~/.t3/scratch/`

## MCP Server Setup

Add this to your MCP configuration (e.g. Claude Desktop, T3 Code, or Antigravity):

```json
{
  "mcpServers": {
    "t3-delete-sessions": {
      "command": "python3",
      "args": ["/path/to/T3-delete-sessions/server.py"]
    }
  }
}
```

### Exposed MCP Tools

1. `delete_orphans`: Scan and purge all orphan sessions in T3.
2. `delete_family`: Cascade delete a target session and all descendants.
3. `delete_subsessions`: Clean only child subagents, keeping the parent session alive.

## CLI Usage

You can also run `cleaner.py` directly from the terminal:

```bash
# Clean orphans
python3 cleaner.py --orphans

# Cascade delete target session and its children
python3 cleaner.py --thread <THREAD_ID>

# Clean subagents of current session
python3 cleaner.py --current --keep-parent
```

## License

MIT
