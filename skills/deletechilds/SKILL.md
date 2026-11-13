---
name: deletechilds
description: 显式 /deletechilds 或 $deletechilds 清理当前会话的全部已核实后代，先核验所有远端删除成功再清本地，当前会话保留。支持T3跨环境委派树。
---

# 删除会话后代

只有用户实际发送 `/deletechilds`、`$deletechilds`（T3 斜杠菜单选择 Skill 后自动插入 `$deletechilds`）或对应 Skill 才执行。讨论、引用、自动登记不授权删除。不再调用旧的 `t3-clean-sessions --current`。

使用 T3-delete-sessions 1.9.0+（纯 Node.js 零外部依赖）。先用 `t3_thread_list` 核实真实 `currentThreadId`，调用 `inspect_target` 与 `delete_subsessions(target_host=..., db_path=..., thread_id=currentThreadId, dry_run=true)` 预览：
- **单机无远端后代**：若返回的 `remoteChildren` 为空（且无跨设备手动登记），检查 `worktreeConfirmationsRequired`：若存在含 `.git` 或独立 Git worktree 的目录，**先向用户询问是否确认一并删除该含 `.git` / worktree 目录**，根据用户意愿传入 `confirm_remove_git_worktrees=true/false`，调用 `delete_subsessions(..., dry_run=false)` 秒级完成（当前根会话保留）。
- **含跨设备远端后代**：`delete_subsessions` 会自动从 T3 SQLite（`orchestration_v2_projection_subagents` 的 `remoteChild`）提取全部远端委派子节点并在未提供 `remote_receipts` 时阻断本地删除（`blocked_by_remote_descendants`）。此时直接调用 `plan_cross_device_cleanup(db_path=..., current_environment_id=..., current_thread_id=currentThreadId)`（无需手写 `registry` JSON，自动从 SQLite 构建 `remote_then_local` 计划），先派远端 worker 清理并拿回 `receipts`，再执行本地删除。

若未挂载 MCP，可在目标机器通过 `~/.cache/t3-delete-sessions/bin/cli.js`（或零依赖 `node` 直接调用）执行单次工具模式：

```sh
node ~/.cache/t3-delete-sessions/bin/cli.js --auto-local --call inspect_target --arguments-file request.json
```

`request.json` 为对应工具参数对象；`inspect_target` 使用 `{}`。其他工具同理替换 `--call`。不把其他设备的路径或凭据复制到本机。仅需 Node.js（>=22.12）及本机官方 `t3` CLI（无需 Python 或第三方 npm 依赖，彻底规避旧版 npm `GitFetcher` 报错）；自定义 T3 目录用明确的 `--db`、`--t3-url`、`--t3-cli` 代替 `--auto-local`。

## 跨设备固定目标与计划（存在远端后代时）

1. 直接通过 T3 SQLite 自动发现远端委派后代（兼容可选的 `archivesessions` 手动登记）。用宿主/T3工具核实当前真实 `environmentId`、`threadId`，不依据标题、最近活动、cwd 猜 ID。通过 `t3_environment_links` 核实远端可达性。
2. 当前会话是锚点且永久保留。协调者、正在执行的远端清理 worker 及其端点均排除。
3. 调用 `plan_cross_device_cleanup`，传入 `db_path`、`current_environment_id`、`current_thread_id`（可省略 `registry`，工具自动从 SQLite 构建跨设备树；若有额外手动 `registry` 亦可一并传入）。将返回 `plan` 保存到独立状态目录。每个节点是 `(environment_id, thread_id)`，同名 ID 在不同设备不等同。
4. **先远程，全部核验成功再本地。** 返回的 `steps` 先按后序处理所有 `remote`，再处理 `local`。远端又委派回本地的顺序冲突会拒绝生成计划，报告具体分支并保留；不能自行换序。

## 执行与回执

5. 对正在运行的委派任务，由它的原创建者用官方 `task_cancel` 精确取消；当前会话所属 `taskId` 永不取消。保留已完成结果。其他 Agent 不能冒用创建者身份；权限不足就报告该分支受阻。不得启动新的目标任务。
6. 当前 Agent 直接执行本地步骤。远端使用已有目标环境工具；需要远端执行者时，按 `resource-aware-execution` 进行轻量资源检查，并通过 T3 `delegate_task` 派一个**独立的清理 worker** 到所属环境。worker 不是删除目标；登记为 `cleanup_worker` 并从计划中排除。**强制要求**：派发给远端 worker 的 prompt 中必须附带 `plan_cross_device_cleanup` 生成的完整 `plan` JSON 与目标 `node_id` 列表，并明确要求 worker 必须调用 `execute_cleanup_step`（禁止手写仅调 `delete_family` 却不清理 worker 自身的脚本）！远端 worker 收到固定 `plan`、当前批次 `node_id`、已验证 `receipts`，并在远端本机用 `t3_thread_list` 获取自己的真实 `worker_thread_id`（即 `currentThreadId`）。只处理该环境步骤，不再派生 Agent，不改目标范围，不执行 `--current`。遵循 `delegate_task` 返回的等待规则。
7. worker 先调用 `inspect_target` 核实 `environment_id`，并用 `t3_thread_list` 确认自身的真实 `worker_thread_id`。对计划的每个步骤依次调用 `execute_cleanup_step`：`plan`、`node_id`、累积的 `receipts`（每次将上一步回执推入 `receipts`）、`worker_thread_id`、`dry_run=true`。`execute_cleanup_step` 会在远端本机**自动递归展开并后序清理该远端会话派生的全部本地子 Agent/子会话（`autoExpandedDescendants`）**。若 `dry_run=true` 返回 `worktreeConfirmationsRequired` 非空，按用户授权传入 `confirm_remove_git_worktrees=true/false`，再改 `dry_run=false` 执行（`v1.9.3+` 在完成该环境最后一个步骤时会自动结合 `receipts` 与本机 SQLite `deleted_at` 双重判定，触发 `workerSelfCleanup` 独立后台进程：等待远端线程与 Provider 回合彻底转为 `idle` 后再额外等待 `post_settle_delay_ms=4500` 自删 `worker_thread_id`，避免父端收回 `delegate_task` 结果前抢跑报 `Thread ... is no longer available`；Windows 下若子进程退出瞬间暂锁空 `scratch/` 目录，会自动投递独立后台 reaper 延时重试彻底移除，不会卡死回执；若因任何原因未触发 `workerSelfCleanup`，worker 必须在返回回执前对自己调用 `schedule_delete_family(thread_id=worker_thread_id, delay_ms=2500, dry_run=false)` 自删，绝不能把自己留在远端列表里）。
8. worker 回传完整 JSON 回执并立即结束回合；协调者在所属环境用官方读接口核验。只有 `deleted` / `already_deleted` 且环境、会话、`node_id` 一致的回执才计为完成。保存实际回执，不能自己补写成功。远端全部成功之前禁止开始任何本地删除；`failed` / `blocked` / `unverified` / 离线保留为 `pending`，相关父入口保留。
9. 全部远端回执核验通过后，将远端成功回执数组传入本地 `delete_subsessions(..., remote_receipts=receipts, dry_run=false)`（或按 `plan` 继续 `execute_cleanup_step`）完成本地子会话清理。`execute_cleanup_step` 在完成该远端环境的最后一个步骤并生成回执后，已自动通过独立脱离后台进程（`workerSelfCleanup`）在回合彻底 `idle` 并等待 `4.5s` 缓冲后自删该临时 `cleanup_worker` 会话及其底层原生文件/`scratch` 目录（收到回执后请勿再向该已自删的 `cleanup_worker` 发送后续消息）。

报告各设备成功/受阻数量。在线删除同时核验三层（T3 会话记录、底层原生会话、独占 T3 `scratch/` 与经确认的隔离 worktree 目录），用户主工程目录始终保留。只核验配置不能算执行成功。

## 会话工作目录与原生会话物理清理（3 层全覆盖）

使用 `T3-delete-sessions` 1.9.3+（纯 Node.js 零外部依赖，跨 macOS / Windows / Linux 通用）。每次在线删除在确认 T3 `deleted_at` 后自动清理并核验（同时自动补扫历史已软删但残留磁盘文件的子会话）：
- **Codex / ChatGPT（`codex`）**：削除前先从 `thread_spawn_edges` 递归收集全部 Codex 原生派生子会话，调用官方 `codex app-server --stdio` `thread/delete`（含 `active writer` 归档释放与退避重试），并同步清理与双重核验 `state_*.sqlite`、`sqlite/codex.db`（`local_thread_catalog`、`thread_timeline_ledger` 等全部目录表）、`session_index.jsonl` 及 `sessions/`、`archived_sessions/` rollout 文件，确保 ChatGPT/Codex 客户端侧栏彻底无残留。
- **Claude Code（`claude` / `claudeAgent`）**：零依赖精确清理 `<UUID>.jsonl`、`<UUID>/`（含子 Agent）、`session-env/<UUID>`、`file-history/<UUID>` 及空 scratch/worktree 项目目录，保留普通项目的 `memory/`。
- **Antigravity（`antigravity`）**：清理 `<userdata>/providers/antigravity/*/antigravity-acp/` 下的 `conversations/<ID>.*`、`brain/<ID>/` 及递归 `INVOKE_SUBAGENT` 子会话（同时严格保护保留会话 ID）。
- **独占 `scratch/` 与隔离 Git worktree 目录**：自动物理移除无存活会话共用的 `<t3-home>/scratch/<dir>`（含隐藏目录）；遇到含 `.git` 的目录或会话专属隔离 Git worktree（`<t3-home>/worktrees/...` 等）时，在 `dry_run=true` 返回 `worktreeConfirmationsRequired`，**先向用户询问确认**，用户同意后传 `confirm_remove_git_worktrees=true` 一并清理；用户主工程仓库根目录（`projection_projects`）与共享目录始终严格保护。

原生端必须返回 `native.complete=true` 方计为 `completed`；`incomplete_native`、`failed`、`blocked`、`unsupported`、`unverified` 不计入远端成功门禁，且可用 `delete_native_sessions` 对同一精确 `thread_id` 补清。
