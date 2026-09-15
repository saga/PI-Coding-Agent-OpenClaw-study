# 环境变量

Pi 以三种方式使用环境变量：

- 诸如 `PI_OFFLINE` 之类的变量用于配置 Pi 进程。
- Pi 会设置进程标记，使子进程能够识别 Pi 是启动它的 agent。
- 由 LLM 可调用的 shell 工具运行的命令会收到描述当前 session 的 `PI_*` 变量。

Provider API-key 变量在 [Providers](providers.md#environment-variables-or-auth-file) 中单独说明。

## 进程标记

CLI 与 RPC 入口会设置两个进程标记：

- `AI_AGENT=pi` 是一个通用标记，让工具链能够识别出 Pi 是启动该进程的 agent。
- `PI_CODING_AGENT=true` 是 Pi 专用的，让子进程能够检测到自己运行在 Pi 内部。

子进程会继承这两个标记。它们不是 session 特有的，并且当 Pi 通过 SDK 嵌入时不会自动设置。

## Shell 工具的 Session 环境

由 `bash` 和 `powershell` 工具运行的命令会收到当前 Pi session 状态：

| 变量 | 描述 |
|----------|-------------|
| `PI_SESSION_ID` | 当前 session ID |
| `PI_SESSION_FILE` | 当前 session JSONL 文件的绝对路径；对 ephemeral session 不设置 |
| `PI_PROVIDER` | 当前选中的 model provider |
| `PI_MODEL` | 当前选中的 model ID |
| `PI_REASONING_LEVEL` | 当前生效的 reasoning level：`off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max` |

这些值在每条命令启动时解析。因此，切换 model 或更改 reasoning level 会影响下一条 shell 命令，而无需重启 Pi。`PI_PROVIDER` 和 `PI_MODEL` 标识的是选中的 Pi model，而不是 router 可能在内部分流到的另一个上游 model。

当被问及正在运行的是哪个 model 或 provider 时，请检查这些变量，而不是从 system prompt 中推断答案：

```bash
printf '%s/%s\n' "$PI_PROVIDER" "$PI_MODEL"
printf 'reasoning=%s session=%s\n' "$PI_REASONING_LEVEL" "$PI_SESSION_ID"
```

当 session 是持久化的时，可以直接检查 session 文件：

```bash
if [ -n "$PI_SESSION_FILE" ]; then
  tail -n 1 "$PI_SESSION_FILE"
fi
```

这些变量会被注入到 LLM 可调用的 `bash` 和 `powershell` 工具中。它们不会被注入到用户输入的 `!` 或 `!!` 命令中。

### 自定义 Shell 工具

用 `createBashTool()` 或 `createPowerShellTool()` 创建的工具在注册到 Pi 时默认会暴露 session 环境。注入发生在 `spawnHook` 之前，因此 hook 会在 `ctx.env` 中收到这些变量：

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

可以独立于 spawn hook 禁用 session 元数据：

```typescript
const powershellTool = createPowerShellTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

禁用后，Pi 会移除这些变量继承来的值，使嵌套的 Pi 进程不会暴露过期的父 session 元数据。

## Pi 进程配置

这些变量由 Pi 自身读取：

| 变量 | 描述 |
|----------|-------------|
| `PI_CODING_AGENT_DIR` | 覆盖配置目录；默认是 `~/.pi/agent` |
| `PI_CODING_AGENT_SESSION_DIR` | 覆盖 session 存储；会被 `--session-dir` 覆盖 |
| `PI_PACKAGE_DIR` | 覆盖 package 目录，对 Nix/Guix store 路径有用 |
| `PI_OFFLINE` | 禁用启动时的网络操作，包括更新检查、package 更新以及安装/更新 telemetry |
| `PI_SKIP_VERSION_CHECK` | 禁用对 `pi.dev` 的最新版本请求 |
| `PI_TELEMETRY` | 覆盖安装/更新 telemetry 与 provider attribution headers：`1`/`true`/`yes` 或 `0`/`false`/`no` |
| `PI_CACHE_RETENTION` | 在支持的地方设为 `long` 以启用扩展的 provider prompt caching |
| `PI_SHARE_VIEWER_URL` | 覆盖 `/share` 使用的基础 URL |
| `PI_HARDWARE_CURSOR` | 设为 `1` 以显示硬件光标；参见 [Terminal setup](terminal-setup.md) |
| `PI_HYPERLINKS` | 用 `1`、`0` 或 `auto` 覆盖 OSC 8 超链接检测 |
| `PI_IMAGE_PROTOCOL` | 用 `kitty`、`iterm2`、`none` 或 `auto` 覆盖 inline image 检测 |
| `PI_TRUE_COLOR` | 用 `1`、`0` 或 `auto` 覆盖 truecolor 检测 |
| `PI_TUI_ESC_TIMEOUT` | 单独一个 ESC 之后等待多久才将其视为 Escape，单位为毫秒；SSH 下默认为 `100`，其他情况为 `10`。如果 Alt 键输入被误读为 Escape，请增大该值 |
| `VISUAL`、`EDITOR` | 当 `externalEditor` 未设置时的外部编辑器回退 |
| `HTTP_PROXY`、`HTTPS_PROXY` | 为出站 HTTP 请求配置代理 |

诸如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等 provider 凭据以及云 provider 配置列在 [Providers](providers.md#environment-variables-or-auth-file) 中。

`PI_SERVER_DIR` 和 `PI_SERVER_ID` 仅适用于 source-only 的 [experimental remote harness](development.md#experimental-remote-harness)，不适用于分发的构建产物。
