---
name: archivechilds
description: 显式 /archivechilds 或 $archivechilds 可恢复归档当前会话的全部已核实后代，先核验所有远端归档成功再归档本地，当前会话保留。支持T3跨环境委派树。
---

# 归档会话后代（保留当前会话）

只有用户实际发送 `/archivechilds`、`$archivechilds`（或旧兼容别名 `/archivesessions`、`$archivesessions`）才执行。讨论、引用、自动启动登记不授权归档。本命令执行可恢复归档，严禁调用删除接口。

## 单机快路径（当前会话无跨设备远端后代）

1. 用 `t3_thread_list(allProjects=true, limit=10)` 核实真实 `currentThreadId`（不用 cwd 或标题猜测），并检查本机 `session-family-cleanup` 目录确认无远端跨设备后代。
2. 调用 `T3-delete-sessions`（1.7.0+）的 `inspect_target` 与 `archive_subsessions(target_host=..., db_path=..., thread_id=currentThreadId, dry_run=true)` 预览后，直接以 `dry_run=false` 执行（未挂 MCP 时通过 `npx -y github:bbfss/T3-delete-sessions --auto-local --call archive_subsessions --arguments-file -` 调用）。当前根会话始终保留。

## 跨设备路径（存在远端 T3 后代）

1. 复用 [archivesessions](../archivesessions/SKILL.md) 的会话族登记，用 T3 工具核实当前真实 `environmentId`、`threadId` 及每个后代节点与 `t3_environment_links` 可达性。当前会话、协调者及远端清理 worker 均加入保护集合。
2. 调用 `plan_cross_device_cleanup(registry, anchor_node_id, current_environment_id, current_thread_id, scope="descendants_only", action="archive")`，保存计划到独立状态目录。
3. **严格先远端后本地**：对正在运行的委派后代由原创建者用 `task_cancel` 定向取消（永不取消当前会话所属 `taskId`）。远端环境派独立 `cleanup_worker` 调用 `inspect_target` 与 `execute_cleanup_step(..., dry_run=true -> false)` 执行官方 `thread.stop` + `thread.archive`（也可对单节点用 `t3_thread_organize(action="archive")` 并核验 `archived: true`）。
4. 只有全部远端回执均为 `archived` / `already_archived` 且官方读接口核验一致后，才执行本地步骤。若有独立 Codex 原生子会话，在所属设备执行 `codex archive <完整UUID>`。远端失败/离线保留为 `pending`，报告各设备归档/受阻数量并说明可通过取消归档恢复。
