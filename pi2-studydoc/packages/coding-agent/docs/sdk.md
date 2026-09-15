> pi 可以帮助你使用 SDK。让它为你的用例构建一个集成。

# SDK

SDK 提供对 pi agent 能力的编程式访问。你可以用它把 pi 嵌入其他应用程序、构建自定义界面，或与自动化工作流集成。

**示例用例：**
- 构建自定义 UI（web、桌面、移动端）
- 将 agent 能力集成到现有应用程序中
- 创建带有 agent 推理的自动化流水线
- 构建可派生 sub-agents 的自定义 tools
- 以编程方式测试 agent 行为

从最小示例到完全控制的可用示例请参见 [examples/sdk/](../examples/sdk/)。

## 快速开始

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("What files are in the current directory?");
```

## 安装

```bash
npm install @earendil-works/pi-coding-agent
```

SDK 已包含在主 package 中。无需单独安装。

## 核心概念

### createAgentSession()

用于创建单个 `AgentSession` 的主要工厂函数。

`createAgentSession()` 使用 `ResourceLoader` 来提供 extensions、skills、prompt templates、themes 和 context files。如果你不提供，它会使用带标准发现机制的 `DefaultResourceLoader`。

```typescript
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

// Minimal: defaults with DefaultResourceLoader
const { session } = await createAgentSession();

// Custom: override specific options
const { session } = await createAgentSession({
  model: myModel,
  tools: ["read", "bash"],
  sessionManager: SessionManager.inMemory(),
});
```

### AgentSession

session 负责管理 agent 生命周期、消息历史、模型状态、compaction 和事件流。

```typescript
interface AgentSession {
  // Send a prompt and wait for completion
  prompt(text: string, options?: PromptOptions): Promise<void>;

  // Queue messages during streaming
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;

  // Subscribe to events (returns unsubscribe function)
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;

  // Session info
  sessionFile: string | undefined;
  sessionId: string;

  // Model control
  setModel(model: Model): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  cycleModel(): Promise<ModelCycleResult | undefined>;
  cycleThinkingLevel(): ThinkingLevel | undefined;

  // State access
  agent: Agent;
  model: Model | undefined;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  isStreaming: boolean;

  // In-place tree navigation within the current session file
  navigateTree(targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }): Promise<{ editorText?: string; cancelled: boolean }>;

  // Compaction
  compact(customInstructions?: string): Promise<CompactionResult>;
  abortCompaction(): void;

  // Abort current operation
  abort(): Promise<void>;

  // Cleanup
  dispose(): void;
}
```

当 agent 响应、手动或自动 compaction，或另一次 tree navigation 正在进行时，`session.navigateTree()` 会 reject，即使指定了 `summarize: false` 也是如此。对于这些冲突，它不会把导航排队，也不会返回 `{ cancelled: true }`。请等待当前活动操作结束（例如使用 `await session.waitForIdle()`）后重试。reject 会保持当前 branch 不变。

诸如 new-session、resume、fork 和 import 之类的 session 替换 API 位于 `AgentSessionRuntime` 上，而不是 `AgentSession` 上。

### createAgentSessionRuntime() 与 AgentSessionRuntime

当你需要替换当前活动 session 并重建绑定 cwd 的运行时状态时，请使用 runtime API。
这与内置的 interactive、print 和 RPC 模式使用的是同一层。

`createAgentSessionRuntime()` 接收一个 runtime 工厂以及初始的 cwd/session 目标。该工厂闭包持有进程级固定输入，为生效的 cwd 重建绑定 cwd 的 services，针对这些 services 解析 session options，并返回完整的 runtime 结果。

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});
```

`AgentSessionRuntime` 负责在以下操作中替换当前活动的 runtime：

- `newSession()`
- `switchSession()`
- `fork()`
- 通过 `fork(entryId, { position: "at" })` 进行的 clone 流程
- `importFromJsonl()`

重要行为：

- 这些操作之后，`runtime.session` 会发生变化
- 事件订阅绑定到特定的 `AgentSession`，因此在替换之后需要重新订阅
- 如果你使用 extensions，需要为新 session 再次调用 `runtime.session.bindExtensions(...)`
- 创建操作会在 `runtime.diagnostics` 上返回 diagnostics
- 如果 runtime 创建或替换失败，该方法会抛出异常，由调用方决定如何处理

```typescript
let session = runtime.session;
let unsubscribe = session.subscribe(() => {});

await runtime.newSession();

unsubscribe();
session = runtime.session;
unsubscribe = session.subscribe(() => {});
```

### Prompting 与消息排队

`PromptOptions` 控制 prompt 展开、流式输出期间的排队行为以及 prompt 预检通知：

```typescript
interface PromptOptions {
  expandPromptTemplates?: boolean;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
  source?: InputSource;
  preflightResult?: (success: boolean) => void;
}
```

每次调用 `prompt()` 时，`preflightResult` 都会被调用一次：

- prompt 被接受、排队或被立即处理时为 `true`
- prompt 预检在接受之前就被拒绝时为 `false`

它会在 `prompt()` resolve 之前触发。`prompt()` 仍然只会在被接受的完整运行结束后才 resolve，其中包括重试。接受之后的失败会通过正常的事件与消息流上报，而不会通过 `preflightResult(false)` 上报。

`prompt()` 方法负责处理 prompt templates、extension commands 和消息发送：

```typescript
// Basic prompt (when not streaming)
await session.prompt("What files are here?");

// With images
await session.prompt("What's in this image?", {
  images: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } }]
});

// During streaming: must specify how to queue the message
await session.prompt("Stop and do this instead", { streamingBehavior: "steer" });
await session.prompt("After you're done, also check X", { streamingBehavior: "followUp" });
```

**行为：**
- **Extension commands**（例如 `/mycommand`）：立即执行，即使在流式输出期间也是如此。它们通过 `pi.sendMessage()` 自行管理其 LLM 交互。
- **基于文件的 prompt templates**（来自 `.md` 文件）：在发送或排队之前展开为其内容。
- **流式输出期间未指定 `streamingBehavior`**：抛出错误。请直接使用 `steer()` 或 `followUp()`，或指定该选项。
- **`preflightResult(true)`**：表示 prompt 被接受、排队或被立即处理。
- **`preflightResult(false)`**：表示预检在接受之前就拒绝了。

在流式输出期间进行显式排队：

```typescript
// Queue a steering message for delivery after the current assistant turn finishes its tool calls
await session.steer("New instruction");

// Wait for agent to finish (delivered only when agent stops)
await session.followUp("After you're done, also do this");
```

`steer()` 与 `followUp()` 都会展开基于文件的 prompt templates，但对 extension commands 会报错（extension commands 无法排队）。

### Agent 与 AgentState

`Agent` 类（来自 `@earendil-works/pi-agent-core`）负责核心 LLM 交互。可通过 `session.agent` 访问它。

```typescript
// Access current state
const state = session.agent.state;

// state.messages: AgentMessage[] - conversation history
// state.model: Model - current model
// state.thinkingLevel: ThinkingLevel - current thinking level
// state.systemPrompt: string - system prompt
// state.tools: AgentTool[] - available tools
// state.streamingMessage?: AgentMessage - current partial assistant message
// state.errorMessage?: string - latest assistant error

// Replace messages (useful for branching or restoration)
session.agent.state.messages = messages; // copies the top-level array

// Replace tools
session.agent.state.tools = tools; // copies the top-level array

// Wait for agent to finish processing
await session.agent.waitForIdle();
```

### 事件

订阅事件以接收流式输出和生命周期通知。

```typescript
session.subscribe((event) => {
  switch (event.type) {
    // Streaming text from assistant
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      if (event.assistantMessageEvent.type === "thinking_delta") {
        // Thinking output (if thinking enabled)
      }
      break;
    
    // Tool execution
    case "tool_execution_start":
      console.log(`Tool: ${event.toolName}`);
      break;
    case "tool_execution_update":
      // Streaming tool output
      break;
    case "tool_execution_end":
      console.log(`Result: ${event.isError ? "error" : "success"}`);
      break;
    
    // Message lifecycle
    case "message_start":
      // New message starting
      break;
    case "message_end":
      // Message complete
      break;
    
    // Agent lifecycle
    case "agent_start":
      // Agent started processing prompt
      break;
    case "agent_end":
      // Agent finished (event.messages contains new messages)
      break;
    
    // Turn lifecycle (one LLM response + tool calls)
    case "turn_start":
      break;
    case "turn_end":
      // event.message: assistant response
      // event.toolResults: tool results from this turn
      break;
    
    // Session events (queue, compaction, retry)
    case "queue_update":
      console.log(event.steering, event.followUp);
      break;
    case "compaction_start":
    case "compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
    case "summarization_retry_scheduled":
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished":
      break;
  }
});
```

## 选项参考

### 目录

```typescript
const { session } = await createAgentSession({
  // Working directory for DefaultResourceLoader discovery
  cwd: process.cwd(), // default
  
  // Global config directory
  agentDir: "~/.pi/agent", // default (expands ~)
});
```

`DefaultResourceLoader` 会将 `cwd` 用于：
- 项目 extensions（`.pi/extensions/`）
- 项目 skills：
  - `.pi/skills/`
  - `cwd` 及各级祖先目录中的 `.agents/skills/`（向上直到 git 仓库根目录；若不在仓库中，则直到文件系统根目录）
- 项目 prompts（`.pi/prompts/`）
- Context files（从 cwd 向上遍历查找 `AGENTS.md`）
- session 目录命名

`DefaultResourceLoader` 会将 `agentDir` 用于：
- 全局 extensions（`extensions/`）
- 全局 skills：
  - `agentDir` 下的 `skills/`（例如 `~/.pi/agent/skills/`）
  - `~/.agents/skills/`
- 全局 prompts（`prompts/`）
- 全局 context 文件（`AGENTS.md`）
- 设置（`settings.json`）
- 自定义模型（`models.json`）
- 凭据（`auth.json`）
- Sessions（`sessions/`）

当你传入自定义的 `ResourceLoader` 时，`cwd` 和 `agentDir` 不再控制资源发现。它们仍然会影响 session 命名和 tool 路径解析。

### 模型

```typescript
import { getModel } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();

// create() restores cached catalogs but does not refresh them from pi.dev by default.
// Opt in to a create-time network refresh and bound how long it may take:
const refreshedRuntime = await ModelRuntime.create({
  allowModelNetwork: true,
  modelRefreshTimeoutMs: 15_000,
});

// Find specific built-in model (doesn't check if API key exists)
const opus = getModel("anthropic", "claude-opus-4-5");
if (!opus) throw new Error("Model not found");

// Find any model by provider/id, including custom models from models.json
// (doesn't check if API key exists)
const customModel = modelRuntime.getModel("my-provider", "my-model");

// Get only models that have valid authentication configured
const available = await modelRuntime.getAvailable();

const { session } = await createAgentSession({
  model: opus,
  thinkingLevel: "medium", // off, minimal, low, medium, high, xhigh, max
  
  // Models for cycling (Ctrl+P in interactive mode)
  scopedModels: [
    { model: opus, thinkingLevel: "high" },
    { model: haiku, thinkingLevel: "off" },
  ],
  
  modelRuntime,
});
```

如果未提供模型：
1. 尝试从 session 恢复（如果是继续会话）
2. 使用设置中的默认值
3. 回退到第一个可用模型

远程 catalog 会在本地持久化，以便后续的 runtime 无需网络请求即可恢复它们。默认文件为 `~/.pi/agent/models-store.json`；设置 `modelsStorePath` 可选择其他位置，或注入 `modelsStore` 来控制持久化。除非强制刷新，否则网络刷新会被限制为每个 provider 每四小时一次。要强制立即刷新，请调用 `await modelRuntime.refresh({ allowNetwork: true, force: true, signal })`。设置 `PI_OFFLINE` 会禁用模型网络访问。

要匹配 CLI 的模型解析行为，请使用导出的 resolver 辅助函数：

```typescript
import {
  resolveCliModel,
  resolveModelScopeWithDiagnostics,
} from "@earendil-works/pi-coding-agent";

const cliModel = resolveCliModel({
  cliModel: "anthropic/claude-opus-4-5:high",
  modelRuntime,
});
if (cliModel.error) throw new Error(cliModel.error);
if (cliModel.warning) console.warn(cliModel.warning);

const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(
  ["anthropic/*:high", "gpt-5"],
  modelRuntime,
);
for (const diagnostic of diagnostics) {
  console.warn(diagnostic.message);
}
```

`resolveCliModel()` 会使用所有已注册的模型，因此 `--api-key` 风格的首次设置可以在已存储的 auth 尚不存在时解析出模型。`resolveModelScopeWithDiagnostics()` 与 `--models` 和 `enabledModels` 的语义一致，但会返回警告而不是直接打印它们。

> 参见 [examples/sdk/02-custom-model.ts](../examples/sdk/02-custom-model.ts)

### API Keys 与 OAuth

身份验证解析优先级（由 `ModelRuntime` 处理）：
1. Runtime 覆盖（通过 `setRuntimeApiKey`，不会持久化）
2. `auth.json` 中存储的凭据（API keys 或 OAuth tokens）
3. 环境变量（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等）
4. 回退 resolver（用于来自 `models.json` 的自定义 provider keys）

```typescript
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";

// Default: uses ~/.pi/agent/auth.json and ~/.pi/agent/models.json
const modelRuntime = await ModelRuntime.create();

// Provider-owned auth methods and current status
for (const provider of modelRuntime.getProviders()) {
  const status = await modelRuntime.checkAuth(provider.id);
  console.log(provider.name, provider.auth, status);
}

// Runtime API key override (not persisted to disk)
await modelRuntime.setRuntimeApiKey("anthropic", "sk-my-temp-key");

// Custom credential and model locations
const customRuntime = await ModelRuntime.create({
  authPath: "/my/app/auth.json",
  modelsPath: "/my/app/models.json",
});

// Or inject any pi-ai CredentialStore
const credentials = new InMemoryCredentialStore();
const inMemoryRuntime = await ModelRuntime.create({ credentials });

const { session } = await createAgentSession({
  modelRuntime: customRuntime,
});
```

`login()`、`logout()`、`setRuntimeApiKey()` 和 `removeRuntimeApiKey()` 会在受影响的 provider 的缓存/内置 catalog、composition 与可用性快照在本地达到一致后 resolve。它们不会等待远程 catalog 的新鲜度。如果凭据已提交但本地同步失败，它们会以导出的 `CredentialSynchronizationError` reject；请检查其 `providerId`、`operation`、`credential` 和 `cause` 字段，而不是盲目重试凭据变更。

公开的模型/auth 操作以及 `ModelRuntime.create({ signal })` 都接受可选的 abort signals，省略时则不设上限。SDK 应用程序自行负责远程 catalog 新鲜度的超时策略：

```typescript
const signal = AbortSignal.timeout(15_000);
const result = await modelRuntime.refresh({
  providers: ["anthropic"],
  signal,
});
if (result.aborted) console.warn("Catalog refresh timed out; using cached models");
for (const [providerId, error] of result.errors) {
  console.warn(`Could not refresh ${providerId}:`, error);
}
```

失败或超时的网络刷新不会撤销已成功的凭据操作。`refresh()` 会启动新的 provider generation，因此它不会排在更早的停滞刷新之后等待，过期的 generation 也无法在之后发布结果。

> 参见 [examples/sdk/09-api-keys-and-oauth.ts](../examples/sdk/09-api-keys-and-oauth.ts)

### System Prompt

使用 `ResourceLoader` 覆盖 system prompt：

```typescript
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  systemPromptOverride: () => "You are a helpful assistant.",
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> 参见 [examples/sdk/03-custom-prompt.ts](../examples/sdk/03-custom-prompt.ts)

### Tools

指定要启用哪些内置 tools：

- 内置 tool 名称：`read`、`bash`、`powershell`、`edit`、`write`、`grep`、`find`、`ls`
- 默认内置项：`read`、`bash`、`edit`、`write`
- `noTools: "all"` 会禁用所有 tools
- `noTools: "builtin"` 会禁用默认内置 tools，同时保持 extension 与自定义 tools 启用
- 在应用任何 `tools` allowlist 之后，`excludeTools` 会禁用指定的内置、extension 或自定义 tool 名称

`edit` tool 会返回 `details.diff` 供 Pi 的 TUI 显示，并返回 `details.patch` 作为面向 SDK 使用者的标准 unified patch。

```typescript
import { createAgentSession } from "@earendil-works/pi-coding-agent";

// Read-only mode
const { session } = await createAgentSession({
  tools: ["read", "grep", "find", "ls"],
});

// Pick specific tools
const { session } = await createAgentSession({
  tools: ["read", "bash", "grep"],
});

// Use PowerShell instead of Bash on Windows
const { session } = await createAgentSession({
  tools: ["read", "powershell", "edit", "write"],
});

// Disable one tool while keeping the rest available
const { session } = await createAgentSession({
  excludeTools: ["ask_question"],
});
```

#### 使用自定义 cwd 的 Tools

当你传入自定义 `cwd` 时，`createAgentSession()` 会为该 cwd 构建所选的 built-in tools。

```typescript
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const cwd = "/path/to/project";

// Use default tools for custom cwd
const { session } = await createAgentSession({
  cwd,
  sessionManager: SessionManager.inMemory(cwd),
});

// Or pick specific tools for custom cwd
const { session } = await createAgentSession({
  cwd,
  tools: ["read", "bash", "grep"],
  sessionManager: SessionManager.inMemory(cwd),
});
```

> 参见 [examples/sdk/05-tools.ts](../examples/sdk/05-tools.ts)

### 自定义 Tools

```typescript
import { Type } from "typebox";
import { createAgentSession, defineTool } from "@earendil-works/pi-coding-agent";

// Inline custom tool
const myTool = defineTool({
  name: "my_tool",
  label: "My Tool",
  description: "Does something useful",
  parameters: Type.Object({
    input: Type.String({ description: "Input value" }),
  }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text", text: `Result: ${params.input}` }],
    details: {},
  }),
});

// Pass custom tools directly
const { session } = await createAgentSession({
  customTools: [myTool],
});
```

对于独立定义以及诸如 `customTools: [myTool]` 这样的数组，请使用 `defineTool()`。内联的 `pi.registerTool({ ... })` 已经能正确推断参数类型。

通过 `customTools` 传入的自定义 tools 会与 extension 注册的 tools 合并。由 ResourceLoader 加载的 extensions 也可以通过 `pi.registerTool()` 注册 tools。

如果你传入 `tools`，请把每个希望启用的自定义或 extension tool 名称都包含进去，例如 `tools: ["read", "bash", "my_tool"]`。

> 参见 [examples/sdk/05-tools.ts](../examples/sdk/05-tools.ts)

### Extensions

Extensions 由 `ResourceLoader` 加载。`DefaultResourceLoader` 会从 `~/.pi/agent/extensions/`、`.pi/extensions/` 以及 settings.json 的 extension 来源中发现 extensions。

```typescript
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  additionalExtensionPaths: ["/path/to/my-extension.ts"],
  extensionFactories: [
    (pi) => {
      pi.on("agent_start", () => {
        console.log("[Inline Extension] Agent starting");
      });
    },
  ],
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

Extensions 可以注册 tools、订阅事件、添加命令等等。完整 API 请参见 [extensions.md](extensions.md)。

**具名内联 extensions：** 默认情况下，内联工厂会在启动时的 Extensions 列表中显示为 `<inline:1>`、`<inline:2>` 等。要改为显示描述性名称，请包装该工厂：

```typescript
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const myProvider: InlineExtension = {
  name: "my-provider",
  factory: (pi) => {
    pi.on("agent_start", () => {
      console.log("[my-provider] Agent starting");
    });
  },
};

const loader = new DefaultResourceLoader({
  extensionFactories: [myProvider],
});
```

这样会显示为 `<inline:my-provider>`，而不是 `<inline:1>`。出于向后兼容，仍然接受裸的工厂函数。

**Event Bus：** Extensions 可以通过 `pi.events` 通信。如果你需要从外部 emit 或 listen，请向 `DefaultResourceLoader` 传入共享的 `eventBus`：

```typescript
import { createEventBus, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const eventBus = createEventBus();
const loader = new DefaultResourceLoader({
  eventBus,
});
await loader.reload();

eventBus.on("my-extension:status", (data) => console.log(data));
```

> 参见 [examples/sdk/06-extensions.ts](../examples/sdk/06-extensions.ts) 与 [docs/extensions.md](extensions.md)

### Skills

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  type Skill,
} from "@earendil-works/pi-coding-agent";

const customSkill: Skill = {
  name: "my-skill",
  description: "Custom instructions",
  filePath: "/path/to/SKILL.md",
  baseDir: "/path/to",
  source: "custom",
};

const loader = new DefaultResourceLoader({
  skillsOverride: (current) => ({
    skills: [...current.skills, customSkill],
    diagnostics: current.diagnostics,
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> 参见 [examples/sdk/04-skills.ts](../examples/sdk/04-skills.ts)

### Context Files

```typescript
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  agentsFilesOverride: (current) => ({
    agentsFiles: [
      ...current.agentsFiles,
      { path: "/virtual/AGENTS.md", content: "# Guidelines\n\n- Be concise" },
    ],
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> 参见 [examples/sdk/07-context-files.ts](../examples/sdk/07-context-files.ts)

### 斜杠命令

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  type PromptTemplate,
} from "@earendil-works/pi-coding-agent";

const customCommand: PromptTemplate = {
  name: "deploy",
  description: "Deploy the application",
  source: "(custom)",
  content: "# Deploy\n\n1. Build\n2. Test\n3. Deploy",
};

const loader = new DefaultResourceLoader({
  promptsOverride: (current) => ({
    prompts: [...current.prompts, customCommand],
    diagnostics: current.diagnostics,
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> 参见 [examples/sdk/08-prompt-templates.ts](../examples/sdk/08-prompt-templates.ts)

### Session 管理

Sessions 使用带 `id`/`parentId` 链接的树结构，从而支持就地 branching。

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

// In-memory (no persistence)
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

// New persistent session
const { session: persisted } = await createAgentSession({
  sessionManager: SessionManager.create(process.cwd()),
});

// Continue most recent
const { session: continued, modelFallbackMessage } = await createAgentSession({
  sessionManager: SessionManager.continueRecent(process.cwd()),
});
if (modelFallbackMessage) {
  console.log("Note:", modelFallbackMessage);
}

// Open specific file
const { session: opened } = await createAgentSession({
  sessionManager: SessionManager.open("/path/to/session.jsonl"),
});

// Resume a session kept outside the filesystem, e.g. in a database
const { session: restored } = await createAgentSession({
  sessionManager: SessionManager.inMemory(process.cwd(), { id: sessionId }, entries),
});

// List sessions
const currentProjectSessions = await SessionManager.list(process.cwd());
const allSessions = await SessionManager.listAll(process.cwd());

// Session replacement API for /new, /resume, /fork, /clone, and import flows.
const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

// Replace the active session with a fresh one
await runtime.newSession();

// Replace the active session with another saved session
await runtime.switchSession("/path/to/session.jsonl");

// Replace the active session with a fork from a specific user entry
await runtime.fork("entry-id");

// Clone the active path through a specific entry
await runtime.fork("entry-id", { position: "at" });
```

**SessionManager tree API：**

```typescript
const sm = SessionManager.open("/path/to/session.jsonl");

// Session listing
const currentProjectSessions = await SessionManager.list(process.cwd());
const allSessions = await SessionManager.listAll(process.cwd());

// Tree traversal
const entries = sm.getEntries();        // All entries (excludes header)
const tree = sm.getTree();              // Full tree structure
const path = sm.getPath();              // Path from root to current leaf
const leaf = sm.getLeafEntry();         // Current leaf entry
const entry = sm.getEntry(id);          // Get entry by ID
const children = sm.getChildren(id);    // Direct children of entry

// Labels
const label = sm.getLabel(id);          // Get label for entry
sm.appendLabelChange(id, "checkpoint"); // Set label

// Branching
sm.branch(entryId);                     // Move leaf to earlier entry
sm.branchWithSummary(id, "Summary...");  // Branch with context summary
sm.createBranchedSession(leafId);       // Extract path to new file
```

> 参见 [examples/sdk/11-sessions.ts](../examples/sdk/11-sessions.ts) 与 [Session Format](session-format.md)

### 设置管理

```typescript
import { createAgentSession, SettingsManager, SessionManager } from "@earendil-works/pi-coding-agent";

// Default: loads from files (global + project merged)
const { session } = await createAgentSession({
  settingsManager: SettingsManager.create(),
});

// With overrides
const settingsManager = SettingsManager.create();
settingsManager.applyOverrides({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 5 },
});
const { session } = await createAgentSession({ settingsManager });

// In-memory (no file I/O, for testing)
const { session } = await createAgentSession({
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  sessionManager: SessionManager.inMemory(),
});

// Custom directories
const { session } = await createAgentSession({
  settingsManager: SettingsManager.create("/custom/cwd", "/custom/agent"),
});
```

**静态工厂：**
- `SettingsManager.create(cwd?, agentDir?)` - 从文件加载
- `SettingsManager.inMemory(settings?)` - 无文件 I/O

**项目专属设置：**

设置从两个位置加载并合并：
1. 全局：`~/.pi/agent/settings.json`
2. 项目：`<cwd>/.pi/settings.json`

项目覆盖全局。嵌套对象按键合并。默认情况下，setter 会修改全局设置。

**持久化与错误处理语义：**

- 对于内存状态，Settings 的 getter/setter 是同步的。
- Setter 会以异步方式把持久化写入排入队列。
- 当你需要持久性边界时（例如进程退出前，或在测试中断言文件内容前），请调用 `await settingsManager.flush()`。
- `SettingsManager` 不会打印设置 I/O 错误。请使用 `settingsManager.drainErrors()` 并在你的应用层上报它们。

> 参见 [examples/sdk/10-settings.ts](../examples/sdk/10-settings.ts)

## ResourceLoader

使用 `DefaultResourceLoader` 发现 extensions、skills、prompts、themes 和 context files。

```typescript
import {
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
});
await loader.reload();

const extensions = loader.getExtensions();
const skills = loader.getSkills();
const prompts = loader.getPrompts();
const themes = loader.getThemes();
const contextFiles = loader.getAgentsFiles().agentsFiles;
```

## 返回值

`createAgentSession()` 返回：

```typescript
interface CreateAgentSessionResult {
  // The session
  session: AgentSession;
  
  // Extensions result (for runner setup)
  extensionsResult: LoadExtensionsResult;
  
  // Warning if session model couldn't be restored
  modelFallbackMessage?: string;
}

interface LoadExtensionsResult {
  extensions: Extension[];
  errors: Array<{ path: string; error: string }>;
  runtime: ExtensionRuntime;
}
```

## 完整示例

```typescript
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create({
  authPath: "/custom/agent/auth.json",
  modelsPath: "/custom/agent/models.json",
});
if (process.env.MY_KEY) {
  await modelRuntime.setRuntimeApiKey("anthropic", process.env.MY_KEY);
}

// Inline tool
const statusTool = defineTool({
  name: "status",
  label: "Status",
  description: "Get system status",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text", text: `Uptime: ${process.uptime()}s` }],
    details: {},
  }),
});

const model = getModel("anthropic", "claude-opus-4-5");
if (!model) throw new Error("Model not found");

// In-memory settings with overrides
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 2 },
});

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: "/custom/agent",
  settingsManager,
  systemPromptOverride: () => "You are a minimal assistant. Be concise.",
});
await loader.reload();

const { session } = await createAgentSession({
  cwd: process.cwd(),
  agentDir: "/custom/agent",

  model,
  thinkingLevel: "off",
  modelRuntime,

  tools: ["read", "bash", "status"],
  customTools: [statusTool],
  resourceLoader: loader,

  sessionManager: SessionManager.inMemory(),
  settingsManager,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Get status and list files.");
```

## 运行模式

SDK 导出运行模式工具，用于在 `createAgentSession()` 之上构建自定义界面：

### InteractiveMode

完整的 TUI 交互模式，包含编辑器、聊天历史和所有内置命令：

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

const mode = new InteractiveMode(runtime, {
  migratedProviders: [],
  modelFallbackMessage: undefined,
  initialMessage: "Hello",
  initialImages: [],
  initialMessages: [],
});

await mode.run();
```

### runPrintMode

单次执行模式：发送 prompts、输出结果、退出：

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  runPrintMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

await runPrintMode(runtime, {
  mode: "text",
  initialMessage: "Hello",
  initialImages: [],
  messages: ["Follow up"],
});
```

### runRpcMode

用于子进程集成的 JSON-RPC 模式：

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  runRpcMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

await runRpcMode(runtime);
```

JSON 协议请参见 [RPC documentation](rpc.md)。

## RPC 模式替代方案

如果要做基于子进程的集成而又不想用 SDK 构建，可以直接使用 CLI：

```bash
pi --mode rpc --no-session
```

JSON 协议请参见 [RPC documentation](rpc.md)。

以下情况优先使用 SDK：
- 你想要类型安全
- 你与它处于同一个 Node.js 进程
- 你需要直接访问 agent 状态
- 你想以编程方式自定义 tools/extensions

以下情况优先使用 RPC 模式：
- 你从其他语言进行集成
- 你想要进程隔离
- 你在构建与语言无关的客户端

## 导出

主入口点导出：

```typescript
// Factory
createAgentSession
createAgentSessionRuntime
AgentSessionRuntime

// Auth and Models
ModelRuntime // implements pi-ai Models and owns credential storage
ModelRegistry // synchronous extension compatibility facade
CredentialSynchronizationError
resolveCliModel
resolveModelScopeWithDiagnostics

// Resource loading
DefaultResourceLoader
type ResourceLoader
createEventBus

// Constants and helpers
CONFIG_DIR_NAME
defineTool
getAgentDir
getPackageDir
getReadmePath
getDocsPath
getExamplesPath

// Session management
SessionManager
SettingsManager

// Tool factories
createCodingTools
createReadOnlyTools
createReadTool, createBashTool, createPowerShellTool, createEditTool, createWriteTool
createGrepTool, createFindTool, createLsTool

// Types
type CreateAgentSessionOptions
type CreateAgentSessionResult
type ExtensionFactory
type InlineExtension
type ExtensionAPI
type ToolDefinition
type Skill
type PromptTemplate
type Tool
```

关于 extension 类型，完整 API 请参见 [extensions.md](extensions.md)。
