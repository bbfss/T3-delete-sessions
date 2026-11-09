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

- `inspect_target`: returns hostname, resolved database path, `environment_id`, and write mode.
- `delete_subsessions` / `archive_subsessions`: selects descendants of an explicit thread ID, preserving the parent (`keep_parent: true`).
- `delete_family` / `archive_family`: selects descendants and the parent itself by default (`keep_parent: false`; pass `keep_parent: true` to retain the parent).
- `schedule_delete_family` / `schedule_archive_family`: spawns an OS-detached background worker (`Win32_Process.Create` on Windows, detached `setsid` + `SIGHUP` ignore on macOS/Linux) that waits `delay_ms` (default `1500ms`) and executes online `delete_family` / `archive_family` (`keep_parent: false`), writing a verified external JSON receipt so `/deletefamily` (`$deletefamily`) and `/archivefamily` (`$archivefamily`) finish in seconds without killing their own MCP call mid-flight.
- `delete_orphans` / `archive_orphans`: selects local orphan roots and their descendants while automatically excluding cross-device delegated sessions whose parent lives on another T3 environment (`delegatedFrom.environmentId != localEnvironmentId`).
- `delete_native_sessions`: deletes and verifies underlying native conversations (plus exclusive scratch directories if the T3 thread is already deleted) for an explicit T3 `thread_id`.

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

Use `--auto-local` on the target host (resolves `T3CODE_HOME` or `~/.t3` automatically across macOS, Windows, and Linux), or pass explicit `--db`, `--t3-url`, and `--t3-cli`.

To avoid older/buggy `npm` `GitFetcher requires an Arborist constructor to pack a tarball` errors on Linux VPS / Windows when `npx github:...` runs, you can use a zero-`npx` `node -e` git-cache launcher:

```json
{
  "mcpServers": {
    "t3-delete-sessions": {
      "command": "node",
      "args": [
        "-e",
        "const{spawn,execFileSync}=require('child_process'),fs=require('fs'),os=require('os'),p=require('path');const d=p.join(os.homedir(),'.cache','t3-delete-sessions'),c=p.join(d,'bin','cli.js'),u='https://github.com/bbfss/T3-delete-sessions.git';try{if(!fs.existsSync(c)){fs.mkdirSync(p.dirname(d),{recursive:true});execFileSync('git',['clone','--depth','1',u,d],{stdio:'ignore',timeout:20000});}else{execFileSync('git',['-C',d,'pull','--ff-only','--quiet'],{stdio:'ignore',timeout:8000});}}catch{}const k=spawn(process.execPath,[c,'--auto-local'],{stdio:'inherit',windowsHide:true});k.on('exit',e=>process.exit(e??1));"
      ]
    }
  }
}
```

Call `inspect_target`, preview the requested family, then pass `dry_run: false`
with the same explicit target. `delete_subsessions` preserves the parent;
`delete_family` deletes both descendants and parent by default (`keep_parent: false`).

Online deletion performs verified **3-layer physical cleanup**:
1. **T3 Layer**: Issues a short-lived bearer session via the local T3 CLI, dispatches official `thread.stop` + `thread.delete` (or `thread.archive`) commands over T3's WebSocket RPC, verifies `deleted_at` / `archived_at` in SQLite, and immediately revokes the temporary bearer session. Also sweeps previously soft-deleted (`deleted_at IS NOT NULL`) descendants whose native/scratch files were left behind.
2. **Native Harness Layer** (`action="delete"`): Maps each deleted T3 thread via `orchestration_v2_projection_provider_threads` (`nativeThreadRef`, protecting any conversation still shared with a live T3 thread):
   - **Codex / ChatGPT (`codex`)**: Collects recursive native subagent trees from `thread_spawn_edges` (`parent_thread_id -> child_thread_id`) before deleting edges, runs official `codex app-server --stdio` `thread/delete` (with `thread/archive` + retry backoff if T3 is still detaching its writer lock), and purges + verifies absence across `state_*.sqlite`, `sqlite/codex.db` (`local_thread_catalog`, `thread_timeline_ledger`, etc.), `session_index.jsonl`, `sessions/`, and `archived_sessions/`.
   - **Claude Code (`claude` / `claudeAgent`)**: Zero-dependency removal of `<UUID>.jsonl`, `<UUID>/` sidecars/subagents, `session-env/<UUID>`, `file-history/<UUID>`, and empty T3 scratch/worktree folders under `~/.claude/projects/`.
   - **Antigravity (`antigravity`)**: Removes `conversations/<ID>.*` and `brain/<ID>/` (including recursively discovered `INVOKE_SUBAGENT` child conversations while protecting retained IDs) across `<userdata>/providers/antigravity/*/antigravity-acp/`.
3. **Scratch & Isolated Worktree Layer** (`action="delete"`): Physically removes each deleted thread's exclusive `<t3-home>/scratch/<dir>` (including hidden files/directories). When a deleted session's exclusive directory contains `.git` or is an isolated Git worktree (`<t3-home>/worktrees/...` or linked worktree), `dry_run: true` surfaces `worktreeConfirmationsRequired` so the agent can ask the user for confirmation first, and removes it when `confirm_remove_git_worktrees: true` is passed (while strictly protecting main user project roots in `projection_projects` and shared directories).

Requires only Node.js (`>= 22.12`) and the official T3 CLI on the MCP host (`t3` or Windows `t3.cmd`) — no Python runtime or external npm packages are required.

## Offline writes

For a disposable snapshot, or a database whose owning T3 server has been stopped,
start with `--allow-offline-writes`, then pass `dry_run: false` and
`offline_confirmed: true`. The caller must establish that the database is offline;
the flag does not detect or stop T3. Use T3's official interface for live sessions.

Updates mark the selected projection rows and append local database event records
in one transaction. This is **not an official T3 API call**, does not broadcast to
a live UI, does not stop agents and does not physically erase conversation data.
Archive, preview and offline operations preserve files.
A preview reports `parentDeleted: false`; successful offline writes report
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

Version 1.9 automatically discovers remote delegated descendants (`remoteChild: { environmentId, threadId, label }`) directly from T3's `orchestration_v2_projection_subagents` table without requiring manual JSON registration files.
- `plan_cross_device_cleanup` can be called with `db_path` (omitting `registry`) to auto-build the `remote_then_local` plan directly from SQLite.
- `delete_subsessions`, `delete_family`, and `schedule_delete_family` automatically block local deletion (`status: "blocked_by_remote_descendants"`) if unconfirmed remote children exist, unless verified `remote_receipts` are supplied.
- On the remote target host, `execute_cleanup_step` autonomously expands and cleans any local subagents/descendants spawned under that remote session (`autoExpandedDescendants`) in post-order before deleting the remote session itself.

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

### Slash & `$` skill command scope (`t3-sessions-manager` suite)

All 9 skills live under `skills/` and group together in Magpie under **`t3-sessions-manager`** (`skillGroups` in `library.json`). Both `/command` and `$command` triggers are supported (`/` menu in T3 Code inserts `$<skill-name>`):

| Scope | Archive (recoverable via T3 Archive) | Delete (marks session deleted) |
|---|---|---|
| **Descendants only** (preserve current session) | `/archivechilds` (`$archivechilds`, legacy alias `/archivesessions`) | `/deletechilds` (`$deletechilds`) |
| **Entire current family** (descendants + current root session) | `/archivefamily` (`$archivefamily`, via `schedule_archive_family`) | `/deletefamily` (`$deletefamily`, via `schedule_delete_family`) |
| **Preserve current subtree**, prune all ancestors & sibling branches | `/archivefathers` (`$archivefathers`) | `/deletefathers` (`$deletefathers`) |
| **Verified orphan session trees** | `/archiveorphans` (`$archiveorphans`) | `/deleteorphans` (`$deleteorphans`) |

- `archivesessions`: automatic cross-provider / cross-device startup lineage registration (`session-family-cleanup/<familyId>/`); never archives or deletes on startup.
- `/deletesessions` and `/deletesubsessions` are removed slash commands, not aliases. MCP tools expose symmetric `archive_subsessions`, `archive_family`, `archive_orphans`, `schedule_archive_family` alongside `delete_subsessions`, `delete_family`, `delete_orphans`, `schedule_delete_family`, plus `action: "delete" | "archive"` on `plan_cross_device_cleanup`.

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


## Native deletion (development)

Online deletion now checks native conversation mappings and returns `incomplete_native` unless all native endpoints are verified deleted. Codex uses the official app-server deletion API; active writers remain a reported failure requiring release by the owning app. Claude uses the official Agent SDK to delete and verify local sessions. Antigravity per-conversation deletion is not implemented and returns `unsupported`. Provider cloud records are outside these local SDK guarantees. A T3 tombstone alone does not count as full deletion. `delete_native_sessions` retries native cleanup for an exact T3 thread, including one already deleted. Scratch cleanup waits for native verification. These changes are not yet released.
