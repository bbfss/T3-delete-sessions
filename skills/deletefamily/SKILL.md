---
name: deletefamily
description: 显式 /deletefamily 或 $deletefamily 删除当前会话及其全部后代；单机无远端后代时直接通过 schedule_delete_family 秒级脱离自删，含远端后代时先核验远端全部删除成功再清本地与当前会话。
---

# 删除当前会话家族

用户实际发送 `/deletefamily`、`$deletefamily`（T3 斜杠菜单选择 Skill 后会自动插入 `$deletefamily`）或直接选择本 Skill 即授权删除**当前会话本身及其全部后代**。仅讨论命令、引用示例或询问原因不授权删除。此命令与保留当前会话的 `/deletechilds`（`$deletechilds`）不同。

## 极速快路径（99% 场景：当前会话无跨设备委派后代，数秒内完成）

禁止在此场景下读取其他 `SKILL.md`、禁止全量拉取其他远端设备的线程列表、禁止逐段翻阅当前会话长历史、禁止手写 `schtasks`/Python 临时脚本：

1. 用 T3 工具 `t3_thread_list(allProjects=true, limit=10)` 获取真实 `currentThreadId`（若返回 `currentThreadId` 为空，仅在当前环境精确核实本会话 `threadId`，绝不用 cwd 或标题盲猜）。
2. 检查本机状态目录（macOS/Linux `~/.local/state/session-family-cleanup/`，Windows `%LOCALAPPDATA%\session-family-cleanup\`）是否存在绑定当前 `threadId` 的跨设备登记，且当前会话未向远端设备发起过 `delegate_task` / `t3_thread_launch`。
3. 若无远端跨设备后代，直接调用 `T3-delete-sessions`（1.8.0+）内置的独立脱离自删工具 `schedule_delete_family`（自动同时清理本机子会话与当前根会话，Windows 走 WMI 独立进程脱离 Job Object，macOS/Linux 走独立 setsid 守护进程）：
   - **已挂载 `t3-delete-sessions` MCP**：先调 `inspect_target` 拿到 `hostname` 与 `db_path`，再直接调 `schedule_delete_family(target_host=..., db_path=..., thread_id=currentThreadId, delay_ms=1500, dry_run=false)`。
   - **未挂载该 MCP（如 T3 默认隔离下的 Antigravity）**：直接在终端执行单条 Node 命令（无需写临时脚本文件）：
     ```sh
     node -e 'const {execFileSync}=require("node:child_process");const run=(t,a)=>JSON.parse(execFileSync(process.platform==="win32"?"npx.cmd":"npx",["-y","github:bbfss/T3-delete-sessions","--auto-local","--call",t,"--arguments-file","-"],{input:JSON.stringify(a),encoding:"utf8",shell:process.platform==="win32"}));const info=run("inspect_target",{});console.log(JSON.stringify(run("schedule_delete_family",{target_host:info.hostname,db_path:info.db_path,thread_id:process.argv[1],delay_ms:1500,dry_run:false})));' "<真实currentThreadId>"
     ```
4. 拿到 `status: "scheduled_detached_delete"` 与 `receipt_path` 后，立即用一句话向用户输出外部回执路径并**立刻结束本轮回复**（1.5 秒后独立进程将自动执行官方 `thread.stop` + `thread.delete` 并写入核验回执）。

## 跨设备路径（仅当当前会话存在远端 T3 后代时）

1. 按相邻 [deletechilds](../deletechilds/SKILL.md) 生成并执行**后代阶段**计划：严格先远端后本地，所有远端后代均删除并核验成功后，再删除本地后代。远端离线、失败或未确认时停止后续删除，在当前会话报告阻碍并保留根以便重试，不得把部分完成报成整树已删。
2. 全部远端后代核验完毕后，对当前根会话调用上述 `schedule_delete_family(..., dry_run=false)`（内部固定 `keep_parent=false`，禁止退化为 `keep_parent=true` 或 `deletechilds`）。
3. 若独立脱离进程启动失败，如实报告“后代已完成，根节点最终删除交接受阻”。只处理本次会话家族；外部项目文件、worktree 与共享服务保留；原生聊天必须按下节删除并核验。

## 会话工作目录与原生会话物理清理（3 层全覆盖）

使用 `T3-delete-sessions` 1.8.0+（100% 纯 Node.js 零外部依赖，跨 macOS / Windows / Linux 通用，无任何单机路径耦合）。所有在线删除入口在核实 T3 `deleted_at` 后自动依次执行并分别核验三层清理：

1. **T3 会话层**：通过官方在线 WebSocket RPC 发送 `thread.stop` + `thread.delete`，并在 SQLite 中核验 `deleted_at` 非空（完成后立即吊销临时鉴权会话）。
2. **原生客户端/磁盘层（不再残留在 ChatGPT 等外部客户端）**：从 T3 官方 `orchestration_v2_projection_provider_threads` 的 `nativeThreadRef` 提取真实原生会话 ID（被其他存活 T3 会话共享时自动保护为 `blocked`，未创建独立原生会话的空会话记为 `no_native_session`）：
   - **Codex / ChatGPT 客户端（`codex`）**：自动解析跨平台 `codex` CLI（支持 Windows `.cmd`、Homebrew、`CODEX_HOME`），通过官方 `codex app-server --stdio` 执行 `thread/delete`（遇到 `active writer` 时自动归档释放并退避重试），最终同时核验 `thread/read` 查无此会话、`state_*.sqlite` 无残留行、`sessions/` 与 `archived_sessions/` 无残留 rollout 文件。
   - **Claude Code（`claude` / `claudeAgent`）**：零依赖精确删除对应 `<UUID>.jsonl`、`<UUID>/`（含子 Agent 记录）、`session-env/<UUID>`、`file-history/<UUID>`，并在 T3 独占 scratch 对应的 `~/.claude/projects/<encoded>` 无剩余会话时自动清理空目录，绝不误删普通工程目录的 `memory/`。
   - **Antigravity（`antigravity`）**：跨平台扫描 `<userdata>/providers/antigravity/*/antigravity-acp/`（及独立目录），递归提取 `INVOKE_SUBAGENT` 派生的子会话 ID，物理删除 `conversations/<ID>.*`（`.db` / `.db-wal` / `.db-shm` / `.meta`）与 `brain/<ID>/` 目录并核验清零。
3. **独占本地工作目录层（`scratch/`）**：完整物理删除已删会话独占的 `<t3-home>/scratch/<dir>`（含 `.agents`、`.gemini` 等隐藏目录）。仍有存活会话共用时保留并报告 `retained_shared`；含 `.git` 的仓库、外部用户工程目录与 Git worktree 一律保留。归档、预览与离线模式不删除物理文件。

必须以独立回执中的三层实际状态为准：`status="completed"` 表示 T3 + 原生会话核验完成（同时返回 `scratchDirectories` 明细）；若任一原生会话仍被外部窗口强占未释放，如实返回 `incomplete_native`，事后可对同一 `thread_id` 调用 `delete_native_sessions` 补清。
