# 调用 Context 与遥测设计说明

> **Status:** 设计输入，而非规范性契约。Context 原语与必需的尾随 `Context` 参数已在 harness、sessions、execution capabilities 与 hosted-harness adapters 中落地。本地传播只是脚手架，而非完整遥测语义的证明：大多数 runtime span 与跨进程 trace 传播仍属于设计或实现工作。Drive ownership 现已由 harness 拥有，request-ID RPC cancellation 也已实现；两者都不提供 distributed trace 的父子关系。将已接受的最终行为并入 `harness.md`。`telemetry-schema.md` 仍是 span 名称与属性的生成参考。

## 目标

`Session`、`Branch`、`AgentLane` 与 `AgentHarness` 通过一个必需的尾随 `Context` 参数，显式接收 invocation 作用域的控制数据。同一个 receiver 可能同时服务并发的本地 caller 或 RPC client，因此它不能保留可变的或默认的 caller context。

invocation context 必须在不用 `AsyncLocalStorage` 的前提下解决两个相关问题：

1. 在并发异步工作中保持正确的遥测父子关系；
2. 在存在 `AbortSignal` 时携带它，使 RPC adapter 能将其映射为请求取消。

本项工作必须复用 `@earendil-works/pi-telemetry`。它不得引入另一套 span 抽象。

## Context 模型

已实现的公开类型为：

```ts
interface ContextKey<T> {
	readonly token: symbol;
	readonly valueType?: (value: T) => T;
}

interface Context {
	readonly abortSignal: AbortSignal | undefined;
	readonly telemetryContext: TelemetryContext;
	value<T>(key: ContextKey<T>): T | undefined;
	toString(): string;
}
```

`valueType` 仅是类型层面的标记。运行时查找使用该 key 的 symbol token。`createContextKey<T>(description)` 创建一个带唯一 token 的 key 并冻结它。

context 是不可变的。派生会创建一个父级链接的、写时复制的层。辅助函数的参数把值放在前面，把父级 context 放在最后：

```ts
const requestContext = withAbortSignal(requestSignal, parentContext);
const spanContext = withTelemetryContext(span, requestContext);
const tenantContext = withContextValue(tenantKey, tenantId, spanContext);
```

已实现的行为为：

- `BACKGROUND_CONTEXT` 与 `TODO_CONTEXT` 是不同的空 root，其 `abortSignal` 为 `undefined`；
- `telemetryContext` 始终可用，在未安装遥测值时回退到 `NOOP_TELEMETRY_CONTEXT`；
- `withAbortSignal(signal, context)` 在父级没有 signal 时保留传入的 signal，否则用 `AbortSignal.any()` 将其与父级 signal 组合；
- `withCancel(context)` 返回一个可独立取消的子 context 与一个 `cancel(reason?)` 函数；父级取消仍会到达子级；
- 类型化值使用 symbol 标识与不可变的写时复制层，同一 key 的较新值会遮蔽其父级值；
- 内置的 abort-signal 与遥测 key 是私有的；caller 使用具名属性，而不是通过 key 取回这些值；
- `toString()` 用于诊断，记录 root 以及每一层的 key 描述。

Context 值是横切的请求元数据，不是业务依赖。合适的类型化值包括 request ID、已认证的 principal、tenant ID 与诊断元数据。Storage、models、tools、持久化状态与业务 payload 不属于 context。Context、signal、遥测对象与后端原生 span 对象永远不是持久化数据。

## Receiver 归属

共享 receiver 保留身份与持久化/进程状态，而不保留 invocation context：

```text
AgentHarness receiver  ── no caller context
AgentLane receiver     ── no caller context
Session receiver       ── no caller context
Branch receiver        ── no caller context
```

每次调用都提供自己的 context。这防止并发 caller 相互覆盖对方的遥测父级或取消 signal。

代表某个进行中 invocation 的进程本地对象可以保留其派生的 context。例如活动的 drive task 或事件订阅。这与在共享 harness 或 session receiver 上存储默认 context 不同。

`AgentHarnessOptions.telemetryContext` 已被移除。harness 级别的默认值无法表示两个具有不同父级的并发 caller。

## 既有的类型化遥测仍是权威

该设计保留：

- `TelemetryContext` 与 `TelemetrySpan`；
- 由 callback 拥有的 span 生命周期；
- `AI_TELEMETRY_SCHEMA` 与 `HARNESS_TELEMETRY_SCHEMA`；
- 类型化的 span 名称、start attributes、completion attributes 与 events；
- `startAiSpan()`、`startHarnessSpan()` 与 `createTypedSpanStarter()`；
- adapter conformance 行为。

`startAiSpan()` 与 `startHarnessSpan()` 通过向它们的 callback 同时提供类型化 span 与派生的 invocation context，来打包 span 派生：

```ts
return startHarnessSpan(
	"pi.harness.run",
	attributes,
	async (span, runContext) => {
		return runDrive(runContext);
	},
	context,
);
```

这些辅助函数委托给 `context.telemetryContext.startSpan()`，并用 `withTelemetryContext(span, context)` 把由 callback 拥有的 span 安装到子 context 中。下层工作必须接收该子 context，而不是父级 invocation context。

不要通过修改 context 来安装活动 span。不要使用进程全局或 receiver 全局的当前 span。

## 并发父子关系

显式传播支持并发的同级调用：

```ts
await parent.telemetryContext.startSpan({ name: "caller" }, async (callerSpan) => {
	const callerContext = withTelemetryContext(callerSpan, parent);
	await Promise.all([
		laneA.drive(optionsA, callerContext),
		laneB.drive(optionsB, callerContext),
	]);
});
```

每次调用都派生自己的子 context。嵌套工作接收属于该调用的子级。正确的父子关系不依赖 promise 调度或环境状态。

测试必须有意识地跨越并发分支，使意外的 receiver 级别 context 变得可见。顺序的父/子测试是不够的。

## Callback、hook 与 event

作为某个 operation 的一部分被调用的 host-local callback，会在其声明的尾随位置接收当前 invocation context：

```ts
handler(event, context);
tool.execute(toolCallId, params, onUpdate, toolContext, invocation, context);
mutation(mutator, context);
```

当前的传播会通过 callback 保留 context，并为 `before_tool` 与 `after_tool` handler 提供一个派生自 `pi.harness.hook` 的子 context。将这种 span 行为扩展到每一种 hook 类型仍是待做工作；尚未安装 hook span 的 handler 目前直接接收 operation context。

在 harness 进程内，event 保留导致每个 event 的 context，缓冲的 event watcher 存储 `{ event, context }` 而不只是 `event`。从该 event context 启动 `pi.harness.event_handler` 并将其子 context 传给每个 listener 仍是待做工作。Event 注册本身是 host-local 配置，没有 operation 父级。

Session mutation callback 与 commit 接收相同的显式 invocation context。从发起提交的 invocation 启动 `pi.session.write` 并把它的子 context 贯穿 storage commit 仍是待做工作。

## Drive 执行与 joiner

多个 caller 可能为同一个持久化 operation 调用 `drive()`。仲裁决定哪个调用安装进程本地执行，哪些调用加入它。这是核心 runtime 关注点，而非 RPC 关注点；并发的本地 caller 有同样的问题。

一个活动执行只有一个遥测父级。当另一个 caller 加入时，它不能被重新指定父级。

```text
installer caller
└─ drive.execute
   └─ provider/tool work

joiner caller
└─ drive.join
```

joiner span 描述该 caller 的等待。它至少携带 lane 名称、持久化 operation ID 与一个进程本地执行 ID。它以诸如 `settled`、`caller_cancelled`、`execution_stopped` 或 `harness_closed` 的结果结束。

joiner 不得覆盖活动执行的 context。使用 operation/execution 属性关联这两个 span。遥测 span link 会更好地建模这种关系，但当前遥测契约没有 link。添加 link 是遥测包的待定设计问题，而不是发明多个父级的理由。

分布式 trace 允许一个执行 span 比 installer 的 RPC span 存活得更久。一旦子级已启动，父级与子级 span 可以重叠，也可以以任意顺序结束。

## Invocation 取消与持久化取消

已中止的 invocation signal 是进程本地控制。它不意味着已请求持久化取消。

```text
context.abortSignal is present and aborts
→ stop only that caller's observation; an installed lane-owned Drive continues
→ do not write cancel_requested
→ preserve the same durable operation state
```

`abortSignal` 为 undefined（两个空 root 均如此暴露）意味着该 invocation 没有取消 signal。

只有 `requestAbort()`/`abort()` 会写入持久化 `cancel_requested` 并允许持久化 aborted settlement。

runtime 必须跟踪停止原因，而不是把每一个已中止的 provider 响应都解释为持久化取消：

```ts
type ExecutionStopCause =
	| "no_drive_waiters"
	| "invocation_cancelled"
	| "harness_closed"
	| "durable_cancel_requested";
```

只有 `durable_cancel_requested` 可以归一化并提交持久化 aborted 结果。invocation/disconnect abort 不得在持久化控制仍为 `running` 时产生 assistant `stopReason: "aborted"` settlement；那条路径会违反持久化状态机。

Drive ownership 被确定为 **harness-owned**：一旦安装，执行就会在 caller 取消/断开后继续存活，直到持久化 settlement 或等待、显式持久化取消、close、fault 或进程丢失。joiner 的 signal 只控制它们各自的观察。来自无关 joiner 的 signal 绝不能用 `AbortSignal.any()` 组合并直接挂到共享执行上。一个被取消的 joiner 不能取消所有其他 caller。

## RPC trace 传播

client 与 server span 可以属于同一个分布式 trace：

```text
caller
└─ rpc.client
   └─ rpc.server
      └─ harness/session operation
```

client 不序列化 `TelemetryContext`。它从 `rpc.client` span 注入一个后端中立的 trace carrier。server 把该 carrier 提取到一个全新的本地 `TelemetryContext`，并从它启动 `rpc.server`。

需要一个面向 transport 的 adapter 边界：

```ts
interface TelemetryPropagation {
	inject(context: TelemetryContext): JsonValue | undefined;
	extract(carrier: JsonValue | undefined): TelemetryContext;
}
```

生产实现可以使用 W3C `traceparent`/`tracestate`。当前遥测包没有 carrier 注入/提取 API，因此已接受的设计必须决定该 adapter 属于遥测包、RPC 基础设施，还是后端集成包。它仍必须复用既有的 `TelemetryContext` span 契约。

RPC cancellation 与遥测传播是相互独立的控制平面通道：

- trace 元数据重建遥测父子关系；
- request ID 加上 cancel/disconnect 消息控制 server 的请求 signal；
- 两个通道都不出现在序列化的方法参数中。

## 接口迁移脚手架

Receiver 方法现在使用一个必需的尾随 `Context`。具体实现、调用、callback adapter 与对象字面量 façade 都已完成迁移，而不是仅依赖接口的可赋值性。

`TODO_CONTEXT` 仍是一个临时迁移标记，而不是语义 root。当前的使用集中在尚未能重建 caller context 的未解决 transport 与 worker 边界，尤其是 Pi protocol 请求入口与 worker RPC 入口。`BACKGROUND_CONTEXT` 意味着有意地在没有 caller 的情况下启动。

继续单独盘点 `TODO_CONTEXT`。只有当边界能够构造请求局部的取消 context 与遥测父级时，才替换每一处 transport 边界的用法；用 `BACKGROUND_CONTEXT` 替代会掩盖未完成的传播。编译仍然不能证明遥测或取消的正确性。

## 后续 handoff 所需的测试

当前测试覆盖了不可变类型化值的分层与遮蔽、不同的空 root、父/子 abort 组合、同级取消隔离以及 tool-hook 子级父子关系。剩余的 handoff 覆盖包括：

- 在一个共享 receiver 上交叉的并发遥测分支；
- 每一种 hook 类型、tools、event handler 与 session write 都接收预期的子 context；
- 缓冲的 event 在延迟投递下保留其发出时的 context；
- 没有 receiver 级别的遥测默认值；
- 预先中止的 invocation 不启动任何外部 effect；
- lane-owned 执行下 installer 与 joiner 的取消隔离；
- invocation abort 使已安装的 Drive 与持久化状态保持不变；
- durable abort 提交持久化 aborted 结果；
- close 与 disconnect 不会伪装成持久化取消；
- client → server 的 trace 重建；
- event 投递重建源 trace 元数据；
- 缺失/畸形的 trace carrier 降级为 no-op/root 遥测，且不影响业务行为。

## 已解决的迁移决策

- Receiver 方法使用一个必需的尾随 `Context`。
- 共享的 Harness、AgentLane、Session 与 Branch receiver 不保留默认 invocation context。
- `Context`、`AbortSignal` 与 `TelemetryContext` 对象永不跨 RPC 边界序列化。

## 遥测 handoff 前的待定决策

- joiner 是否需要遥测 link；
- trace-carrier adapter 的归属与形态；
- 哪些 context 值（如果有）可以跨 RPC 边界；
- RPC 调用与 drive join 等待的确切 span 名称/结果属性。
