---
name: deletefathers
description: 显式 /deletefathers 在整棵family中只保留当前节点为root的子树，删除全部祖先及其余分支；跨设备先远端成功再本地。
---

# 只保留当前子树

只有用户实际发送 `/deletefathers` 或直接选择本 Skill 才授权执行。目标范围是**最高祖先所辖的整棵family，减去当前节点及其全部后代**。包括所有祖先、兄弟/叔伯等其他分支及它们的后代。不相关的family保持不动。当前节点已经是根时没有删除目标。

1. 复用 [deletechilds](../deletechilds/SKILL.md) 的身份核实、跨设备执行及回执机制，但本命令必须使用下面的范围。不得执行deletechilds的默认后代删除计划。
2. 从当前节点向上核实直到最高祖先，并核实该family的所有分支；任何祖先缺失或跨设备归属未明时停止补查，不把缺失节点当作根。全部关系用真实environmentId/threadId和parentNodeId登记。
3. 调用plan_cross_device_cleanup，传完整registry、当前anchor_node_id、current_environment_id、current_thread_id，**scope="preserve_current_subtree"**。核对protected包含当前节点及其全部后代；steps只含其补集。不得用delete_family对祖先整树删除。
4. 先远端后本地，各阶段按后序执行execute_cleanup_step并保存实际回执。当前子树的任何任务、provider会话与执行worker都不能停止、取消或删除。尤其不得对祖先调用递归task_cancel或普通thread.stop；祖先删除由新版执行器的精确thread.delete处理。
5. 删除祖先前，执行器检查仍存活的本地后代只包含protected。若保留分支是T3会级联删除的side chat，则父删除blocked：报告需要受支持的分离能力，保留相关祖先。不能修改SQLite伪造分离，不能绕过保护。新增后代或登记不全同样补查后再继续。
6. 每步核验被删目标和保留节点。全部结束后，核实当前节点与所有保留后代仍可由官方接口读取，并将独立会话族登记中的当前节点作为保留树根维护，保留原谱系的历史记录。插件不改写T3历史lineage字段；当前节点展示为根与其历史来源是两回事。

远端失败/离线/未确认时，不开始本地删除，在当前聊天返回原因。报告删除与保留数量及任何受阻祖先，不把部分完成说成family已裁剪完成。保留项目/worktree及原生provider文件。
