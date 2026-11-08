---
name: archivefathers
description: 显式 /archivefathers 或 $archivefathers 在整棵family中只保留当前节点为root的子树不归档，将其余全部祖先及旁支可恢复归档；跨设备先远端成功再本地。
---

# 只保留当前子树活跃（归档祖先与旁支）

只有用户实际发送 `/archivefathers`、`$archivefathers` 或直接选择本 Skill 才授权执行。目标范围是**最高祖先所辖的整棵 family，减去当前节点及其全部后代**：对所有祖先、兄弟/叔伯等旁支及它们的后代执行可恢复归档，不相关的 family 保持不动。当前节点已经是根时无归档目标。严禁调用删除接口。

1. 从当前节点向上核实直到最高祖先，并核实该 family 的所有分支；任何祖先缺失或跨设备归属未明时停止补查，不把缺失节点当作根。全部关系用真实 `environmentId`/`threadId` 和 `parentNodeId` 登记。
2. 调用 `T3-delete-sessions`（1.7.0+）的 `plan_cross_device_cleanup`，传完整 `registry`、当前 `anchor_node_id`、`current_environment_id`、`current_thread_id`、**`scope="preserve_current_subtree"`**、**`action="archive"`**。核对 `protected` 包含当前节点及其全部后代，`steps` 只含其补集。不得对祖先调用整树 `archive_family`。
3. 先远端后本地，按后序执行 `execute_cleanup_step` 并保存真实回执。当前子树的任何任务、provider 会话与执行 worker 均不得停止、取消或归档；对祖先执行器自动跳过递归 `thread.stop`，仅精确发送 `thread.archive`。
4. 归档祖先前，执行器自动核对仍未归档的本地后代只包含 `protected`。全部结束后核实当前节点与所有保留后代仍处于未归档活跃状态，报告归档与保留数量及受阻项（归档可在 T3 归档列表恢复，保留项目/worktree 与原生文件）。
