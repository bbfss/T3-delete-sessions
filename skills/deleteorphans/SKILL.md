---
name: deleteorphans
description: 显式 /deleteorphans 或 $deleteorphans 预览并清理指定T3环境中已核实的孤儿会话；不把远端父节点当作本地缺失父节点。
---

用户实际发送 `/deleteorphans` 或 `$deleteorphans` 时执行：先 `inspect_target` 确认本机 `hostname`、`db_path` 与 `environment_id`，再调用 `delete_orphans(dry_run=true)` 预览。`T3-delete-sessions` 1.8.0+ 已在底层扫描器自动比对本机 `environment-id`，**自动排除 `delegatedFrom.environmentId` 属于远端设备的跨机委派会话**，不会把远端父节点当作本地缺失父节点；同时执行前仍须核实候选不含当前会话或活跃清理 worker。若某个本地孤儿自身曾向远端设备发起过跨设备委派，先按 [deletechilds](../deletechilds/SKILL.md) 先远端成功再本地的原则清理其远端后代，最后执行 `delete_orphans(dry_run=false)`。禁止调用旧 `t3-clean-sessions --orphans`。

## 三层物理清理与完成条件

`T3-delete-sessions` 1.8.0+ 在确认 T3 `deleted_at` 后自动清理并核验：
1. **T3 会话记录**：官方 `thread.stop` + `thread.delete` 并核验 `deleted_at`。
2. **原生客户端/本地会话文件**：自动清理并核验绑定的 Codex（ChatGPT 客户端不再残留）、Claude Code、Antigravity（含子会话）本地记录；其他存活会话共享的原生会话自动保护为 `blocked`。
3. **独占 T3 `scratch/` 目录**：物理移除无存活会话共用的 `<t3-home>/scratch/<dir>`（含隐藏目录），共享目录与外部项目/Git worktree 保留。

如实分别报告 T3、原生会话（`native.complete`）与 `scratchDirectories` 清理结果；若个别原生会话返回 `incomplete_native`，可用 `delete_native_sessions` 针对该 `thread_id` 重试补清。
