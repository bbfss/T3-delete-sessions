---
name: deleteorphans
description: 显式 /deleteorphans 或 $deleteorphans 预览并清理指定T3环境中已核实的孤儿会话；不把远端父节点当作本地缺失父节点。
---

用户实际发送 `/deleteorphans` 或 `$deleteorphans` 时执行：先 `inspect_target` 确认环境，再预览 `delete_orphans`。核对每个候选的父节点环境：远端父会话、本轮协调者或执行worker、关系不明的候选必须排除。旧版扫描器只看本地父关系，不能对包含跨设备委派的环境直接全量执行。对可证明孤儿的目标，逐个核实本地家族及远端后代，按deletechilds的先远端成功再本地原则处理；有无法区分的候选时报告受阻。禁止调用旧t3-clean-sessions --orphans。

## 会话工作目录

使用 T3-delete-sessions 1.8.0+。所有在线删除入口在核实删除成功后，完整移除目标会话独占的 T3 scratch 一级目录（含隐藏文件及目录）。仍有未删除会话使用该目录或其子目录时保留并报告 retained_shared；外部项目、Git worktree、原生 provider 历史保留。归档、预览和离线快照不删除目录。跨设备在目录所属机器执行并在回执返回 scratchDirectories。
