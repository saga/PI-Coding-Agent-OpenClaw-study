# Compaction 与 Branch Summarization

LLM 的 context window 是有限的。当对话变得过长时，Pi 使用 compaction 概括更早的内容，同时保留最近的工作。本页涵盖 auto-compaction 和 branch summarization 两者。

**源文件**（[pi](https://github.com/earendil-works/pi)）：
- [`packages/coding-agent/src/core/compaction/compaction.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) - Auto-compaction 逻辑
- [`packages/coding-agent/src/core/compaction/branch-summarization.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) - Branch summarization
- [`packages/coding-agent/src/core/compaction/utils.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/utils.ts) - 共享工具（文件跟踪、序列化）
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts) - 条目类型（`CompactionEntry`、`BranchSummaryEntry`）
- [`packages/coding-agent/src/core/extensions/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) - Extension 事件类型

对于你项目中的 TypeScript 定义，请检查 `node_modules/@earendil-works/pi-coding-agent/dist/`。

## 概述

Pi 有两种概括机制：

| 机制 | 触发条件 | 目的 |
|-----------|---------|---------|
| Compaction | Context 超过阈值，或 `/compact` | 概括旧消息以释放 context |
| Branch summarization | `/tree` 导航 | 在切换 branch 时保留 context |

两者使用相同的结构化摘要格式，并以累积方式跟踪文件操作。Compaction 和 branch-summary 请求使用全新的路由 session ID，并且在 provider 支持的情况下禁用 prompt-cache 写入，因为这些一次性 prompt 不太可能被重用。

## Compaction

### 何时触发

Auto-compaction 在以下情况下触发：

```
contextTokens > contextWindow - reserveTokens
```

默认情况下，`reserveTokens` 为 16384 个 token（可在 `~/.pi/agent/settings.json` 或 `<project-dir>/.pi/settings.json` 中配置）。这为 LLM 的响应留出空间。

在多轮 agent 运行期间，Pi 会在 tool 完成且其结果被追加之后、开始下一个 assistant 响应之前检查此阈值。如果超过阈值，Pi 会在同一次 agent 运行内进行 compact，并使用摘要和保留的消息继续。当完成的 tool 批次终止运行且没有排队的消息需要另一个响应时，它会跳过此轮次之间的检查。Pi 还会在新的用户 prompt 之前以及底层 agent 运行结束后检查阈值。

你也可以使用 `/compact [instructions]` 手动触发，其中可选的 instructions 用于聚焦摘要。

### 工作原理

1. **查找切点**：从最新消息向前回溯，累积 token 估算值，直到达到 `keepRecentTokens`（默认 20k，可在 `~/.pi/agent/settings.json` 或 `<project-dir>/.pi/settings.json` 中配置）
2. **提取消息**：收集从上一个保留边界（或 session 开始）到切点的消息
3. **生成摘要**：调用 LLM 以结构化格式进行概括，存在时传入上一个摘要作为迭代 context
4. **追加条目**：保存带有摘要和 `firstKeptEntryId` 的 `CompactionEntry`
5. **重建 context**：Session 为下一个请求重建 context，使用摘要 + 从 `firstKeptEntryId` 开始的消息

```
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9     10
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

在重复进行 compaction 时，被概括的范围从上一个 compaction 的保留边界（`firstKeptEntryId`）开始，而不是从 compaction 条目本身开始；如果该保留条目无法在路径中找到，则回退到上一个 compaction 之后的条目。这会通过将幸存于更早 compaction 的消息也包含在下一轮概括中来保留它们。Pi 还会在写入新的 `CompactionEntry` 之前从重建的 session context 重新计算 `tokensBefore`，因此 token 计数反映的是被替换的实际 pre-compaction context。

### Split Turns

一个“turn”从一条 user 消息开始，包含直到下一条 user 消息之前的所有 assistant 响应和 tool 调用。通常，compaction 在 turn 边界处进行切割。

当单个 turn 超过 `keepRecentTokens` 时，切点会落在 turn 中间的某条 assistant 消息处。这就是“split turn”：

```
Split turn (one huge turn exceeds budget):

  entry:  0     1     2      3     4      5      6     7      8
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┴──────┘
                ↑                                     ↑
         turnStartIndex = 1                  firstKeptEntryId = 7
                │                                     │
                └──── turnPrefixMessages (1-6) ───────┘
                                                      └── kept (7-8)

  isSplitTurn = true
  messagesToSummarize = []  (no complete turns before)
  turnPrefixMessages = [usr, ass, tool, ass, tool, tool]
```

对于 split turn，Pi 会生成两个摘要并将它们合并：
1. **History summary**：先前的 context（如果有）
2. **Turn prefix summary**：split turn 的早期部分

### 切点规则

有效的切点是：
- User 消息
- Assistant 消息
- BashExecution 消息
- Custom 消息（custom_message、branch_summary）

绝不在 tool result 处切割（它们必须与其 tool call 保持在一起）。

### CompactionEntry 结构

定义于 [`session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts)：

```typescript
interface CompactionEntry<T = unknown> {
  type: "compaction";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: Usage;       // LLM usage that generated the summary
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default compaction uses this for details (from compaction.ts):
interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Extension 可以在 `details` 中存储任何可 JSON 序列化的数据。默认 compaction 跟踪文件操作，但自定义 extension 实现可以使用自己的结构。生成的和 extension 提供的摘要在可用时会存储它们的 LLM `usage`，以便 session 总计包含概括工作。

实现请参见 [`prepareCompaction()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) 和 [`compact()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts)。对于直接的程序化概括，`generateSummary()` 返回摘要文本，`generateSummaryWithUsage()` 返回 `{ text, usage }`。

## Branch Summarization

### 何时触发

当你使用 `/tree` 导航到不同的 branch 时，Pi 会提议概括你正在离开的工作。这会将来自已离开 branch 的 context 注入到新 branch 中。

### 工作原理

1. **查找共同祖先**：旧位置和新位置共享的最深节点
2. **收集条目**：从旧叶节点回溯到共同祖先
3. **按预算准备**：包含直到 token 预算的消息（最新的优先）
4. **生成摘要**：以结构化格式调用 LLM
5. **追加条目**：在导航点保存 `BranchSummaryEntry`

```
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D
    A ───┤
         └─ E ─ F ─ [summary of B,C,D] (new leaf)
```

### 累积文件跟踪

Compaction 和 branch summarization 都以累积方式跟踪文件。生成摘要时，pi 从以下来源提取文件操作：
- 正在被概括的消息中的 tool call
- 上一个 compaction 或 branch summary 的 `details`（如果有）

这意味着文件跟踪会在多次 compaction 或嵌套的 branch summary 之间累积，保留读取和修改文件的完整历史。

### BranchSummaryEntry 结构

定义于 [`session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts)：

```typescript
interface BranchSummaryEntry<T = unknown> {
  type: "branch_summary";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  fromId: string;      // Entry we navigated from
  usage?: Usage;       // LLM usage that generated the summary
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default branch summarization uses this for details (from branch-summarization.ts):
interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

与 compaction 相同，extension 可以在 `details` 中存储自定义数据。

实现请参见 [`collectEntriesForBranchSummary()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts)、[`prepareBranchEntries()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) 和 [`generateBranchSummary()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts)。

## 摘要格式

Compaction 和 branch summarization 使用相同的结构化格式：

```markdown
## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data needed to continue]

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

### 消息序列化

在概括之前，消息会通过 [`serializeConversation()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/utils.ts) 序列化为文本：

```
[User]: What they said
[Assistant thinking]: Internal reasoning
[Assistant]: Response text
[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
[Tool result]: Output from tool
```

这可以防止模型将其视为要继续的对话。

在序列化过程中，tool result 会被截断为 2000 个字符。超出该限制的内容会被替换为一个标记，指明截断了多少个字符。这使概括请求保持在合理的 token 预算内，因为 tool result（尤其是来自 `read` 和 `bash` 的）通常是 context 大小的最大贡献者。

## 通过 Extension 自定义概括

Extension 可以拦截并自定义 compaction 和 branch summarization 两者。事件类型定义请参见 [`extensions/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)。

### session_before_compact

在 auto-compaction 或 `/compact` 之前触发。可以取消或提供自定义摘要。请参见类型文件中的 `SessionBeforeCompactEvent` 和 `CompactionPreparation`。

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, reason, willRetry, signal } = event;

  // preparation.messagesToSummarize - messages to summarize
  // preparation.turnPrefixMessages - split turn prefix (if isSplitTurn)
  // preparation.previousSummary - previous compaction summary
  // preparation.fileOps - extracted file operations
  // preparation.tokensBefore - context tokens before compaction
  // preparation.firstKeptEntryId - where kept messages start
  // preparation.settings - effective settings after applying model overrides

  // branchEntries - all entries on current branch (for custom state)
  // reason - "manual" (/compact), "threshold", or "overflow"
  // willRetry - whether the aborted turn is retried after compaction (overflow recovery)
  // signal - AbortSignal (pass to LLM calls)

  // Cancel:
  return { cancel: true };

  // Custom summary:
  return {
    compaction: {
      summary: "Your summary...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      // usage: summaryResponse.usage, // Optional; included in session totals
      details: { /* custom data */ },
    }
  };
});
```

#### 将消息转换为文本

要使用你自己的 model 生成摘要，请使用 `serializeConversation` 将消息转换为文本：

```typescript
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

pi.on("session_before_compact", async (event, ctx) => {
  const { preparation } = event;
  
  // Convert AgentMessage[] to Message[], then serialize to text
  const conversationText = serializeConversation(
    convertToLlm(preparation.messagesToSummarize)
  );
  // Returns:
  // [User]: message text
  // [Assistant thinking]: thinking content
  // [Assistant]: response text
  // [Assistant tool calls]: read(path="..."); bash(command="...")
  // [Tool result]: output text

  // Now send to your model for summarization
  const { summary, usage } = await myModel.summarize(conversationText);
  
  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      usage,
    }
  };
});
```

关于使用不同 model 的完整示例，请参见 [custom-compaction.ts](../examples/extensions/custom-compaction.ts)。

### session_compact_failed

当手动或自动 compaction 失败或被中止时触发。这对于需要将 `session_before_compact` 尝试与终端结果配对的 telemetry extension 很有用。

```typescript
pi.on("session_compact_failed", async (event, ctx) => {
  const { reason, errorMessage, aborted, willRetry, fromExtension } = event;
  // reason - "manual" (/compact), "threshold", or "overflow"
  // errorMessage - present for non-abort failures
  // aborted - true for cancelled/aborted compactions
  // willRetry - whether the aborted turn would have retried after compaction
  // fromExtension - whether extension-provided compaction content was being used
});
```

### session_before_tree

在 `/tree` 导航之前触发。无论用户是否选择概括，都会始终触发。可以取消导航或提供自定义摘要。

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;

  // preparation.targetId - where we're navigating to
  // preparation.oldLeafId - current position (being abandoned)
  // preparation.commonAncestorId - shared ancestor
  // preparation.entriesToSummarize - entries that would be summarized
  // preparation.userWantsSummary - whether user chose to summarize

  // Cancel navigation entirely:
  return { cancel: true };

  // Provide custom summary (only used if userWantsSummary is true):
  if (preparation.userWantsSummary) {
    return {
      summary: {
        summary: "Your summary...",
        // usage: summaryResponse.usage, // Optional; included in session totals
        details: { /* custom data */ },
      }
    };
  }
});
```

请参见类型文件中的 `SessionBeforeTreeEvent` 和 `TreePreparation`。

## Settings

在 `~/.pi/agent/settings.json` 或 `<project-dir>/.pi/settings.json` 中配置 compaction：

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

| 设置 | 默认值 | 描述 |
|---------|---------|-------------|
| `enabled` | `true` | 启用 auto-compaction |
| `reserveTokens` | `16384` | 为 LLM 响应保留的 token |
| `keepRecentTokens` | `20000` | 保留的最近 token（不被概括） |

使用 `"enabled": false` 禁用 auto-compaction。你仍然可以使用 `/compact` 手动 compact。

### 按 model 覆盖

使用 `compaction.modelOverrides` 为不同的 model 调整 token 预算：

```json
{
  "compaction": {
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "modelOverrides": {
      "some-provider/big-model": {
        "reserveTokens": 400000
      }
    }
  }
}
```

对于具有 1M context window 的 model，此覆盖会在超过 600K token 时触发 compaction，并保留普通的 20000 个最近 token。其他 model 保留普通的 16384 token 预留。`reserveTokens` 还会影响概括输出限制，上限为 model 的最大输出 token；它不仅仅是触发阈值。

键是精确、区分大小写的 `provider/modelId` 值，包括 model ID 中的任何斜杠。每个 `reserveTokens` 和 `keepRecentTokens` 值都会独立地从 model 覆盖回退到普通设置，再回退到内置默认值。值必须是非负安全整数。匹配的 model 覆盖中的无效值在被读取时会产生错误；只有省略的字段才会回退到普通设置。Model 覆盖条目必须是对象。无效的普通 token 设置在被读取时会产生错误，即使活动 model 具有有效的覆盖。只有省略的普通值才使用内置默认值。`enabled` 保持全局，而不是按 model 特定。

这些解析后的值用于手动 compaction、所有自动阈值检查、overflow 恢复以及 extension 可见的 `preparation.settings`。Model 切换会影响后续的检查和 compaction，而不会更改普通设置。已经进行中的 compaction 使用为该操作捕获的 model 和 settings。Branch summarization 设置不受影响。

覆盖在全局和项目 settings 中都有效。这些文件在查找前会递归合并，因此全局的 model 特定值优先于项目范围的回退值；项目必须覆盖该 model 条目才能更改它。详情请参见 [settings.md](settings.md#per-model-compaction-overrides)。
