# Coding-Agent Application Host 与 facet

与应用无关的 facet、service 与 replicated-state runtime 由 `@earendil-works/chord` 提供。本文档规定 Pi 如何将该 runtime 与 Pi 拥有的 service contract、进程角色、routing 与 lifecycle 策略组合起来。

> **Status:** 实验性 facet 与 service 架构的设计规范。

本文档假定你已经理解 `AgentHarness`、`AgentLane`、`Session`、`Branch`、`SessionRepo` 与 invocation `Context`。service transport 语义见 `rpc.md`，遥测模型见 `telemetry.md`。

## 鸟瞰

coding agent 在多个进程中独立组装。共三层：

1. **facet kernel** 拥有 service 感知的生命周期机制：同步 setup、依赖组装、本地与已连接 service 绑定、activation、作用域化资源所有权、setup 失败清理、reload 与逆序 disposal。它了解 service 与远程 service source，但不了解 Harness、tools、TUI component 或 coding-agent 策略。
2. 一个 **application host** 拥有一个具体 runtime，并贡献提供其具体 service 的 runtime facet。**session host** 通常运行在专用的 session worker 中，拥有 session 权威——真正的 Harness。**presentation host**（今天是 TUI，日后是 web）拥有用户界面。**server host** 拥有 server 级权威：session 记录（`SessionRepo`）、session-worker 管理、认证、attachment，以及 presentation 与 session worker 之间的 routing。
3. 一个 **extension** 可以分发包含 **facet** 的、相互独立的 host 特定 bundle。没有任何聚合 extension 对象被加载到所有进程。每个 host 只加载为该进程构建的 facet，而这些 facet 只能使用该 host 图中可用的 service。

初始拓扑有一个 server，且没有 server 到 server 的链接：

```text
server
├─ TUI A
├─ web B
├─ session worker S0
└─ session worker S1
```

一个 presentation 与一个 session worker 各自连接到 server。不存在直接的 presentation→session-worker 连接；server 将 service 调用路由到选定的 worker。server 只列出并管理自己的 session。多 server routing 与 server 层级不在范围内。

一个 session worker 通常拥有一个 session，且每个 session facet 都为该 session 实例化。一个 server facet 在每个 server 进程实例化一次，并在连接到它的每个 session 与 presentation 之间共享。因此 server facet 应当稀少，且仅限于本质上是 server 级的关注点。per-session 功能状态属于 session facet；专用 worker 提供更优的生命周期、崩溃与状态隔离。未来的 co-location 可以保留相同的逻辑 service 图，而不改变 facet 能访问哪些对象。

**Host** 与 **client** 是每条连接上的角色，而非固定的进程种类。server 承载 presentation 与 session-worker 连接。session worker 服务其提供的 session service，并可以通过同一 RPC 绑定机制消费 server 提供的 service。下文的“Client”始终指连接角色，绝不是某类 extension。

## 为什么是这种形态

- **权威留在它该在的地方。** Provider 凭据、tool 执行与 per-session extension 数据只存在于 session worker；session 记录与 worker 控制只存在于 server。除通过刻意的契约之外，任何东西都不会到达 presentation。
- **一个功能保持内聚。** question extension 的 tool、dialog 与 renderer 围绕一份 JSON 契约打包在一个包里，而每个 facet 都是 host 原生代码。
- **一个新的表面只是 presentation 侧的工作。** 用于 question dialog 或 session picker 的 web facet 针对既有 token 注册；session 与 server 代码不变。
- **Server 状态保持 server 级。** server facet 由所有 session 与 client 共享，因此只有当某功能的权威本质上是该 server 全局的时才使用它。
- **一套 facet 机制。** 内置项、runtime 能力与 extension 在每个 host 中使用相同的 facet environment。
- **可分段测试。** facet 针对提供 service 的 fixture 测试，契约针对 loopback 测试，路由的 TUI → server → session-worker 路径针对真实 transport 测试——各自独立。

## 一个功能，多个独立加载的 facet

有意不提供 `CodingAgentPlugin` runtime 接口。server、Session worker、TUI 与未来的 web host 在不同进程中执行不同的 bundle，因此它们无法共享一个包含所有 host facet 的已加载对象。

进程内的单位是一个 facet：

```ts
interface Facet {
	readonly id: string;
	setup(env: FacetEnvironment): void;
}
```

每个进程加载适合该进程的有序 `Facet[]`。Setup 是同步声明；异步初始化属于 `onActivate()`。一个功能可以由一个共享 contract bundle 加上零个或多个分别解析的 server、Session、TUI 或 web bundle 组成。连接它们的是共享的 service ID 与 wire contract，而不是聚合 JavaScript 对象或 `definePlugin()` wrapper。

一个包将共享 wire contract 与 host 依赖分开：

```text
question-extension/
  contract.ts       JSON DTOs and service tokens
  session.ts        dialog-service authority and tool contribution; imports agent/session code
  tui.ts            terminal dialog and renderer; imports TUI code
  web.ts            optional browser dialog and renderer
  package exports   unresolved mapping from host kind to independently loadable bundles
```

浏览器构建从不导入 `session.ts`；session 进程从不导入 TUI 或 DOM 代码。

question extension 是本文档的端到端示例：

```text
model calls the question tool                                  (session facet)
→ session facet adds one invocation-keyed dialog service        (session authority)
→ every connected TUI/web facet observes the service instance   (keyed service)
→ the first accepted answer settles it for everyone
→ session facet returns the durable tool result
→ closing the instance closes every presentation's dialog
```

在没有 presentation 连接时，question 保持 pending。稍后连接的 TUI 或 web facet 会获得同一个 pending question。

后续各节中的 models service 说明了 service 与 replicated state；[server 部分](#the-server-directory-management-and-routing)涵盖 server 级 service 与 session routing；[question 部分](#session-owned-deferred-interactions-the-question-extension)把完整的往返过程具体化。

## 加载与连接 host

loader 抽象有意比 extension manifest 更小：

```ts
interface LoadedFacets {
	readonly facets: readonly Facet[];
	dispose(): Promise<void>;
}

interface FacetLoader {
	load(): Promise<LoadedFacets>;
}
```

每个 host 接收一个或多个静态、组合或由 extension 支持的 loader。一个 loader 拥有一个已加载 module generation 的资源；facet host 拥有活动的 facet environment。初始启动会加载 facet、组装 service 图、激活它，并且只在 host 退役后才 dispose 已加载的 generation。

一个 extension resolver 可以添加身份、排序、版本选择、包隔离与进程特定的源解析。其输出仍是为每个进程提供的独立 `FacetLoader` 输入，而不是一个跨进程 extension 对象。

在 transport setup 之后，host 向 kernel 提供其已加载的 facet、提供具体本地 service 的 runtime facet，以及任何 host 选定的远程 service source。kernel 按 loader 顺序运行每个 `setup()`，校验完整的 service 图，绑定依赖，然后在 consumer 之前激活 provider。Setup 失败与正常关闭按反向依赖顺序 dispose 资源。

同一时刻恰好一个进程拥有一个 Session 的权威。Worker 替换必须先关闭旧 owner，然后新进程才能打开同一个持久化 Session。每个 presentation 与 Session worker 对其 server 使用一条多路复用连接；facet 从不打开私有 socket，也不处理 request ID、cancellation frame、routing namespace 或 reconnect buffering。

不在范围内：任意的未声明对象 remoting、序列化的 function/class/`Map`/`Set`、远程 hook 或 tool 执行、离线 presentation 写入或自动 mutation replay、通用的远程 `AgentHarness`，以及序列化的 UI 树。

## service 连接 host facet

facet 通过 **service** 跨进程通信。一种 token 类型赋予 service 契约其身份：

```ts
function defineService<T>(id: string, options?: { local?: boolean }): Service<T>;
```

该声明位于共享 contract 模块中，且不创建任何东西。Service 默认可远程发布；进程本地 token 声明 `{ local: true }`。`provide(service, implementation)` 向 host service 图添加一个 singleton。`provideMany(service)` 在 facet setup 期间注册对多实例 service 的所有权，并返回一个 `ServiceSpawner`，其后续的 `spawn(key, implementation)` 调用会发布实例。host 会把每一个非本地 provision 发布跨越其进程边界。consumer 用 `use(service)` 或 `observe(service, handler)` 选择相同的模式。在一个 facet generation 内，一个 token 必须保持一种模式：把 `provide`/`use` 与 `provideMany`/`observe` 混用属于组装或协议错误。

```ts
interface ServiceSpawner<T> {
	spawn(key: string, implementation: T): () => void;
}
```

TypeScript 类型无法产生 runtime member 元数据。facet 作者因此不声明平行的 member descriptor。当一个已暴露的 `provide()` 实现或 `ServiceSpawner.spawn()` 实例到达 remote-service 边界时，runtime 会把 function 归类为 remote method，并识别由 Chord 创建的 `ReplicatedState` 值。它拒绝不受支持的 member，并通过 transport 宣告生成的 member table。进程本地 service 可以使用任意对象契约。

对 singleton 调用 `use()` 会同步返回一个稳定的 lazy proxy，即使在远程 provider 被 attach 之前也是如此。member 访问在使用时创建本地 method 或 state slot；attachment 会依据 provider 宣告的 kind 校验这些 slot。不匹配属于组装或协议错误。该 runtime 机制由 host 实现一次，而不是在每个 service 声明中重复。

### 依赖声明与组装

在 facet setup 期间进行的 service API 调用就是依赖声明。kernel 不会对已擦除的 TypeScript 接口做反射，facet 作者也不维护平行的 `requires` 与 `provides` 列表。`Service<T>` 在 runtime 保留其稳定 ID，API 调用提供模式。`use()` 与 `observe()` 初始返回与 source 无关的断开 handle。所有 setup 完成后，host 将未解析的 requirement 与 provider 生成的 connection catalogue 匹配，并把每个 token 绑定到其本地 provision 或恰好一条 connection。

host 记录一份私有的 generation 作用域 ledger：

```text
env.provide(Models, implementation)
→ @pi/providers-builtin:session provides pi.models/singleton

env.use(Models)
→ @pi/model-selection:tui requires pi.models/singleton

env.provideMany(QuestionDialogs)
→ @pi/question:session provides pi.question-dialog/keyed

env.observe(QuestionDialogs, handler)
→ @pi/question:tui requires pi.question-dialog/keyed
```

对一个 token 的首次 `provide()`、`provideMany()`、`use()` 或 `observe()` 必须发生在 facet setup 期间。command、hook、event handler 与 activation callback 使用在 setup 期间获取的 handle；它们不能在之后引入未声明的 service 依赖。动态实例使用 setup 拥有的 `ServiceSpawner`，因此 spawn 与 close 实例不会改变该图。

每个 facet 注册完成后，host 从非本地 provision 生成其出站 catalogue，从远程 service source 获取 catalogue，把 requirement 解析为本地或已连接的 provision，拒绝缺失的 provider、重复的 offer 或 singleton owner、singleton/keyed 不匹配、无效的依赖环以及无效的远程 service 实现，然后为生命周期排序记录 consumer 到 provider 的边。`use()` 与 `observe()` 声明硬性 requirement；可选依赖需要一个未来的、不同的获取 API，而不是从调用失败推断。ledger 与生成的图是私有的 kernel 机制，而不是面向 facet 的计划或第二份声明格式。

只有通过 `env.use()` 或 `env.observe()` 获取的依赖属于该生命周期图。导入另一个 extension 的活动实现会绕过所有权，因此不受支持。module loader 单独拥有普通的源导入图。因此 reload 既需要已加载源的所有权，也需要生成的 service 图；参见 [Reloading facets](#reloading-facets)。

models service——model picker 与 thinking-level 控件背后的权威——演练了 method、replicated state 与多个 consumer。

### 共享契约

```ts
export interface ModelRef {
	provider: string;
	modelId: string;
}

export interface ModelsState {
	catalog: { revision: number; availableModels: Array<ModelRef & { name: string; reasoning: boolean }> };
	configuration: { model: ModelRef | null; thinkingLevel: "off" | "low" | "high" };
	refresh:
		| { status: "idle" | "refreshing" | "done" }
		| { status: "warning"; errors: Record<string, string> };
}

export interface Models {
	readonly state: ReplicatedState<ModelsState>;
	cycleThinking(context: Context): Promise<void>;
	refresh(context: Context): Promise<void>;
	select(model: ModelRef, context: Context): Promise<void>;
}

export const Models = defineService<Models>("pi.models");
```

在远程契约中传输的一切都是严格 JSON：参数、结果与 replicated state。业务层面的缺失使用 JSON `null`，绝不使用 `undefined`。未 hydrate 的 `ReplicatedState.value === undefined` 是本地控制平面就绪状态，而不是被传输的 state 值。`Context` 是声明位置上的控制平面数据；proxy 会剥离它，它从不被序列化。

### Session facet

下面的片段使用 facet 形态，但压缩了应用细节。

```ts
export const providersBuiltinSessionFacet = defineFacet({
	id: "@pi/providers-builtin",

	setup(env) {
		const providers = new ProviderRegistry(); // process-local, non-JSON
		const state = env.replicatedState<ModelsState>(initialModelsState());

		env.provide(Models, {
			state,

			async cycleThinking(context) {
				const { catalog, configuration } = state.value;
				if (configuration.model === null) return;
				const spec = findSpec(catalog, configuration.model);
				if (spec === undefined || !spec.reasoning) return;
				state.set(
					{
						...state.value,
						configuration: {
							...configuration,
							thinkingLevel: nextThinkingLevel(configuration.thinkingLevel),
						},
					},
					context,
				);
			},

			async select(model, context) {
				const spec = findSpec(state.value.catalog, model);
				if (spec === undefined) throw new Error(`Unknown model: ${model.provider}/${model.modelId}`);
				const thinkingLevel = spec.reasoning ? state.value.configuration.thinkingLevel : "off";
				state.set({ ...state.value, configuration: { model, thinkingLevel } }, context);
			},

			async refresh(context) {
				state.set({ ...state.value, refresh: { status: "refreshing" } }, context);
				const errors = await providers.refresh(context.abortSignal);
				state.set({ ...state.value, catalog: providers.snapshot(), refresh: toRefreshStatus(errors) }, context);
			},
		});

		env.onActivate(() => providers.rebuild());
	},
});
```

### TUI facet

这展示了通用的 command-service 模式。

```ts
export const modelSelectionTuiFacet = defineFacet({
	id: "@pi/model-selection",

	setup(env) {
		const models = env.use(Models);
		const tui = env.use(Tui);

		tui.commands.register("models.select", async (context) => {
			const current = models.state.value;
			if (current === undefined) return;
			const selected = await tui.select(
				"Models",
				current.catalog.availableModels.map((model) => ({
					label: model.name,
					value: { provider: model.provider, modelId: model.modelId },
				})),
				{ signal: context.abortSignal },
			);
			if (selected !== undefined) await models.select(selected, context);
		});
		tui.commands.register("models.cycle-thinking", (context) => models.cycleThinking(context));
		env.own(models.state.subscribe((next) => renderModelSelector(next)));
	},
});
```

TUI facet 没有凭据、registry 或 refresh 逻辑：它用契约的方法签名调用类型化 lazy proxy，并在 hydration 之后渲染 replicated state。web facet 会通过其 web facet environment 做同样的事。

### Service 语义

一个 service 有 **一个 owner 与多个 consumer**。在 singleton 模式下，`providersBuiltinSessionFacet` 提供 `Models`，两个 model-selection command 都消费它。在多实例模式下，一个 owner 可以 spawn 实例 `A` 与 `B`，每个 observer 都看到相同的两个实例。

`use()` 的行为因 locality 而异：

- **Local：** `use()` 返回一个稳定的 lazy proxy，由直接的进程本地实现 slot 支撑。在同步 setup 期间它是断开的；组装之后它会绑定到本地实现，而不要求 provider-before-consumer 的 setup 顺序。Reload 会解绑并重新绑定同一个 slot。
- **Remote：** 跨一条 connection 时，`use()` 返回同一种稳定的 lazy proxy。在断开状态下发起的调用会在被调用时失败；state 在 hydrate 之前没有值。一个进程内同一 token 的并发 consumer 共享一个 proxy、一个 state replica 与一个远程订阅。

多实例 service 使用 `provideMany()` 与 `observe()`。在其 setup 拥有的 `ServiceSpawner` 调用 `spawn()` 之前，该 service 是空的；observe 它永远不会创建实例。`spawner.spawn(key, implementation)` 返回一个幂等的 close 函数，且 key 必须在该 service 的活动实例中唯一。本地 observer 使用直接的进程本地实例 registry；非本地 provision 还会通过 RPC 发布同一实例。`observe(service, handler)` 先对账当前实例，然后是有序的添加、替换与移除。handler 接收与 `use()` 相同的 `T` proxy 形态；实例 key 仍是 provider 侧的寻址细节。在一个实例的初始 state member hydrate 之后，host 用一个全新的 `Context` 启动一个 handler task。facet 生命周期拥有该观察。关闭实例会中止其 task context、拒绝新调用，并让已被接纳的调用返回。来自实例 context 的取消是正常的 task 清理；其他 handler 失败遵循 host 失败策略。复用已关闭的 key 会创建一个新的 host 拥有的 generation，因此陈旧 proxy 无法寻址到替代者。

一个已添加的实例 member 具有结构身份 `(service, key, generation, member)`。因此其 `ReplicatedState` member 不需要独立的 ID。实例目录是控制平面元数据，而不是包含 proxy 的、facet 可见的 `ReplicatedState`。切换 session 会在 hydrate 所选 session 的当前实例之前，中止所有已观察的实例 task。

每个 facet 都使用相同的、无修饰的 `env.use()` 与 `env.observe()` operation。presentation host 将其本地 service 与已连接的 server 及所选 Session 的 service 组合起来，然后在内部路由每个 token。provider facet 从同一个 host 图解析 service。transport 绑定与 routing 仍是 host 基础设施，而不是 facet API。

## 每种 facet 授予什么

这是设计中最重要的边界。

**Session facet 运行在真实对象旁边。** 它们在拥有具体 `AgentHarness`、`AgentLane`、`Session` 与 Branch 的进程中执行，并接收由这些实例支撑的、直接的、进程本地的、作用域化能力——而非 RPC proxy。调用保留真实方法签名、`Context` 传播、`Result` 类型与对象身份。session facet 从不 RPC 回自己的进程。

```ts
interface ScopedSessionData {
	readonly metadata: SessionMetadata;
	getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined>;
	setValue<T>(address: Value<T>, value: T, context: Context): Promise<void>;
}

interface AgentFacetScope {
	readonly identity: SessionIdentity;
	readonly session: ScopedSessionData;
	readonly hooks: ScopedHooks;
	lane(name: string, context: Context): Promise<AgentLaneFacetView>;
}

const Agent = defineService<AgentFacetScope>("pi.local.agent", { local: true });
const Providers = defineService<ProviderContributionRegistry>("pi.local.providers", { local: true });
const Tools = defineService<ToolContributionRegistry>("pi.local.tools", { local: true });
```

“Local”与“unrestricted”是相互独立的决策。该 scope 为生命周期与组合收窄权威——通过它注册的 hook 与 event subscription 自动由该 facet 拥有并随之 dispose。`AgentLaneFacetView` 与 agent operation 并列直接暴露 Branch 方法。`ScopedSessionData` 暴露用途受限的持久化 operation。host 保留不受限的具体实例并保留：`AgentHarness.close()` 与 `Session.close()`；原始的 `Session.mutate()`、`beginMutation()` 与 `SessionMutator`（除非某个范围狭窄且受信任的 durability extension 显式拥有它们）；`idGenerator` 与 backend/storage 对象；Branch 创建；诸如 `setTools()` 的整 registry setter；未作用域化的 hook/event 注册；transport 暴露与 remote-reference 注册。这是组合与生命周期边界，而不是安全沙箱：session facet 是权威进程中的受信任代码。未来的 extension 策略可以显式授予更广的本地能力，但内置项不应获得任何隐式绕过。

**Presentation facet 不持有这些中的任何一项。** TUI 或 web facet 从不接收原始 Harness、Session、tree、tool registry、hook 或凭据。它使用 host-local presentation service，加上由 Session 或 server facet 刻意暴露的语义 service 与 replicated state。

```ts
interface FacetEnvironment extends FacetLifecycle {
	use<T>(service: Service<T>): T;
	observe<T>(
		service: Service<T>,
		handler: (service: T, context: Context) => void | Promise<void>,
	): void;
	provide<T>(service: Service<T>, implementation: T): void;
	provideMany<T>(service: Service<T>): ServiceSpawner<T>;
	replicatedState<T>(initial: T): MutableReplicatedState<T>;
}

type AttachmentState = { status: "detached" } | { status: "attaching" | "attached" | "degraded"; sessionId: string };

interface SelectItem<T> {
	label: string;
	description?: string;
	value: T;
}

interface TuiModal {
	select<T>(title: string, items: SelectItem<T>[]): Promise<T | undefined>;
	input(title: string): Promise<string | undefined>;
	close(): void;
}

interface TuiHost {
	readonly attachment: ReplicatedState<AttachmentState>;
	readonly commands: CommandContributions;
	readonly toolRenderers: ToolRendererContributions;
	acquireModal(signal: AbortSignal): Promise<TuiModal>;
	select<T>(title: string, items: SelectItem<T>[], options: { signal: AbortSignal }): Promise<T | undefined>;
}

const Tui = defineService<TuiHost>("pi.local.tui", { local: true });
```

第一个已实现的 presentation hookpoint 比这个最终的 `TuiHost` 更窄：一个进程本地的 `SlashCommands` registry。内置 presentation facet 与 plugin presentation facet 获取同一个 registry，并在 activation 期间添加 command 元数据与 callback。返回的 cleanup 会移除该 contribution，因此 facet reload 与 unload 会更新 autocomplete 与 dispatch，而无需重建 TUI。command callback 接收狭窄的 selection、status 与 prompt-submission operation，而不是原始 renderer 或 editor。

每个 plugin host facet 都是一个独立的 loader entry。示例 `/hello` presentation facet 有一个默认 facet 导出；未来的包构建会把该 facet 输出为一个预打包文件。来自同一 plugin 的 Session、server、web 与其他 presentation facet 是分开的 bundle entry，由共享 service ID 连接，而不是一个聚合的 runtime plugin 对象。

`acquireModal()` 在一个 presentation 拥有的队列中等待，并在多步交互期间持有 modal slot。其 signal 会移除排队的请求或关闭活动的请求，且 `close()` 是幂等的。`select()` 是单步的 acquire/select/close 便捷方式。两者都直接返回所选值，因此功能代码从不从显示标签恢复身份。

TUI 将其所有 facet 加载到一个 generation。其 host 把 `env.use(SessionDirectory)` 路由到已连接的 server，把 `env.use(Models)` 路由到所选 Session。在 detached 期间，Session 调用以 `session_not_attached` 失败，且 replicated state 没有值。Connection 与 attachment 健康状态是 host-local service，因为它们描述 presentation 控制状态。未来的 web host 同样会为 route、view 与 DOM dialog 绑定本地 service。其 server 与 Session facet 仍使用无修饰的 service operation。

`AgentController` 是位于 worker 拥有的 main `AgentLane` 之上的、presentation 安全的 command facade。它把 prompt、queue、abort、resume、compaction 与 navigation operation 暴露为 JSON 安全的结果。Session runtime 直接从 lane 构造它；它不把原始 Harness 或 lane 发布为本地 facet service。

其 runtime 形态为：

```ts
export function createAgentControllerRuntimeFacet(lane: AgentLane) {
	return defineFacet({
		id: "@pi/agent-controller-runtime",
		setup(env) {
			env.provide(AgentController, createAgentController(lane));
		},
	});
}
```

其 TUI facet 通过 `env.use()` 消费 `AgentController`，正如 model picker 消费 `Models` 一样。它不暴露 controller 背后的 Harness 对象；对任意 plugin 不存在通用的远程 Harness。`rpc.md` 仍可为其他受信任集成（IDE bridge、orchestrator）定义通用 Harness proxy——那是刻意的、分离的暴露，而不是 plugin 边界。

## 本地 service 与狭窄的远程 facade

并非每个依赖都应可远程到达。**local service** 是用 `{ local: true }` 声明并局限于其提供进程的 token。它可以使用同步方法，并持有 function、class、原生对象、凭据、文件系统 handle 或其他非 JSON 值。远程 `use()` 无法解析它，且 local service 从不可被远程发现。本地与非本地 provision 共享依赖排序、稳定 handle、keyed generation、activation、disposal 与 provider-facet reload；非本地 service 只额外增加校验、复制与 RPC 发布。敏感状态的模式是一个本地完整 service 加上一个狭窄的远程 facade：

```ts
const Credentials = defineService<CredentialStore>("credentials", { local: true }); // get/set provider secrets

interface Accounts {
	readonly state: ReplicatedState<{ providers: Array<{ provider: string; configured: boolean }> }>;
	remove(provider: string, context: Context): Promise<void>;
}
const Accounts = defineService<Accounts>("pi.accounts");
```

auth extension 的 Session facet 直接使用 `Credentials`；presentation 看到的是 provider ID 与 `configured` 布尔值——绝不是秘密。如果某些 setting 必须不可远程写入，用同样的方式拆分它们；不要依赖 presentation 侧的约定。

## Replicated state：`ReplicatedState`

`Models.state` 是一个 `ReplicatedState<ModelsState>`：**权威的最新值复制**——不是 event history、持久化 storage、CRDT 或多写入者机制。

```ts
interface ReplicatedState<T> {
	/** Borrowed immutable value, or `undefined` until hydration. Do not mutate or retain it. */
	readonly value: T | undefined;
	/** Listener values are borrowed and must not be mutated or retained. */
	subscribe(listener: (value: T, context: Context) => void): () => void;
}

interface MutableReplicatedState<T> extends ReplicatedState<T> {
	/** A providing state is always initialized. */
	readonly value: T;
	/** Transfers the JSON value to the state; the caller must not subsequently mutate it. */
	set(value: T, context: Context): void;
}
```

必需行为：

1. 提供方 host 拥有一个已初始化的权威值；远程 consumer 调用方法，而不是写入 replica。
2. 冷启动的远程 replica 没有值。其 `.value` 为 `undefined`，且 `subscribe()` 注册 listener 而不调用它。这个 `undefined` 是本地就绪状态，从不在 wire 上传输。
3. **Hydration** 在 update 流动之前原子地安装一个完整 snapshot。在 hydration 之前订阅是合法的，且与 snapshot 并发发出的 update 会被缓冲，因此 listener 先观察到 snapshot 再观察到 update，中间没有间隙。
4. 一旦 hydrated，`.value` 可同步读取，`subscribe()` 会立即报告当前值，然后报告未来的 update。snapshot hydration 使用一个以该 subscription 为父级的全新 delivery context；后续 update 从源 trace 元数据重建全新的 delivery context。
5. state 值是借用的不可变 JSON。state runtime 不会对读、写、snapshot 或 listener 投递做防御性克隆。caller 向 `set()` 转移所有权，且不得修改或保留由 `.value` 返回或传给 listener 的值；需要所有权时显式复制。进程与 transport 序列化可能自然产生一个分离的值，但 caller 不得依赖对象身份或分离性。
6. Disconnect、provider withdrawal 与 route switching 会清除就绪状态，因此 `.value` 变为 `undefined`。Reconnect 或 singleton 替换会在后续 update 流动之前，在既有 member facade 中安装一个完整的全新 snapshot。想要保留陈旧显示数据的 presentation 必须将其与 connection 或 attachment 健康状态分开保留。
7. `set(value, context)` 把其 context 传给本地 source listener 并发布源 trace 元数据。远程投递会重建一个全新的本地 `Context`；它从不保留源 context 对象。

consumer 在 reconnect 之后必须恢复的任何东西，都作为 replicated state 暴露，或通过远程方法拉取。replicated state 是最新值复制，其本身不是持久化 session storage；提供方 facet 必须在 worker 重启后重建其权威值。

优先使用若干粗粒度的独立 cell，而不是一个巨大的值或一种通用 patch 语言，这样 catalogue refresh 就不会重传无关的 configuration。诸如 transcript streaming 的高频数据需要一个未来的 snapshot-and-delta 设计，而不是让 `ReplicatedState` 过载。Revision 元数据、gap recovery、未变值抑制与按需订阅属于那个未来的协议，而不属于单个 facet 作者。

## Contribution registry：多个贡献者，一个结果

Service 适合一个 owner、多个 consumer。provider 与 tool 则相反：**多个 extension 贡献到一个 host 拥有的结果**。可变的全局 registry 会使组合依赖顺序，并使移除不可能。contribution registry 则在一个全新的 draft 上重放有序 contribution：

```text
fresh ProviderDraft
→ built-in provider contribution        (@pi/providers-builtin)
→ remote catalogue contribution         (@pi/providers-catalog)
→ models.json transformation            (@pi/providers-models-json)
→ authentication/availability marking   (@pi/auth)
→ validated ProviderState
```

移除一个 extension 会移除其 contribution 并重建；没有任何东西运行反向 mutation。tool 遵循同一模型，包括 wrapping：

```ts
sessionContext.tools.add((draft) => {
	draft.set("review_add", reviewAddTool);
	draft.wrap("bash", (next) => async (invocation) => {
		await authorize(invocation);
		return next(invocation);
	});
});
```

有序 wrapper 会确定性地组合——`telemetry(permission(sandbox(coreBash)))`——并且如果 permission extension 消失，重建会得到 `telemetry(sandbox(coreBash))`。只有 host 会 finalize draft 并把完整 registry 应用到 Harness；facet 从不调用 `setTools()`。contribution 配置重建后的行为；hook 拦截活动 operation——这是相互独立的机制。

## 面向 facet 作者的 Context、cancellation 与 telemetry

每个远程方法在其声明位置接收一个全新的本地 `Context`。proxy 从 JSON 参数中剥离 caller 的 context，并把 `context.abortSignal` 映射为该单个请求的取消。接收端点构造一个请求局部的 abort signal；它从不反序列化发送方的 `Context` 或任意类型化值。共享 service 对象不得保留 caller 的 context。

model refresh 展示了作者可见的全部表面：

```ts
const controller = new AbortController();
await uiTelemetry.startSpan({ name: "ui.models.refresh" }, async (span) => {
	const context = withAbortSignal(controller.signal, withTelemetryContext(span, BACKGROUND_CONTEXT));
	await models.refresh(context);
});
```

RPC 遥测与应用 span 的组合如下：

```text
ui.models.refresh
└─ rpc.client models.refresh
   └─ rpc.server models.refresh
      └─ plugin.models.refresh
```

`controller.abort()` 只取消那一个请求：server 重建的 `context.abortSignal` 被中止，且没有其他 caller 受影响。

三个 cancellation 域绝不能模糊：

1. **Invocation cancellation** 中止一次远程调用或等待——即上文的 `controller.abort()`。
2. **Service-owned cancellation** 是诸如 `job.cancel()` 的显式方法，用于停止 service 拥有的 task。
3. **Durable Harness cancellation**——`requestAbort()`/`abort()`——写入持久化 `cancel_requested` 并驱动持久化 settlement。

transport 断开只对活动请求执行第一项，并关闭该 client 的 subscription。它不得静默取消 service 拥有的工作或写入持久化取消。意图比其发起请求存活更久的工作，必须有意识地分离为一个 service 拥有的 task，并带有自己的 controller 与遥测 root。

## Service 拥有的 job

私有的返回引用不在初始 service 契约之内。对于可发现的活动实例，优先使用 `provideMany()`。只有在某个具体功能确立了其所有权与回收要求之后，才添加 caller 私有的引用。

一个可能的长时运行 job 契约为：

```ts
interface IndexJob {
	readonly progress: ReplicatedState<IndexProgress>;
	wait(context: Context): Promise<IndexProgress>; // aborting this context cancels only this wait
	cancel(context: Context): Promise<void>;        // cancels the job itself, for everyone
}
```

一个返回 `IndexJob` 的 `IndexService.start(root, context)` 会校验 root、创建自己的 `AbortController` 与一个分离的遥测 root，并返回该 job。该 job 作为仅该 caller 知晓的私有 **remote object reference**（`rpc.md`）跨越 wire。如果每个已 attach 的 presentation 都必须发现某个 job，则在 setup 期间用 `provideMany()` 注册一个多实例 service 并改为 spawn 一个实例。可发现性是区别所在：返回引用被显式传递；spawn 的实例出现在 `observe()` hydration 中。两者都使 cancellation 域具体化，且两者都需要显式的生命周期清理。

## server：目录、管理与 routing

server host 做两件事。它 **拥有 server 级 service**——列出、创建、删除 session 以及 attach 到 session——并在已 attach 的 presentation 与其管理的 session worker 之间 **路由 session 流量**。Routing 是 host 基础设施，facet 代码不实现它。

server facet 由连接到该 server 的每个 session 与 presentation 共享。它只应用于本质上是 server 级的功能。per-session 功能数据属于 session facet。

### Server host service

```ts
interface FleetFacetScope {
	readonly managed: ManagedSessionsView;  // sessions managed by this server
	readonly attachments: AttachmentsView;  // bind/unbind a client's selected session
}

const Fleet = defineService<FleetFacetScope>("pi.local.fleet", { local: true });
```

原始的 `SessionRepo`、storage handle、不受限的 process-kill 权威、routing map 与 routing 机制留在 server 应用中：

```ts
interface ManagedSessionRecord {
	sessionId: string;
	title: string;
	workspaceId: string;
	ownerId: string;
	cwd: string; // ownerId and cwd never leave the server
}

type ManagedSessionChange = { type: "created" | "changed" | "deleted"; record: ManagedSessionRecord };

interface ManagedSessionsView {
	snapshot(): ManagedSessionRecord[];
	onChanged(listener: (change: ManagedSessionChange, context: Context) => void): () => void;
	create(options: { title: string; workspaceId: string }, context: Context): Promise<ManagedSessionRecord>;
	remove(sessionId: string, context: Context): Promise<void>;
}
```

### 共享契约

目录是读取；管理会变更并选择。两者都是 presentation 安全的：`ownerId` 与 `cwd` 会从 summary 中剥离。

```ts
export interface SessionRecordSummary {
	sessionId: string;
	title: string;
}

export interface SessionDirectory {
	readonly state: ReplicatedState<{ revision: number; sessions: SessionRecordSummary[] }>;
}

export const SessionDirectory = defineService<SessionDirectory>("pi.session-directory");

export interface SessionManagement {
	create(options: { title: string }, context: Context): Promise<SessionRecordSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
	attach(sessionId: string, context: Context): Promise<void>;
	detach(context: Context): Promise<void>;
}

export const SessionManagement = defineService<SessionManagement>("pi.session-management");
```

### Server facet

```ts
// server.ts
export const sessionDirectoryServerFacet = defineFacet({
	id: "@pi/session-directory",
	setup(env) {
		const { managed, attachments } = env.use(Fleet);
		const state = env.replicatedState({ revision: 0, sessions: [] as SessionRecordSummary[] });

		function publish(_change: ManagedSessionChange, context: Context) {
			state.set({ revision: state.value.revision + 1, sessions: managed.snapshot().map(toSummary) }, context);
		}

		env.own(managed.onChanged(publish));
		env.onActivate(() =>
			state.set({ revision: 1, sessions: managed.snapshot().map(toSummary) }, BACKGROUND_CONTEXT),
		);

		env.provide(SessionDirectory, { state });
		env.provide(SessionManagement, {
			async create(options, context) {
				const client = requireClientIdentity(context);
				return toSummary(
					await managed.create({ title: options.title, workspaceId: client.workspaceId }, context),
				);
			},
			async remove(sessionId, context) {
				authorizeTarget(requireClientIdentity(context), managed.snapshot(), sessionId);
				await managed.remove(sessionId, context);
			},
			async attach(sessionId, context) {
				const client = requireClientIdentity(context);
				authorizeTarget(client, managed.snapshot(), sessionId);
				await attachments.bind(client.clientId, sessionId, context);
			},
			async detach(context) {
				await attachments.unbind(requireClientIdentity(context).clientId, context);
			},
		});
	},
});

function authorizeTarget(client: ClientIdentity, records: ManagedSessionRecord[], sessionId: string) {
	const record = records.find((candidate) => candidate.sessionId === sessionId);
	if (record === undefined || record.workspaceId !== client.workspaceId) {
		throw new RemoteServiceError("not_authorized", `Not accessible: ${sessionId}`);
	}
}

function toSummary({ sessionId, title }: ManagedSessionRecord): SessionRecordSummary {
	return { sessionId, title };
}
```

每次调用都针对 transport 策略在 server 本地安装的 client 身份进行授权，绝不针对普通参数中提供的身份。

### TUI facet：picker

```ts
// tui.ts
export const sessionPickerTuiFacet = defineFacet({
	id: "@pi/session-picker",
	setup(env) {
		const directory = env.use(SessionDirectory);
		const management = env.use(SessionManagement);
		const tui = env.use(Tui);

		tui.commands.register("sessions.switch", async (context) => {
			const current = directory.state.value;
			const attachment = tui.attachment.value;
			if (current === undefined || attachment === undefined) return;
			const selected = await tui.select(
				"Sessions",
				current.sessions.map((session) => ({
					label: pickerLabel(session, attachment),
					value: session.sessionId,
				})),
				{ signal: context.abortSignal },
			);
			if (selected !== undefined) await management.attach(selected, context);
		});

		env.own(directory.state.subscribe((next) => renderSessionList(next)));
	},
});
```

TUI facet 消费由唯一已连接的 server 提供的 service。这个 plugin 中没有 session facet，因为 session 不拥有发现或 attachment。

### Attaching 与 switching

`attach(sessionId)` 为该 presentation 连接选择 session：

1. server 为某个受管理的 session 授权该 client；
2. 它关闭该 client 先前的 session 作用域请求、subscription 与已观察的实例 task；
3. 它把 presentation host 的 Session service 绑定到所选 Session worker；
4. Session worker 从完整的全新 snapshot hydrate singleton state 与当前 keyed 实例；attachment 状态变为 `attached`。

Session service handle 在切换之间是稳定的：由 Session facet 的 `env.use(Models)` 返回一次的 proxy 会继续对新 Session 工作，且 `env.observe(QuestionDialogs, ...)` 会对账新 Session 的实例。属于已关闭 subscription 或请求的 frame 会被丢弃。

### 路由的 session 调用

```text
TUI A (selected session S1): rpc.client agent-controller.prompt
server: authorize client for S1; route to session worker S1 with authenticated client identity
S1: rpc.server agent-controller.prompt — fresh local Context, validated JSON args → lane.prompt(...)
response returns S1 → server → TUI A
```

中止 TUI 请求会通过 server 把取消发送到 S1，从而中止 session 侧的 request controller。`Context` 与 trace 元数据在 service endpoint 重建。

### Routing 是 host 基础设施

server 以契约无关的方式路由 session 流量。它解析 protocol envelope——frame kind、request ID、service ID、可选的 instance key/generation 与所选 session——但不解析 service 业务 payload。校验发生在 service endpoint，因此 server 可以路由一个 Session service 而不加载该 session facet。

server 用其已认证的 client 身份标记被路由的调用。Session worker 按 presentation route 为 connection 拥有的请求设置 key，防止 request-ID 冲突与跨 client 取消。没有 server facet 参与 routing 或重新提供 session service。

## Session 拥有的延迟交互：question extension

某些 session 侧工作必须向用户询问决策。既有的 `examples/extensions/question.ts` 展示了这种体验：model 调用 `question` tool，用户选择一个选项或输入答案，该 tool 以一个紧凑的渲染返回该答案。

question 不是路由到某个合格 presentation 的反向 RPC。Session 添加一个以 invocation ID 为 key 的临时 dialog service。每个已连接的 TUI 或 web presentation 都观察该实例，稍后连接的 presentation 通过实例 hydration 发现它，且在没有用户连接时该实例保持打开。

### 共享契约

```ts
const QuestionParamsSchema = Type.Object({
	question: Type.String(),
	options: Type.Array(
		Type.Object({
			label: Type.String(),
			description: Type.Union([Type.String(), Type.Null()]),
		}),
	),
});
type QuestionRequest = Static<typeof QuestionParamsSchema>;

type QuestionResponse =
	| { outcome: "selected"; index: number }
	| { outcome: "custom"; answer: string }
	| { outcome: "cancelled" };

interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom: boolean;
}

interface QuestionDialogs {
	readonly request: ReplicatedState<QuestionRequest>;
	submitAnswer(response: QuestionResponse, context: Context): Promise<void>;
}

const QuestionDialogs = defineService<QuestionDialogs>("pi.question-dialog");
```

`QuestionDialogs` 只声明契约。每次调用显式添加一个 keyed 实例。其 `request` state 由 service、invocation key、隐藏的 generation 与 member 名称寻址。

tool-result helper 保持 session 本地：

```ts
function questionResult(request: QuestionRequest, answer: string | null, wasCustom: boolean, text: string) {
	return {
		content: [{ type: "text", text }],
		details: { question: request.question, options: request.options.map((o) => o.label), answer, wasCustom },
	} satisfies AgentToolResult<QuestionDetails>;
}
```

### Session facet：添加一个 dialog service

`memoOnce(name, candidate)` 是一个原子的 invocation-memo operation。它保留第一个值，把该持久化胜者返回给每个 caller，并通过 reject 其 promise 而非同步抛出异常来报告所有失败。`awaitAbortable()` 是一个普通的共享 cancellation 工具。

```ts
// session.ts
export const questionSessionFacet = defineFacet({
	id: "@pi/question",
	setup(env) {
		const dialogs = env.provideMany(QuestionDialogs);
		const tools = env.use(Tools);

		tools.add((draft) => {
			draft.set("question", {
				label: "Question",
				description: "Ask users a question and wait for an answer.",
				executionMode: "sequential",
				replay: "safe",
				parameters: QuestionParamsSchema,

				async execute(_toolCallId, params, _onUpdate, _toolContext, invocation, context) {
					if (params.options.length === 0) {
						return questionResult(params, null, false, "No options provided");
					}

					const memoName = "pi.question.answer";
					let response = (await invocation.getMemo(memoName)) as QuestionResponse | undefined;

					if (response === undefined) {
						const completion = Promise.withResolvers<QuestionResponse>();
						const request = env.replicatedState<QuestionRequest>(params);
						const close = dialogs.spawn(invocation.invocationId, {
							request,
							async submitAnswer(candidate, _answerContext) {
								if (candidate.outcome === "selected" && params.options[candidate.index] === undefined) {
									throw new Error("Question response selected an invalid option");
								}
								const committed = invocation.memoOnce(memoName, candidate);
								completion.resolve(committed);
								await committed;
							},
						});

						try {
							response = await awaitAbortable(completion.promise, context.abortSignal);
						} finally {
							close();
						}
					}

					if (response.outcome === "cancelled") {
						return questionResult(params, null, false, "User cancelled the question");
					}
					if (response.outcome === "custom") {
						return questionResult(params, response.answer, true, `User wrote: ${response.answer}`);
					}
					const selected = params.options[response.index];
					if (selected === undefined) throw new Error("Question response selected an invalid option");
					return questionResult(params, selected.label, false, `User selected: ${response.index + 1}. ${selected.label}`);
				},
			});
		});
	},
});
```

`dialogs.spawn()` 在 `execute()` 等待之前安装该实例。返回的 close 函数是唯一的正常、取消与错误清理路径。并发提交会调用 `memoOnce()`，其原子的先写者规则防止覆盖并返回同一个持久化胜者。`completion.resolve(committed)` 使本地等待跟随该持久化 operation：成功会恢复该 tool，而失败会 reject 它并运行相同的清理，而不是让它保持挂起。每个 service 调用还会 await 自己的 `committed` promise，因此它无法在持久化之前报告成功，也不会留下被忽略的 rejection。通过已关闭实例或旧 generation 的调用会作为陈旧 service 调用失败。

### TUI 与 web facet：观察每个 dialog 实例

```ts
// tui.ts
type QuestionChoice =
	| { outcome: "selected"; index: number }
	| { outcome: "custom" };

export const questionTuiFacet = defineFacet({
	id: "@pi/question",
	setup(env) {
		const tui = env.use(Tui);
		env.observe(QuestionDialogs, async (dialog, context) => {
			const request = dialog.request.value;
			if (request === undefined) throw new Error("Question dialog was observed before hydration");

			const modal = await tui.acquireModal(context.abortSignal);
			try {
				const choice = await modal.select<QuestionChoice>(
					request.question,
					[
						...request.options.map((option, index) => ({
							label: option.label,
							...(option.description === null ? {} : { description: option.description }),
							value: { outcome: "selected" as const, index },
						})),
						{ label: "Write a custom answer", value: { outcome: "custom" as const } },
					],
				);

				let response: QuestionResponse;
				if (choice === undefined) {
					response = { outcome: "cancelled" };
				} else if (choice.outcome === "selected") {
					response = choice;
				} else {
					const answer = await modal.input(request.question);
					response = answer === undefined ? { outcome: "cancelled" } : { outcome: "custom", answer };
				}

				await dialog.submitAnswer(response, context);
			} finally {
				modal.close();
			}
		});

		tui.toolRenderers.add<QuestionDetails>("question", questionRenderer);
	},
});
```

`observe()` 为每个打开的实例运行一个可中止的 task，包括 hydration snapshot 中存在的实例。因此三个并发的 tool 调用会产生三个以其 invocation ID 为 key 的 task。TUI modal 队列一次显示它们中的一个；web host 可以渲染全部三个。关闭一个实例只会在每个 presentation 中中止其 task。

在没有已连接的 presentation 时，已添加的实例与未解析的 tool 保持 Session 拥有。web facet 观察同一个 service；headless client 可以忽略它。类似的功能——permissions、OAuth 或 editor 请求——可以在所有 presentation 都需要发现临时实例时添加自己的 service 实例。秘密仍需要狭窄的方法与 presentation 安全的状态。

### Durability 与 worker 替换

service 实例是活动的进程状态；invocation memo 是 replay 凭据。Harness 已经持久化了一个 safe tool 的有效参数、稳定的 invocation ID、`effect_pending` 状态与 memo。`memoOnce()` 在该 invocation 的 Session mutation line 上同步进入一次原子 read-or-write，并验证相同的 operation、turn、source position 与 invocation 仍拥有该 effect。它返回既有值，或提交并返回候选值。

如果 worker 在答案提交之前死亡，旧实例与 promise 会消失。safe replay 读不到答案，并以新的 generation 添加同一个逻辑 key。如果它在提交之后死亡，replay 会读到答案并返回，而不添加实例。在 worker 缺席时 client 无法作答；通过旧 generation 的调用会失败，而不是通过裸 ID 定位 invocation。

memo 具有既有的 invocation 生命周期。把 tool result staging 为 `outcome_ready` 会原子地删除它；取消与外部 finalization 使用相同的清理。question 请求不会被复制到另一个 memo，因为 Harness 已经持久化了有效的 tool 参数。Source reload 使用这同一条持久化 worker 重建路径。

## 生命周期与 disposal

一个 facet environment 拥有 service provision、`provideMany()` 实例、观察以及通过 `own()` 显式注册的资源。facet 必须自行注册 state subscription、watcher、timer、subprocess、overlay 与其他外部资源。host 在 provider 之前 deactivate consumer，并按反向注册顺序运行每个 facet 拥有的 cleanup。

已被接纳的入站 RPC 调用可以在其提供方 facet deactivate 期间继续。withdraw 一个 provider 会拒绝新调用。需要更强 fencing 的代码需要一个显式的、生命周期拥有的 controller。

## Reload facet

Reload 意味着替换已加载的 facet 源。它不是对持久化 Session 状态或外部 effect 的事务。

### 保持形态的 provider 替换

只有当每个替代者声明与活动 facet 完全相同的 service requirement、provision 与 singleton/keyed 模式时，`FacetHost.reload()` 才按 `Facet.id` 替换 facet。经过测试的序列为：

```text
load replacement facets
→ run setup and validate the unchanged service shape
→ withdraw replaced singleton provisions
→ deactivate old facets in reverse dependency order
→ activate replacements in dependency order
→ rebind local implementation slots
→ publish complete RPC singleton replacement snapshots
→ dispose the retired LoadedFacets generation
```

loader disposal 被刻意放在 `FacetHost.reload()` 之外：加载某个 module 的 coordinator 拥有该 module。它必须只在旧的活动 facet 退役之后 dispose 旧的 `LoadedFacets`，并在 setup 或校验失败时 dispose 失败的候选 generation。

singleton facade 属于其 consumer，而不属于某个 provider generation。既有的本地 proxy 与已捕获的本地方法会分派到替代实现。既有的 RPC proxy、已捕获的方法与 replicated-state facade 保留身份。在替换期间它们不可用：调用会失败而不是排队，且 state 会变为未 hydrate，直到完整的替代 snapshot 到达。

在旧 facet deactivation 开始之后，reload 没有回滚保证。失败的替换会使受影响的 service 不可用或降级。已被接纳的调用不会被自动 replay 或取消；caller 必须通过权威状态或稳定的 operation ID 来调和不确定的持久化结果。

### 形态变更与进程替换

更改 requirement、provision、模式、facet 成员关系或进程权威是结构性的。它需要新组装的图或普通的进程重启；`FacetHost.reload()` 有意拒绝它。

reload coordinator 位于它所替换的 facet 图之外，并遵循这些规则：

1. Reload 控制留在被替换的 facet 图之外。
2. 它选择一个期望的 source generation，然后独立加载受影响的 server、Session 与 presentation bundle。不存在聚合的跨进程 extension 对象。
3. 保持形态的 facet 使用既有的 host reload 原语。结构性变更在切换之前构建并校验候选图。Session 权威变更会停止旧 worker，并在打开替代者之前释放 Session 所有权。
4. host 可能在不同时间收敛，因此共享 service 契约与持久化记录必须容忍临时的 source-generation skew。
5. 失败会被报告，但不假装回滚已提交的 Session 记录、文件系统写入、subprocess effect 或已经切换的 host。

`ReplicatedState` 是 projection 而非 storage。替代 provider 从持久化 Session 记录、configuration 或另一个拥有的源重建权威状态，并发布一个完整 snapshot。必须比 worker 重启存活更久的 keyed 实例同样需要持久化应用记录，并作为全新的活动 generation 返回。provider 本地的 transport sequence 与 keyed generation 可以在重新绑定后重启，且从不是全局单调的。

恰好一个 worker 可以拥有一个打开的 Session。因此 worker 替换有一个路由间隙：

```text
old worker stops and releases Session ownership
→ selected Session remains logically selected but unavailable
→ replacement worker opens the Session and reconstructs services
→ server creates a fresh attachment binding
→ presentations hydrate fresh singleton and keyed snapshots
```

Reload 从不盲目重试被中断的 mutation。一个请求可能在其响应丢失之前已提交。持久化可恢复性属于 Harness 与应用契约，而不属于 facet cleanup。

## 连接丢失、错误与安全

从 facet 作者视角看的 disconnect 行为：

- **一个 presentation 断开。** 其 server 中止该 client 的活动请求，并关闭其已观察的实例 task 与其他 session 路由的资源。Session 拥有的工作按应用策略继续。已添加的 question dialog 保持 Session 拥有；断开的 presentation 失去其 proxy，任何进行中的 `submitAnswer()` 调用都会失败。
- **一个 Session worker 断开或崩溃。** 其 server 使被路由的进行中调用失败，并关闭该 worker 已观察的实例 task。在 server 连接保持健康的同时，已 attach 的 presentation 看到 `attachment.status === "degraded"`，因此目录仍可用，用户可以 attach 到别处。
- **一个进程失去其 server 连接。** 其已连接的 server 与 Session service 变为不可用。Session worker 会同时失去 server service 与所有已 attach 的 presentation；unattended-Session 策略决定它是否退出。
- Reconnect 与 reattach 总是从全新的权威 snapshot hydrate；先前的 keyed proxy 与 attachment 绑定的 frame 无效。**在不确定的 disconnect 之后绝不盲目 replay 一个 mutation**——replay 的 `select()` 无害，replay 的 `prompt()` 则不然。Reconnect、hydrate 并 reconcile，或者围绕一个具有显式查找语义的稳定 operation ID 设计该 operation。

错误作为 JSON envelope `{ code, message }` 跨越 wire，带有稳定的 protocol 与 service code。意外的异常变为 `internal_error`，且不暴露 stack。认证与应用错误使用已注册的稳定 code。

边界规则：

- 可远程发布的 service ID 来自受信任的已加载 service token；远程边界只接受实现 function 与 branded replicated-state member，实例 generation 由 host 拥有，且 `{ local: true }` service 从不可被远程发现；
- 业务参数、结果与 state 被校验为 JSON；protocol envelope 不能作为普通值被伪造；
- client 不能选择 context 位置、实例 generation、selected-Session routing 字段，或除自己请求之外的取消目标；以及
- 凭据、prompt、completion、tool 参数/结果与文件系统内容不会被暴露，除非显式契约允许。

## Host 组合

facet kernel 是 service 感知但与应用无关的。一个完整产品应为 server 权威、每个 Session worker 与每个 presentation 提供独立加载的 facet 集合。共享契约包含 service token 与 JSON 安全的 DTO；它们并不意味着提供方与消费方 facet 共享一个 bundle。

## 待定决策

在 extension 层成为规范之前：

- `Extension` 标识什么，以及它如何把一个版本映射到独立打包的 host facet；
- manifest/source-selection 格式、排序规则、package export 约定、信任策略与跨进程 version skew；
- 结构性图替换如何保持 host 控制并报告部分收敛；
- 具体的 scoped server、Session、TUI 与未来的 web 能力；
- 目录状态是按已认证 client 投影，还是全局 presentation 安全；
- 认证、授权、protocol 版本协商与预期应用错误注册；
- 可选的 service 依赖、multi-Session presentation、replicated-state flow control 与 gap recovery；
- 在 keyed service 覆盖具体功能之后，是否还需要 private returned reference；以及
- facet kernel、service RPC、coding-agent host 集成与 extension 契约之间的包边界。

## 必需测试

测试矩阵覆盖：

- 由 setup 派生的 provision 与 requirement、late-access guard、缺失与重复的 provider、模式校验、环、activation 顺序与逆序 disposal；
- 本地与已连接的 singleton 调用、token 驱动的发布、严格 JSON 值、keyed 实例 hydration、generation fencing、cancellation 与 selected-Session routing；
- 冷状态、snapshot/update 竞态、缓冲、update 顺序、disconnect cleanup 与完整替代 snapshot；以及
- static/combined loader，以及在保持形态的 provider reload 期间稳定的本地与 RPC singleton handle。

它还覆盖 extension 发现与隔离的进程特定 bundle 加载；结构性图重新组装与 reload 协调；保留逻辑选择与全新 attachment fencing 的 worker handoff；scoped host 能力与 contribution-registry 重建；已认证 routing 与遥测传播；keyed-provider 替换与 activation 失败；以及下文 question 与 collaborative diff review 示例。

## 协作式 diff review：持久化的共享 sidebar

diff review 始于 presentation，而非 tool invocation。用户要求 review 当前 working-tree diff；session 对其做 snapshot 并打开一个共享 review。每个已 attach 的 TUI 与 web presentation 都渲染相同的 patch 与 comment，任何已授权用户都可以添加 comment，或把整个 review 作为一个 prompt 提交。

这使用两种 service 模式：

```text
DiffReviewManager                         singleton service
  createReview()
    → persist immutable patch
    → add DiffReviews[reviewId]

DiffReviews[reviewId]                    keyed service
  document                               immutable patch state
  activity                               durable comments + status state
  addComment()                           commit, then publish
  submit()                               freeze, enqueue one prompt, close
```

keyed 实例是活动的、响应式的 projection。extension 拥有的 record 是持久化权威。pending comment 不是弱持久化的：每个已确认的 comment 都能在 worker 重启后存活，但该 record 在其 prompt 被持久化接受之后会被删除。

### 共享远程契约

```ts
interface DiffCommentInput {
	commentId: string; // stable across an uncertain retry
	path: string;
	side: "old" | "new";
	line: number;
	body: string;
}

interface DiffComment extends DiffCommentInput {
	author: { userId: string; displayName: string };
	createdAt: string;
}

interface DiffReviewDocument {
	reviewId: string;
	patch: string;
}

interface DiffReviewActivity {
	revision: number;
	comments: DiffComment[];
	status: "open" | "submitting";
}

interface DiffReviewManager {
	createReview(context: Context): Promise<void>;
}

interface DiffReviews {
	readonly document: ReplicatedState<DiffReviewDocument>;
	readonly activity: ReplicatedState<DiffReviewActivity>;
	addComment(input: DiffCommentInput, context: Context): Promise<void>;
	submit(context: Context): Promise<void>;
}

const DiffReviewManager = defineService<DiffReviewManager>("pi.diff-review-manager");
const DiffReviews = defineService<DiffReviews>("pi.diff-review");
```

client 从不提供 patch、author 或 review ID。session 计算一个有界的不可变 patch、创建 ID，并从 `Context` 中已认证的身份派生每个 author。`commentId` 只是幂等 key；它不授予任何权威。

### 狭窄的本地 durability 能力

与 question 不同，这种交互没有 invocation memo。Session facet 使用三个进程本地能力：一个对 working tree 做 snapshot 的 diff source、一个序列化 record mutation 的 review store，以及一个带幂等 `enqueueOnce()` 的 prompt queue。一个持久化 review record 包含不可变 patch、带版本号的 comment、status 与一个可选的冻结 `{ submissionId, prompt }`。这些本地能力是普通的 `{ local: true }` service；其 repository API 不属于该 extension 的共享契约。

`DiffReviewRecords` 按 review 序列化 mutation。`addComment()` 依据存储的 patch 校验锚点、标记已认证的 author、对 `commentId` 去重、提交，然后返回新的 revision。`freezeForSubmission()` 原子地排除后续 comment，并存储一个稳定的 submission ID 加上一个包含不可变 patch 与该精确 comment snapshot 的 prompt。如果 submission 已被冻结，它返回同一条 record。`PromptQueue.enqueueOnce()` 只在该逻辑 prompt 被持久化接受之后才返回；重试其 submission ID 无法入队第二个 prompt。

### 为什么 record mutation 需要 critical region

`DiffReviewRecords` 构建在 facet 的 scoped Session data（`values.md`）之上：extension 拥有的 namespace 中的类型化持久化值。每次 storage 调用都是原子的，但一次应用层的 read-modify-write 循环跨多个调用，因此也跨多个 await。并发的 service 调用可以在它们之间交错。

没有序列化时的具体失败——两个用户同时按下 submit：

```text
submit A: getValue(record)          → status "open"
submit B: getValue(record)          → status "open"
submit A: setValue(frozen, subm-A)
submit B: setValue(frozen, subm-B)  → overwrites A's freeze
→ enqueueOnce(subm-A) and enqueueOnce(subm-B) both run: two prompts for one review
```

每次 `setValue()` 都是原子的；而那个*循环*不是。在 `addComment()` 中，检查 status 与替换 record 之间也存在同样的窗口。

在单权威 worker 模型中，最简单的修复是 per-review 的 **critical region**：一个 FIFO、非重入的 async mutex，其 `run(signal, fn)` 一次接纳一个 pending function。每个读取并变更既有 review 的 operation——包括 `addComment()`、`freezeForSubmission()` 与 `complete()`——都对那个 review ID 使用同一个 region：

```ts
async freezeForSubmission(reviewId, context) {
	return regionFor(reviewId).run(context.abortSignal, async () => {
		const stored = await session.getValue(reviewRecord(reviewId), context);
		if (stored === undefined) throw new RemoteServiceError("review_not_found", `Unknown review: ${reviewId}`);

		const current = stored.value;
		if (current.status === "submission_pending") return current; // idempotent retry

		const submissionId = newSubmissionId();
		const frozen = {
			...current,
			revision: current.revision + 1,
			status: "submission_pending",
			submission: {
				submissionId,
				prompt: renderReviewPrompt(current.patch, current.comments),
			},
		};
		await session.setValue(reviewRecord(reviewId), frozen, context);
		return frozen;
	});
}
```

`revision` 由应用拥有，且按 review 单调。该 region 使 `current.revision + 1` 无歧义；session 全局的 storage `seq` 仍是 storage 排序元数据，且不被投影进 record。因此 `publish()` 可以直接比较返回的 record revision。

一个在排队时被中止的 caller 会从 FIFO 中移除，并在不调用 `fn` 的情况下 reject。一旦被接纳，该 region 会在 `finally` 中释放；取消与 storage 失败可能 reject 该 operation，而每个单独的 storage 转换仍是原子的。有状态校验留在 region 内，但用户交互与无关的 I/O 留在其外。一个 repository 方法不得调用另一个获取同一非重入 region 的方法，且在一个已完成的 review 没有 owner 或 waiter 之后，region entry 可以被丢弃。

要求是每个 review 一条可线性化的 read-modify-write 路径，而不特指 mutex。一个 storage compare-and-swap operation，或一个序列化 mutation 的 repository 能力，可以取代进程本地 region。持久化 settlement 幂等性（`memoOnce()`、`enqueueOnce()`）解决 record 转换之后的崩溃与重试行为；它不取代该转换本身的序列化。

### Session facet

Session facet 遵循一个简短的重建算法：

```text
activation
→ list pending review records
→ add one DiffReviews instance per record
→ publish document and activity state
→ resume any frozen submission through enqueueOnce()

createReview()
→ snapshot the diff
→ create the durable record
→ add its DiffReviews instance

submit()
→ atomically freeze comments and submission ID
→ publish "submitting"
→ enqueueOnce(submission ID, prompt)
→ delete the completed record and close the instance
```

每个 mutation 都在 `publish()` 之前提交。并发的 comment 与 submit 调用由 record repository 排序：先提交的 comment 会出现在冻结的 prompt 中；在 freeze 之后到达的 comment 会收到 `review_closed`。`complete()` 只删除匹配的冻结 record，且 `close()` 是幂等的。

启动扫描从持久化 record 重建每个打开的 keyed 实例。一条 `submission_pending` record 会通过 `enqueueOnce()` 恢复投递然后关闭。因此，在 prompt 被接受之前崩溃会重试该 prompt，而在接受之后、cleanup 之前崩溃会观察到相同的 submission ID，只完成 cleanup。

### TUI 与 web facet

该 extension 拥有其 TUI 与浏览器 widget。TUI 与 web facet 都 `observe(DiffReviews, ...)`。每个 observer 从 hydrated document 打开一个原生 panel，订阅 activity，把 comment 与 submit action 转发给 service，并在实例 context 中止时关闭该 panel。TUI 还注册一个调用 `DiffReviewManager.createReview()` 的 command；web 表面可以把同一 operation 暴露为一个按钮。

`observe()` 只在两个 state member 都 hydrate 之后才开始。panel 一次性接收不可变 document，而订阅 `activity` 会立即渲染当前 comment，无需在每次编辑时重传 patch。迟到的 client 看到同一个 pending review。`nextAction()` 等待期间，activity update 会继续。每个 sidebar action 携带一个由 presentation 创建的全新 `Context`；存活更久的 observation context 只控制 panel 生命周期。当 submission 关闭 keyed 实例时，每个 panel 的 observation context 都会中止，其 `finally` 块会 dispose subscription 与 widget。

提交的 prompt 在一个请求中包含不可变 patch 与所有冻结的 comment。简写为：

```text
Review this patch and address all comments:

<stored immutable patch>

- src/parser.ts, new line 42 — Armin: Preserve the original error cause.
- src/ui.ts, new line 18 — Jane: Keep this state visible after reconnect.
```

comment author 赋予 sidebar 基本的多人在场感。当前 viewer roster 或 cursor 会是单独的 live state，且不会被写入 review record。

这是一个共享 review，而不是通用的 room 原语。keyed service 提供发现与响应式生命周期；record repository 提供临时 durability；prompt queue 提供进入 session 的幂等 handoff。

## 推迟：基于 delta 的 replicated state

> **Deferred：** `DeltaState` 不属于初始 facet-service 或 RPC 契约。只有在某个具体功能证明全值 `ReplicatedState` update 过于昂贵，且同一模式出现在不止一个功能中之后，才添加它。

仍存在真实的复制缺口。某些权威值很大、变化频繁，且必须支持迟到的加入者。`ReplicatedState` 能正确 hydrate 与 reconnect，但每次 update 都发送一个完整的值。

canvas 是一个可能的例子：加入需要完整 document，而拖动一个 shape 理想上只应发送该 operation。用今天的原语，facet 必须接受完整的 `ReplicatedState` update，或把高频 projection 保持为进程本地。在添加另一个远程原语之前，某个具体功能应先确立 snapshot、delta、gap-recovery 与 flow-control 要求。

### 可能的未来原语

如果反复出现的实现证明值得抽取，未来的 `DeltaState<S, D>` 可以保留 `ReplicatedState` 的同步值与 snapshot hydration，同时在 hydration 之后投递类型化 delta。provider 只会暴露 `apply(delta, context)` 与 `replace(value, context)`；一个共享的纯 reducer 会更新 consumer replica。

共享 reducer 是纯的、确定性的。`apply()` 同步归约 provider 的值并发布一个 delta；`replace()` 发布一个新的权威 snapshot。业务 snapshot 与 delta 不包含 transport revision。host 在 provider binding 内打上 revision、缓冲与 hydration 竞态的 update、只应用连续的 frame，并在出现 gap 或 reconnect 之后请求一个新的 snapshot。

支持这一点需要一个显式的 RPC member kind。提供对象携带 `DeltaState` definition ID；provider 在 member 元数据中宣告该 ID；消费方 host 在本地应用 delta 之前解析同一个已导入的 definition。该契约只有与该注册及 hydration 协议一起才被采纳。

`DeltaState` 只会解决 live replication。它不会提供持久化 storage、mutation 序列化、multi-writer 合并、离线编辑或自动 mutation replay。一个持久化 canvas 仍会序列化自己的 mutation、在发布前持久化一个已接纳的 delta，并协调日志 compaction 与 append。持久化 log cursor 仍是应用/storage 元数据，且独立于 host 的 transport revision。
