---
name: deletefamily
description: 显式 /deletefamily 清理指定会话家族；跨设备先远端再本地，执行中的当前会话始终保留。
---

先执行相邻 [deletesessions](../deletesessions/SKILL.md) 的后代清理流程，固定远端全部成功后才本地。当前会话不能自删；要包含家族根，必须从该树之外的会话操作并明确目标环境与根ID，逐端点核实范围，所有远端回执成功且后代处理完毕后，再用所属环境的delete_family(thread_id=目标根,keep_parent=false,dry_run=false)。不得以--current猜目标，不得向本地插件传其他设备ID，不把本命令讨论当成执行授权。目标是当前会话时保留当前会话并说明保护结果，不派自毁worker。
