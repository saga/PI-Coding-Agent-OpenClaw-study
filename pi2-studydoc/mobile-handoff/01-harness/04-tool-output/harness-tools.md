# 工具输出与 Progress

> **Scope：** harness-local。这里没有任何内容依赖 facet 系统、RPC 或任何
> 呈现层。依赖 [delta tracking](../01-delta/delta.md)（已落地的 Chord op 词汇表与 tracker）、[execution environments](../03-execenv/execenv.md)（截断发生的地方），以及 [scoped storage](../02-scopes/scopes.md)（durability）。

## 1. 问题

三个故障，一个成因。

**每个工具各自实现自己的截断。** `bash.ts` 拥有一个滚动缓冲区、
`truncateTail`、一个 spill 文件、一个 update 节流和一个 checkpoint 间隔。
`read.ts` 有它自己的截断。未来每一个产生大量输出的工具都会
以不同方式重新实现这些。

**Progress 是一个整值。** `onUpdate(partialResult)` 在每次 update 时都交出一个完整的
`AgentToolResult`，`tool_update` 携带那整个结果，而
`openToolProgress` 用 `setValue` 持久化它。

**人们曾认为 `details: unknown` 迫使如此** —— 你无法向一个你
不知道其形状的值追加内容。那个前提现在是错的。一个结构性的 tracker
（`delta.md`）在不知道类型的情况下针对 JSON 记录 ops，因此 details
完全不需要特殊处理。

## 2. `ToolOutput`

harness 为每个 invocation 构造一个 sink 并把它传给 `execute`。**工具
不返回任何东西**；sink 持有结果。

```ts
interface ToolOutput<TDetails extends JsonValue> {
  /** Append to the text block. */
  write(text: string): void;
  /** Append an image block. Images are never windowed. */
  image(image: ImageContent): void;
  /** Replace the retained text wholesale. Chord still recovers a verified `t` + `a` slide when possible. */
  replace(text: string): void;
  /** Apply source-owned truncation totals and spill metadata without resending text. */
  capture(metadata: ShellOutputMetadata): void;

  /** The tool's own details object. Mutate it directly. */
  readonly details: TDetails;

  /** Accumulates. A subagent making several model calls adds to it. */
  usage(usage: Usage): void;
  /** Replaces. */
  addTools(names: string[]): void;
  /** Replaces — a tool that decides to terminate and then recovers can say so. */
  terminate(value: boolean): void;
}
```

```ts
execute(
  toolCallId: string,
  params: Static<TParameters>,
  signal: AbortSignal,
  out: ToolOutput<TDetails>,
  context: Context,
): Promise<void>;
```

`execute` 返回 `void`。工具产生的一切都流经 sink ——
包括 `usage` 和 `addTools`，它们不能作为 settle 时的返回值，
因为一个被重放的工具必须能够从持久化状态播种（§7.4）。

**失败就是一个抛出的错误。** 当 `execute` reject 时，`isError` 由 harness 设置。
工具可以抛出任何东西，包括来自它并未编写的库的错误。

**`terminate` 与执行如何结束是正交的**，因此一个失败的工具可以请求
循环停止：

```ts
try { await thing(); } catch (error) { out.terminate(true); throw error; }
```

这填补了当前实现中的一个缺口：在那里 `executeToolCall` 的 catch
硬编码 `isError: true` 而不带 terminate，而 `immediateError` 的 terminate
参数只会被 `applyBeforeToolDecision` 为一次 hook
block 传入 `true`。

### 2.1 Details 只是一个对象

```ts
async execute(id, params, signal, out, context) {
  out.details.total = 42;
  out.details.passed += 1;
  out.details.failures.push({ name, message });
  out.details.current = undefined;          // -> delete
}
```

完全细粒度的 ops 会自然产生，已针对原型验证：

```jsonc
["#",0,["details","passed"]]
["s",0,1]
["p",["details","failures"],0,0,[{…}]]
["d",["details","current"]]
```

没有 recipes，没有 mutation map，`tool_start` 上没有 `initialDetails`，没有 Immer，并且
没有任何 consumer 会运行工具代码。`TDetails` 仍然是工具自己导出的类型，
以便 renderer 可以把 `call.details` 转型为它 —— 这就是它的全部用途。

对 `packages/agent/src/harness/tools/` 的一次调查发现，**今天没有任何工具会
增量地 mutation details**；只有 `bash.ts` 在流中途写入它们，而且它是整体重建它们，
因为那个容器本来就会被整体替换。这个设计移除了那个成因，并且如果没有人采用它，
也不会付出任何代价。

**Caveat：** details 现在是无界的。一个在循环中向 `failures` 推送的工具
会无限增长，而且与文本不同，它没有上限。已发布的东西里没有这么做的；
这扇门被打开了，而在 details 还只是一个只能替换的值时，它并不是这样。

### 2.2 部分输出在失败后仍然保留

今天 `executeToolCall` 会捕获并返回 `createErrorToolResult(message)`，
仅从错误字符串构建一个全新的结果 —— 一个流式输出了 8 KB
然后抛出的工具只会报告那个错误。

有了 sink 之后，已经写入的内容本身就是结果。harness 会把
错误文本作为 content 追加，并保留其余部分。错误文本是模型可见的
content，而不是呈现层：模型需要读取这次调用为什么失败。

`abortedMessage` 和 `interruptedMessage` 应当与此保持一致；
今天它们通过 `syntheticMessage` 构建替换结果，所以一个被取消的
长时间运行的命令也会丢失它的部分输出。

## 3. Content

Content 恰好是**一个 text block，后跟零个或多个 image blocks**。一个
工具不能在 images 之间穿插文本 —— 在某个 image 之前和之后写入的文本
会落在同一个 block 中。这是有意为之的：截断只会触及字符串，
而一个 image 永远不会是部分的任何东西。

Images **永远不会被窗口化**。对 base64 payloads 施加字节或行上限是
没有意义的，而 `truncateTail` 作用于文本。`maxBytes` / `maxLines` 只
管文本。

### 3.1 保留模式

在工具定义上声明：

```ts
output?: {
  retain?: "head" | "tail";   // default "tail"
  maxBytes?: number;
  maxLines?: number;
}
```

**`head`** —— 一直 append 到上限，然后停止。永远不会移除任何东西。适用于
从一开始就有意义的输出：文件读取、列表、grep。

**`tail`** —— 一个滚动窗口。适用于任何有趣部分在
末尾的东西：build、test run。

Head+tail **不**提供。`truncate.ts` 导出 `truncateHead` 和
`truncateTail`；两者都不会组合它们，也不会添加任何组合。

### 3.2 工具不截断 —— exec env 才截断

对于源自执行环境的输出，设上限、合并和
溢写都发生在 **source 处**。参见 [`execenv.md`](../03-execenv/execenv.md)。工具把它的
`ShellOutputLimits` 传入 `env.exec`，并把产生的 updates 管道输入 sink。

这不是一个便利性措施。在 sandbox host 上读取一个 1 GB 文件时，绝不能把
1 GB 发送到 agent 机器在那里设上限，而 spill 文件必须落在
模型自己的 `read` 和 `grep` 运行的地方。

对于源自 agent 机器的输出（subagents、进程内工作），
`ToolOutput` 在本地应用同样的逻辑。相同的代码，不同的位置。

注意，这推翻了早先的一个决定：sink 中没有 spill，而
temp-file 路径是工具特有的。exec-env 的论点 —— 跨机器边界的模型可达性 ——
才是改变它的原因。

## 4. 工具输出状态

`tool_update` 携带 `Op[]`（`delta.md` §6），目标是该 invocation 的
`ToolOutputState`：

```ts
interface ToolOutputState {
  content: (TextContent | ImageContent)[];
  details: JsonValue;
  usage?: Usage;
  addedTools?: string[];
  terminate: boolean;
  truncation: ShellOutputTruncation;   // totals over everything ever written, without duplicate text
}
```

使用 ops 而不是带类型的 variant union，有一个决定性的理由：**只有 ops 能在
harness 不知道 `TDetails` 的情况下赋予 details 细粒度**。带类型的 union 会
需要 per-tool recipes，而 §2.1 删除的正是这套机制。

文本仍然得到 delta 处理，因为 sink 在 mutation *之前* 应用上限，
所以一个滚动窗口会在 `content[0].text` 上产生 `truncate` + `append`，
而不是一次整值 set。

在每一种 workload 上，interned ops 也都测量出**比带类型的 frame 词汇表更小**，
在 details 上则小 10 倍，因为一个 frame 会重复 `toolCallId`，而
一个 interned op 只携带一个整数。参见 `delta.md` §4.1。

没有 `drop` event。sink 知道它淘汰了什么，并把它表达为
`truncate`；consumer 不需要单独的 signal，也不推导任何东西。

## 5. Harness events

```ts
| { type: "tool_start";
    runId; turnId; toolCallId; toolName;
    args: unknown }

| { type: "tool_update";
    runId; turnId; toolCallId;
    ops: Op[] }                       // a base batch begins with `r`

| { type: "tool_end";
    runId; turnId; toolCallId;
    isError: boolean }
```

**`tool_start` 只携带 identity。** 早先的一个草稿添加了 `caps` 和
`initial`；两者都是冗余的，已经移除。第一批总是一个 base batch
（`delta.md` §6），所以初始状态通过 update 通道到达 —— 把它携带两次
意味着有两种建立 base 的方式，而它们可能不一致。而且 `caps` 已经
在状态内部：`ToolOutputState.truncation` 携带 `maxBytes` 和
`maxLines`，这正是 renderer 用来表达 "50 KB 限制" 所需的东西。那份草稿本身
也承认 consumer "不再必须" 以相同方式 fold，因为 producer 的 ops
编码了淘汰 —— 那是 `caps` 需要传输的最后一个理由，而它并不成立。

`tool_update` 携带 ops。一个 base batch 与一个 delta 走同一个通道，
因为一次替换本身就是一个 op（`delta.md` §2）—— 没有第二种形状。`message_update` 具有相同的形状
（`message-update.md` §5.1）；consumer 用同一条代码路径 fold 工具输出和 assistant 输出。

**`tool_end` 不携带 content，不携带 details，不携带 usage，不携带 terminate。** 每一个字节
都已经发出去了。在没有任何新事情发生的时刻重发，会复制每一个 base64 image。

> **fold 就是结果。** consumer 已经 fold 过的任何东西都不会被重发来
> 确认它。

这消解了早先一个关于 settle 时截断与运行中的 fold 不一致的开放问题。
没有单独的 settle 时截断：sink 的窗口*就是*截断。一个工具想在末尾添加的任何东西 —— bash 的
`[Showing lines 8000-8123 of 8123]` 页脚 —— 就是 `out.write(footer)`，多一次
append。

harness 仍然在进程内为模型组装 `AgentToolResult`，而
`createToolResultMessage` 仍然把已 settle 的 `ToolResultMessage` 写入
transcript，带有 `content`、`details`、`usage`、`addedToolNames`、`isError`。
两者都不是 wire event。

## 6. Lane reduction

```ts
export function reduceLaneSnapshot(view: LaneView, event: HarnessEvent): void;
```

在普通对象上进行 plain mutation。没有 `Draft`，没有 `produce`，没有 Immer，并且**没有
`Rebase` 返回值** —— 一个无法应用某个 event 的 fold 会不动状态，
而 host 会发送一个 `replace`。（早先的一个草稿是 `void | Rebase`；在
Immer 下那会抛出，而没有 Immer 就没有东西可以返回。注意
`reducer.ts:4` 当前定义了 `LaneSnapshotReduction = LaneSnapshot | { rebase: true }`，
所以这是对现有代码的一次真实修改，而 `navigation_end` 就是驱动它的 event。）

event 是除视图之外唯一的输入。没有 registry，没有 `resolve`，没有工具
代码 —— 所以一个在崩溃与恢复之间被重写的工具无法让一个持久化的
stream 变得不可读。

当 harness 被一个 facet 包裹时，同样的 mutation 在来自 `delta.md` 的 tracker
之下运行，ops 就会自然产生。harness 本身并不知道这一点。

## 7. Durability

### 7.1 今天存在的东西

`pendingToolOutput(operationId, invocationId)` 是一个
`value<AgentToolResult<unknown>>`，并且 —— 重要的是 —— `progress.write(partial)`
**只**在 `options?.checkpoint === true` 时触发（`drive/tools.ts:325`）。不是
每次 update 都触发。bash 每 2 s 用一个 `JSON.stringify` dedupe 做一次 checkpoint；其他
每一个工具都完全不做 checkpoint。

它也**不是一个 progress 缓冲区**。它是中断 checkpoint。在
resume 时，如果该工具不是 replay-safe，`readCheckpoint` 会把它转成给模型的真实
`ToolResultMessage`：`[...checkpoint.content, INTERRUPTION_MARKER]`
加上 `details` 和 `usage`。

注意那个误导了早先一个草稿的推论：因为 checkpoint 必须
*就是*当前状态，它被解读为需要 `value` 语义。它并不需要。它
需要是*可推导的*，而从最后一个 base batch 开始 fold encoded batches 就能推导出它 —— 这正是给 base batches 打标签的意义（§7.3）。`checkpoint: true`
请求的是一次持久化写入，而不是一次替换。

`pendingAssistantFrames` 是一个 `list<AssistantMessageFrame>`，每帧追加一次，
settle 时在 `response.ts:345`、`deferred.ts:157`、`terminal.ts:47` 中 `deleteList`。

注意 `operationCleanupWrites`（`terminal.ts:26`）会做四次 `scanValues` 调用来
枚举 settle 时要删除的内容。在 scopes 之下，覆盖
`operationToolMemoPrefix` 和 `pendingToolOutputPrefix` 的那两次会被一个单一的
`retireScope(operationId)` 取代。

### 7.2 重命名

`pendingAssistantFrames` → **`pendingAssistantOutput`**，与
`pendingToolOutput` 匹配。Frames 不再是持久化单元；两个地址现在都持有
以 ops 或 snapshots 写入的 tracked 状态。

### 7.3 写什么，以及何时写

两个地址都是 **ephemeral-scoped**（[scopes.md](../02-scopes/scopes.md)），因此它们存在于一个
在 settle 时退役的 sidecar 中，而不是永远在主日志中。

两个独立的收益，按重要性排序：

- **Encoding。** 用 ops 代替整值，加上地址 interning：在单个文件中从 93.89 MB 到
  5.32 MB，原子性不变。先做这个。
- **Scopes。** 待处理状态完全离开主日志：存活量从 5.32 MB 到 0.06 MB。

**两者都是 `list<WireOp[]>`**，而不是值。sink 为每个持久化 value stream 拥有一个带状态的 Chord encoder/decoder 对。每次 flush 追加一个 encoded batch，而一个第一个 op 为 `r` 的逻辑 batch 会在存储记录上打上 `"base"` 标签。
Recovery 用 `stopAtTag: "base"` 向后读取并向前应用
（[delta.md §9](../01-delta/delta.md#9-durable-form)、[scopes.md §11](../02-scopes/scopes.md#11-list-tags-and-stop-conditions)）。

写入一次 flush：

```ts
const ops = out.flush();
if (ops.length === 0) return;
const wire = enc.encode(ops);
writes: [appendList(address, wire, isBase(ops) ? "base" : undefined)];
```

`isBase` 来自 Chord。它检查根替换 op `r`；普通的嵌套 set 使用 `s`。分类逻辑与词汇表放在一起，因此这个比较只写一次。

已落地的 tracker 无条件地发出结构性 ops。没有 serialized-size 比较，也没有自适应替换启发式。producer 用 `rebase()` 显式请求一个 base batch；输出 sink 的上限约束那次替换，而周期性的 rebasing 约束 recovery 工作。生产环境的重新测量否决了一个文本专用的 append/truncate API：通用路径在本地测得每次 50 KB 滚动窗口 flush 耗时 2.43–2.46 µs，低于周边的成本。保留普通的 tracked 字符串 mutation；参见[决策记录](../01-delta/append-decision.md)。

**Checkpointing 没有被删除。** `BASH_CHECKPOINT_INTERVAL_MS` 只作为过渡期的兼容机制保留。通用 sink 拥有持久化频率，因为 Shell 无法为一次存储写入定价，也无法强制 memo/output 的原子性。强制的 memo、terminal 和 recovery-base 写入绕过普通的限速，同时仍受上限约束。

### 7.4 Replay 必须播种，而不是丢弃

`clearReplayCheckpoint` 当前在重新执行一个 replay-safe 工具之前写入
`deleteValue(pendingToolOutput(...))`（`drive/tools.ts:257`）。**这是一个 bug。**

Replay-safe 意味着该工具会被重新执行，但 memos 的存在恰恰是为了让它
*不*重做它已经做过的工作 —— 而被跳过的工作不会发出任何东西。今天，任何针对
已 memo 工作的输出都会丢失。

修复方法：从持久化状态播种一个新的 `ToolOutput`，然后重新执行。该
工具向一个已经持有它在崩溃之前所产生内容的 sink 追加。

这也是为什么任何东西都不能是 settle-only 的。`usage` 和 `addTools` 必须能在
一次播种后存活，因此它们像其他一切一样流经 sink。

### 7.5 memo invariant

> 一个工具的 memo 写入与其 output checkpoint 必须在同一个
> 事务中提交。

否则，一个工具做了工作、设置了一个 memo、在下一个 checkpoint 之前崩溃，然后
在 replay 时跳过该工作，而播种的输出没有它的记录。

**今天这并不成立。** `setMemo`（`drive/tools.ts:112`）和 `openProgress`
（`runtime/progress.ts:44`）是两次分开的 `lane.command` 调用，因此是两个
事务。让它成立意味着把 checkpoint 捆绑进 memo 的 commit：

```ts
setMemo(name, value) {
  validateMemoName(name);
  if (!active) return Promise.reject(ended());
  return lane.command<void>((state) => {
    if (!ownsEffect(state)) return { kind: "reject", error: ended() };
    const memo = operationToolMemo(drive.operationId, call.resultEntryId, name);
    return {
      kind: "commit",
      writes: [
        value === undefined ? deleteValue(memo) : setValue(memo, value),
        setValue(pendingToolOutput(drive.operationId, call.resultEntryId), out.snapshot()),
      ],
      next: state,
      materialize: () => undefined,
    };
  }, drive.context);
}
```

两个地址都是 **ephemeral-scoped**，所以这是一次单文件事务，并且在静态上
被强制为一次（[scopes.md §3 和 §6](../02-scopes/scopes.md)）。`operationToolMemo` 被
放在那个 scope 中正是为了这个。在 Session 线上排序是不够的 ——
两次文件写入不是原子的。周期性的 checkpoint 保持原样 —— best-effort，用于
中断路径；而在正确性要求的地方，这里强制进行一次。

该 invariant 成立，是因为工具做 X、把 X 的输出写入 sink，*然后*
调用 `setMemo("did X")` —— 所以 sink 在 commit 时的状态已经包含 X 的
输出。

**仅有排序是不行的**，以防它看起来很诱人：

- memo 在前，checkpoint 在后 → 两者之间崩溃 → replay 跳过 X，而播种的
  输出缺少它 → 静默丢失；
- checkpoint 在前，memo 在后 → 两者之间崩溃 → replay 重做 X 并再次
  追加 → 重复输出。

重复是没那么糟糕的失败，所以有序写入是一个可容忍的兜底，
但两者都不正确。

**代价：** `setMemo` 现在写入一个完整的、受上限约束的 output state，而不是一个小的
值。Memos 很少见 —— 每次 invocation 只有少数几个 —— 所以这受
`memo count x cap` 约束，而不是受输出量约束。

### 7.6 `openProgress` 有一个写入排序竞争

`commitWrite(item)` 在调用 `write()` 时捕获 `item`，而该写入是
fire-and-forget，只跟踪 `latest`。因此，一个在 T1 捕获的 checkpoint 可能
在 T2 的一个 memo-bundled checkpoint *之后* commit，用更旧的状态覆盖更新的
状态 —— 恰好重新引入 §7.5 所防止的丢失。

修复：在 command planner 内部解析 sink 的状态，而不是在调用时。

```ts
commitWrite: () => setValue(address, out.snapshot())   // evaluated under the Session line
```

`lane.command` 在 Session 线上串行化，所以 checkpoint 写入在构造上变得
单调。这从总体上消除了这个竞争，而不只是针对 memos。

### 7.7 持久化路径上没有任何东西运行工具代码

Ops 由一个没有领域知识的六-verb applier 解释，所以一个在崩溃与恢复之间
被重写的工具无法让一个持久化的 stream 变得不可读。

> **持久化路径只使用 harness 拥有的 reducers。**

这也排除了持久化 *facet* ops。harness 没有 facet 状态，
facets 来去无常，而一个正在恢复的 harness 必须在没有 facet 存在的情况下
重建它的工作值。

## 8. 开放问题

- **tracker 的 property tests**（`delta.md` §3.3）。这里的一切都建立在
  producer 与 replica 一致之上；目前没有任何东西证明它们一致。
- Coalescing 窗口：按 tick，还是按字节/时间阈值。
- image 数量是否需要界限。Images 不被窗口化，所以一个在循环中推送
  它们的工具会无限制地增长 `content`。目前被视为工具 bug。
- details 是否出于同样的原因需要界限（§2.1）。
- `retain: "head"` 在达到上限之后是否应继续发出仅计数器的 updates，
  以便 renderer 可以报告有多少被抑制了。[`execenv.md`](../03-execenv/execenv.md) 为
  exec 来源的输出回答了这一点；agent 侧的输出需要同样的答案。
- 一个失败的工具*是否应该*能够 terminate，还是当前
  的不能是刻意为之 —— 有一个合理的论点认为模型应当
  接收错误并自行决定。
- **Derived values。** 从累积的 JSON 解析出的 `arguments` 不应被
  replicated；按需推导它。这是安全的，因为 `parseStreamingJson` 是 total 的 ——
  四个 fallback，最终落到 `{}`，它不可能抛出 —— 所以 replica 的推导没有
  error 路径，也没有 agreement protocol。推广为：replicated state 中不放
  任何 derived 字段。
