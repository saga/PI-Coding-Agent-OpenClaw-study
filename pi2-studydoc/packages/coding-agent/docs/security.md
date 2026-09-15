# 安全

Pi 是一个本地 coding agent。它以启动它的用户账户的权限运行，并将该用户可写的文件视为处于同一个本地 trust 边界内。

## 项目 Trust

项目 trust 控制 pi 是否加载项目本地的 settings、resources、packages 和 extensions。它不是 sandbox，也不会限制在你开始在某个目录中工作后 model 可以要求 tools 做什么。

当 pi 从当前工作目录中发现以下任意一项时，它会认为该项目具有需要 trust 的 resources：

- `.pi/settings.json`
- `.pi/extensions`、`.pi/skills`、`.pi/prompts` 或 `.pi/themes`
- `.pi/SYSTEM.md` 或 `.pi/APPEND_SYSTEM.md`
- 当前目录或祖先目录中的项目 `.agents/skills`

一个空的 `.pi` 目录不算作需要 trust 的项目 resource。

当交互式 session 在具有需要 trust 的 resources、且对当前目录或父目录没有已保存决定的项目中启动时，pi 遵循全局 settings 中的 `defaultProjectTrust`。默认值为 `"ask"`，即在 UI 可用时询问是否 trust 该项目。已保存的决定按规范化目录存储在 `~/.pi/agent/trust.json` 中，当前路径或父路径上最近的已保存决定优先于全局默认值生效。

Trust 一个项目允许 pi 加载需要 trust 的项目 resources，包括：

- `.pi/settings.json`
- `.pi` resources，例如 extensions、skills、prompt templates、themes 和 system prompt 文件
- 通过项目 settings 配置的缺失项目 packages
- 项目本地的 extensions 以及由项目 package 管理的 extensions

拒绝 trust 会跳过受保护的 resources。除非 context 加载被禁用，否则诸如 `AGENTS.override.md`、`AGENTS.md` 和 `CLAUDE.md` 之类的 context 文件无论项目 trust 如何都会被加载。在 trust 被解决之前，pi 仅加载 context 文件、用户/全局 extensions 以及 CLI `-e` extensions。用户/全局和 CLI extensions 可以处理 `project_trust` 事件；第一个返回是/否决定的 extension 拥有该决定。

非交互模式（`-p`、`--mode json` 和 `--mode rpc`）不显示 trust 提示。在没有适用的已保存 trust 决定时，`defaultProjectTrust: "ask"` 和 `"never"` 会忽略此类 resources，而 `"always"` 会 trust 它们。使用 `--approve`/`-a` 或 `--no-approve`/`-na` 为单次运行覆盖项目 trust。

## 无内置 Sandbox

Pi 不包含内置 sandbox。内置 tools 可以以 pi 进程的权限读取文件、写入文件、编辑文件并运行 shell 命令。Extensions 是以相同权限运行的 TypeScript 模块。Package 安装、shell 命令、language servers、测试命令以及其他开发者 tools 的行为与普通的本地进程相同。

这是有意为之的。Pi 被设计为在本地源代码树上操作、调用项目工具链，并与用户现有的开发环境集成。一个部分的进程内 sandbox 很容易被误解为安全边界，同时仍然依赖于宿主 shell、文件系统、package managers、凭据和 extension 代码。真正的隔离需要来自操作系统或虚拟化/container 边界。

项目 trust 仅是一个输入加载防护。它防止仓库在你批准之前静默更改 pi 的 settings 或 extensions。它不会使不受信任的代码、不受信任的 prompts 或不受信任的 model 输出变得安全。来自仓库文件、注释、文档、context 文件或构建输出的 prompt injection 是预期的本地 agent 风险，pi 无法可靠地防止它。

## 运行不受信任或无人监控的工作

对于不受信任的仓库、你不打算密切监控的生成代码，或无人值守的自动化，请在受控环境中运行 pi。使用只包含任务所需文件和凭据的 container、VM、micro-VM、远程 sandbox 或策略控制的 sandbox。

常见模式记录在 [容器化](containerization.md) 中：

- 在 container/sandbox 内运行整个 `pi` 进程
- 在宿主上运行 pi，同时将内置 tool 执行路由到 Gondolin micro-VM 中
- 仅挂载 agent 应访问的 workspace 路径
- 避免挂载宿主 `~/.pi/agent`，除非 container 应访问宿主的 sessions、settings 和凭据
- 传递最低必需的 API keys 或使用短期凭据
- 当任务不需要网络访问时限制它
- 在将结果复制回受信任系统之前审查 diffs 和输出

如果你以读/写方式 bind-mount 宿主 workspace，来自 container 或 VM 内部的写入仍可能修改宿主文件。当你需要更强的保护以防止意外写入时，请使用只读挂载，或将文件复制进/出 sandbox。

## 报告安全问题

要报告安全问题，请遵循仓库的 [Security Policy](https://github.com/earendil-works/pi/blob/main/SECURITY.md)。不要为安全敏感的报告创建公开 issue。

预期的本地 agent 行为、缺少内置 sandbox、来自不受信任内容的 prompt injection，以及用户安装的 extensions 或 skills 的行为，通常都在安全边界之外，除非报告展示了真正的权限边界绕过，或显示了 pi 如何授予本地用户原本不具备的访问权限。
