# 实验性客户端/服务器 service 切片

Facet 设置会根据其提供的非本地 token 生成每个宿主的 RPC service 目录。远程 service 源获取这些目录，并仅绑定消费 facet 所需的 service；不存在手写的内置 service 清单。在没有选定 Session 时，其延迟源将未解析的需求视为不可用，并让其 handle 保持断开。Attachment 会根据 worker 生成的目录验证它们，该目录会被缓存以供后续的分离代际使用。键控 service 会以空目录的形式水合，直到其所属功能生成一个实例。

| 范围 | Service | 当前切片 | 延续点 |
|---|---|---|---|
| server | `SessionDirectory` | 已实现复制状态 | 当身份机制落地时添加经过认证的按客户端投影 |
| server | `SessionManagement` | 已实现 create、remove、attach、detach | 添加经过认证的工作区授权 |
| server | `PresentationPlugins` | 准备所选 Session branch 匹配的 TUI 产物并重载该 branch | 添加经过认证的 plugin 策略 |
| session | `SessionPlugins` | 重载已配置的 Session facet 代际 | 添加协调的多 worker 重载报告 |
| session | `Models` | 已实现状态、默认持久化的选择、thinking、刷新 | 将 provider/auth 组合移到 plugin facet 之后 |
| session | `AgentController` | 面向 presentation 安全的 `AgentLane` 外观，用于提示、排队、中止、恢复、Compaction 与导航 | 仅当 presentation 需要时才添加新的 lane operation |
| session | `Transcript` | 带源事件元数据的复制 lane 状态 | 仅当另一个 presentation 需要时才添加投影 |
| presentation | `SlashCommands` | 进程本地的贡献注册表，带 model、thinking、compact、reload 与示例 hello 命令 | 仅当具体 plugin 切片需要时才添加更多 presentation hookpoint |
| presentation | `PresentationUI` | 进程本地的选择与状态能力 | 仅当命令需要时才添加范围狭窄的 UI 能力 |

`ServerServiceSource.connection` 与 `SessionServiceSource.attachment` 是已实现的本地控制状态。Session 目录、创建与地址 DTO 由这些 coding-agent service 契约所拥有，而非 `pi-protocol`；传输层将其 payload 视为不透明的 service 数据。

在 `PI_EXPERIMENTAL=1` 下，交互式 `pi client` 会在打开仅含 service 的聊天 TUI 之前创建并附加一个 Session。`pi client -c` 与 `pi client -r` 则改为附加最新的现有 Session，并保留其持久化的模型与 thinking 配置。模型选择可通过 `/model` 按需使用；它从来不是启动屏幕。presentation 始终使用稳定版 coding agent 的备用屏幕渲染器以及共享的 transcript/dock 视口。它加载已配置的 theme 资源，并使用稳定的终端明暗检测与外观变更通知。其复制状态供给稳定的编辑器、消息、tool、状态、theme 与 tool 渲染器组件。presentation 通过 `AgentController` 驱动 worker 拥有的主 lane，并在 controller 调用挂起期间渲染 `Transcript` service 的完整复制值。provider 仍然是唯一的 Harness reducer，并在发布每个事件之前修改 Transcript 跟踪的 snapshot。Chord 每次发布时都会刷新 compact operation，而每个客户端/状态配对都用一个独立的路径字典对它们进行编码。Chord 重建 presentation 副本，并拥有水合、排序与间隙检测。

前台服务器使用可重复的 `-e` 选项来建立其默认 Session 与 TUI facet。本地客户端则可以为它创建或恢复的 Session 选择包；该 branch 选择会随 Session 一起持久化，并且不会改变其他 worker 或服务器默认值。在附加之前，服务器要求 Chord 将常规的 `src/session.ts` 与 `src/tui.ts` 入口构建到独立的 `plugin-builds/` 目录中，将生成的 manifest 路径传递给该 Session worker，并返回匹配的 TUI 产物。Session worker 加载内置 facet 与单独拥有的 plugin 代际，然后创建一个活跃的 `FacetHost`。`/reload` 会原子地重新构建这些包，加载新的 plugin 候选，通过 `FacetHost.reload()` 完成切换，并处置已退役的代际。宿主创建的实现依赖（例如 `AgentLane`、`ModelRuntime` 与 `SettingsManager`）会直接传递给内置 facet 工厂；它们不会作为 service 暴露。TUI 加载已配置的 presentation facet，并添加一个私有桥接 facet，为 `ExperimentalClientTui` 消费已连接的服务器与所选 Session 的 service。其本地 presentation service 是 `SlashCommands`（拥有命令贡献）与 `PresentationUI`（在不暴露原始 TUI 的情况下暴露选择与状态渲染）。命令回调直接接收 Chord `Context`。Facet 显式消费 `AgentController` 以进行提示、转向或排队，并将结构化的 controller 结果返回给命令分发器。

宿主可以在所选 facet 声明的 service 形态未变时重载它们；保留的消费者保持相同的 service facade，而替换实现与单例 snapshot 被安装在其后。同步的 setup 期 `env.provide()`、`env.provideMany()`、`env.use()` 与 `env.observe()` 调用会生成内部依赖图；setup 不会重复声明式依赖列表，并且 service handle 在完整图通过验证之前保持断开。Provider 在消费者之前激活，observation 与其消费 facet 一起连接，facet 替换或宿主关闭会按反向依赖顺序处置受影响的生命周期。Server 与 Session 的 service token 是非本地的，并由其提供宿主自动发布。仅 presentation 的 hookpoint（例如 `SlashCommands`）显式本地化，永远不会进入 RPC 目录。

Facet 始终调用不带限定的 `env.use()` 或 `env.observe()`。宿主会在 facet 提供的 service 与已连接的 service 中解析每个 token。示例 plugin 包通过其 TUI facet 贡献 `/hello`。`examples/plugins/pi-example-plugin/` 是一个实际的 `@earendil-works/pi-example-plugin` 包：可重复的 `-e` 选项可将 plugin 包选作服务器默认值或用于某个 Session branch，Chord 会发现并构建其常规 facet，而已附加的 presentation 通过 `PresentationPlugins` 接收匹配的 TUI 产物。来自同一 plugin 的其他宿主 facet 保持为独立的 bundle 条目，而不是一个聚合的 plugin 对象。传输绑定保持为内部机制，而不是 facet 环境的一部分。`ExperimentalClientTui` 目前直接拥有终端渲染、状态订阅、导航与操作分发。服务器 provider 在其完整宿主环境存在之前保持直接组装。`packages/agent/docs/plugins.md` 中的问题对话框、diff 审查、Git、索引作业、canvas 与富本地 TUI service 示例是 extension 模式，而不是内置的 coding-agent service。私有引用、trace 载体与流控制保持为 protocol/host 基础设施切片，而不是 presentation service token。
