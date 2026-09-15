# Session File Format

Session 以 JSONL（JSON Lines）文件的形式存储。每一行都是一个带有 `type` 字段的 JSON 对象。Session 条目通过 `id`/`parentId` 字段形成树结构，从而支持在不创建新文件的情况下进行就地 branching。

## 文件位置

```
~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl
```

默认情况下，`<session-id>` 是一个 UUID。调用方可以通过 SDK 或 `--session-id` 提供自定义 ID。对于 `<path>`，Pi 会移除开头的路径分隔符，并将 `/`、`\\` 和 `:` 替换为 `-`。

## 删除 Session

可以通过删除 `~/.pi/agent/sessions/` 下的 `.jsonl` 文件来移除 session。

Pi 还支持从 `/resume` 交互式删除 session（选择一个 session 并按 `Ctrl+D`，然后确认）。在可用时，pi 会使用 `trash` CLI 以避免永久删除。

## Session 版本

Session 在头部有一个版本字段：

- **Version 1**：线性条目序列（旧版，加载时自动迁移）
- **Version 2**：使用 `id`/`parentId` 链接的树结构
- **Version 3**：将 `hookMessage` role 重命名为 `custom`（extensions 统一）

现有的 session 在加载时会自动迁移到当前版本（v3）。

## 源文件

GitHub 上的源码（[pi](https://github.com/earendil-works/pi)）：
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts) - Session 条目类型和 SessionManager
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/messages.ts) - 扩展消息类型（BashExecutionMessage、CustomMessage 等）
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts) - 基础消息类型（UserMessage、AssistantMessage、ToolResultMessage）
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts) - AgentMessage 联合类型

对于你项目中的 TypeScript 定义，请检查 `node_modules/@earendil-works/pi-coding-agent/dist/` 和 `node_modules/@earendil-works/pi-ai/dist/`。

## 消息类型

Session 条目包含 `AgentMessage` 对象。理解这些类型对于解析 session 和编写 extension 至关重要。

### 内容块

消息包含类型化内容块的数组：

```typescript
interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

interface ImageContent {
  type: "image";
  data: string;      // base64 encoded
  mimeType: string;  // e.g., "image/jpeg", "image/png"
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
  thoughtSignature?: string;
  namespace?: string;
}
```

### 基础消息类型（来自 pi-ai）

```typescript
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;  // Unix ms
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  providerThinkingLevel?: string;
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  deferred?: DeferredHandle;
  errorMessage?: string;
  rawStopReason?: string;
  endTurn?: boolean;
  timestamp: number;
}

interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: any;      // Tool-specific metadata
  usage?: Usage;      // Nested LLM work performed by the tool
  addedToolNames?: string[];
  isError: boolean;
  timestamp: number;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

`"pending"` 保留用于流式事件中的部分消息。终端事件会在 Pi 持久化 assistant 消息之前将其替换为完成原因，因此 `"pending"` 永远不应出现在 session JSONL 中。`"deferred"` 是 provider 响应稍后才会完成的终端原因；它的 `deferred` handle 包含检索该响应所需的 provider 数据。

### 扩展消息类型（来自 pi-coding-agent）

```typescript
interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;  // true for !! prefix commands
  timestamp: number;
}

interface CustomMessage {
  role: "custom";
  customType: string;            // Extension identifier
  content: string | (TextContent | ImageContent)[];
  display: boolean;              // Show in TUI
  details?: any;                 // Extension-specific metadata
  timestamp: number;
}

interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string | null;         // Previous leaf whose abandoned path was summarized
  timestamp: number;
}

interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}
```

### AgentMessage 联合类型

```typescript
type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;
```

## 条目基础

所有条目（`SessionHeader` 除外）都扩展 `SessionEntryBase`：

```typescript
interface SessionEntryBase {
  type: string;
  id: string;           // Usually an 8-char hex ID; may fall back to a full UUID
  parentId: string | null;  // Parent entry ID (null for a root entry)
  timestamp: string;    // ISO timestamp
}
```

## 条目类型

### SessionHeader

文件的第一行。仅元数据，不属于树的一部分（没有 `id`/`parentId`）。

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project"}
```

对于带有 parent 的 session（通过 `/fork`、`/clone` 或 `newSession({ parentSession })` 创建）：

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSession":"/path/to/original/session.jsonl"}
```

### SessionMessageEntry

对话中的一条消息。`message` 字段包含一个 `AgentMessage`。

```json
{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello","timestamp":1733234401000}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop","timestamp":1733234402000}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false,"timestamp":1733234403000}}
```

### ModelChangeEntry

当用户在 session 中途切换 model 时发出。

```json
{"type":"model_change","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}
```

### ThinkingLevelChangeEntry

当用户更改 thinking/reasoning level 时发出。

```json
{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}
```

### CompactionEntry

当 context 被 compacted 时创建。存储更早消息的摘要。

```json
{"type":"compaction","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:10:00.000Z","summary":"User discussed X, Y, Z...","firstKeptEntryId":"c3d4e5f6","tokensBefore":50000}
```

`firstKeptEntryId` 是必需的。它标识从 compaction 条目之前保留的第一个条目。在重建 context 时，Pi 会用 compaction 摘要替换更早的被概括条目，并保留从该条目开始的范围。

可选字段：
- `usage`：生成摘要所产生的 LLM usage；包含在 session 的 token 和 cost 总计中
- `details`：实现特定的数据（例如，默认情况下为 `{ readFiles: string[], modifiedFiles: string[] }`，或 extension 的自定义数据）
- `fromHook`：如果由 extension 生成则为 `true`，如果由 pi 生成则为 `false`/`undefined`（旧版字段名）

### BranchSummaryEntry

当通过 `/tree` 切换 branch 时创建，包含对直到共同祖先为止的已离开 branch 的 LLM 生成摘要。捕获被放弃路径中的 context。

```json
{"type":"branch_summary","id":"g7h8i9j0","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:15:00.000Z","fromId":"f6g7h8i9","summary":"Branch explored approach A..."}
```

`parentId` 是新 branch 从中继续的条目。`fromId` 是被概括了被放弃路径的前一个叶节点。

可选字段：
- `usage`：生成摘要所产生的 LLM usage；包含在 session 的 token 和 cost 总计中
- `details`：默认情况下为文件跟踪数据（`{ readFiles: string[], modifiedFiles: string[] }`），或 extension 的自定义数据
- `fromHook`：如果由 extension 生成则为 `true`，如果由 pi 生成则为 `false`/`undefined`（旧版字段名）

### CustomEntry

Extension 状态持久化。不参与 LLM context。

```json
{"type":"custom","id":"h8i9j0k1","parentId":"g7h8i9j0","timestamp":"2024-12-03T14:20:00.000Z","customType":"my-extension","data":{"count":42}}
```

使用 `customType` 在重新加载时识别你的 extension 的条目。交互模式可以通过 `pi.registerEntryRenderer(customType, renderer)` 渲染 custom 条目，但它们仍然不参与 LLM context。

### CustomMessageEntry

参与 LLM context 的 extension 注入消息。

```json
{"type":"custom_message","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"2024-12-03T14:25:00.000Z","customType":"my-extension","content":"Injected context...","display":true}
```

字段：
- `content`：字符串或 `(TextContent | ImageContent)[]`（与 UserMessage 相同）
- `display`：`true` = 在 TUI 中以独特的样式显示，`false` = 隐藏
- `details`：可选的 extension 特定元数据（不发送给 LLM）

### LabelEntry

条目上用户定义的书签/标记。

```json
{"type":"label","id":"j0k1l2m3","parentId":"i9j0k1l2","timestamp":"2024-12-03T14:30:00.000Z","targetId":"a1b2c3d4","label":"checkpoint-1"}
```

将 `label` 设置为 `undefined` 以清除 label。

### SessionInfoEntry

Session 元数据（例如，用户定义的显示名称）。通过 `/name`、`--name` / `-n` 或 extension 中的 `pi.setSessionName()` 设置。

```json
{"type":"session_info","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"2024-12-03T14:35:00.000Z","name":"Refactor auth module"}
```

设置后，session 名称会显示在 session 选择器（`/resume`）中，而不是显示第一条消息。

## 树结构

条目通常形成一棵树，但导航 API 可以创建多个根：
- 根条目的 `parentId: null`；第一个条目最初是根
- 每个非根条目通过 `parentId` 指向其父节点
- Branching 会从更早的条目创建新的子节点
- “叶节点”是树中的当前位置
- 调用 `resetLeaf()` 或 `branchWithSummary(null, ...)` 允许后续条目成为另一个根

```
[user msg] ─── [assistant] ─── [user msg] ─── [assistant] ─┬─ [user msg] ← current leaf
                                                            │
                                                            └─ [branch_summary] ─── [user msg] ← alternate branch
```

## Context 构建

`buildContextEntries()` 从当前叶节点走到根，生成活动条目列表，同时遵循 compaction：

1. 收集路径上的所有条目
2. 如果路径上有一个或多个 `CompactionEntry` 值，则使用最新的那个：
   - 首先包含 compaction 条目
   - 包含从 `firstKeptEntryId` 到 compaction 条目（但不包括该条目）的条目
   - 包含 compaction 条目之后的条目
3. 保留所选范围内的非消息条目，以便交互模式可以渲染它们

`buildSessionContext()` 在该条目列表的基础上构建，以生成供 LLM 使用的消息列表：

1. 从完整路径中提取当前 model 和 thinking level 设置
2. 将所选条目转换为消息：
   - `message` -> 存储的 `AgentMessage`
   - `compaction` -> `compactionSummary`
   - `branch_summary` -> `branchSummary`
   - `custom_message` -> `CustomMessage`
   - `custom` -> 无 context 消息

compaction 摘要会替换 `firstKeptEntryId` 之前的条目。保留的条目以及 compaction 之后的所有条目仍然可供 LLM 使用。

## 解析示例

```typescript
import { readFileSync } from "fs";

const lines = readFileSync("session.jsonl", "utf8").trim().split("\n");

for (const line of lines) {
  const entry = JSON.parse(line);

  switch (entry.type) {
    case "session":
      console.log(`Session v${entry.version ?? 1}: ${entry.id}`);
      break;
    case "message":
      console.log(`[${entry.id}] ${entry.message.role}: ${JSON.stringify(entry.message.content)}`);
      break;
    case "compaction":
      console.log(`[${entry.id}] Compaction: ${entry.tokensBefore} tokens summarized`);
      break;
    case "branch_summary":
      console.log(`[${entry.id}] Branch from ${entry.fromId}`);
      break;
    case "custom":
      console.log(`[${entry.id}] Custom (${entry.customType}): ${JSON.stringify(entry.data)}`);
      break;
    case "custom_message":
      console.log(`[${entry.id}] Extension message (${entry.customType}): ${entry.content}`);
      break;
    case "label":
      console.log(`[${entry.id}] Label "${entry.label}" on ${entry.targetId}`);
      break;
    case "model_change":
      console.log(`[${entry.id}] Model: ${entry.provider}/${entry.modelId}`);
      break;
    case "thinking_level_change":
      console.log(`[${entry.id}] Thinking: ${entry.thinkingLevel}`);
      break;
  }
}
```

## SessionManager API

以编程方式处理 session 的关键方法。

### 静态创建方法
- `SessionManager.create(cwd, sessionDir?, options?)` - 新 session；`options` 可以设置 `id` 和 `parentSession`
- `SessionManager.open(path, sessionDir?, cwdOverride?)` - 打开现有的 session 文件
- `SessionManager.continueRecent(cwd, sessionDir?)` - 继续最近的 session 或创建新的 session
- `SessionManager.inMemory(cwd?, options?, entries?)` - 无文件持久化，可选地从条目初始化
- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?, options?)` - 从另一个项目 Fork session

### 静态列出方法
- `SessionManager.list(cwd, sessionDir?, onProgress?)` - 列出一个目录的 session
- `SessionManager.listAll(onProgress?)` - 列出所有项目中的所有 session
- `SessionManager.listAll(sessionDir?, onProgress?)` - 从自定义 session 根目录列出 session

### 实例方法 - Session 管理
- `newSession(options?)` - 启动一个新的 session（options：`{ id?: string, parentSession?: string }`）
- `setSessionFile(path)` - 切换到不同的 session 文件
- `createBranchedSession(leafId)` - 将 branch 提取到新的 session 文件

### 实例方法 - 追加（全部返回条目 ID）
- `appendMessage(message)` - 添加消息
- `appendThinkingLevelChange(level)` - 记录 thinking 变更
- `appendModelChange(provider, modelId)` - 记录 model 变更
- `appendCompaction(summary, firstKeptEntryId, tokensBefore, details?, fromHook?, usage?)` - 添加 compaction
- `appendCustomEntry(customType, data?)` - Extension 状态（不在 context 中）
- `appendSessionInfo(name)` - 设置 session 显示名称
- `appendCustomMessageEntry(customType, content, display, details?)` - Extension 消息（在 context 中）
- `appendLabelChange(targetId, label)` - 设置/清除 label

### 实例方法 - 树导航
- `getLeafId()` - 当前位置
- `getLeafEntry()` - 获取当前叶条目
- `getEntry(id)` - 按 ID 获取条目
- `getBranch(fromId?)` - 从条目走到根
- `getTree()` - 获取完整树结构
- `getChildren(parentId)` - 获取直接子节点
- `getLabel(id)` - 获取条目的 label
- `branch(entryId)` - 将叶节点移动到更早的条目
- `resetLeaf()` - 将叶节点重置为 null（在任何条目之前）
- `branchWithSummary(entryId, summary, details?, fromHook?, usage?)` - 带 context 摘要的 Branch；`entryId` 可以为 `null`，以从根进行 branch

### 实例方法 - Context 与信息
- `buildContextEntries()` - 获取应用了 compaction 的活动 branch 条目
- `buildSessionContext()` - 获取供 LLM 使用的消息、thinkingLevel 和 model
- `getEntries()` - 所有条目（不包括头部）
- `getHeader()` - Session 头部元数据
- `getSessionName()` - 从最新的 session_info 条目获取显示名称
- `getCwd()` - 工作目录
- `getSessionDir()` - Session 存储目录
- `getSessionId()` - Session UUID
- `getSessionFile()` - Session 文件路径（内存中时为 undefined）
- `isPersisted()` - session 是否保存到磁盘
