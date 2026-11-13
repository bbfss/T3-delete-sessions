---
name: deleteorphans
description: 显式 /deleteorphans 或 $deleteorphans 预览并清理本机及跨设备已核实的孤儿会话（含右键删除父会话遗留的远端子会话与本地原生残余）；绝不误删存活远端父节点的正常跨机委派会话。
---

用户实际发送 `/deleteorphans` 或 `$deleteorphans` 时执行（使用 `T3-delete-sessions` `1.9.3+`，严禁调用旧 `t3-clean-sessions --orphans`）：

## 标准执行流程（本机 + 跨设备双向孤儿核验）

1. **确认本机与跨机拓扑**：调用 `inspect_target` 获取本机 `hostname`、`db_path` 与 `environment_id`；调用 `t3_thread_list(allProjects=true, limit=10)` 确认当前协调会话 `currentThreadId`（加入保护集合），并调用 `t3_environment_links` 查看已连接远端设备及其可达状态。
2. **预览全部孤儿与跨机候选**：调用 `delete_orphans(target_host=..., db_path=..., dry_run=true)`，返回四类信息：
   - `orphans`：本机父会话已缺失/已删的本地孤儿（含 `orchestration_v2_projection_subagents.child_thread_id` 关联的本地子会话；自动排除远端父会话正常的跨机委派会话）。核实不含当前会话或活跃 worker。
   - `outboundRemoteOrphanCandidates`：本机父会话已被右键删除/缺失（或父会话本身为孤儿）所遗留的跨设备远端 `remoteChild` 候选。**关键去重规则**：SQLite `subagents` 表会永久保留历史 `remoteChild` 记录，必须先对每个可达远端环境调用 `t3_thread_list(environmentId=..., allProjects=true, limit=100)` 过滤，**仅保留远端当前仍存活的会话**作为真实远端孤儿目标（已删历史记录严禁重复派发 worker；不可达环境如实报告 `pending`）。
   - `inboundRemoteDelegatedCandidates`：本机上由远端设备委派创建的存活会话（`delegatedFrom.environmentId`）。对所属远端环境**可达**的候选，在远端用 `t3_thread_list` / `t3_thread_read` 核实其 `remoteParentThreadId`：**仅当确认远端父会话已删除/不存在时**，将该本机会话 ID 加入 `verified_remote_orphan_thread_ids`（远端父仍存活或远端离线时必须保留，绝不误删）。若 `verified_remote_orphan_thread_ids` 非空，再用 `delete_orphans(..., verified_remote_orphan_thread_ids=..., dry_run=true)` 复核预览（自动递归展开其本机后代与 `worktreeConfirmationsRequired`）。
   - `deletedOrphanParentIds`：本机曾右键删除但可能遗留底层原生会话或独占 `scratch/` 目录的已删父会话 ID。
3. **隔离 Git worktree 确认门禁**：若预览返回 `worktreeConfirmationsRequired` 非空（存在含 `.git` 或独立 Git worktree 的目录），**先向用户询问是否一并删除该目录**，按用户意愿设置 `confirm_remove_git_worktrees=true/false`。
4. **先远端后本地清理**：
   - 若存在第 2 步核实仍存活的远端孤儿目标（或本地孤儿派生的远端后代），调用 `plan_cross_device_cleanup(db_path=..., current_environment_id=..., current_thread_id=currentThreadId, remote_targets=[{ environment_id, thread_id, label, title }, ...], scope="descendants_only", action="delete")` 生成计划，按 [deletechilds](../deletechilds/SKILL.md) 向各目标远端环境派发单个独立 `cleanup_worker` 调用 `execute_cleanup_step`（`dry_run=true -> false`）。`v1.9.3+` 的 `workerSelfCleanup` 会在远端 worker 回合彻底转为 `idle` 后额外等待 `post_settle_delay_ms=4500` 再自删，确保父端 `delegate_task` 正常收回完成结果而不会报 `Thread ... is no longer available`。全部远端目标核验清零后再继续本地步骤。
   - 执行本地 `delete_orphans(target_host=..., db_path=..., verified_remote_orphan_thread_ids=..., clean_deleted_parent_residuals=true, confirm_remove_git_worktrees=..., dry_run=false)`（即使本地存活 `orphans` 为 0，只要存在 `deletedOrphanParentIds`，传 `clean_deleted_parent_residuals=true` 也会自动补清右键已删父会话遗留的本地原生会话与独占 `scratch/` 目录）。

## 三层物理清理与完成条件

`T3-delete-sessions` `1.9.3+` 在确认 T3 `deleted_at` 后自动清理并核验：
1. **T3 会话记录**：官方 `thread.stop` + `thread.delete` 并核验 `deleted_at`。
2. **原生客户端/本地会话文件**：自动清理并核验绑定的 Codex（含 `state_*.sqlite`、`sqlite/codex.db`、`session_index.jsonl`、`thread_spawn_edges` 子会话）、Claude Code、Antigravity（含子会话）本地记录；其他存活会话共享的原生会话自动保护为 `blocked`。
3. **独占 T3 `scratch/` 与经确认的隔离 Git worktree 目录**：物理移除无存活会话共用的 `<t3-home>/scratch/<dir>`（含隐藏目录），含 `.git` 或隔离 Git worktree 经用户确认后清理，共享目录与外部用户主工程目录保留。

如实分别报告各设备 T3、原生会话（`native.complete`）与 `scratchDirectories` 清理结果；若个别原生会话返回 `incomplete_native`，用 `delete_native_sessions` 针对该精确 `thread_id` 重试补清。
