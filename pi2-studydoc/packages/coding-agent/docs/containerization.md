# 容器化

Pi 默认以所有权限运行，但在某些情况下，你会希望更精细地控制 Pi 可以写入哪些目录以及它拥有哪些访问权限。

有两种通用的选项。你可以
1. 在隔离环境中运行整个 `pi` 进程，或者
2. 在宿主上运行 `pi`，并将 tool 执行路由到隔离环境中。

## 选择一种模式

| Pattern | 隔离的内容 | 最适合 | 备注 |
| --- | --- | --- | --- |
| Gondolin extension | 内置 tools 和 `!` 命令 | 在将认证保留在宿主上的同时实现本地 micro-VM 隔离 | 请参阅 [`examples/extensions/gondolin/`](../examples/extensions/gondolin/)。 |
| Plain Docker | 本地 container 中的整个 `pi` 进程 | 简单的本地隔离 | Provider API keys 会进入 container。 |
| OpenShell | 策略控制的 sandbox 中的整个 `pi` 进程 | 本地或远程的受管 sandbox | 需要一个 OpenShell gateway |
| Docker Sandboxes | 受管 sandbox 中的整个 `pi` 进程 | 将 provider keys 保留在宿主上的本地隔离 | 需要 Docker Sandboxes（`sbx`）。 |

Extensions 在 `pi` 进程运行的地方运行。如果你在宿主上运行 `pi` 并使用 tool-routing extension，其他自定义 extension tools 仍会在宿主上运行，除非它们也委托自己的 operations。

## Gondolin

[Gondolin](https://github.com/earendil-works/gondolin) 是一个本地 Linux micro-VM。
当你希望 `pi` 在宿主上、但所有内置 tools 都路由到 VM 中时，请使用[示例 extension](../examples/extensions/gondolin)。

设置：

```bash
cp -R packages/coding-agent/examples/extensions/gondolin ~/.pi/agent/extensions/gondolin
cd ~/.pi/agent/extensions/gondolin
npm install --ignore-scripts
```

从你想挂载的项目中运行：

```bash
cd /path/to/project
pi -e ~/.pi/agent/extensions/gondolin
```

该 extension 将宿主的 cwd 挂载到 VM 中的 `/workspace`，并覆盖 `read`、`write`、`edit`、`bash`、`grep`、`find` 和 `ls`。
用户的 `!` 命令也会被路由到 VM 中。
`/workspace` 下的文件更改会写穿到宿主。

要求：`@earendil-works/gondolin` 需要 Node.js >= 23.6.0，以及 QEMU（需要通过你的 package manager 安装）。

## Plain Docker

当你想要最简单的本地 container 边界时，在 Docker 中运行整个 `pi` 进程。

`Dockerfile.pi`：

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

WORKDIR /workspace
ENTRYPOINT ["pi"]
```

构建并运行：

```bash
docker build -t pi-sandbox -f Dockerfile.pi .

docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v pi-agent-home:/root/.pi/agent \
  pi-sandbox
```

`-v "$PWD:/workspace"` 将你的当前目录挂载到 container 中的 /workspace，使得 Docker 内 `/workspace` 中的读写会直接影响你的宿主文件，就像 Gondolin 示例中那样。

如果你想要 container 本地的 settings 和 sessions，请为 `/root/.pi/agent` 使用具名 volume。挂载宿主的 `~/.pi/agent` 会将宿主的认证和 session 文件暴露给 container。

## OpenShell

当你想要一个具有文件系统、进程、网络、凭据和推理控制的策略控制 sandbox 时，请使用 [NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview)。
OpenShell 可以通过由 Docker、Podman 或 VM runtime 支持的本地 gateway，或通过远程 Kubernetes gateway 来运行 sandboxes。

每个 sandbox 都需要一个活动的 gateway。
在创建 sandbox 之前，请注册并选择一个：

```bash
openshell gateway add <gateway-url> --name <name>
openshell gateway select <name>
```

在 OpenShell sandbox 内启动 `pi`：

```bash
openshell sandbox create --name pi-sandbox --from pi -- pi
```

在这种模式下，整个 `pi` 进程在 sandbox 内运行。
内置 tools、`!` 命令和 extension tools 在 OpenShell 边界内执行。

如果 gateway 是远程的，项目文件不会从宿主 bind-mount，这意味着 sandbox 中的写入不会反映到你的机器上。
在 sandbox 内 clone 仓库，或使用 OpenShell 文件传输命令：

```bash
openshell sandbox upload pi-sandbox ./repo /workspace
openshell sandbox download pi-sandbox /workspace/repo ./repo-out
```

OpenShell providers 可以将原始 model API keys 保留在 sandbox 之外。
当配置了 inference routing 时，sandbox 内的代码可以调用 `https://inference.local`，并且 gateway 会在上游注入已配置的 provider 凭据。
如果你希望 model 流量使用此路由，请将 Pi 配置为使用相应的 OpenAI 兼容或 Anthropic 兼容 endpoint。

## Docker Sandboxes

[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) 是 Docker 提供的受管 sandbox runtime，它在 sandbox 内运行整个 `pi` 进程。
它是 [No Built-in Sandbox](security.md#no-built-in-sandbox) 所指的 container 边界之一。

与上面的 Plain Docker 模式不同，provider 凭据不会传入 container。
sandbox 改为接收一个 sentinel 值，`sbx` proxy 在出口到 `api.anthropic.com` 时替换为真实凭据。
凭据在创建时接线，因此在创建 sandbox 之前请先将你的凭据存储在宿主上。

对于 Claude Pro/Max 订阅，请在一台装有 Claude Code 的机器上运行 `claude setup-token`，然后将结果存储在宿主上。
如果已经绑定了一个 `anthropic` secret，请先移除它：否则 proxy 会在 Bearer token 之外添加一个 `x-api-key` header，而 Anthropic 会拒绝该请求。
`sbx secret set-custom` 从 stdin 读取 token，因此它不会留在 shell 历史中。

```bash
sbx secret rm anthropic

sbx secret set-custom \
  --host api.anthropic.com \
  --env ANTHROPIC_OAUTH_TOKEN \
  --placeholder 'sk-ant-oat01-{rand}'
```

sandbox 得到的是一个 OAuth 形式的占位符，而不是真实 token，proxy 在出口到该宿主时会替换它；`ANTHROPIC_OAUTH_TOKEN` 是 pi 已经读取并优先于 API key 的变量，因此不需要额外的 pi 配置。

对于 API key，请改用 `sbx secret set anthropic` 存储它。该 kit 以相同的方式接线它，作为 proxy 在出口时替换的 sentinel。

在凭据存储后，从你想挂载的项目中启动 `pi`：

```bash
sbx run --kit "docker.io/sbx/pi-kit:latest" pi
```

该 kit 将 `pi` 预先烘焙到其镜像中，因此 sandbox 启动时无需安装任何东西，并且当前目录就是 sandbox workspace。

不要从 sandbox 内部进行认证：在那里运行 `/login` 会将真实 token 写入 container，并破坏 proxy 模型。

脚本化使用的工作方式相同：

```bash
sbx exec <sandbox-name> -- pi -p "list the failing tests"
```

有关完整的凭据矩阵、故障排除和 pinning，请参阅 [kit 文档](https://github.com/docker/sbx-kits-contrib/tree/main/pi)。
