# WP04 — Mutation 发布与 event 投递

## 状态

已完成。Phase A 与最终实现复审均通过 Fable，没有 findings。Focused agent/server/SQLite tests、`npm run build`、`npm run check` 以及 `./test.sh` 均通过。`packages/agent/docs/harness.md` 保持规范性。

> 历史说明：WP06 后来用一个 Session line 上的原子 `AgentHarness.lane()` 获取，取代了这份已完成 handoff 中描述的 lane-creation API 与 keyed line。event-publication 保证仍然是当前的。

WP02 建立了原子性验收、接收者绑定与连贯的 lane watches。WP03 移除了 drive deadlines。WP04 移除由调用方操作的 event-delivery gate，而不削弱那些保证，并让历史性的 `Session.createLane()` 端到端地拥有 lane creation。direct durable-drive package 作为 WP05 紧随其后。

## 问题

一个 committing lane job 当前使用两段式的 event API：

```text
inside Session.mutate:
  commit
  publish process-local state
  delivery = events.enqueue(batch, context)

outside Session.mutate:
  await delivery.start()
```

这种拆分保留了正确的边界，但它是一个 footgun：过早调用 `emit()`、过早调用 `start()`，或者漏掉 `start()`，都可能违反观察语义或阻塞全局 event tail。历史性的 `Harness.createLane()` 手动重复这套编排。

Lane creation 还有第二个一次性边界。历史性的 `Session.createLane()` 拥有 validation 与 durable transaction，但 Harness 无法从同一个 commit continuation 中发布其进程本地的 `Lane` 并绑定 `lane_created` 接收者。因此 Harness 自己打开 `Session.mutate()` 并调用导出的 `createLaneWithMutator()`。

WP04 在保留当前 direct-listener 与 hook barriers 的同时，移除这两个由调用方操作的接缝。

## 必需的语义

### Direct events 仍然是被等待的观察

Direct `events.on()` listeners 保持 passive，但具有因果顺序：

```text
hook or preparation
→ commit
→ publish process-local state
→ bind and append event batch
→ release lane mutation line
→ await direct listeners
→ resolve operation
→ later hook or transition
```

Passive 意味着 listener 不能改变进行中的 operation，且 listener 失败被隔离为 `handler_error`。它并不意味着 fire-and-forget。一个 extension 可以在 event listener 中更新进程本地状态，并在之后的 hook 中检查它。等待还提供了 producer backpressure。

direct listener 不得调用会改变状态的 harness API：一次被 emit 的 mutation 会把一个更晚的 event 排在当前正等待该 listener 的 event 之后。只读的 lane 调用仍然合法。

有意的例外保持不变：

- watchers 与 RPC/watch 消费者使用它们自己的 buffered FIFO，且不被 operations 等待；
- fault publication 是 fire-and-forget，且 close 从不等待 listener 完成；
- 高频 tool updates 把每个 event 入队，并只保留最新的 delivery promise；tool settlement 在 `after_tool` 与 outcome publication 之前等待那个 promise，这会通过全局 FIFO 排空所有更早的 updates，而不产生 per-update backpressure。

### Commit 与接收者绑定保持为同一个 continuation

每一个产生 event 的 committing lane job 都在观察到成功 commit 的精确 continuation 中执行：

```text
commit succeeds
→ publish complete process-local state
→ synchronously call emitBatch(batch, context)
   - clone payloads
   - bind current ordinary listeners and watchers
   - append the complete batch to the global delivery tail
→ return from the mutation callback
```

不存在 scheduler 拥有的 after-release publication phase。把接收者绑定移到一个更晚的 promise continuation 中会制造一个间隙：在这个间隙里，另一个 task 可能观察到已提交状态，并在旧 event 绑定接收者之前注册一个 listener。

`emitBatch()` 立即启动异步投递并返回其完成 promise。mutation callback 从不等待那个 promise。listener 代码可以在 publication/binding 之后、但在 mutation line 技术上释放之前开始；一次可重入的 lane read 会排到当前 job 之后。command 把该 promise 带出 `Session.mutate()`，并在公开 resolve 之前等待它。

这保留了两种合法的 watcher races：

```text
watcher registration first
→ snapshot-before + complete buffered batch

commit publication first
→ snapshot-after + no old event
```

### 顺序

- 一次非空的 `emitBatch()` 调用发布一个连续 batch。
- Batches 按 `emitBatch()` 调用顺序进入现有的全局 event tail，包括跨 lanes。
- batch 内的 events 保持源顺序。
- Direct listeners 按注册顺序串行运行。
- 同一 lane 的 committing jobs 按 lane mutation 顺序绑定 batches。
- 一个 lane procedure 在调用其下一个 hook 或 transition 之前等待每个 command 的投递。
- 无关 lanes 上的 hooks 可能重叠；不存在跨 lane 的全局 hook 顺序。
- Context 保持为精确的 emitting invocation Context，并且始终是最后一个参数。

## Event bus 契约

用以下内容取代 public/internal delivery 的拆分：

```ts
class HarnessEventBus implements Events {
  emit(event: HarnessEvent, context: Context): Promise<void>;
  emitBatch(events: readonly HarnessEvent[], context: Context): Promise<void>;
}
```

`emitBatch()`：

1. 对空 batch 或已关闭的 bus 返回一个已经 resolved 的 promise；
2. 同步 structured-clone 每个 payload 并绑定其当前接收者；
3. 向现有的全局 tail 追加一次连续的投递；
4. 用 emitting Context 串行投递克隆后的 payloads；
5. 隔离 listener failures 并像今天一样发布非递归的 `handler_error`；
6. 返回一个在符合条件的 direct listeners 结束后 resolve 的 promise，且绝不因某个 listener 失败而 reject。

同步 publication 缺陷（例如一个不可克隆的内部 payload）仍然在调用方的 commit continuation 中抛出，并遵循现有的 harness-fault 路径。

删除：

- `HarnessEventDelivery`；
- `HarnessEventBus.enqueue()`；
- 由调用方操作的 `start()`；
- delivery gates 与 `pendingStarts`；
- close 时的强制 gate release。

`close(error)` 立即封住 listener/watch 注册与未来的 publication。已经追加的 batches 保留其已绑定接收者并通过现有 tail 排空；listener 完成仍然不阻塞 Harness close。

## Lane command 集成

`Lane.command()` 的 commit 分支返回一个普通内部 outcome，其中包含调用方结果与可选的 delivery promise：

```ts
const events = decision.events?.(commit) ?? [];
const delivery = events.length === 0
  ? undefined
  : this.onEvent(events, context);

return {
  kind: "return",
  result,
  ...(delivery === undefined ? {} : { delivery }),
};
```

`onEvent` 返回 `Promise<void>` 并委托给 `emitBatch()`。它只在 commit、完整进程本地状态发布以及同步 result materialization 之后被调用，作为返回 mutation outcome 之前的最后一个 action。

在 `Session.mutate()` 返回之后：

```ts
if (outcome.kind === "reject") throw outcome.error;
await outcome.delivery;
return outcome.result;
```

预期中的 no-commit rejections 不发布任何 events。Commit/materialization/publication 错误保留现有的 harness-fault 语义。

## Session lane creation 契约

历史性的 `Session.createLane()` 拥有 validation、commit 以及同步的 committed-publication callback。Context 保持在最后：

```ts
createLane(
  name: string,
  at: string | null,
  configuration: LaneConfiguration,
  onCommitted: ((context: Context) => void | Promise<void>) | undefined,
  context: Context,
): Promise<SessionTree>;
```

实现执行：

```text
enter the prospective lane's mutation line
→ validate name, absence, complete lane shape, and target
→ commit lane configuration + leaf + idle lane state
→ synchronously invoke onCommitted(context) in that same commit continuation
→ retain its returned promise inside a non-thenable outcome object
→ return from the mutation callback and release the line
→ await the retained promise
→ return Session.view(name)
```

该 callback 既不接收 `SessionTree` 也不接收 `SessionMutator`。它只是进程本地的发布点。它的同步前缀必须完成另一个同 lane job 能够运行之前所需的 publication。普通的 Session 调用方传入 `undefined`。

如果 validation 或 commit 失败，callback 不会被调用。如果 callback 在 commit 之后抛出，或者其保留的 promise 在 line release 之后 reject，durable lane 仍然存在且调用方 reject；Harness 把那个 committed-publication 缺陷转换为其现有的 fault 路径。Harness callback 返回的 promise 是 event delivery，其 listener failures 由 bus 隔离。

当前的 lane validation/transaction 实现变为 Session 私有。删除导出的 `createLaneWithMutator()` 及其直接测试。

Harness 预先构造一个 detached 的 `Lane`，然后调用 Session：

```ts
const lane = this.buildLane(name, state);

await this.session.createLane(
  name,
  at,
  this.seed,
  (context) => {
    if (this.closedError !== undefined) lane.seal(this.closedError);
    this.lanesByName.set(name, lane);
    return this.events.emitBatch(
      [{ type: "lane_created", lane: name, at }],
      context,
    );
  },
  context,
);

return Result.ok(lane);
```

callback 的同步前缀在第一个 creation job 释放其 line 之前发布 `lanesByName` 并绑定 `lane_created`。因此，一个排队的重复请求无法在 winner 通过 `harness.lane(name)` 可见之前报告 `LaneExists`。

如果 close 或 fault 在 commit 被接纳时胜出，callback 发布被 seal 的新 Lane。在已关闭的 bus 上 emit 是一个已 resolved 的 no-op，与现有的 admitted-creation race 相符。成功被接纳的 creation 仍然返回其被 seal 的 Lane。

## 范围

### Source

修改：

- `packages/agent/src/harness/events.ts`；
- `packages/agent/src/harness/runtime2/lane.ts`；
- `packages/agent/src/harness/runtime2/harness.ts`；
- `packages/agent/src/harness/session/types.ts`；
- 历史性的 `createLane` 签名所要求的本地 Session 实现与测试；
- direct event primitive、acceptance、watch、lane 和 harness 测试。

远程/实验性 runtime 行为不是 WP04 的设计约束。Session mutation authority 保持进程本地；不要添加远程 Session callback transport、protocol machinery、compatibility abstractions 或 boundary tests。

### 文档

更新规范性的 `harness.md`：

- 用同步的 `emitBatch` 绑定与 post-mutation 等待取代 enqueue/start 措辞；
- 准确说明 listener 执行可以在 publication/binding 之后、但在技术性 line release 之前开始；
- 保留被等待的 direct-listener、event/hook、watcher、Context、close 和顺序语义；
- 用历史性的 `Session.createLane(onCommitted, context)` 取代共享的、导出的 mutator-procedure lane creation；
- 更新 invariants、races、tests、glossary 和 Part 8；
- 链接 WP04，并把 direct durable drive 移到 WP05。

只在历史性的 WP02 handoff 指向未来或声称旧机制仍然当前的地方更新它。不要把它作为已完成 package 的记录改写为仿佛 WP04 的行为是在 WP02 中落地的。

## 非目标

- fire-and-forget direct events 或公共 flush API；
- sequence/watermark delivery 重新设计；
- per-extension event queues；
- 改变 hook aggregation 或 event/hook causal barriers；
- 改变 watcher/RPC buffering；
- 改变 tool-update settlement barriers；
- 让 event-listener mutation 变得安全；
- drive、breakpoints、providers、tools、recovery、retries、polling、abort 或 terminal settlement；
- 通用的 Session post-commit/after-release task APIs；
- 远程 callback 执行或 remote-runtime 重新设计。

## 必需的测试

### Event 原语

- `emitBatch` 同步绑定 ordinary listeners 与 watchers；
- 在 `emitBatch` 之后、延迟投递之前注册的 listener 什么也收不到；
- 一个完整的 batch 是连续的并保持 event 顺序；
- 并发 batch publication 保持调用顺序；
- listener payload mutation 保持隔离；
- listener rejection 发出一个非递归的 `handler_error`，且不 reject delivery；
- 空 batch 与 close 之后的 batches 在不投递的情况下 resolve；
- 已经追加的 batches 在 close 之后排空；
- 不再保留任何 gate/start 测试。

### Lane commands 与 watch

- direct listeners 可以执行可重入的只读 lane 检查而不死锁；
- 一个 command 在其 direct listeners 结束之前不 resolve；
- 已提交的 memory 对 listeners 可见；
- commit failure 不发布任何内容；
- 一个观察到 durable 状态的晚到 listener 收不到历史 event；
- watcher-first 产生 snapshot-before 加上完整 buffered batch；
- publication-first 产生 snapshot-after 且不重放；
- source Context identity 在延迟与 buffered 投递中保持。

### Lane creation

- Session callback 在成功 commit 之后恰好运行一次，且在 validation/commit 失败时从不运行；
- callback 的同步 publication 发生在一个排队的重复请求报告 `LaneExists` 之前；
- Harness Lane 与 durable configuration 对 `lane_created` listeners 可见；
- Harness 在 resolve 之前等待异步的 `lane_created` listeners；
- 与 close 竞态的 admitted creation 发布一个被 seal 的 Lane，且不要求 event delivery；
- commit 之后 callback 抛出与保留 promise reject 遵循文档化的 committed-publication failure 路径；
- 使用 `undefined` 的普通 Session creation 返回其 view；
- 不再保留任何导出的 `createLaneWithMutator`。

### 顺序 barriers

- acceptance events 在 `accept()` resolve 之前完成；
- command resolution 不能越过其被等待的 direct event delivery；WP05 测试第一个后续的 procedure hook；
- event batches 在并发 lane publication 之间全局有序；
- 在已实现的地方，tool-update latest-delivery settlement 行为保持不变。

## 验证

文档之后：

```bash
git diff --check -- \
  packages/agent/docs/harness.md \
  packages/agent/docs/work-packages/02-atomic-run-acceptance.md \
  packages/agent/docs/work-packages/04-mutation-publication.md \
  packages/agent/docs/work-packages/05-direct-durable-drive.md
```

实现之后，运行每一个被修改的 focused test，然后：

```bash
git diff --check
npm run check
./test.sh
```

在宣布 WP04 完成之前，用 Fable 审查最终实现。没有用户明确批准不要提交。

## 停止条件

WP04 在以下情况完成：

- event publication 只有一个 `emitBatch()` operation，且没有由调用方操作的 gate；
- 接收者绑定仍然在精确的 commit-observation continuation 中；
- direct event delivery 保持全局 FIFO，并在公共 operation resolution 之前被等待；
- 现有的 event/hook causal barriers 保持完好；
- lane watches 恰好保留两种连贯的 race 结果；
- Session 拥有 lane creation，并在释放 creation job 之前调用 Harness publication；
- `createLaneWithMutator()` 已消失；
- Context 自始至终是尾随的且与源相同；
- focused tests、`npm run check` 和 `./test.sh` 通过；
- 最终的 Fable review 报告没有 findings。
