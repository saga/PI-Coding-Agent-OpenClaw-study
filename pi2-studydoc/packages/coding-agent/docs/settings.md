# Settings

Pi 使用 JSON settings 文件，其中项目 settings 覆盖全局 settings。

| 位置 | 作用域 |
|----------|-------|
| `~/.pi/agent/settings.json` | 全局（所有项目） |
| `.pi/settings.json` | 项目（当前目录） |

直接编辑，或使用 `/settings` 进行常见选项设置。要以交互方式保存启动 model 默认值，请使用 `/model` 并在所需 model 上按 Ctrl+S。要保存启动 thinking 等级，请使用 `/thinking` 并按 Ctrl+S。

## 项目 Trust

在交互式启动时，如果某个项目文件夹包含项目本地的 settings、resources 或项目 `.agents/skills`，并且在 `~/.pi/agent/trust.json` 中对该文件夹或其父文件夹没有已保存的决定，pi 会在 trust 之前先询问。Trust 一个项目允许 pi 加载 `.pi/settings.json` 和 `.pi` resources、安装缺失的项目 packages，并执行项目 extensions。

非交互模式（`-p`、`--mode json` 和 `--mode rpc`）不显示 trust 提示。在没有适用的已保存 trust 决定时，它们使用全局 settings 中的 `defaultProjectTrust`：`ask`（默认）和 `never` 会忽略那些项目 resources，而 `always` 会 trust 它们。传入 `--approve`/`-a` 或 `--no-approve`/`-na` 以为单次运行覆盖项目 trust。

如果没有 extension 或已保存的决定适用，`defaultProjectTrust` 控制回退行为。在 `~/.pi/agent/settings.json` 中将其设置为 `"ask"`、`"always"` 或 `"never"`，或使用 `/settings` 更改它。

`pi config` 和 package 命令使用相同的项目 trust 流程，但 `pi update` 从不提示。传入 `--approve` 以为单条命令 trust 项目本地的 settings，或传入 `--no-approve` 以忽略它们。

在交互模式下使用 `/trust` 为未来的 sessions 保存项目 trust 决定，包括对直接父文件夹的 trust。它仅写入 `~/.pi/agent/trust.json`；当前 session 不会被重新加载，因此请重启 pi 以使更改生效。

## 所有 Settings

### Model 与 Thinking

| Setting | Type | Default | 描述 |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | 启动 provider（例如 `"anthropic"`、`"openai"`；在 `/model` 中按 Ctrl+S 保存，或手动编辑） |
| `defaultModel` | string | - | 启动 model ID（在 `/model` 中按 Ctrl+S 保存，或手动编辑） |
| `defaultThinkingLevel` | string | - | 启动 thinking 等级（在 `/thinking` 中按 Ctrl+S 保存，或手动编辑）：`"off"`、`"minimal"`、`"low"`、`"medium"`、`"high"`、`"xhigh"`、`"max"` |
| `modelThinkingLevels` | object | - | 以 `"provider/modelId"` 为键的按 model 启动 thinking 等级；从 `/settings` → Default thinking level per model 配置，或手动编辑 |
| `hideThinkingBlock` | boolean | `false` | 在输出中隐藏 thinking blocks |
| `showCacheMissNotices` | boolean | `false` | 为显著的 prompt-cache miss、compaction 或 branch-summary 用量，以及 provider 恢复诊断（例如被丢弃的 Anthropic thinking blocks）显示 transcript 通知 |
| `thinkingBudgets` | object | - | 每个 thinking 等级的自定义 token 预算。Anthropic、Google 和 Bedrock 原生使用这些值。OpenAI 兼容的 models 在设置了 `compat.thinkingTokenBudgetField`（或 `supportsThinkingTokenBudget`）时使用它们。 |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI 与 Display

| Setting | Type | Default | 描述 |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme 名称（`"dark"`、`"light"` 或自定义） |
| `externalEditor` | string | `$VISUAL`，然后是 `$EDITOR`，然后是 Windows 上的 Notepad 或其他平台的 `nano` | 用于 Ctrl+G 外部编辑器的命令；优先于环境变量 |
| `quietStartup` | boolean | `false` | 隐藏启动头部 |
| `defaultProjectTrust` | string | `"ask"` | 回退的项目 trust 行为：`"ask"`、`"always"` 或 `"never"`。仅限全局 setting |
| `collapseChangelog` | boolean | `false` | 在更新后显示精简的 changelog |
| `enableInstallTelemetry` | boolean | `true` | 发送匿名安装/更新 ping 以及选定的 provider 归属 headers。这不控制更新检查 |
| `enableAnalytics` | boolean | `false` | 选择加入的 analytics 数据分享。目前仅在实验性的首次设置（`PI_EXPERIMENTAL=1`）期间询问 |
| `trackingId` | string | - | Analytics 跟踪标识符，在 `enableAnalytics` 打开时生成 |
| `doubleEscapeAction` | string | `"tree"` | 双击 escape 的 action：`"tree"`、`"fork"` 或 `"none"` |
| `treeFilterMode` | string | `"default"` | `/tree` 的默认过滤器：`"default"`、`"no-tools"`、`"user-only"`、`"labeled-only"`、`"all"` |
| `editorPaddingX` | number | `0` | 输入编辑器的水平内边距（0-3） |
| `outputPad` | number | `1` | 用户消息、assistant 消息和 thinking 的水平内边距（0 或 1） |
| `autocompleteMaxVisible` | number | `5` | 自动补全下拉列表中可见条目的最大数量（3-20） |
| `showHardwareCursor` | boolean | `false` | 在 TUI 为 IME 支持定位终端光标时显示该光标 |
| `tuiMode` | string | `"regular"` | 交互式 TUI 模式：`"regular"` 或实验性的 `"fullscreen"`。来自 `/settings` 的更改立即生效；`--tui-mode` 在启动时覆盖此 setting |
| `fullscreenExitOutput` | string | `"transcript"` | Fullscreen 退出输出：`"transcript"` 打印最终 transcript 和恢复提示，而 `"resume-hint"` 恢复之前的屏幕并仅打印恢复提示。在 regular TUI 模式下无效 |
| `fullscreenScrollbar` | string | `"auto"` | Fullscreen transcript 滚动条：`"auto"` 在滚动时或指针位于其最右列轨道上时临时显示它，`"always"` 保留该列并使其保持可见，`"hidden"` 隐藏它。在 regular TUI 模式下无效 |
| `fullscreenCopyOnSelect` | boolean | `true` | 在 fullscreen 模式下自动复制选中的文本。禁用时，选区保持高亮，且 `Ctrl+X` 复制当前选区 |

对于 VS Code，包含 `--wait`，以便 pi 在编辑器退出后恢复：

```json
{
  "externalEditor": "code --wait"
}
```

### Telemetry 与更新检查

`enableInstallTelemetry` 控制发往 `https://pi.dev/api/report-install` 的匿名安装/更新 ping，以及 OpenRouter、NVIDIA NIM 和 Cloudflare provider 请求的 Pi 归属 headers。选择退出会同时禁用两者。它不会禁用更新检查；Pi 仍然可以获取 `https://pi.dev/api/latest-version` 以查找最新版本。

设置 `PI_SKIP_VERSION_CHECK=1` 以禁用 Pi 版本更新检查。使用 `--offline` 或 `PI_OFFLINE=1` 禁用此处描述的所有启动网络操作，包括更新检查、package 更新检查以及安装/更新 telemetry。

### 网络

| Setting | Type | Default | 描述 |
|---------|------|---------|-------------|
| `httpProxy` | string | - | 作为 `HTTP_PROXY` 和 `HTTPS_PROXY` 应用的 HTTP proxy URL。仅限全局 setting。 |

```json
{
  "httpProxy": "http://127.0.0.1:7890"
}
```

### 警告

| Setting | Type | Default | 描述 |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | 当 Anthropic 订阅认证可能使用付费额外用量时显示警告 |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | 描述 |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | 启用自动 compaction |
| `compaction.reserveTokens` | number | `16384` | 为 LLM 回复保留的 tokens |
| `compaction.keepRecentTokens` | number | `20000` | 保留的近期 tokens（不进行摘要） |
| `compaction.modelOverrides` | object | - | 以精确的 `"provider/modelId"` 为键的按 model `reserveTokens` 和 `keepRecentTokens` 覆盖 |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

#### 按 model 的 compaction 覆盖

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "modelOverrides": {
      "some-provider/big-model": {
        "reserveTokens": 400000
      },
      "local/small-model": {
        "reserveTokens": 2048,
        "keepRecentTokens": 4096
      }
    }
  }
}
```

键匹配精确、区分大小写的 `provider/modelId` 值，而不是名称或 glob 模式。Model ID 可能包含斜杠（例如 `openrouter/anthropic/claude-sonnet-4`）。

每个 token setting 独立解析：匹配的 model 覆盖 → 普通的 `compaction` setting → 内置默认值。在示例中，`some-provider/big-model` 保留普通的 20000 近期 tokens。Token 值必须是非负安全整数。匹配的 model 覆盖中的无效值在读取时会产生错误；只有被省略的字段才回退到普通 setting。Model 覆盖条目必须是对象。无效的普通 token settings 在读取时会产生错误，即使活动 model 有有效的覆盖也是如此。只有被省略的普通值才使用内置默认值。零是被接受的，但 `reserveTokens: 0` 不留下回复余量，并且还会将摘要输出预算设置为零。

全局与项目 settings 在 model 查找**之前**递归合并。项目可以为某个 model 覆盖一个字段，而不替换它的其他字段或其他 models。全局的 model 特定值优先于项目范围的回退值；在项目中覆盖同一个 model 条目即可更改它。

`enabled` 不是 model 特定的。活动 model 的 token settings 适用于手动 compaction、自动阈值检查（包括在 assistant 回合之间）以及溢出恢复。切换 models 会在下一次检查或 compaction 时生效。在 JSON 中配置覆盖；`/settings` 保留普通的自动 compaction 开关。

有关触发与摘要行为，请参阅 [compaction.md](compaction.md)。

### Branch 摘要

| Setting | Type | Default | 描述 |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | 选择 branch 历史时保留的 tokens；输出上限为 4096 tokens |
| `branchSummary.skipPrompt` | boolean | `false` | 在 `/tree` 导航时跳过 "Summarize branch?" prompt（默认为不摘要） |

### Retry

| Setting | Type | Default | 描述 |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | 在瞬时错误上启用自动的 agent 级 retry |
| `retry.maxRetries` | number | `3` | agent 级 retry 的最大尝试次数 |
| `retry.baseDelayMs` | number | `2000` | agent 级指数退避的基础延迟（2s、4s、8s） |
| `retry.maxAgentDelayMs` | number | `60000` | agent 级 retry 的最大延迟（60s） |
| `retry.provider.timeoutMs` | number | SDK 默认值 | Provider/SDK 请求超时，以毫秒为单位 |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK retry 尝试次数 |
| `retry.provider.maxRetryDelayMs` | number | `60000` | 失败前服务器请求的最大延迟（60s） |

Agent 级 retries 使用由 `retry.maxAgentDelayMs` 限制上限的指数退避，因此在长时间中断后，较长的 retry 运行仍能保持响应。

当 provider 请求的 retry 延迟长于 `retry.provider.maxRetryDelayMs` 时，请求会立即失败并给出信息性错误，而不是静默等待。将其设置为 `0` 以禁用该限制。

除非明确需要 provider 级 retries，否则请将 `retry.provider.maxRetries` 保持为 `0`。将其设置为大于 `0` 可能使 SDK/provider retries 在 Pi 看到 out-of-usage-limit 错误之前就处理它们，这在某些情况下可能会阻塞 agent，直到 provider 配额重置。

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "maxAgentDelayMs": 60000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### 消息投递

| Setting | Type | Default | 描述 |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | steering 消息如何发送：`"all"` 或 `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | follow-up 消息如何发送：`"all"` 或 `"one-at-a-time"` |
| `transport` | string | `"auto"` | 对于支持多种 transports 的 providers，首选的 transport：`"sse"`、`"websocket"`、`"websocket-cached"` 或 `"auto"` |
| `httpIdleTimeoutMs` | number | `300000` | HTTP header/body 空闲超时，以毫秒为单位，也被具有显式 stream 空闲超时的 providers 使用。设置为 `0` 以禁用。 |
| `websocketConnectTimeoutMs` | number | `15000` | 对于支持 WebSocket transports 的 providers，WebSocket 连接/打开握手超时，以毫秒为单位。设置为 `0` 以禁用。 |

### 终端与图片

| Setting | Type | Default | 描述 |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | 在终端中显示图片（如果支持） |
| `terminal.imageWidthCells` | number | `60` | 首选的 inline image 宽度，以终端单元格为单位 |
| `terminal.clearOnShrink` | boolean | `false` | 当内容收缩时清除空行（可能导致闪烁） |
| `terminal.hyperlinks` | boolean 或 `"auto"` | `"auto"` | 覆盖 OSC 8 超链接支持（高级，仅限 JSON） |
| `terminal.images` | string 或 boolean | `"auto"` | 使用 `"kitty"`、`"iterm2"`、`false` 或 `"auto"` 覆盖 image protocol 支持（高级，仅限 JSON） |
| `terminal.trueColor` | boolean 或 `"auto"` | `"auto"` | 覆盖 truecolor 支持（高级，仅限 JSON） |
| `images.autoResize` | boolean | `true` | 将图片调整为最大 2000x2000。适用于 `@file` attachments、`read` 以及 tools 返回的图片 |
| `images.blockImages` | boolean | `false` | 阻止所有图片被发送到 LLM |

### Shell

| Setting | Type | Default | 描述 |
|---------|------|---------|-------------|
| `shellPath` | string | - | 自定义 shell 路径（例如用于 Windows 上的 Cygwin）；支持以 `~` 开头表示主目录 |
| `shellCommandPrefix` | string | - | 每条 bash 命令的前缀（例如 `"shopt -s expand_aliases"`） |
| `npmCommand` | string[] | - | 用于 npm package 查找/安装操作的命令 argv（例如 `["mise", "exec", "node@20", "--", "npm"]`） |

JSON 中的 Windows 路径必须使用正斜杠或转义的反斜杠：

```json
{
  "shellPath": "C:/Program Files/Git/bin/bash.exe"
}
```

```json
{
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
}
```

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` 用于所有 npm package-manager 操作，包括安装、卸载以及 git packages 内部的依赖安装。用户作用域的 npm packages 安装到 `~/.pi/agent/npm/` 下；项目作用域的 npm packages 安装到 `.pi/npm/` 下。使用 argv 风格的条目，与进程应被启动的方式完全一致。当配置了 `npmCommand` 时，git package 依赖安装使用普通的 `install`，以避免在包装器或替代 package managers 中出现 npm 特定的 flags。

### Tools

| Setting | Type | Default | 描述 |
|---------|------|---------|-------------|
| `defaultTools` | string[] | - | 初始启用的内置 tools。省略时，Pi 使用其标准默认值 |

`defaultTools` 选择启动时启用的内置 tools。Extension 和 SDK 自定义 tools 保持启用。可用的内置 tools 为 `read`、`bash`、`powershell`、`edit`、`write`、`grep`、`find` 和 `ls`：

```json
{
  "defaultTools": ["bash", "edit", "write"]
}
```

在 Windows 上，选择 `powershell` 而不是 `bash`，或同时包含两者：

```json
{
  "defaultTools": ["read", "powershell", "edit", "write"]
}
```

空数组启动时不带任何内置 tools，同时保留 extension 和 SDK 自定义 tools。`--tools` 用对所有 tools 的严格 allowlist 替换此行为，`--no-tools` 禁用所有 tools，而 `--no-builtin-tools` 禁用内置默认值。`--exclude-tools` 过滤结果列表。项目的 `defaultTools` 数组会替换全局数组。

### Sessions

| Setting | Type | Default | 描述 |
|---------|------|---------|-------------|
| `sessionDir` | string | - | 存储 session 文件的目录。接受绝对路径或相对路径，以及 `~`。 |

```json
{ "sessionDir": ".pi/sessions" }
```

当多个来源指定 session 目录时，优先级为 `--session-dir`、`PI_CODING_AGENT_SESSION_DIR`，然后是 settings.json 中的 `sessionDir`。

### Model 循环切换

| Setting | Type | Default | 描述 |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | 用于 Ctrl+P 循环切换的 model 模式（与 `--models` CLI flag 格式相同） |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | 描述 |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | 代码块的缩进 |
| `markdown.mermaid` | string | `"streaming"` | Mermaid 渲染模式：`"off"`、`"final"` 或 `"streaming"` |

### Resources

这些 settings 定义从何处加载 extensions、skills、prompts 和 themes。

`~/.pi/agent/settings.json` 中的路径相对于 `~/.pi/agent` 解析。`.pi/settings.json` 中的路径相对于 `.pi` 解析。支持绝对路径和 `~`。

| Setting | Type | Default | 描述 |
|---------|------|---------|-------------|
| `packages` | array | `[]` | 从中加载 resources 的 npm/git packages |
| `extensions` | string[] | `[]` | 本地 extension 文件路径或目录 |
| `skills` | string[] | `[]` | 本地 skill 文件路径或目录 |
| `prompts` | string[] | `[]` | 本地 prompt template 路径或目录 |
| `themes` | string[] | `[]` | 本地 theme 文件路径或目录 |
| `enableSkillCommands` | boolean | `true` | 将 skills 注册为 `/skill:name` 命令 |

数组支持 glob 模式与排除项。使用 `!pattern` 排除。使用 `+path` 强制包含精确路径，使用 `-path` 强制排除精确路径。

#### packages

字符串形式从 package 加载所有 resources：

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

对象形式过滤要加载的 resources：

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

有关 package 管理详情，请参阅 [packages.md](packages.md)。

## 示例

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "modelThinkingLevels": {
    "anthropic/claude-sonnet-4-20250514": "high"
  },
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## 项目覆盖

项目 settings（`.pi/settings.json`）覆盖全局 settings。嵌套对象会被合并：

```json
// ~/.pi/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .pi/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
