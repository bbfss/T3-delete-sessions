# T3-delete-sessions

MCP tools to inspect T3 session families and maintain an **offline database**.
Requires Node.js and Python 3 with SQLite support.

## Setup

```json
{
  "mcpServers": {
    "t3-delete-sessions": {
      "command": "npx",
      "args": ["-y", "github:bbfss/T3-delete-sessions", "--db", "/absolute/path/to/offline-statev2.sqlite"]
    }
  }
}
```

The MCP process operates on the machine that starts it. A local `npx` process
stays local even when an agent also runs tasks in InstaBox. To inspect an
InstaBox database, start the process inside that sandbox with its database path.
No database is selected automatically. Starting without `--db` permits target
inspection only. Reconnect the MCP after upgrading to load the new tools.

## Tools

- `inspect_target`: returns hostname, resolved database path and write mode.
- `delete_subsessions`: selects descendants of an explicit thread ID, preserving the parent.
- `delete_family`: selects descendants; includes the parent only with `keep_parent: false`.
- `delete_orphans`: selects orphan roots and their descendants; `archive_only: true` archives them.

All cleanup tools default to `dry_run: true`. Supply `target_host` and `db_path`
exactly as returned by `inspect_target`, plus `thread_id` for family operations.
IDs are never inferred from the working directory, title or latest activity.

Example preview:

```json
{
  "target_host": "sandbox-hostname",
  "db_path": "/tmp/test-statev2.sqlite",
  "thread_id": "test-parent",
  "dry_run": true
}
```

## Offline writes

For a disposable snapshot, or a database whose owning T3 server has been stopped,
start with `--allow-offline-writes`, then pass `dry_run: false` and
`offline_confirmed: true`. The caller must establish that the database is offline;
the flag does not detect or stop T3. Use T3's official interface for live sessions.

Updates mark the selected projection rows and append local database event records
in one transaction. This is **not an official T3 API call**, does not broadcast to
a live UI, does not stop agents and does not physically erase conversation data.
Provider-native sessions, artifacts, scratch directories and worktrees are preserved.
A preview reports `parentDeleted: false`; successful writes report
`updated_offline_database`, not physical deletion.

The SQL targets the schema exercised in `tests/test_cleaner.py`; compatibility
with arbitrary T3 releases, side-chat relationships and cross-device families is
not established. Descendants use lineage, delegatedFrom and subagent records.
The tools do not patch the T3 UI delete button or clean remote machines implicitly.

## Development

```sh
npm test
python3 server.py --help
```

Tests use temporary synthetic databases and never open the user's T3 database.

## License

MIT
