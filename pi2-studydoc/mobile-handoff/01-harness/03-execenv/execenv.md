# ExecutionEnv：有界 shell 输出

**Status：** 已在生产源码中实现。本文档旁边的原型文件是历史证据；生产代码位于：

- `packages/agent/src/harness/utils/adaptive-publisher.ts`
- `packages/agent/src/harness/utils/output-capture.ts`
- `packages/agent/src/harness/env/nodejs.ts`
- `packages/agent/src/harness/tools/bash.ts`

同一发布器在通用 `ToolOutput` 中的用法仍保留在 `04-tool-output`。

## 1. 问题

旧的 `Shell.exec()` 在 `NodeExecutionEnv` 内部累积完整字符串：

```ts
stdout += chunk;
stderr += chunk;
```

Bash 只有在这些字符串已经构建完成之后才截断。因此 `cat 1gb.txt` 在任何工具级别的限制能够发挥作用之前，就已经在 worker 中实体化了一个 gigabyte。

溢写也应当发生在字节产生的地方。如果执行是远程的，那么 worker 上的溢写文件对模型的 `read` 和 `grep` 工具而言是不可访问的，而如果在传输之后再创建它，就会先把完整的 gigabyte 通过连接发送过去。

## 2. 边界

`ExecutionEnv` 现在负责：

- 一个有界的 head 或 tail 视图；
- 完整的字节与行总计；
- 在视图首次越过其限制之后进行的惰性源本地溢写；
- 带有有界写流 backpressure 的持久化源本地溢写；
- 对最新有界状态的自适应发布；
- 在 settlement 之前的一次强制最终发布。

它不再返回或保留分开的 `stdout` 与 `stderr` 值。两个管道汇入同一个按到达顺序排列的、模型可见的文本视图，与 bash 和 `ToolOutput` 保持一致；要在 tail 淘汰过程中保留流样式，就需要一种分段保留状态，而 Harness 并不暴露这种状态。文本由 updates 折叠而来，`ShellExecResult` 只包含 exit 与 truncation/spill 元数据。

Bash 只负责命令语义及其模型可见的页脚。它旧的滚动缓冲区、溢写创建、100 ms 节流以及完整输出累积都已移除。现有的两秒持久化 checkpoint 请求暂时保留，直到 `ToolOutput` 接管持久化节奏为止。

## 3. 契约

```ts
interface ShellOutputLimits {
  maxBytes: number;
  maxLines: number;
  retain?: "head" | "tail";
}

interface ShellOutputCaptureOptions {
  limits: ShellOutputLimits;
  spill?: boolean;
}

type ShellOutputTruncation = Omit<TruncationResult, "content">;

interface ShellOutputMetadata {
  truncation: ShellOutputTruncation;
  spillPath?: string;
  lastLineBytes?: number;
}

interface ShellOutputView extends ShellOutputMetadata {
  text: string;
}

type ShellOutputUpdate =
  | { kind: "replace"; output: ShellOutputView }
  | { kind: "append"; text: string; metadata: ShellOutputMetadata }
  | { kind: "slide"; drop: number; text: string; metadata: ShellOutputMetadata }
  | { kind: "metadata"; metadata: ShellOutputMetadata };

interface ShellExecResult extends ShellOutputMetadata {
  exitCode: number;
}
```

`drop` 计数的是 JavaScript 字符串 code units，与 `slice()` 一致。Updates 是有序的。消费者用 `applyShellOutputUpdate()` 来应用它们。

一次完整替换会建立初始状态，或者在没有经过验证的重叠时进行恢复。一次 append 只携带不断增长的 suffix。一次 slide 丢弃一个 prefix 并追加新的 suffix。Metadata updates 移动总计值或 spill 路径，而不重发文本。

兼容性的 `executeShellWithCapture()` 辅助函数仍然返回一个有界的最终视图。它的 `onChunk` 回调只接收 initial、append 和 slide 文本；metadata 以及 turnover 之后的替换不会被误标为新字节。

## 4. 自适应发布

`AdaptivePublisher` 只保留最新的 dirty 状态。中间的进程写入永远不会变成输出 updates 的队列。

策略是 harness 全局的，而不是每个工具各自的：

```ts
minIntervalMs = 100;
targetBytesPerSecond = 100 * 1024;
nextDelayMs = max(minIntervalMs, encodedUpdateBytes * 1000 / targetBytesPerSecond);
```

空闲之后第一个 dirty 状态会立即发布。在截止时间之前收到的写入会折叠进最新的有界状态。一个 trailing 定时器保证最终一定会发布。Finalization 会绕过截止时间一次，但仍受保留上限的约束。

发布器在调用消费者之前先提交自己的 baseline。如果某个消费者应用了一次 update 之后抛出异常，finalization 就无法把同一个 delta 发出两次。该命令会以 `callback_error` 失败。

### 工作负载行为

| workload | result |
| --- | --- |
| 在上限以下完成 | 立即的初始状态、小的 appends、强制的最终状态 |
| 低于上限的涓流 | 孤立的写入立即发布；持续的写入之间至多相隔 100 ms |
| 达到上限后的全速输出 | 完整的 turnovers 是按 encoded size 间隔的、上限大小的替换 |
| 达到上限后的涓流 | 小的经过验证的 `slide` updates 保持响应；完整的窗口不会被重发 |
| 突发然后静默 | 一个 leading update 和一个 trailing update |
| 错误、超时或中止 | 在错误 settle 之前强制发布最新的有界状态 |

在上限为 50 KB、目标为 100 KB/s 时，重复的完整 turnovers 会稳定在每秒约两次 updates 附近。达到上限之后的小 slides 仍然使用 100 ms 的下限。

速率限制是摊销的。空闲后立即发生的 update 以及强制的 terminal update 各自都可能造成一次受上限约束的突发。

## 5. 捕获与溢写

当 `OutputCapture` 解码后的、感知行的（line-aware）工作缓冲区超过字节上限的四倍时，它会将其裁剪回字节上限的两倍。Tail 模式丢弃旧文本；head 模式保留原始 prefix。这样就把 UTF-8 裁剪摊销了，而不是对每个进程 chunk 都重新扫描保留窗口。

溢写的创建是惰性的。在越过之前，source 最多保留创建完整归档所需的有界 prefix。在越过的时刻，它会：

1. 在执行环境内部创建文件期间暂停 stdout 和 stderr；
2. 打开一个持久的 append stream，具有有界的 8 MB high-water mark；
3. 按到达顺序写入保留的原始 prefix 以及后续的原始 chunks；
4. 在 writer 接受数据期间立即恢复；
5. 只有当 `write()` 报告 backpressure 时才再次暂停，然后在 `drain` 时恢复。

这既避免了无界的 promise 链，也避免了每个进程 chunk 都要进行一次异步的 file-open/append 循环。溢写创建或 stream 写入失败会杀掉子进程并使执行失败，而不是发布有损的成功结果。

溢写路径在可用时会被作为 metadata 强制发布。在最终输出 flush 之前会 await 溢写写入。

Node streams 保持 raw，以获得溢写吞吐量和精确的归档字节。`OutputCapture` 使用一个流式 `TextDecoder`，因此读取边界不会拆开一个 code point；无效的显示控制字符只会从有界 snapshots 中移除，而不是通过扫描完整的 raw stream 来移除。行总计会计入最后一行没有终止符的行，并且即使某一行超过了工作缓冲区，`lastLineBytes` 仍然保持精确。

## 6. 远程执行

当 worker 与执行环境位于同一位置（colocated）时，updates 是进程内的，而这个发布器主要约束的是捕获工作。`ToolOutput` 仍然是下游的 event/durability 限制器。

当执行环境与其 worker 在物理上分离时，同样的有界 updates 会跨越那个传输层。全速输出无法传输完整的 stream：中间写入会在 source 处折叠，而完整的 stream 保留在源本地溢写中。

每个真正有成本的边界都有自己的发布器实例。colocated 部署可以绕过传输序列化；绕过 `ExecutionEnv` 的自定义工具仍然会经过未来的 `ToolOutput` 发布器。

## 7. 剩余工作

- 把通用的自定义工具组合、文本保留、event 发布以及持久化节奏移入 `ToolOutput`。
- 在那个下游边界用 Chord operations 替换整块的 `AgentToolResult` progress。
- 让 memo 与 output checkpoint 的持久化成为一次原子事务。
- 从持久化输出中播种（seed）replay，而不是删除它。
- 把溢写放进一个由环境拥有的 session 目录，并在 session 生命周期加上一个崩溃保留下限之后清扫它们。
- 为 images 和结构化 details 决定明确的限制；文本是有界的，那些值目前还不是。
- 定义原始二进制输出的行为。当前的 shell 输出仍然是有损的 UTF-8 文本。
