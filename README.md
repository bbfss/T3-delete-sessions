# T3-delete-sessions (v1.9.0)

**[简体中文](#-t3-delete-sessions-中文文档) | [English](#-t3-delete-sessions-english-documentation)**

---

# 🇨🇳 T3-delete-sessions 中文文档

用于 T3 Code 的**三层物理级联清理与跨设备会话族谱管理 MCP 插件 + Skills 套件**。  
原生运行于 Node.js（`>= 22.12`，基于内置 `node:sqlite` 与内置 HTTP/WebSocket），**零 Python 依赖、零第三方 npm 依赖**，跨平台支持 macOS、Windows 与 Linux。

---

## 1. 为什么我们要做这个插件？（官方 T3 Code 右键删除的四大痛点）

在日常使用 T3 Code 进行多 Agent 编排、跨 Provider（Codex / Claude Code / Antigravity）委派以及跨设备（Mac + Windows + Linux VPS）协同开发时，每一次任务都会派生出大量的**子会话（Subagents / Delegated Threads）**、**底层 Provider 原生对话存档**以及 **`~/.t3/scratch/` 临时工作目录**。

然而，我们对 T3 Code 官方自带的 **UI 右键删除（`thread.delete`）** 进行了源码与底层数据库取证，发现**单纯使用 T3 右键删除存在四大核心缺陷**：

1. **只做 UI 软删除，底层 Provider 原生数据 100% 残留在硬盘上**
   - T3 右键删除仅仅在 `~/.t3/userdata/statev2.sqlite` 的 `orchestration_v2_projection_threads` 表中给当前点击的那一条记录打上 `deleted_at` 时间戳（使其从 T3 左侧列表隐藏）。
   - 它**完全不会触碰**底层 Provider 的真实存储：
     - **Codex**：`~/.codex/state_5.sqlite`、`~/.codex/sqlite/codex.db`、`session_index.jsonl`、`~/.codex/sessions/**/*.jsonl` 原封不动残留；
     - **Claude Code**：`~/.claude/projects/` 下的 `.jsonl`、子 Agent 记录、`session-env`、`file-history` 原封不动残留；
     - **Antigravity**：`antigravity-acp/conversations/*.db` 与 `brain/<ID>/` 目录原封不动残留。
   - **真实取证数据**：在我们单台主力 Mac 的 `~/.t3/userdata/statev2.sqlite` 扫描中，过去通过 T3 右键删除的会话里，有 **155 个已删除会话** 的底层 Codex / Claude / Antigravity 原生数据库与 `.jsonl` 文件依然完整残留在硬盘上，导致在终端运行 `codex resume` 或 `claude -r` 时列表被大量死会话塞满。
2. **`~/.t3/scratch/` 临时工作目录永远不会被清理**
   - 派发子任务时 T3 自动创建的 `~/.t3/scratch/2026-...` 临时目录，在右键删除会话后**不会被删除**。
   - **真实取证数据**：在同一台 Mac 上，`~/.t3/scratch/` 下共有 **48 个临时目录**，其中 **42 个（高达 87.5%）** 所属的 T3 会话早已被右键删除，但目录与文件全部残留在磁盘上白白占用空间。
3. **本机子会话 / Subagent 完全不级联（父删子留变孤儿）**
   - 右键删除一个父会话时，T3 不会级联删除它派生的子会话（`lineage` / `delegatedFrom` / `subagents`）。父会话消失后，所有子会话的 `deleted_at` 依然为 `null`，直接变成无人认领的**孤儿会话（Orphans）**堆积在列表里。
4. **跨设备远端委派会话（VPS / 另一台电脑）完全失联**
   - 当你在本机将任务委派给远端 T3 环境（如 Linux VPS 或 Windows 主机）后，在本机右键删除父会话，远端机器上的子会话不仅不会被清理，甚至可能还在后台继续消耗 Token 运行。

### 现场 A/B 实测对比表：单纯 T3 右键删除 vs `T3-delete-sessions v1.9.0`

| 对比维度 | 单纯 T3 Code 右键删除 (`thread.delete`) | `T3-delete-sessions v1.9.0` 插件 + Skills |
| :--- | :--- | :--- |
| **1. T3 列表记录** | 仅对当前右键点击的 **1 个会话**打上 `deleted_at` 软删除标记 | 自动遍历整棵会话族谱树，按拓扑后序批量停止 (`thread.stop`) 并删除全部目标节点 |
| **2. 本机子会话 / Subagent 级联** | ❌ **不级联**（删父留子，产生孤儿会话） | ✅ **全自动级联**（同时追踪 `lineage`、`delegatedFrom`、`subagents` 三种关系） |
| **3. 跨设备远端委派会话** | ❌ **完全不管**（远端机器继续残留） | ✅ **跨设备门禁级联**（SQLite 自动发现远端节点，先核验远端 100% 清理成功回执，再放行本机清理） |
| **4. 底层 Provider 原生存储** | ❌ **0 清理**（Codex / Claude / Antigravity 数据 100% 残留） | ✅ **穿透物理抹除 + 逐项核验**（含 Codex 递归原生子 Agent 与 `codex.db` 账本，终端 `resume` 列表彻底干净） |
| **5. `~/.t3/scratch/` 临时目录** | ❌ **不清理**（87.5% 已删会话目录残留磁盘） | ✅ **自动识别排他目录并物理删除**（对含 `.git` 的真实 Worktree 自动弹窗确认，保护主工程目录） |
| **6. 误用右键删除后的兜底补救** | ❌ **一旦右键删掉，UI 消失但底层垃圾永久残留** | ✅ **顺手兜底扫尾 (`previouslyDeletedChildrenIds`)**：哪怕你先用右键删了子会话，只要在父会话跑一次 `/deletechilds` 或 `/deletefamily`，照样揪出已软删子会话并清光其底层原生文件与 `scratch` 目录 |

<details>
<summary><b>📊 点击展开：真实 A/B 现场实测日志（Codex 子会话对比验证）</b></summary>

```text
=== [1] 删除前初始状态 ===
T3 SQLite: { thread_id: 'thread:delegated-task:...', deleted_at: null }
Codex 底层存储: {
  inState5Sqlite: true,
  rolloutPath: '/Users/huangyongbin/.codex/sessions/2026/11/09/rollout-...-01a1c084-83b5-7bb2-b526-fa18ddb07326.jsonl',
  rolloutFileExists: true
}

=== [2] 阶段 A：模拟单纯 T3 右键删除 (仅派发 thread.stop + thread.delete) ===
T3 SQLite (仅设置软删除时间戳): {
  thread_id: 'thread:delegated-task:...',
  deleted_at: '2026-11-09T13:43:03.104Z'
}
Codex 底层存储 (完全未清理，100% 原封不动残留!): {
  inState5Sqlite: true,
  rolloutPath: '/Users/huangyongbin/.codex/sessions/2026/11/09/rollout-...-01a1c084-83b5-7bb2-b526-fa18ddb07326.jsonl',
  rolloutFileExists: true
}

=== [3] 阶段 B：执行 T3-delete-sessions v1.9.0 清理 ===
status: "completed"
verification: "Purged directly from local Codex SQLite (including codex.db), session_index.jsonl, and rollout dirs"
Codex 底层存储 (彻底归零!): {
  inState5Sqlite: false,
  rolloutPath: null,
  rolloutFileExists: false
}
```
</details>

---

## 2. 命令与技能详解（Slash `/` 与 `$` 命令体系）

本仓库内置 9 个技能（位于 `skills/`，在 Magpie 中归组为 **`t3-sessions-manager`**），同时支持 `/命令` 和 `$命令` 触发（在 T3 Code 输入框按 `/` 选择技能会自动插入 `$技能名`）。

我们将操作对称拆分为 **彻底物理删除（`delete*`）** 与 **可恢复归档（`archive*`）** 两大类、四种作用域：

### 🗑️ 彻底删除命令（三层物理抹除：T3 列表 + 底层原生对话 + Scratch 目录）

| 命令触发 | 作用范围 | 核心用途与适用场景 |
| :--- | :--- | :--- |
| **`/deletechilds`**<br>(`$deletechilds`) | **仅删全部后代，保留当前会话** | **最常用命令**。当你在主会话里派发了一堆本机/跨机子 Agent 完成了任务，想把所有子孙会话、底层垃圾和 `scratch` 目录彻底清干净，同时**继续留在当前主会话工作**时使用。 |
| **`/deletefamily`**<br>(`$deletefamily`) | **删除整棵家族（当前会话 + 全部后代）** | 当整个任务彻底结束，你想把**所有子孙会话连同当前主会话自己**一起彻底抹除时使用。单机无远端后代时通过 `schedule_delete_family` 派生操作系统级脱离后台进程，**1.5 秒内极速自删**且不会掐断当前 MCP 调用；含远端后代时先核验远端 100% 删干净再自删。 |
| **`/deletefathers`**<br>(`$deletefathers`) | **只保留当前子树，删除所有祖先与旁支** | 当你在某个深层子会话里得到了最终满意的结果，想**把当前子会话扶正保留**，而把上面冗长的老父会话、老祖先以及其它失败的兄弟分支全部删掉时使用。 |
| **`/deleteorphans`**<br>(`$deleteorphans`) | **扫描并清理本机孤儿会话树** | 专门清理过去因为你用“T3 右键删除父会话”而遗留在列表里的**无父孤儿会话及其后代**。内置跨设备防误判保护：绝不会把父节点在远端机器上的合法跨机委派会话误判为本机孤儿。 |

### 📦 可恢复归档命令（仅归档隐藏，保留底层文件可随时恢复）

| 命令触发 | 作用范围 | 核心用途与适用场景 |
| :--- | :--- | :--- |
| **`/archivechilds`**<br>(`$archivechilds`) | **仅归档全部后代，保留当前会话** | 将当前会话派生的所有本机/跨机子孙会话移入 T3 Archive 归档区（不删底层原生文件，可恢复），保持左侧列表清爽。（兼容旧别名 `/archivesessions`） |
| **`/archivefamily`**<br>(`$archivefamily`) | **归档整棵家族（当前会话 + 全部后代）** | 将所有后代连同当前会话一起移入归档区（通过 `schedule_archive_family` 秒级脱离归档）。 |
| **`/archivefathers`**<br>(`$archivefathers`) | **只保留当前子树不归档，归档所有祖先与旁支** | 只留当前节点及其子孙在活跃列表，将其余祖先和旁支全部移入归档区。 |
| **`/archiveorphans`**<br>(`$archiveorphans`) | **扫描并归档本机孤儿会话树** | 预览并将本机已核实的孤儿会话移入归档区。 |
| **`archivesessions`** | **族谱被动登记基座** | 跨设备/多层嵌套会话族谱规范基座（不会在启动时主动删除或归档任何会话）。 |

---

## 3. MCP 工具列表（11 个核心工具）

所有清理类工具默认均为 **`dry_run: true`（安全预览模式）**，绝不盲猜当前会话或主机，必须显式传入 `inspect_target` 返回的 `target_host` 与 `db_path`：

- `inspect_target`：读取当前机器的 `hostname`、解析后的 `db_path`、`environment_id` 以及运行模式。
- `delete_subsessions` / `archive_subsessions`：清理或归档指定 `thread_id` 的全部后代（强制保留父节点 `keep_parent: true`），同时自动清扫此前已被右键软删除的子节点残留（`previouslyDeletedChildrenIds`）。
- `delete_family` / `archive_family`：清理或归档指定 `thread_id` 及其全部后代（默认 `keep_parent: false`，也可传 `keep_parent: true`）。
- `schedule_delete_family` / `schedule_archive_family`：派生 OS 级脱离后台进程（Windows 使用 `Win32_Process.Create`，macOS/Linux 使用 `detached` + `SIGHUP` 忽略），等待 `delay_ms`（默认 `1500ms`）后执行全家族自删/自归档，并写入外部 JSON 核验回执。
- `delete_orphans` / `archive_orphans`：扫描并清理/归档本机孤儿会话树（自动排除 `delegatedFrom.environmentId != localEnvironmentId` 的跨机委派子节点）。
- `plan_cross_device_cleanup`：支持**零手工注册表自动规划**！只需传入 `current_thread_id`（无需手工传 `registry`），即可直接从 SQLite 自动提取本机与跨机远端委派节点（`remoteChild`），生成 `remote_then_local` 拓扑执行计划。
- `execute_cleanup_step`：在对应机器上执行跨设备清理计划中的单个节点。远端机器执行时会自动递归展开并清理该远端会话在当地派生的子孙节点（`autoExpandedDescendants`）；本机节点在未收到全部远端成功回执前强制阻断（`blocked_by_remote_descendants`）。
- `delete_native_sessions`：针对单个指定 T3 `thread_id`（包括已经被 T3 右键软删除的会话），物理抹除并核验其底层原生对话文件与排他 `scratch` 目录。

---

## 4. 三层物理清理架构详解

当执行在线删除（`action="delete"`, `dry_run=false`）时，插件严格按顺序执行并核验以下三层清理：

1. **第一层：T3 官方 RPC 层**
   - 通过本机 T3 CLI 签发短效 Bearer Token，经 T3 WebSocket RPC 发送官方 `thread.stop` + `thread.delete` 指令，并在 SQLite 中核验 `deleted_at` 时间戳落盘后立即吊销临时 Token。
2. **第二层：底层 Provider 原生存储层（逐项核验 `gone: true`）**
   - 通过 `orchestration_v2_projection_provider_threads` 精确映射 `nativeThreadRef`，并自动保护仍被其它存活 T3 会话共享的原生 ID（`protectedNativeIds`）：
   - **Codex (`codex`)**：在删除前先从 `thread_spawn_edges` 递归提取原生子 Agent 树；调用 `codex app-server --stdio` 执行 `thread/delete`（若遇到 T3 刚停止会话尚未释放写锁，自动回退直接清理本地 SQLite + 重试）；彻底清除并核验 `~/.codex/state_*.sqlite`（`threads`、`thread_spawn_edges` 等）、`~/.codex/sqlite/codex.db`（`local_thread_catalog`、`thread_timeline_ledger` 等）、`session_index.jsonl`、`sessions/` 与 `archived_sessions/`。
   - **Claude Code (`claude` / `claudeAgent`)**：零依赖清除 `~/.claude/projects/**/<UUID>.jsonl`、`<UUID>/` 子目录、`session-env/<UUID>`、`file-history/<UUID>` 以及空的临时工程目录。
   - **Antigravity (`antigravity`)**：递归解析 `INVOKE_SUBAGENT` 子对话，清除 `<userdata>/providers/antigravity/*/antigravity-acp/` 下的 `conversations/<ID>.*` 与 `brain/<ID>/`。
3. **第三层：`~/.t3/scratch/` 与隔离 Worktree 层**
   - 自动物理删除已删会话独占的 `<t3-home>/scratch/<dir>` 目录。
   - 若目录内含 `.git` 或属于隔离 Git Worktree，`dry_run: true` 会返回 `worktreeConfirmationsRequired` 提示用户确认，传入 `confirm_remove_git_worktrees: true` 后再执行清理；同时严格保护 `projection_projects` 中的用户主工程目录。

---

## 5. 安装与推荐 MCP 配置（跨平台零 `npx` 极速启动）

为了彻底规避部分 Linux VPS 或 Windows 环境因旧版 `npm` 在执行 `npx github:...` 时触发 `npm error GitFetcher requires an Arborist constructor to pack a tarball` 导致 MCP 启动失败的问题，强烈推荐使用以下**零 `npx` 的 `node -e` Git 缓存启动器**（自动克隆/更新至 `~/.cache/t3-delete-sessions` 并开启 `--auto-local`）：

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

也可以使用传统的 `npx` 方式：

```json
{
  "mcpServers": {
    "t3-delete-sessions": {
      "command": "npx",
      "args": ["-y", "github:bbfss/T3-delete-sessions", "--auto-local"]
    }
  }
}
```

---

# 🇺🇸 T3-delete-sessions (English Documentation)

**Verified 3-Layer Cascading Session Cleanup & Cross-Device Family Manager MCP + Skills Suite for T3 Code.**  
Runs natively in Node.js (`>= 22.12`, using built-in `node:sqlite` + built-in HTTP/WebSocket) with **zero Python or third-party npm dependencies** across macOS, Windows, and Linux.

---

## 1. Why We Built This Plugin (The 4 Core Limitations of T3 Code's Built-in Right-Click Delete)

When using T3 Code for multi-agent orchestration, cross-provider delegation (Codex / Claude Code / Antigravity), and cross-device workflows (Mac + Windows + Linux VPS), every task spawns **child sessions (subagents / delegated threads)**, **native provider conversation archives**, and **`~/.t3/scratch/` directories**.

By auditing T3 Code's source behavior and SQLite database (`~/.t3/userdata/statev2.sqlite`), we found **four major limitations when relying solely on T3 Code's built-in UI right-click Delete (`thread.delete`)**:

1. **UI Soft-Delete Only — 100% of Native Provider Storage Is Left Behind on Disk**
   - T3's right-click delete only sets a `deleted_at` timestamp on that single row in `orchestration_v2_projection_threads` inside `~/.t3/userdata/statev2.sqlite` to hide it from the T3 sidebar.
   - It **never cleans** the underlying provider storage:
     - **Codex**: `~/.codex/state_5.sqlite`, `~/.codex/sqlite/codex.db`, `session_index.jsonl`, and `~/.codex/sessions/**/*.jsonl` remain untouched;
     - **Claude Code**: `~/.claude/projects/**/<UUID>.jsonl`, subagent folders, `session-env`, and `file-history` remain untouched;
     - **Antigravity**: `antigravity-acp/conversations/*.db` and `brain/<ID>/` remain untouched.
   - **Real-world audit on our primary Mac**: **155 T3 sessions** that had already been deleted via T3's right-click UI still had their full native Codex / Claude / Antigravity databases and `.jsonl` files sitting on disk — polluting `codex resume` and `claude -r` session pickers.
2. **`~/.t3/scratch/` Temporary Directories Are Never Removed**
   - Temporary workspaces created under `~/.t3/scratch/2026-...` for delegated tasks are left on disk forever after right-click deleting their owning T3 threads.
   - **Real-world audit**: Out of **48 directories** in `~/.t3/scratch/` on our Mac, **42 (87.5%)** belonged to T3 threads that had already been right-click deleted.
3. **No Cascading to Child / Subagent Sessions (Creates Orphans)**
   - Right-click deleting a parent thread in T3 does not cascade to its spawned children (`lineage`, `delegatedFrom`, `subagents`). Once the parent is deleted, its children remain active (`deleted_at IS NULL`) as orphaned threads cluttering the sidebar.
4. **No Cross-Device Remote Delegation Cleanup**
   - If a parent thread delegated tasks to remote T3 environments (e.g., a Linux VPS or Windows workstation), right-click deleting the parent locally leaves the remote child sessions orphaned (and potentially still running) on the remote machines.

### Side-by-Side Comparison: Built-in T3 Right-Click Delete vs. `T3-delete-sessions v1.9.0`

| Dimension | Built-in T3 Right-Click Delete (`thread.delete`) | `T3-delete-sessions v1.9.0` Plugin + Skills |
| :--- | :--- | :--- |
| **1. T3 Sidebar / SQLite** | Soft-deletes (`deleted_at`) **only the 1 clicked row** | Traverses the entire session family tree and dispatches `thread.stop` + `thread.delete` in post-order |
| **2. Local Children & Subagents** | ❌ **Does not cascade** (leaves child sessions behind as orphans) | ✅ **Full automatic cascade** across `lineage`, `delegatedFrom`, and `subagents` links |
| **3. Cross-Device Remote Children** | ❌ **Ignored** (remote sessions remain on VPS / other hosts) | ✅ **Enforced Remote-Before-Local Gate** (auto-discovers remote children from SQLite, verifies 100% remote cleanup receipts before local cleanup) |
| **4. Native Provider Storage** | ❌ **0% cleaned** (Codex / Claude / Antigravity files remain on disk) | ✅ **Physical purge + per-endpoint verification** (including recursive Codex subagents & `codex.db` ledger) |
| **5. `~/.t3/scratch/` Directories** | ❌ **Never removed** (87.5% orphaned scratch dirs left on disk) | ✅ **Automatically removes exclusive scratch dirs** (with confirmation gates for `.git` worktrees and strict protection for main project roots) |
| **6. Recovery for Prior Right-Click Deletes** | ❌ **Once right-click deleted, native & scratch garbage is orphaned forever** | ✅ **Automatic sweep (`previouslyDeletedChildrenIds`)**: running `/deletechilds` or `/deletefamily` on a parent also sweeps previously right-click-deleted children and purges their leftover native & scratch files |

---

## 2. Slash `/` & `$` Skill Commands (`t3-sessions-manager` Suite)

All 9 skills live under `skills/` and group together in Magpie under **`t3-sessions-manager`** (`skillGroups` in `library.json`). Both `/command` and `$command` triggers are supported (selecting a skill from T3 Code's `/` menu inserts `$<skill-name>`):

| Scope | Delete (3-Layer Physical Wipe: T3 + Native + Scratch) | Archive (Recoverable via T3 Archive, preserves files) |
| :--- | :--- | :--- |
| **Descendants only** (preserve current session) | **`/deletechilds`** (`$deletechilds`) — Deletes all local & remote child/subagent sessions while keeping your current main session alive. | **`/archivechilds`** (`$archivechilds`, legacy alias `/archivesessions`) — Archives all descendants while keeping the current session. |
| **Entire current family** (descendants + current root session) | **`/deletefamily`** (`$deletefamily`) — Deletes all descendants **and** the current session itself (uses `schedule_delete_family` detached worker for instant self-deletion when no remote children exist). | **`/archivefamily`** (`$archivefamily`) — Archives all descendants and the current session via `schedule_archive_family`. |
| **Preserve current subtree**, prune all ancestors & sibling branches | **`/deletefathers`** (`$deletefathers`) — Keeps only the current node and its descendants, deleting all ancestors and sibling branches across devices. | **`/archivefathers`** (`$archivefathers`) — Keeps only the current subtree active, archiving all ancestors and sibling branches. |
| **Verified orphan session trees** | **`/deleteorphans`** (`$deleteorphans`) — Previews and deletes orphaned local session trees (never misclassifies cross-device delegated sessions whose parent lives on a remote T3 host). | **`/archiveorphans`** (`$archiveorphans`) — Previews and archives verified local orphan session trees. |

- **`archivesessions`**: Foundational cross-provider / cross-device family lineage specification; never archives or deletes on startup.

---

## 3. MCP Tools Overview

All cleanup tools default to **`dry_run: true` (safe preview)**. Always supply `target_host` and `db_path` exactly as returned by `inspect_target`:

- `inspect_target`: Returns `hostname`, resolved `db_path`, `environment_id`, and write mode.
- `delete_subsessions` / `archive_subsessions`: Selects all descendants of an explicit `thread_id`, preserving the parent (`keep_parent: true`), and sweeps any previously soft-deleted children (`previouslyDeletedChildrenIds`).
- `delete_family` / `archive_family`: Selects all descendants and the parent itself (`keep_parent: false` by default).
- `schedule_delete_family` / `schedule_archive_family`: Spawns an OS-detached background worker (`Win32_Process.Create` on Windows, detached `setsid` + `SIGHUP` ignore on macOS/Linux) that waits `delay_ms` (default `1500ms`) and executes online `delete_family` / `archive_family` (`keep_parent: false`), writing a verified external JSON receipt.
- `delete_orphans` / `archive_orphans`: Selects local orphan roots and their descendants while excluding cross-device delegated sessions (`delegatedFrom.environmentId != localEnvironmentId`).
- `plan_cross_device_cleanup`: Auto-builds a `remote_then_local` cleanup plan directly from SQLite when given `current_thread_id` (no manual JSON registry required), discovering `remoteChild` delegations from `orchestration_v2_projection_subagents`.
- `execute_cleanup_step`: Executes one node of a cross-device plan on its owning machine (autonomously expanding local descendants on remote workers via `autoExpandedDescendants`, and blocking local nodes until all remote receipts are verified).
- `delete_native_sessions`: Deletes and verifies underlying native conversations and exclusive scratch directories for an explicit T3 `thread_id` (including threads already soft-deleted via T3's UI).

---

## 4. T3 Code + Antigravity (`GEMINI_HOME` Isolation & Magpie Sync)

Unlike Codex (`~/.codex`) and Claude (`~/.claude`), **T3 Code isolates Antigravity into a per-instance `GEMINI_HOME` directory**:
- Default instance path: `~/.t3/userdata/providers/antigravity/ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32/` (Windows: `%USERPROFILE%\.t3\userdata\providers\antigravity\...`).

If you manage shared instructions, skills, and MCP servers with **Magpie** (which syncs `agy` to `~/.gemini/config/`), apply these three steps so T3 Antigravity sessions load both MCP tools and `$skill` / `/skill` commands:

1. **Switch Magpie `agy` skills from `link` to `copy`** (prevents Antigravity `view_file` symlink sandbox `Access denied` errors):
   ```sh
   mkdir -p ~/.gemini/antigravity-cli && [ -f ~/.gemini/antigravity-cli/settings.json ] || echo '{}' > ~/.gemini/antigravity-cli/settings.json
   magpie library skill how copy agy
   magpie library sync
   ```
2. **Link `skills`, `GEMINI.md`, and `mcp_config.json` into T3's isolated Antigravity profile**:
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
     Copy-Item "$env:USERPROFILE\.gemini\config\GEMINI.md" "$cfg\GEMINI.md" -Force
     Copy-Item "$env:USERPROFILE\.gemini\config\mcp_config.json" "$cfg\mcp_config.json" -Force
     ```
3. **Keep `$<skill-name>` in skill descriptions and `GEMINI.md` instructions** so Antigravity immediately loads the matching `SKILL.md` when T3 Code's `/` menu inserts `$<skill-name>`.

---

## Development & Testing

```sh
npm test
node ./bin/cli.js --help
```

Tests run against temporary synthetic SQLite databases and never touch your live T3 database.

## License

MIT
