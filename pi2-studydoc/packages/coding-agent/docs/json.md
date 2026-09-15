# JSON 事件流模式

```bash
pi --mode json "Your prompt"
```

将所有 session 事件以 JSON lines 形式输出到 stdout。适用于将 pi 集成到其他工具或自定义 UI 中。

## 事件类型

Wire 事件使用 `JsonAgentSessionEvent`。它匹配
[`AgentSessionEvent`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts)，
区别在于流式消息更新省略了累积快照：

```typescript
type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

type JsonAssistantMessageEvent<T> = T extends { type: "toolcall_start"; partial: unknown }
  ? WithoutPartial<T> & { id: string; toolName: string }
  : WithoutPartial<T>;

type JsonAgentSessionEvent =
  | Exclude<AgentSessionEvent, { type: "message_update" }>
  | {
      type: "message_update";
      usage: Usage;
      assistantMessageEvent: JsonAssistantMessageEvent<AssistantMessageEvent>;
    };
```

`queue_update` 会在待处理的 steering 和 follow-up 队列发生变化时发出完整的队列。`compaction_start` 和 `compaction_end` 同时覆盖手动和自动 compaction。

其他基础事件来自
[`AgentEvent`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts)：

```typescript
type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn lifecycle
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

## 消息类型

来自 [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts#L134) 的基础消息：
- `UserMessage`（第 134 行）
- `AssistantMessage`（第 140 行）
- `ToolResultMessage`（第 152 行）

来自 [`packages/coding-agent/src/core/messages.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/messages.ts#L29) 的扩展消息：
- `BashExecutionMessage`（第 29 行）
- `CustomMessage`（第 46 行）
- `BranchSummaryMessage`（第 55 行）
- `CompactionSummaryMessage`（第 62 行）

## 输出格式

每一行都是一个 JSON 对象。第一行是 session header：

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
```

其后是事件发生时的记录：

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...]}
```

`message_update` 记录仅包含 delta。它们同时省略了累积的 `message` 字段和
`assistantMessageEvent.partial`，以使流式传输的大小保持线性增长。顶层 `usage` 字段包含
provider 报告的最新累积 usage，当 provider 仅在完成时报告 usage 时，该字段可能保持为零。
如有需要，可使用 `contentIndex` 和 `delta` 来组装实时文本、thinking 或 tool-call
参数。`toolcall_start` 事件还包含大小恒定的 `id` 和 `toolName`
字段。`message_end` 包含最终的权威消息。

## 示例

```bash
pi --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```
