# 有界输出发布

**Status：** 共享的自适应发布器及其 `ExecutionEnv` 用法已经实现。通用的 `ToolOutput` 集成仍属于设计工作。

依赖已落地的 Chord delta tracking、source 有界的执行输出，以及用于持久化 batches 的 scoped storage。

## 1. invariant

> 持久化记录、模型所看到的内容，以及 UI 所显示的内容，都是同一个有界视图。

一个 spill 文件不是第二个视图。它是执行环境内部的一个文件，模型通过普通的文件工具到达它。

每一个不受控的 producer 边界都需要两个独立的界限：

- **state size：** 最新保留的文本受上限约束；
- **publication：** encoded bytes 与 event count 都被限速。

Delta 编码是补充性的。它压缩一次已发布的变更；它不约束 state，也不决定发布何时发生。

## 2. 边界

```text
远程进程
  -> 可选的 ExecutionEnv 发布器
  -> worker ToolOutput 发布器
  -> events + durability + replication
```

只有在真正有成本的边界之前才需要一个发布器实例：

- 物理上远程的执行环境在传输之前限制输出；
- `ToolOutput` 限制自定义工具以及下游的 event/storage 流量；
- 一个 colocated 环境可以在进程内馈入它的有界 updates，而无需另一个序列化的传输；
- 自定义工具绕过 `ExecutionEnv`，但无法绕过 `ToolOutput`。

控制算法是共享的。Payload 词汇表不同：Shell 使用 replace/append/slide/metadata；`ToolOutput` 使用 Chord operations。

## 3. 为什么仅有大小或节奏是不够的

一个固定的 50 KB snapshot 在单个 event 上是安全的，但随时间推移就不安全了。在 100 ms 下，它允许每秒十次完整 snapshots，约 500 KB/s 加上 envelopes。

仅有一个字节预算也会允许过多微小的事件和持久化事务。最小间隔约束数量；encoded-size 债务约束带宽。

最初的 handoff 错误地把 `intervalMs = 100` 当作 100 emits/s。它是十 emits/s。固定的间隔仍然是非自适应的：它延迟了小的涓流，同时以相同的频率允许完整的窗口。

## 4. 已落地的自适应算法

`packages/agent/src/harness/utils/adaptive-publisher.ts` 实现了：

```ts
nextDelayMs = max(globalMinEmitInterval, encodedUpdateBytes * 1000 / globalTargetBytesPerSecond);
```

当前的 harness 全局策略：

```ts
minEmitInterval = 100 ms;
targetBytesPerSecond = 100 KB/s;
```

行为：

1. 空闲之后第一个 dirty 状态立即发布。
2. 在下一个截止时间之前的写入会折叠进最新状态。
3. 一个 trailing 定时器在截止时间之后发布被持有的状态。
4. 完成以及正确性边界会强制进行一次有界发布。
5. 发布器在投递给 consumer 之前提交自己的 baseline，防止在 consumer 应用之后抛出时出现重复 deltas。

这是一个带有上限大小突发的摊销 token bucket。一个 leading 或强制的 terminal update 可能在短间隔内超过目标，但持续的 encoded bytes 会收敛到目标，并且除了显式的强制正确性写入之外，持续的 event count 不能超过最小间隔的下限。

## 5. 场景追踪

假设上限为 50 KB，目标为 100 KB/s，下限为 100 ms。

### 低于上限，完成

初始状态立即发布。小的 appends 的发布速度不会快于下限，最终 dirty 状态被强制发布。总 encoded 文本大约等于产生的文本。

### 低于上限，涓流

相隔超过 100 ms 到达的写入会立即发布，因为前一个截止时间已经过去。更快的写入会折叠为每个下限间隔一次 append。

### 高于上限，全速

保留状态永远不会超过 50 KB。完整的窗口 turnovers 会编码为有界替换。一次大约 50 KB 的 update 换来约 500 ms 的静默，从而无论原始 producer 吞吐量如何，都产生每秒约两次 updates 和 100 KB。

对于 shell 执行，完整的 stream 在 backpressure 下进入源本地溢写，而不是走 output-update 通道。

### 高于上限，涓流

一次小的 tail 移动会编码为 truncate 加 append（Chord）或 `slide`（Shell）。它的 encoded size 很小，所以 100 ms 下限占主导，输出保持响应。为每一个微小的 slide 重发一个完整的 50 KB snapshot 会既更慢又更大。

### 突发然后静默

leading 状态是立即的。被持有的写入会折叠，一个 trailing 定时器发布最新的残余。没有轮询定时器。

### 巨大的单次写入

producer 可能已经分配了它的输入，但边界只保留并发布配置的上限。Shell 溢写保留完整的 source stream。任意的自定义工具 images 和结构化 details 仍然需要单独的限制。

## 6. 强制写入

以下这些会绕过限速一次，同时仍受 state-size 约束：

- 命令/工具完成；
- 错误或中止；
- 一个 memo 与 output checkpoint 原子地提交；
- 一次显式的 recovery base/rebase。

一次 terminal flush 会在 `tool_end` 之前取消 trailing 定时器，防止对一个已 settle 的 invocation 出现迟到的 update。

## 7. `ToolOutput` 的应用

sink 将为每个 invocation 拥有一个 Chord tracker 和 encoder。当发布被阻塞时，mutations 保持在本地；flush 时的 dirty tracking 意味着被持有的写入会折叠，而不会为每次写入保留一个 op。

一次 sink flush 同时馈入 live event 和当前模型可见状态。持久化 batches 使用同一个逻辑 flush，编码为 per-stream 的 `WireOp[]`。周期性的 `rebase()` 约束 recovery 重放；一次 memo 正确性 flush 会与 memo 在同一事务中写入一个打标签的 base batch。

持久化节奏属于 sink，而不属于 Shell 或 bash。Bash 现有的两秒 checkpoint 请求只作为过渡期的兼容机制保留，直到 sink 迁移完成为止。

## 8. 剩余决策

- 对 images 的显式字节/数量拒绝策略。
- 结构化 details 的界限；任意 JSON 无法被有意义地 tail 窗口化。
- 普通的持久化写入最初是搭载每一次 live sink 发布，还是使用更慢的、经过测量的节奏。Memo 与 terminal 的正确性 flush 不是可选的。
- 在对真实的远程传输和存储进行 profiling 之后确定精确的全局生产值。
