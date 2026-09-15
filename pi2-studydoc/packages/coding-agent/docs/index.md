# Pi 文档

Pi 是一个极简的终端 coding harness。它的设计目标是在核心保持小巧，同时通过 TypeScript extensions、skills、prompt templates、themes 和 pi packages 进行扩展。

## 快速开始

使用 npm 安装 Pi：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 会在安装期间禁用依赖生命周期脚本。Pi 在常规 npm 安装中不需要安装脚本。

在 Linux 或 macOS 上，你也可以使用安装器：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

要卸载 pi 本身，对于 curl 和 npm 安装请使用 npm：

```bash
npm uninstall -g @earendil-works/pi-coding-agent
```

对于 pnpm、Yarn 或 Bun 安装，请使用匹配的全局移除命令：`pnpm remove -g @earendil-works/pi-coding-agent`、`yarn global remove @earendil-works/pi-coding-agent` 或 `bun uninstall -g @earendil-works/pi-coding-agent`。

然后在一个项目目录中运行它：

```bash
pi
```

对于订阅制 provider，使用 `/login` 进行认证；或者在启动 pi 之前设置一个 API key，例如 `ANTHROPIC_API_KEY`。

完整的首次运行流程，请参阅 [快速开始](quickstart.md)。

## 从这里开始

- [快速开始](quickstart.md) - 安装、认证并运行第一个 session。
- [使用 Pi](usage.md) - 交互模式、斜杠命令、context 文件与 CLI 参考。
- [Providers](providers.md) - 内置 provider 的订阅与 API-key 设置。
- [llama.cpp](llama-cpp.md) - 运行本地 router 并通过 `/llama` 管理 models。
- [安全](security.md) - 项目 trust、sandbox 边界与漏洞报告。
- [容器化](containerization.md) - 使用 Gondolin、Docker 或 OpenShell 为 pi 提供 sandbox。
- [Settings](settings.md) - 全局与项目 settings。
- [Keybindings](keybindings.md) - 默认快捷键与自定义 keybindings。
- [Sessions](sessions.md) - session 管理、branch 与树导航。
- [Compaction](compaction.md) - context compaction 与 branch 摘要。

## 定制

- [Extensions](extensions.md) - 用于 tools、commands、events 和自定义 UI 的 TypeScript 模块。
- [Skills](skills.md) - 用于可复用的按需能力的 Agent Skills。
- [Prompt templates](prompt-templates.md) - 从斜杠命令展开的可复用 prompts。
- [Themes](themes.md) - 内置与自定义终端 themes。
- [Pi packages](packages.md) - 打包并分享 extensions、skills、prompts 和 themes。
- [自定义 models](models.md) - 为受支持的 provider API 添加 model 条目。
- [自定义 providers](custom-provider.md) - 实现自定义 API 与 OAuth 流程。

## 编程式用法

- [SDK](sdk.md) - 将 pi 嵌入 Node.js 应用。
- [RPC 模式](rpc.md) - 通过 stdin/stdout JSONL 集成。
- [JSON 事件流模式](json.md) - 带结构化事件的 print 模式。
- [TUI 组件](tui.md) - 为 extensions 构建自定义终端 UI。

## 参考

- [环境变量](environment-variables.md) - 可供 bash tools 使用的 Pi 进程配置与 session 元数据。
- [Session 格式](session-format.md) - JSONL session 文件格式、条目类型与 SessionManager API。

## 平台设置

- [Windows](windows.md)
- [Android 上的 Termux](termux.md)
- [tmux](tmux.md)
- [终端设置](terminal-setup.md)
- [Shell 别名](shell-aliases.md)

## 开发

- [开发](development.md) - 本地设置、项目结构与调试。
