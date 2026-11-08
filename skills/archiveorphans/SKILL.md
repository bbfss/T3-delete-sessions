---
name: archiveorphans
description: 显式 /archiveorphans 或 $archiveorphans 预览并可恢复归档指定T3环境中已核实的孤儿会话；不把远端父节点当作本地缺失父节点。
---

用户实际发送 `/archiveorphans` 或 `$archiveorphans` 时执行：先调用 `inspect_target` 确认本机环境，再调用 `archive_orphans`（或 `delete_orphans(archive_only=true)`）以 `dry_run=true` 预览候选。逐个核对候选的父节点环境：远端父会话、本轮协调者或执行 worker、关系不明的候选必须排除，不能对包含跨设备委派的环境盲目全量执行。对已核实确属孤儿的目标，按 `archivechilds` 先远端归档成功再本地归档的原则处理（单机无远端后代时以 `archive_orphans(..., dry_run=false)` 执行）；有无法区分的候选时如实报告受阻。严禁调用删除接口或旧 `t3-clean-sessions --orphans`。
