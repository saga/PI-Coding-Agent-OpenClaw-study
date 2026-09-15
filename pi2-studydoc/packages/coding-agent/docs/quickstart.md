# 快速开始

本页将带你从安装走到第一个有用的 pi session。

## 安装

Pi 以 npm package 的形式分发：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 会在安装期间禁用依赖的生命周期脚本。对于常规的 npm 安装，Pi 不需要安装脚本。

### 卸载

请使用当初安装 pi 的那个 package manager。curl 安装器使用的是全局 npm，因此 curl 与 npm 安装都通过 npm 卸载：

```bash
# curl installer or npm install -g
npm uninstall -g @earendil-works/pi-coding-agent

# pnpm
pnpm remove -g @earendil-works/pi-coding-agent

# Yarn
yarn global remove @earendil-works/pi-coding-agent

# Bun
bun uninstall -g @earendil-works/pi-coding-agent
```

卸载 pi 后，设置、凭据、sessions 以及已安装的 pi packages 仍会保留在 `~/.pi/agent/` 中。

然后在你希望 pi 处理的项目目录中启动 pi：

```bash
cd /path/to/project
pi
```

## 身份验证

Pi 可以通过 `/login` 使用订阅类 provider，也可以通过环境变量或 auth 文件使用 API key 类 provider。

### 方式 1：订阅登录

启动 pi 并运行：

```text
/login
```

然后选择一个 provider。内置的订阅登录包括 Claude Pro/Max、ChatGPT Plus/Pro（Codex）和 GitHub Copilot。

### 方式 2：API key

在启动 pi 之前设置 API key：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

你也可以运行 `/login` 并选择一个 API key 类 provider，将 key 存储到 `~/.pi/agent/auth.json`。

所有受支持的 provider、环境变量以及云 provider 的设置请参见 [Providers](providers.md)。

## 第一个 session

pi 启动后，输入请求并按 Enter：

```text
Summarize this repository and tell me how to run its checks.
```

默认情况下，pi 会为模型提供四个 tools：

- `read` - read files
- `write` - create or overwrite files
- `edit` - patch files
- `bash` - run shell commands

额外的内置只读 tools（`grep`、`find`、`ls`）可通过 tool options 启用。Pi 会在你当前的工作目录中运行，并且可以修改其中的文件。如果你希望便于回滚，请使用 git 或其他检查点工作流。

## 给 pi 项目指令

Pi 会在启动时加载 context files。添加一个 `AGENTS.md` 文件来告诉它如何在该项目中工作：

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Pi 会加载：

- `~/.pi/agent/AGENTS.md` 作为全局指令
- 来自各级父目录和当前目录的 `AGENTS.md` 或 `CLAUDE.md`

如果某个目录中存在 `AGENTS.override.md`，Pi 会加载它，而不是该目录中的 `AGENTS.md` 或 `CLAUDE.md`。

更改 context files 后，请重启 pi，或运行 `/reload`。

## 常见操作尝试

### 引用文件

在编辑器中输入 `@` 可模糊搜索文件，或在命令行上直接传入文件：

```bash
pi @README.md "Summarize this"
pi @src/app.ts @src/app.test.ts "Review these together"
```

图像或文本可以用 Ctrl+V 粘贴（Windows 上为 Alt+V）；图像也可以拖入支持该功能的终端。

### 运行 shell 命令

在交互模式下：

```text
!npm run lint
```

命令输出会发送给模型。使用 `!!command` 可以在运行命令时不把其输出加入模型 context。

### 切换模型

使用 `/model` 或 Ctrl+L 为当前 session 选择模型。在模型选择器中按 Ctrl+S 可将高亮的模型保存为启动默认值。使用 `/thinking` 为当前 session 选择思考等级，或在该选择器中按 Ctrl+S 保存启动默认思考等级。使用 Shift+Tab 循环切换思考等级。使用 Ctrl+P / Shift+Ctrl+P 循环切换 scoped models。

### 稍后继续

Sessions 会自动保存：

```bash
pi -c                  # Continue most recent session
pi -r                  # Browse previous sessions
pi --name "my task"    # Set session display name at startup
pi --session <path|id> # Open a specific session
```

在 pi 内部，可使用 `/resume`、`/new`、`/tree`、`/fork` 和 `/clone` 来管理 sessions。

### 非交互模式

用于一次性 prompt：

```bash
pi -p "Summarize this codebase"
cat README.md | pi -p "Summarize this text"
pi -p @screenshot.png "What's in this image?"
```

使用 `--mode json` 输出 JSON 事件，或使用 `--mode rpc` 进行进程集成。

## 后续步骤

- [Using Pi](usage.md) - 交互模式、斜杠命令、sessions、context files 以及 CLI 参考。
- [Providers](providers.md) - 身份验证与模型设置。
- [Settings](settings.md) - 全局与项目配置。
- [Keybindings](keybindings.md) - 快捷键与自定义。
- [Pi Packages](packages.md) - 安装共享的 extensions、skills、prompts 和 themes。

平台说明：[Windows](windows.md)、[Termux](termux.md)、[tmux](tmux.md)、[Terminal setup](terminal-setup.md)、[Shell aliases](shell-aliases.md)。
