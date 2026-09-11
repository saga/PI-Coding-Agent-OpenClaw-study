# Facet Service RPC

Chord 拥有应用中立的 service 语义以及可插拔的 strict-JSON 连接
边界。Pi 拥有此处描述的具体 wire envelope、路由、attachment state 与 error adapters。
当前实现将 `JsonValue` 视为静态契约，并把对不受支持值的
运行时拒绝推迟到具体 serializer。

> **Status:** 实验性 facet-service RPC 语义的设计规格。

## 角色

`provide()`/`use()` 与 `provideMany().spawn()`/`observe()` 是 facet 系统隐藏的 RPC。facet 之间共享 TypeScript service 契约，而 transport 承载 service/member 标识符、strict JSON 值、request/subscription 关联、keyed generations 以及 binding 控制消息。Host 构造带类型的本地实现或 facade；TypeScript 类型与任意对象绝不跨 wire。独立加载的 process 可能暂时运行不同的 source generation，因此它们的 service 契约必须在受支持的 skew window 内保持前向兼容；version negotiation 仍然推迟。

```text
session/server facet: provide() / provideMany().spawn()
                    ↕ hidden service RPC
presentation/session facet: use() / observe()
```

service 系统就是扩展边界。presentation facet 接收语义化 service 与 replicated state；它们绝不接收原始 Harness、Session、tool registry、hook registry、credential store 或 storage handle。

## 非目标

不要序列化 `Context`、`AbortSignal`、telemetry 对象、callbacks、tools、hooks、functions 或任意对象图。不要让核心 Harness 或 Session 实现感知 transport 机制。不要让 disconnect 执行 durable 或 service-owned cancellation。不要为已经受限于 JSON 的值构建 per-method codecs。

## Service 契约与带类型 facade

一个 service token 是一份共享的 TypeScript 契约和一个稳定的 service ID。它不是生成的 descriptor，也不创建 provider。token 默认可远程发布；process-local token 声明 `{ local: true }`。`provide()` 向 host graph 添加一个 singleton 实现。`provideMany()` 在 facet setup 期间注册一个 multi-instance service owner，并返回一个 `ServiceSpawner`，其后续 `spawn()` 调用发布实例。host 自动发布每个 non-local provision。一个 token 在一个 host service graph 中只有一种模式：混用 singleton 与 keyed 用法是错误的。

provider 将每个被暴露的实现成员归类为 method 或 Chord 创建的 `ReplicatedState`，并在 subscription snapshot 中发布该成员表。consumer 通过普通属性访问获得成员名——例如，JavaScript `Proxy` 对 `models.state` 收到 `"state"`，对 `models.refresh(context)` 收到 `"refresh"`。被访问的 slot 在 facade 绑定时依据 provider 公布的 kind 进行校验。

本地与远程 `use()` 都返回一个稳定的、惰性的带类型 facade，由该 token 的 consumer 共享。在同步 facet setup 期间，facade 处于 disconnected 状态，因此 setup 可以捕获它，但不能调用 method、读取 state 或注册 member subscription。装配之后，local facade 通过直接的 process-local implementation slot 解析，remote facade 通过 host 已连接的 services 绑定。重新加载提供该 service 的 facet 会暂时把同一个 facade 标记为 unavailable，然后替换其目标；RPC singleton 会清除 readiness，并在其既有 subscription 上安装完整的 replacement snapshot，使已捕获的 method 与 member facade 指向 replacement。在没有任何 provider 绑定时，调用 method 会失败，state 保持 unhydrated；不会仅仅因为调用是通过 proxy 发起的就将其排队。

远程 method 返回 promise，并且除了其声明的 `Context` 之外，接受并返回 strict JSON；`void` 是成功响应，不含 result 字段。不支持 private returned reference。client 在 transport 之前移除 context，接收方 host 构造一个全新的 local context。契约位置由 host 控制且必须一致；示例使用一个必需的尾部 `Context`。业务上的缺失是 JSON `null` 或一个 options 对象，绝不传输 `undefined`。

使用静态断言与运行时校验。静态检查约束远程 method 与 replicated-state 成员；运行时边界拒绝不受支持的成员以及非 JSON 的 arguments、results 与 state values。TypeScript 提供带类型 facade，但不认证对端，也不创建运行时元数据。

`{ local: true }` 仅移除远程发布及其 wire-contract 限制。除此之外，local 与 non-local provision 使用相同的 dependency ledger、activation 顺序、稳定的 singleton slot、keyed-instance generation、observer cancellation、disposal 与 provider-facet reload。local singleton slot 与 local keyed registry 直接持有任意对象契约；non-local provision 另外还会把其实现安装到 remote provider 中。

## 依赖 ledger

类型擦除不会隐藏 service 身份：每个 service token 在运行时都保留其稳定 ID。facet environment 由 host 以不可伪造的 owner identity 创建，其 setup 期的 service method 会追加到一个 generation-scoped ledger：

- `provide()` 记录一个 singleton provision；
- `provideMany()` 记录一个 keyed provision；
- `use()` 记录一个 singleton requirement；以及
- `observe()` 记录一个 keyed requirement。

facet 总是调用未限定的 `env.use()` 或 `env.observe()`；routing 不编码在调用中。这些操作在 setup 期间返回 source-independent 的 disconnected handle。setup 之后，每个 connection 返回其 provider 生成的 service catalogue，host 把每个 requirement 绑定到其 local provision 或恰好一个已连接的 provider。method 提供 mode，token 提供 ID。因此 host 无需对被擦除的 `T` 做反射，也无需手写一份并行的 dependency 列表。

首次 acquisition 或 provision 只允许在 facet setup 期间进行。之后的 commands、hooks 与 activation callbacks 使用 setup 期获取的 singleton facade、observer registration 或 `ServiceSpawner` capability。特别地，dynamic instance 通过 `provideMany()` 返回的 capability 来 spawn；延迟 spawn 无法引入一个此前未声明的 provision。

setup 之后，每个 host 私下将记录的 requirement 与 local provision 和 connection catalogue 进行解析，以拒绝缺失的 provider、重复的 remote offer 与 mode 不匹配，并推导出 lifecycle edge。一个没有 live attachment 的 selected-Session connection 可以暂时把未解析的 requirement 接受为 unavailable；attachment 会依据 worker 生成的 catalogue 校验它们，并缓存该 catalogue 供后续 detached generation 使用。connection binding 归 generation 所有，且只包含被选中的 requirement，因此失败或退役的 generation 会释放其 subscription，而不 dispose 底层 transport connection。这个内部 service graph 不同于 module loader 的 source import graph；它不是 facet 编写或 facet 可见的 plan。

## 绑定与身份

presentation host 在一个 graph 中组合来自其已连接 server 与已选 Session 的 service。它的所有 facet 使用同一个未限定的 environment API。Session-service 调用绝不接受 client 选择的 durable `sessionId`；server 会授权并把 presentation 的 selected Session binding 路由到其 worker。

### Server 控制平面

Session 的列出与管理是普通的 server singleton service，而不是通用的远程 `Session` method。`SessionDirectory` 以 replicated state 的形式暴露 presentation-safe 的 session summary。`SessionManagement` 暴露 `create`、`remove`、`attach` 与 `detach` method。TUI 或 web facet 通过其 environment 消费两者：

```ts
const directory = env.use(SessionDirectory);
const management = env.use(SessionManagement);
```

server 为每个 presentation connection 绑定一个 service provider。它从本地已认证的 connection identity 推导出 workspace 与 client authority，而不是从 summary 字段或 method argument 推导。它可以按 client 投影 directory state；无论哪种方式，summary 绝不暴露 server-private 字段，例如 owner ID 或 working directory。

`management.attach(sessionId, context)` 改变 presentation host 中的 selected-Session services。server 关闭该 presentation 先前的 Session-scoped requests、subscriptions 与 observer tasks，把该 presentation 的 Session services 绑定到 worker，然后 hydrate 它们的 singleton state 与 keyed-instance directory。server 依据 connection identity 授权所选 Session。Attachment state 是报告该选择及其健康状况的 host control state；它不是 directory service。`detach()` 执行相同的清理，但不做替换。

host 需要为该 route 提供一个私有的、host-owned 的 binding incarnation。当 presentation attach、detach、切换 session 或替换失败的 worker 时，它会改变。其表示形式有意未作规定。该 binding 防止为旧的 selected session 而延迟到达的 frame 被应用到新的 session；它不是 facet-visible 的 service value，也不能替代授权。

一个 replicated-state source 具有结构化身份：

```text
(provider binding, service ID, optional instance key + generation, member name)
```

不存在可单独发现的 state ID。所添加的 instance key 是 application-level 的 logical key。当已关闭的 key 被复用时，其 host-owned generation 会改变，因此 stale proxy 无法调用 replacement。`requestId` 标识一次 transport invocation，用于响应与取消。Harness/tool 的 `invocationId` 可能是有用的 instance key——如 question 示例中那样——但它不能替代 live address 中的 service、binding 或 generation 部分。

## 调用、context 与 routing

一次 call 携带足够的 control-plane 信息以选择 provider binding、service、可选的 keyed instance 与 member，外加一个 request ID、JSON arguments 与 trace carrier。server 可以解析这些 control-plane 字段来路由 Session 调用，但它不解析 facet 业务 payload，也不加载 facet 契约。service endpoint 校验 member 与 values，创建 request-local 的 abort controller 与 `Context`，安装已认证的身份，并调用本地实现。

client 把 `context.abortSignal` 映射为对该单个 request 的取消。Disconnect 取消该 connection 的 active calls 并关闭其 subscriptions。这两个动作都不会取消 service-owned work，也不会写入 durable Harness cancellation。per-client request correlation 会到达 worker，因此来自不同 presentation 的 request ID 不会冲突。

## Replicated state 与 keyed instances

`ReplicatedState` 是权威的 latest-value replication，而不是 event history、durable storage、CRDT 或 multi-writer state。cold replica 的 `value === undefined`；在 hydration 之前订阅只会记录一个 listener，而不会调用它。Hydration 会在后续 updates 被投递之前以原子方式安装一个完整 snapshot，因此不存在 snapshot/update gap。一旦 hydrated，`value` 是同步的，订阅会先报告当前值，随后报告后续 updates。第一个 snapshot callback 使用全新的 hydration context；已 hydrated 的 replica 使用全新的 local delivery context，而不是保留最初的 write context。State values 是借用的 immutable JSON，不做防御性克隆；caller 不得修改或保留它们。

远程 hydration 使用一个以 subscription 为 parent 的全新 delivery context，而 updates 会从 source trace metadata 重建全新的 delivery context。Disconnect、provider withdrawal、replacement 与 route switching 会清除 readiness。Reconnect 或 replacement 会在后续 updates 之前安装一个完整 snapshot。transport 会缓冲与 hydration 竞争的 updates 并检查其 sequence。Acknowledgements、flow control 与 gap recovery 仍是独立的 protocol mechanics。

`observe()` 是 keyed-instance discovery，而不是一个包含 proxy 的 `ReplicatedState`。它把完整的 initial directory 与有序的 additions、replacements 和 removals 进行协调。每个 instance 的 initial state members 会在其 observer task 启动之前 hydrate。关闭一个 instance 会拒绝新的 calls，只 abort 该 instance 的 observer task，并允许已准入的 calls 完成 settle。Session facet 的 `env.observe()` registration 会在该 facet generation 关闭时 abort 旧的 tasks；replacement generation 会协调新的 directory。

## 私有返回引用

私有返回引用不在初始 service 契约之内。对于可发现的 live instance，优先使用 keyed services。如果某个具体 feature 需要 caller-private 的 remote identity，其 reference 必须显式传递，而不是通过 `observe()` 发现，并且要限定到 recipient 与 provider binding。

本设计不包含任何通用 Harness projection。原始 Harness、Session、lane、tool、hook 与 storage 对象仍是 local authority。如果未来的 integration 需要 remote callback 或通用 object capability，它需要单独的显式 protocol 与 policy；它不是 service RPC 的扩展。

## Context、cancellation 与 telemetry

每个 remote method 都接收一个全新的 local `Context`；发送方的 object、signal、telemetry implementation 与任意 typed values 绝不跨 wire。client 把该 call 的 abort signal 映射到该 request，并注入一个 trace carrier。endpoint 构造 request-local 的 abort signal 与 telemetry parent。Cancellation 会通过 server 转发给 Session worker，并保持按 client 加 request ID 隔离。

span 关系是：

```text
caller
└─ rpc.client
   └─ rpc.server
      └─ service implementation
```

三个 cancellation domain 保持分离：abort 一次 RPC invocation；显式取消 service-owned work，例如 `job.cancel()`；以及 durable Harness cancellation，例如 `requestAbort()`。Transport cancellation 与 disconnect 只执行第一个。比一次 call 存活更久的工作必须 detach 成一个 service-owned task，拥有自己的 controller 与 telemetry root。

## 安全与生命周期

只有未标记为 local 的已加载 service token 才能在 remote boundary 注册。只有拥有它的 `ServiceSpawner` 才能 spawn instances。标记为 `{ local: true }` 的 service 绝不可在远程被发现。local service 可以使用不受限制的 object contracts。remote provider 校验 member kind，而具体 serializer 强制执行 JSON business values。client 无法把 control envelope 伪造为普通 value、无法选择 instance generation、无法在 service call 中选择不同的 Session route，也无法取消另一个 client 的 request。

server 认证 connections、授权 attachment，并在 service `Context` 中重建 client identity。普通业务 argument 绝不携带 authority。Credentials、prompts、completions、tool data、filesystem contents 与其他敏感值需要一份显式的 presentation-safe 契约。

facet environment 拥有 registrations、已添加的 service instances、observations，以及通过 `own()` 显式注册的 resources。connection binding 拥有其 transport subscriptions 与 active request controllers。已准入的 inbound calls 不依附于提供该 service 的 facet lifecycle：provider withdrawal 会拒绝新的 calls，但已准入的 method 可以在旧 facet 停用期间继续。provider 自身的 Session work 保持存活，除非其 lifecycle policy 停止它。

## 测试

面向 facet 的语义在 loopback 与 framed transports 上测试：

- setup 期 dependency-ledger 归属、拒绝延迟 acquisition、local 与 remote `use()`、keyed-provider 归属、singleton/keyed mode 校验、token 驱动的 RPC publication、惰性 member access、在 provider-facet replacement 期间保持稳定的 local 与 RPC singleton facade，以及 `{ local: true }` service 在远程保持不可达；
- strict JSON 边界、method context 重建，以及在不序列化 context values 的前提下实现 request cancellation 隔离；
- server/Session facet 隔离、selected-Session 切换、stale-frame 拒绝，以及 worker 侧的 per-client request correlation；
- cold 与 hydrated 的 `ReplicatedState`、snapshot/update 无竞争、fresh delivery contexts，以及在 disconnect、reconnect 与 provider replacement 时的 clearing/re-hydration；
- instance directory hydration、有序 reconciliation、在 observer tasks 之前进行 state hydration、基于 generation 的 stale rejection，以及 close 或 switch 时的 task cleanup。

额外的测试覆盖已认证的 attachment 与 identity、telemetry propagation、flow control 与 gap recovery，以及 question 与 shared-review 应用模式。如果添加 private references，它们需要单独的 lifetime 与 isolation 覆盖。

## 未定的 protocol mechanics

确切的 service call、cancellation、subscription、snapshot/update、keyed-instance、unavailable 与 replacement frames 定义在 `packages/protocol/src/protocol.ts` 中。provider 与 namespace 层负责 member classification、lazy facades、buffering 与 sequencing。

仍未确定的是 acknowledgements、flow control、sequence-gap recovery、若添加 references 后的 reference collection、protocol-version negotiation，以及未来的 multi-pane presentation 如何表示多个 selected Session。singleton provider replacement 必须继续在既有 subscription 上安装完整的 replacement snapshot，使 method 与 state member slots 保持 identity。

## 示例：directory 与 selected session

directory 与 management service 是普通的 server service。它们的契约只携带 presentation-safe 的值：

```ts
interface SessionSummary {
	serverId: string;
	sessionId: string;
	createdAt: string;
}

interface SessionDirectory {
	readonly state: ReplicatedState<{ revision: number; sessions: SessionSummary[] }>;
}

interface SessionManagement {
	create(options: { id?: string }, context: Context): Promise<SessionSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
	attach(sessionId: string, context: Context): Promise<void>;
	detach(context: Context): Promise<void>;
}

const SessionDirectory = defineService<SessionDirectory>("pi.session-directory");
const SessionManagement = defineService<SessionManagement>("pi.session-management");
```

server facet 从已认证的 `Context` 推导出 client，授权所请求的 Session，并执行 binding transition：

```ts
serverContext.provide(SessionDirectory, { state: directoryState });
serverContext.provide(SessionManagement, {
	async attach(sessionId, context) {
		const client = requireClientIdentity(context);
		authorizeSession(client, sessionId);
		await attachments.bind(client.clientId, sessionId, context);
	},
	async detach(context) {
		await attachments.unbind(requireClientIdentity(context).clientId, context);
	},
});
```

presentation facet 渲染并选择 Sessions：

```ts
setup(env) {
	const directory = env.use(SessionDirectory);
	const management = env.use(SessionManagement);
	const tui = env.use(Tui);

	tui.commands.register("sessions.switch", async (operation) => {
		const snapshot = directory.state.value;
		if (snapshot === undefined) return;
		const sessionId = await tui.select(
			"Sessions",
			snapshot.sessions.map((session) => ({ label: session.sessionId, value: session.sessionId })),
			{ signal: operation.abortSignal },
		);
		if (sessionId !== undefined) await management.attach(sessionId, operation);
	});
}
```

同一 presentation 中的另一个 facet 通过相同的 API 获取 Session services：

```ts
setup(env) {
	const models = env.use(Models);
	// After attach() settles, `models` addresses the selected worker.
}
```

presentation 绝不使用 selected `sessionId` 来路由 `models`；其 host 路由每个 service token，transport 保留 selected-Session binding。server 在 hydrate 新的 Session binding 之前关闭先前 Session binding 的 resources。
