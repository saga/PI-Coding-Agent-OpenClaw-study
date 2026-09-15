> pi 可以创建 extension。让它为你的使用场景构建一个。

# Extensions

Extension 是扩展 pi 行为的 TypeScript 模块。它们可以订阅生命周期事件、注册可供 LLM 调用的自定义 tool、添加命令，等等。

> **/reload 的放置位置：** 将 extension 放在 `~/.pi/agent/extensions/`（全局）或 `.pi/extensions/`（项目本地）以启用自动发现。仅在快速测试时使用 `pi -e ./path.ts`。位于自动发现位置中的 extension 可以通过 `/reload` 热重载。

**关键能力：**
- **自定义 tool** - 通过 `pi.registerTool()` 注册 LLM 可以调用的 tool
- **事件拦截** - 阻止或修改 tool 调用、注入 context、自定义 compaction
- **用户交互** - 通过 `ctx.ui` 提示用户（select、confirm、input、notify）
- **自定义 UI 组件** - 通过 `ctx.ui.custom()` 使用带键盘输入的完整 TUI 组件，以实现复杂交互
- **自定义命令** - 通过 `pi.registerCommand()` 注册类似 `/mycommand` 的命令
- **Session 持久化** - 通过 `pi.appendEntry()` 存储可在重启后存续的状态
- **自定义渲染** - 控制 tool 调用/结果以及消息在 TUI 中呈现的方式

**示例用例：**
- 权限闸门（在执行 `rm -rf`、`sudo` 等之前进行确认）
- Git 检查点（在每个 turn 进行 stash，在 branch 上恢复）
- 路径保护（阻止对 `.env`、`node_modules/` 的写入）
- 自定义 compaction（按你的方式总结对话）
- 对话摘要（参见 `summarize.ts` 示例）
- 交互式 tool（提问、向导、自定义对话框）
- 有状态 tool（todo 列表、连接池）
- 外部集成（文件监听器、webhook、CI 触发器）
- 等待时的游戏（参见 `snake.ts` 示例）

参见 [examples/extensions/](../examples/extensions/) 获取可运行的实现。

## 目录

- [快速开始](#quick-start)
- [Extension 位置](#extension-locations)
- [可用导入](#available-imports)
- [编写 Extension](#writing-an-extension)
  - [Extension 风格](#extension-styles)
- [事件](#events)
  - [生命周期概览](#lifecycle-overview)
  - [资源事件](#resource-events)
  - [Session 事件](#session-events)
  - [Agent 事件](#agent-events)
  - [Model 事件](#model-events)
  - [Tool 事件](#tool-events)
- [ExtensionContext](#extensioncontext)
- [ExtensionCommandContext](#extensioncommandcontext)
- [ExtensionAPI 方法](#extensionapi-methods)
- [状态管理](#state-management)
- [自定义 Tool](#custom-tools)
  - [动态 Tool 加载](#dynamic-tool-loading)
- [自定义 UI](#custom-ui)
- [错误处理](#error-handling)
- [模式行为](#mode-behavior)
- [示例参考](#examples-reference)

## 快速开始

创建 `~/.pi/agent/extensions/my-extension.ts`：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // React to events
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  // Register a custom tool
  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  // Register a command
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });
}
```

使用 `--extension`（或 `-e`）标志进行测试：

```bash
pi -e ./my-extension.ts
```

## Extension 位置

> **安全：** Extension 以你的完整系统权限运行，并且可以执行任意代码。只从你信任的来源安装。

Extension 会从受信任的位置自动发现。项目本地的 `.pi/extensions` 条目只有在项目被信任之后才会加载。

| 位置 | 作用域 |
|----------|-------|
| `~/.pi/agent/extensions/*.ts` | 全局（所有项目） |
| `~/.pi/agent/extensions/*/index.ts` | 全局（子目录） |
| `.pi/extensions/*.ts` | 项目本地 |
| `.pi/extensions/*/index.ts` | 项目本地（子目录） |

通过 `settings.json` 添加额外路径：

```json
{
  "packages": [
    "npm:@foo/bar@1.0.0",
    "git:github.com/user/repo@v1"
  ],
  "extensions": [
    "/path/to/local/extension.ts",
    "/path/to/local/extension/dir"
  ]
}
```

如需通过 npm 或 git 以 pi package 的形式分享 extension，参见 [packages.md](packages.md)。

## 可用导入

| Package | 用途 |
|---------|---------|
| `@earendil-works/pi-coding-agent` | Extension 类型（`ExtensionAPI`、`ExtensionContext`、事件） |
| `typebox` | tool 参数的 schema 定义 |
| `@earendil-works/pi-ai` | AI 工具（用于 Google 兼容枚举的 `StringEnum`） |
| `@earendil-works/pi-tui` | 用于自定义渲染的 TUI 组件 |

npm 依赖同样可用。在你的 extension 旁边（或父目录中）添加 `package.json`，运行 `npm install`，来自 `node_modules/` 的导入就会被自动解析。

对于使用 `pi install` 安装的分发 pi package（npm 或 git），运行时依赖必须放在 `dependencies` 中。Package 安装默认使用生产安装（`npm install --omit=dev`），因此 `devDependencies` 在运行时不可用；当配置了 `npmCommand` 时，git package 使用普通的 `install` 以兼容 wrapper。

Node.js 内置模块（`node:fs`、`node:path` 等）同样可用。

## 编写 Extension

Extension 导出一个默认工厂函数，该函数接收 `ExtensionAPI`。工厂可以是同步的或异步的：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Subscribe to events
  pi.on("event_name", async (event, ctx) => {
    // ctx.ui for user interaction
    const ok = await ctx.ui.confirm("Title", "Are you sure?");
    ctx.ui.notify("Done!", "info");
    ctx.ui.setStatus("my-ext", "Processing...");  // Footer status
    ctx.ui.setWidget("my-ext", ["Line 1", "Line 2"]);  // Widget above editor (default)
  });

  // Register tools, commands, shortcuts, flags
  pi.registerTool({ ... });
  pi.registerCommand("name", { ... });
  pi.registerShortcut("ctrl+x", { ... });
  pi.registerFlag("my-flag", { ... });
}
```

Extension 通过 [jiti](https://github.com/unjs/jiti) 加载，因此 TypeScript 无需编译即可运行。

如果工厂返回 `Promise`，pi 会在继续启动之前等待它完成。这意味着异步初始化会在 `session_start` 之前、在 `resources_discover` 之前、以及在通过 `pi.registerProvider()` 排队的 provider 注册被刷新之前完成。

### 异步工厂函数

对于一次性的启动工作，例如获取远程配置或动态发现可用的 model，使用异步工厂。

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/v1/models");
  const payload = (await response.json()) as {
    data: Array<{
      id: string;
      name?: string;
      context_window?: number;
      max_tokens?: number;
    }>;
  };

  pi.registerProvider("local-openai", {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "$LOCAL_OPENAI_API_KEY",
    api: "openai-completions",
    models: payload.data.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.context_window ?? 128000,
      maxTokens: model.max_tokens ?? 4096,
    })),
  });
}
```

这种模式使得获取到的 model 在正常启动期间以及 `pi --list-models` 中可用。

### 长生命周期资源与关闭

Extension 工厂可能运行在从不启动 session 的调用中。不要从工厂中启动后台资源，例如进程、socket、文件监听器或定时器。

将后台资源的启动推迟到 `session_start` 或需要该资源的 command/tool/event。注册一个幂等的 `session_shutdown` 处理器，用于关闭你启动的任何 session 作用域资源。

### Extension 风格

**单文件** - 最简单，适用于小型 extension：

```
~/.pi/agent/extensions/
└── my-extension.ts
```

**带 index.ts 的目录** - 适用于多文件 extension：

```
~/.pi/agent/extensions/
└── my-extension/
    ├── index.ts        # 入口点（导出默认函数）
    ├── tools.ts        # 辅助模块
    └── utils.ts        # 辅助模块
```

**带依赖的 Package** - 适用于需要 npm package 的 extension：

```
~/.pi/agent/extensions/
└── my-extension/
    ├── package.json    # 声明依赖与入口点
    ├── package-lock.json
    ├── node_modules/   # npm install 之后
    └── src/
        └── index.ts
```

```json
// package.json
{
  "name": "my-extension",
  "dependencies": {
    "zod": "^3.0.0",
    "chalk": "^5.0.0"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

在 extension 目录中运行 `npm install`，之后来自 `node_modules/` 的导入就会自动生效。

## 事件

### 生命周期概览

```
pi starts
  │
  ├─► project_trust (user/global and CLI extensions only, before project resources load)
  ├─► session_start { reason: "startup" }
  └─► resources_discover { reason: "startup" }
      │
      ▼
user sends prompt ─────────────────────────────────────────┐
  │                                                        │
  ├─► (extension commands checked first, bypass if found)  │
  ├─► input (can intercept, transform, or handle)          │
  ├─► (skill/template expansion if not handled)            │
  ├─► before_agent_start (can inject message, modify system prompt)
  ├─► agent_start                                          │
  ├─► message_start / message_update / message_end         │
  │                                                        │
  │   ┌─── turn (repeats while LLM calls tools) ───┐       │
  │   │                                            │       │
  │   ├─► turn_start                               │       │
  │   ├─► context (can modify messages)            │       │
  │   ├─► before_provider_headers (can mutate headers)     |
  │   ├─► before_provider_request (can inspect or replace payload)
  │   ├─► after_provider_response (status + headers, before stream consume)
  │   │                                            │       │
  │   │   LLM responds, may call tools:            │       │
  │   │     ├─► tool_execution_start               │       │
  │   │     ├─► tool_call (can block)              │       │
  │   │     ├─► tool_execution_update              │       │
  │   │     ├─► tool_result (can modify)           │       │
  │   │     └─► tool_execution_end                 │       │
  │   │                                            │       │
  │   └─► turn_end                                 │       │
  │                                                        │
  ├─► agent_end                                            │
  └─► agent_settled (no retry/compaction/follow-up left)   │
                                                           │
user sends another prompt ◄────────────────────────────────┘

/new (new session) or /resume (switch session)
  ├─► session_before_switch (can cancel)
  ├─► session_shutdown
  ├─► session_start { reason: "new" | "resume", previousSessionFile? }
  └─► resources_discover { reason: "startup" }

/fork or /clone
  ├─► session_before_fork (can cancel)
  ├─► session_shutdown
  ├─► session_start { reason: "fork", previousSessionFile }
  └─► resources_discover { reason: "startup" }

/name or pi.setSessionName()
  └─► session_info_changed

/compact or auto-compaction
  ├─► session_before_compact (can cancel or customize)
  ├─► session_compact (success)
  └─► session_compact_failed (failure or abort)

/tree navigation
  ├─► session_before_tree (can cancel or customize)
  └─► session_tree

/model or Ctrl+P (model selection/cycling)
  ├─► thinking_level_select (if model change changes/clamps thinking level)
  └─► model_select

thinking level changes (settings, keybinding, pi.setThinkingLevel())
  └─► thinking_level_select

exit (Ctrl+C, Ctrl+D, SIGHUP, SIGTERM)
  └─► session_shutdown
```

### 启动事件

#### project_trust

在 pi 决定是否信任带有动态配置（`.pi` 或 `.agents/skills`）的项目之前触发。它会在启动期间运行，也会在 session 替换（例如 `/resume`）进入一个其信任状态在当前进程中尚未解析的 cwd 时运行。只有 user/global extension 和 CLI `-e` extension 参与；项目本地 extension 在信任解析完成之前不会加载。

```typescript
pi.on("project_trust", async (event, ctx) => {
  // event.cwd - current working directory
  // ctx has a limited trust context: cwd, mode, hasUI, and select/confirm/input/notify UI helpers
  if (await ctx.ui.confirm("Trust project?", event.cwd)) {
    return { trusted: "yes", remember: true };
  }
  return { trusted: "undecided" };
});
```

`project_trust` 处理器必须返回 `{ trusted: "yes" | "no" | "undecided" }`。返回 `"yes"` 或 `"no"` 的 user/global 或 CLI extension 拥有该决定权；第一个 yes/no 决定生效，并抑制内置的信任提示。使用 `remember: true` 持久化 yes/no 决定；否则该决定仅适用于当前进程。返回 `"undecided"` 以让后续处理器或内置信任流程做出决定。在提示之前检查 `ctx.hasUI`。如果没有处理器返回 yes/no，则正常的信任解析继续：先应用已保存的 `trust.json` 决定，然后由 `defaultProjectTrust` 控制 pi 默认是询问、信任还是拒绝。

### 资源事件

#### resources_discover

在 `session_start` 之后触发，以便 extension 可以贡献额外的 skill、prompt 和 theme 路径。
启动路径使用 `reason: "startup"`。Reload 使用 `reason: "reload"`。

```typescript
pi.on("resources_discover", async (event, _ctx) => {
  // event.cwd - current working directory
  // event.reason - "startup" | "reload"
  return {
    skillPaths: ["/path/to/skills"],
    promptPaths: ["/path/to/prompts"],
    themePaths: ["/path/to/themes"],
  };
});
```

### Session 事件

关于 session 存储内部机制和 SessionManager API，参见 [Session Format](session-format.md)。

#### session_start

在 session 启动、加载或重载时触发。

```typescript
pi.on("session_start", async (event, ctx) => {
  // event.reason - "startup" | "reload" | "new" | "resume" | "fork"
  // event.previousSessionFile - present for "new", "resume", and "fork"
  ctx.ui.notify(`Session: ${ctx.sessionManager.getSessionFile() ?? "ephemeral"}`, "info");
});
```

#### session_info_changed

在当前 session 的显示名称通过 `/name`、RPC 或 `pi.setSessionName()` 设置时触发。

```typescript
pi.on("session_info_changed", async (event, ctx) => {
  // event.name - current normalized name, or undefined if cleared
  ctx.ui.notify(`Session renamed: ${event.name ?? "(none)"}`, "info");
});
```

#### session_before_switch

在启动新 session（`/new`）或切换 session（`/resume`）之前触发。

```typescript
pi.on("session_before_switch", async (event, ctx) => {
  // event.reason - "new" or "resume"
  // event.targetSessionFile - session we're switching to (only for "resume")

  if (event.reason === "new") {
    const ok = await ctx.ui.confirm("Clear?", "Delete all messages?");
    if (!ok) return { cancel: true };
  }
});
```

在一次成功的切换或新建 session 操作之后，pi 会为旧的 extension 实例发出 `session_shutdown`，为新 session 重新加载并重新绑定 extension，然后发出带有 `reason: "new" | "resume"` 和 `previousSessionFile` 的 `session_start`。
在 `session_shutdown` 中完成清理工作，然后在 `session_start` 中重新建立任何内存中的状态。

#### session_before_fork

在通过 `/fork` fork 或通过 `/clone` clone 时触发。

```typescript
pi.on("session_before_fork", async (event, ctx) => {
  // event.entryId - ID of the selected entry
  // event.position - "before" for /fork, "at" for /clone
  return { cancel: true }; // Cancel fork/clone
  // OR
  return { skipConversationRestore: true }; // Reserved for future conversation restore control
});
```

在一次成功的 fork 或 clone 之后，pi 会为旧的 extension 实例发出 `session_shutdown`，为新 session 重新加载并重新绑定 extension，然后发出带有 `reason: "fork"` 和 `previousSessionFile` 的 `session_start`。
在 `session_shutdown` 中完成清理工作，然后在 `session_start` 中重新建立任何内存中的状态。

#### session_before_compact / session_compact / session_compact_failed

在 compaction 时触发。详情参见 [compaction.md](compaction.md)。

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, reason, willRetry, signal } = event;

  // reason - "manual" (/compact), "threshold", or "overflow"
  // willRetry - whether the aborted turn is retried after compaction (overflow recovery)

  // Cancel:
  return { cancel: true };

  // Custom summary:
  return {
    compaction: {
      summary: "...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      // usage: summaryResponse.usage, // Optional; included in session totals
    }
  };
});

pi.on("session_compact", async (event, ctx) => {
  // event.compactionEntry - the saved compaction
  // event.fromExtension - whether extension provided it
  // event.reason - "manual" (/compact), "threshold", or "overflow"
  // event.willRetry - whether the aborted turn is retried after compaction (overflow recovery)
});

pi.on("session_compact_failed", async (event, ctx) => {
  // event.reason - "manual" (/compact), "threshold", or "overflow"
  // event.errorMessage - present for non-abort failures
  // event.aborted - true for cancelled/aborted compactions
  // event.willRetry - whether the aborted turn would have retried after compaction
  // event.fromExtension - whether extension-provided compaction content was being used
});
```

#### session_before_tree / session_tree

在 `/tree` 导航时触发。关于 tree 导航的概念，参见 [Sessions](sessions.md)。

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;
  return { cancel: true };
  // OR provide custom summary:
  return {
    summary: {
      summary: "...",
      // usage: summaryResponse.usage, // Optional; included in session totals
      details: {},
    },
  };
});

pi.on("session_tree", async (event, ctx) => {
  // event.newLeafId, oldLeafId, summaryEntry, fromExtension
});
```

#### session_shutdown

在已启动的 session runtime 被拆除之前触发。使用它来清理从 `session_start` 或其他 session 作用域 hook 打开的资源。

```typescript
pi.on("session_shutdown", async (event, ctx) => {
  // event.reason - "quit" | "reload" | "new" | "resume" | "fork"
  // event.targetSessionFile - destination session for session replacement flows
  // Cleanup, save state, etc.
});
```

### Agent 事件

#### before_agent_start

在用户提交 prompt 之后、agent loop 之前触发。可以注入消息和/或修改 system prompt。

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // event.prompt - user's prompt text
  // event.images - attached images (if any)
  // event.systemPrompt - current chained system prompt for this handler
  //   (includes changes from earlier before_agent_start handlers)
  // event.systemPromptOptions - structured options used to build the system prompt
  //   .customPrompt - any custom system prompt (from --system-prompt, SYSTEM.md, or custom templates)
  //   .selectedTools - tools currently active in the prompt
  //   .toolSnippets - one-line descriptions for each tool
  //   .promptGuidelines - custom guideline bullets
  //   .appendSystemPrompt - text from --append-system-prompt flags
  //   .cwd - working directory
  //   .contextFiles - AGENTS.md files and other loaded context files
  //   .skills - loaded skills

  return {
    // Inject a persistent message (stored in session, sent to LLM)
    message: {
      customType: "my-extension",
      content: "Additional context for the LLM",
      display: true,
    },
    // Replace the system prompt for this turn (chained across extensions)
    systemPrompt: event.systemPrompt + "\n\nExtra instructions for this turn...",
  };
});
```

`systemPromptOptions` 字段让 extension 能够访问 Pi 用于构建 system prompt 的同一份结构化数据。这让你可以检查 Pi 加载了什么 —— 自定义 prompt、guideline、tool snippet、context 文件、skill —— 而无需重新发现资源或重新解析标志。当你的 extension 需要在尊重用户提供配置的同时对 system prompt 做深入且有依据的修改时，使用它。

在 `before_agent_start` 内部，`event.systemPrompt` 和 `ctx.getSystemPrompt()` 都反映截至当前处理器的链式 system prompt。后续的 `before_agent_start` 处理器仍然可以再次修改它。

#### agent_start / agent_end / agent_settled

`agent_start` 在底层 agent 运行开始时触发。`agent_end` 在该运行结束时触发，但 Pi 可能仍会自动重试、自动 compact 并重试，或继续处理排队的 follow-up 消息。对于需要知道 Pi 不会自动继续运行的状态集成，使用 `agent_settled`。

```typescript
pi.on("agent_start", async (_event, ctx) => {});

pi.on("agent_end", async (event, ctx) => {
  // event.messages - messages from this low-level run
});

pi.on("agent_settled", async (_event, ctx) => {
  // ctx.isIdle() is true here unless another extension started a new run.
});
```

#### ui_prompt_start / ui_prompt_end

针对阻塞式、面向用户的 extension UI prompt 的仅通知生命周期事件。它们围绕 `ctx.ui.select()`、`ctx.ui.confirm()`、`ctx.ui.input()`、`ctx.ui.editor()` 和 `ctx.ui.custom()` 触发，以便 host/status 集成可以报告"正在等待用户"，而不只是"正在运行"。

嵌套或重叠的 prompt 会被合并为一个外层等待区间。处理器以 best-effort 方式调用，并且在显示或关闭 prompt 之前不会被 await。

```typescript
pi.on("ui_prompt_start", async (event, ctx) => {
  // event.reason === "ui_prompt"
  // event.kind: "select" | "confirm" | "input" | "editor" | "custom"
  // event.title: prompt title when available
});

pi.on("ui_prompt_end", async (event, ctx) => {
  // Pi is no longer waiting on that UI prompt span.
});
```

#### turn_start / turn_end

为每个 turn 触发（一次 LLM 响应 + tool 调用）。

```typescript
pi.on("turn_start", async (event, ctx) => {
  // event.turnIndex, event.timestamp
});

pi.on("turn_end", async (event, ctx) => {
  // event.turnIndex, event.message, event.toolResults
});
```

#### message_start / message_update / message_end

为消息生命周期更新而触发。

- `message_start` 和 `message_end` 会为用户、assistant 和 toolResult 消息触发。
- `message_update` 会为 assistant 流式更新触发。
- `message_end` 处理器可以返回 `{ message }` 来替换最终确定的消息。替换后的消息必须保持相同的 `role`。

```typescript
pi.on("message_start", async (event, ctx) => {
  // event.message
});

pi.on("message_update", async (event, ctx) => {
  // event.message
  // event.assistantMessageEvent (token-by-token stream event)
});

pi.on("message_end", async (event, ctx) => {
  if (event.message.role !== "assistant") return;

  return {
    message: {
      ...event.message,
      usage: {
        ...event.message.usage,
        cost: {
          ...event.message.usage.cost,
          total: 0.123,
        },
      },
    },
  };
});
```

#### tool_execution_start / tool_execution_update / tool_execution_end

为 tool 执行生命周期更新而触发。

在并行 tool 模式下：
- `tool_execution_start` 在预检阶段按 assistant 源顺序发出
- `tool_execution_update` 事件可能在多个 tool 之间交错
- `tool_execution_end` 在每个 tool 最终确定之后按 tool 完成顺序发出
- 最终的 `toolResult` 消息事件仍然稍后按 assistant 源顺序发出

```typescript
pi.on("tool_execution_start", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args
});

pi.on("tool_execution_update", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args, event.partialResult
});

pi.on("tool_execution_end", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.result, event.isError
});
```

#### context

在每次 LLM 调用之前触发。以非破坏性的方式修改消息。关于消息类型，参见 [Session Format](session-format.md)。

```typescript
pi.on("context", async (event, ctx) => {
  // event.messages - deep copy, safe to modify
  const filtered = event.messages.filter(m => !shouldPrune(m));
  return { messages: filtered };
});
```

#### before_provider_headers

在即将发出的 HTTP header 组装完成之后触发。使用它来添加、覆盖或移除请求 header。

处理器就地修改 `event.headers`。将某个键设为字符串即可添加或覆盖它，或设为 `null` 以删除它。

```typescript
pi.on("before_provider_headers", (event, ctx) => {
  // Add or override — e.g. a session id for gateway tracing/attribution
  event.headers["x-session-id"] = ctx.sessionManager.getSessionId();

  // Drop a tracking header pi adds for this call
  event.headers["X-OpenRouter-Title"] = null;
});
```

每个 provider 请求运行一次；重试会复用相同的 header，而不会重新触发该 hook。

#### before_provider_request

在 provider 特定的 payload 构建完成之后、请求即将发送之前触发。处理器按 extension 加载顺序运行。返回 `undefined` 会保持 payload 不变。返回任何其他值都会为后续处理器和实际请求替换该 payload。

这个 hook 可以重写 provider 级别的 system 指令，或将其完全移除。这些 payload 级别的改动不会反映在 `ctx.getSystemPrompt()` 中，后者报告的是 Pi 的 system prompt 字符串，而不是最终序列化后的 provider payload。

```typescript
pi.on("before_provider_request", (event, ctx) => {
  console.log(JSON.stringify(event.payload, null, 2));

  // Optional: replace payload
  // return { ...event.payload, temperature: 0 };
});
```

这主要用于调试 provider 序列化和缓存行为。

#### after_provider_response

在收到 HTTP 响应之后、其流式 body 被消费之前触发。处理器按 extension 加载顺序运行。

```typescript
pi.on("after_provider_response", (event, ctx) => {
  // event.status - HTTP status code
  // event.headers - normalized response headers
  if (event.status === 429) {
    console.log("rate limited", event.headers["retry-after"]);
  }
});
```

Header 的可用性取决于 provider 和传输层。抽象了 HTTP 响应的 provider 可能不会暴露 header。

### Model 事件

#### model_select

在 model 通过 `/model` 命令、model 循环切换（`Ctrl+P`）或 session 恢复而发生变更时触发。

```typescript
pi.on("model_select", async (event, ctx) => {
  // event.model - newly selected model
  // event.previousModel - previous model (undefined if first selection)
  // event.source - "set" | "cycle" | "restore"

  const prev = event.previousModel
    ? `${event.previousModel.provider}/${event.previousModel.id}`
    : "none";
  const next = `${event.model.provider}/${event.model.id}`;

  ctx.ui.notify(`Model changed (${event.source}): ${prev} -> ${next}`, "info");
});
```

使用它来更新 UI 元素（状态栏、footer），或在活动 model 变更时执行特定于 model 的初始化。

#### thinking_level_select

在 thinking level 变更时触发。这是仅通知事件；处理器的返回值会被忽略。

```typescript
pi.on("thinking_level_select", async (event, ctx) => {
  // event.level - newly selected thinking level
  // event.previousLevel - previous thinking level

  ctx.ui.setStatus("thinking", `thinking: ${event.level}`);
});
```

当 `pi.setThinkingLevel()`、model 变更或内置 thinking-level 控件改变活动 thinking level 时，使用它来更新 extension UI。

### Tool 事件

#### tool_call

在 `tool_execution_start` 之后、tool 执行之前触发。**可以阻止。** 使用 `isToolCallEventType` 进行收窄并获得带类型的输入。

在 `tool_call` 运行之前，pi 会等待此前发出的 Agent 事件通过 `AgentSession` 完成排空。这意味着 `ctx.sessionManager` 已更新到当前 assistant tool-calling 消息为止。

在默认的并行 tool 执行模式下，来自同一条 assistant 消息的兄弟 tool 调用会按顺序预检，然后并发执行。`tool_call` 不保证能在 `ctx.sessionManager` 中看到来自同一条 assistant 消息的兄弟 tool 结果。

`event.input` 是可变的。就地修改它即可在执行前修补 tool 参数。

行为保证：
- 对 `event.input` 的修改会影响实际的 tool 执行
- 后续的 `tool_call` 处理器能看到更早处理器所做的修改
- 在你的修改之后不会执行重新校验
- `tool_call` 的返回值通过 `{ block: true, reason?: string, terminate?: boolean }` 控制阻止行为
- `terminate` 仅适用于被阻止的调用；只有当批次中每个最终确定的结果都是 terminating 时，agent 才会提前停止

```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  // event.toolName - "bash", "read", "write", "edit", etc.
  // event.toolCallId
  // event.input - tool parameters (mutable)

  // Built-in tools: no type params needed
  if (isToolCallEventType("bash", event)) {
    // event.input is { command: string; timeout?: number }
    event.input.command = `source ~/.profile\n${event.input.command}`;

    if (event.input.command.includes("rm -rf")) {
      return { block: true, reason: "Dangerous command", terminate: true };
    }
  }

  if (isToolCallEventType("read", event)) {
    // event.input is { path: string; offset?: number; limit?: number }
    console.log(`Reading: ${event.input.path}`);
  }
});
```

#### 为自定义 tool 输入指定类型

自定义 tool 应当导出其输入类型：

```typescript
// my-extension.ts
export type MyToolInput = Static<typeof myToolSchema>;
```

将 `isToolCallEventType` 与显式类型参数一起使用：

```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { MyToolInput } from "my-extension";

pi.on("tool_call", (event) => {
  if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
    event.input.action;  // typed
  }
});
```

#### tool_result

在 tool 执行完成之后、在 `tool_execution_end` 以及最终 tool 结果消息事件发出之前触发。**可以修改结果。**

在并行 tool 模式下，`tool_result` 和 `tool_execution_end` 可能按 tool 完成顺序交错，而最终的 `toolResult` 消息事件仍然稍后按 assistant 源顺序发出。

`tool_result` 处理器像中间件一样链式执行：
- 处理器按 extension 加载顺序运行
- 每个处理器看到的是前一个处理器修改后的最新结果
- 处理器可以返回部分补丁（`content`、`details`、`isError` 或 `usage`）；省略的字段保持其当前值

在处理器内部进行嵌套异步工作时，使用 `ctx.signal`。这可以让 Esc 取消由 extension 启动的 model 调用、`fetch()` 以及其他可中止感知的操作。

```typescript
import { isBashToolResult } from "@earendil-works/pi-coding-agent";

pi.on("tool_result", async (event, ctx) => {
  // event.toolName, event.toolCallId, event.input
  // event.content, event.details, event.isError, event.usage

  if (isBashToolResult(event)) {
    // event.details is typed as BashToolDetails
  }

  const response = await fetch("https://example.com/summarize", {
    method: "POST",
    body: JSON.stringify({ content: event.content }),
    signal: ctx.signal,
  });

  // Modify result:
  return { content: [...], details: {...}, isError: false, usage: nestedModelUsage };
});
```

### 用户 Bash 事件

#### user_bash

在用户执行 `!` 或 `!!` 命令时触发。**可以拦截。**

```typescript
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

pi.on("user_bash", (event, ctx) => {
  // event.command - the bash command
  // event.excludeFromContext - true if !! prefix
  // event.cwd - working directory

  // Option 1: Provide custom operations (e.g., SSH)
  return { operations: remoteBashOps };

  // Option 2: Wrap pi's built-in local bash backend
  const local = createLocalBashOperations();
  return {
    operations: {
      exec(command, cwd, options) {
        return local.exec(`source ~/.profile\n${command}`, cwd, options);
      }
    }
  };

  // Option 3: Full replacement - return result directly
  return { result: { output: "...", exitCode: 0, cancelled: false, truncated: false } };
});
```

### 输入事件

#### input

在收到用户输入时触发，位于检查 extension 命令之后、但在 skill 和 template 展开之前。该事件看到的是原始输入文本，因此 `/skill:foo` 和 `/template` 尚未被展开。

**处理顺序：**
1. 首先检查 extension 命令（`/cmd`）- 如果找到，则运行其处理器并跳过 input 事件
2. 触发 `input` 事件 - 可以拦截、转换或处理
3. 如果未被处理：skill 命令（`/skill:name`）被展开为 skill 内容
4. 如果未被处理：prompt template（`/template`）被展开为 template 内容
5. Agent 处理开始（`before_agent_start` 等）

```typescript
pi.on("input", async (event, ctx) => {
  // event.text - raw input (before skill/template expansion)
  // event.images - attached images, if any
  // event.source - "interactive" (typed), "rpc" (API), or "extension" (via sendUserMessage)
  // event.streamingBehavior - "steer" | "followUp" | undefined
  //   undefined when idle, "steer" for mid-stream interrupts,
  //   "followUp" for messages queued until the agent finishes

  // Transform: rewrite input before expansion
  if (event.text.startsWith("?quick "))
    return { action: "transform", text: `Respond briefly: ${event.text.slice(7)}` };

  // Handle: respond without LLM (extension shows its own feedback)
  if (event.text === "ping") {
    ctx.ui.notify("pong", "info");
    return { action: "handled" };
  }

  // Route by source: skip processing for extension-injected messages
  if (event.source === "extension") return { action: "continue" };

  // Intercept skill commands before expansion
  if (event.text.startsWith("/skill:")) {
    // Could transform, block, or let pass through
  }

  return { action: "continue" };  // Default: pass through to expansion
});
```

**结果：**
- `continue` - 原样传递（如果处理器没有返回任何内容，则为默认行为）
- `transform` - 修改 text/images，然后继续进入展开
- `handled` - 完全跳过 agent（第一个返回该值的处理器生效）

Transform 会在多个处理器之间链式传递。关于感知 `streamingBehavior` 的路由，参见 [input-transform.ts](../examples/extensions/input-transform.ts) 和 [input-transform-streaming.ts](../examples/extensions/input-transform-streaming.ts)。

## ExtensionContext

所有处理器都接收 `ctx: ExtensionContext`。

### ctx.ui

用于用户交互的 UI 方法。完整细节参见[自定义 UI](#custom-ui)。

### ctx.mode

当前运行模式：`"tui"`、`"rpc"`、`"json"` 或 `"print"`。使用 `ctx.mode === "tui"` 来守卫仅限终端的特性，例如 `custom()`、component 工厂、终端输入和直接 TUI 渲染。

### ctx.hasUI

在 TUI 和 RPC 模式下为 `true`。在 print 模式（`-p`）和 JSON 模式下为 `false`。使用它来守卫对话框方法（`select`、`confirm`、`input`、`editor`）以及即发即忘方法（`notify`、`setStatus`、`setWidget`、`setTitle`、`setEditorText`），后者在 TUI 和 RPC 模式下都可用。在 RPC 模式下，一些 TUI 特有的方法是 no-op 或返回默认值（参见 [rpc.md](rpc.md#extension-ui-protocol)）。

### ctx.cwd

当前工作目录。

在构造项目本地配置路径时，使用 `CONFIG_DIR_NAME` 而不是硬编码 `.pi`。经过重新品牌的发行版可能使用不同的配置目录名。

```typescript
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const projectConfigPath = join(ctx.cwd, CONFIG_DIR_NAME, "my-extension.json");
    // ...
  });
}
```

### ctx.isProjectTrusted()

返回当前 session context 是否启用了项目本地信任。这包括临时信任决定和 CLI 信任覆盖，而不仅仅是全局信任存储中已保存的决定。

在读取那些只应针对受信任项目生效的项目本地 extension 配置之前，使用它。

### ctx.sessionManager

对 session 状态的只读访问。关于完整的 SessionManager API 和条目类型，参见 [Session Format](session-format.md)。

对于 `tool_call`，该状态在处理器运行之前已同步到当前 assistant 消息。在并行 tool 执行模式下，它仍不保证包含来自同一条 assistant 消息的兄弟 tool 结果。

```typescript
ctx.sessionManager.getEntries()             // All entries
ctx.sessionManager.getBranch()              // Current branch
ctx.sessionManager.buildContextEntries()    // Active branch entries with compaction applied
ctx.sessionManager.getLeafId()              // Current leaf entry ID
```

### ctx.modelRegistry / ctx.model / ctx.thinkingLevel / ctx.scopedModels

访问 model、provider 以及已解析的认证。`ctx.modelRegistry.getProvider(id)` 返回生效的 pi-ai provider，而 `getProviderAuth(id)` 会解析其当前的 API key、header、base URL 以及 provider 作用域的环境变量，无需先加载 model。`ctx.model` 是活动的 model，`ctx.thinkingLevel` 是其当前生效的 thinking level。

`ctx.scopedModels` 是限定到当前 session 的 model 的只读列表 —— 与 `/scoped-models` 命令所显示的集合相同。它在 session 启动时根据 `--models` CLI 标志和 `enabledModels` 设置解析得出（使用 minimatch 针对 `provider/modelId` 或裸 `modelId` 与可用目录进行匹配）。当未配置任何作用域限定时为空白，意味着每个可用 model 都可使用。每个条目是 `{ model, thinkingLevel? }`，其中 `thinkingLevel` 仅在某个 pattern 固定了它时才被设置（例如 `anthropic/*:high`）。使用它来填充一个与内置选择器一致的 model picker，而不是通过 `ctx.modelRegistry.getAvailable()` 枚举整个目录。

#### 流式 model 调用

对于 provider 中立的选项（例如 `reasoning`）使用 `ctx.modelRegistry.streamSimple(model, context, options)`，对于 API 特定的选项使用 `stream()`。两者都使用已配置的 provider 并解析认证，包括使用 `pi.registerProvider()` 注册的 provider。使用它们而不是 `pi-ai/compat` 的流式函数，后者无法看到 extension 的 provider 注册。

两者都返回一个 `AssistantMessageEventStream`。迭代它以获取响应事件，并 await `.result()` 以获得最终消息。设置失败会产生 error 事件和 error 结果。

### ctx.signal

当前的 agent 中止信号，当没有活动的 agent turn 时为 `undefined`。

将其用于由 extension 处理器启动的可中止感知的嵌套工作，例如：
- `fetch(..., { signal: ctx.signal })`
- 接受 `signal` 的 model 调用
- 接受 `AbortSignal` 的文件或进程辅助函数

`ctx.signal` 通常在活动 turn 事件（例如 `tool_call`、`tool_result`、`message_update` 和 `turn_end`）期间有定义。
在空闲或非 turn 的上下文中（例如 session 事件、extension 命令，以及 pi 空闲时触发的 shortcut）它通常为 `undefined`。

```typescript
pi.on("tool_result", async (event, ctx) => {
  const response = await fetch("https://example.com/api", {
    method: "POST",
    body: JSON.stringify(event),
    signal: ctx.signal,
  });

  const data = await response.json();
  return { details: data };
});
```

### ctx.isIdle() / ctx.abort() / ctx.hasPendingMessages()

控制流辅助函数。当 Pi 正在处理 agent 运行、自动重试、auto-compaction 重试或排队的 continuation 时，`ctx.isIdle()` 为 false。

### ctx.shutdown()

请求 pi 优雅关闭。

- **交互模式：** 延迟到 agent 变为空闲时（在处理完所有排队的 steering 和 follow-up 消息之后）。
- **RPC 模式：** 延迟到下一个空闲状态（在完成当前命令响应之后，即等待下一条命令时）。
- **Print 模式：** No-op。当所有 prompt 都被处理完毕后，进程会自动退出。

在退出之前向所有 extension 发出 `session_shutdown` 事件。在所有上下文中都可用（事件处理器、tool、命令、shortcut）。

```typescript
pi.on("tool_call", (event, ctx) => {
  if (isFatal(event.input)) {
    ctx.shutdown();
  }
});
```

### ctx.getContextUsage()

返回活动 model 的当前 context 使用量。在可用时使用最后一次 assistant usage，然后为尾部消息估算 token。

```typescript
const usage = ctx.getContextUsage();
if (usage && usage.tokens > 100_000) {
  // ...
}
```

### ctx.compact()

触发 compaction 而不等待其完成。使用 `onComplete` 和 `onError` 执行后续操作。

```typescript
ctx.compact({
  customInstructions: "Focus on recent changes",
  onComplete: (result) => {
    ctx.ui.notify("Compaction completed", "info");
  },
  onError: (error) => {
    ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
  },
});
```

### ctx.getSystemPrompt()

返回 Pi 当前的 system prompt 字符串。

- 在 `before_agent_start` 期间，它反映当前 turn 迄今为止所做的链式 system-prompt 修改。
- 它不包含之后的 `context` 消息修改。
- 它不包含 `before_provider_request` 的 payload 重写。
- 如果之后加载的 extension 在你的 extension 之后运行，它们仍然可以改变最终发送的内容。

```typescript
pi.on("before_agent_start", (event, ctx) => {
  const prompt = ctx.getSystemPrompt();
  console.log(`System prompt length: ${prompt.length}`);
});
```

## ExtensionCommandContext

命令处理器接收 `ExtensionCommandContext`，它扩展了 `ExtensionContext`，增加了 session 控制方法。这些方法仅在命令中可用，因为如果从事件处理器中调用它们可能会导致死锁。

### ctx.getSystemPromptOptions()

返回 Pi 当前用于构建 system prompt 的基础输入。

```typescript
const options = ctx.getSystemPromptOptions();
const contextPaths = options.contextFiles?.map((file) => file.path) ?? [];
```

它与 `before_agent_start` 的 `event.systemPromptOptions` 具有相同的结构和可变性：自定义 prompt、活动 tool、tool snippet、prompt guideline、追加的 system prompt 文本、cwd、已加载的 context 文件以及已加载的 skill。它可能包含完整的 context 文件内容，因此请将其视为敏感的 extension 本地数据，避免通过命令列表、日志或自动补全元数据暴露它。

它报告的是当前的基础 prompt 输入。它不包含逐 turn 的 `before_agent_start` 链式 system-prompt 修改、之后的 `context` 事件消息修改，或 `before_provider_request` 的 payload 重写。

### ctx.waitForIdle()

等待 agent 完全稳定下来，包括自动重试、auto-compaction 重试以及排队的 continuation：

```typescript
pi.registerCommand("my-cmd", {
  handler: async (args, ctx) => {
    await ctx.waitForIdle();
    // Agent is now idle, safe to modify session
  },
});
```

### ctx.newSession(options?)

创建一个新 session：

```typescript
const parentSession = ctx.sessionManager.getSessionFile();
const kickoff = "Continue in the replacement session";

const result = await ctx.newSession({
  parentSession,
  setup: async (sm) => {
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Context from previous session..." }],
      timestamp: Date.now(),
    });
  },
  withSession: async (ctx) => {
    // Use only the replacement-session ctx here.
    await ctx.sendUserMessage(kickoff);
  },
});

if (result.cancelled) {
  // An extension cancelled the new session
}
```

选项：
- `parentSession`：要记录在新 session header 中的父 session 文件
- `setup`：在 `withSession` 运行之前修改新 session 的 `SessionManager`
- `withSession`：针对一个全新的替换 session context 运行切换后的工作。不要使用捕获的旧 `pi` / 命令 `ctx`；参见 [Session 替换生命周期与陷阱](#session-replacement-lifecycle-and-footguns)。

### ctx.fork(entryId, options?)

从特定条目 fork，创建一个新的 session 文件：

```typescript
const result = await ctx.fork("entry-id-123", {
  withSession: async (ctx) => {
    // Use only the replacement-session ctx here.
    ctx.ui.notify("Now in the forked session", "info");
  },
});
if (result.cancelled) {
  // An extension cancelled the fork
}

const cloneResult = await ctx.fork("entry-id-456", { position: "at" });
if (cloneResult.cancelled) {
  // An extension cancelled the clone
}
```

选项：
- `position`：`"before"`（默认）在选定的用户消息之前 fork，并将该 prompt 恢复到编辑器中
- `position`：`"at"` 复制经过所选条目的活动路径，但不恢复编辑器文本
- `withSession`：针对一个全新的替换 session context 运行切换后的工作。不要使用捕获的旧 `pi` / 命令 `ctx`；参见 [Session 替换生命周期与陷阱](#session-replacement-lifecycle-and-footguns)。

### ctx.navigateTree(targetId, options?)

导航到 session tree 中的另一个位置。当 agent 响应、手动或自动 compaction，或另一次 tree 导航处于活动状态时会被拒绝，即使设置 `summarize: false` 也是如此。这些冲突会保持活动 branch 不变，并让 promise 被拒绝，而不是返回 `{ cancelled: true }`。等待活动操作完成（例如在命令处理器中使用 `await ctx.waitForIdle()`）然后重试：

```typescript
const result = await ctx.navigateTree("entry-id-456", {
  summarize: true,
  customInstructions: "Focus on error handling changes",
  replaceInstructions: false, // true = replace default prompt entirely
  label: "review-checkpoint",
});
```

选项：
- `summarize`：是否生成被放弃 branch 的摘要
- `customInstructions`：给 summarizer 的自定义指令
- `replaceInstructions`：如果为 true，`customInstructions` 会替换默认 prompt，而不是被追加
- `label`：要附加到 branch summary 条目（或未做摘要时的目标条目）的 label

### ctx.switchSession(sessionPath, options?)

切换到另一个 session 文件：

```typescript
const result = await ctx.switchSession("/path/to/session.jsonl", {
  withSession: async (ctx) => {
    await ctx.sendUserMessage("Resume work in the replacement session");
  },
});
if (result.cancelled) {
  // An extension cancelled the switch via session_before_switch
}
```

选项：
- `withSession`：针对一个全新的替换 session context 运行切换后的工作。不要使用捕获的旧 `pi` / 命令 `ctx`；参见 [Session 替换生命周期与陷阱](#session-replacement-lifecycle-and-footguns)。

要发现可用的 session，使用静态的 `SessionManager.list()` 或 `SessionManager.listAll()` 方法：

```typescript
import { SessionManager } from "@earendil-works/pi-coding-agent";

pi.registerCommand("switch", {
  description: "Switch to another session",
  handler: async (args, ctx) => {
    const sessions = await SessionManager.list(ctx.cwd);
    if (sessions.length === 0) return;
    const choice = await ctx.ui.select(
      "Pick session:",
      sessions.map(s => s.file),
    );
    if (choice) {
      await ctx.switchSession(choice, {
        withSession: async (ctx) => {
          ctx.ui.notify("Switched session", "info");
        },
      });
    }
  },
});
```

### Session 替换生命周期与陷阱

`withSession` 接收一个全新的 `ReplacedSessionContext`，它扩展了 `ExtensionCommandContext`，并增加了绑定到替换 session 的异步 `sendMessage()` 和 `sendUserMessage()` 辅助函数。

生命周期与陷阱：
- `withSession` 只有在旧 session 已发出 `session_shutdown`、旧 runtime 已被拆除、替换 session 已重新绑定、且新的 extension 实例已经收到 `session_start` 之后才会运行。
- 该回调仍然在原始闭包中执行，而不是在新的 extension 实例内部。这意味着你的旧 extension 实例可能已经在 `withSession` 开始之前运行了它的 shutdown 清理。
- 捕获的旧 `pi` / 旧命令 `ctx` 等绑定到 session 的对象在替换之后已经过期，使用它们会抛出错误。对于绑定到 session 的工作，只使用传给 `withSession` 的 `ctx`。
- 此前提取出来的原始对象仍然由你负责。例如，如果你在替换之前捕获了 `const sm = ctx.sessionManager`，那么 `sm` 仍然是旧的 `SessionManager` 对象。替换之后不要复用它。
- `withSession` 中的代码应当假设任何被你的 `session_shutdown` 处理器置为无效的状态都已经消失。只捕获能在 shutdown 中干净存续的纯数据，例如字符串、id 和序列化后的配置。

安全模式：

```typescript
pi.registerCommand("handoff", {
  handler: async (_args, ctx) => {
    const kickoff = "Continue from the replacement session";
    await ctx.newSession({
      withSession: async (ctx) => {
        await ctx.sendUserMessage(kickoff);
      },
    });
  },
});
```

不安全模式：

```typescript
pi.registerCommand("handoff", {
  handler: async (_args, ctx) => {
    const oldSessionManager = ctx.sessionManager;
    await ctx.newSession({
      withSession: async (_ctx) => {
        // stale old objects: do not do this
        oldSessionManager.getSessionFile();
        pi.sendUserMessage("wrong");
      },
    });
  },
});
```

### ctx.reload()

运行与 `/reload` 相同的 reload 流程。

```typescript
pi.registerCommand("reload-runtime", {
  description: "Reload extensions, skills, prompts, themes, and context files",
  handler: async (_args, ctx) => {
    await ctx.reload();
    return;
  },
});
```

重要行为：
- `await ctx.reload()` 为当前 extension runtime 发出 `session_shutdown`
- 然后它重新加载资源，并发出带有 `reason: "reload"` 的 `session_start` 以及 reason 为 `"reload"` 的 `resources_discover`
- 当前正在运行的命令处理器仍会在旧调用帧中继续执行
- `await ctx.reload()` 之后的代码仍然来自 reload 之前的版本
- `await ctx.reload()` 之后的代码不得假设旧的内存中 extension 状态仍然有效
- 处理器返回之后，未来的命令/事件/tool 调用会使用新的 extension 版本

为了行为可预测，将该 handler 中的 reload 视为终结操作（`await ctx.reload(); return;`）。

Tool 以 `ExtensionContext` 运行，因此它们无法直接调用 `ctx.reload()`。使用一个命令作为 reload 入口点，然后暴露一个 tool，将该命令作为 follow-up 用户消息排队。

LLM 可以调用以触发 reload 的示例 tool：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("reload-runtime", {
    description: "Reload extensions, skills, prompts, themes, and context files",
    handler: async (_args, ctx) => {
      await ctx.reload();
      return;
    },
  });

  pi.registerTool({
    name: "reload_runtime",
    label: "Reload Runtime",
    description: "Reload extensions, skills, prompts, themes, and context files",
    parameters: Type.Object({}),
    async execute() {
      pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
      return {
        content: [{ type: "text", text: "Queued /reload-runtime as a follow-up command." }],
      };
    },
  });
}
```

## ExtensionAPI 方法

### pi.on(event, handler)

订阅事件。关于事件类型和返回值，参见[事件](#events)。

### pi.registerTool(definition)

注册一个可供 LLM 调用的自定义 tool。完整细节参见[自定义 Tool](#custom-tools)。

`pi.registerTool()` 在 extension 加载期间和启动之后都可以工作。你可以在 `session_start`、命令处理器或其他事件处理器中调用它。新 tool 会在同一个 session 中立即刷新，因此它们会出现在 `pi.getAllTools()` 中，并且无需 `/reload` 即可被 LLM 调用。

使用 `pi.setActiveTools()` 在运行时启用或禁用 tool（包括动态添加的 tool）。

使用 `promptSnippet` 让自定义 tool 在 `Available tools` 中拥有一行条目，使用 `promptGuidelines` 在 tool 处于活动状态时向其追加 tool 特定的要点到默认的 `Guidelines` 部分。

**重要：** `promptGuidelines` 要点会以扁平方式追加到 `Guidelines` 部分，不带 tool 名称前缀。每条 guideline 都必须指明它所引用的 tool —— 避免使用 "Use this tool when..."，因为 LLM 无法分辨 "this" 指的是哪个 tool。应改写为 "Use my_tool when..."。

完整示例参见 [dynamic-tools.ts](../examples/extensions/dynamic-tools.ts)。

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does",
  promptSnippet: "Summarize or transform text according to action",
  promptGuidelines: ["Use my_tool when the user asks to summarize previously generated text."],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {
    // Optional compatibility shim. Runs before schema validation.
    // Return the current schema shape, for example to fold legacy fields
    // into the modern parameter object.
    return args;
  },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Stream progress
    onUpdate?.({ content: [{ type: "text", text: "Working..." }] });

    return {
      content: [{ type: "text", text: "Done" }],
      details: { result: "..." },
    };
  },

  // Optional: Custom rendering
  renderCall(args, theme, context) { ... },
  renderResult(result, options, theme, context) { ... },
});
```

### pi.sendMessage(message, options?)

向 session 注入一条自定义消息。自定义消息会参与 LLM context。对于不应发送给 LLM 的持久化 TUI 专用内容，使用 [`pi.appendEntry()`](#piappendentrycustomtype-data) 搭配 [`pi.registerEntryRenderer()`](#piregisterentryrenderercustomtype-renderer)。

```typescript
pi.sendMessage({
  customType: "my-extension",
  content: "Message text",
  display: true,
  details: { ... },
}, {
  triggerTurn: true,
  deliverAs: "steer",
});
```

**选项：**
- `deliverAs` - 投递模式：
  - `"steer"`（默认）- 在流式输出期间将消息排队。在当前 assistant turn 执行完其 tool 调用之后、下一次 LLM 调用之前投递。
  - `"followUp"` - 等待 agent 完成。仅当 agent 没有更多 tool 调用时才投递。
  - `"nextTurn"` - 排队等待下一个用户 prompt。不会中断或触发任何内容。
- `triggerTurn: true` - 如果 agent 空闲，立即触发一次 LLM 响应。仅适用于 `"steer"` 和 `"followUp"` 模式（对 `"nextTurn"` 忽略）。

### pi.sendUserMessage(content, options?)

向 agent 发送一条用户消息。与发送自定义消息的 `sendMessage()` 不同，这里发送的是一条真正的用户消息，看起来就像用户输入的一样。总是会触发一个 turn。

```typescript
// Simple text message
pi.sendUserMessage("What is 2+2?");

// With content array (text + images)
pi.sendUserMessage([
  { type: "text", text: "Describe this image:" },
  { type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } },
]);

// During streaming - must specify delivery mode
pi.sendUserMessage("Focus on error handling", { deliverAs: "steer" });
pi.sendUserMessage("And then summarize", { deliverAs: "followUp" });

// Opt in to extension command dispatch and skill/prompt template expansion
pi.sendUserMessage("/review src/index.ts", { expandPromptTemplates: true });
```

**选项：**
- `deliverAs` - 当 agent 正在流式输出时必填：
  - `"steer"` - 将消息排队，在当前 assistant turn 执行完其 tool 调用之后投递
  - `"followUp"` - 等待 agent 完成所有 tool
- `expandPromptTemplates` - 派发 extension 命令并展开 skill 命令和 prompt template。默认为 `false`。

当不在流式输出时，消息会立即发送并触发一个新的 turn。当正在流式输出而未提供 `deliverAs` 时，会抛出错误。

完整示例参见 [send-user-message.ts](../examples/extensions/send-user-message.ts)。

### pi.appendEntry(customType, data?)

持久化 extension 数据。自定义条目不参与 LLM context。在交互模式下，当与 `pi.registerEntryRenderer()` 搭配使用时，它们还可以在聊天 transcript 内部渲染。

```typescript
pi.appendEntry("my-state", { count: 42 });
pi.appendEntry("status-card", { title: "Indexed files", count: 17 });

// Restore on reload
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      // Reconstruct from entry.data
    }
  }
});
```

### pi.setSessionName(name)

设置 session 显示名称（在 session 选择器中显示，替代首条消息）。

```typescript
pi.setSessionName("Refactor auth module");
```

### pi.getSessionName()

获取当前 session 名称（如果已设置）。

```typescript
const name = pi.getSessionName();
if (name) {
  console.log(`Session: ${name}`);
}
```

### pi.setLabel(entryId, label)

设置或清除某个条目的 label。Label 是用户定义的标记，用于书签和导航（显示在 `/tree` 选择器中）。

```typescript
// Set a label
pi.setLabel(entryId, "checkpoint-before-refactor");

// Clear a label
pi.setLabel(entryId, undefined);

// Read labels via sessionManager
const label = ctx.sessionManager.getLabel(entryId);
```

Label 会持久化在 session 中，并在重启后存续。使用它们来标记对话 tree 中的重要位置（turn、检查点）。

### pi.registerCommand(name, options)

注册一个命令。

如果多个 extension 注册了相同的命令名，pi 会保留它们全部，并按加载顺序分配数字调用后缀，例如 `/review:1` 和 `/review:2`。

```typescript
pi.registerCommand("stats", {
  description: "Show session statistics",
  handler: async (args, ctx) => {
    const count = ctx.sessionManager.getEntries().length;
    ctx.ui.notify(`${count} entries`, "info");
  }
});
```

可选：为 `/command ...` 添加参数自动补全：

```typescript
import type { AutocompleteItem } from "@earendil-works/pi-tui";

pi.registerCommand("deploy", {
  description: "Deploy to an environment",
  getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
    const envs = ["dev", "staging", "prod"];
    const items = envs.map((e) => ({ value: e, label: e }));
    const filtered = items.filter((i) => i.value.startsWith(prefix));
    return filtered.length > 0 ? filtered : null;
  },
  handler: async (args, ctx) => {
    ctx.ui.notify(`Deploying: ${args}`, "info");
  },
});
```

### pi.getCommands()

获取当前 session 中可通过 `prompt` 调用的 slash 命令。包括 extension 命令、prompt template 和 skill 命令。
该列表与 RPC `get_commands` 的顺序一致：先 extension，然后 template，最后 skill。

```typescript
const commands = pi.getCommands();
const bySource = commands.filter((command) => command.source === "extension");
const userScoped = commands.filter((command) => command.sourceInfo.scope === "user");
```

每个条目具有以下结构：

```typescript
{
  name: string; // Invokable command name without the leading slash. May be suffixed like "review:1"
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}
```

使用 `sourceInfo` 作为规范的来源字段。不要从命令名或临时性的路径解析推断归属。

内置交互式命令（例如 `/model` 和 `/settings`）不包含在此处。它们仅在交互模式下处理，如果通过 `prompt` 发送则不会执行。

### pi.registerMessageRenderer(customType, renderer)

为使用你的 `customType` 的自定义消息注册自定义 TUI 渲染器。自定义消息通过 `pi.sendMessage()` 创建，并参与 LLM context。参见[自定义 UI](#custom-ui)。

### pi.registerMarkdownTransformer(transformer)

为普通用户文本、assistant 文本和 thinking 块中的 Markdown 注册一个 transformer。Transformer 按 extension 加载顺序运行，每个 transformer 接收前一个 transformer 返回的 Markdown。链执行完毕之后，Pi 使用其内置渲染器渲染转换后的内容。

Transformer 接收 Markdown 字符串和一个 context，其中包含：

- `messageType` — `"user"`、`"assistant"` 或 `"assistant-thinking"`
- `isStreaming` — 对于部分 assistant 更新为 `true`；对于用户、最终确定的 assistant 以及恢复的消息为 `false`
- `availableWidth` — 转换后的 Markdown 内容可用的确切终端列数

返回转换后的 Markdown：

```typescript
pi.registerMarkdownTransformer((markdown, { messageType, isStreaming }) => {
  if (isStreaming || messageType === "assistant-thinking") return markdown;
  return markdown.replaceAll("-->", "→");
});
```

如果某个 transformer 抛出异常，Pi 会保留到目前为止产生的 Markdown，并继续执行下一个 transformer。该 hook 仅用于显示：原始消息在 session 和 model context 中保持不变。它会在新的用户消息、assistant 流式更新、恢复的 session 消息以及终端宽度变化时运行，因此 transformer 应保持同步且开销低廉。

### pi.registerEntryRenderer(customType, renderer)

为使用你的 `customType` 的自定义条目注册自定义 TUI 渲染器。自定义条目通过 `pi.appendEntry()` 创建，且不参与 LLM context。

```typescript
import { Box, Text } from "@earendil-works/pi-tui";

pi.registerEntryRenderer("status-card", (entry, { expanded }, theme) => {
  const data = entry.data as { title: string; count: number };
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(`${theme.bold(data.title)}: ${data.count}`));
  if (expanded) {
    box.addChild(new Text(theme.fg("dim", JSON.stringify(data, null, 2))));
  }
  return box;
});

pi.appendEntry("status-card", { title: "Indexed files", count: 17 });
```

### pi.registerShortcut(shortcut, options)

注册一个键盘 shortcut。关于 shortcut 格式和内置 keybinding，参见 [keybindings.md](keybindings.md)。

```typescript
pi.registerShortcut("ctrl+shift+p", {
  description: "Toggle plan mode",
  handler: async (ctx) => {
    ctx.ui.notify("Toggled!");
  },
});
```

### pi.registerFlag(name, options)

注册一个 CLI 标志。

```typescript
pi.registerFlag("plan", {
  description: "Start in plan mode",
  type: "boolean",
  default: false,
});

// Check value
if (pi.getFlag("plan")) {
  // Plan mode enabled
}
```

### pi.exec(command, args, options?)

执行一个 shell 命令。

```typescript
const result = await pi.exec("git", ["status"], { signal, timeout: 5000 });
// result.stdout, result.stderr, result.code, result.killed
```

### pi.getActiveTools() / pi.getAllTools() / pi.setActiveTools(names)

管理活动的 tool。这对内置 tool 和动态注册的 tool 都适用。`pi.getActiveTools()` 以 `string[]` 返回活动 tool 的名称；`pi.getAllTools()` 返回所有已配置 tool 的元数据。

```typescript
const active = pi.getActiveTools(); // ["read", "bash", ...]
const all = pi.getAllTools();
// all = [{
//   name: "read",
//   description: "Read file contents...",
//   parameters: ...,
//   promptGuidelines: ["Use read to examine files instead of cat or sed."],
//   sourceInfo: { path: "<builtin:read>", source: "builtin", scope: "temporary", origin: "top-level" }
// }, ...]
const builtinTools = all.filter((t) => t.sourceInfo.source === "builtin");
const extensionTools = all.filter((t) => t.sourceInfo.source !== "builtin" && t.sourceInfo.source !== "sdk");
pi.setActiveTools([...new Set([...active, "my_custom_tool"])]); // Keep current tools and enable my_custom_tool
pi.setActiveTools(["read", "bash"]); // Switch to read-only
```

`pi.getAllTools()` 返回 `name`、`description`、`parameters`、`promptGuidelines` 和 `sourceInfo`。

典型的 `sourceInfo.source` 值：
- `builtin` 表示内置 tool
- `sdk` 表示通过 `createAgentSession({ customTools })` 传入的 tool
- 由 extension 注册的 tool 的 extension 来源元数据

### pi.setModel(model)

为当前 session 设置 model。该变更会记录在 session 历史中，并在该 session 被恢复时还原，但它不会改变新 session 所使用的已配置 `defaultProvider` 或 `defaultModel`。如果该 model 的 provider 未配置认证，则返回 `false`。关于配置自定义 model，参见 [models.md](models.md)。

```typescript
const model = ctx.modelRegistry.find("anthropic", "claude-sonnet-4-5");
if (model) {
  const success = await pi.setModel(model);
  if (!success) {
    ctx.ui.notify("No API key for this model", "error");
  }
}
```

### pi.getThinkingLevel() / pi.setThinkingLevel(level)

获取当前 thinking level。Level 会被钳制到 model 的能力范围内（非 reasoning model 始终使用 "off"）。变更会发出 `thinking_level_select`。

`pi.setThinkingLevel()` 会改变当前 session 的 thinking level。该变更会记录在 session 历史中，并在该 session 被恢复时还原，但它不会改变新 session 所使用的已配置默认值。

```typescript
const current = pi.getThinkingLevel();  // "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
pi.setThinkingLevel("high");
```

### pi.events

用于 extension 之间通信的共享事件总线：

```typescript
pi.events.on("my:event", (data) => { ... });
pi.events.emit("my:event", { ... });
```

### pi.registerProvider(name, config)

动态注册或覆盖一个 model provider。适用于代理、自定义端点或团队范围的 model 配置。

在 extension 工厂函数期间进行的调用会被排队，并在 runner 初始化后应用。在那之后进行的调用 —— 例如来自用户设置流程之后的命令处理器 —— 会立即生效，无需 `/reload`。

动态 provider 可以实现 `refreshModels`。Pi 在 model 刷新期间调用它，通过 provider 同步发布返回的列表，并传入规范的 credential/stored-catalog/network/signal context。由 extension 决定是否通过带 generation 校验的 `context.publish({ persist: entry })` 持久化 catalog 元数据；诸如 llama.cpp 之类的实时服务器可以返回 model 而不持久化它们。

`context.signal` 始终是一个具体信号，provider 回调必须将它传递给阻塞式 I/O。公开的 `ModelRuntime.refresh()` 和 `ModelRegistry.refresh()` 调用接受一个可选 signal，省略它时不受时限约束；extension 和应用程序自行选择它们的截止时间。即使某个 provider 忽略该 signal，取消也会停止调用方等待，但仍然需要该 provider 的配合才能停止底层工作。

需要原生 provider 认证、过滤、刷新或流式行为的 extension，可以从 `@earendil-works/pi-ai` 注册一个完整的 `Provider`。该 provider 会成为组合基础，`models.json` 的覆盖仍然在其之上生效。

```typescript
import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai";

const provider = createProvider({
  id: "local-server",
  name: "Local Server",
  baseUrl: "http://localhost:8080/v1",
  auth: {
    apiKey: {
      name: "Local server setup",
      async login(interaction) {
        return {
          type: "api_key",
          key: await interaction.prompt({ type: "secret", message: "API key" }),
        };
      },
      async resolve({ credential }) {
        return credential?.key
          ? { auth: { apiKey: credential.key }, source: "stored API key" }
          : undefined;
      },
    },
  },
  models: [],
  api: openAICompletionsApi(),
});

pi.registerProvider(provider);

// Register a new provider with custom models
pi.registerProvider("my-proxy", {
  name: "My Proxy",
  baseUrl: "https://proxy.example.com",
  apiKey: "$PROXY_API_KEY",  // env var reference
  api: "anthropic-messages",
  models: [
    {
      id: "claude-sonnet-4-20250514",
      name: "Claude 4 Sonnet (proxy)",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384
    }
  ]
});

// Register a live llama.cpp catalog without persisting discovered models
pi.registerProvider("llama.cpp", {
  baseUrl: "http://localhost:8080/v1",
  apiKey: "local",
  api: "openai-completions",
  async refreshModels({ signal }) {
    const response = await fetch("http://localhost:8080/v1/models", { signal });
    const { data } = await response.json();
    return data.map(({ id }) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384
    }));
  }
});

// Override baseUrl for an existing provider (keeps all models)
pi.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com"
});

// Register provider with OAuth support for /login
pi.registerProvider("corporate-ai", {
  baseUrl: "https://ai.corp.com",
  api: "openai-responses",
  models: [...],
  oauth: {
    name: "Corporate AI (SSO)",
    async login(callbacks) {
      // Custom OAuth flow
      callbacks.onAuth({ url: "https://sso.corp.com/..." });
      const code = await callbacks.onPrompt({ message: "Enter code:" });
      return { refresh: code, access: code, expires: Date.now() + 3600000 };
    },
    async refreshToken(credentials, signal) {
      signal.throwIfAborted();
      // Refresh logic
      return credentials;
    },
    getApiKey(credentials) {
      return credentials.access;
    }
  }
});
```

对象形式接受一个完整的 pi-ai `Provider`，包括原生 `auth`、`getModels`、`refreshModels`、`filterModels`、`stream` 和 `streamSimple` 行为。

**旧版配置选项：**
- `name` - 在 UI（例如 `/login`）中显示 provider 的名称。
- `baseUrl` - API 端点 URL。定义 model 时必填。
- `apiKey` - API key 字面量、环境变量插值（`$ENV_VAR` 或 `${ENV_VAR}`），或前导 `!command`。定义 model 时必填（除非提供了 `oauth`）。`$$` 转义 `$`，`$!` 转义字面量 `!` 而不触发命令执行。
- `api` - API 类型：`"anthropic-messages"`、`"openai-completions"`、`"openai-responses"` 等。
- `headers` - 要包含在请求中的自定义 header。
- `authHeader` - 如果为 true，会自动添加 `Authorization: Bearer` header。
- `models` - model 定义数组。如果提供，会替换该 provider 的所有现有 model。model 定义可以设置 `baseUrl` 来覆盖该 model 的 provider 端点。
- `refreshModels` - 异步动态发现回调。其返回的 model 会替换 extension 提供的 model。`context.stored` 包含持久化的 provider snapshot；仅当更新后的 catalog 数据应当持久化时，才使用带 generation 校验的 `context.publish({ persist: entry })`。使用 `persist: null` 删除该 snapshot。
- `oauth` - 用于支持 `/login` 的 OAuth provider 配置。提供后，该 provider 会出现在登录菜单中。
- `streamSimple` - 针对非标准 API 的自定义流式实现。

关于进阶主题（自定义流式 API、OAuth 细节、model 定义参考），参见 [custom-provider.md](custom-provider.md)。

### pi.unregisterProvider(name)

移除此前注册的 provider 及其 model。被该 provider 覆盖的内置 model 会被恢复。如果该 provider 未被注册，则无效果。

与 `registerProvider` 一样，在初始加载阶段之后调用它会立即生效，因此不需要 `/reload`。

```typescript
pi.registerCommand("my-setup-teardown", {
  description: "Remove the custom proxy provider",
  handler: async (_args, _ctx) => {
    pi.unregisterProvider("my-proxy");
  },
});
```

## 状态管理

带状态的 extension 应将其状态存储在 tool 结果的 `details` 中，以获得正确的 branch 支持：

```typescript
export default function (pi: ExtensionAPI) {
  let items: string[] = [];

  // Reconstruct state from session
  pi.on("session_start", async (_event, ctx) => {
    items = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (entry.message.toolName === "my_tool") {
          items = entry.message.details?.items ?? [];
        }
      }
    }
  });

  pi.registerTool({
    name: "my_tool",
    // ...
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      items.push("new item");
      return {
        content: [{ type: "text", text: "Added" }],
        details: { items: [...items] },  // Store for reconstruction
      };
    },
  });
}
```

## 自定义 Tool

通过 `pi.registerTool()` 注册 LLM 可以调用的 tool。Tool 会出现在 system prompt 中，并且可以具有自定义渲染。

使用 `promptSnippet` 在默认 system prompt 的 `Available tools` 部分中添加一行简短条目。如果省略，自定义 tool 将不会出现在该部分中。

使用 `promptGuidelines` 将 tool 特定的要点添加到默认 system prompt 的 `Guidelines` 部分。这些要点仅在 tool 处于活动状态时（例如在执行 `pi.setActiveTools([...])` 之后）才会被包含。

**重要：** `promptGuidelines` 要点会以扁平方式追加到 `Guidelines` 部分，不带 tool 名称前缀或分组。每条 guideline 都必须指明它所引用的 tool —— 避免使用 "Use this tool when..."，因为 LLM 无法分辨 "this" 指的是哪个 tool。应改写为 "Use my_tool when..."。

注意：有些 model 很笨，会在 tool 路径参数中包含 @ 前缀。内置 tool 会在解析路径之前剥离前导 @。如果你的自定义 tool 接受路径，也应当对前导 @ 进行规范化。

如果你的自定义 tool 会修改文件，请使用 `withFileMutationQueue()`，使其参与与内置 `edit` 和 `write` 相同的按文件队列。这一点很重要，因为 tool 调用默认并行运行。如果没有该队列，两个 tool 可能会读取相同的旧文件内容、计算出不同的更新，然后后落盘的那个写入会覆盖另一个。

示例失败场景：你的自定义 tool 编辑 `foo.ts`，而内置 `edit` 在同一个 assistant turn 中也修改 `foo.ts`。如果你的 tool 不参与该队列，两者都可能读取原始的 `foo.ts`，各自应用不同的修改，其中一个修改会丢失。

将真实的目标文件路径传给 `withFileMutationQueue()`，而不是原始的用户参数。首先将其解析为绝对路径，相对于 `ctx.cwd` 或你的 tool 的工作目录。对于已存在的文件，该辅助函数会通过 `realpath()` 进行规范化，因此同一文件的符号链接别名会共享同一个队列。对于新文件，它会回退到解析后的绝对路径，因为此时还没有可供 `realpath()` 处理的内容。

在该目标路径上对整个变更窗口进行排队。这包括读-改-写逻辑，而不仅仅是最终的写入。

```typescript
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  const absolutePath = resolve(ctx.cwd, params.path);

  return withFileMutationQueue(absolutePath, async () => {
    await mkdir(dirname(absolutePath), { recursive: true });
    const current = await readFile(absolutePath, "utf8");
    const next = current.replace(params.oldText, params.newText);
    await writeFile(absolutePath, next, "utf8");

    return {
      content: [{ type: "text", text: `Updated ${params.path}` }],
      details: {},
    };
  });
}
```

### Tool 定义

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does (shown to LLM)",
  promptSnippet: "List or add items in the project todo list",
  promptGuidelines: [
    "Use my_tool for todo planning instead of direct file edits when the user asks for a task list."
  ],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),  // Use StringEnum for Google compatibility
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {
    if (!args || typeof args !== "object") return args;
    const input = args as { action?: string; oldAction?: string };
    if (typeof input.oldAction === "string" && input.action === undefined) {
      return { ...input, action: input.oldAction };
    }
    return args;
  },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Check for cancellation
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }

    // Stream progress updates
    onUpdate?.({
      content: [{ type: "text", text: "Working..." }],
      details: { progress: 50 },
    });

    // Run commands via pi.exec (captured from extension closure)
    const result = await pi.exec("some-command", [], { signal });

    // Return result
    return {
      content: [{ type: "text", text: "Done" }],  // Sent to LLM
      details: { data: result },                   // For rendering & state
      // usage: nestedModelResponse.usage,          // Optional nested LLM usage
      // Optional: stop after this tool batch when every finalized tool result
      // in the batch also returns terminate: true.
      terminate: true,
    };
  },

  // Optional: Custom rendering
  renderCall(args, theme, context) { ... },
  renderResult(result, options, theme, context) { ... },
});
```

**用量核算：** 如果某个 tool 发起了嵌套的 LLM 调用，将它们合并后的 `Usage` 作为 `usage` 返回。Pi 会将其持久化在 tool 结果上，并计入 footer、`/session` 和 RPC session 总计。`tool_result` 处理器可以检查或替换该值。

**发出错误信号：** 要将一次 tool 执行标记为失败（在结果上设置 `isError: true` 并报告给 LLM），从 `execute` 中抛出一个错误。返回值永远不会设置错误标志，无论你在返回对象中包含了什么属性。

**提前终止：** 从 `execute()` 返回 `terminate: true`，以提示在当前 tool 批次之后应跳过自动的后续 LLM 调用。只有当该批次中每个最终确定的 tool 结果都是 terminating 时才会生效。关于一个最小的示例（agent 在最终的 structured-output tool 调用上结束），参见 [examples/extensions/structured-output.ts](../examples/extensions/structured-output.ts)。

```typescript
// Correct: throw to signal an error
async execute(toolCallId, params) {
  if (!isValid(params.input)) {
    throw new Error(`Invalid input: ${params.input}`);
  }
  return { content: [{ type: "text", text: "OK" }], details: {} };
}
```

**重要：** 对字符串枚举使用来自 `@earendil-works/pi-ai` 的 `StringEnum`。`Type.Union`/`Type.Literal` 无法与 Google 的 API 配合使用。

**参数准备：** `prepareArguments(args)` 是可选的。如果定义了，它会在 schema 校验之前、`execute()` 之前运行。当 pi 恢复一个较旧的 session，而该 session 存储的 tool 调用参数不再匹配当前 schema 时，使用它来模拟较旧的、被接受的输入结构。返回你希望按 `parameters` 进行校验的对象。保持公开 schema 严格。不要仅仅为了让旧的恢复 session 能工作就向 `parameters` 添加已弃用的兼容字段。

示例：一个较旧的 session 可能包含一次带有顶层 `oldText` 和 `newText` 的 `edit` tool 调用，而当前 schema 只接受 `edits: [{ oldText, newText }]`。

```typescript
pi.registerTool({
  name: "edit",
  label: "Edit",
  description: "Edit a single file using exact text replacement",
  parameters: Type.Object({
    path: Type.String(),
    edits: Type.Array(
      Type.Object({
        oldText: Type.String(),
        newText: Type.String(),
      }),
    ),
  }),
  prepareArguments(args) {
    if (!args || typeof args !== "object") return args;

    const input = args as {
      path?: string;
      edits?: Array<{ oldText: string; newText: string }>;
      oldText?: unknown;
      newText?: unknown;
    };

    if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
      return args;
    }

    return {
      ...input,
      edits: [...(input.edits ?? []), { oldText: input.oldText, newText: input.newText }],
    };
  },
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // params now matches the current schema
    return {
      content: [{ type: "text", text: `Applying ${params.edits.length} edit block(s)` }],
      details: {},
    };
  },
});
```

### 覆盖内置 Tool

Extension 可以通过注册同名 tool 来覆盖内置 tool（`read`、`bash`、`powershell`、`edit`、`write`、`grep`、`find`、`ls`）。发生这种情况时，交互模式会显示一条警告。

```bash
# Extension's read tool replaces built-in read
pi -e ./tool-override.ts
```

或者，使用 `--no-builtin-tools` 在不带任何内置 tool 的情况下启动，同时保持 extension tool 处于启用状态：
```bash
# No built-in tools, only extension tools
pi --no-builtin-tools -e ./my-extension.ts
```

关于一个用日志和访问控制覆盖 `read` 的完整示例，参见 [examples/extensions/tool-override.ts](../examples/extensions/tool-override.ts)。

**渲染：** 内置渲染器的继承按槽位解析。执行覆盖和渲染覆盖是相互独立的。如果你的覆盖省略了 `renderCall`，则使用内置的 `renderCall`。如果你的覆盖省略了 `renderResult`，则使用内置的 `renderResult`。如果你的覆盖两者都省略，则自动使用内置渲染器（语法高亮、diff 等）。这让你可以包装内置 tool 以实现日志或访问控制，而无需重新实现 UI。

**Prompt 元数据：** `promptSnippet` 和 `promptGuidelines` 不会从内置 tool 继承。如果你的覆盖应当保留这些 prompt 指令，请在你的覆盖上显式定义它们。

**你的实现必须匹配确切的结果结构**，包括 `details` 类型。UI 和 session 逻辑依赖这些结构来进行渲染和状态跟踪。

内置 tool 实现：
- [read.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/read.ts) - `ReadToolDetails`
- [bash.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/bash.ts) - `BashToolDetails`
- [powershell.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/powershell.ts) - `PowerShellToolDetails`
- [edit.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/edit.ts)
- [write.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/write.ts)
- [grep.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/grep.ts) - `GrepToolDetails`
- [find.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/find.ts) - `FindToolDetails`
- [ls.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/ls.ts) - `LsToolDetails`

### 远程执行

内置 tool 支持可插拔的 operation，用于委派给远程系统（SSH、容器等）：

```typescript
import { createReadTool, createBashTool, type ReadOperations } from "@earendil-works/pi-coding-agent";

// Create tool with custom operations
const remoteRead = createReadTool(cwd, {
  operations: {
    readFile: (path) => sshExec(remote, `cat ${path}`),
    access: (path) => sshExec(remote, `test -r ${path}`).then(() => {}),
  }
});

// Register, checking flag at execution time
pi.registerTool({
  ...remoteRead,
  async execute(id, params, signal, onUpdate, _ctx) {
    const ssh = getSshConfig();
    if (ssh) {
      const tool = createReadTool(cwd, { operations: createRemoteOps(ssh) });
      return tool.execute(id, params, signal, onUpdate);
    }
    return localRead.execute(id, params, signal, onUpdate);
  },
});
```

**Operations 接口：** `ReadOperations`、`WriteOperations`、`EditOperations`、`BashOperations`、`PowerShellOperations`、`LsOperations`、`GrepOperations`、`FindOperations`

对于 `user_bash`，extension 可以通过 `createLocalBashOperations()` 复用 pi 的本地 shell 后端，而无需重新实现本地进程启动、shell 解析和进程树终止。

`bash` 和 `powershell` tool 还支持一个 spawn hook，用于在执行前调整命令、cwd 或 env：

```typescript
import { createBashTool } from "@earendil-works/pi-coding-agent";

const bashTool = createBashTool(cwd, {
  spawnHook: ({ command, cwd, env }) => ({
    command: `source ~/.profile\n${command}`,
    cwd: `/mnt/sandbox${cwd}`,
    env: { ...env, CI: "1" },
  }),
});
```

`createBashTool()` 和 `createPowerShellTool()` 通过 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL` 和 `PI_REASONING_LEVEL` 将当前 session 暴露给命令。注入发生在 `spawnHook` 之前，因此 hook 会在 `env` 中收到这些值，并在如上所述展开现有环境时保留它们。设置 `exposeSessionEnvironment: false` 以禁用它们：

```typescript
const bashTool = createBashTool(cwd, {
  exposeSessionEnvironment: false,
});
```

关于变量语义，参见 [Shell tool session environment](environment-variables.md#shell-tool-session-environment)。关于带 `--ssh` 标志的完整 SSH 示例，参见 [examples/extensions/ssh.ts](../examples/extensions/ssh.ts)。

### 输出截断

**Tool 必须截断其输出**，以避免压垮 LLM context。过大的输出可能导致：
- Context 溢出错误（prompt 过长）
- Compaction 失败
- model 性能下降

内置限制是 **50KB**（约 10k token）和 **2000 行**，以先达到者为准。使用导出的截断工具：

```typescript
import {
  truncateHead,      // Keep first N lines/bytes (good for file reads, search results)
  truncateTail,      // Keep last N lines/bytes (good for logs, command output)
  truncateLine,      // Truncate a single line to maxBytes with ellipsis
  formatSize,        // Human-readable size (e.g., "50KB", "1.5MB")
  DEFAULT_MAX_BYTES, // 50KB
  DEFAULT_MAX_LINES, // 2000
} from "@earendil-works/pi-coding-agent";

async execute(toolCallId, params, signal, onUpdate, ctx) {
  const output = await runCommand();

  // Apply truncation
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  let result = truncation.content;

  if (truncation.truncated) {
    // Write full output to temp file
    const tempFile = writeTempFile(output);

    // Inform the LLM where to find complete output
    result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
    result += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
    result += ` Full output saved to: ${tempFile}]`;
  }

  return { content: [{ type: "text", text: result }] };
}
```

**关键要点：**
- 对于开头重要的内容（搜索结果、文件读取）使用 `truncateHead`
- 对于结尾重要的内容（日志、命令输出）使用 `truncateTail`
- 当输出被截断时，始终告知 LLM，并说明在哪里可以找到完整版本
- 在你的 tool 描述中记录截断限制

关于一个用适当截断包装 `rg`（ripgrep）的完整示例，参见 [examples/extensions/truncated-tool.ts](../examples/extensions/truncated-tool.ts)。

### 多个 Tool

一个 extension 可以注册多个共享状态的 tool：

```typescript
export default function (pi: ExtensionAPI) {
  let connection = null;

  pi.registerTool({ name: "db_connect", ... });
  pi.registerTool({ name: "db_query", ... });
  pi.registerTool({ name: "db_close", ... });

  pi.on("session_shutdown", async () => {
    connection?.close();
  });
}
```

### 自定义渲染

Tool 可以提供 `renderCall` 和 `renderResult` 以实现自定义 TUI 显示。关于完整的 component API，参见 [tui.md](tui.md)；关于 tool 行是如何组合的，参见 [tool-execution.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/components/tool-execution.ts)。

默认情况下，tool 输出会被包裹在一个处理内边距和背景的 `Box` 中。已定义的 `renderCall` 或 `renderResult` 必须返回一个 `Component`。如果某个槽位的渲染器未定义，`tool-execution.ts` 会为该槽位使用回退渲染。

当 tool 应当渲染自己的外壳而不是使用默认 `Box` 时，设置 `renderShell: "self"`。这对于需要对边框或背景行为拥有完全控制权的 tool 很有用，例如在 tool 稳定后必须保持视觉稳定的大型预览。

```typescript
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "Custom shell example",
  parameters: Type.Object({}),
  renderShell: "self",
  async execute() {
    return { content: [{ type: "text", text: "ok" }], details: undefined };
  },
  renderCall(args, theme, context) {
    return new Text(theme.fg("accent", "my custom shell"), 0, 0);
  },
});
```

`renderCall` 和 `renderResult` 各自接收一个 `context` 对象，其中包含：
- `args` - 当前 tool 调用参数
- `state` - 在 `renderCall` 和 `renderResult` 之间共享的行本地状态
- `lastComponent` - 该槽位此前返回的 component（如果有）
- `invalidate()` - 请求重新渲染该 tool 行
- `toolCallId`、`cwd`、`executionStarted`、`argsComplete`、`isPartial`、`expanded`、`showImages`、`isError`

使用 `context.state` 存放跨槽位共享的状态。当你希望在多次渲染之间复用并修改同一个 component 时，将槽位本地缓存保留在返回的 component 实例上。

#### renderCall

渲染 tool 调用或 header：

```typescript
import { Text } from "@earendil-works/pi-tui";

renderCall(args, theme, context) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  let content = theme.fg("toolTitle", theme.bold("my_tool "));
  content += theme.fg("muted", args.action);
  if (args.text) {
    content += " " + theme.fg("dim", `"${args.text}"`);
  }
  text.setText(content);
  return text;
}
```

#### renderResult

渲染 tool 结果或输出：

```typescript
renderResult(result, { expanded, isPartial }, theme, context) {
  if (isPartial) {
    return new Text(theme.fg("warning", "Processing..."), 0, 0);
  }

  if (result.details?.error) {
    return new Text(theme.fg("error", `Error: ${result.details.error}`), 0, 0);
  }

  let text = theme.fg("success", "✓ Done");
  if (expanded && result.details?.items) {
    for (const item of result.details.items) {
      text += "\n  " + theme.fg("dim", item);
    }
  }
  return new Text(text, 0, 0);
}
```

如果某个槽位有意不显示任何可见内容，返回一个空的 `Component`，例如一个空 `Container`。

#### Keybinding 提示

使用 `keyHint()` 显示遵循当前 keybinding 配置的 keybinding 提示：

```typescript
import { keyHint } from "@earendil-works/pi-coding-agent";

renderResult(result, { expanded }, theme, context) {
  let text = theme.fg("success", "✓ Done");
  if (!expanded) {
    text += ` (${keyHint("app.tools.expand", "to expand")})`;
  }
  return new Text(text, 0, 0);
}
```

可用函数：
- `keyHint(keybinding, description)` - 格式化已配置的 keybinding id，例如 `"app.tools.expand"` 或 `"tui.select.confirm"`
- `keyText(keybinding)` - 返回某个 keybinding id 的原始已配置按键文本
- `rawKeyHint(key, description)` - 格式化一个原始按键字符串

使用带命名空间的 keybinding id：
- Coding-agent 的 id 使用 `app.*` 命名空间，例如 `app.tools.expand`、`app.editor.external`、`app.session.rename`
- 共享 TUI 的 id 使用 `tui.*` 命名空间，例如 `tui.select.confirm`、`tui.select.cancel`、`tui.input.tab`

关于 keybinding id 和默认值的详尽列表，参见 [keybindings.md](keybindings.md)。`keybindings.json` 使用这些相同的带命名空间 id。

自定义 editor 和 `ctx.ui.custom()` component 会收到作为注入参数的 `keybindings: KeybindingsManager`。它们应当直接使用该注入的 manager，而不是调用 `getKeybindings()` 或 `setKeybindings()`。

#### 最佳实践

- 使用带内边距 `(0, 0)` 的 `Text`。默认 Box 会处理内边距。
- 多行内容使用 `\n`。
- 为流式进度处理 `isPartial`。
- 支持 `expanded` 以按需显示详情。
- 保持默认视图紧凑。
- 在 `renderResult` 中读取 `context.args`，而不是将 args 复制到 `context.state`。
- 仅将 `context.state` 用于必须在 call 和 result 槽位之间共享的数据。
- 当同一个 component 实例可以就地更新时，复用 `context.lastComponent`。
- 仅当默认的盒式外壳造成妨碍时才使用 `renderShell: "self"`。在 self-shell 模式下，tool 需自行负责其边框、内边距和背景。

#### 回退

如果某个槽位的渲染器未定义或抛出异常：
- `renderCall`：显示 tool 名称
- `renderResult`：显示来自 `content` 的原始文本

### 动态 Tool 加载

Extension 可以注册许多 tool，同时只保持一小组初始 tool 处于活动状态。随后某个 tool 可以在执行期间通过 `pi.setActiveTools()` 添加更多 tool。Pi 会检测纯增量式的变更，将新可用的 tool 名称记录在该 tool 结果上，并在下一次 model 请求之前应用更新后的活动集合。

这对每一种 model 都有效。具有原生 deferred-loading 支持的 model 会保留稳定的 prompt 前缀，并在 tool 结果位置加载新的定义。其他 model 使用下文描述的回退方案。

生命周期如下：

1. 用 `pi.registerTool()` 注册每一个 tool，使其出现在 `pi.getAllTools()` 中。
2. 保持 loader tool（例如 `search_tools`）处于活动状态，并让可搜索的 tool 保持非活动状态。
3. 在 loader 执行期间，调用 `pi.setActiveTools([...currentTools, ...matchingTools])`。该变更必须是增量式的：不要在同一次调用中移除当前活动的 tool。
4. Pi 在 loader 的 tool 结果上记录哪些 tool 被添加了。
5. 在下一次 model 响应之前，Pi 会在受支持时使用原生 deferred loading 暴露新增的定义，否则使用正常的活动 tool 列表。

你不需要返回 provider 特定的 tool 引用，也不需要将 loader 标记为特殊的搜索 tool。活动 tool 的变更本身就是信号。传给 `pi.setActiveTools()` 的名称必须已经注册；未知名称会被忽略。

#### 具有原生 deferred loading 的 model

- **Anthropic**
  - **Model：** Sonnet、Opus、Fable 4.5 或更新版本（不含 Haiku）
  - **原生表示：** 延迟定义使用 `defer_loading`；加载点使用 `tool_reference` content。
- **Fireworks Messages API**
  - **原生表示：** 延迟定义使用 `defer_loading`；加载点使用 `tool_reference` content。
  - **Loader 名称：** 使用 `ToolSearch` 或 `tool_search` 以实现前缀延迟。其他 loader 名称仍然可用，但 Fireworks 会将已加载的 schema 包含在初始 tool 前缀中，从而失去缓存收益。
  - 这不会改变 API 路由：Fireworks GLM model 和 Kimi K3 使用 Chat Completions，而不是 Messages。
- **OpenAI**
  - **Model：** `gpt-5.4` 及更新的系列
  - **原生表示：** Pi 在加载点添加已完成的客户端 `tool_search_call` 和 `tool_search_output` 项。

对于经过验证的自定义 model 或代理，可以通过 `compat.supportsToolReferences: true`（用于 `anthropic-messages`）或 `compat.supportsToolSearch: true`（用于 `openai-responses` 和 `openai-codex-responses`）启用原生处理。除非端点和 model 接受相应的原生协议，否则请保持这些选项处于禁用状态。

#### 回退行为

对于所有其他 model 和 provider，动态激活仍然有效：Pi 会在下一次请求时正常发送当前完整的活动 tool 列表。model 可以调用新激活的 tool，但添加它们的定义可能会使 provider 缓存的 prompt 前缀失效。

当活动集合不是纯增量式时（例如用一组 tool 替换另一组），Pi 也会使用这种安全的回退方案。因此 tool 移除可以工作，但它们不会使用 deferred loading。

为了获得最佳的缓存行为，请在整个 session 期间保持 loader tool 处于活动状态，并添加 tool 而不是替换活动集合。另请注意，激活一个带有 `promptSnippet` 或 `promptGuidelines` 的 tool 会重建 system prompt；即使 provider 支持延迟 schema，这种 system-prompt 变更也可能使前缀失效。延迟加载的 tool 通常应依赖其 tool `description`，并省略仅活动时使用的 prompt 元数据。

#### 搜索 tool 示例

以下 extension 注册两个可搜索的 tool，将它们从初始活动集合中移除，并只保留 `search_tools` 作为它们的 loader。该示例使用简单的关键词匹配，但搜索实现可以使用 BM25、embedding、远程 catalog 或项目特定的路由。

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SEARCHABLE_TOOL_NAMES = new Set(["lookup_weather", "search_issues"]);

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "lookup_weather",
    label: "Lookup Weather",
    description: "Look up the current weather for a city",
    parameters: Type.Object({ city: Type.String() }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `Weather for ${params.city}: sunny` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "search_issues",
    label: "Search Issues",
    description: "Search project issues by keyword",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `No open issues matching ${params.query}` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "search_tools",
    label: "Search Tools",
    description: "Search for and enable tools relevant to a task",
    promptSnippet: "Search for additional tools when the active tools cannot perform the task",
    promptGuidelines: [
      "Use search_tools when a task requires a capability that is not currently available.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Capability or task to search for" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    }),
    async execute(_toolCallId, params) {
      const terms = params.query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const matches = pi.getAllTools()
        .filter((tool) => SEARCHABLE_TOOL_NAMES.has(tool.name))
        .map((tool) => ({
          tool,
          score: terms.reduce(
            (score, term) =>
              score + (`${tool.name} ${tool.description}`.toLowerCase().includes(term) ? 1 : 0),
            0,
          ),
        }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, params.limit ?? 3)
        .map((match) => match.tool.name);

      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: `No tools found for: ${params.query}` }],
          details: { matches: [] },
        };
      }

      const active = pi.getActiveTools();
      const added = matches.filter((name) => !active.includes(name));
      pi.setActiveTools([...new Set([...active, ...added])]);

      return {
        content: [{
          type: "text",
          text: added.length > 0
            ? `Loaded tools: ${added.join(", ")}`
            : `Matching tools already active: ${matches.join(", ")}`,
        }],
        details: { matches, added },
      };
    },
  });

  pi.on("session_start", () => {
    // Keep searchable tools registered but initially inactive. Preserve built-ins
    // and tools owned by other extensions, and keep the loader itself active.
    const initialTools = pi.getActiveTools().filter(
      (name) => !SEARCHABLE_TOOL_NAMES.has(name),
    );
    pi.setActiveTools([...new Set([...initialTools, "search_tools"])]);
  });
}
```

当 `search_tools` 添加一个匹配项时，model 会在紧接着的下一次请求中收到该定义。在具备原生能力的 model 上，该定义会被锚定在搜索结果之后，而不改变初始的 tool-schema 前缀。在其他 model 上，它会在同一次后续请求中出现在正常的 tool 列表中。

## 自定义 UI

Extension 可以通过 `ctx.ui` 方法与用户交互，并自定义消息/tool 的渲染方式。

**关于自定义 component，参见 [tui.md](tui.md)**，其中包含以下内容的可直接复制粘贴的模式：
- 选择对话框（SelectList）
- 带取消的异步操作（BorderedLoader）
- 设置开关（SettingsList）
- 状态指示器（setStatus）
- 流式输出期间的工作消息、可见性和指示器（`setWorkingMessage`、`setWorkingVisible`、`setWorkingIndicator`）
- editor 上方/下方的 widget（setWidget）
- 叠加在内置 slash/path 补全之上的自动补全 provider（addAutocompleteProvider）
- 自定义 footer（setFooter）

### 对话框

```typescript
// Select from options
const choice = await ctx.ui.select("Pick one:", ["A", "B", "C"]);

// Confirm dialog
const ok = await ctx.ui.confirm("Delete?", "This cannot be undone");

// Text input
const name = await ctx.ui.input("Name:", "placeholder");

// Multi-line editor
const text = await ctx.ui.editor("Edit:", "prefilled text");

// Notification (non-blocking)
ctx.ui.notify("Done!", "info");  // "info" | "warning" | "error"
```

#### 带倒计时的定时对话框

对话框支持 `timeout` 选项，它会以实时倒计时显示自动关闭：

```typescript
// Dialog shows "Title (5s)" → "Title (4s)" → ... → auto-dismisses at 0
const confirmed = await ctx.ui.confirm(
  "Timed Confirmation",
  "This dialog will auto-cancel in 5 seconds. Confirm?",
  { timeout: 5000 }
);

if (confirmed) {
  // User confirmed
} else {
  // User cancelled or timed out
}
```

**超时时的返回值：**
- `select()` 返回 `undefined`
- `confirm()` 返回 `false`
- `input()` 返回 `undefined`

#### 使用 AbortSignal 手动关闭

如需更多控制（例如区分超时和用户取消），使用 `AbortSignal`：

```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 5000);

const confirmed = await ctx.ui.confirm(
  "Timed Confirmation",
  "This dialog will auto-cancel in 5 seconds. Confirm?",
  { signal: controller.signal }
);

clearTimeout(timeoutId);

if (confirmed) {
  // User confirmed
} else if (controller.signal.aborted) {
  // Dialog timed out
} else {
  // User cancelled (pressed Escape or selected "No")
}
```

完整示例参见 [examples/extensions/timed-confirm.ts](../examples/extensions/timed-confirm.ts)。

### Widget、状态与 Footer

```typescript
// Status in footer (persistent until cleared)
ctx.ui.setStatus("my-ext", "Processing...");
ctx.ui.setStatus("my-ext", undefined);  // Clear

// Working loader (shown during streaming)
ctx.ui.setWorkingMessage("Thinking deeply...");
ctx.ui.setWorkingMessage();  // Restore default
ctx.ui.setWorkingVisible(false);  // Hide the built-in working loader row entirely
ctx.ui.setWorkingVisible(true);   // Show the built-in working loader row

// Working indicator (shown during streaming)
ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", "●")] });  // Static dot
ctx.ui.setWorkingIndicator({
  frames: [
    ctx.ui.theme.fg("dim", "·"),
    ctx.ui.theme.fg("muted", "•"),
    ctx.ui.theme.fg("accent", "●"),
    ctx.ui.theme.fg("muted", "•"),
  ],
  intervalMs: 120,
});
ctx.ui.setWorkingIndicator({ frames: [] });  // Hide indicator
ctx.ui.setWorkingIndicator();  // Restore default spinner

// Widget above editor (default)
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"]);
// Widget below editor
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"], { placement: "belowEditor" });
ctx.ui.setWidget("my-widget", (tui, theme) => new Text(theme.fg("accent", "Custom"), 0, 0));
ctx.ui.setWidget("my-widget", undefined);  // Clear

// Custom footer (replaces built-in footer entirely)
ctx.ui.setFooter((tui, theme) => ({
  render(width) { return [theme.fg("dim", "Custom footer")]; },
  invalidate() {},
}));
ctx.ui.setFooter(undefined);  // Restore built-in footer

// Terminal title
ctx.ui.setTitle("pi - my-project");

// Editor text
ctx.ui.setEditorText("Prefill text");
const current = ctx.ui.getEditorText();

// Paste into editor (triggers paste handling, including collapse for large content)
ctx.ui.pasteToEditor("pasted content");

// Stack custom autocomplete behavior on top of the built-in provider
ctx.ui.addAutocompleteProvider((current) => ({
  triggerCharacters: ["#"],
  async getSuggestions(lines, line, col, options) {
    const beforeCursor = (lines[line] ?? "").slice(0, col);
    const match = beforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
    if (!match) {
      return current.getSuggestions(lines, line, col, options);
    }

    return {
      prefix: `#${match[1] ?? ""}`,
      items: [{ value: "#2983", label: "#2983", description: "Extension API for autocomplete" }],
    };
  },
  applyCompletion(lines, line, col, item, prefix) {
    return current.applyCompletion(lines, line, col, item, prefix);
  },
  shouldTriggerFileCompletion(lines, line, col) {
    return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
  },
}));

// Tool output expansion
const wasExpanded = ctx.ui.getToolsExpanded();
ctx.ui.setToolsExpanded(true);
ctx.ui.setToolsExpanded(wasExpanded);

// Custom editor (vim mode, emacs mode, etc.)
ctx.ui.setEditorComponent((tui, theme, keybindings) => new VimEditor(tui, theme, keybindings));
const currentEditor = ctx.ui.getEditorComponent();
ctx.ui.setEditorComponent((tui, theme, keybindings) =>
  new WrappedEditor(tui, theme, keybindings, currentEditor?.(tui, theme, keybindings))
);
ctx.ui.setEditorComponent(undefined);  // Restore default editor

// Theme management (see themes.md for creating themes)
const themes = ctx.ui.getAllThemes();  // [{ name: "dark", path: "/..." | undefined }, ...]
const lightTheme = ctx.ui.getTheme("light");  // Load without switching
const result = ctx.ui.setTheme("light");  // Switch by name
if (!result.success) {
  ctx.ui.notify(`Failed: ${result.error}`, "error");
}
ctx.ui.setTheme(lightTheme!);  // Or switch by Theme object
ctx.ui.theme.fg("accent", "styled text");  // Access current theme
```

自定义 working-indicator 帧会按原样渲染。如果你想要颜色，请自行将颜色添加到帧字符串中，例如使用 `ctx.ui.theme.fg(...)`。

### 自动补全 Provider

使用 `ctx.ui.addAutocompleteProvider()` 将自定义自动补全逻辑叠加在内置 slash 命令和 path provider 之上。为诸如 `$` 之类的自定义自然触发符设置 `triggerCharacters`。

典型模式：

- 检查光标之前的文本
- 当你的 extension 特定语法匹配时返回你自己的建议
- 否则委派给 `current.getSuggestions(...)`
- 委派 `applyCompletion(...)`，除非你需要自定义插入行为

```typescript
pi.on("session_start", (_event, ctx) => {
  ctx.ui.addAutocompleteProvider((current) => ({
    triggerCharacters: ["#"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);
      const match = beforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
      if (!match) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      return {
        prefix: `#${match[1] ?? ""}`,
        items: [
          { value: "#2983", label: "#2983", description: "Extension API for registering custom @ autocomplete providers" },
          { value: "#2753", label: "#2753", description: "Reload stale resource settings" },
        ],
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  }));
});
```

关于一个用 `gh issue list` 预加载最新未关闭 GitHub issue 并在本地过滤以快速完成 `#...` 补全的完整示例，参见 [github-issue-autocomplete.ts](../examples/extensions/github-issue-autocomplete.ts)。它需要 GitHub CLI（`gh`）以及一个 GitHub 仓库检出。

### 自定义 Component

对于复杂 UI，使用 `ctx.ui.custom()`。它会临时用你的 component 替换 editor，直到调用 `done()`：

```typescript
import { Text, Component } from "@earendil-works/pi-tui";

const result = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
  const text = new Text("Press Enter to confirm, Escape to cancel", 1, 1);

  text.onKey = (key) => {
    if (key === "return") done(true);
    if (key === "escape") done(false);
    return true;
  };

  return text;
});

if (result) {
  // User pressed Enter
}
```

该回调接收：
- `tui` - TUI 实例（用于屏幕尺寸、焦点管理）
- `theme` - 用于样式化的当前 theme
- `keybindings` - App keybinding manager（用于检查 shortcut）
- `done(value)` - 调用它以关闭 component 并返回值

关于完整的 component API，参见 [tui.md](tui.md)。

#### Overlay 模式（实验性）

传入 `{ overlay: true }` 可将 component 渲染为浮在现有内容之上的模态框，而无需清屏：

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyOverlayComponent({ onClose: done }),
  { overlay: true }
);
```

对于高级定位（锚点、边距、百分比、响应式可见性），传入 `overlayOptions`。使用 `onHandle` 以编程方式控制焦点或可见性：

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyOverlayComponent({ onClose: done }),
  {
    overlay: true,
    overlayOptions: { anchor: "top-right", width: "50%", margin: 2 },
    onHandle: (handle) => {
      handle.focus(); // focus this overlay and bring it to the visual front
      // handle.unfocus({ target: editorComponent }); // release input to a specific component
      // handle.setHidden(true/false); // toggle visibility
      // handle.hide(); // permanently remove
    }
  }
);
```

一个已聚焦且可见的 overlay 可以在临时的非 overlay 自定义 UI 关闭后重新获取输入。如果你有意希望另一个 component 在 overlay 保持可见时继续持有输入，调用 `handle.unfocus({ target })`。传入 `{ target: null }` 会释放该 overlay 而不聚焦到另一个 component。

关于完整的 `OverlayOptions` 和 `OverlayHandle` API，参见 [tui.md](tui.md)；关于示例，参见 [overlay-qa-tests.ts](../examples/extensions/overlay-qa-tests.ts)。

### 自定义 Editor

用自定义实现（vim 模式、emacs 模式等）替换主输入 editor：

```typescript
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

class VimEditor extends CustomEditor {
  private mode: "normal" | "insert" = "insert";

  handleInput(data: string): void {
    if (matchesKey(data, "escape") && this.mode === "insert") {
      this.mode = "normal";
      return;
    }
    if (this.mode === "normal" && data === "i") {
      this.mode = "insert";
      return;
    }
    super.handleInput(data);  // App keybindings + text editing
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new VimEditor(tui, theme, keybindings)
    );
  });
}
```

**关键要点：**
- 继承 `CustomEditor`（而不是基类 `Editor`）以获得 app keybinding（escape 中止、ctrl+d、model 切换）
- 对你不处理的按键调用 `super.handleInput(data)`
- 自定义 editor 默认保留独立的 working 行。将 `{ embedWorkingStatus: true }` 作为 `CustomEditor` 构造函数的第四个参数传入，以改用内置的 editor 边框 spinner。
- 工厂从 app 接收 `tui`、`theme` 和 `keybindings`
- 在 `setEditorComponent()` 之前使用 `ctx.ui.getEditorComponent()` 来包装此前已配置的自定义 editor
- 传入 `undefined` 以恢复默认：`ctx.ui.setEditorComponent(undefined)`

要与另一个已经替换了 editor 的 extension 组合，在设置你自己的 editor 之前先捕获之前的工厂：

```typescript
const previous = ctx.ui.getEditorComponent();
ctx.ui.setEditorComponent((tui, theme, keybindings) =>
  new MyEditor(tui, theme, keybindings, { base: previous?.(tui, theme, keybindings) })
);
```

关于带 mode 指示器的完整示例，参见 [tui.md](tui.md) 的 Pattern 7。

### 消息与条目渲染

为使用你的 `customType` 的消息注册自定义渲染器。对应当参与 LLM context 的内容使用 message renderer：

```typescript
import { Text } from "@earendil-works/pi-tui";

pi.registerMessageRenderer("my-extension", (message, options, theme) => {
  const { expanded, outputPad } = options;
  let text = theme.fg("accent", `[${message.customType}] `);
  text += message.content;

  if (expanded && message.details) {
    text += "\n" + theme.fg("dim", JSON.stringify(message.details, null, 2));
  }

  return new Text(text, outputPad, 0);
});
```

消息通过 `pi.sendMessage()` 发送：

```typescript
pi.sendMessage({
  customType: "my-extension",  // Matches registerMessageRenderer
  content: "Status update",
  display: true,               // Show in TUI
  details: { ... },            // Available in renderer
});
```

对于不应发送给 LLM 的 TUI 专用内容，改为渲染自定义条目：

```typescript
pi.registerEntryRenderer("my-card", (entry, options, theme) => {
  return new Text(theme.fg("accent", JSON.stringify(entry.data)));
});

pi.appendEntry("my-card", { status: "done" });
```

### Theme 颜色

所有渲染函数都接收一个 `theme` 对象。关于创建自定义 theme 和完整调色板，参见 [themes.md](themes.md)。

```typescript
// Foreground colors
theme.fg("toolTitle", text)   // Tool names
theme.fg("accent", text)      // Highlights
theme.fg("success", text)     // Success (green)
theme.fg("error", text)       // Errors (red)
theme.fg("warning", text)     // Warnings (yellow)
theme.fg("muted", text)       // Secondary text
theme.fg("dim", text)         // Tertiary text

// Text styles
theme.bold(text)
theme.italic(text)
theme.strikethrough(text)
```

用于自定义 tool 渲染器中的语法高亮：

```typescript
import { highlightCode, getLanguageFromPath } from "@earendil-works/pi-coding-agent";

// Highlight code with explicit language
const highlighted = highlightCode("const x = 1;", "typescript", theme);

// Auto-detect language from file path
const lang = getLanguageFromPath("/path/to/file.rs");  // "rust"
const highlighted = highlightCode(code, lang, theme);
```

## 错误处理

- Extension 错误会被记录，agent 继续运行
- `tool_call` 错误会阻止该 tool（fail-safe）
- Tool 的 `execute` 错误必须通过抛出异常来发出信号；抛出的错误会被捕获，以 `isError: true` 报告给 LLM，然后继续执行

## 模式行为

| 模式 | `ctx.mode` | `ctx.hasUI` | 说明 |
|------|------------|-------------|-------|
| 交互式 | `"tui"` | `true` | 带终端渲染的完整 TUI |
| RPC（`--mode rpc`） | `"rpc"` | `true` | 通过 JSON 协议进行对话框和通知；`custom()` 返回 `undefined`。参见 [rpc.md](rpc.md) |
| JSON（`--mode json`） | `"json"` | `false` | 向 stdout 输出事件流；UI 方法为 no-op |
| Print（`-p`） | `"print"` | `false` | Extension 会运行，但无法提示 |

在 TUI 特有的特性（`custom()`、component 工厂、终端输入）之前使用 `ctx.mode === "tui"`。在 TUI 和 RPC 模式下都可用的对话框和通知方法之前使用 `ctx.hasUI`。

## 示例参考

所有示例都在 [examples/extensions/](../examples/extensions/)。

| 示例 | 描述 | 关键 API |
|---------|-------------|----------|
| **Tool** |||
| `hello.ts` | 最小的 tool 注册 | `registerTool` |
| `question.ts` | 带用户交互的 tool | `registerTool`, `ui.select` |
| `questionnaire.ts` | 多步向导 tool | `registerTool`, `ui.custom` |
| `todo.ts` | 带持久化的有状态 tool | `registerTool`, `appendEntry`, `renderResult`, session 事件 |
| `dynamic-tools.ts` | 在启动之后和命令执行期间注册 tool | `registerTool`, `session_start`, `registerCommand` |
| `structured-output.ts` | 带 `terminate: true` 的最终 structured-output tool | `registerTool`, terminating tool 结果 |
| `truncated-tool.ts` | 输出截断示例 | `registerTool`, `truncateHead` |
| `tool-override.ts` | 覆盖内置 read tool | `registerTool`（与内置同名） |
| **命令** |||
| `pirate.ts` | 逐 turn 修改 system prompt | `registerCommand`, `before_agent_start` |
| `summarize.ts` | 对话摘要命令 | `registerCommand`, `ui.custom` |
| `handoff.ts` | 跨 provider 的 model 交接 | `registerCommand`, `ui.editor`, `ui.custom` |
| `qna.ts` | 带自定义 UI 的问答 | `registerCommand`, `ui.custom`, `setEditorText` |
| `send-user-message.ts` | 注入用户消息 | `registerCommand`, `sendUserMessage` |
| `reload-runtime.ts` | reload 命令与 LLM tool 交接 | `registerCommand`, `ctx.reload()`, `sendUserMessage` |
| `shutdown-command.ts` | 优雅关闭命令 | `registerCommand`, `shutdown()` |
| **事件与闸门** |||
| `permission-gate.ts` | 阻止危险命令 | `on("tool_call")`, `ui.confirm` |
| `project-trust.ts` | 从 user/global 或 CLI extension 决定或推迟项目信任 | `on("project_trust")`, trust UI, 必需的 trust 结果 |
| `protected-paths.ts` | 阻止对特定路径的写入 | `on("tool_call")` |
| `confirm-destructive.ts` | 确认 session 变更 | `on("session_before_switch")`, `on("session_before_fork")` |
| `dirty-repo-guard.ts` | 在 git 仓库有未提交改动时警告 | `on("session_before_*")`, `exec` |
| `input-transform.ts` | 转换用户输入 | `on("input")` |
| `input-transform-streaming.ts` | 感知流式输出的输入转换 | `on("input")`, `streamingBehavior` |
| `model-status.ts` | 对 model 变更做出反应 | `on("model_select")`, `setStatus` |
| `provider-payload.ts` | 检查 payload 和 provider 响应 header | `on("before_provider_request")`, `on("after_provider_response")` |
| `system-prompt-header.ts` | 显示 system prompt 信息 | `on("agent_start")`, `getSystemPrompt` |
| `claude-rules.ts` | 从文件加载规则 | `on("session_start")`, `on("before_agent_start")` |
| `prompt-customizer.ts` | 使用 `systemPromptOptions` 添加上下文感知的 tool 指导 | `on("before_agent_start")`, `BuildSystemPromptOptions` |
| `file-trigger.ts` | 文件监听器触发消息 | `sendMessage` |
| **Compaction 与 Session** |||
| `custom-compaction.ts` | 自定义 compaction 摘要 | `on("session_before_compact")` |
| `trigger-compact.ts` | 手动触发 compaction | `compact()` |
| `git-checkpoint.ts` | 在 turn 时进行 git stash | `on("turn_start")`, `on("session_before_fork")`, `exec` |
| `git-merge-and-resolve.ts` | 获取、合并并解决冲突 | `on("agent_end")`, `exec`, `sendUserMessage` |
| `auto-commit-on-exit.ts` | 在 shutdown 时提交 | `on("session_shutdown")`, `exec` |
| **UI Component** |||
| `status-line.ts` | Footer 状态指示器 | `setStatus`, session 事件 |
| `working-indicator.ts` | 自定义流式输出的 working 指示器 | `setWorkingIndicator`, `registerCommand` |
| `github-issue-autocomplete.ts` | 通过从 `gh issue list` 预加载近期未关闭 issue，在内置自动补全之上添加 `#1234` issue 补全 | `addAutocompleteProvider`, `on("session_start")`, `exec` |
| `custom-footer.ts` | 完全替换 footer | `registerCommand`, `setFooter` |
| `custom-header.ts` | 替换启动 header | `on("session_start")`, `setHeader` |
| `modal-editor.ts` | Vim 风格模态 editor | `setEditorComponent`, `CustomEditor` |
| `rainbow-editor.ts` | 自定义 editor 样式 | `setEditorComponent` |
| `widget-placement.ts` | editor 上方/下方的 widget | `setWidget` |
| `overlay-test.ts` | Overlay component | 带 overlay 选项的 `ui.custom` |
| `overlay-qa-tests.ts` | 全面的 overlay 测试 | `ui.custom`, 所有 overlay 选项 |
| `notify.ts` | 简单的通知 | `ui.notify` |
| `timed-confirm.ts` | 带超时的对话框 | 带 timeout/signal 的 `ui.confirm` |
| `mac-system-theme.ts` | 自动切换 theme | `setTheme`, `exec` |
| **复杂 Extension** |||
| `plan-mode/` | 完整的 plan mode 实现 | 所有事件类型, `registerCommand`, `registerShortcut`, `registerFlag`, `setStatus`, `setWidget`, `sendMessage`, `setActiveTools` |
| `preset.ts` | 可保存的预设（model、tool、thinking） | `registerCommand`, `registerShortcut`, `registerFlag`, `setModel`, `setActiveTools`, `setThinkingLevel`, `appendEntry` |
| `tools.ts` | 开启/关闭 tool 的 UI | `registerCommand`, `setActiveTools`, `SettingsList`, session 事件 |
| **远程与沙箱** |||
| `ssh.ts` | SSH 远程执行 | `registerFlag`, `on("user_bash")`, `on("before_agent_start")`, tool operation |
| `interactive-shell.ts` | 持久化 shell session | `on("user_bash")` |
| `sandbox/` | 沙箱化的 tool 执行 | Tool operation |
| `gondolin/` | 将内置 tool 和 `!` 命令路由到 Gondolin micro-VM | Tool operation, 内置 tool 覆盖, `on("user_bash")` |
| `subagent/` | 派生子 agent | `registerTool`, `exec` |
| **游戏** |||
| `snake.ts` | 贪吃蛇游戏 | `registerCommand`, `ui.custom`, 键盘处理 |
| `space-invaders.ts` | 太空侵略者游戏 | `registerCommand`, `ui.custom` |
| `doom-overlay/` | 在 overlay 中运行 Doom | 带 overlay 的 `ui.custom` |
| **Provider** |||
| `custom-provider-anthropic/` | 自定义 Anthropic 代理 | `registerProvider` |
| `custom-provider-gitlab-duo/` | GitLab Duo 集成 | 带 OAuth 的 `registerProvider` |
| **消息与通信** |||
| `message-renderer.ts` | 自定义消息渲染 | `registerMessageRenderer`, `sendMessage` |
| `entry-renderer.ts` | TUI 专用的自定义条目渲染 | `registerEntryRenderer`, `appendEntry` |
| `event-bus.ts` | Extension 间事件 | `pi.events` |
| **Session 元数据** |||
| `session-name.ts` | 为选择器命名 session | `setSessionName`, `getSessionName` |
| `bookmark.ts` | 为 /tree 添加书签条目 | `setLabel` |
| **杂项** |||
| `inline-bash.ts` | 在 tool 调用中内联 bash | `on("tool_call")` |
| `bash-spawn-hook.ts` | 在执行前调整 bash 命令、cwd 和 env | `createBashTool`, `spawnHook` |
| `with-deps/` | 带 npm 依赖的 extension | 带 `package.json` 的 package 结构 |
