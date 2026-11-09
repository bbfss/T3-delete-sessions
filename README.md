# T3-delete-sessions

[简体中文](#中文说明) | [English](#english)

---

## 中文说明

专为 T3 Code 打造的**会话彻底清理与跨设备级联管理插件**（Node.js `>= 22.12` 零依赖原生运行，支持 macOS / Windows / Linux）。

### 为什么做这个插件？（官方 T3 右键删除的 4 个问题）

T3 Code 自带的右键删除（`thread.delete`）只是在本地 SQLite 里打个 `deleted_at` 隐藏标记，存在 4 个明显残留问题：

1. **底层原生对话不删**：Codex (`~/.codex`)、Claude (`~/.claude`)、Antigravity (`brain/`) 的底层数据库和 `.jsonl` 100% 残留在硬盘上（实测单台 Mac 上有 **155 个已右键删除会话**的原生文件残留，`codex resume` / `claude -r` 列表全是死会话）。
2. **`~/.t3/scratch/` 临时目录不删**：子任务生成的临时目录永久留在硬盘（实测 48 个 `scratch` 目录中 **42 个（87.5%）** 属于已右键删除的会话）。
3. **本机子会话不级联**：删了父会话，它派生的子会话（Subagents）不会跟着删，直接变成孤儿会话留在列表里。
4. **跨设备远端会话不管**：发往 VPS 或另一台电脑的跨机子会话完全不会联动清理。

**本插件的作用**：一键实现 **T3 列表记录 + 本机/跨机全族谱子孙会话 + 底层 Provider 原生文件 + `~/.t3/scratch/` 临时目录** 的三层彻底物理清理（哪怕之前不小心用右键删过的子会话，也能顺手把残留垃圾扫干净）。

### 命令一览（支持 `/命令` 或 `$命令`）

| 命令 | 作用 |
| :--- | :--- |
| **`/deletechilds`** (`$deletechilds`) | **最常用**：彻底删除当前会话的所有本机/跨机子孙会话，**保留当前会话** |
| **`/deletefamily`** (`$deletefamily`) | 彻底删除**当前会话 + 所有子孙会话**（后台脱离秒级自删） |
| **`/deletefathers`** (`$deletefathers`) | **只保留当前子树**，彻底删除上面的所有父辈祖先与旁支 |
| **`/deleteorphans`** (`$deleteorphans`) | 扫描并彻底清理本机无父节点的**孤儿会话**（自动保护跨设备远端父节点） |
| **`/archivechilds`** / **`/archivefamily`** / **`/archivefathers`** / **`/archiveorphans`** | 与上面 4 个删除命令一一对应，但**只归档隐藏（移入 T3 Archive），不删底层文件，可恢复** |

### 安装配置（MCP）

```json
{
  "mcpServers": {
    "t3-delete-sessions": {
      "command": "node",
      "args": [
        "-e",
        "const{spawn,execFileSync}=require('child_process'),fs=require('fs'),os=require('os'),p=require('path');const d=p.join(os.homedir(),'.cache','t3-delete-sessions'),c=p.join(d,'bin','cli.js'),u='https://github.com/bbfss/T3-delete-sessions.git';try{if(!fs.existsSync(c)){fs.mkdirSync(p.dirname(d),{recursive:true});execFileSync('git',['clone','--depth','1',u,d],{stdio:'ignore',timeout:20000});}else{execFileSync('git',['-C',d,'pull','--ff-only','--quiet'],{stdio:'ignore',timeout:8000});}}catch{}const k=spawn(process.execPath,[c,'--auto-local'],{stdio:'inherit',windowsHide:true});k.on('exit',e=>process.exit(e??1));"
      ]
    }
  }
}
```

---

## English

**Complete 3-layer cascading session cleanup & cross-device family manager for T3 Code.**  
Zero third-party npm or Python dependencies (runs natively on Node.js `>= 22.12` across macOS, Windows, and Linux).

### Why We Built This (4 Problems with T3's Built-in Right-Click Delete)

T3 Code's built-in right-click delete (`thread.delete`) only marks a single SQLite row with `deleted_at` to hide it from the UI:

1. **Native Provider Files Left Behind**: Codex (`~/.codex`), Claude (`~/.claude`), and Antigravity (`brain/`) conversations remain on disk (155 deleted T3 threads still had full native files on our Mac, cluttering `codex resume` / `claude -r`).
2. **`~/.t3/scratch/` Directories Never Removed**: 42 out of 48 (`87.5%`) scratch directories on our Mac belonged to already-deleted T3 threads.
3. **No Child / Subagent Cascade**: Deleting a parent leaves its spawned children behind as orphaned sessions.
4. **No Cross-Device Cleanup**: Remote delegated sessions on VPS or other machines are left behind.

**What This Plugin Does**: Performs verified 3-layer cleanup across **T3 SQLite + local & remote child sessions + native provider storage + `~/.t3/scratch/` directories** (and automatically sweeps leftover files from children you previously right-click deleted).

### Commands (`/` or `$` triggers)

| Command | What It Does |
| :--- | :--- |
| **`/deletechilds`** (`$deletechilds`) | **Most used**: Deletes all local & remote descendants while **keeping the current session** |
| **`/deletefamily`** (`$deletefamily`) | Deletes **the current session + all descendants** via a detached background worker |
| **`/deletefathers`** (`$deletefathers`) | **Keeps only the current subtree**, deleting all ancestors and sibling branches |
| **`/deleteorphans`** (`$deleteorphans`) | Scans and deletes verified local **orphan sessions** (protects cross-device remote parents) |
| **`/archivechilds`** / **`/archivefamily`** / **`/archivefathers`** / **`/archiveorphans`** | Same 4 scopes as above, but **archives to T3 Archive** (recoverable, preserves files) |

### Setup (MCP)

Use the same `mcpServers.t3-delete-sessions` JSON snippet shown above, or run via `npx -y github:bbfss/T3-delete-sessions --auto-local`.

### License

MIT
