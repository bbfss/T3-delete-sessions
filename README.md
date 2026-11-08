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

---

## Quick Setup via NPX (Zero Install)

You can run this MCP directly with `npx` without cloning or installing dependencies.

Add this to your MCP configuration (e.g., T3 Code, Claude Desktop, Cursor):

```json
{
  "mcpServers": {
    "t3-delete-sessions": {
      "command": "npx",
      "args": ["-y", "github:bbfss/T3-delete-sessions"]
    }
  }
}
```

*(Once published to the npm registry, you can also use `["-y", "t3-delete-sessions"]`)*

---

## Exposed MCP Tools

1. **`delete_orphans`**: Scan and purge all orphan sessions in T3 (sessions whose parent session was deleted).
2. **`delete_family`**: Cascade delete a target session and all of its descendants bottom-up (连根拔起).
3. **`delete_subsessions`**: Clean only child subagents, keeping the parent session active for further chat.

---

## Local Development & CLI Usage

You can also run the cleaner script directly from the terminal:

```bash
# Scan and clean all orphan sessions
python3 cleaner.py --orphans

# Cascade delete a specific session and all its child tasks
python3 cleaner.py --thread <THREAD_ID>

# Clean all child subagents under the current session (keep parent)
python3 cleaner.py --current --keep-parent
```

## License

MIT
