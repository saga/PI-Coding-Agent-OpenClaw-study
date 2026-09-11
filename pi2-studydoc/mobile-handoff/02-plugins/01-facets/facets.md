# Plugin 与 Facet 架构

> **Status:** 设计规范。在两者不一致之处，取代 `plugins.md` 中的 facet/service 模型。
> 传输帧格式请阅读 `rpc.md`。

## 1. 系统的形态

一个 **plugin** 是一个最多有三个入口点的 package，每种 host 类型一个：

```text
my-plugin/
  contract.ts    service tokens + JSON DTOs         (shared, no host imports)
  server.ts      server facet                        (optional)
  worker.ts      session-worker facet                (optional)
  tui.ts         presentation facet                  (optional)
```

在运行时没有任何东西把这些入口点链接起来。它们只共享
`contract.ts` 中的 token。每一个都由 esbuild 构建成单个 JavaScript 文件，指向
那个入口。

一个 **facet** 是进程内单元：一个带有静态 manifest 的对象，外加一个
construct 函数。一个 **host** 是组装 facet graph 的进程——server、
session worker 或 presentation。

拓扑是一棵连接树：

```text
server
├─ TUI A
├─ web B
├─ session worker S0
└─ session worker S1
```

## 2. Token

一个 token 是 service contract 的身份。它携带 service 类型作为
phantom，携带其稳定的 ID、是否具备 RPC 能力，以及——关键地——它的 **mode**。

```ts
type ServiceMode = "singleton" | "keyed" | "peer";

interface Service<T, M extends ServiceMode = ServiceMode> {
  readonly id: string;
  readonly mode: M;
  readonly rpc: boolean;
  readonly __type?: T; // phantom
}

function defineService<T>(
  id: string,
  options?: { rpc?: boolean },
): Service<T, "singleton">;

function defineKeyedService<T>(
  id: string,
  options?: { rpc?: boolean },
): Service<T, "keyed">;

/** One instance per connected peer; each peer sees exactly its own. */
function definePeerService<T>(
  id: string,
  options?: { rpc?: boolean },
): Service<T, "peer">;
```

这三种 mode 的区别仅在于存在多少个实例，以及谁能看到它们：

| mode | instances | consumer 声明 | consumer 得到 |
| --- | --- | --- | --- |
| `singleton` | 一个，共享 | `uses` | 该 service |
| `keyed` | 多个，对所有人可见 | `observes` | 每个实例一个 task |
| `peer` | 每个已连接的 peer 一个，仅对该 peer 可见 | `uses` | 该 service |

`peer` 是 per-client state 的答案（§10.2）。它不是第四种机制——
host 按 peer 惰性地实例化，并且只向该 peer 通告——但
consumer 的人机工效很重要：从 client 一侧看恰好只有一个，所以它说
`uses` 并调用它，完全像一个 singleton。观察一组*集合*的实例正是
`observes` 的用途，而 per-client state 不是那个。

Mode 存在于 token 上，因为它是 contract 的属性，而不是
provider 做出的选择。这消除了整类组装错误：一个 token 不可能
被作为 singleton 提供却作为 keyed 消费，因为没有任何东西可声明。

Token 默认具备 RPC 能力。`{ rpc: false }` 把一个 token 限制在
其提供进程内；这类 token 从不被通告，也永远无法远程解析。

## 3. Facet

```ts
const modelSelectionTui = defineFacet({
  id: "@pi/model-selection:tui",

  uses:     [Models, Tui],
  provides: [],
  observes: [],

  construct(ctx) {
    const models = ctx.use(Models);
    const tui = ctx.use(Tui);

    tui.commands.register("models.select", async (context) => { /* ... */ });

    return [];
  },
});
```

三个声明字段，全是纯 token 数据，全都可以在不执行
任何东西的情况下读取：

- **`uses`** — 此 facet 所需的 singleton token。
- **`provides`** — 此 facet 实现的 token，singleton 或 keyed。
- **`observes`** — 此 facet 观察其实例的 keyed token。

`construct` 只在 kernel 验证了整个 graph 并
构造了每一个依赖之后才运行。`ctx.use()` 返回的一切都是**真实对象**，
绝不是稍后才变为有效的 proxy。不存在任何阶段让 facet
持有不可用的东西。

**`construct` 是同步的。** 它连接对象并返回 provisions；它不做
I/O。任何异步的东西都通过 `ctx.onActivate` 注册，它在
整个 graph 构造完成之后按依赖顺序运行。`ctx.onDeactivate` 在
disposal 之前按相反顺序运行。三个阶段，每个阶段只有一项职责：

| phase | 同步？ | 可以调用依赖？ | 目的 |
| --- | --- | --- | --- |
| `construct` | 是 | 否 | 连接对象，返回 provisions |
| activate | 否 | 是 | I/O、subscriptions、初始获取 |
| deactivate | 否 | 是 | disposal 之前的有序关闭 |

保持 `construct` 同步正是让顺序保证变得简单的原因：一个 facet
无法观察到一个只建了一半的 graph，因为在整个 graph 存在之前什么都不会运行。

### 3.1 为何不用副作用式声明

`plugins.md` 从同步的 `setup()` 期间所做的 `env.use()`/`env.provide()` 调用
推导出依赖 ledger。这避免了把 manifest 写两遍，但它
迫使 `use()` 返回一个断开的惰性 proxy——一个类型是谎言的对象，
直到组装完成。于是每个 facet 作者都必须记住一条语言
无法强制执行的规则。

把声明与构造分离的代价是每个 token 多提及一次，换来的
是：

- 在**零 facet 代码执行**的情况下进行 graph 验证——这对第三方
  plugin 是决定性的，坏的一组应当在运行之前就被拒绝；
- 整个 construct 过程中诚实的类型；
- 一个整体表面能在十秒内读完的 facet。

这种重复被类型检查（§4）消除，因此它不会漂移。

### 3.2 Construct context

```ts
interface ConstructContext<U, P> {
  /** Resolved singleton dependency. Only accepts tokens declared in `uses`. */
  use<S extends U[number]>(token: S): ServiceType<S>;

  /** Owner handle for a keyed token declared in `provides`. */
  owner<S extends KeyedOf<P>>(token: S): ServiceInstances<ServiceType<S>>;

  /** Host-built replicated state; see §9.2. */
  state<T>(definition: StateDefinition<T>, initial: T): MutableState<T>;

  /** Runs after the whole graph has constructed, in dependency order. */
  onActivate(fn: (context: Context) => void | Promise<void>): void;
  /** Runs before disposal, in reverse dependency order. */
  onDeactivate(fn: (context: Context) => void | Promise<void>): void;
}

interface ServiceInstances<T> {
  /** Invokes this facet's factory for `key`, registers it, announces it. */
  add(key: string): () => void;
}
```

`ctx.use()` 是带类型的查找，而不是位置元组或有名袋子：没有
凭空发明的标签，没有位置匹配，而传入未声明的 token 是
编译错误。

Owner handle 通过 `ctx` 到达，而不是被返回，因为它们是
kernel 拥有的机器，在 factory 存在之前就已存在。Construct 接收
依赖和它自己的 handle；它返回实现。

## 4. 返回类型与完整性

`construct` 返回一个 entry 数组，由两个辅助函数构建：

```ts
function provide<T>(token: Service<T, "singleton">, impl: T): ProvideEntry<typeof token>;
function provide<T>(token: Service<T, "keyed">, factory: (key: string, scope: InstanceScope) => T): ProvideEntry<typeof token>;
function provide<T>(token: Service<T, "peer">, factory: (principal: Principal, scope: InstanceScope) => T): ProvideEntry<typeof token>;

/** Instance-lifetime equivalent of the construct context's state(). */
interface InstanceScope {
  state<T>(definition: StateDefinition<T>, initial: T): MutableState<T>;
}

function watch<T>(
  token: Service<T, "keyed">,
  handler: (instance: Instance<T>, context: Context) => void | Promise<void>,
): WatchEntry<typeof token>;

interface Instance<T> {
  readonly key: string;
  readonly service: T;
}
```

返回数组中的 token 并集必须等于 `provides` 加上
`observes` 的并集——双向互相可赋值，这既给出
**完整性**（没有遗漏），也给出**没有多余**（没有未声明的东西）：

```ts
type TokensIn<R extends readonly Entry[]> = R[number]["token"];

type CheckComplete<R extends readonly Entry[], Declared> =
  [TokensIn<R>] extends [Declared]
    ? [Declared] extends [TokensIn<R>]
      ? unknown
      : { __error: "missing implementation for declared token" }
    : { __error: "returned an undeclared token" };

function defineFacet<
  const U extends readonly AnySingleton[],
  const P extends readonly AnyService[],
  const O extends readonly AnyKeyed[],
  const R extends readonly Entry[],
>(facet: {
  id: string;
  uses: U;
  provides: P;
  observes: O;
  construct: (ctx: ConstructContext<U, P>) => R & CheckComplete<R, P[number] | O[number]>;
}): Facet;
```

注意这是一个 token/value 对的数组，而不是对象映射。Token 是对象，
而对象不能作 key。String-ID key 会在 manifest 中的 token 与
construct 中的字符串字面量之间重新引入接缝；unique symbol 无法在
`defineService` 的返回类型中存活，会塌缩为普通的 `symbol` 并合并每一个 key。
在数组中把 token 与 value 配对，可以让每个 entry 分别针对
它自己的 token 类型化，并让完整性可检查。

> **Open:** `CheckComplete` 的错误消息人机工效需要实验。
> 失败会指向 construct 的返回类型，这是正确的但并不美观。

### 4.1 完整示例

```ts
export const questionSession = defineFacet({
  id: "@pi/question:session",

  uses:     [Tools],
  provides: [QuestionDialogs],   // keyed token
  observes: [],

  construct(ctx) {
    const tools = ctx.use(Tools);
    const dialogs = ctx.owner(QuestionDialogs);
    const pending = new Map<string, PendingQuestion>();

    tools.add((draft) => {
      draft.set("question", {
        /* ... */
        async execute(_id, params, _u, _tc, invocation, context) {
          const completion = Promise.withResolvers<QuestionResponse>();
          pending.set(invocation.invocationId, { params, completion });
          const close = dialogs.add(invocation.invocationId);
          try {
            return toResult(await awaitAbortable(completion.promise, context.abortSignal));
          } finally {
            close();
            pending.delete(invocation.invocationId);
          }
        },
      });
    });

    return [
      provide(QuestionDialogs, (key) => {
        const entry = pending.get(key)!;
        return {
          request: entry.state,
          async submitAnswer(candidate, _context) { /* memoOnce, resolve */ },
        };
      }),
    ];
  },
});
```

factory 接收 key 并闭包捕获 facet 私有的 state。`dialogs.add()`
触发它。Construct 仍然恰好运行一次。

## 5. 顺序与环

`uses` 和 `provides` 是静态的，因此 kernel 在
**运行任何 facet 之前**就计算出一个拓扑顺序。每个 facet 都在其所有
依赖之后被构造。失败——缺失 provider、重复 singleton owner、环——都
针对 manifest 报告，且不执行任何 facet 代码。

**facet 之间的环被拒绝。** 没有任何顺序能满足它们，而对
coding-agent 功能的调研没有发现真正的构造期环：tools 和
providers 通过 contribution registry 扇入；hooks 是 host 调用
你；telemetry 是叶子；wrappers 是有序组合。

看起来循环的情况是晚期的 *call-time* 引用，而不是构造
依赖。那些会得到一个显式、可见的逃生舱：

```ts
uses: [Tools, deferred(QuestionDialogs)]
// ctx.use(deferred(X)) returns () => X, resolved on first call, after assembly
```

延迟是选择性加入且罕见的，因此一个结的代价是局部且可读的，而不是
由每个 facet 以普遍不可用的 proxy 的形式来付出。

### 5.1 同一 facet 内的组合

一个 facet 的 service 共享模块和闭包作用域。两个互相需要
的 service 就是普通的 JavaScript：在 construct 内构建两者，手工连接引用，
把两者都返回。共享的私有 state 是两者都闭包捕获的一个变量。Kernel
不参与其中，也不存在 facet 内部的 graph。

如果一个 facet 中的两个 service 对称地互相需要，那通常是一个
有两个面的 service，或者一个私有对象藏在两个 facade 之后。

## 6. Host、连接与权限的方向

**一个 host 只能依赖它所连接的东西，而连接构成一棵树。**
这一条规则取代了任何全局排序，并让跨进程 graph 保持无环，
而无需把 server 特殊化为「本来就在那里的内建物」。

每个 host 本地排序。远程 provisions 是**叶子**——上游进程在
通告之前已经构造了它们，所以按定义它们已经得到满足。

具体来说：

- 一个 **session worker** 连接到 server，因此 worker facet 可以 `use` server
  token。这是必需的：一个 `spawn_subagent` tool 需要 server 的 session
  管理。
- 一个 **presentation** 连接到 server，因此 TUI facet 可以 `use` server token。
- 一个 presentation 也消费 **session** service——但从它的
  视角看 provider 是 server，由 server 路由。当一个 session 被 attach 时，
  server 的 catalogue 就直接增长。

不存在直接的 presentation↔worker 连接。

### 6.1 server 从不依赖 worker

server 必须在任何 worker 存在之前构造，因此它不能 `use` 一个 worker
service。反向的流使用一个 **reporting registry**：server 提供一个 token，
worker 向其中推送。

```ts
// contract.ts
export interface SessionStatusReporting {
  report(status: SessionStatus, context: Context): Promise<void>;
}
export const SessionStatusReporting =
  defineService<SessionStatusReporting>("pi.session-status-reporting");

export interface SessionStatusView {
  readonly state: State<Record<string, SessionStatus>>;
}
export const SessionStatusView =
  defineService<SessionStatusView>("pi.session-status");
```

worker `uses` reporting token 并推送；server 聚合到
replicated state 中；presentations 读取聚合结果。依赖仍然指向
上游，数据向下流动。

这免费地让生命周期变得正确：聚合立即存在且
为空；worker 出现、注册、消失；一个崩溃的 worker 是一次 entry 移除，
而 server 已经知道这件事，因为它拥有该连接。

## 7. Facet 的投递与 generation

**一个 presentation 发布时不带任何 plugin facet。** 它有 host service（`Tui`）以及
别的什么都没有。所有 plugin facet 都作为已构建的 bundle 通过网络到达。

这化解了一个处于 detached 状态的 presentation 持有未解析
需求的问题：在 detached 期间没有需求，因为没有
facet。

两种 generation，具有不同的生命周期：

| generation | 来源 | 生命周期 | 示例 |
| --- | --- | --- | --- |
| **connection** | server | server 连接 | session picker |
| **attachment** | session worker | 一个 attachment | question dialog、chat |

切换 session 只会拆除并重建 attachment generation。
picker 全程保持运行——它必须如此，因为它正是触发
切换的东西。

attachment generation 针对 connection generation 解析（按 §6
上游优先）。反向是被禁止的：一个 connection-generation facet 不能
依赖一个 attachment-generation token，因为 attachment 可能消失。

### 7.1 为何由 worker 选择 presentation facet

Plugin 可以是**全局的**，也可以位于某个 session 的**工作目录**中。因此
TUI facet 的集合取决于 TUI 在何处启动——同一个二进制，不同
项目有不同的能力。

因此 worker 知道哪些 TUI bundle 属于它，并在 attach 时
通过 server 把它们送达。工作目录不仅仅是一个 spawn 参数；它是
graph 的一个输入。

> **Security:** attachment-generation bundle 是从项目目录到达并在
> 用户的 presentation 进程中执行的第三方代码。针对目录本地 plugin 的信任策略
> 是一个未决决定，必须在此项发布
> 之前敲定。

## 8. 启动与握手

### 8.1 Presentation 连接

```text
TUI → server: connect
server → TUI: catalogue of server RPC provisions + connection-generation bundles
TUI: assemble, validate, construct connection generation
```

### 8.2 抵达一个 session

三条路径，汇聚到同一个 attach：

| 调用 | 路径 |
| --- | --- |
| `pi`（裸命令，在某个目录中） | 请求 server 为 cwd 创建一个 session |
| `pi --resume` | 在启动时调用 picker command |
| `pi --session <id>` | 直接 attach |

`--resume` 不需要特殊机制：picker 是一个由 server 来源的 picker facet 注册的
普通 command，而 resume 在启动时调用它，而不是
等待一次按键。两条路都是同一条代码路径。

Create 携带工作目录，因为 server 需要它来 spawn，而
worker 需要它来解析本地 plugin。

### 8.3 Attach

```text
TUI → server:   attach(sessionId)
server:         authorize; tear down previous attachment generation;
                bind routing to worker
server → worker: client attached (identity)
worker → server: catalogue of session RPC provisions + TUI bundles
server → TUI:    catalogue + bundles
TUI:             assemble, validate, construct attachment generation
worker/server:   hydrate state state values
```

TUI 的 kernel 验证一次，此时 worker 的 catalogue 已在手中。
不存在临时的或降级的解析状态。

### 8.4 Worker 启动

```text
worker → server: connect
server → worker: catalogue of server RPC provisions
worker:          load global + cwd-local plugins; assemble; construct
```

worker 自身对 server token 的依赖在这里解析，在任何 attachment 之前。

## 9. Replication 原语

恰好有三样东西跨越一个连接。

### 9.1 Service 调用

普通的请求/响应。用于 actions（`select`、`submitAnswer`）以及对
不变事物的单次读取（向上滚动回聊天历史）。没有任何东西
被复制。参数和结果是严格 JSON；`Context` 被
proxy 剥离，并在端点重建。

### 9.2 Replicated state

一个权威 writer，多个 reader。流携带一个 base op batch，随后是 delta batch；词汇表见 [delta.md](../../01-harness/01-delta/delta.md)。

Full-value replication 是退化配置，其中 producer 在每次更新时显式替换或 rebase。它不是单独的原语：Chord 发出根替换 op `r`。

#### State 就是普通 TypeScript

Facet 从不写 op。Provider 正常地修改它的 state 对象；
框架的 tracker（`delta.md`）记录 intent 并发出 op。

```ts
// contract.ts
export const TranscriptState = defineState<TranscriptTail>("pi.transcript.tail");
```

```ts
const tail = scope.state(TranscriptState, initial);

tail.mutate((s) => {
  s.entries.push(entry);            // -> splice
  s.entries[0].text += chunk;       // -> append
  delete s.pending;                 // -> delete
});
```

没有 mutation map，没有 recipe，没有声明的 operation，没有 Immer。也不存在
`defineValueState` / `defineReducedState` 的划分——更早的草稿需要
它，因为 reduced state 携带了 differ 无法恢复的 typed delta，而
tracker 能恢复它们。

`mutate` 是同步的，且不接受 `Context`。一次 mutation 是一次纯 state
转换：它不调用任何东西，不能被取消，也没有 caller identity 可供
查询。Authority 在决定 mutate 的那个方法中被检查。

#### Op 从不携带 provider 代码

Consumer 应用 op。它们从不看到 mutation name，也从不运行 provider 代码。

这一点有特定的重要性：运行 provider 代码的 consumer 将不得不
从一个 registry 解析 definition，使 fold 依赖于环境
注册——一次 reload 会为相同输入改变答案。Op 消除了这一点，
并让非 JS 的 consumer 变得轻而易举，因为 applier 只有六个动词。

后果：

- mutation name 不是 wire contract 的一部分，也不出现在任何 member table 中，
  因此不存在 mutation-name 的版本偏斜；
- consumer 不需要参数的 schema，只需要根 `r` op 中 value 的 schema；
- `x = undefined` 归一化为 `delete`，因为 JSON 没有 `undefined`。

#### Wire protocol

producer 和 applier 使用 `Op[]`；一个 subscription 携带编码后的 `WireOp[]`。没有 frame type，payload 中也没有 `seq`：SSE binding 盖上 `id:`，那才是 transport
metadata 该待的地方（`delta.md` §6）。

`Op` 及其编码——六个动词、数组路径、元组形式、二次使用路径 interning——在 [delta.md](../../01-harness/01-delta/delta.md) §2 和 §4 中规定。此处不再重述。

**一次替换就是一个 op**，`["r", value]`。没有 frame discriminator。首个 op 为 `r` 的 batch 是一个 **base batch**，而 batch zero 永远是其中之一。这合并了 `plugins.md` 分开处理的几件事：

- 不存在独立的 wire hydration 形态——snapshot 就是第一个 batch；
- snapshot 缓冲仍是本地 adapter 细节，而不是第二个 wire protocol；
- cold start、reconnect、provider reload、session switch、序列间隙，以及一个
  无法应用的 fold 都是**同一条代码路径**：发送一个全新的 base batch。

最后一项就是本设计中任何地方都没有 `Rebase` 类型的原因。

SSE `id:` 由 host binding 盖上，在每次
subscription 时从零开始，并且是连续的。看到间隙的 consumer 会丢弃它的 replica 并
重新订阅。

#### 重新订阅是一个 base batch 加上缓冲的 batch

不存在跨 subscription 的 resume，也没有 `Last-Event-ID`。重新订阅的工作方式
与 harness 已经分发 lane state 的方式相同：把当前 value 快照为
base batch zero，在 client 追赶期间缓冲到达的任何东西，然后在它就绪后把缓冲作为普通 batch 送达。

这与 `AgentHarness.watch` 是同样的两阶段形态——先是 `snapshot`，然后
是 `start`——而且它纯粹是 provider binding 的本地细节，在 wire 上不可见。
Consumer 看到一个 base batch 之后跟着连续的 batch，与 cold start 时完全一样。

真正的 resume 需要一个保留的 op log，这样 client 就能请求「seq N 之后的一切」。我们刻意不保留一个：durable form 是每个 *value* 的 batch 列表（[delta.md §9](../../01-harness/01-delta/delta.md#9-durable-form)），随其 scope 一起退役，而不是每个 subscription 的历史。缓冲在握手期间耗费有界的内存；op log 则会永远耗费无界的磁盘。

已落地的 tracker 在没有 serialized-size 启发式的情况下发出结构性 op。Provider 替换、reconnect 和策略驱动的恢复边界会显式调用 `replace()`/`rebase()`；那些是根 `r` batch 的唯一来源。

#### Harness 不发出 op

harness 发出带类型的 `HarnessEvent`，并且永远如此。Op 出现在上一层。

一个 lane facet 在进程内调用 harness，订阅 typed event，并通过
普通 mutation 把它们 fold 进**它自己的** state 形态。tracker 把那变成
op。facet 从不写 op，也从不考虑路径。

这个 fold 无论如何都必须存在，因为**replicated shape 是 facet 的
选择，而不是 harness 的**。从 harness 发出 op 不会移除
这个 fold；它只会把「event 进入 state」替换为「op 进入 state，且类型更糟」，
并且会让 `LaneSnapshot` 的字段布局成为 wire contract。

```ts
// packages/agent/src/harness/runtime/reducer.ts
export function reduceLaneSnapshot(view: LaneView, event: HarnessEvent): void;
```

普通 mutation，没有 Immer，没有返回值。见 `harness-tools.md` §6。

#### 塑造 state 以避免写放大

两条规则，都是 tracker 记录 intent 的后果：

- **让增长的 string 保持在稳定的路径上**——每个 content block 一个，每个 tool
  operation 的输出一个。这样一次 delta 恰好触及一个路径，这也正是
  让 path interning 把它塌缩为单个整数的原因。
- **replicated state 中没有派生字段。** 从原始值重新计算出的解析值
  在每次解析时都是新引用，因此它作为 whole-value `set` 发送，
  并重复已经存在的信息。改为按需派生
  （`message-update.md` §5.2）。

一个 content block 数组是可以的：当一个 block 出现时它消耗一次 `splice`，
之后就没有了。此后变化的是 block *内部*的一个 string。

#### 请求一个 state value

Provider 在 `construct` 期间请求 host 构建 state value。Facet 从不
自己构造一个，因为 state value 是一个 binding：host 拥有它的
subscriber table、revision stamping 和 disposal。

```ts
interface State<T> {
  readonly value: T | undefined;                    // undefined until base batch zero
  subscribe(listener: (value: T) => void): void;   // returns nothing (§13)
}

// on ConstructContext and InstanceScope
state<T>(definition: StateDefinition<T>, initial: T): MutableState<T>;
```

Provider 一侧：

```ts
export const transcriptSession = defineFacet({
  id: "@pi/transcript:session",
  uses: [Agent],
  provides: [Transcript],
  observes: [],

  construct(ctx) {
    const agent = ctx.use(Agent);
    const tail = ctx.state(TranscriptState, { entries: [] });

    agent.onEntry((entry, context) => {
      tail.append([entry]);
      if (tail.value.entries.length > TAIL_LIMIT) {
        tail.evict(tail.value.entries.at(-TAIL_LIMIT)!.id);
      }
    });

    return [
      provide(Transcript, {
        tail,
        page: (params, context) => archive.read(params.before, params.limit, context),
      }),
    ];
  },
});
```

一次 `mutate()` 调用推进权威 value **并且**发布由此产生的 op——一条语句，所以 value 和 wire 不可能不一致。`replace()` 发布一个显式的根 `r` batch，是 reconnect、provider reload、resnapshot 以及策略驱动的恢复边界所使用的东西。

Consumer 一侧：

```ts
export const transcriptTui = defineFacet({
  id: "@pi/transcript:tui",
  uses: [Transcript, Tui],
  provides: [],
  observes: [],

  construct(ctx) {
    const transcript = ctx.use(Transcript);
    const tui = ctx.use(Tui);

    transcript.tail.subscribe((tail) => render(tail.entries));   // base batch zero arrives here too
    tui.commands.register("transcript.older", async (context) =>
      render(await transcript.page({ before: oldestId(), limit: 100 }, context)),
    );

    return [];
  },
});
```

consumer 从不看到 opcode。它接收 value，而 base batch zero 作为普通更新送达——因此没有单独的「ready」callback，也没有
facet 代码中的 hydration 分支。

#### 完整示例：适配 `AgentHarness.watch`

真实的 API 全程是异步的：

```ts
interface AgentHarness {
  lane(name: string, context: Context): Promise<AgentLane>;
  lanes(context: Context): Promise<LaneInfo[]>;
}
interface AgentLane {
  watch(context: Context): Promise<WatchHandle<LaneSnapshot>>;
}
interface WatchHandle<T> {
  snapshot: T;
  start(listener: EventListener): void;
  resnapshot(context: Context): Promise<T>;
  unsubscribe(): void;
}
```

`watch()` 在单个 `readLane` 临界区**内**安装 subscription **并**捕获
snapshot，所以两者是在同一把锁下取得的。在 `start()` 之前到达的
event 被缓冲，然后 flush。`resnapshot()` 做同样的事，并用一个
`markBoundary()` callback 重新确立流在何处恢复。那正是
base batch zero 所需要的保证，所以 adapter 很薄。

`LaneSnapshot` 是按 lane 的，所以 `Lane` 是 keyed——每个 lane 一个实例，各自
取自己的 `watch()`。harness 已经按 lane 过滤
（`event.type === "usage" || !("lane" in event) || event.lane === this.name`），所以
adapter 不做任何路由。

因为 `watch()` 是异步的，**instance factory 可以是异步的**。实例在
factory resolve 后被通告；`add(key)` 立即返回它的 closer。

```ts
export const Lane = defineKeyedService<LaneView>("pi.lane");   // key = lane name

export const laneSession = defineFacet({
  id: "@pi/lane:session",
  uses:     [Harness],
  provides: [Lane],
  observes: [],

  construct(ctx) {
    const harness = ctx.use(Harness);
    const lanes = ctx.owner(Lane);

    ctx.onActivate(async (context) => {
      for (const info of await harness.lanes(context)) lanes.add(info.name);
    });

    return [
      provide(Lane, async (laneName, scope, context) => {
        const lane = await harness.lane(laneName, context);
        const handle = await lane.watch(context);          // phase 1: snapshot + subscribe
        // The facet's own shape, not LaneSnapshot. reduceLaneView is its code.
        const state = scope.state(LaneState, toLaneView(handle.snapshot));

        handle.start((event) => {                          // phase 2: buffered, then live
          if (event.type === "navigation_end") {
            void handle.resnapshot(context).then((fresh) => state.replace(toLaneView(fresh)));
            return;
          }
          state.mutate((v) => reduceLaneView(v, event));   // plain mutation; ops fall out
        });

        return { snapshot: state, setModel: (ref, ctx2) => lane.setModel(ref, ctx2) };
      }),
    ];
  },
});
```

Consumer 声明 `observes: [Lane]` 并获得每个 lane 一个 task，每个都有自己的
replica。

有四点值得注意。

- **`watch`/`start` 握手不跨越 wire。** 它是一个 adapter 的本地
  细节。远程 consumer 看到 base batch zero，然后是 op。Mini 的缓冲之舞
  消失了，因为 harness 已经在两个阶段之间缓冲，而 flush
  作为初始 value 之后的普通 mutation 落地。
- **facet 拥有 replicated shape。** `LaneView` 是 facet 的，而不是
  harness 的——因此有 `toLaneView`。这就是上面提出的观点：fold 无论如何
  都存在，所以 harness 自己发出 op 什么也得不到。
- **Rebase 从不到达 consumer，也不是一个类型。** `navigation_end` 是一个
  普通 event，adapter 用 `resnapshot()` 加上 `replace()` 来回应——
  与重连的 client 收到的是同一个 base batch。`markBoundary()` 提供
  顺序。没有 reducer 通过返回 value 来发出任何信号。
- **`HarnessEvent` 不是 wire format。** 今天的 `message_update` 携带完整
  message *以及*一个持有第二份拷贝的 `AssistantMessageEvent` *以及* delta，
  所以发送它会比发送 snapshot 更糟。见 `message-update.md`。
  它在这里从不发送，因为 travel 的是 op。
- **这个 union 的大部分已经是 lane state。** `usage` fold 进 `stats.usage`；config
  的 `value_update` 进 `configuration.*`；`message_update` 进
  `operation.streamingMessage`；`tool_start`/`tool_update` 进
  `operation.runningTools`；retries 进 `operation.retry`。state value 几乎
  就是 presentation 所需要的一切。

那三个**不**属于它的东西是对 §9.4 的一个有用检验：

| event | 为何不是 mutation | 它去哪里 |
| --- | --- | --- |
| `lane_created` | 创建一个 lane，而不是改变一个 | `lanes.add(name)`——一个新实例 |
| `handler_error` | 诊断性的；没有迟到的加入者需要它 | events 原语 |
| 全局 `value_update` | 不是 lane 作用域的 | 拥有该 value 的 service 上的 state |

注意 `lane_created` 是在 lane event stream 上送达的，所以在启动之后发现
新的 lane 需要一个 session 级别的 watch，而不是上面那些按 lane 的 watch——
这是 §16 中的一个未决问题。

#### Host 的职责

以下一切都是 host 机器，而不是 facet API：

- 在 provider binding 内为每个 batch 盖上 `seq`，这样业务 snapshot 和 op 不携带 transport metadata；
- 在一个全新 subscription 上，在 delta 之前送达一个根 `r` base batch；
- 在该 base batch 上重置每个 subscriber 的 encoder dictionary；
- 只应用连续的 batch，并在间隙、reconnect 或 provider 替换之后请求一个全新的 base batch；
- 在 value 跨越边界时加固它们（§14.3）；
- 在 member table 中通告 state value definition ID。Mutation name
  **不**被通告，因为它们从不 travel——op 是结构性的，所以 consumer
  不需要知道 value 是如何产生的。

两条规则源自 provider 和每个 replica 运行同一个 fold：

> **一个 reducer 的 state 必须是 replicated value 的一部分。** 任何在
> 它旁边累积的东西——经典情形是一个被增量解析的原始 JSON string——
> 在任何没有运行 producer 的 fold 的 consumer 上都会发散。

> **durable path 只使用 host 拥有的 reducer。** Plugin 解释的数据必须是
> 可跳过的，这样不可读的流会降级那一个 value，而不是让包含它的
> 记录失败。

Mutation-name 版本偏斜不存在：mutation 从不跨越边界，所以
添加、重命名或移除一个是破坏性变更。版本偏斜的暴露面
仅仅是 *value shape*，由根 `r` batch 的 schema 描述。

宁可要几个粗粒度的 state value，也不要一个大的 value。一个 cold replica 的
`value === undefined`；那是本地就绪状态，从不跨越 wire。

### 9.3 Events

Fire-and-forget 广播。没有历史，没有 durability，在断开时丢弃。用于
presence、cursor、进行中的拖拽、瞬态通知。

### 9.4 该用哪个

> **一个迟到的加入者需要它吗？**
> 是 → replicated state。否 → event。

State：transcript、model catalogue、session status、chat tail、canvas document。
Events：谁在打字、某人的 cursor 在哪里、一次未提交的笔画。

### 9.5 完整示例：chat，以及 tail/archive 的划分

一个 chat room 不是一个 state。它沿着同样的界线划分：

- **live tail**——最后 N 条消息作为一个 state value。第一个 batch 用
  该窗口替换；append 和 eviction 是 op。
- **archive**——一个普通 service 调用，返回一页更旧的消息。不可变
  历史，没有 liveness 要求，不复制到任何东西上。

没有 `subscribe` 方法。附加到 state value *就是* subscription，而它
产生 snapshot，所以 server 在读取之前就注册了 reader。这
关闭了 query 与之后 subscribe 之间的窗口，并意味着 server 永远
不必回答「在一个任意的 client 提供的 cursor 之后发生了什么」——那是
client 选择的时间戳所制造的那一类竞争。

lane transcript 是同样的模式：最近的 entry 在 state value 中，更旧的
在用户向上滚动时通过 query 获取。

### 9.6 完整示例：共享 canvas

Document state 是一个 state value；strokes 是 op。多 writer 通过
**带确认的乐观应用**来处理，而不是 CRDT：

1. client 生成一个 op ID，在本地作为未确认应用，发送它；
2. server 按先到先得接受，并发布由此产生的 op；
3. client 看到自己的 op ID 返回，并将其提升为已确认。

注意这是 `delta.md` 背后的单 writer 假设被
放宽的唯一一处，而且它是通过在 server 处串行化而不是通过合并来放宽的。
op 词汇表没有 `test` 动词，正是因为
没有需要支持的冲突模型。

进行中的拖拽从不触碰 document。它们是 events，按 peer 键控，
最新者胜，在断开时丢弃——这正是 events 原语
存在的原因。

## 10. Peer、principal 与 authority

### 10.1 context 上的 principal

每个 service method 已经接受一个 `Context`。proxy 在出去的路上剥离它，
并**在端点重建它**，因此 kernel 会从已认证的连接中
填入 caller 的 principal。它是 control-plane 数据：永远不是
参数，永远不可伪造。

```ts
type Principal =
  | { kind: "local" }                                   // same process, full authority
  | { kind: "user"; peer: PeerId; userId: string; role: Role }
  | { kind: "process"; peer: PeerId; host: "worker" | "server"; sessionId?: string };

interface Context {
  readonly abortSignal: AbortSignal;
  readonly principal: Principal;
  // ...
}
```

恰好只有一个 `Context` 类型，而 `principal` 总是被填充——
本地和跨连接都是同一个接口，所以一个 method body 读取
`context.principal` 而无需知道是哪种情况。这正是要点：一个 service 必须
不能有一条只在进程内出现的未检查路径。

Peer 不仅仅是人——一个通过 reporting registry 调用 server 的 worker
也是一个 peer，而 server facet 常常想区分*我自己的 worker*
与*某个 TUI*。进程内调用携带一个显式的 `local` principal，而不是一个
缺失的 principal，所以一个缺失的检查不能伪装成一个缺失的 peer。

### 10.2 Per-peer service

**携带 authority 的 state 属于一个 `peer` service，而不是一个 singleton。** 一个
singleton 按定义只有一个 value，所以它无法向 owner 和 guest
展示不同的 root——这个差异无处安放。

Provider 把 token 声明为 `peer` 并返回一个 factory。Host 为每个已连接的
peer 调用它一次，传入该 peer 的 principal，并只向
该 peer 通告结果。每个实例从它自己的 `scope` 获得自己的 state value。

Consumer 在 `uses` 中声明它并调用它。没有 `observes`，没有 reconciliation，
没有要 watch 的集合——从 client 一侧看恰好存在一个实例，因为恰好
只有一个曾被通告给它。

### 10.3 完整示例：文件浏览

```ts
// contract.ts
export interface BrowseRoot {
  readonly handle: string;   // opaque, per-principal, revocable
  readonly label: string;
}

export interface BrowseView {
  readonly roots: BrowseRoot[];
  readonly note?: string;    // e.g. "Ask the owner for wider access"
}

export const BrowseState = defineState<BrowseView>("pi.browse.view");

export interface FileBrowsing {
  readonly view: State<BrowseView>;
  list(handle: string, path: string, context: Context): Promise<DirEntry[]>;
}

export const FileBrowsing = definePeerService<FileBrowsing>("pi.file-browsing");
```

Server facet：

```ts
export const fileBrowsingServer = defineFacet({
  id: "@pi/file-browsing:server",

  uses:     [Fleet],
  provides: [FileBrowsing],
  observes: [],

  construct(ctx) {
    const fleet = ctx.use(Fleet);

    return [
      provide(FileBrowsing, (principal, scope) => {
        // One table per instance. Handles are minted here, so a handle a peer
        // was never given is not merely rejected — it does not exist for them.
        const table = new Map<string, string>();

        function publish() {
          const roots = rootsForPrincipal(principal, fleet).map((path) => {
            const handle = newHandle();
            table.set(handle, path);
            return { handle, label: labelFor(path) };
          });
          return roots.length > 0
            ? { roots }
            : { roots: [], note: "No browsable locations for this account" };
        }

        const view = scope.state(BrowseState, publish());

        return {
          view,

          async list(handle, path, context) {
            const root = table.get(handle);
            if (root === undefined) throw new ServiceError("forbidden", "unknown root");
            return readDirectory(root, path, context);
          },
        };
      }),
    ];
  },
});

function rootsForPrincipal(principal: Principal, fleet: Fleet): string[] {
  if (principal.kind === "local") return [ROOT];
  if (principal.kind === "user" && principal.role === "owner") return [ROOT, ...fleet.workspaces()];
  if (principal.kind === "user") return fleet.workspacesFor(principal.userId);
  return [];
}
```

TUI facet——注意它完全不包含权限逻辑：

```ts
export const fileBrowsingTui = defineFacet({
  id: "@pi/file-browsing:tui",

  uses:     [FileBrowsing, Tui],
  provides: [],
  observes: [],

  construct(ctx) {
    const browsing = ctx.use(FileBrowsing);
    const tui = ctx.use(Tui);

    tui.commands.register("files.browse", async (context) => {
      const view = browsing.view.value;
      if (view === undefined) return;

      if (view.roots.length === 0) {
        await tui.notify(view.note ?? "Browsing unavailable");
        return;
      }

      const root = await tui.select(
        "Browse",
        view.roots.map((r) => ({ label: r.label, value: r })),
        { signal: context.abortSignal },
      );
      if (root === undefined) return;

      let path = "";
      for (;;) {
        const entries = await browsing.list(root.handle, path, context);
        const chosen = await tui.select(
          root.label,
          entries.map((e) => ({ label: e.name, value: e })),
          { signal: context.abortSignal },
        );
        if (chosen === undefined) return;
        if (!chosen.isDirectory) return void open(root.handle, join(path, chosen.name));
        path = join(path, chosen.name);
      }
    });

    return [];
  },
});
```

owner 的 `view` state 同时携带一个 machine root 和 workspace root；guest 的
携带一个或零个。同一个 bundle，同一条代码路径，不同的数据。TUI 从不
按 role 分支，从不把任何东西置灰，也无法构造一个它
未被给予的 handle。

### 10.4 Server 侧验证仍然是强制的

state 支配渲染。它不约束 wire：一个敌意的 client 可以
用任何参数调用任何 method，包括它从未收到过的参数。

因此 `list()` 会针对该实例的 table 检查它的 handle。宁可要
**不可伪造的 handle，而不是解析过的路径**——table 查找按构造就会失败，
而路径验证会招来 `..`、symlink、归一化和大小写折叠的 bug。
撤销是免费的：丢掉 entry，未结清的 handle 就停止工作。

当某个参数不能是 handle 时，method 读取 `context.principal` 并
做决定。规则是 authority 在 provider 处被检查，每一次都是，无论
client 之前被展示过什么。

### 10.5 peers cell

Presence 是 host 提供的 replicated state：

```ts
export const ConnectedPeers =
  defineService<{ readonly state: State<Record<PeerId, Principal>> }>("pi.peers");
```

Server 和 worker facet 读取它来枚举谁被 attach。一个 facet 只有
在真正多 peer 的功能中才需要它——一个 presence 名册、一个「3 viewers」徽章。
Per-peer state **不**需要它，因为 `peer` mode 为你处理实例化和
teardown。

### 10.6 Keyed instance

`keyed` 保持它一直以来的样子：多个实例，对每个 consumer 都可见，
每个在 `observes` 下产生一个可中止的 task。Question dialog 是
典型情形——三个并发的 invocation 产生三个实例，而每个
已 attach 的 presentation 看到全部三个。

一个实例由 `(service, key, generation, member)` 寻址，所以它的 state value
天然是 per-instance 的。复用一个已关闭的 key 会创建一个新的 generation，所以陈旧的
proxy 无法寻址替代者。

要理清的区别：

- **我想要全部吗？** → `keyed` + `observes`。
- **我想要我的吗？** → `peer` + `uses`。


## 11. Presentation 表面

`Tui` 是一个普通的 singleton token，在 `uses` 中声明，并通过
`ctx.use` 像其他任何 token 一样解析。它由 presentation kernel 提供，而不是
由 plugin 提供，所以它位于本地排序的根部，但 facet 无法分辨
其中的区别。

```ts
interface TuiHost {
  readonly slots: SlotContributions;
  readonly commands: CommandContributions;   // handlers take an AbortSignal; see §11.3
  readonly keybindings: KeybindingContributions;
  readonly toolRenderers: ToolRendererContributions;
  notify(message: string): Promise<void>;
  acquireModal(signal: AbortSignal): Promise<TuiModal>;
  select<T>(title: string, items: SelectItem<T>[], options: { signal: AbortSignal }): Promise<T | undefined>;
}

const Tui = defineService<TuiHost>("pi.local.tui", { rpc: false });
```

### 11.1 Slots

一个 slot 是 host chrome 的一个具名区域，facet 可以填充它。

```ts
interface SlotContributions {
  /** Exclusive. A second claim on the same slot is an assembly error. */
  claim<P>(slot: string, factory: (props: P) => Component): void;
  /** Additive. Ordered by contribution order. */
  add<P>(slot: string, factory: (props: P) => Component): void;
}
```

```ts
ctx.use(Tui).slots.claim("footer", (props) => new FooterComponent(props, models));
```

`claim` 是排他的，重复是一个 **assembly error，而不是 last-write-wins**——
两个 plugin 静默地争夺 footer 是一个必须在验证时浮现的 bug，
与缺失 provider 和重复 singleton 并列。

Props 是 DTO。一个 factory 从不接收 `TUI` 或 `Theme` 实例，所以一个
component 无法通过它自己的参数反向触及 host 内部。

### 11.2 Mounting 由 host 拥有

Facet 不做 mount 或 unmount。它们贡献一个 factory；host 实例化它，
把 mount 与贡献它的 facet 关联跟踪，并在 disposal 时
**unmount 它**——为被 claim 的 slot 恢复内建 chrome，或为
additive 的 slot 丢弃该 entry。

因此 contribution 上没有 `dispose?()`，也没有供 facet 作者
遗忘的 teardown。这与 §13 是同一条规则：registration 就是 ownership。

从 §7 的 generation 模型可以推出两个后果：

- **Attachment drop**——消费 session service 的 presentation facet 被
  dispose，所以它们的 mount 消失，host chrome 在它们的 slot 中渲染。只有
  connection-generation 的 chrome 读取 attachment state。
- **Session switch**——attachment-generation facet 被 dispose，它们的 mount
  随之而去；connection-generation 的 mount 存活，所以没有闪烁，也
  没有丢失的滚动状态。

### 11.3 带 in-flight 工作的 contribution

§11.2 覆盖了*移除*：host 把每个 mount 与贡献它的 facet 关联跟踪，
并在 disposal 时 unmount，所以没有要遗忘的 teardown。对于任何
disposal 是同步的东西，那是完整的。

对于在 contributor 被 dispose 时可能**正在执行**的 contribution，它是不完整的
——那是 in-flight tool call 在 presentation 侧的对应物
（§13.2）。三种情况，只有一种是难的。

**同步 callback 是免费的。** 一个 keypress handler、一次 render 调用、一个 click
listener。JavaScript 是单线程的，所以一个 handler 在 disposal 被调度之前
就会运行到完成——disposal 无法与一个同步帧交错。
注销就是一次列表移除。不需要更多东西，而这占了
表面的大部分：slots、keybindings、tool renderers、theme tokens。

**Modal 和 picker 已经携带一个 signal。** `acquireModal(signal)` 和
`select(title, items, { signal })` 接受一个 `AbortSignal`，因为 host 可能需要
关闭它们。Disposal 中止它，promise reject，而 facet 的
`await` 展开。机制已经存在；disposal 只需要使用它。

**Async command handler 是难的那种情况**，它们正是换了件外衣的
tool call：

```ts
ctx.use(Tui).commands.add("deploy", async (args, signal) => {
  await longRunningThing(signal);
});
```

用户运行 `/deploy`，十秒后 facet 被 dispose，而 handler
仍在 await。所以 `CommandContributions` 是一个带 in-flight 工作的 registry，
并采用与 tool registry 相同的四个阶段：deregister、signal、race
kernel deadline，并按结果 settle——在这里是关闭任何 progress UI，
恢复 host chrome，而不是产生一个 `ToolResultMessage`。

对 API 的两个后果：

- **一个 command handler 接收一个 `AbortSignal`。** 不是可选的。没有它，
  registry 可以 deregister 但无法 signal，阶段 2 就不可用。
- **由 host 渲染 command progress，而不是 facet。** 如果一个 facet 绘制它自己的
  progress 并在 command 中途被 dispose，绘制会活得比绘制者更久。Host 拥有的
  progress 随 mount 一起被移除，这是把 §11.2 的规则应用到一个 §11.2
  没有点名的情形。

这推广到的规则：

> 一个 contribution registry 需要 settlement 机器，**当且仅当**一个 contribution 可能
> 在 disposal 期间处于执行中。同步 contribution 永远不可能；任何
> 被交给 `AbortSignal` 的东西总是可能。

这让 signal 成为标记。一个 contribution 接受 signal 的 registry
拥有 invocation tracking 和一个 deadline；contribution 不接受 signal 的则是一个普通
列表，disposal 就是一次移除。

### 11.4 Reload

Reload 就是 unload 加 load，所以 mount 由同一条路径拆除并重建。
跨 host 的 reload 是两阶段的，所以没有任何 facet 会带着一个已死的 provider 存活：

```text
1. server → presentations with dependent facets: dispose, ack
   (the provider is still ALIVE, so in-flight calls abort against a live peer)
2. server → session worker: dispose + reload
3. server → presentations: load
race(acks, 2s); a presentation that misses the window goes degraded,
which disposes those facets anyway.
```

调用携带一个 caller generation，provider 丢弃已退役的。因为
一次 reload 是对每个已连接 presentation 的一次往返，它保持由用户发起——
它绝不能被接到一个 file watcher 上。

## 12. Contribution registry

Service 是一个 owner、多个 consumer。Provider 和 tool 反转了这一点：多个
contributor、一个 host 拥有的结果。一个 registry 在一个全新的工作副本上
重放有序的 contribution，所以移除是一次重建，而不是一次逆向 mutation。
（与 `delta.md` 中的 tracker 无关；这里没有任何东西被复制。）

```text
fresh working copy
→ built-in providers      (@pi/providers-builtin)
→ remote catalogue        (@pi/providers-catalog)
→ models.json transform   (@pi/providers-models-json)
→ auth/availability mark  (@pi/auth)
→ validated state
```

Tools 另外支持有序包装——`telemetry(permission(sandbox(bash)))`
——当一个 contributor 消失时它会确定性地重新组合。只有 host
才 finalize 一个 draft；facet 从不调用 `setTools()`。

Slots、commands、keybindings 和 tool renderers（§11）都是这同一种
形态在 presentation host 上的实例。

**Registry 按一个 contribution 是否可以处于 in flight 来划分。** 一个
contribution 是 value 的 registry——slots、keybindings、theme tokens、tool renderers——是一个
列表，disposal 就是一次移除（§11.2）。一个 contribution 是
*被调用并接受 `AbortSignal`* 的 registry——tools、commands——拥有 invocation tracking、一个
从 caller 的 signal 链接而来的 signal，以及针对 kernel 的 disposal
deadline 的 settlement（§13.2）。contribution 签名中的 signal 是
它属于哪一种的标记。

Contribution 配置被重建的行为；hook 拦截实时的 operation。它们
保持为分开的机制。

## 13. 生命周期、失败、disposal

- 按依赖顺序 construct；按相反顺序 dispose。
- 一个 facet 拥有它的 provisions、keyed instance 和 observation。Ownership 是
  **隐式的**：facet 收到的每个 handle 都是一个 host 构建的 binding，
  它注册自己的 disposer，所以 `subscribe`、`on`、timer 和 instance handle
  随 facet 一起释放。没有 `own()`，也没有任何东西需要记住。
  这覆盖 host 交过来的 handle；它不覆盖 facet 可以在没有被交给
  任何东西的情况下触及的 ambient authority（§14.3）。
  因此 `subscribe()` 不返回任何东西——没有 unsubscribe handle 可供
  持有或泄漏。
- 已准入的 inbound call 可能在其 provider 正在 deactivate 时完成；withdrawal
  拒绝新的调用。
- 断开连接会中止 in-flight 请求，并关闭该 peer 的 subscriptions 和
  instance task。它**不得**执行 service 拥有的或 durable 的取消。
- 三个取消域保持区分：per-invocation、service 拥有的
  （`job.cancel()`）以及 durable Harness（`requestAbort()`）。
- 在一次不确定的断开之后绝不要盲目重放 mutation。Reconnect、
  hydrate、reconcile——或者围绕一个稳定的 operation ID 来设计。
- 错误以带稳定 code 的 `{ code, message }` 跨越；意外的异常
  变成不带 stack 的 `internal_error`。

Reload：当替代者声明了一个完全相同的 manifest 时，按 `Facet.id` 的保形替换
是被允许的。因为 manifest 是静态的，这个
检查发生在构造候选者**之前**——相比通过运行 setup 来验证
形态，这是一个真正的改进。结构性变更需要 graph 重新组装或
进程重启。

### 13.1 Teardown，而非替换

替代方案是为每个依赖者一个 proxy，在 consumer 背后替换实现，
这样它们永远不会被拆除。它被拒绝，而先例
异常清晰。

**OSGi 两者都提供。** Bundle refresh 计算与旧 export 相连的
一切事物的传递闭包并重启它；Declarative Services 还提供
`ReferencePolicy.DYNAMIC`，其中 consumer 在替换期间保持运行。他们自己的
指南把 `STATIC` 作为默认，因为 dynamic 要求每个 consumer 对
service 在调用中途消失保持防御姿态。

**Cordis 是 proxy 模型，而其人机工效显露无疑。** `ctx.get(name)` 在缺失时
返回 `undefined`，而指南是*「处理它们的缺失」*——
防御性检查是被推荐的路径。`inject` 选择*加入* teardown：plugin
进入等待，并在 service 返回时被重新激活。

**JS HMR 是本设计加一个补充。** 更新沿着 import graph 向上传播，
直到某个模块调用 `import.meta.hot.accept()`；如果没有东西 accept，则完整 reload。
当 hook 签名变化时，React Fast Refresh 放弃并转向完整 reload——这是
从不同方向得出的同一个结论：实现替换能存活，形态
变更不能。

**Erlang 是反例，而它不可迁移。** 两个模块版本
共存，`code_change/3` 在转换时迁移 state。这之所以有效，是因为
contract 是消息而不是类型，所以一个进程可以在切换期间处理两种形态，
也因为隔离意味着没有共享 state 需要
协调。这两点在这里都不成立。

三个具体的反对意见，按严重程度递增：

**Contract 变更。** JVM HotSwap 只允许 method body；DCEVM 和 JRebel
走得更远，但在形态变化时仍然会崩。我们比它们任何一个处境都好，
因为 token 的 `protocol` block 携带一个 TypeBox schema，而 `CheckComplete`
已经做了互相可赋值——所以一次替换*可以*以新
provider 的 schema 双向可赋值为门控。这是我们真正
能回答的那一个反对意见。

**In-flight registration。** 由旧 provider 贡献的一个 tool 可能
正处于执行中。它不能被取消（副作用已经发生）、不能被移交
（不同的闭包），也不能被允许 settle 进一个不再包含
它的 registry。一个 proxy 帮不上忙：invocation 绑定到启动它的那个
实现上。无论如何都需要 §13.2，这也是 proxy 几乎
毫无收益的主要原因。

**State。** 这是没有答案的那一个。一个 facet 持有从旧 provider 的
流派生出的 replica。在一次替换之后，它要么是陈旧的——静默地错误——要么
新 provider 发送一个 base batch，而那*就是*一次重新订阅。state 被拆除了；
只是 facet 没有。Erlang 用一个显式的迁移 hook 解决这一点，那
是 Erlang 的设计却没有 Erlang 的隔离。

**缓存的引用让 proxy 更糟，而不是更好。** Cordis 的守卫存在于
访问路径上，而不是 value 上：如果 service 不在了，`ctx.foo` 会抛错，但你
存储的一个引用会继续工作，并调用进已死 plugin 的闭包。我们的
`ctx.use(Token)` 按设计在 construct 时返回一个 value，所以我们有同样的
危险——而拆除依赖者正是让它安全的东西，因为持有者
随 provider 一起死去。Proxy 不能修复缓存的引用；它让它们静默地
错误，而不是不可能。

> **推迟，而非采纳。** 如果 teardown 有一天被证明太粗粒度，补充物是
> HMR 的 `accept()`，而不是 OSGi 的动态策略：一个 per-dependency 的选择加入，
> `uses: [Harness, accepts(Models)]`，意思是*我的获取可以被重新指向，我
> 不从该 provider 派生任何 state，并且我不对它持有任何 in-flight registration*。
> 只有当 schema 检查通过时 kernel 才会允许替换，
> 否则静默回退到 teardown。**Teardown 必须保持为那条
> 永远有效的路径**；一旦 `accepts` 对正确性变得关键，每个
> consumer 就又开始写防御性代码了。
>
> 在构建它之前值得测量 teardown 的成本。如果 dispose 一个
> presentation facet 就是一次 repaint，这个机制什么也买不到。

### 13.2 带 in-flight 工作的 disposal

Disposal 移除一个 registration。对一个 service 而言这足够了，对一个
contribution 可能在其 contributor 离去时正在执行的 registry 而言则**不够**。

起决定作用的约束是 settlement，而不是 cleanup：harness 欠模型一个
它为每次调用启动的 `ToolResultMessage`。「facet 走开了」不是一个
结果，而一个等待它的 operation 会挂起。

两个参考系统都没有解决这一点。Cordis 的 `_unload` 是
带 try/catch 且没有 deadline 的 `await Promise.all(disposers)`——一个
挂起的 disposer 会让 reload 挂起。DSH 走得更远，把义务放在 tool
作者身上：async 工作必须*「观察或转发 `exec.signal`，并且只在」*
达到*「静默」*之后才 settle，registry 随后重新检查取消。那
是 Cordis 缺失的 settlement 概念，但它只是以散文形式陈述，且没有
任何东西强制执行，所以一个忽略自己 signal 的 tool 仍会卡住 unload。

**四个阶段，而后两个是两个系统都没有的：**

1. **Deregister。** contribution 立即离开 registry。同步、
   廉价，且它阻止问题增长。
2. **Signal。** 中止每个 in-flight invocation。
3. **Race 一个 deadline。** 由 kernel 施加，作用于每个 disposer。
4. **按结果 settle。** 到期时 registry 用一
   个已中止的结果 resolve *它自己的* promise，并放弃 contributor 的，挂上一个 catch 并丢弃
   该引用。harness 看到一个普通的已中止 invocation，而它现有的
   `abortedMessage` 路径产生结果。没有新的 settlement 机器。

阶段 4 是让 deadline 变得安全、而不是一个多了几步的泄漏的原因：**
invocation 会 settle，即使 contribution 不会。**

**分层。** kernel 知道 facet 和 contribution，而不知道 invocation，所以它
泛化地约束 disposal：每个 disposer 得到一个 deadline，而一个超时的
会被记录并丢弃。一个带 in-flight 工作的 registry 是让那个 deadline
有意义的东西，因为只有它知道有一个调用尚未结清。

signal 是 **registry 拥有并从 harness signal 链接而来**的，从来不是
harness signal 本身——所以 deregister 一个 tool 会中止该 tool 的 invocation，
而不会取消 operation。DSH 的警告*「替换不能脱离
caller 的取消」*正是关于这一点；链条必须是单向的。

**Invocation tracking 属于 registry，而不是 contributor。** 一个 facet 可以
跟踪它自己未结清的调用并给它们 signal，但那样一个有问题或敌意的 facet
就完全没有边界。每个 invocation 已经路由经过 registry，所以它
可以持有 signal 和计数，而无需信任任何人。

**这个 deadline 实际保证了什么，诚实地说：** disposal 在有界时间内
完成，且 kernel 之后不持有任何引用。**不是**说该 bundle
被回收了。如果被放弃的 contribution 有一个 live interval、一个打开的 socket，或
一个待处理的子进程，它自己的 async 工作仍引用该闭包，而
compartment 保持存活。我们可以约束我们自己的保留；我们无法约束 runtime 的。
唯一真正的修复是进程隔离，其中 teardown 就是一次 kill——这就是为何
Erlang supervisor 终止而不是协商，也是为何 OSGi `refresh` 会
在一个不肯停止的 bundle 上挂起。

## 14. 隔离与信任

精简版；完整的论述在 isolation spec 中。此处记录是因为它
约束了上面的 API 表面。

### 14.1 威胁模型

**一个恶意 server 把一个 facet 发送给一个毫无戒心的 client。**

§7 声明一个 presentation 发布时不带 plugin facet，而所有
facet 都作为已构建的 bundle 通过网络到达。所以第三方代码在用户
进程中执行是设计使然，而连接到一个 server 并不等于同意运行它的代码。
受害者是*用户*，连同他们的文件系统、他们的凭据、他们的 SSH key——
而不是 operator。

更早的草稿把它限定为「一个粗心的 plugin 作者，而不是敌意的」，
并明确把坚定的攻击者排除在范围之外。**那是错的**，而且它
选错了机制。攻击者是敌意的，投递是远程的，而
目标是一台工作站。

**Availability 不在范围内。** 一个恶意 server 本来就可以拒绝服务、
挂起或发送垃圾；让 client 崩溃是其中的一个子集。必须被
阻止的是**磁盘访问和数据外泄**。

这种不对称决定了下面若干事项，也是这一节比一个一般的 sandboxing
论述更短的原因。

### 14.2 机制：string-only membrane 背后的 V8 isolate

Facet 代码运行在一个 `isolated-vm` isolate 中。是实测行为，不是推断——
见 sandbox PoC：

```
require / process / fetch     undefined
globals visible               64
Function("return process")()  undefined
spinning guest                interrupted at its timeout, isolate reusable after
```

**什么被拒绝了，以及为什么。**

*SES / `lockdown()`*——更早的草稿选择了这个。它加固了 intrinsics，但
把 guest 和 host 留在**同一个 VM** 中，而这正是 Figma 的
Realms shim 失败的那一类：「把一个来自 sandbox 外部的对象与一个
来自内部的对象混淆……之所以可能，是因为 shim 对内部和外部的
所有代码都使用同一个 JavaScript VM」。Figma 发布了 Realms，在两个月内
就被攻破，然后迁移到不同的 VM。选择 SES 是重复他们的第一次尝试。

*Node `worker_threads`*——`terminate()` 是真正的 kill（在紧密循环上 3 ms），
但一个 worker 拥有完整的 `fs`、`env` 和 `child_process`。Node 的 `--permission` 模型
确实在 worker 内部生效，但 Node 把它记录为一个**「安全带」**，
「恶意代码可以绕过」，而且它不按 worker 继承。Availability
而没有 authority 对这个威胁模型来说是错的那一半。

*Deno workers*——`permissions: "none"` 给出真正的 per-worker authority 削减，
已验证。但 `terminate()` **不能**停止一个空转的 worker：在 terminate 之后
测得 3 s 墙钟时间内消耗了 2990 ms CPU。而且它是一次 runtime 切换。

*QuickJS-WASM*——一个真正不同的 VM，所以对象混淆不可能发生，
而且它是 Figma 发布的东西。基于两项测量被拒绝：**慢 8–17×**（300
个 markdown 组件重绘需要 1118 ms 对 108 ms），以及**没有 `Intl`**，而
`packages/tui` 在每次宽度计算中都需要它来做 grapheme 分段。它
仍是 native addon 不可接受时的回退方案。

*ShadowRealm*——同一个线程、同一个 VM，而它自己的说明文档否认自己是「一个
应对安全问题的全谱系机制」。对这个目的而言不是
继任者。

**membrane 是让 `isolated-vm` 安全的东西，而且它是结构性的。**

`isolated-vm` 可以被不安全地使用，而更早的草稿正是因此拒绝它：
通过 `derefInto()` 把一个 live handle 交给 guest，或从一次 host 调用
返回一个 `Reference`，让 guest 沿着该对象的 prototype chain
走入 host realm。（该草稿还把该项目称为「maintenance mode」——
那是过时的；发布从 2025 年 7 月的 6.0.1 一直到 2026 年 8 月的 7.0.1。）

membrane 通过构造而不是通过小心谨慎来排除它：

1. `encode()` 是从 host 到 guest 的唯一路径，它是带
   replacer 的 `JSON.stringify`。**它的输出是一个 string。** 一个 string 无法携带引用。
2. Host 可调用对象从不跨越。它们变成进入一个 host 侧 table 的整数 id。
   guest 收到的是一个 **number**。
3. 到达 guest 的 `Reference` 恰好只有**一个**——即唯一的 call-in 点——而
   它的 `deref()` 跨 isolate 抛错。
4. `derefInto()` 只用一次，作用于 guest **自己的** global。任何 host 对象都
   从未成为它的参数。

guest 对 host 的全部视野就是 `{ number, string }`。没有对象
图，因此没有东西可遍历。已审计：`deref`、`copySync` 和 `getSync` 全部
被阻止；`derefInto()` 产生一个惰性标记，它不可调用，也不暴露任何
host global。

**一个 isolate，N 个 context**——不是每个 facet 一个 isolate。Context 给出分开的
global，而一个 context 上的 timeout 让其他的继续运行。它们共享一个
`memoryLimit`，所以一个 facet 的分配炸弹会 dispose 该 isolate 以及其中的每个
context——这在这里无关紧要，因为 availability 不在范围内
（§14.1）。成本差异是真实的：**每个 context 164 KB 对每个
isolate 1124 KB**。

一个必须比它的邻居活得更久的 facet——作为 facet 运行的 host chrome——
采用它自己的 isolate。那是一个 per-facet 的决定，而不是全局决定。

**值得知道的限制。**

- **预算不嵌套。** 一个 timeout 只约束一次求值。一个 guest function
  被 *host* 重新进入——一个 contribution callback、一个 component method——得到的
  是它自己的预算，而不是外层的预算。约束 facet 的总时间需要单独的
  计账。
- **引用会释放，但是惰性的。** membrane 用 `WeakRef` 加上一个
  `FinalizationRegistry` 按 id intern，这既在跨越时给出 identity，
  也在回收时释放。Finalization 并不及时，所以**不要在
  hot path 中创建引用**：在 construct 时注册的一个 factory 是一个引用
  直到永远；一个每帧返回新闭包的 component method 则是每
  帧一个。
- **Native addon。** Prebuilds 覆盖 linux-x64/arm64、darwin-arm64 和 win32-x64，
  仅限 Node 22 和 24；其他任何情况都回退到需要 Python 和一个
  toolchain 的源码构建。发布 SEA builds 会把这一点从每个用户的安装过程
  转移到 CI。
- **仍然是一个引擎。** 一个独立的 isolate 是远比 SES 更强的边界，
  但它不是 Figma 的「不同 VM」主张。这里的保证是 V8 的 isolate
  边界加上 membrane 的纪律。

### 14.3 Ambient authority 击败 registration-is-ownership

§13 声明 facet 收到的每个 handle 都是一个 host 构建的 binding，
它注册自己的 disposer，所以没有什么需要记住。这对 host
*交过来*的 handle 成立。它对 facet 可以在**没有**被交给任何东西的
情况下触及的 authority 什么也没说：`setInterval`、`process.on`、
`document.addEventListener`、一个 WebSocket。

Registration-is-ownership 是 API 表面的一个属性，而它的完整程度
只与表面的排他程度一样。当一个 facet 有另一种方式触及
外部世界时，disposal 就回到了作者纪律——正是 §13.1
批评 Cordis 的那个立场（*「不要假定 unload 会自动移除任意的
第三方 callback」*）。

我们能把它做得多完整是**不一致的**，假装不是这样会是
错误的那种整洁。

**Session 和 server facet：可封闭，而这为 compartment 提供了论据。** 它们
今天在 Node 中运行并拥有完整的 ambient authority——一个 facet 可以 `import` timers、`fs`、
`net`。在一个没有模块访问权限的 compartment 内部，唯一的 global 是我们
赋予的那些，所以一个注册自己 disposer 的、被赋予的 `setTimeout` 是*唯一的*
`setTimeout`。这是一个真实的论据，支持把上面的未决问题解决为
对 session facet 进行 compartment 化，理由是 ergonomics 而非 trust。

**TUI：出于同样的原因可封闭。** 一个 presentation facet 已经获得一个
compartment（§14.2），并且只通过 `TuiHost` facade 触及终端。
没有可抓取的 ambient 终端。以同样的方式赋予 timer，表面就
是排他的。

**Web：不可封闭，而值得明确说明为什么。** DOM 是一个
可以从*其中任何一个节点*触及的 ambient 可变 graph。把一个 element 交给一个
component，它就拥有 `ownerDocument`、`parentNode`、`window`——并从那里
得到 `addEventListener`、`MutationObserver`、一个比它的 mount 活得更久的
detached subtree。`lockdown()` 帮不上忙：逃逸不是一个 prototype，而是一个我们
刻意交出去的 live 对象图。

有两种机制能真正封闭它，而两者的代价都超过这个问题目前
值得的：

- **每个 facet 一个 iframe。** 真正的隔离，`postMessage` 边界，teardown 就是
  移除该 frame。VS Code 对 webview 就是这样做的。代价是没有共享 DOM：
  样式、布局和焦点全都变成协议。

  Figma 走得更远，值得研究，因为它是
  「让表面排他」的最强形式。他们按*能力*拆分：plugin 逻辑运行在
  带 scene graph 且**完全没有 browser API** 的 QuickJS-on-WASM 中，而 UI
  运行在带 browser API 且**没有 scene 访问权限**的 iframe 中，通过
  `postMessage` 连接。Plugin 代码从不触碰 DOM——不是「被 sandbox 的 DOM 访问」，
  环境中没有 `document`。这正是让他们能保证 cleanup 的原因。

  从他们的历史中有两点可以汲取。他们先发布了 **Realms**，而它在两个月内
  被发现不安全，这与 §14.2 引用来拒绝 `isolated-vm` 的是同一逃逸
  类别——是生产证据而非推断。而
  QuickJS 的代价是真实的：实践者报告*「真正无法穿透的错误」*以及
  严重退化的调试体验，§14.2 在把 QuickJS 命名为升级路径时
  应当权衡这一点。正如有人所说，sandboxing 是一件*「每个人都想要，但
  真正有效的例子却少之又少」*的事情。
- **仅声明式 component。** facet 从不接收一个 node——它返回一个
  描述，由 host 进行 reconcile。§11.1 已经指向这个方向（*「props 是
  DTO；一个 factory 从不接收 `TUI` 或 `Theme` 实例」*），把它扩展
  到*从不接收 DOM node* 会成立。但它排除了 ref，因此也排除了
  大多数值得使用的 component 框架。

**所以规则是：让安全的路径成为容易的路径，并且不要假装逃逸
已被封闭。**

提供会注册自己 disposer 的 `ctx.dom.on(el, event, fn)` 和 `ctx.timer.every(ms, fn)`，
并让它们成为做这件事的显而易见的方式。§14.1 的威胁
模型是一个*粗心的*作者，而不是敌意的，而一个粗心的作者会使用
符合人机工效的路径。逃逸仍然可达；只是它不是你掉进去的那一个。

在表面可以被做成排他的地方——session、server、TUI——用 endowment
来强制执行它，而不是依赖人机工效。在不能的地方——web——记录下
facet 作者自己拥有他们的 DOM cleanup，并把 iframe 视为升级
路径，如果威胁模型有一天从粗心转向敌意的话。

这与 §14.2 的 isolate 决定是同样的形态：采用适合
当前威胁模型的机制，点出更强的那个，并记录什么会触发
迁移到它。

### 14.4 对 API 的后果

隔离不改变 §3–§4 中的形态，但它固定了三件否则
会是约定的事情：

- **Ownership 是隐式的。** facet 收到的每个 handle 都是一个 host 构建的 binding，
  它注册自己的 disposer。因此没有 `own()`，而 `subscribe()`/`on()`
  不返回任何东西——没有 unsubscribe handle 可持有，因此也没有
  可泄漏的。本地 `{ rpc: false }` service 是例外：它们交回原始
  实现，没有拦截，也没有自动 disposal。
- **一个 binding 返回的每个对象本身就是一个 binding**——host 构建、普通
  prototype、已加固、注册自己的 disposer。这是让前一点
  传递性成立的 invariant。
- **借用的不可变 JSON 是被强制执行的，而不是被建议的。** Value 在跨越边界时
  被加固，如果未冻结则被拒绝，所以 §9 的 no-clone 规则是安全的，
  而不是一个写在文档里的希望。

  这**不**延伸到 replica 的内部 buffer。来自 `delta.md` 的 `apply`
  就地修改一个普通对象，并且会对着一个已冻结的对象抛错，所以 host
  让 replica 保持可变，只加固它通过 `State.value` 交给 facet 的
  value。冻结发生在 binding 处，而不是 buffer 处。同一条规则
  支配 producer 一侧：tracker 代理一个可变对象并加固
  它所暴露的东西。

Facet 以把 `await` 编译为 generator 的方式构建，所以 host 拥有恢复权。
于是 disposal 停止三样不同的东西，其中没有任何一个涵盖其他：
取消该 scope 的根 context（停止 **operation**），展开 driver
（停止 **continuation**，运行每一个 `finally` 而不运行 `catch`），然后按相反顺序
释放 registration（停止 **effects**）。

Endowment 是最小的：`Date` 和 `Math` 被替换为基于时钟的版本，
timer 返回不透明的整数并且归 scope 所有，`process` 和 `console` 是
只有形态的 stub，而 `fetch`、`Buffer`、`require` 和 `process.exit` 从不
被赋予。**网络访问是一个 binding，从来不是一个 endowment。**

## 15. Protocol：把 service 暴露给外部 client

以上一切都假设两端是针对相同 token 编译的 TypeScript。
一个浏览器、一个脚本或另一种语言做不到这一点——它需要一份它
能获取的描述。

**Schema 是选择加入的，并且按 service。** 大多数 plugin 从不暴露任何东西，也不付
任何代价。一个没有 `protocol` block 的 service 只是进程内和 native-RPC 的：它
不在 catalogue 中，而 HTTP router 返回 `no_such_member`。

### 15.1 声明一个 protocol

```ts
import { object, array, string, int, oneOf, literal } from "@pi/schema";

export const TranscriptEntry = object({
  id: string(),
  role: oneOf([literal("user"), literal("assistant")]),
  text: string(),
});
export type TranscriptEntry = Static<typeof TranscriptEntry>;

export const TranscriptState = defineState<TranscriptTail>("pi.transcript.tail", {
  schema: object({ entries: array(TranscriptEntry) }),
});

export interface Transcript {
  readonly tail: State<TranscriptTail>;
  page(params: { before: string; limit: number }, context: Context): Promise<TranscriptEntry[]>;
  subscribeRaw(sink: (e: TranscriptEntry) => void): Unsubscribe;
}

export const Transcript = defineService<Transcript>("pi.transcript", {
  protocol: {
    methods: { page: { params: object({ before: string(), limit: int() }),
                       result: array(TranscriptEntry) } },
    state:   { tail: TranscriptState },
  },
});
```

`page` 和 `tail` 被发布。`subscribeRaw` 不在 `protocol` 中，所以它是
本地的——没有任何东西标记它，以后发布它意味着添加一个 entry。

只有 state **value** 需要 schema，用于根 `r` batch。Mutation 不需要，
因为 recipe 从不离开 provider（§9.2），而 op 是结构性的。

Method 参数是单个对象，而不是位置参数。这样名称会存活到
TypeScript 签名、存活到作为 `properties` 的 JSON Schema、存活到 request body，
而添加一个可选字段不会改变 arity。

`@pi/schema` 把 TypeBox 构造函数重新导出为自由函数，以便声明保持
可读。它们是函数而不是常量，因为 TypeBox schema 是可变
对象，而一个共享常量会别名进每一个引用它的 schema。

### 15.2 protocol 必须与类型匹配

一个偏离 interface 的 schema 是本设计存在的目的所要防止的失败，
所以它被检查，使用与 `CheckComplete` 相同的互相可赋值技术（§4）：

- `protocol.methods` 中的每个 key 都必须存在于 service interface 上——一个拼写错误是
  编译错误，而不是一个被静默地不发布的 member；
- 对每一个，`(params: Static<P>, context: Context) => Promise<Static<R>>` 必须
  可赋值给 interface member，反之亦然；
- `protocol.state` 中的每个 key 都必须是一个 `State<T>` member，其 `T` 与
  definition 的 value schema 匹配。

省略永远是合法的。省略就是这个特性。

### 15.3 路由

```
GET  /v1/catalogue
POST /v1/call/{service}/{member}
POST /v1/call/{service}/{key}/{member}          keyed instance
GET  /v1/state/{service}/{member}               SSE
GET  /v1/state/{service}/{key}/{member}         SSE
```

`peer` service 不接受 key：server 从已认证的
session 解析实例，所以 client 无法寻址另一个 peer 的（§10.2）。

**Catalogue**

```json
{ "version": "1",
  "services": {
    "pi.transcript": {
      "mode": "singleton",
      "methods": { "page": { "params": { "$ref": "#/definitions/PageParams" },
                             "result": { "type": "array",
                                         "items": { "$ref": "#/definitions/TranscriptEntry" } } } },
      "state": { "tail": { "value": { "$ref": "#/definitions/TranscriptTail" } } }
    }
  },
  "definitions": { "TranscriptEntry": { "type": "object", "properties": { "...": {} } } } }
```

**Call**

```
POST /v1/call/pi.transcript/page
{ "before": "entry_88", "limit": 50 }

200 { "result": [ { "id": "entry_87", "role": "assistant", "text": "..." } ] }
403 { "code": "forbidden", "message": "unknown root" }
404 { "code": "no_such_member" }            ← unpublished members land here
422 { "code": "invalid_params", "message": "limit: expected integer" }
```

**State over SSE**

```
GET /v1/state/pi.lane/main/snapshot
Accept: text/event-stream
id: 0
event: ops
data: [["r",{"lane":"main","transcript":[],"operation":null}]]

id: 1
event: ops
data: [["p",["transcript"],12,0,[{"id":"e12"}]]]

id: 2
event: ops
data: [["a",["operation","streamingMessage","content",0,"text"],"Sure, I"]]
```

`id` 由 binding 盖上，而不是在 payload 中携带。第一个 batch
总是一个 base batch，所以 hydration 不是
一条单独的路由。`Last-Event-ID` **不**被尊重：`seq` 在每次
subscription 时重启，而重新订阅是一个 base batch 加上缓冲的 batch（§9.2）；一个间隙、一个未知 id 和一次 provider reload 都走那同一条路径。一个
已关闭的 keyed instance 以 `event: closed` 结束流，而 client 不
重试。

一个外部 client 只需要 [delta.md §2](../../01-harness/01-delta/delta.md#2-ops) 的六个 op——`replace`、`set`、`delete`、`append`、`truncate`、`splice`。没有 mutation name，没有 recipe，没有 provider 代码。applier
在任何语言中都是一页代码。

**这是不合规变得可见的地方**，而这是唯一一处值得
对此刻意为之。该格式是 JSON-Patch-*形状的*，而不是 RFC 6902：路径是
数组而不是字符串指针，而 `append`、`truncate` 和 `splice` 没有
RFC 等价物。一个伸手去拿现成 `jsonpatch` library 的 client 将
无法工作。

两种缓解措施，其中没有一个是「合规」：

- catalogue 显式地宣传 op 词汇表，所以 client 发现这
  六个动词，而不是假定一个不同的词汇表。
- 如果 client 真的需要 RFC 6902，server 可以在一个 content negotiation header 背后
  提供一个有损降级——用斜杠和 `~0`/`~1` 转义连接路径，
  把 `append` 和 `truncate` 物化为 whole-value `replace`，把 `splice` 展开
  为 `add`/`remove` 序列。大约十五行。它重新引入了二次方文本
  成本，而这正是要点：合规是可用的，而由 client 为之
  付费。

默认合规会把那个成本强加给每个 consumer，只为服务一个
假设中的对象，而且甚至买不到真正的互操作性，因为 Immer 的输出
也从来不合规（§9.2）。

### 15.4 发布让你承诺了什么

catalogue 中的一个 member 是一种兼容性承诺，其方式是一个内部 token 所不具备的。
Member 应当从一开始就携带一个 stability marker，这样发布就不会
静默地意味着冻结，而 §16 把版本协商列为未解决。

## 16. 相对于 `plugins.md` 的差异

| 主题 | `plugins.md` | 此处 |
| --- | --- | --- |
| 依赖声明 | 从 `setup()` 副作用派生 | 静态的 `uses`/`provides`/`observes` |
| setup 期间的 handle | 断开的惰性 proxy | 验证之后的真实对象 |
| 验证 | 需要运行 facet 代码 | 纯 manifest 分析 |
| mode | 按调用点声明，已验证 | token 的属性 |
| 环 | 通过惰性容忍 | 被拒绝；显式的 `deferred()` 逃生舱 |
| replication | `ReplicatedState` 全值；`DeltaState` 推迟 | 一个原语；显式的根 `r` + 六动词 op |
| hydration | 单独的原子 snapshot + 缓冲 | 流的 base batch zero |
| presentation facet | 本地加载 | 由 server 和 worker 投递 |
| server↔worker | 未指定的反转 | reporting registry；依赖指向上游 |
| authority | method body 中的 `requireClientIdentity` | context 上的 principal；过滤后的 view + handle 检查 |
| per-client state | 未处理 | `peer` mode：每个 peer 一个实例，作为 singleton 消费 |
| 资源 ownership | 显式的 `own()` | 隐式；每个 handle 都是一个自 disposal 的 binding |
| state 更新 | 手写的 patch union | provider 上的普通 mutation；wire 上的六动词 op |
| UI mounting | facet 拥有的 panel，未指定的 host API | 带 `claim`/`add` 的 slot；host 在 disposal 时 unmount |
| 隔离 | 受信任的代码，未指定 | 每个 presentation facet 一个 SES compartment |
| 外部 client | 未处理 | 选择加入的 `protocol` block；JSON Schema catalogue + HTTP/SSE |
| 生命周期 | 仅 `setup` | 同步 `construct`，异步 activate / deactivate |

## 17. 未决决定

- cwd 来源的 *session* facet 是否也需要 compartment（§14.2）。
- `CheckComplete` 错误消息的人机工效。
- role 从何而来，以及它们是 per-server 还是 per-session。
- handle table 是 facet 拥有的，还是 kernel 提供的 utility。
- owner 如何在运行时授予和撤销 guest 访问。
- Protocol 版本协商，以及一个 state value definition 的 reducer 如何参与
  source-generation skew（§9.2）。
- 高频 state value 的流控；间隙恢复已敲定（§9.2）。
- 发现启动之后创建的 lane（§9.2）。
- `reduceLaneSnapshot` 是现在还是以后成为 draft mutator；在它成为之前，
  lane state 是 replace-only 的。
- `deferred()` 在与真实 plugin 接触后是否能存活，还是应当被移除。
- 在任何 facet 依赖 tracker（`delta.md` §3.3）之前，为它做 property test。
- 哪些 durable value 需要一个显式的周期性 `rebase()` 节奏来约束恢复工作。
