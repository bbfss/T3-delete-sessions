---
name: deletechilds
description: 显式 /deletechilds 或 $deletechilds 清理当前会话的全部已核实后代，先核验所有远端删除成功再清本地，当前会话保留。支持T3跨环境委派树。
---

# 删除会话后代

只有用户实际发送 `/deletechilds`、`$deletechilds`（T3 斜杠菜单选择 Skill 后自动插入 `$deletechilds`）或对应 Skill 才执行。讨论、引用、自动登记不授权删除。不再调用旧的 `t3-clean-sessions --current`。

使用 T3-delete-sessions 1.8.0+（纯 Node.js 零外部依赖）。若当前会话无跨设备远端后代（本机 `session-family-cleanup` 无远端登记且未发起过远端委派），直接走单机快路径：用 `t3_thread_list` 核实真实 `currentThreadId`，调用 `inspect_target` 与 `delete_subsessions(target_host=..., db_path=..., thread_id=currentThreadId, dry_run=true -> false)` 秒级完成（当前根会话保留）。若未挂载 MCP，可在目标机器以单次工具模式调用：

```sh
npx -y github:bbfss/T3-delete-sessions --auto-local --call inspect_target --arguments-file request.json
```

request.json 为对应工具参数对象；inspect_target 使用 `{}`。其他工具同理替换 --call。不把其他设备的路径或凭据复制到本机。仅需 Node.js（>=22.12）及本机官方 t3 CLI（无需 Python 或第三方 npm 依赖）；自定义T3目录用明确的--db、--t3-url、--t3-cli代替--auto-local。

## 跨设备固定目标与计划（存在远端后代时）

1. 复用 archivesessions 的会话族登记。用宿主/T3工具核实当前真实 environmentId、threadId；补齐每个后代的直属parentNodeId及所属T3端点。不依据标题、最近活动、cwd猜ID。通过 `t3_environment_links` 核实远端可达性；回读目标会话和委派记录，不能仅凭登记文件就删除。
2. 当前会话是锚点且永久保留。协调者、正在执行的远端清理worker及其端点均排除。缺失身份或关系时先补查，不能把未知分支当成没有后代。
3. 调用 `plan_cross_device_cleanup`，参数 registry（含nodes）、anchor_node_id、current_environment_id、current_thread_id。将返回plan保存到独立状态目录。每次节点是 `(environment_id, thread_id)`，同名ID在不同设备不等同。
4. **先远程，全部核验成功再本地。** 返回的steps先按后序处理所有remote，再处理local。远端又委派回本地的顺序冲突会拒绝生成计划，报告具体分支并保留；不能自行换序。

## 执行与回执

5. 对正在运行的委派任务，由它的原创建者用官方task_cancel精确取消；当前会话所属taskId永不取消。保留已完成结果。其他Agent不能冒用创建者身份；权限不足就报告该分支受阻。不得启动新的目标任务。
6. 当前Agent直接执行本地步骤。远端使用已有目标环境工具；需要远端执行者时，按resource-aware-execution进行轻量资源检查，并通过T3 delegate_task派一个**独立的清理worker**到所属环境。worker不是删除目标；登记为cleanup_worker并从计划中排除。远端worker收到固定plan、当前批次node_id、已验证receipts、自己的真实worker_thread_id、回传通道。只处理该环境步骤，不再派生Agent，不改目标范围，不执行--current。遵循delegate_task返回的等待规则。
7. worker先调用inspect_target核实environment_id。对计划的每个步骤调用execute_cleanup_step：plan、node_id、receipts、worker_thread_id、dry_run=true。核实ready后，在原命令授权下改dry_run=false执行，无需再次询问用户。插件只向本机所属环境发送官方停止/删除命令，并阻止删除协调者和worker；仍有本地活后代时拒绝删除父节点。
8. worker回传完整JSON回执；协调者在所属环境用官方读接口核验。只有deleted/already_deleted且环境、会话、node_id一致的回执才计为完成。保存实际回执，不能自己补写成功。远端全部成功之前禁止开始任何本地删除；failed/blocked/unverified/离线保留为pending，相关父入口保留。
9. 原始plan与receipts保存在会话历史之外，便于重试。已删节点再次查询可返回already_deleted。清理worker保持可用并回报，不自删；需要清理worker时另一次显式调用处理。

报告各设备成功/受阻数量。在线删除同时核验三层（T3 会话记录、底层原生会话、独占 T3 scratch 目录），外部用户项目与 Git worktree 始终保留。只核验配置不能算执行成功。

## 会话工作目录与原生会话物理清理（3 层全覆盖）

使用 `T3-delete-sessions` 1.8.0+（纯 Node.js 零外部依赖，跨 macOS / Windows / Linux 通用）。每次在线删除在确认 T3 `deleted_at` 后自动清理并核验：
- **Codex / ChatGPT（`codex`）**：官方 `codex app-server --stdio` `thread/delete`（含 `active writer` 归档释放与退避重试）+ `thread/read`、`state_*.sqlite` 及 `sessions/`、`archived_sessions/` rollout 文件双核验，确保 ChatGPT 客户端侧栏不再残留。
- **Claude Code（`claude` / `claudeAgent`）**：零依赖精确清理 `<UUID>.jsonl`、`<UUID>/`（含子 Agent）、`session-env/<UUID>`、`file-history/<UUID>` 及空 scratch 项目目录，保留普通项目的 `memory/`。
- **Antigravity（`antigravity`）**：清理 `<userdata>/providers/antigravity/*/antigravity-acp/` 下的 `conversations/<ID>.*`、`brain/<ID>/` 及递归 `INVOKE_SUBAGENT` 子会话。
- **独占 `scratch/` 目录**：物理移除无存活会话共用的 `<t3-home>/scratch/<dir>`（含隐藏目录），共享目录报告 `retained_shared`，外部项目与 Git worktree 保留。

原生端必须返回 `native.complete=true` 方计为 `completed`；`incomplete_native`、`failed`、`blocked`、`unsupported`、`unverified` 不计入远端成功门禁，且可用 `delete_native_sessions` 对同一精确 `thread_id` 补清。
