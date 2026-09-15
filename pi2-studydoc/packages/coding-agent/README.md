<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> 来自新贡献者的新 issue 和 PR 默认会被自动关闭。维护者每天审查自动关闭的 issue。参见 [CONTRIBUTING.md](../../CONTRIBUTING.md)。

---

Pi 是一个极简的终端 coding harness。让 pi 适配你的工作流，而不是反过来，无需 fork 并修改 pi 内部实现。用 TypeScript 的 [Extensions](#extensions)、[Skills](#skills)、[Prompt Templates](#prompt-templates) 和 [Themes](#themes) 来扩展它。把你的 extensions、skills、prompt templates 和 themes 放进 [Pi Packages](#pi-packages)，并通过 npm 或 git 与他人分享。

Pi 自带强大的默认配置，但跳过了 sub agents 和 plan mode 之类的功能。取而代之，你可以让 pi 构建你想要的东西，或安装一个契合你工作流的第三方 pi package。

Pi 以四种模式运行：interactive、print 或 JSON、用于进程集成的 RPC，以及用于嵌入你自己应用的 SDK。

## 分享你的 OSS coding agent sessions

如果你将 pi 用于开源工作，请分享你的 coding agent sessions。

公开的 OSS session 数据有助于利用真实开发工作流来改进 models、prompts、tools 和 evaluations。

完整说明参见 [X 上的这篇帖子](https://x.com/badlogicgames/status/2037811643774652911)。

要发布 sessions，请使用 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf)。阅读其 README.md 获取设置说明。你只需要一个 Hugging Face 账号、Hugging Face CLI 和 `pi-share-hf`。

你也可以观看[这个视频](https://x.com/badlogicgames/status/2041151967695634619)，其中我演示了如何发布我的 `pi-mono` sessions。

我会定期在这里发布我自己的 `pi-mono` 工作 sessions：

- [Hugging Face 上的 badlogicgames/pi-mono](https://huggingface.co/datasets/badlogicgames/pi-mono)

## 目录

- [快速开始](#quick-start)
- [Providers 与 Models](#providers--models)
- [交互模式](#interactive-mode)
  - [编辑器](#editor)
  - [命令](#commands)
  - [键盘快捷键](#keyboard-shortcuts)
  - [消息队列](#message-queue)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context 文件](#context-files)
- [自定义](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [Pi Packages](#pi-packages)
- [编程式用法](#programmatic-usage)
- [理念](#philosophy)
- [CLI 参考](#cli-reference)

---

## 快速开始

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 在安装期间禁用依赖的生命周期脚本。对于常规的 npm 安装，Pi 不需要安装脚本。

安装器替代方案：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

使用 API key 进行认证：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

或使用你现有的 subscription：

```bash
pi
/login  # Then select provider
```

然后只需与 pi 对话。默认情况下，pi 给 model 提供四个 tools：`read`、`write`、`edit` 和 `bash`。model 使用这些 tools 来完成你的请求。通过 [skills](#skills)、[prompt templates](#prompt-templates)、[extensions](#extensions) 或 [pi packages](#pi-packages) 添加能力。

**平台说明：** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [终端设置](docs/terminal-setup.md) | [Shell 别名](docs/shell-aliases.md)

---

## Providers 与 Models

对于每个内置 provider，pi 维护一份具备 tool 能力的 model 列表。已配置的 provider catalog 会自动刷新；运行 `pi update --models` 可强制立即刷新。通过 subscription（`/login`）或 API key 进行认证，然后通过 `/model`（或 Ctrl+L）从该 provider 选择任意 model。在 model 选择器中按 Ctrl+S 可将高亮的 model 保存为启动默认值。

**Subscriptions：**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot

**API keys：**
- Anthropic
- Ant Ling
- OpenAI
- Azure OpenAI
- DeepSeek
- NVIDIA NIM
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- Cloudflare AI Gateway
- Cloudflare Workers AI
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI Coding Plan (Global)
- ZAI Coding Plan (China)
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Fireworks
- Together AI
- Baseten
- Kimi For Coding
- MiniMax
- Xiaomi MiMo
- Xiaomi MiMo Token Plan (China)
- Xiaomi MiMo Token Plan (Amsterdam)
- Xiaomi MiMo Token Plan (Singapore)

Pi 还支持 llama.cpp router server。用 `/login llama.cpp` 配置它，用 `/llama` 管理下载和已加载的 models，然后用 `/model` 选择一个已加载的 model。设置与用法参见 [docs/llama-cpp.md](docs/llama-cpp.md)。

其他 provider 的设置说明参见 [docs/providers.md](docs/providers.md)。

**自定义 providers 与 models：** 如果某个 provider 使用受支持的 API（OpenAI、Anthropic、Google），可通过 `~/.pi/agent/models.json` 添加它。对于自定义 API 或 OAuth，请使用 extensions。参见 [docs/models.md](docs/models.md) 和 [docs/custom-provider.md](docs/custom-provider.md)。

---

## 交互模式

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

界面自上而下依次为：

- **启动头部** - 显示快捷键（全部快捷键见 `/hotkeys`）、已加载的 AGENTS.md 文件、prompt templates、skills 和 extensions
- **消息** - 你的消息、assistant 回复、tool 调用与结果、通知、错误以及 extension UI
- **编辑器** - 你输入的位置；边框颜色表示 thinking level，边框显示流式工作指示器
- **页脚** - 工作目录、session 名称、token/cache 总用量（`↑` 输入，`↓` 输出，`R` cache read，`W` cache write，`CH` 最新 cache 命中率）、成本、context 用量、当前 model。总量包含 assistant 回复、tools 上报的用量以及摘要生成。

编辑器可以被其他 UI 临时替换，比如内置的 `/settings` 或来自 extensions 的自定义 UI（例如一个让用户以结构化格式回答 model 提问的 Q&A tool）。[Extensions](#extensions) 还可以替换编辑器、在其上方/下方添加 widgets、添加状态行、自定义页脚或浮层。

### 编辑器

| 功能 | 方式 |
|---------|-----|
| 文件引用 | 输入 `@` 对项目文件进行模糊搜索 |
| 路径补全 | Tab 补全路径 |
| 多行 | Shift+Enter（Windows Terminal 上为 Ctrl+Enter） |
| 外部编辑器 | Ctrl+G 打开 `externalEditor`、`$VISUAL`、`$EDITOR`、Windows 上的 Notepad，或其他平台上的 `nano` |
| 剪贴板 | Ctrl+V 粘贴图片或文本（Windows 上为 Alt+V），或将图片拖入终端 |
| Bash 命令 | `!command` 执行并把输出发送给 LLM，`!!command` 执行但不发送 |

删除单词、撤销等操作使用标准编辑键绑定。参见 [docs/keybindings.md](docs/keybindings.md)。

### 命令

在编辑器中输入 `/` 触发命令。[Extensions](#extensions) 可以注册自定义命令，[skills](#skills) 以 `/skill:name` 形式可用，[prompt templates](#prompt-templates) 通过 `/templatename` 展开。

| 命令 | 说明 |
|---------|-------------|
| `/login`、`/logout` | 管理 provider 凭据 |
| [`/llama`](docs/llama-cpp.md) | 下载、加载和卸载 llama.cpp router models |
| `/model` | 切换 models；在选择器中按 Ctrl+S 保存启动默认值 |
| `/thinking` | 切换 thinking level；在选择器中按 Ctrl+S 保存启动默认值 |
| `/scoped-models` | 为 Ctrl+P 循环启用/禁用 models |
| `/settings` | Theme、消息投递、transport 及其他偏好设置 |
| `/resume` | 从先前的 sessions 中选择 |
| `/new` | 开始一个新的 session |
| `/name <name>` | 设置 session 显示名称 |
| `/session` | 显示 session 信息（文件、ID、消息、tokens、成本） |
| `/tree` | 跳转到 session 中的任意点并从那里继续 |
| `/trust` | 为未来的 sessions 保存项目信任决定（需要重启） |
| `/fork` | 基于一条先前的用户消息创建新 session |
| `/clone` | 将当前活动 branch 复制到新 session |
| `/compact [prompt]` | 手动 compact context，可提供自定义指令 |
| `/copy` | 将最后一条 assistant 消息复制到剪贴板 |
| `/export [file]` | 将 session 导出为 HTML 或 JSONL 文件 |
| `/import <file>` | 从 JSONL 文件导入并恢复 session |
| `/share` | 作为私有 GitHub gist 上传，并提供可分享的 HTML 链接 |
| `/reload` | 重新加载 keybindings、extensions、skills、prompts、themes 和 context 文件 |
| `/hotkeys` | 显示所有键盘快捷键 |
| `/changelog` | 显示版本历史 |
| `/quit` | 退出 pi |

### 键盘快捷键

完整列表见 `/hotkeys`。通过 `~/.pi/agent/keybindings.json` 自定义。参见 [docs/keybindings.md](docs/keybindings.md)。

**常用：**

| 按键 | 操作 |
|-----|--------|
| Ctrl+C | 清空编辑器 |
| Ctrl+C 两次 | 退出 |
| Escape | 取消/中止 |
| Escape 两次 | 打开 `/tree` |
| Ctrl+L | 打开 model 选择器 |
| Ctrl+P / Shift+Ctrl+P | 向前/向后循环 scoped models |
| Shift+Tab | 循环切换 thinking level |
| Ctrl+O | 折叠/展开 tool 输出 |
| Ctrl+T | 折叠/展开 thinking 块 |
| Ctrl+X | 复制最后一条 assistant 消息；在禁用 fullscreen copy-on-select 时，复制当前文本选择 |

### 消息队列

在 agent 工作时提交消息：

- **Enter** 将一条 *steering* 消息加入队列，在当前 assistant 轮次执行完其 tool calls 后投递
- **Alt+Enter** 将一条 *follow-up* 消息加入队列，仅在 agent 完成所有工作后投递
- **Escape** 中止并将已排队的消息恢复到编辑器
- **Alt+Up** 将已排队的消息取回编辑器

在 Windows Terminal 上，`Alt+Enter` 默认是全屏。请在 [docs/terminal-setup.md](docs/terminal-setup.md) 中重新映射它，以便 pi 能接收 follow-up 快捷键。

在 [settings](docs/settings.md) 中配置投递方式：`steeringMode` 和 `followUpMode` 可以是 `"one-at-a-time"`（默认，等待响应）或 `"all"`（一次性投递所有排队消息）。对于支持多种 transport 的 providers，`transport` 选择 provider transport 偏好（`"sse"`、`"websocket"` 或 `"auto"`）。

---

## Sessions

Sessions 以树状结构的 JSONL 文件存储。每个条目都有一个 `id` 和一个 `parentId`，从而可以就地 branching，而无需创建新文件。文件格式参见 [docs/session-format.md](docs/session-format.md)。

### 管理

Sessions 会自动保存到 `~/.pi/agent/sessions/`，按工作目录组织。

```bash
pi -c                  # Continue most recent session
pi -r                  # Browse and select from past sessions
pi --no-session        # Ephemeral mode (don't save)
pi --name "my task"    # Set session display name at startup
pi --session <path|id> # Use specific session file or ID
pi --fork <path|id>    # Fork specific session file or ID into a new session
```

在交互模式下使用 `/session` 查看当前 session ID，然后再用 `--session <id>` 或 `--fork <id>` 复用它。

### Branching

**`/tree`** - 就地导航 session 树。选择任意先前的点，从那里继续，并在 branches 之间切换。所有历史都保留在单个文件中。在 model 正在响应时选择某个点会取消该响应。当 compaction 或另一次树导航仍在运行时，无法进行导航；请等待其完成并重试。

<p align="center"><img src="docs/images/tree-view.png" alt="Tree View" width="600"></p>

- 通过输入进行搜索，用 Ctrl+←/Ctrl+→ 或 Alt+←/Alt+→ 折叠/展开并在 branches 之间跳转，用 ←/→ 翻页
- 过滤模式（Ctrl+O）：default → no-tools → user-only → labeled-only → all
- 按 Ctrl+X 复制选中的消息
- 按 Shift+L 将条目标记为书签，按 Shift+T 切换标签时间戳

**`/fork`** - 基于活动 branch 上的一条先前用户消息创建新的 session 文件。打开一个选择器，复制到该点为止的活动路径，并将选中的 prompt 放入编辑器以供修改。

**`/clone`** - 将当前活动 branch 在当前位置复制到一个新的 session 文件。新 session 保留完整的活动路径历史，并以空编辑器打开。

**`--fork <path|id>`** - 直接从 CLI 对一个现有 session 文件或部分 session UUID 进行 Fork。这会将完整的源 session 复制到当前项目中的一个新 session 文件。

### Compaction

长时间运行的 sessions 可能会耗尽 context windows。Compaction 在保留近期消息的同时对较早的消息进行摘要。

**手动：** `/compact` 或 `/compact <custom instructions>`

**自动：** 默认启用。在 context 溢出时触发（恢复并重试），或在接近上限时触发（主动）。通过 `/settings` 或 `settings.json` 配置。

Compaction 是有损的。完整历史仍保留在 JSONL 文件中；使用 `/tree` 重新查看。通过 [extensions](#extensions) 自定义 compaction 行为。内部机制参见 [docs/compaction.md](docs/compaction.md)。

---

## Settings

使用 `/settings` 修改常用选项，或直接编辑 JSON 文件：

| 位置 | 范围 |
|----------|-------|
| `~/.pi/agent/settings.json` | 全局（所有项目） |
| `.pi/settings.json` | 项目（覆盖全局） |

所有选项参见 [docs/settings.md](docs/settings.md)。

### 项目信任

在交互式启动时，如果某个项目文件夹包含项目本地 settings、resources 或项目 `.agents/skills`，且在 `~/.pi/agent/trust.json` 中对该文件夹或其父文件夹没有已保存的决定，pi 会在信任它之前先询问。信任某个项目会允许 pi 加载 `.pi/settings.json` 和 `.pi` resources、安装缺失的项目 packages，并执行项目 extensions。

在做出信任决定之前，pi 只加载 context 文件、用户/全局 extensions 和 CLI `-e` extensions，以便它们能够处理 `project_trust` 事件。项目本地 extensions、项目 package 管理的 extensions 以及项目 settings 只有在项目被信任之后才会加载。当切换到来自不同 cwd、且其信任尚未在当前进程中解析的 session 时，这种拆分也同样适用。

非交互模式（`-p`、`--mode json` 和 `--mode rpc`）不显示信任提示。在没有适用的已保存信任决定时，它们使用全局 settings 中的 `defaultProjectTrust`：`ask`（默认）和 `never` 忽略那些项目 resources，而 `always` 信任它们。传入 `--approve`/`-a` 或 `--no-approve`/`-na` 可为单次运行覆盖项目信任。

如果没有 extension 或已保存的决定适用，则由 `defaultProjectTrust` 控制回退行为。在 `~/.pi/agent/settings.json` 中将其设置为 `"ask"`、`"always"` 或 `"never"`，或用 `/settings` 更改它。

`pi config` 和 package 命令使用相同的项目信任流程，只是 `pi update` 从不提示。传入 `--approve` 可为单条命令信任项目本地 settings，或传入 `--no-approve` 忽略它们。

在交互模式下使用 `/trust` 为未来的 sessions 保存项目信任决定，包括对直接父文件夹的信任。它只写入 `~/.pi/agent/trust.json`；当前 session 不会被重新加载，因此请重启 pi 以使更改生效。

### Telemetry 与更新检查

Pi 有两个独立的启动功能：

- **更新检查：** 获取 `https://pi.dev/api/latest-version` 以检查是否存在更新的 Pi 版本。用 `PI_SKIP_VERSION_CHECK=1` 禁用它。禁用更新检查只会关闭这项检查。
- **安装/更新 telemetry：** 在首次安装或 changelog 检测到更新后，向 `https://pi.dev/api/report-install` 发送匿名的版本 ping。此设置还控制针对 OpenRouter、Cloudflare 和直接 NVIDIA NIM 请求的可选 provider 归属 headers。通过在 `settings.json` 中将 `enableInstallTelemetry` 设置为 `false`，或设置 `PI_TELEMETRY=0` 来选择退出。这不会禁用更新检查；除非禁用更新检查或启用离线模式，Pi 仍可能联系 `pi.dev` 获取最新版本。

使用 `--offline` 或 `PI_OFFLINE=1` 禁用此处描述的所有启动网络操作，包括更新检查、package 更新检查和安装/更新 telemetry。

---

## Context 文件

Pi 在启动时从以下位置加载 `AGENTS.md`（或 `CLAUDE.md`）：
- `~/.pi/agent/AGENTS.md`（全局）
- 父目录（从 cwd 向上遍历）
- 当前目录

如果某个目录包含 `AGENTS.override.md`，Pi 会加载它，而不是该目录中的 `AGENTS.md` 或 `CLAUDE.md`。来自其他目录的 context 文件仍会被拼接。

用于项目指令（`AGENTS.md`/`CLAUDE.md`）、约定、常用命令。所有匹配的文件都会被拼接。

用 `--no-context-files`（或 `-nc`）禁用 context 文件加载。

### System Prompt

用 `.pi/SYSTEM.md`（项目）或 `~/.pi/agent/SYSTEM.md`（全局）替换默认 system prompt。通过 `APPEND_SYSTEM.md` 追加而不替换。

---

## 自定义

### Prompt Templates

以 Markdown 文件形式提供的可复用 prompts。输入 `/name` 展开。

```markdown
<!-- ~/.pi/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

放入 `~/.pi/agent/prompts/`、`.pi/prompts/`，或一个 [pi package](#pi-packages) 以与他人分享。参见 [docs/prompt-templates.md](docs/prompt-templates.md)。

### Skills

遵循 [Agent Skills 标准](https://agentskills.io) 的按需能力包。通过 `/skill:name` 调用，或让 agent 自动加载它们。

```markdown
<!-- ~/.pi/agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

放入 `~/.pi/agent/skills/`、`~/.agents/skills/`、`.pi/skills/` 或 `.agents/skills/`（从 `cwd` 向上到父目录），或一个 [pi package](#pi-packages) 以与他人分享。参见 [docs/skills.md](docs/skills.md)。

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

用 TypeScript 模块扩展 pi，为其添加自定义 tools、commands、键盘快捷键、事件处理器和 UI 组件。

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

默认导出也可以是 `async`。pi 会在启动继续之前等待异步 extension 工厂，这对于一次性初始化很有用，例如在调用 `pi.registerProvider()` 之前获取远程 model 列表。

**可以实现的功能：**
- 自定义 tools（或完全替换内置 tools）
- Sub-agents 和 plan mode
- 自定义 compaction 和摘要生成
- 权限门控和路径保护
- 自定义编辑器和 UI 组件
- 状态行、头部、页脚
- Git checkpointing 和 auto-commit
- SSH 和 sandbox 执行
- MCP server 集成
- 让 pi 看起来像 Claude Code
- 等待时玩游戏（是的，Doom 可以运行）
- ...任何你能想到的东西

放入 `~/.pi/agent/extensions/`、`.pi/extensions/`，或一个 [pi package](#pi-packages) 以与他人分享。参见 [docs/extensions.md](docs/extensions.md) 和 [examples/extensions/](examples/extensions/)。

### Themes

内置：`dark`、`light`。Themes 支持热重载：修改活动 theme 文件，pi 会立即应用更改。

放入 `~/.pi/agent/themes/`、`.pi/themes/`，或一个 [pi package](#pi-packages) 以与他人分享。参见 [docs/themes.md](docs/themes.md)。

### Pi Packages

通过 npm 或 git 打包并分享 extensions、skills、prompts 和 themes。在 [npmjs.com](https://www.npmjs.com/search?q=keywords%3Api-package) 或 [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628) 上查找 packages。

> **安全：** Pi packages 以完整的系统访问权限运行。Extensions 会执行任意代码，而 skills 可以指示 model 执行任何操作，包括运行可执行文件。安装第三方 packages 之前请审查源代码。

```bash
pi install npm:@foo/pi-tools
pi install npm:@foo/pi-tools@1.2.3      # pinned version
pi install git:github.com/user/repo
pi install git:github.com/user/repo@v1  # tag or commit
pi install git:git@github.com:user/repo
pi install git:git@github.com:user/repo@v1  # tag or commit
pi install https://github.com/user/repo
pi install https://github.com/user/repo@v1      # tag or commit
pi install ssh://git@github.com/user/repo
pi install ssh://git@github.com/user/repo@v1    # tag or commit
pi remove npm:@foo/pi-tools
pi uninstall npm:@foo/pi-tools          # alias for remove
pi list
pi update                               # update pi only
pi update --all                         # update pi and packages
pi update --extensions                  # update packages only
pi update --models                      # refresh model catalogs only
pi update --self                        # update pi only
pi update --self --force                # reinstall pi even if current
pi update npm:@foo/pi-tools             # update one package
pi config                               # enable/disable extensions, skills, prompts, themes
```

Packages 安装到 `~/.pi/agent/git/`（git）或 `~/.pi/agent/npm/`（npm）。使用 `-l` 进行项目本地安装（`.pi/git/`、`.pi/npm/`）。Git 的 `@ref` 值是固定（pinned）的 tag 或 commit；被固定的 packages 会被 `pi update --extensions` 和 `pi update --all` 跳过，因此请使用 `pi install git:host/user/repo@new-ref` 将现有 package 移动到新的 ref。Git packages 默认使用 `npm install --omit=dev` 安装依赖，因此运行时依赖必须列在 `dependencies` 下；当配置了 `npmCommand` 时，git packages 会使用普通的 `install`，以便与各种 wrapper 兼容。如果你使用 Node 版本管理器，并希望 package 安装复用稳定的 npm 环境，请在 `settings.json` 中设置 `npmCommand`，例如 `["mise", "exec", "node@20", "--", "npm"]`。

通过在 `package.json` 中添加 `pi` 键来创建 package：

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

如果没有 `pi` manifest，pi 会从约定目录（`extensions/`、`skills/`、`prompts/`、`themes/`）自动发现。

参见 [docs/packages.md](docs/packages.md)。

---

## 编程式用法

### SDK

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

await session.prompt("What files are in the current directory?");
```

对于高级的多 session 运行时替换，请使用 `createAgentSessionRuntime()` 和 `AgentSessionRuntime`。

参见 [docs/sdk.md](docs/sdk.md) 和 [examples/sdk/](examples/sdk/)。

### RPC 模式

对于非 Node.js 的集成，请使用基于 stdin/stdout 的 RPC 模式：

```bash
pi --mode rpc
```

RPC 模式使用严格的以 LF 分隔的 JSONL 分帧。客户端必须仅按 `\n` 拆分记录。不要使用像 Node `readline` 这样的通用行读取器，它们还会按 JSON payload 内部的 Unicode 分隔符进行拆分。

协议参见 [docs/rpc.md](docs/rpc.md)。

---

## 理念

Pi 具有极强的可扩展性，因此无需规定你的工作流。其他工具内置的功能，可以用 [extensions](#extensions)、[skills](#skills) 构建，或从第三方 [pi packages](#pi-packages) 安装。这使核心保持极简，同时让你塑造 pi 以契合你的工作方式。

**没有 MCP。** 构建带有 README 的 CLI tools（参见 [Skills](#skills)），或构建一个添加 MCP 支持的 extension。[为什么？](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)

**没有 sub-agents。** 有很多方法可以实现。通过 tmux 启动 pi 实例，或用 [extensions](#extensions) 构建你自己的，或安装一个按你的方式实现的 package。

**没有权限弹窗。** 在容器中运行，或用 [extensions](#extensions) 构建符合你环境和安全要求的自定义确认流程。

**没有 plan mode。** 把计划写入文件，或用 [extensions](#extensions) 构建它，或安装一个 package。

**没有内置 to-dos。** 它们会让 models 困惑。使用 TODO.md 文件，或用 [extensions](#extensions) 构建你自己的。

**没有后台 bash。** 使用 tmux。完全可观测，直接交互。

完整理由请阅读[博客文章](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)。

---

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
pi update --all              # Update pi and packages
pi update --extensions       # Update packages only
pi update --models           # Refresh model catalogs only
pi update --self             # Update pi only
pi update --self --force     # Reinstall pi even if current
pi update --extension <src>  # Update one package
pi list                      # List installed packages
pi config                    # Enable/disable package resources
```

`pi config` 和项目 package 命令接受 `--approve`/`--no-approve`，以便为单条命令信任或忽略项目本地 settings。`pi update` 从不提示项目信任。

### 模式

| 标志 | 说明 |
|------|-------------|
| （默认） | 交互模式 |
| `-p`, `--print` | 打印响应并退出 |
| `--mode json` | 将所有事件以 JSON lines 输出（参见 [docs/json.md](docs/json.md)） |
| `--mode rpc` | 用于进程集成的 RPC 模式（参见 [docs/rpc.md](docs/rpc.md)） |
| `--export <in> [out]` | 将 session 导出为 HTML |

在 print 模式下，pi 还会读取管道传入的 stdin 并将其合并到初始 prompt 中：

```bash
cat README.md | pi -p "Summarize this text"
```

### Model 选项

| 选项 | 说明 |
|--------|-------------|
| `--provider <name>` | Provider（anthropic、openai、google 等） |
| `--model <pattern>` | Model 模式或 ID（支持 `provider/id` 和可选的 `:<thinking>`） |
| `--api-key <key>` | API key（覆盖环境变量） |
| `--thinking <level>` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| `--models <patterns>` | 用于 Ctrl+P 循环的逗号分隔模式 |
| `--list-models [search]` | 列出可用的 models |

### Session 选项

| 选项 | 说明 |
|--------|-------------|
| `-c`, `--continue` | 继续最近的 session |
| `-r`, `--resume` | 浏览并选择 session |
| `--session <path\|id>` | 使用特定的 session 文件或部分 UUID |
| `--fork <path\|id>` | 将特定的 session 文件或部分 UUID Fork 到新 session |
| `--session-dir <dir>` | 自定义 session 存储目录 |
| `--no-session` | 临时模式（不保存） |
| `--name <name>`, `-n <name>` | 在启动时设置 session 显示名称 |

### Tool 选项

| 选项 | 说明 |
|--------|-------------|
| `--tools <list>`, `-t <list>` | 在内置、extension 和自定义 tools 中允许特定的 tool 名称 |
| `--exclude-tools <list>`, `-xt <list>` | 在内置、extension 和自定义 tools 中禁用特定的 tool 名称 |
| `--no-builtin-tools`, `-nbt` | 默认禁用内置 tools，但保持 extension/自定义 tools 启用 |
| `--no-tools`, `-nt` | 默认禁用所有 tools |

可用的内置 tools：`read`、`bash`、`powershell`（Windows）、`edit`、`write`、`grep`、`find`、`ls`

### Resource 选项

| 选项 | 说明 |
|--------|-------------|
| `-e`, `--extension <source>` | 从 path、npm 或 git 加载 extension（可重复） |
| `--no-extensions` | 禁用 extension 发现 |
| `--skill <path>` | 加载 skill（可重复） |
| `--no-skills` | 禁用 skill 发现 |
| `--prompt-template <path>` | 加载 prompt template（可重复） |
| `--no-prompt-templates` | 禁用 prompt template 发现 |
| `--theme <path>` | 加载 theme（可重复） |
| `--no-themes` | 禁用 theme 发现 |
| `--no-context-files`, `-nc` | 禁用 AGENTS.md 和 CLAUDE.md context 文件发现 |

将 `--no-*` 与显式标志结合使用，可精确加载你需要的内容，忽略 settings.json（例如 `--no-extensions -e ./my-ext.ts`）。

### 其他选项

| 选项 | 说明 |
|--------|-------------|
| `--system-prompt <text>` | 替换默认 prompt（context 文件和 skills 仍会被追加） |
| `--append-system-prompt <text>` | 追加到 system prompt |
| `--tui-mode <mode>` | TUI 模式：`regular`（默认）或实验性的 `fullscreen` |
| `--use-theme <name[/name]>` | 为本次运行设置初始交互 theme，而不更改 settings |
| `--verbose` | 强制详细启动输出 |
| `-a`, `--approve` | 为本次运行信任项目本地文件 |
| `-na`, `--no-approve` | 为本次运行忽略项目本地文件 |
| `--` | 停止选项解析；其余参数是 prompts 或 `@file` 输入 |
| `-h`, `--help` | 显示帮助 |
| `-v`, `--version` | 显示版本 |

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

# Model with provider prefix (no --provider needed)
pi --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
pi --model sonnet:high "Solve this complex problem"

# Limit model cycling
pi --models "claude-*,gpt-4o"

# Read-only mode
pi --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
pi --exclude-tools ask_question

# High thinking level
pi --thinking high "Solve this complex problem"
```

### 环境变量

| 变量 | 说明 |
|----------|-------------|
| `AI_AGENT` | 由 CLI 和 RPC 入口点设置为 `pi`，以便通用工具能将子进程归属到 Pi |
| `PI_CODING_AGENT` | 由 CLI 和 RPC 入口点设置为 `true`，以便子进程能检测到自己在 Pi 内运行 |
| `PI_CODING_AGENT_DIR` | 覆盖配置目录（默认：`~/.pi/agent`） |
| `PI_CODING_AGENT_SESSION_DIR` | 覆盖 session 存储目录（会被 `--session-dir` 覆盖） |
| `PI_PACKAGE_DIR` | 覆盖 package 目录（在 store 路径难以 tokenize 的 Nix/Guix 上很有用） |
| `PI_OFFLINE` | 禁用启动网络操作，包括更新检查、package 更新检查和安装/更新 telemetry |
| `PI_SKIP_VERSION_CHECK` | 在启动时跳过 Pi 版本更新检查。这会阻止对 `pi.dev` 的最新版本请求 |
| `PI_TELEMETRY` | 覆盖安装/更新 telemetry 和 provider 归属 headers。使用 `1`/`true`/`yes` 启用，或 `0`/`false`/`no` 禁用。这不会禁用更新检查 |
| `PI_CACHE_RETENTION` | 设置为 `long` 以启用扩展 prompt cache（Anthropic：1h，OpenAI：24h） |
| `VISUAL`, `EDITOR` | 当 `externalEditor` 未设置时，Ctrl+G 的回退外部编辑器；Windows 上默认为 Notepad，其他平台为 `nano` |

由 LLM 可调用的 `bash` 和 `powershell` tools 运行的命令还会收到当前 session 元数据：

| 变量 | 说明 |
|----------|-------------|
| `PI_SESSION_ID` | 当前 session ID |
| `PI_SESSION_FILE` | 绝对 session JSONL 路径；对临时 sessions 不设置 |
| `PI_PROVIDER` | 当前选中的 model provider |
| `PI_MODEL` | 当前选中的 model ID |
| `PI_REASONING_LEVEL` | 当前生效的 reasoning level |

这些值在每条命令启动时解析。语义、示例和自定义 tool 退出方式参见 [Environment Variables](docs/environment-variables.md#shell-tool-session-environment)。

---

## 贡献与开发

指南参见 [CONTRIBUTING.md](../../CONTRIBUTING.md)，设置、fork 和调试参见 [docs/development.md](docs/development.md)。

## License

MIT

## 另见

- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)：核心 LLM toolkit
- [@earendil-works/pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core)：Agent 框架
- [@earendil-works/pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui)：终端 UI 组件

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
