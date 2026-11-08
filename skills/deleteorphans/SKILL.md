---
name: deleteorphans
description: 显式 /deleteorphans 预览并清理指定T3环境中已核实的孤儿会话；不把远端父节点当作本地缺失父节点。
---

先inspect_target确认环境，再预览delete_orphans。核对每个候选的父节点环境：远端父会话、本轮协调者或执行worker、关系不明的候选必须排除。旧版扫描器只看本地父关系，不能对包含跨设备委派的环境直接全量执行。对可证明孤儿的目标，逐个核实本地家族及远端后代，按deletesessions的先远端成功再本地原则处理；有无法区分的候选时报告受阻。禁止调用旧t3-clean-sessions --orphans。
