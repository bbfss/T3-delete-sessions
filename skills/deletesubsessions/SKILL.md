---
name: deletesubsessions
description: 显式 /deletesubsessions 删除当前会话全部后代，先远端全部成功再本地，保留当前会话。
---

执行相邻 [deletesessions](../deletesessions/SKILL.md) 的同一流程。当前用户发送本命令即授权该流程，无需再发送另一个命令。当前会话及执行worker始终排除；不得调用旧--current脚本。
