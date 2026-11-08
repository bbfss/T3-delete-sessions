# T3-delete-sessions

MCP tools to inspect T3 session families and clean them through a running T3 server or maintain an offline database.
Runs natively in Node.js (`>= 22.12`, built-in `node:sqlite` + built-in HTTP/WebSocket) with **zero Python or third-party npm dependencies**.

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
- `schedule_delete_family`: spawns an OS-detached background worker (`Win32_Process.Create` on Windows, detached `setsid` + `SIGHUP` ignore on macOS/Linux) that waits `delay_ms` (default `1500ms`) and executes online `delete_family(..., keep_parent: false)`, writing a verified external JSON receipt so `/deletefamily` (`$deletefamily`) finishes in seconds without killing its own MCP call mid-flight.
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

Requires only Node.js (`>= 22.12`) and the official T3 CLI on the MCP host (`t3` or Windows `t3.cmd`) — no Python runtime or external npm packages are required. The database
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

The SQL targets the schema exercised in `tests/test_cleaner.mjs`; compatibility
with arbitrary T3 releases, side-chat relationships and cross-device families is
not established. Online parent/child/grandchild cleanup was verified on T3 0.1.7. Descendants use lineage, delegatedFrom and subagent records.
The tools do not patch the T3 UI delete button or clean remote machines implicitly.

## Development

```sh
npm test
node ./bin/cli.js --help
```

Tests use temporary synthetic databases and never open the user's T3 database.

## License

MIT

## Cross-device cleanup

Version 1.3 adds `plan_cross_device_cleanup` and `execute_cleanup_step`.
The slash skills in `skills/` coordinate T3 delegates on the owning machines;
the MCP does not silently forward local calls to another host.

`plan_cross_device_cleanup` takes the verified session registry (`nodes`, each
with `nodeId`, `parentNodeId` and `t3.environmentId/threadId`), the current
`anchor_node_id`, `current_environment_id` and `current_thread_id`. It excludes
the current thread and orders every remote endpoint before local endpoints.
A remote-to-local nesting that conflicts with this order is rejected.

Each owning environment executes one step with `execute_cleanup_step`, passing
the plan, `node_id`, actual success `receipts`, its `worker_thread_id`, and
`dry_run`. Receipts are trusted orchestration inputs: the coordinator must verify
and persist the worker's results, never manufacture a success receipt. The tool
checks environment identity against T3's environment-id file, protects the
coordinator/worker, and requires success receipts for **all** remote steps
before a local deletion can proceed. Failure, offline state or missing receipts
leaves local deletion blocked. Live local descendants also block their parent's
deletion, so the registry must be complete and refreshed when needed.

For an agent running on the owning host, `--auto-local` reads that host's running
T3 metadata from `T3CODE_HOME` or `~/.t3`. It infers no thread IDs. This avoids
copying Mac paths to Windows/Linux. A tool can also run once without reconnecting MCP:

```sh
npx -y github:bbfss/T3-delete-sessions --auto-local --call inspect_target --arguments-file inspect.json
```

`inspect.json` contains `{}`. Use the appropriate tool name and argument file for
planning/execution. Only Node.js (`>= 22.12`) and the local T3 CLI are required on each worker (no Python or third-party npm dependencies).
Existing T3 links and authorization are required for delegated workers. The
current thread stays available to collect outcomes and retry blocked branches.

### Slash & `$` skill command scope

Both `/command` and `$command` triggers are supported (selecting a skill from T3 Code's `/` composer menu inserts `$<skill-name>` such as `$deletefamily`):

- `/deletechilds` (`$deletechilds`): preserves the invoking thread and deletes verified descendants.
- `/deletefamily` (`$deletefamily`): includes the invoking thread as the final target. For single-environment sessions without remote descendants, `schedule_delete_family` completes the detached self-deletion handoff in seconds and writes a verified receipt under `~/.local/state/session-family-cleanup/self-delete/` (or `%LOCALAPPDATA%\session-family-cleanup\self-delete\` on Windows). When remote descendants exist, all remote steps must succeed before local/root deletion.
- `/deletefathers` (`$deletefathers`): preserves the invoking thread and all of its descendants, and removes every ancestor and the other branches of that same family (`scope: "preserve_current_subtree"`).
- `/deleteorphans` (`$deleteorphans`): previews and cleans verified local orphan trees.

`/deletesessions` and `/deletesubsessions` are removed slash commands, not aliases. MCP tool names remain stable.

## T3 Code + Antigravity (`GEMINI_HOME` Isolation & Magpie Sync)

Unlike Codex (`~/.codex`) and Claude (`~/.claude`), **T3 Code intentionally isolates Antigravity into a per-instance `GEMINI_HOME` directory**:

- Default instance path: `~/.t3/userdata/providers/antigravity/ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32/` (`SHA-256("antigravity")`; on Windows under `%USERPROFILE%\.t3\userdata\providers\antigravity\...`).
- **Why T3 isolates `GEMINI_HOME`**:
  1. Allows multiple Antigravity provider instances/accounts in T3 without overwriting `~/.gemini` login state;
  2. Forces headless file-based OAuth storage (`AGY_ACP_FORCE_FILE_STORAGE=1`) and intercepts browser auth URLs for remote/daemon T3 hosts;
  3. Strips conflicting host environment variables (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT`, etc.);
  4. Leaves `<isolated-dir>/config/mcp_config.json` and `GEMINI.md` unlinked by default so lightweight internal helper calls do not spawn external MCP servers.

If you manage shared instructions, skills, and MCP servers with **Magpie** (which syncs `agy` to `~/.gemini/config/`), three separate adjustments are needed so T3 Antigravity sessions recognize both MCP tools and `$skill` / `/skill` commands:

1. **Switch Magpie `agy` skills from `link` to `copy`** (fixes Antigravity `view_file` symlink sandbox `Access denied` when `realpath` points into `~/.config/magpie/library/skills`):
   ```sh
   # On headless Linux/VPS without standalone Antigravity CLI, create the marker file first so Magpie detects `agy`:
   mkdir -p ~/.gemini/antigravity-cli && [ -f ~/.gemini/antigravity-cli/settings.json ] || echo '{}' > ~/.gemini/antigravity-cli/settings.json

   magpie library skill how copy agy
   magpie library sync
   ```
2. **Link `skills`, `GEMINI.md` (shared instructions), and `mcp_config.json` into T3's isolated Antigravity profile**:
   - **macOS / Linux**:
     ```sh
     AGY_T3_CFG="$HOME/.t3/userdata/providers/antigravity/ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32/config"
     mkdir -p "$AGY_T3_CFG"
     ln -sfn "$HOME/.gemini/config/skills" "$AGY_T3_CFG/skills"
     ln -sfn "$HOME/.gemini/config/GEMINI.md" "$AGY_T3_CFG/GEMINI.md"
     ln -sfn "$HOME/.gemini/config/mcp_config.json" "$AGY_T3_CFG/mcp_config.json"
     ```
   - **Windows (PowerShell)**:
     ```powershell
     $cfg = "$env:USERPROFILE\.t3\userdata\providers\antigravity\ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32\config"
     New-Item -ItemType Directory -Force -Path $cfg | Out-Null
     if (-not (Test-Path "$cfg\skills")) {
       New-Item -ItemType Junction -Path "$cfg\skills" -Target "$env:USERPROFILE\.gemini\config\skills" | Out-Null
     }
     cmd /c mklink "$cfg\GEMINI.md" "$env:USERPROFILE\.gemini\config\GEMINI.md"
     cmd /c mklink "$cfg\mcp_config.json" "$env:USERPROFILE\.gemini\config\mcp_config.json"
     ```
   *(Note: On Windows without Developer Mode / Administrator file-symlink privileges, `New-Item -ItemType HardLink` can be used for `GEMINI.md` and `mcp_config.json`, or leave `mcp_config.json` unlinked so skills invoke `npx -y github:bbfss/T3-delete-sessions --auto-local --call ...` directly. In T3 `0.1.7`, linking a non-empty `mcp_config.json` sets `supportsTextGeneration: false` on the Antigravity provider so T3 falls back to Codex/Claude for background thread-title generation while normal Antigravity chat sessions load all Magpie MCP servers.)*
3. **Ensure `$<skill-name>` is recognized alongside `/<skill-name>`**:
   Selecting a skill from T3 Code's `/` menu inserts `$<skill-name>` (Codex syntax). Codex auto-expands `$<skill-name>`, whereas Antigravity passes the literal text `$<skill-name>` to the model. Keep `$<skill-name>` in skill descriptions (included in `skills/*/SKILL.md` in `1.6.0+`) and in shared `GEMINI.md` instructions so Antigravity immediately loads the matching `SKILL.md`.

