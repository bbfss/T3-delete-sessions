---
name: archiveorphans
description: 显式 /archiveorphans 或 $archiveorphans 预览并可恢复归档本机及跨设备已核实的孤儿会话，并在专用清理会话结束时自动脱离归档当前会话；不把存活远端父节点当作本地缺失父节点。
---

用户实际发送 `/archiveorphans` 或 `$archiveorphans` 时执行（使用 `T3-delete-sessions` `1.9.4+`，严禁调用删除接口或旧 `t3-clean-sessions --orphans`）：

1. **确认本机与跨机环境**：调用 `inspect_target` 确认本机 `hostname`、`db_path` 与 `environment_id`，用 `t3_thread_list(allProjects=true, limit=10)` 确认当前 `currentThreadId`，并用 `t3_environment_links` 检查远端环境可达性。
2. **预览并双向核验跨设备候选**：调用 `archive_orphans(target_host=..., db_path=..., dry_run=true)`：
   - `orphans`：本机父会话缺失/已删且尚未归档的本地孤儿（自动排除本轮协调者与远端委派会话）。
   - `outboundRemoteOrphanCandidates`：本机已删父会话遗留的跨机 `remoteChild` 候选。先在可达远端环境用 `t3_thread_list(environmentId=..., allProjects=true, limit=100)` 过滤出**当前仍存活且未归档**的远端会话（忽略历史已删/已归档记录；离线远端如实报告受阻）。
   - `inboundRemoteDelegatedCandidates`：本机上由远端委派创建的未归档会话。仅当所属远端环境可达且通过 `t3_thread_list` / `t3_thread_read` 核实远端父会话确已删除时，才将其加入 `verified_remote_orphan_thread_ids`（远端父存活或离线的一律保留）。
3. **先远端归档成功再本地归档孤儿**：
   - 若存在核实存活未归档的远端孤儿目标，调用 `plan_cross_device_cleanup(db_path=..., current_environment_id=..., current_thread_id=currentThreadId, remote_targets=[...], scope="descendants_only", action="archive")`，按 [archivechilds](../archivechilds/SKILL.md) 派远端 `cleanup_worker` 执行 `execute_cleanup_step(..., dry_run=true -> false)` 并保存 `receipts`（完成后 `workerSelfCleanup` 会在回合 `idle` 且等待 `post_settle_delay_ms=4500` 后自动归档临时 worker 自身）。
   - 远端全部核验归档后（或单机无远端目标时），调用 `archive_orphans(target_host=..., db_path=..., verified_remote_orphan_thread_ids=..., dry_run=false)` 完成本地孤儿可恢复归档。
4. **最后一步：自动把当前专用清理会话自身也归档（`schedule_archive_family`）**：
   - 当全部孤儿均已归档且无受阻项，并且当前会话是专门用于清理孤儿而新建/发起的会话（此前无其他未完结业务开发对话）时，紧接着调用 `schedule_archive_family(target_host=..., db_path=..., thread_id=currentThreadId, remote_receipts=receipts, delay_ms=1500, dry_run=false)`，一句话汇报归档汇总与 `receipt_path` 后立刻结束回复（若当前会话原本是正在干活的业务主会话或存在远端受阻项，则保留当前会话）。
