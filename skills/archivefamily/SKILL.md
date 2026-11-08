---
name: archivefamily
description: 显式 /archivefamily 或 $archivefamily 可恢复归档当前会话及其全部后代；单机无远端后代时直接通过 schedule_archive_family 秒级脱离归档，含远端后代时先核验远端全部归档成功再归档本地与当前会话。
---

# 归档当前会话家族（含当前会话）

用户实际发送 `/archivefamily`、`$archivefamily`（T3 斜杠菜单选择 Skill 后会自动插入 `$archivefamily`）或直接选择本 Skill 即授权**可恢复归档当前会话本身及其全部后代**。仅讨论命令、引用示例或自动启动登记不触发归档。此命令包含当前根会话，与保留当前会话的 `/archivechilds`（`$archivechilds`）及永久删除的 `/deletefamily`（`$deletefamily`）严格区分。

## 极速快路径（99% 场景：当前会话无跨设备委派后代，数秒内完成）

禁止在此场景下读取其他 `SKILL.md`、禁止全量拉取远端设备线程列表、禁止逐段翻阅当前会话长历史、禁止手写 `schtasks`/Python 临时脚本：

1. 用 T3 工具 `t3_thread_list(allProjects=true, limit=10)` 获取真实 `currentThreadId`（若为空仅在当前环境精确核实本会话 `threadId`，绝不用 cwd 或标题猜测）。
2. 检查本机状态目录（macOS/Linux `~/.local/state/session-family-cleanup/`，Windows `%LOCALAPPDATA%\session-family-cleanup\`）是否存在绑定当前 `threadId` 的跨设备登记，且当前会话未向远端设备发起过 `delegate_task` / `t3_thread_launch`。
3. 若无远端跨设备后代，直接调用 `T3-delete-sessions`（1.7.0+）内置的独立脱离归档工具 `schedule_archive_family`（自动同时停止并归档本机子会话与当前根会话，Windows 走 WMI 独立进程脱离 Job Object，macOS/Linux 走独立 setsid 守护进程）：
   - **已挂载 `t3-delete-sessions` MCP**：先调 `inspect_target` 拿到 `hostname` 与 `db_path`，再直接调 `schedule_archive_family(target_host=..., db_path=..., thread_id=currentThreadId, delay_ms=1500, dry_run=false)`。
   - **未挂载该 MCP**：直接在终端执行单条 Node 命令：
     ```sh
     node -e 'const {execFileSync}=require("node:child_process");const run=(t,a)=>JSON.parse(execFileSync(process.platform==="win32"?"npx.cmd":"npx",["-y","github:bbfss/T3-delete-sessions","--auto-local","--call",t,"--arguments-file","-"],{input:JSON.stringify(a),encoding:"utf8",shell:process.platform==="win32"}));const info=run("inspect_target",{});console.log(JSON.stringify(run("schedule_archive_family",{target_host:info.hostname,db_path:info.db_path,thread_id:process.argv[1],delay_ms:1500,dry_run:false})));' "<真实currentThreadId>"
     ```
4. 拿到 `status: "scheduled_detached_archive"` 与 `receipt_path` 后，立即用一句话向用户输出外部回执路径并说明归档可在 T3 归档列表恢复，**立刻结束本轮回复**（1.5 秒后独立进程自动执行官方 `thread.stop` + `thread.archive` 并写入核验回执）。

## 跨设备路径（仅当当前会话存在远端 T3 后代时）

1. 按相邻 [archivechilds](../archivechilds/SKILL.md) 生成并执行**后代阶段**计划（`action="archive"`）：严格先远端后本地，所有远端后代均归档并核验成功后，再处理本地。远端离线、失败或未确认时停止后续操作，在当前会话报告阻碍并保留根以便重试。
2. 全部远端后代核验完毕后，对当前根会话调用上述 `schedule_archive_family(..., dry_run=false)`（内部固定 `keep_parent=false`，禁止退化为 `archivechilds` 或升级为删除）。
3. 若存在独立 Codex CLI 子会话端点，在所属设备/home 同步执行 `codex archive <完整UUID>`；不得调用 `delete` 冒充归档。项目文件、worktree 与共享服务保持不动。
