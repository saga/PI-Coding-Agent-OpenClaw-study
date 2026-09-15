# Sessions

Pi 将对话保存为 session，以便你可以继续工作、从更早的轮次进行 Branch，并重新访问之前的路径。

## Session 存储

Session 会自动保存到 `~/.pi/agent/sessions/`，并按工作目录组织。每个 session 都是一个具有树结构的 JSONL 文件。

```bash
pi -c                  # Continue most recent session
pi -r                  # Browse and select from past sessions
pi --no-session        # Ephemeral mode; do not save
pi --name "my task"    # Set session display name at startup
pi --session <path|id> # Use a specific session file or partial session ID
pi --fork <path|id>    # Fork a session file or partial session ID into a new session
```

在交互模式下使用 `/session` 查看当前 session 文件、session ID、消息数、token 和成本。

关于 JSONL 文件格式和 SessionManager API，请参见 [Session Format](session-format.md)。

## Session 命令

| 命令 | 描述 |
|---------|-------------|
| `/resume` | 浏览并选择之前的 session |
| `/new` | 启动一个新的 session |
| `/name <name>` | 设置当前 session 的显示名称 |
| `/session` | 显示 session 信息 |
| `/tree` | 导航当前 session 树 |
| `/fork` | 从之前的用户消息创建一个新的 session |
| `/clone` | 将当前活动 branch 复制到一个新的 session |
| `/compact [prompt]` | 概括更早的 context；参见 [Compaction](compaction.md) |
| `/export [file]` | 将 session 导出为 HTML |
| `/share` | 作为私有 GitHub gist 上传，并提供可分享的 HTML 链接 |

## 恢复和删除 Session

`/resume` 会为当前项目打开一个交互式 session 选择器。`pi -r` 在启动时打开相同的选择器。

在选择器中你可以：

- 通过输入进行搜索
- 使用 Ctrl+P 切换路径显示
- 使用 Ctrl+S 切换排序模式
- 使用 Ctrl+N 过滤到已命名的 session
- 使用 Ctrl+R 重命名
- 使用 Ctrl+D 删除，然后确认

在可用时，pi 会使用 `trash` CLI 进行删除，而不是永久移除文件。

## 命名 Session

使用 `/name <name>` 设置人类可读的 session 名称：

```text
/name Refactor auth module
```

在启动时使用 `--name` 或 `-n` 设置名称：

```bash
pi --name "Refactor auth module"
pi --name "CI audit" -p "Review this build failure"
```

已命名的 session 在 `/resume` 和 `pi -r` 中更容易找到。

## 使用 `/tree` 进行 Branching

Session 以树的形式存储。每个条目都有一个 `id` 和一个 `parentId`，当前位置是活动叶节点。`/tree` 允许你跳转到任何之前的位置并从那里继续，而无需创建新文件。

<p align="center"><img src="images/tree-view.png" alt="Tree View" width="600"></p>

示例结构：

```text
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ user: "That worked..."  ← active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

### 树控制

| 按键 | 操作 |
|-----|--------|
| ↑/↓ | 导航可见条目 |
| ←/→ | 上翻/下翻页 |
| Ctrl+←/Ctrl+→ 或 Alt+←/Alt+→ | 折叠/展开或在 branch 段之间跳转 |
| Shift+L | 在选中的条目上设置或清除 label |
| Shift+T | 切换 label 时间戳 |
| Enter | 选择条目 |
| Escape/Ctrl+C | 取消 |
| Ctrl+O | 循环切换过滤模式 |

过滤模式有：default、no-tools、user-only、labeled-only 和 all。在 [Settings](settings.md) 中使用 `treeFilterMode` 配置默认值。

### 选择行为

选择一条 user 或 custom 消息：

1. 将叶节点移动到所选消息的父节点。
2. 将所选消息文本放入编辑器。
3. 允许你编辑并重新提交，从而创建一个新的 branch。

选择一条 assistant、tool、compaction 或其他非 user 条目：

1. 将叶节点移动到该条目。
2. 使编辑器保持为空。
3. 允许你从该点继续。

选择根 user 消息会将叶节点重置为一个空对话，并将原始 prompt 放入编辑器。

## `/tree`、`/fork` 和 `/clone`

| 特性 | `/tree` | `/fork` | `/clone` |
|---------|---------|---------|----------|
| 输出 | 相同的 session 文件 | 新的 session 文件 | 新的 session 文件 |
| 视图 | 完整树 | 用户消息选择器 | 当前活动 branch |
| 典型用途 | 在原处探索替代方案 | 从更早的 prompt 启动一个新的 session | 在继续之前复制当前工作 |
| 摘要 | 可选的 branch summary | 无 | 无 |

当你希望将替代方案放在一起时，使用 `/tree`。当你想要一个单独的 session 文件时，使用 `/fork` 或 `/clone`。

## Branch 摘要

当 `/tree` 从一个 branch 切换到另一个 branch 时，pi 可以概括被放弃的 branch，并将该摘要附加到新位置。这可以保留你离开的路径中的重要 context，而无需重放整个 branch。

当出现提示时，选择以下之一：

1. 无摘要
2. 使用默认 prompt 进行概括
3. 使用自定义重点指令进行概括

关于 branch summarization 的内部机制和 extension hook，请参见 [Compaction](compaction.md)。

## Session 格式

Session 文件是 JSONL，包含消息条目、model 变更、thinking-level 变更、label、compaction、branch summary 和 extension 条目。

关于 parser、extension、SDK 用法以及完整的 SessionManager API，请参见 [Session Format](session-format.md)。
