# RPC 模式

RPC 模式通过 stdin/stdout 上的 JSON 协议实现 coding agent 的无头（headless）运行。这适用于将 agent 嵌入到其他应用程序、IDE 或自定义 UI 中。

**Node.js/TypeScript 用户须知**：如果你正在构建 Node.js 应用程序，请考虑直接使用 `@earendil-works/pi-coding-agent` 中的 `AgentSession`，而不是启动子进程。API 参见 [`src/core/agent-session.ts`](../src/core/agent-session.ts)。基于子进程的 TypeScript 客户端参见 [`src/modes/rpc/rpc-client.ts`](../src/modes/rpc/rpc-client.ts)。

## 启动 RPC 模式

```bash
pi --mode rpc [options]
```

常用选项：
- `--provider <name>`：设置 LLM provider（anthropic、openai、google 等）
- `--model <pattern>`：模型 pattern 或 ID（支持 `provider/id` 以及可选的 `:<thinking>`）
- `--name <name>` / `-n <name>`：在启动时设置 session 显示名称
- `--no-session`：禁用 session 持久化
- `--session-dir <path>`：自定义 session 存储目录

## 协议概览

- **Commands**：发送到 stdin 的 JSON 对象，每行一个
- **Responses**：带有 `type: "response"` 的 JSON 对象，表示命令成功/失败
- **Events**：以 JSON lines 形式流式传输到 stdout 的 agent 事件

所有命令都支持可选的 `id` 字段用于请求/响应关联。如果提供，相应的响应将包含相同的 `id`。`bash_execution_update` 事件也包含其来源 `bash` 命令的 `id`。

### 分帧

RPC 模式使用严格的 JSONL 语义，仅以 LF（`\n`）作为记录分隔符。

这对客户端很重要：
- 仅按 `\n` 切分记录
- 通过剥离末尾的 `\r` 来接受可选的 `\r\n` 输入
- 不要使用将 Unicode 分隔符视为换行的通用行读取器

特别地，Node 的 `readline` 不符合 RPC 模式的协议要求，因为它还会按 `U+2028` 和 `U+2029` 切分，而这些字符在 JSON 字符串内部是合法的。

## Commands

### Prompting

#### prompt

向 agent 发送用户 prompt。命令响应在 prompt 被接受、排队或处理后发出。事件在接受后继续异步流式传输。

```json
{"id": "req-1", "type": "prompt", "message": "Hello, world!"}
```

带图片：
```json
{"type": "prompt", "message": "What's in this image?", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

**流式传输期间**：如果 agent 已在流式传输，你必须指定 `streamingBehavior` 来将该消息排队：

```json
{"type": "prompt", "message": "New instruction", "streamingBehavior": "steer"}
```

- `"steer"`：在 agent 运行期间将该消息排队。它会在当前 assistant turn 执行完其 tool calls 之后、下一次 LLM 调用之前被投递。
- `"followUp"`：等待 agent 结束。仅当 agent 停止时才投递消息。

如果 agent 正在流式传输且未指定 `streamingBehavior`，该命令会返回错误。

**Extension commands**：如果消息是一个 extension command（例如 `/mycommand`），即使在流式传输期间它也会立即执行。Extension commands 通过 `pi.sendMessage()` 管理自己的 LLM 交互。

**Input expansion**：Skill commands（`/skill:name`）和 prompt templates（`/template`）在发送/排队之前会被展开。

Response：
```json
{"id": "req-1", "type": "response", "command": "prompt", "success": true}
```

`success: true` 表示 prompt 被接受、排队或立即处理。`success: false` 表示 prompt 在接受之前被拒绝。接受之后的失败通过正常的事件和消息流报告，而不会针对同一请求 id 发送第二个 `response`。

`images` 字段是可选的。每张图片使用 `ImageContent` 格式：`{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}`。

#### steer

在 agent 运行期间将一条 steering 消息排队。它会在当前 assistant turn 执行完其 tool calls 之后、下一次 LLM 调用之前被投递。Skill commands 和 prompt templates 会被展开。不允许 extension commands（请改用 `prompt`）。

```json
{"type": "steer", "message": "Stop and do this instead"}
```

带图片：
```json
{"type": "steer", "message": "Look at this instead", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

`images` 字段是可选的。每张图片使用 `ImageContent` 格式（与 `prompt` 相同）。

Response：
```json
{"type": "response", "command": "steer", "success": true}
```

关于如何控制 steering 消息的处理方式，参见 [set_steering_mode](#set_steering_mode)。

#### follow_up

将一条 follow-up 消息排队，以便在 agent 结束后处理。仅当 agent 没有更多 tool calls 或 steering 消息时才投递。Skill commands 和 prompt templates 会被展开。不允许 extension commands（请改用 `prompt`）。

```json
{"type": "follow_up", "message": "After you're done, also do this"}
```

带图片：
```json
{"type": "follow_up", "message": "Also check this image", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

`images` 字段是可选的。每张图片使用 `ImageContent` 格式（与 `prompt` 相同）。

Response：
```json
{"type": "response", "command": "follow_up", "success": true}
```

关于如何控制 follow-up 消息的处理方式，参见 [set_follow_up_mode](#set_follow_up_mode)。

#### abort

中止当前 operation，并等待 session 变为空闲后再响应。

```json
{"type": "abort"}
```

Response：
```json
{"type": "response", "command": "abort", "success": true}
```

#### clear_queue

移除已排队的 steering 和 follow-up 消息，并返回其文本。

```json
{"type": "clear_queue"}
```

Response：
```json
{
  "type": "response",
  "command": "clear_queue",
  "success": true,
  "data": {
    "steering": ["Change direction"],
    "followUp": ["Summarize when finished"]
  }
}
```

要实现交互式 Esc 行为，请在 `abort` 之前发送 `clear_queue`，然后在客户端编辑器中恢复返回的文本。当排队的消息仍保留在 session 中时，`abort` 会继续处理它们。

#### new_session

启动一个新的 session。可由 `session_before_switch` extension 事件处理器取消。

```json
{"type": "new_session"}
```

带可选的父 session 跟踪：
```json
{"type": "new_session", "parentSession": "/path/to/parent-session.jsonl"}
```

Response：
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": false}}
```

如果被 extension 取消：
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": true}}
```

### State

#### get_state

获取当前 session 状态。

```json
{"type": "get_state"}
```

Response：
```json
{
  "type": "response",
  "command": "get_state",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "isStreaming": false,
    "isCompacting": false,
    "steeringMode": "all",
    "followUpMode": "one-at-a-time",
    "sessionFile": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "sessionName": "my-feature-work",
    "autoCompactionEnabled": true,
    "messageCount": 5,
    "pendingMessageCount": 0
  }
}
```

`model` 字段是一个完整的 [Model](#model) 对象或 `null`。`sessionName` 字段是通过 `set_session_name` 设置的显示名称，如果未设置则省略。

#### get_messages

获取对话中的所有消息。

```json
{"type": "get_messages"}
```

Response：
```json
{
  "type": "response",
  "command": "get_messages",
  "success": true,
  "data": {"messages": [...]}
}
```

消息是 `AgentMessage` 对象（参见 [Message Types](#message-types)）。

### Model

#### set_model

切换到特定模型。

```json
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}
```

Response 包含完整的 [Model](#model) 对象：
```json
{
  "type": "response",
  "command": "set_model",
  "success": true,
  "data": {...}
}
```

#### cycle_model

循环切换到下一个可用模型。如果只有一个可用模型，则返回 `null` data。

```json
{"type": "cycle_model"}
```

Response：
```json
{
  "type": "response",
  "command": "cycle_model",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "isScoped": false
  }
}
```

`model` 字段是一个完整的 [Model](#model) 对象。

#### get_available_models

列出所有已配置的模型。

```json
{"type": "get_available_models"}
```

Response 包含一个由完整 [Model](#model) 对象组成的数组：
```json
{
  "type": "response",
  "command": "get_available_models",
  "success": true,
  "data": {
    "models": [...]
  }
}
```

### Thinking

#### set_thinking_level

为支持该功能的模型设置推理/思考级别。

```json
{"type": "set_thinking_level", "level": "high"}
```

级别：`"off"`、`"minimal"`、`"low"`、`"medium"`、`"high"`、`"xhigh"`、`"max"`

`"xhigh"` 和 `"max"` 仅在所选模型支持时才暴露。某些模型（包括 GPT-5.6）会同时暴露两者。

Response：
```json
{"type": "response", "command": "set_thinking_level", "success": true}
```

#### cycle_thinking_level

循环切换可用的思考级别。如果模型不支持思考，则返回 `null` data。

```json
{"type": "cycle_thinking_level"}
```

Response：
```json
{
  "type": "response",
  "command": "cycle_thinking_level",
  "success": true,
  "data": {"level": "high"}
}
```

#### get_available_thinking_levels

列出当前模型支持的思考级别。对于不支持推理的模型，返回 `["off"]`。

```json
{"type": "get_available_thinking_levels"}
```

Response：
```json
{
  "type": "response",
  "command": "get_available_thinking_levels",
  "success": true,
  "data": {
    "levels": ["off", "minimal", "low", "medium", "high"]
  }
}
```

### Queue Modes

#### set_steering_mode

控制 steering 消息（来自 `steer`）的投递方式。

```json
{"type": "set_steering_mode", "mode": "one-at-a-time"}
```

模式：
- `"all"`：在当前 assistant turn 执行完其 tool calls 之后投递所有 steering 消息
- `"one-at-a-time"`：每完成一个 assistant turn 投递一条 steering 消息（默认）

Response：
```json
{"type": "response", "command": "set_steering_mode", "success": true}
```

#### set_follow_up_mode

控制 follow-up 消息（来自 `follow_up`）的投递方式。

```json
{"type": "set_follow_up_mode", "mode": "one-at-a-time"}
```

模式：
- `"all"`：当 agent 结束时投递所有 follow-up 消息
- `"one-at-a-time"`：每次 agent 完成时投递一条 follow-up 消息（默认）

Response：
```json
{"type": "response", "command": "set_follow_up_mode", "success": true}
```

### Compaction

#### compact

手动压缩对话 Context 以减少 token 用量。

```json
{"type": "compact"}
```

带自定义指令：
```json
{"type": "compact", "customInstructions": "Focus on code changes"}
```

Response：
```json
{
  "type": "response",
  "command": "compact",
  "success": true,
  "data": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {
      "input": 32000,
      "output": 1200,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 33200,
      "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03}
    },
    "details": {}
  }
}
```

`estimatedTokensAfter` 是对紧接 compaction 之后重建的消息 Context 的启发式估算，并非 provider 精确的 token 计数。`usage` 报告生成摘要的那次或那些 LLM 调用，自定义 compaction 处理器可能会省略它。

#### set_auto_compaction

在 Context 接近占满时启用或禁用自动 compaction。

```json
{"type": "set_auto_compaction", "enabled": true}
```

Response：
```json
{"type": "response", "command": "set_auto_compaction", "success": true}
```

### Retry

#### set_auto_retry

在瞬时错误（过载、速率限制、5xx）时启用或禁用自动重试。

```json
{"type": "set_auto_retry", "enabled": true}
```

Response：
```json
{"type": "response", "command": "set_auto_retry", "success": true}
```

#### abort_retry

中止进行中的重试（取消延迟并停止重试）。

```json
{"type": "abort_retry"}
```

Response：
```json
{"type": "response", "command": "abort_retry", "success": true}
```

### Bash

#### bash

执行一条 shell 命令并将输出添加到对话 Context 中。命令运行期间，输出以 `bash_execution_update` 事件流式传输；响应包含最终结果。

```json
{"id": "req-1", "type": "bash", "command": "ls -la"}
```

包含 `id` 可将流式传输的 `bash_execution_update` 事件与该命令关联起来。

Response：
```json
{
  "id": "req-1",
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "total 48\ndrwxr-xr-x ...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": false
  }
}
```

如果输出被截断，则包含 `fullOutputPath`：
```json
{
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "truncated output...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": true,
    "fullOutputPath": "/tmp/pi-bash-abc123.log"
  }
}
```

**bash 结果如何到达 LLM：**

`bash` 命令会立即执行并返回一个 `BashResult`。在内部，会创建一个 `BashExecutionMessage` 并存储在 agent 的消息状态中。

当发送下一条 `prompt` 命令时，所有消息（包括 `BashExecutionMessage`）都会在发送给 LLM 之前被转换。`BashExecutionMessage` 会被转换为具有以下格式的 `UserMessage`：

````
Ran `ls -la`
```
total 48
drwxr-xr-x ...
```
````

这意味着：
1. Bash 输出在**下一次 prompt** 时被包含进 LLM Context，而不是立即包含
2. 在一次 prompt 之前可以执行多条 bash 命令；所有输出都会被包含

#### abort_bash

中止正在运行的 bash 命令。

```json
{"type": "abort_bash"}
```

Response：
```json
{"type": "response", "command": "abort_bash", "success": true}
```

### Session

#### get_session_stats

获取 token 用量、成本统计以及当前 Context window 使用情况。

```json
{"type": "get_session_stats"}
```

Response：
```json
{
  "type": "response",
  "command": "get_session_stats",
  "success": true,
  "data": {
    "sessionFile": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "userMessages": 5,
    "assistantMessages": 5,
    "toolCalls": 12,
    "toolResults": 12,
    "totalMessages": 22,
    "tokens": {
      "input": 50000,
      "output": 10000,
      "cacheRead": 40000,
      "cacheWrite": 5000,
      "total": 105000
    },
    "cost": 0.45,
    "contextUsage": {
      "tokens": 60000,
      "contextWindow": 200000,
      "percent": 30
    }
  }
}
```

`tokens` 和 `cost` 包括 assistant 消息、tool 报告的 usage，以及整个 session 中的 compaction/branch-summary 生成。`contextUsage` 包含用于 compaction 和 footer 显示的实际当前 Context window 估算值。

当没有可用的模型或 Context window 时，会省略 `contextUsage`。紧接 compaction 之后，`contextUsage.tokens` 和 `contextUsage.percent` 为 `null`，直到一次新的 compaction 后 assistant 响应提供有效的 usage 数据。

#### export_html

将 session 导出为 HTML 文件。

```json
{"type": "export_html"}
```

带自定义路径：
```json
{"type": "export_html", "outputPath": "/tmp/session.html"}
```

Response：
```json
{
  "type": "response",
  "command": "export_html",
  "success": true,
  "data": {"path": "/tmp/session.html"}
}
```

#### switch_session

加载另一个 session 文件。可由 `session_before_switch` extension 事件处理器取消。

```json
{"type": "switch_session", "sessionPath": "/path/to/session.jsonl"}
```

Response：
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": false}}
```

如果 extension 取消了切换：
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": true}}
```

#### fork

从活动 Branch 上先前的用户消息创建一个新的 fork。可由 `session_before_fork` extension 事件处理器取消。返回被 fork 来源的消息文本。

```json
{"type": "fork", "entryId": "abc123"}
```

Response：
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": false}
}
```

如果 extension 取消了 fork：
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": true}
}
```

#### clone

将当前活动 Branch 复制为一个处于当前位置的新 session。可由 `session_before_fork` extension 事件处理器取消。

```json
{"type": "clone"}
```

Response：
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": false}
}
```

如果 extension 取消了 clone：
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": true}
}
```

#### get_fork_messages

获取可用于 fork 的用户消息。

```json
{"type": "get_fork_messages"}
```

Response：
```json
{
  "type": "response",
  "command": "get_fork_messages",
  "success": true,
  "data": {
    "messages": [
      {"entryId": "abc123", "text": "First prompt..."},
      {"entryId": "def456", "text": "Second prompt..."}
    ]
  }
}
```

#### get_entries

按追加顺序获取所有 session entries（不包括 session header）。session 是一棵具有稳定 id 的仅追加 entry 树，因此 entry id 可作为持久的游标使用：将你已见过的最后一个 entry id 作为 `since` 传入，即可只获取严格位于其后的 entries，即使跨客户端重启也有效。与 `get_messages` 不同，这包括 compaction 之前的历史和被放弃的 Branch。

```json
{"type": "get_entries"}
```

带游标：
```json
{"type": "get_entries", "since": "abc123"}
```

Response：
```json
{
  "type": "response",
  "command": "get_entries",
  "success": true,
  "data": {
    "entries": [
      {"type": "message", "id": "def456", "parentId": "abc123", "timestamp": "...", "message": {"role": "user", "...": "..."}}
    ],
    "leafId": "def456"
  }
}
```

`leafId` 是当前 leaf entry 的 id（对于空 session 为 `null`），因此客户端可以在一次往返中判断活动 Branch 是否发生移动。如果 `since` 不匹配任何 entry id，响应为 `success: false`。

#### get_tree

以 entry 树的形式获取 session。每个节点为 `{entry, children, label?, labelTimestamp?}`。一个格式良好的 session 只有一个根；孤立 entry（父链断裂）也会作为根出现。

```json
{"type": "get_tree"}
```

Response：
```json
{
  "type": "response",
  "command": "get_tree",
  "success": true,
  "data": {
    "tree": [
      {
        "entry": {"type": "message", "id": "abc123", "parentId": null, "...": "..."},
        "children": [
          {"entry": {"type": "message", "id": "def456", "parentId": "abc123", "...": "..."}, "children": []}
        ]
      }
    ],
    "leafId": "def456"
  }
}
```

#### get_last_assistant_text

获取最后一条 assistant 消息的文本内容。

```json
{"type": "get_last_assistant_text"}
```

Response：
```json
{
  "type": "response",
  "command": "get_last_assistant_text",
  "success": true,
  "data": {"text": "The assistant's response..."}
}
```

如果不存在 assistant 消息，则返回 `{"text": null}`。

#### set_session_name

为当前 session 设置显示名称。该名称会出现在 session 列表中，有助于识别 session。

```json
{"type": "set_session_name", "name": "my-feature-work"}
```

Response：
```json
{
  "type": "response",
  "command": "set_session_name",
  "success": true
}
```

当前 session 名称可通过 `get_state` 的 `sessionName` 字段获取。要在启动 RPC 模式时设置初始名称，请向 `pi --mode rpc` 进程传入 `--name <name>` 或 `-n <name>`。

### Commands

#### get_commands

获取可用命令（extension commands、prompt templates 和 skills）。这些命令可以通过在 `prompt` 命令前加 `/` 来调用。

```json
{"type": "get_commands"}
```

Response：
```json
{
  "type": "response",
  "command": "get_commands",
  "success": true,
  "data": {
    "commands": [
      {"name": "session-name", "description": "Set or clear session name", "source": "extension", "path": "/home/user/.pi/agent/extensions/session.ts"},
      {"name": "fix-tests", "description": "Fix failing tests", "source": "prompt", "location": "project", "path": "/home/user/myproject/.pi/agent/prompts/fix-tests.md"},
      {"name": "skill:brave-search", "description": "Web search via Brave API", "source": "skill", "location": "user", "path": "/home/user/.pi/agent/skills/brave-search/SKILL.md"}
    ]
  }
}
```

每个命令具有：
- `name`：命令名称（使用 `/name` 调用）
- `description`：人类可读的描述（对 extension commands 为可选）
- `source`：命令种类：
  - `"extension"`：通过 extension 中的 `pi.registerCommand()` 注册
  - `"prompt"`：从 prompt template `.md` 文件加载
  - `"skill"`：从 skill 目录加载（名称以 `skill:` 为前缀）
- `location`：加载来源（可选，extension 不包含此项）：
  - `"user"`：用户级（`~/.pi/agent/`）
  - `"project"`：项目级（`./.pi/agent/`）
  - `"path"`：通过 CLI 或 settings 指定的显式路径
- `path`：命令来源的绝对文件路径（可选）

**注意**：不包含内置 TUI 命令（`/settings`、`/hotkeys` 等）。它们仅在交互模式下处理，如果通过 `prompt` 发送则不会执行。

## Events

事件在 agent 运行期间以 JSON lines 形式流式传输到 stdout。事件通常不包含 `id` 字段；`bash_execution_update` 在提供了 id 时包含其来源 `bash` 命令的 `id`。

### Event Types

| Event | Description |
|-------|-------------|
| `agent_start` | Agent 开始处理 |
| `agent_end` | 一次底层 agent 运行完成（之后可能仍有 retry、compaction 或排队的延续） |
| `agent_settled` | Agent 运行完全稳定；不再有自动 retry、compaction retry 或排队的延续 |
| `turn_start` | 新 turn 开始 |
| `turn_end` | Turn 完成（包含 assistant 消息和 tool 结果） |
| `message_start` | 消息开始 |
| `message_update` | 流式更新（text/thinking/toolcall 增量） |
| `message_end` | 消息完成 |
| `bash_execution_update` | 直接 RPC bash 命令输出块 |
| `tool_execution_start` | Tool 开始执行 |
| `tool_execution_update` | Tool 执行进度（流式输出） |
| `tool_execution_end` | Tool 完成 |
| `queue_update` | 待处理的 steering/follow-up 队列发生变化 |
| `compaction_start` | Compaction 开始 |
| `compaction_end` | Compaction 完成 |
| `auto_retry_start` | 自动 retry 开始（在瞬时错误之后） |
| `auto_retry_end` | 自动 retry 完成（成功或最终失败） |
| `summarization_retry_scheduled` | 针对瞬时 compaction 或 branch-summary 摘要错误安排了重试 |
| `summarization_retry_attempt_start` | 重试的摘要请求开始 |
| `summarization_retry_finished` | 摘要重试循环完成 |
| `extension_error` | Extension 抛出了错误 |

### agent_start

当 agent 开始处理一个 prompt 时发出。

```json
{"type": "agent_start"}
```

### agent_end

当一次底层 agent 运行完成时发出。包含本次运行期间生成的所有消息。如果 `willRetry` 为 true，将随后进行自动重试。

```json
{
  "type": "agent_end",
  "messages": [...],
  "willRetry": false
}
```

### agent_settled

在整个 session 级运行稳定之后发出。此时 Pi 不会通过 retry、compaction retry 或排队的 follow-up 消息自动继续。

```json
{"type": "agent_settled"}
```

### turn_start / turn_end

一个 turn 由一次 assistant 响应加上由此产生的任何 tool calls 和结果组成。

```json
{"type": "turn_start"}
```

```json
{
  "type": "turn_end",
  "message": {...},
  "toolResults": [...]
}
```

### message_start / message_end

在消息开始和完成时发出。`message` 字段包含一个 `AgentMessage`。

```json
{"type": "message_start", "message": {...}}
{"type": "message_end", "message": {...}}
```

### message_update (Streaming)

在 assistant 消息流式传输期间发出。包含一个不带累积消息快照的 delta 事件。

```json
{
  "type": "message_update",
  "usage": {
    "input": 100,
    "output": 1,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 101,
    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}
  },
  "assistantMessageEvent": {
    "type": "text_delta",
    "contentIndex": 0,
    "delta": "Hello "
  }
}
```

`assistantMessageEvent` 字段包含以下 delta 类型之一：

| Type | Description |
|------|-------------|
| `text_start` | 文本内容块开始 |
| `text_delta` | 文本内容块 |
| `text_end` | 文本内容块结束 |
| `thinking_start` | Thinking 块开始 |
| `thinking_delta` | Thinking 内容块 |
| `thinking_end` | Thinking 块结束 |
| `toolcall_start` | Tool call 开始（包含 `id` 和 `toolName`） |
| `toolcall_delta` | Tool call 参数块 |
| `toolcall_end` | Tool call 结束（包含完整的 `toolCall` 对象） |

流式传输文本响应的示例：
```json
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_start","contentIndex":0}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":" world"}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello world"}}
```

顶层 `usage` 字段包含 provider 报告的最新累积 usage。当 provider 在流式传输期间不报告 usage 时，
该字段可能一直保持为零直到完成。

启动一个 tool call 的示例：
```json
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"toolcall_start","contentIndex":1,"id":"call_abc123","toolName":"write"}}
```

`message_update` 有意省略了原先的累积 `message` 字段和
`assistantMessageEvent.partial`。需要实时部分消息的客户端必须使用 `contentIndex`
从 `message_start` 及后续事件中组装它。将 `message_end.message`
视为权威。对于 tool calls，`toolcall_start` 提供调用的 `id` 和 `toolName`；
缓冲 `toolcall_delta.delta` 以获取参数。`toolcall_end.toolCall` 包含已完成的
调用。

### bash_execution_update

对于来自直接 `bash` 命令的每个输出块发出一次。`id` 与该命令的 `id` 匹配，使客户端能够将输出关联到正确的命令。

事件会在命令运行期间流式传输所有输出，即使最终 `bash` 响应的 `output` 被截断。

```json
{
  "type": "bash_execution_update",
  "id": "req-1",
  "delta": "total 48\n"
}
```

### tool_execution_start / tool_execution_update / tool_execution_end

在 tool 开始、流式传输进度和完成执行时发出。

```json
{
  "type": "tool_execution_start",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"}
}
```

执行期间，`tool_execution_update` 事件流式传输部分结果（例如 bash 输出到达时的内容）：

```json
{
  "type": "tool_execution_update",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"},
  "partialResult": {
    "content": [{"type": "text", "text": "partial output so far..."}],
    "details": {"truncation": null, "fullOutputPath": null}
  }
}
```

完成时：

```json
{
  "type": "tool_execution_end",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "result": {
    "content": [{"type": "text", "text": "total 48\n..."}],
    "details": {...}
  },
  "isError": false
}
```

使用 `toolCallId` 来关联事件。`tool_execution_update` 中的 `partialResult` 包含目前累积的输出（不只是增量），使客户端可以在每次更新时简单地替换其显示内容。

### queue_update

每当待处理的 steering 或 follow-up 队列发生变化时发出。

```json
{
  "type": "queue_update",
  "steering": ["Focus on error handling"],
  "followUp": ["After that, summarize the result"]
}
```

### compaction_start / compaction_end

在 compaction 运行（无论是手动还是自动）时发出。

```json
{"type": "compaction_start", "reason": "threshold"}
```

`reason` 字段为 `"manual"`、`"threshold"` 或 `"overflow"`。

```json
{
  "type": "compaction_end",
  "reason": "threshold",
  "result": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {
      "input": 32000,
      "output": 1200,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 33200,
      "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03}
    },
    "details": {}
  },
  "aborted": false,
  "willRetry": false
}
```

如果 `reason` 为 `"overflow"` 且 compaction 成功，则 `willRetry` 为 `true`，agent 将自动重试该 prompt。

如果 compaction 被中止，则 `result` 为 `null` 且 `aborted` 为 `true`。

如果 compaction 失败（例如 API 配额超限），则 `result` 为 `null`，`aborted` 为 `false`，并且 `errorMessage` 包含错误描述。

### auto_retry_start / auto_retry_end

在瞬时错误（过载、速率限制、5xx）之后触发自动重试时发出。

```json
{
  "type": "auto_retry_start",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"
}
```

```json
{
  "type": "auto_retry_end",
  "success": true,
  "attempt": 2
}
```

最终失败时（超过最大重试次数）：
```json
{
  "type": "auto_retry_end",
  "success": false,
  "attempt": 3,
  "finalError": "529 overloaded_error: Overloaded"
}
```

### summarization_retry_scheduled / summarization_retry_attempt_start / summarization_retry_finished

在 compaction 或 branch-summary 摘要在遇到瞬时 provider 错误后重试时发出。这些事件使用与自动 assistant-turn 重试相同的重试设置。

```json
{
  "type": "summarization_retry_scheduled",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "terminated"
}
```

```json
{
  "type": "summarization_retry_attempt_start",
  "source": "compaction",
  "reason": "threshold"
}
```

对于 branch summaries，`source` 为 `"branchSummary"` 且不包含 `reason`。

```json
{
  "type": "summarization_retry_finished"
}
```

### extension_error

在 extension 抛出错误时发出。

```json
{
  "type": "extension_error",
  "extensionPath": "/path/to/extension.ts",
  "event": "tool_call",
  "error": "Error message..."
}
```

## Extension UI Protocol

Extensions 可以通过 `ctx.ui.select()`、`ctx.ui.confirm()` 等请求用户交互。在 RPC 模式中，这些会被转换为建立在基础 command/event 流之上的请求/响应子协议。

Extension UI 方法分为两类：

- **Dialog methods**（`select`、`confirm`、`input`、`editor`）：在 stdout 上发出一个 `extension_ui_request`，并阻塞直到客户端在 stdin 上发回一个带有匹配 `id` 的 `extension_ui_response`。
- **Fire-and-forget methods**（`notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text`）：在 stdout 上发出一个 `extension_ui_request`，但不期望响应。客户端可以显示该信息或忽略它。

如果某个 dialog method 包含 `timeout` 字段，agent 端将在超时到期时用默认值自动解决。客户端无需跟踪超时。

某些 `ExtensionUIContext` 方法在 RPC 模式中不受支持或功能降级，因为它们需要直接的 TUI 访问：
- `custom()` 返回 `undefined`
- `setWorkingMessage()`、`setWorkingIndicator()`、`setFooter()`、`setHeader()`、`setEditorComponent()`、`setToolsExpanded()` 为空操作
- `getEditorText()` 返回 `""`
- `getToolsExpanded()` 返回 `false`
- `pasteToEditor()` 委托给 `setEditorText()`（不处理粘贴/折叠）
- `getAllThemes()` 返回 `[]`
- `getTheme()` 返回 `undefined`
- `setTheme()` 返回 `{ success: false, error: "..." }`

注意：在 RPC 模式中 `ctx.mode` 为 `"rpc"`，`ctx.hasUI` 为 `true`，因为 dialog 和 fire-and-forget 方法通过 extension UI 子协议是可用的。请使用 `ctx.mode === "tui"` 来守护像 `custom()` 这样需要真实终端的 TUI 特定功能。

### Extension UI Requests (stdout)

所有请求都具有 `type: "extension_ui_request"`、一个唯一的 `id` 和一个 `method` 字段。

#### select

提示用户从列表中选择。带有 `timeout` 字段的 dialog methods 会包含以毫秒为单位的超时；如果客户端未及时响应，agent 会用 `undefined` 自动解决。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-1",
  "method": "select",
  "title": "Allow dangerous command?",
  "options": ["Allow", "Block"],
  "timeout": 10000
}
```

预期响应：带有 `value`（所选的选项字符串）或 `cancelled: true` 的 `extension_ui_response`。

#### confirm

提示用户进行是/否确认。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-2",
  "method": "confirm",
  "title": "Clear session?",
  "message": "All messages will be lost.",
  "timeout": 5000
}
```

预期响应：带有 `confirmed: true/false` 或 `cancelled: true` 的 `extension_ui_response`。

#### input

提示用户输入自由形式的文本。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-3",
  "method": "input",
  "title": "Enter a value",
  "placeholder": "type something..."
}
```

预期响应：带有 `value`（所输入的文本）或 `cancelled: true` 的 `extension_ui_response`。

#### editor

打开一个多行文本编辑器，可选地预填内容。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-4",
  "method": "editor",
  "title": "Edit some text",
  "prefill": "Line 1\nLine 2\nLine 3"
}
```

预期响应：带有 `value`（编辑后的文本）或 `cancelled: true` 的 `extension_ui_response`。

#### notify

显示一条通知。Fire-and-forget，不期望响应。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-5",
  "method": "notify",
  "message": "Command blocked by user",
  "notifyType": "warning"
}
```

`notifyType` 字段为 `"info"`、`"warning"` 或 `"error"`。如果省略，默认为 `"info"`。

#### setStatus

在 footer/status bar 中设置或清除一个状态条目。Fire-and-forget。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-6",
  "method": "setStatus",
  "statusKey": "my-ext",
  "statusText": "Turn 3 running..."
}
```

发送 `statusText: undefined`（或省略它）以清除该 key 的状态条目。

#### setWidget

设置或清除显示在编辑器上方或下方的一个 widget（文本行块）。Fire-and-forget。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-7",
  "method": "setWidget",
  "widgetKey": "my-ext",
  "widgetLines": ["--- My Widget ---", "Line 1", "Line 2"],
  "widgetPlacement": "aboveEditor"
}
```

发送 `widgetLines: undefined`（或省略它）以清除该 widget。`widgetPlacement` 字段为 `"aboveEditor"`（默认）或 `"belowEditor"`。RPC 模式仅支持字符串数组；component factories 会被忽略。

#### setTitle

设置终端窗口/标签页标题。Fire-and-forget。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-8",
  "method": "setTitle",
  "title": "pi - my project"
}
```

#### set_editor_text

设置输入编辑器中的文本。Fire-and-forget。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-9",
  "method": "set_editor_text",
  "text": "prefilled text for the user"
}
```

### Extension UI Responses (stdin)

仅对 dialog methods（`select`、`confirm`、`input`、`editor`）发送响应。`id` 必须与请求匹配。

#### Value response (select, input, editor)

```json
{"type": "extension_ui_response", "id": "uuid-1", "value": "Allow"}
```

#### Confirmation response (confirm)

```json
{"type": "extension_ui_response", "id": "uuid-2", "confirmed": true}
```

#### Cancellation response (any dialog)

关闭任何 dialog method。Extension 会收到 `undefined`（对于 select/input/editor）或 `false`（对于 confirm）。

```json
{"type": "extension_ui_response", "id": "uuid-3", "cancelled": true}
```

## Error Handling

失败的命令会返回带有 `success: false` 的响应：

```json
{
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: invalid/model"
}
```

解析错误：

```json
{
  "type": "response",
  "command": "parse",
  "success": false,
  "error": "Failed to parse command: Unexpected token..."
}
```

## Types

源文件：
- [`packages/ai/src/types.ts`](../../ai/src/types.ts) - `Model`、`UserMessage`、`AssistantMessage`、`ToolResultMessage`
- [`packages/agent/src/types.ts`](../../agent/src/types.ts) - `AgentMessage`、`AgentEvent`
- [`src/core/messages.ts`](../src/core/messages.ts) - `BashExecutionMessage`
- [`src/modes/json-event.ts`](../src/modes/json-event.ts) - `JsonAgentSessionEvent`
- [`src/modes/rpc/rpc-types.ts`](../src/modes/rpc/rpc-types.ts) - RPC command/response 类型、extension UI request/response 类型

### Model

```json
{
  "id": "claude-sonnet-4-20250514",
  "name": "Claude Sonnet 4",
  "api": "anthropic-messages",
  "provider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "reasoning": true,
  "input": ["text", "image"],
  "contextWindow": 200000,
  "maxTokens": 16384,
  "cost": {
    "input": 3.0,
    "output": 15.0,
    "cacheRead": 0.3,
    "cacheWrite": 3.75
  }
}
```

### UserMessage

```json
{
  "role": "user",
  "content": "Hello!",
  "timestamp": 1733234567890,
  "attachments": []
}
```

`content` 字段可以是字符串，也可以是 `TextContent`/`ImageContent` 块的数组。

### AssistantMessage

```json
{
  "role": "assistant",
  "content": [
    {"type": "text", "text": "Hello! How can I help?"},
    {"type": "thinking", "thinking": "User is greeting me..."},
    {"type": "toolCall", "id": "call_123", "name": "bash", "arguments": {"command": "ls"}}
  ],
  "api": "anthropic-messages",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "usage": {
    "input": 100,
    "output": 50,
    "cacheRead": 0,
    "cacheWrite": 0,
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105}
  },
  "stopReason": "stop",
  "timestamp": 1733234567890
}
```

停止原因：`"stop"`、`"length"`、`"toolUse"`、`"error"`、`"aborted"`

### ToolResultMessage

```json
{
  "role": "toolResult",
  "toolCallId": "call_123",
  "toolName": "bash",
  "content": [{"type": "text", "text": "total 48\ndrwxr-xr-x ..."}],
  "usage": {
    "input": 100,
    "output": 50,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 150,
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105}
  },
  "isError": false,
  "timestamp": 1733234567890
}
```

`usage` 是可选的，报告 tool 执行的嵌套 LLM 工作。当存在时，它会贡献到 session token 和成本总计中。

### BashExecutionMessage

由 `bash` RPC 命令创建（不是由 LLM tool calls 创建）：

```json
{
  "role": "bashExecution",
  "command": "ls -la",
  "output": "total 48\ndrwxr-xr-x ...",
  "exitCode": 0,
  "cancelled": false,
  "truncated": false,
  "fullOutputPath": null,
  "timestamp": 1733234567890
}
```

### Attachment

```json
{
  "id": "img1",
  "type": "image",
  "fileName": "photo.jpg",
  "mimeType": "image/jpeg",
  "size": 102400,
  "content": "base64-encoded-data...",
  "extractedText": null,
  "preview": null
}
```

## Example: Basic Client (Python)

```python
import subprocess
import json

proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True
)

def send(cmd):
    proc.stdin.write(json.dumps(cmd) + "\n")
    proc.stdin.flush()

def read_events():
    for line in proc.stdout:
        yield json.loads(line)

# Send prompt
send({"type": "prompt", "message": "Hello!"})

# Process events
for event in read_events():
    if event.get("type") == "message_update":
        delta = event.get("assistantMessageEvent", {})
        if delta.get("type") == "text_delta":
            print(delta["delta"], end="", flush=True)
    
    if event.get("type") == "agent_end":
        print()
        break
```

## Example: Interactive Client (Node.js)

完整的交互式示例参见 [`test/rpc-example.ts`](../test/rpc-example.ts)，类型化客户端实现参见 [`src/modes/rpc/rpc-client.ts`](../src/modes/rpc/rpc-client.ts)。

关于处理 extension UI 协议的完整示例，参见 [`examples/rpc-extension-ui.ts`](../examples/rpc-extension-ui.ts)，它与 [`examples/extensions/rpc-demo.ts`](../examples/extensions/rpc-demo.ts) extension 配套使用。

```javascript
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");

const agent = spawn("pi", ["--mode", "rpc", "--no-session"]);

function attachJsonlReader(stream, onLine) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    stream.on("data", (chunk) => {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

        while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex === -1) break;

            let line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            onLine(line);
        }
    });

    stream.on("end", () => {
        buffer += decoder.end();
        if (buffer.length > 0) {
            onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
        }
    });
}

attachJsonlReader(agent.stdout, (line) => {
    const event = JSON.parse(line);

    if (event.type === "message_update") {
        const { assistantMessageEvent } = event;
        if (assistantMessageEvent.type === "text_delta") {
            process.stdout.write(assistantMessageEvent.delta);
        }
    }
});

// Send prompt
agent.stdin.write(JSON.stringify({ type: "prompt", message: "Hello" }) + "\n");

// Abort on Ctrl+C
process.on("SIGINT", () => {
    agent.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
});
```
