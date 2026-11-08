# T3-delete-sessions

MCP tools to inspect T3 session families and clean them through a running T3 server or maintain an offline database.
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

## Online cleanup (recommended)

Use the database and URL of the **same running T3 environment**:

```json
{
  "mcpServers": {
    "t3-delete-sessions": {
      "command": "npx",
      "args": ["-y", "github:bbfss/T3-delete-sessions", "--db", "/absolute/t3-base/userdata/statev2.sqlite", "--t3-url", "http://127.0.0.1:3773", "--t3-cli", "/absolute/path/to/t3"]
    }
  }
}
```

Call `inspect_target`, preview the requested family, then pass `dry_run: false`
with the same explicit target. `delete_subsessions` preserves the parent;
`delete_family` includes it only with `keep_parent: false`.

Online mode reads the family from the local database, obtains a five-minute
bearer session through the local T3 CLI for that database's base directory,
and sends official `thread.stop` and `thread.delete` (or `thread.archive`)
commands over T3's WebSocket RPC. It checks each selected thread's resulting
state. Tokens stay inside the command process. A failure may follow successful
earlier commands; inspect the family before retrying. This mode does not require
`offline_confirmed` or `--allow-offline-writes`.

Requires the official T3 CLI on the MCP host, Node.js and Python 3. The database
must be at `<base-dir>/userdata/statev2.sqlite`. The server URL must belong to
that base directory; a different environment will reject its bearer token.
The server remains running during cleanup. The UI delete button itself is not patched.

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
not established. Online parent/child/grandchild cleanup was verified on T3 0.1.7. Descendants use lineage, delegatedFrom and subagent records.
The tools do not patch the T3 UI delete button or clean remote machines implicitly.

## Development

```sh
npm test
python3 server.py --help
```

Tests use temporary synthetic databases and never open the user's T3 database.

## License

MIT
