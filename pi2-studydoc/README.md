<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> 来自新贡献者的新 issue 和 PR 默认会被自动关闭。维护者每天审查被自动关闭的 issue。参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

# Pi Agent Harness

这里是 Pi agent harness 项目的主页，其中包括我们的可自扩展 coding agent。

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**：交互式 coding agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**：带有 tool calling 和状态管理的 agent 运行时
* **[@earendil-works/pi-ai](packages/ai)**：统一的多 provider LLM API（OpenAI、Anthropic、Google……）

要了解更多关于 Pi 的信息：

* [访问 pi.dev](https://pi.dev)，这是带有演示的项目网站
* [阅读文档](https://pi.dev/docs/latest)，不过你也可以让 agent 自己解释自己

## 所有包

| 包 | 描述 |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | 用于 service、复制状态、RPC 和 plugin 的独立应用组合运行时 |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | 厂商中立的 telemetry 契约、参考适配器、一致性测试和类型化 schema |
| **[@earendil-works/pi-ai](packages/ai)** | 统一的多 provider LLM API（OpenAI、Anthropic、Google 等） |
| **[@earendil-works/pi-agent-core](packages/agent)** | 带有 tool calling 和状态管理的 agent 运行时 |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | 交互式 coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | 带有差分渲染的终端 UI 库 |

关于 Slack/chat 自动化和工作流，参见 [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat)。

## 权限与容器化

Pi 不包含用于限制文件系统、进程、网络或凭据访问的内置权限系统。默认情况下，它以启动它的用户和进程的权限运行。

如果你需要更强的边界，请对 Pi 进行容器化或 sandbox 化。关于三种模式，参见 [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md)：

- **Gondolin extension**：将 `pi` 和 provider auth 保留在宿主机上，同时把内置 tool 和 `!` 命令路由到本地 Linux micro-VM 中。
- **Plain Docker**：在本地容器中运行整个 `pi` 进程，以实现简单隔离。
- **OpenShell**：在受策略控制的 sandbox 中运行整个 `pi` 进程。

## 贡献

关于贡献指南，参见 [CONTRIBUTING.md](CONTRIBUTING.md)；关于项目特定规则（同时面向人类和 agent），参见 [AGENTS.md](AGENTS.md)。  Pi 的较长期计划也可以在 [RFC](https://rfc.earendil.com/keyword/pi/) 中找到。

## 开发

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## 从发布源码构建独立二进制文件

GitHub release 包含一个带版本号的源码归档，由该 release 的 `SHA256SUMS` 文件覆盖。解压它，并运行与官方独立二进制文件相同的构建脚本：

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

该归档包含 release model data 和原生 prebuild。`--offline-model-data` 使用该 model data 而不刷新 provider catalog。该脚本会安装依赖，并连同其运行时资产一起构建可执行文件；如果依赖已经提供，请传入 `--skip-install`。

## 供应链加固

我们把 npm 依赖变更视为需要审查的代码变更。

- 直接外部依赖被固定到精确版本。内部 workspace 包仍保持版本范围。
- `.npmrc` 设置 `save-exact=true` 和 `min-release-age=2`，以避免在 npm 解析期间使用当日发布的依赖。
- `package-lock.json` 是依赖的唯一事实来源。pre-commit 会阻止意外的 lockfile 提交，除非设置了 `PI_ALLOW_LOCKFILE_CHANGE=1`。
- `npm run check` 会校验被固定的直接依赖、原生 TypeScript import 兼容性，以及生成的 coding-agent shrinkwrap。
- 发布的 CLI 包包含 `packages/coding-agent/npm-shrinkwrap.json`，它由根 lockfile 生成，用于为 npm 用户固定传递依赖。
- Release smoke test 使用 `npm run release:local` 在打 release tag 之前，于仓库之外构建、打包并创建隔离的 npm 和 Bun 安装。
- 本地 release 安装、文档化的 npm 安装以及 `pi update --self` 在受支持的情况下使用 `--ignore-scripts`。
- CI 使用 `npm ci --ignore-scripts` 安装，并且有一个定时的 GitHub workflow 运行 `npm audit --omit=dev` 以及 `npm audit signatures --omit=dev`。
- Shrinkwrap 生成对依赖生命周期脚本有明确的 allowlist；新增带生命周期脚本的依赖会导致检查失败，直到经过审查。

## 分享你的 OSS coding agent session

如果你使用 Pi 或其他 coding agent 进行开源工作，请分享你的 session。

公开的 OSS session 数据有助于用真实世界的任务、tool 使用、失败和修复来改进 coding agent，而不是用玩具基准。

关于完整说明，参见 [这篇 X 上的帖子](https://x.com/badlogicgames/status/2037811643774652911)。

要发布 session，请使用 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf)。阅读它的 README.md 了解设置说明。你只需要一个 Hugging Face 账号、Hugging Face CLI 和 `pi-share-hf`。

你也可以观看[这个视频](https://x.com/badlogicgames/status/2041151967695634619)，我在其中展示了我如何发布我的 `pi-mono` session。

我会定期在这里发布我自己的 `pi-mono` 工作 session：

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## 许可证

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
