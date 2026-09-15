# 使用 Pi

本页收集了不适合放在快速开始页面上的日常使用细节。

## 交互模式

<p align="center"><img src="images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

界面有四个主要区域：

- **启动头部** - 快捷键、已加载的 context 文件、prompt templates、skills 和 extensions
- **消息** - 用户消息、assistant 回复、tool 调用、tool 结果、通知、错误以及 extension UI
- **编辑器** - 你输入的地方；边框颜色表示当前的 thinking 等级
- **页脚** - 工作目录、session 名称、token/cache 用量、费用、context 用量以及当前 model。总计包含 assistant 回复、tools 报告的用量以及摘要生成。

编辑器可以被临时替换为内置 UI（例如 `/settings`）或自定义 extension UI。

### 编辑器功能

| 功能 | 方式 |
|---------|-----|
| 文件引用 | 输入 `@` 以模糊搜索项目文件 |
| 路径补全 | 按 Tab 补全路径 |
| 多行输入 | Shift+Enter，或在 Windows Terminal 上使用 Ctrl+Enter |
| 复制回复 | Ctrl+X 在 `/tree` 中复制选中的消息；否则复制最后一条 assistant 消息，或在 `fullscreenCopyOnSelect` 被禁用时复制当前 fullscreen 文本选区 |
| 图片 | 使用 Ctrl+V 粘贴，在 Windows 上使用 Alt+V，或拖入终端 |
| Shell 命令 | `!command` 运行并将输出发送给 model |
| 隐藏的 shell 命令 | `!!command` 运行但不将输出发送给 model |
| 外部编辑器 | Ctrl+G 打开 `externalEditor`、`$VISUAL`、`$EDITOR`，在 Windows 上打开 Notepad，在其他平台打开 `nano` |

有关所有快捷键与自定义，请参阅 [Keybindings](keybindings.md)。

## 斜杠命令

在编辑器中输入 `/` 以打开命令补全。Extensions 可以注册自定义命令，skills 以 `/skill:name` 的形式可用，prompt templates 通过 `/templatename` 展开。

| 命令 | 描述 |
|---------|-------------|
| `/login`, `/logout` | 管理 OAuth 或 API-key 凭据 |
| [`/llama`](llama-cpp.md) | 下载、加载和卸载 llama.cpp router models |
| `/model` | 切换 models；在选择器中按 Ctrl+S 保存启动默认值 |
| `/thinking` | 切换 thinking 等级；在选择器中按 Ctrl+S 保存启动默认值 |
| `/scoped-models` | 启用/禁用用于 Ctrl+P 循环切换的 models |
| `/settings` | Theme、消息投递、transport 以及其他偏好设置 |
| `/resume` | 从之前的 sessions 中选择 |
| `/new` | 开始一个新的 session |
| `/name <name>` | 设置 session 显示名称 |
| `/session` | 显示 session 文件、ID、消息数、tokens 和费用 |
| `/tree` | 跳转到 session 中的任意位置并从那里继续 |
| `/trust` | 为未来的 sessions 保存项目 trust 决定 |
| `/fork` | 从之前的用户消息创建一个新的 session |
| `/clone` | 将当前活动 branch 复制到一个新的 session |
| `/compact [prompt]` | 手动 compact context，可选地附带自定义指令 |
| `/copy` | 将最后一条 assistant 消息复制到剪贴板 |
| `/export [file]` | 将 session 导出为 HTML 或 JSONL |
| `/import <file>` | 从 JSONL 文件导入并恢复一个 session |
| `/share` | 上传为私有 GitHub gist，并带有可分享的 HTML 链接 |
| `/reload` | 重新加载 keybindings、extensions、skills、prompts、themes 和 context 文件 |
| `/hotkeys` | 显示所有键盘快捷键 |
| `/changelog` | 显示版本历史 |
| `/quit` | 退出 pi |

## 消息队列

你可以在 agent 仍在工作时提交消息：

- **Enter** 将一条 steering 消息加入队列，在当前 assistant 回合完成执行其 tool 调用后投递。
- **Alt+Enter** 将一条 follow-up 消息加入队列，在 agent 完成所有工作后投递。
- **Escape** 中止并将已排队的消息恢复到编辑器。
- **Alt+Up** 将已排队的消息取回到编辑器。

在 Windows Terminal 上，Alt+Enter 默认是全屏。如果你希望 pi 接收该快捷键，请按 [终端设置](terminal-setup.md) 中所述重新映射它。

在 [Settings](settings.md) 中使用 `steeringMode` 和 `followUpMode` 配置投递方式。

## Sessions

Sessions 会自动保存到 `~/.pi/agent/sessions/`，按工作目录组织。

```bash
pi -c                  # Continue most recent session
pi -r                  # Browse and select a session
pi --no-session        # Ephemeral mode; do not save
pi --name "my task"    # Set session display name at startup
pi --session <path|id> # Use a specific session file or session ID
pi --fork <path|id>    # Fork a session into a new session file
```

有用的 session 命令：

- `/session` 显示当前的 session 文件与 ID。
- `/tree` 导航文件内的 session 树，并可以摘要已被放弃的 branches。
- `/fork` 从较早的用户消息创建一个新的 session。
- `/clone` 将当前活动 branch 复制到一个新的 session 文件。
- `/compact` 摘要较早的消息以释放 context。

详情请参阅 [Sessions](sessions.md) 和 [Compaction](compaction.md)。

## Context 文件

Pi 在启动时从以下位置加载 `AGENTS.md` 或 `CLAUDE.md`：

- `~/.pi/agent/AGENTS.md` 用于全局指令
- 父目录，从当前工作目录向上遍历
- 当前目录

如果某个目录包含 `AGENTS.override.md`，Pi 会从该目录加载它，而不是 `AGENTS.md` 或 `CLAUDE.md`。来自其他目录的 context 文件仍会正常叠加。

使用 context 文件来记录项目约定、命令、安全规则和偏好。使用 `--no-context-files` 或 `-nc` 禁用加载。

### System Prompt 文件

使用以下文件替换默认的 system prompt：

- `.pi/SYSTEM.md` 用于单个项目
- `~/.pi/agent/SYSTEM.md` 用于全局

在两个位置中任一处使用 `APPEND_SYSTEM.md` 即可追加到默认 prompt 而不替换它。

### 项目 Trust

在交互式启动时，如果某个项目文件夹包含项目本地的 settings、resources 或项目 `.agents/skills`，并且在 `~/.pi/agent/trust.json` 中对该文件夹或其父文件夹没有已保存的决定，pi 会在 trust 之前先询问。Trust 一个项目允许 pi 加载 `.pi/settings.json` 和 `.pi` resources、安装缺失的项目 packages，并执行项目 extensions。

在 trust 决定之前，pi 仅加载 context 文件、用户/全局 extensions 以及 CLI `-e` extensions，以便它们能够处理 `project_trust` 事件。项目本地的 extensions、由项目 package 管理的 extensions 以及项目 settings 仅在项目被 trust 之后才加载。当切换到来自不同 cwd、且其 trust 在当前进程中尚未解决的 session 时，这种划分同样适用。

非交互模式（`-p`、`--mode json` 和 `--mode rpc`）不显示 trust 提示。在没有适用的已保存 trust 决定时，它们使用全局 settings 中的 `defaultProjectTrust`：`ask`（默认）和 `never` 会忽略那些项目 resources，而 `always` 会 trust 它们。传入 `--approve`/`-a` 或 `--no-approve`/`-na` 以为单次运行覆盖项目 trust。

如果没有 extension 或已保存的决定适用，`defaultProjectTrust` 控制回退行为。在 `~/.pi/agent/settings.json` 中将其设置为 `"ask"`、`"always"` 或 `"never"`，或使用 `/settings` 更改它。

`pi config` 和 package 命令使用相同的项目 trust 流程，但 `pi update` 从不提示。传入 `--approve` 以为单条命令 trust 项目本地的 settings，或传入 `--no-approve` 以忽略它们。

在交互模式下使用 `/trust` 为未来的 sessions 保存项目 trust 决定，包括对直接父文件夹的 trust。它仅写入 `~/.pi/agent/trust.json`；当前 session 不会被重新加载，因此请重启 pi 以使更改生效。


## 导出与分享 Sessions

使用 `/export [file]` 将 session 写入 HTML。

使用 `/share` 上传私有 GitHub gist，并带有可分享的 HTML 链接。

如果你将 pi 用于开源工作，并希望发布 sessions 用于 model、prompt、tool 和评估研究，请参阅 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf)。它会将 sessions 发布到 Hugging Face datasets。

## CLI 参考

```bash
pi [options] [--] [@files...] [messages...]
```

### Package 命令

```bash
pi install <source> [-l]     # Install package, -l for project-local
pi remove <source> [-l]      # Remove package
pi uninstall <source> [-l]   # Alias for remove
pi update [source|self|pi]   # Update pi only, or one package source
pi update --all              # Update pi and packages; reconcile pinned git refs
pi update --extensions       # Update packages only; reconcile pinned git refs
pi update --models           # Refresh model catalogs only
pi update --self             # Update pi only
pi update --extension <src>  # Update one package
pi list                      # List installed packages
pi config                    # Enable/disable package resources
```

这些命令管理 pi packages，并且 `pi update` 可以更新 pi CLI 安装。要卸载 pi 本身，请参阅 [快速开始](quickstart.md#uninstall)。`pi config` 和项目 package 命令接受 `--approve`/`--no-approve`，以在单条命令中 trust 或忽略项目本地的 settings。`pi update` 从不提示项目 trust。

有关 package 来源与安全说明，请参阅 [Pi Packages](packages.md)。

### 模式

| Flag | 描述 |
|------|-------------|
| default | 交互模式 |
| `-p`, `--print` | 打印回复并退出 |
| `--mode json` | 将所有事件输出为 JSON lines；请参阅 [JSON 模式](json.md) |
| `--mode rpc` | 通过 stdin/stdout 的 RPC 模式；请参阅 [RPC 模式](rpc.md) |
| `--export <in> [out]` | 将 session 导出为 HTML |

在 print 模式下，pi 还会读取管道传入的 stdin 并将其合并到初始 prompt 中：

```bash
cat README.md | pi -p "Summarize this text"
```

### Model 选项

| Option | 描述 |
|--------|-------------|
| `--provider <name>` | Provider，例如 `anthropic`、`openai` 或 `google` |
| `--model <pattern>` | Model 模式或 ID；支持 `provider/id` 以及可选的 `:<thinking>` |
| `--api-key <key>` | API key，覆盖环境变量 |
| `--thinking <level>` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| `--models <patterns>` | 用于 Ctrl+P 循环切换的逗号分隔模式 |
| `--list-models [search]` | 列出可用的 models |

### Session 选项

| Option | 描述 |
|--------|-------------|
| `-c`, `--continue` | 继续最近的 session |
| `-r`, `--resume` | 浏览并选择一个 session |
| `--session <path\|id>` | 使用特定的 session 文件或部分 UUID |
| `--fork <path\|id>` | 将 session 文件或部分 UUID fork 到一个新的 session |
| `--session-dir <dir>` | 自定义 session 存储目录 |
| `--no-session` | 临时模式；不保存 |
| `--name <name>`, `-n <name>` | 在启动时设置 session 显示名称 |

### Tool 选项

| Option | 描述 |
|--------|-------------|
| `--tools <list>`, `-t <list>` | 将特定的内置、extension 和自定义 tools 加入 allowlist |
| `--exclude-tools <list>`, `-xt <list>` | 禁用特定的内置、extension 和自定义 tools |
| `--no-builtin-tools`, `-nbt` | 禁用内置 tools，但保持 extension/自定义 tools 启用 |
| `--no-tools`, `-nt` | 禁用所有 tools |

内置 tools：`read`、`bash`、`powershell`（Windows）、`edit`、`write`、`grep`、`find`、`ls`。

### Resource 选项

| Option | 描述 |
|--------|-------------|
| `-e`, `--extension <source>` | 从路径、npm 或 git 加载一个 extension；可重复 |
| `--no-extensions` | 禁用 extension 发现 |
| `--skill <path>` | 加载一个 skill；可重复 |
| `--no-skills` | 禁用 skill 发现 |
| `--prompt-template <path>` | 加载一个 prompt template；可重复 |
| `--no-prompt-templates` | 禁用 prompt template 发现 |
| `--theme <path>` | 加载一个 theme；可重复 |
| `--no-themes` | 禁用 theme 发现 |
| `--no-context-files`, `-nc` | 禁用 `AGENTS.md` 和 `CLAUDE.md` 发现 |

将 `--no-*` 与显式 flags 组合使用，以在忽略 settings 的情况下精确加载你需要的内容。例如：

```bash
pi --no-extensions -e ./my-extension.ts
```

### 其他选项

| Option | 描述 |
|--------|-------------|
| `--system-prompt <text>` | 替换默认 prompt；context 文件和 skills 仍会被追加 |
| `--append-system-prompt <text>` | 追加到 system prompt |
| `--tui-mode <mode>` | TUI 模式：`regular`（默认）或实验性的 `fullscreen` |
| `--use-theme <name[/name]>` | 为本次运行设置初始交互 theme，而不更改 settings |
| `--verbose` | 强制详细启动 |
| `-a`, `--approve` | 为本次运行 trust 项目本地文件 |
| `-na`, `--no-approve` | 为本次运行忽略项目本地文件 |
| `--` | 停止选项解析；剩余参数为 prompts 或 `@file` 输入 |
| `-h`, `--help` | 显示帮助 |
| `-v`, `--version` | 显示版本 |

在 `fullscreen` 模式下，transcript 在终端视口内滚动，而已排队的消息、工作状态、extension widgets、编辑器与页脚则固定在底部。鼠标/触控板输入会滚动指针下方的区域；键盘视口操作始终可用。Inline images 在支持 Kitty graphics protocol 的终端中可用，包括 Kitty 和 Ghostty。在 iTerm2 中，它们会渲染为文本占位符，因为其 inline-image protocol 无法在应用所拥有的滚动期间删除或裁剪 placements。在 `regular` 模式下，pi 使用主屏幕和终端所拥有的 scrollback，iTerm2 inline images 继续正常渲染。有关终端特定的 settings 与变通方法，请参阅 [终端设置](terminal-setup.md)。

在 `/settings` 中设置 **TUI mode** 可立即在 `regular` 与 `fullscreen` 之间切换，并为未来的 sessions 选择默认值。**Fullscreen exit output** 控制退出 fullscreen 时是打印最终 transcript，还是恢复之前的屏幕并仅打印 session 恢复提示。

### 文件参数

在文件前加上 `@` 以将其包含在消息中：

```bash
pi @prompt.md "Answer this"
pi -p @screenshot.png "What's in this image?"
pi @code.ts @test.ts "Review these files"
```

### 示例

```bash
# Interactive with initial prompt
pi "List all .ts files in src/"

# Non-interactive
pi -p "Summarize this codebase"

# Prompt beginning with a dash
pi -p -- "- Summarize these points"

# Non-interactive with piped stdin
cat README.md | pi -p "Summarize this text"

# Named one-shot session
pi --name "release audit" -p "Audit this repository"

# Different model
pi --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix
pi --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
pi --model sonnet:high "Solve this complex problem"

# Limit model cycling
pi --models "claude-*,gpt-4o"

# Read-only mode
pi --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
pi --exclude-tools ask_question
```

## 设计原则

Pi 保持核心小巧，并将工作流特定的行为推入 extensions、skills、prompt templates 和 packages。

它有意不包含内置 MCP、sub-agents、权限弹窗、plan mode、to-dos 或 background bash。你可以将这些工作流构建或安装为 extensions 或 packages，或使用外部 tools，例如 containers 和 tmux。

完整的理由，请阅读 [blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)。
