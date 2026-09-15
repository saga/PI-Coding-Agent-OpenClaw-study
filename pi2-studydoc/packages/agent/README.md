# @earendil-works/pi-agent-core

带 tool 执行和 event streaming 的有状态 agent。构建于 `@earendil-works/pi-ai` 之上。

## 安装

```bash
npm install @earendil-works/pi-agent-core
```

### SQLite session 后端

SQLite session 后端和 `node:sqlite` adapter 位于单独的包 `@earendil-works/pi-session-backend-sqlite-node` 中，因此核心包默认不会引入 runtime builtin 或原生 SQLite 依赖。该后端接受一个 runtime 特定的 SQLite factory，从而允许其他 session 后端将来作为自己的包发布。

## 快速开始

```typescript
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-6");
if (!model) throw new Error("Model not found");

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model,
  },
  streamFn: models.streamSimple.bind(models),
});

agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    // Stream just the new text chunk
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt("Hello!");
```

## 实验性 facet service

Transport 中立的 facet-service 原语位于 `@earendil-works/chord` 中。agent core 不导出 service runtime。

## 核心概念

### AgentMessage 与 LLM Message

agent 使用 `AgentMessage` 工作，这是一种灵活的类型，可以包含：
- 标准 LLM message（`user`、`assistant`、`toolResult`）
- 通过 declaration merging 定义的应用特定自定义 message 类型

LLM 只理解 `user`、`assistant` 和 `toolResult`。`convertToLlm` 函数通过在每次 LLM 调用之前过滤和转换 message 来弥合这一差距。

### Message 流转

```
AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[] → LLM
                    (optional)                           (required)
```

1. **transformContext**：修剪旧 message，注入外部 context
2. **convertToLlm**：过滤掉仅用于 UI 的 message，将自定义类型转换为 LLM 格式

## Event 流转

agent 会为 UI 更新发出 event。理解 event 序列有助于构建响应式界面。

### prompt() event 序列

当你调用 `prompt("Hello")` 时：

```
prompt("Hello")
├─ agent_start
├─ turn_start
├─ message_start   { message: userMessage }      // Your prompt
├─ message_end     { message: userMessage }
├─ message_start   { message: assistantMessage } // LLM starts responding
├─ message_update  { message: partial... }       // Streaming chunks
├─ message_update  { message: partial... }
├─ message_end     { message: assistantMessage } // Complete response
├─ turn_end        { message, toolResults: [] }
└─ agent_end       { messages: [...] }
```

### 带 tool 调用时

如果 assistant 调用 tool，循环会继续：

```
prompt("Read config.json")
├─ agent_start
├─ turn_start
├─ message_start/end  { userMessage }
├─ message_start      { assistantMessage with toolCall }
├─ message_update...
├─ message_end        { assistantMessage }
├─ tool_execution_start  { toolCallId, toolName, args }
├─ tool_execution_update { partialResult }           // If tool streams
├─ tool_execution_end    { toolCallId, result }
├─ message_start/end  { toolResultMessage }
├─ turn_end           { message, toolResults: [toolResult] }
│
├─ turn_start                                        // Next turn
├─ message_start      { assistantMessage }           // LLM responds to tool result
├─ message_update...
├─ message_end
├─ turn_end
└─ agent_end
```

Tool 执行 mode 是可配置的：

- `parallel`（默认）：顺序 preflight tool 调用，并发执行被允许的 tool，在每个 tool 定稿后立即发出 `tool_execution_end`，然后按 assistant 源顺序发出 toolResult message 和 `turn_end.toolResults`
- `sequential`：逐个执行 tool 调用，与历史行为一致

在 parallel mode 下，tool 完成 event 遵循 tool 完成顺序，但持久化的 toolResult message 仍然遵循 assistant 源顺序。

该 mode 可以通过 agent config 中的 `toolExecution` 全局设置，也可以通过 `AgentTool` 上的 `executionMode` 按 tool 设置。如果一个批次中的任何 tool 调用指向带有 `executionMode: "sequential"` 的 tool，则整个批次都会顺序执行，无论全局设置如何。

`beforeToolCall` hook 在 `tool_execution_start` 和参数解析校验之后运行。它可以阻止执行，并将 `terminate: true` 附加到被阻止的结果上。`afterToolCall` hook 在 tool 执行完成之后、`tool_execution_end` 和最终 tool result message event 发出之前运行。

Tool、被阻止的 `beforeToolCall` 结果以及 `afterToolCall` 覆盖都可以返回 `terminate: true`，以提示应跳过自动的后续 LLM 调用。只有当该批次中每个定稿的 tool result 都设置 `terminate: true` 时，循环才会提前停止。混合批次会正常继续。

`Agent` class 在 `AgentOptions` 中接受 `shouldStopAfterTurn`。低层循环调用方可以在 `AgentLoopConfig` 中设置同一个 hook：

```typescript
const stream = agentLoop(
  prompts,
  context,
  {
    model,
    convertToLlm,
    shouldStopAfterTurn: async ({ message, toolResults, context, newMessages }) => {
      return shouldCompactBeforeNextTurn(context.messages);
    },
  },
  undefined,
  models.streamSimple.bind(models),
);
```

`shouldStopAfterTurn` 在 `turn_end` 发出之后、assistant 响应和任何 tool 执行正常完成之后运行。如果它返回 `true`，循环会发出 `agent_end` 并退出，此时不会轮询 steering 或 follow-up 队列，也不会开始另一次 LLM 调用。它不会中止 provider stream，不会取消正在运行的 tool，也不会改变 assistant message 的 stop reason。`AgentOptions` callback 还会将活动 run 的 `AbortSignal` 作为其第二个参数接收。

当你使用 `Agent` class 时，assistant `message_end` 处理在 tool preflight 开始之前被视为一个 barrier。这意味着 `beforeToolCall` 看到的 agent state 已经包含了请求该 tool 调用的 assistant message。

### continue() event 序列

`continue()` 从既有 context 继续，不添加新的 message。可用于错误后的重试。

```typescript
// After an error, retry from current state
await agent.continue();
```

context 中的最后一条 message 必须是 `user` 或 `toolResult`（不能是 `assistant`）。

### Event 类型

| Event | 描述 |
|-------|-------------|
| `agent_start` | Agent 开始处理 |
| `agent_end` | 该 run 的最终 event。针对此 event 的已 await subscriber 仍计入 settlement |
| `turn_start` | 新的 turn 开始（一次 LLM 调用 + tool 执行） |
| `turn_end` | turn 以 assistant message 和 tool result 完成 |
| `message_start` | 任何 message 开始（user、assistant、toolResult） |
| `message_update` | **仅 assistant。** 包含带 delta 的 `assistantMessageEvent` |
| `message_end` | Message 完成 |
| `tool_execution_start` | Tool 开始 |
| `tool_execution_update` | Tool 流式输出进度 |
| `tool_execution_end` | Tool 完成 |

`Agent.subscribe()` listener 按注册顺序被 await。`agent_end` 意味着不会再发出循环 event，但 `await agent.waitForIdle()` 和 `await agent.prompt(...)` 只有在已 await 的 `agent_end` listener 完成后才会 settle。

## Agent 选项

```typescript
const agent = new Agent({
  // Initial state
  initialState: {
    systemPrompt: string,
    model: Model<any>,
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    tools: AgentTool<any>[],
    messages: AgentMessage[],
  },

  // Convert AgentMessage[] to LLM Message[] (required for custom message types)
  convertToLlm: (messages) => messages.filter(...),

  // Transform context before convertToLlm (for pruning, compaction)
  transformContext: async (messages, signal) => pruneOldMessages(messages),

  // Steering mode: "one-at-a-time" (default) or "all"
  steeringMode: "one-at-a-time",

  // Follow-up mode: "one-at-a-time" (default) or "all"
  followUpMode: "one-at-a-time",

  // Required stream function
  streamFn: models.streamSimple.bind(models),

  // Session ID for provider caching
  sessionId: "session-123",

  // Dynamic API key resolution (for expiring OAuth tokens)
  getApiKey: async (provider) => refreshToken(),

  // Tool execution mode: "parallel" (default) or "sequential"
  toolExecution: "parallel",

  // Preflight each tool call after args are validated. Can block execution.
  beforeToolCall: async ({ toolCall, args, context }) => {
    if (toolCall.name === "bash") {
      return { block: true, reason: "bash is disabled", terminate: true };
    }
  },

  // Postprocess each tool result before final tool events are emitted.
  afterToolCall: async ({ toolCall, result, isError, context }) => {
    if (toolCall.name === "notify_done" && !isError) {
      return { terminate: true };
    }
    if (!isError) {
      return { details: { ...result.details, audited: true } };
    }
  },

  // Stop gracefully after a completed turn, before queued messages are polled.
  shouldStopAfterTurn: async ({ context }, signal) => {
    return shouldCompactBeforeNextTurn(context.messages, signal);
  },

  // Custom thinking budgets for token-based providers
  thinkingBudgets: {
    minimal: 128,
    low: 512,
    medium: 1024,
    high: 2048,
  },
});
```

## Agent State

```typescript
interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}
```

通过 `agent.state` 访问 state。

对 `agent.state.tools = [...]` 或 `agent.state.messages = [...]` 赋值会在存储之前复制顶层数组。修改返回的数组会修改当前 agent state。

在 streaming 期间，`agent.state.streamingMessage` 包含当前部分的 assistant message。

`agent.state.isStreaming` 保持为 `true`，直到 run 完全 settle，包括已 await 的 `agent_end` subscriber。

## 方法

### 发起 prompt

```typescript
// Text prompt
await agent.prompt("Hello");

// With images
await agent.prompt("What's in this image?", [
  { type: "image", data: base64Data, mimeType: "image/jpeg" }
]);

// AgentMessage directly
await agent.prompt({ role: "user", content: "Hello", timestamp: Date.now() });

// Continue from current context (last message must be user or toolResult)
await agent.continue();
```

### State 管理

```typescript
agent.state.systemPrompt = "New prompt";
agent.state.model = getModel("openai", "gpt-4o");
agent.state.thinkingLevel = "medium";
agent.state.tools = [myTool];
agent.toolExecution = "sequential";
agent.beforeToolCall = async ({ toolCall }) => undefined;
agent.afterToolCall = async ({ toolCall, result }) => undefined;
agent.shouldStopAfterTurn = async ({ context }) => shouldCompactBeforeNextTurn(context.messages);
agent.state.messages = newMessages; // top-level array is copied
agent.state.messages.push(message);
agent.reset();
```

### Session 与 Thinking Budget

```typescript
agent.sessionId = "session-123";

agent.thinkingBudgets = {
  minimal: 128,
  low: 512,
  medium: 1024,
  high: 2048,
};
```

### 控制

```typescript
agent.abort();           // Cancel current operation
await agent.waitForIdle(); // Wait for completion
```

### Event

```typescript
const unsubscribe = agent.subscribe(async (event, signal) => {
  if (event.type === "agent_end") {
    // Final barrier work for the run
    await flushSessionState(signal);
  }
});
unsubscribe();
```

## Steering 与 Follow-up

Steering message 让你可以在 tool 运行时打断 agent。Follow-up message 让你可以在 agent 原本会停止之后排队工作。

```typescript
agent.steeringMode = "one-at-a-time";
agent.followUpMode = "one-at-a-time";

// While agent is running tools
agent.steer({
  role: "user",
  content: "Stop! Do this instead.",
  timestamp: Date.now(),
});

// After the agent finishes its current work
agent.followUp({
  role: "user",
  content: "Also summarize the result.",
  timestamp: Date.now(),
});

const steeringMode = agent.steeringMode;
const followUpMode = agent.followUpMode;

agent.clearSteeringQueue();
agent.clearFollowUpQueue();
agent.clearAllQueues();
```

使用 clearSteeringQueue、clearFollowUpQueue 或 clearAllQueues 来丢弃已排队的 message。

当在一个 turn 完成之后检测到 steering message 时：
1. 当前 assistant message 的所有 tool 调用都已经完成
2. 注入 steering message
3. LLM 在下一个 turn 作出响应

只有在没有更多 tool 调用且没有 steering message 时，才会检查 follow-up message。如果有任何已排队的 follow-up message，它们会被注入，并运行另一个 turn。

## 自定义 Message 类型

通过 declaration merging 扩展 `AgentMessage`：

```typescript
declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    notification: { role: "notification"; text: string; timestamp: number };
  }
}

// Now valid
const msg: AgentMessage = { role: "notification", text: "Info", timestamp: Date.now() };
```

在 `convertToLlm` 中处理自定义类型：

```typescript
const agent = new Agent({
  streamFn: models.streamSimple.bind(models),
  convertToLlm: (messages) => messages.flatMap(m => {
    if (m.role === "notification") return []; // Filter out
    return [m];
  }),
});
```

## Tool

使用 `AgentTool` 定义 tool：

```typescript
import { Type } from "typebox";

const readFileTool: AgentTool = {
  name: "read_file",
  label: "Read File",  // For UI display
  description: "Read a file's contents",
  parameters: Type.Object({
    path: Type.String({ description: "File path" }),
  }),
  // Override execution mode for this tool (optional).
  // "sequential" forces the entire batch to run one at a time.
  // "parallel" allows concurrent execution with other tool calls.
  // If omitted, the global toolExecution config applies.
  executionMode: "sequential",
  execute: async (toolCallId, params, signal, onUpdate) => {
    const content = await fs.readFile(params.path, "utf-8");

    // Optional: stream progress
    onUpdate?.({ content: [{ type: "text", text: "Reading..." }], details: {} });

    // Optional: add `terminate: true` here to skip the automatic follow-up LLM call
    // when every finalized tool result in the batch does the same.
    return {
      content: [{ type: "text", text: content }],
      details: { path: params.path, size: content.length },
    };
  },
};

agent.state.tools = [readFileTool];
```

### 错误处理

当 tool 失败时**抛出错误**。不要把错误消息作为 content 返回。

```typescript
execute: async (toolCallId, params, signal, onUpdate) => {
  if (!fs.existsSync(params.path)) {
    throw new Error(`File not found: ${params.path}`);
  }
  // Return content only on success
  return { content: [{ type: "text", text: "..." }] };
}
```

抛出的错误会被 agent 捕获，并作为带有 `isError: true` 的 tool error 报告给 LLM。

从 `execute()`、被阻止的 `beforeToolCall` 或 `afterToolCall` 返回 `terminate: true`，以提示 agent 应在当前 tool 批次之后停止。只有当该批次中每个定稿的 tool result 都是终止性的时，这才会生效。该提示仅在 runtime 中有效；发出的 `toolResult` transcript message 仍然是标准的 LLM tool result。

## Proxy 用法

对于通过后端进行 proxy 的 browser 应用：

```typescript
import { Agent, streamProxy } from "@earendil-works/pi-agent-core";

const agent = new Agent({
  streamFn: (model, context, options) =>
    streamProxy(model, context, {
      ...options,
      authToken: "...",
      proxyUrl: "https://your-server.com",
    }),
});
```

## 低层 API

用于在不使用 Agent class 的情况下直接控制：

```typescript
import { agentLoop, agentLoopContinue } from "@earendil-works/pi-agent-core";

const context: AgentContext = {
  systemPrompt: "You are helpful.",
  messages: [],
  tools: [],
};

const config: AgentLoopConfig = {
  model: getModel("openai", "gpt-4o"),
  convertToLlm: (msgs) => msgs.filter(m => ["user", "assistant", "toolResult"].includes(m.role)),
  toolExecution: "parallel",  // overridden by per-tool executionMode if set
  beforeToolCall: async ({ toolCall, args, context }) => undefined,
  afterToolCall: async ({ toolCall, result, isError, context }) => undefined,
};

const userMessage = { role: "user", content: "Hello", timestamp: Date.now() };

const streamFn = models.streamSimple.bind(models);
for await (const event of agentLoop([userMessage], context, config, undefined, streamFn)) {
  console.log(event.type);
}

// Continue from existing context
for await (const event of agentLoopContinue(context, config, undefined, streamFn)) {
  console.log(event.type);
}
```

这些低层 stream 是观察性的。它们保留 event 顺序，但不会等待你的异步 event 处理 settle 之后才继续后续 producer 阶段。如果你需要 message 处理在 tool preflight 之前充当 barrier，请使用 `Agent` class，而不是原始的 `agentLoop()` 或 `agentLoopContinue()`。

## 许可证

MIT
