# Chord 实现计划

> **Status:** 正在执行的实现计划。Context、strict JSON、replicated state、service 的发布/消费、facet host/loader，以及最初的 Node facet bundling 和 generation 加载现已落在 Chord 中。Symmetric RPC 和结构化 generation 替换仍处于规划阶段。这还不是稳定的公共 API 契约。

## 1. 目标

Chord 将成为以下各项的应用中立基础：

1. 加载、组合、卸载、重新加载和 bundling plugin；
2. 声明和消费本地或远程 service；
3. 通过 symmetric RPC plumbing 传输 service 调用和 subscription；以及
4. 将权威的 latest-value 状态复制到本地和远程 consumer。

当前的 Pi 实验证明了许多必需的行为，但 Chord 将从零开始实现。现有源代码可以作为测试和设计证据使用，但不会被复制进这个包。与实验性 API 或 wire message 的兼容性不是一项要求。

## 2. 依赖边界

依赖方向是严格的：

```text
@earendil-works/chord
        ↑
Pi agent, protocol, server, coding agent, TUI, and future applications
```

Chord 必须：

- 不依赖任何其他 Pi workspace 包；
- 不包含来自 `@earendil-works/pi-*` 的 import，也不包含 `packages/chord` 之外的相对路径；
- 在源代码、错误、测试和示例中使用应用中立的词汇；
- 拥有其公共 API 所需的任何通用 runtime 类型，包括 strict JSON 值和 invocation cancellation context；
- 将 Node 专有的加载和 bundling 与平台中立的 runtime 分开；以及
- 在无需解析任何其他 Pi 包的情况下即可构建、测试、打包和使用。

通用的第三方依赖并非被禁止，但每个依赖都必须有正当理由。runtime 最初应优先使用标准 JavaScript API。bundler 可以在一个 Chord 拥有的 adapter 之后使用一个固定版本的实现。

以下术语不得成为 Chord 的概念：Session、Harness、AgentLane、server、client、attachment、TUI、model、tool、hook、provider credential 或 workspace。它们属于 consumer。

## 3. 架构模型

### 3.1 工作词汇

下面的名称是暂定的，但这些区分是必需的。

- **Plugin**：一个独立激活的组合单元，具有稳定的 ID 和同步的 setup 函数。
- **Plugin module**：一个 JavaScript 模块，为一个由应用选定的 entry 导出一个或多个 plugin。
- **Loaded generation**：plugin，加上通过加载其 module generation 所拥有的资源。
- **Host**：一个已组装好的 plugin 和 service graph。
- **Service token**：稳定的 runtime service ID，加上类型信息和 locality policy。
- **Provider**：一个 singleton service 或一个 keyed service 集合的所有者。
- **Connection**：当前 host 之外 service 的 transport 中立来源。
- **Peer**：symmetric RPC 通道的一个端点。任一 peer 都可以提供和消费 service。
- **Replicated state**：已初始化的可变 source state，带有只读的本地或远程 replica。

一个产品功能可以为不同的应用环境提供多个 plugin-module entry。Chord 不会将这些 entry 归组为一个跨进程的 runtime 对象，也不会解释它们的 entry 名称。

### 3.2 分层

实现应划分为以下层：

```text
plugin loader and bundler
        ↓
plugin host, lifecycle, and dependency graph
        ↓
service tokens, providers, facades, and keyed instances
        ↓
replicated state and service subscriptions
        ↓
symmetric RPC peer and transport adapter
        ↓
strict JSON, invocation context, cancellation, and errors
```

本地 service 路径不得要求 RPC 序列化。远程路径必须通过严格的 wire 边界使用相同的 service 语义。

## 4. 调用 context 与 strict JSON

当前的实验依赖 Pi 的 Harness `Context`，而 Chord 无法 import 它。因此 Chord 需要一个小的、中立的调用 context。

最初的 context 应提供：

- 一个可选的 `AbortSignal`，用于取消一次调用或 observation；
- 通过 Chord 拥有的 context key 提供的不可变带类型本地值；
- 一个 background root；
- child 派生、取消，以及可感知取消的等待 helper；以及
- 不内置 telemetry、identity、authentication 或应用值。

应用可以定义自己的 context key。Pi adapter 可以通过这些 key 携带 telemetry 和已认证的 identity，而无需 Chord 知道它们的类型。

context 对象绝不会作为业务值跨越 RPC。调用方 peer 发送取消控制和（如果已配置）一个不透明的 strict-JSON metadata 载体。接收方 adapter 会构造一个全新的本地 context。安装已认证本地 identity 的是 adapter，而不是远程业务参数。

Chord 拥有静态的 `JsonValue` 契约，并为 adapter 边界提供 `JsonRepresentation<T>` 和 `isJsonValue()`。service runtime 有意不执行自动的递归校验；具体的 serializer 仍负责拒绝不受支持的值。远程参数、结果、错误、snapshot、update、catalogue 和 RPC envelope 都应当是有限的 strict JSON：

- 仅限有限数字；
- 不得包含 `undefined`、稀疏数组、symbol、prototype、环、class、function、`Map` 或 `Set`；以及
- 业务层面的缺失使用 `null`，而不是 `undefined`。

应用 schema 校验仍然是应用的责任。Chord 会校验结构性的 control envelope，但 strict-JSON 边界的 runtime 强制执行目前交由 serializer 负责。

## 5. Plugin 与 lifecycle

### 5.1 Plugin 形态

预期的作者模型等价于：

```ts
interface Plugin {
  readonly id: string;
  setup(environment: PluginEnvironment): void;
}
```

Setup 是同步声明。它可以：

- 提供一个 singleton service；
- 声明对一个 keyed service 的所有权；
- 获取一个 singleton service handle；
- 声明对 keyed service 实例的 observation；
- 创建 replicated state；
- 注册一个 activation callback；
- 注册所拥有的资源清理；以及
- 注册最终的 deactivation 工作。

Setup 不得：

- 通过已获取的 facade 调用 service 或读取 replicated state；
- 执行异步工作；
- 稍后从 event handler 或 activation callback 引入新的 service 依赖；或
- 修改活动的 host generation。

host 在私有的 generation ledger 中记录 setup 调用。plugin 作者不维护并行的 `requires`/`provides` manifest。

### 5.2 组装

在每个 plugin 都完成 setup 之后，host 必须：

1. 从已配置的远程 service source 收集本地 provision 和 catalogue；
2. 将每个硬性要求解析为恰好一个本地或已连接的 provision；
3. 拒绝缺失的 provider、重复的 provider、有歧义的 source offer，以及 singleton/keyed 不匹配；
4. 拒绝重复的 plugin ID；
5. 推导 provider 到 consumer 的 lifecycle 边；
6. 拒绝依赖环；
7. 在 handle 仍不可访问时构造本地和远程 service binding；
8. hydrate 所需的已连接 service；以及
9. 在 consumer 之前激活 provider。

一个 plugin 可以同时提供和消费同一个 token，而不会产生自环。可选依赖不属于第一版契约；它们稍后需要一个独立的获取 API。

### 5.3 资源所有权

每个 plugin generation 拥有：

- activation callback；
- 显式 cleanup 函数；
- 通过其 provider handle 添加的 keyed 实例；
- keyed observation 及其 task；以及
- service provision。

Disposal 是幂等的。Consumer 在 provider 之前 deactivate，每个 plugin 的资源按注册的逆序 dispose。Cleanup 在个别失败之后仍会继续，并在所有 cleanup 尝试结束后报告一个 error 或一个 `AggregateError`。

Keyed observation handler 会收到一个全新的可取消 context。关闭或替换该实例只会中止那个 handler task。除非其 context 是作为正常 cleanup 被取消的，否则 handler 失败会通过 host policy 上报。

### 5.4 已加载的 module generation

Module 加载与 plugin activation 是不同的所有权域：

```ts
interface LoadedPlugins {
  readonly plugins: readonly Plugin[];
  dispose(): Promise<void>;
}

interface PluginLoader {
  load(): Promise<LoadedPlugins>;
}
```

必需的 loader：

- 用于 built-in 和测试的 static loader；
- 有序的 combined loader，具有逆序 disposal 和启动失败 cleanup；以及
- 用于一个选定 manifest entry 的 bundle/module loader。

loader 拥有一个 source generation。host 拥有活动的 plugin lifecycle。coordinator 必须先 deactivate 一个已退役的 generation，然后才能 dispose 它的 `LoadedPlugins`。

Node 的默认 ESM loader 会在其进程范围的缓存中保留每一个已 import 的 module generation。因此 Chord 将 Node facet bundle 为 CommonJS，并使用 `node:vm` 直接编译每个 generation，而不把 plugin 代码插入任一 Node module 缓存。Chord 的 unload 契约仍然是 deactivation、移除 service 可达性、cleanup，以及释放 loader 拥有的 reference/resource。一旦不再残留任何由 plugin 创建的 timer、listener、callback 或其他逸出的 reference，V8 就可以垃圾回收已编译的 generation；回收时机不是确定性的。

## 6. 加载、卸载和重新加载

### 6.1 Host 更新

Host 更新是串行化的，并有两种形式。

#### 保持形态的替换

当每个被替换的 plugin 都保持以下各项相同时，定向替换就是保持形态的：

- plugin ID；
- 所要求的 service ID 和 mode；
- 所提供的 service ID 和 mode；以及
- 可远程暴露的 singleton member 名称和 kind。

序列是：

```text
load replacement module generation
→ run replacement setup
→ validate replacement shape and remote implementations
→ activate replacements in dependency order while the old providers remain routed
→ replace each local or remote singleton directly without withdrawing it
→ deactivate replaced plugins in reverse dependency order
→ dispose the retired loaded generation
```

性质：

- 既有的本地和远程 singleton facade 保持对象 identity；
- 已捕获的本地和远程方法在 cutover 之前分派到旧 provider，在 cutover 之后分派到替换者；
- replicated-state facade 会安装替换者的 snapshot，而不会变为未 hydrate；
- 每个 singleton 都直接从其旧 target 切换到其替换者，但多 service reload 不是 graph 事务性的；
- 旧 plugin 的 keyed 实例会关闭；由替换者暂存的实例使用全新的 generation；
- setup、形态校验或替换激活失败会使活动 generation 保持不变；
- 在 activation 期间获取的具名 host 资源支持重叠的暂存替换，因此 candidate cleanup 会恢复旧的 registration，而已退役的 cleanup 无法移除替换者；以及
- 替换开始后的任何失败都会终止 host，而不是尝试保留一个部分转换的 graph。

cutover 之后没有回滚。终端 cleanup 会在尽力而为的 disposal 之前撤销每个 facet handle；只有 cutover 之前的 candidate cleanup 和普通的 host disposal 才保证按依赖顺序的 cleanup。已提交的应用效果在 reload 事务之外。

#### 结构性替换

添加或移除 plugin、改变 service 形态或改变 connection 选择都是结构性的。第一版实现应替换完整的 host generation，而不是尝试对受影响的子图做部分更新：

```text
load and synchronously set up the complete desired generation
→ resolve and validate its graph without activation effects
→ begin cutover
→ withdraw old providers and deactivate the old graph
→ install and activate the new graph
→ dispose the old loaded generation
```

规则：

- cutover 之前的校验失败会使旧 graph 保持活动；
- cutover 开始之后，失败会 dispose 整个 host，因为已退役的 graph 无法恢复；
- 在保留硬性 consumer 的同时移除 provider，会在 candidate 校验期间被拒绝；
- 当 service ID 和 mode 在替换后仍存在时，plugin lifecycle 之外拥有的 service facade 保持稳定；
- 被移除的 service 对已退役的 generation 而言会永久断开；以及
- 未来的优化可以保留未受影响的 plugin，但这不是最初的结构性更新所必需的。

这条全 generation 路径提供了真正的 plugin 加载和卸载语义，而无需先实现复杂的部分 graph 事务。

### 6.2 卸载期间的调用

替换绝不会让一个 singleton facade 失去 target：一次 invocation 要么解析到旧实现，要么解析到其替换者。已在退役 facet 中运行的工作不会被排空；之后使用该 facet 已撤销的 handle 可能会作为陈旧工作而失败。未来的可杀死 isolate host 会直接终止这类工作。Transport 断开仍然只取消 connection 拥有的 invocation；它并不意味着应用层级的取消或回滚。

### 6.3 更新失败上报

更新结果必须区分：

- 加载失败；
- cutover 之前的 setup 或 graph 校验失败；
- 旧 generation deactivation 失败；
- 替换者 activation 失败；
- service 重新绑定失败；以及
- 已退役 loader disposal 失败。

多个失败会被聚合，同时不会隐藏第一个转换失败。并发的 update、unload 和 host-dispose 请求会被串行化，或以稳定的 lifecycle error 拒绝。

## 7. Service

### 7.1 Token 与 mode

一个 service token 具有：

- 非空的稳定字符串 ID；
- TypeScript 契约类型；
- locality policy：默认可远程暴露，或显式 process-local；以及
- 其自身没有 provider 实例。

Chord 为 control-plane ID 保留了一个前缀。同一个 catalogue 中的重复 ID 是无效的。

需要两种 mode：

- **singleton**：一个 provider，多个 consumer；以及
- **keyed**：一个集合所有者、动态实例、多个 observer。

一个 token 在一个 host graph 中只有一种 mode。混用 singleton 和 keyed 用法属于组装错误或协议错误。

### 7.2 本地 service

Process-local service：

- 可以暴露任意对象、同步方法、class、function、native handle 或非 JSON 值；
- 绝不会包含在远程 catalogue 中；
- 使用与远程 service 相同的 graph 排序、稳定 handle、keyed generation 和 lifecycle 行为；以及
- 是受信任的组合，而不是安全边界。

本地 singleton consumer 收到的是一个稳定的惰性 facade，而不是 provider 对象。这消除了对 setup 顺序的依赖，并让 provider 替换能够更新已捕获的方法。

即使 provider 和 consumer 共享一个 host，可远程暴露的 service 也使用 provider/binding 路径。一个内部 loopback binding 使替换、replicated-state 和 keyed-generation 语义与位置无关。只有显式 process-local 的 service 才绕过该路径。

### 7.3 远程 service 契约

可远程暴露的实现只能包含被归类为以下各项的 own data property：

- 业务参数和结果为 strict JSON 的异步方法，并在声明的位置带有一个 Chord 调用 context；或
- branded replicated-state 值。

provider 从实现中推导出一个 runtime member 表。plugin 作者不维护第二个 method/state 描述符。不受支持的 accessor、field 或 member kind 会在 publication 之前被拒绝。

类型层面的检查应拒绝明显无效的远程契约。runtime 检查仍然是强制性的，因为类型无法认证 peer，也无法在 JavaScript 消费之后存续。

远程方法：

- 返回 promise；
- 返回 strict JSON 或 `void`；
- 接收一个全新的本地调用 context；
- 将调用方取消映射到恰好一个 request；
- 在断开时不排队；以及
- 在 wire 上暴露稳定的 error code 和已净化的消息。

任意返回的对象 reference、callback、function 序列化，以及一般的对象图 remoting 不在最初范围内。

### 7.4 稳定的 singleton facade

`use(token)` 返回一个由 facet 拥有的 capability view，作用于一个与 source 无关的 host service slot。在一个 facet 内重复获取会返回同一个 view；不同的 facet lifecycle 会收到不同的 view。Member slot 在属性访问时惰性创建，并在绑定时针对 provider metadata 进行校验。

必需行为：

- 在 setup 期间以及拥有它的 facet lifecycle 结束之后不可访问；
- 在本地 graph 组装或远程 hydration 之后直接绑定；
- 在 provider 撤销和替换期间保持稳定；
- 在断开时 method invocation 失败；
- 在未 hydrate 时 state 读取返回 `undefined`；
- 可远程暴露的替换者会保留完整的 member 名称/kind 表；以及
- provider 省略一个已访问过的 member 属于 binding error。

### 7.5 Keyed service

`provideMany(token)` 在 setup 期间声明一个 keyed 所有者，并返回一个由 generation 拥有的 `ServiceSpawner`。在其活动期间，`spawn(key, implementation)`：

- 要求一个非空的 key，且在活动实例中唯一；
- 为该 key 创建一个由 host 拥有的单调递增 generation；
- 原子地发布方法和初始 state；
- 返回一个幂等的 close 函数；以及
- 在 plugin disposal 期间自动关闭。

实例地址是 `(service ID, key, generation)`。复用一个已关闭的 key 会创建一个新的 generation。陈旧的 facade 无法调用替换者。

`observe(token, handler)`：

- 协调一份完整的初始实例目录；
- 仅在所有初始 state member hydrate 之后，才为每个实例启动一个 task；
- 保留有序的添加、替换和移除；
- 在 close、替换、断开或 observation disposal 时中止该实例 task；
- 为每个 observation 提供一个 observer 生命周期的 service view，该 view 在其 task 被中止时变为不可访问；以及
- 绝不在 replicated JSON state 内表示 service facade。

## 8. Replicated state

Replicated state 是权威的单写者 latest-value 复制。

source API 具有一个已初始化的值、`set(value, context)` 和 subscription。远程或已断开的 replica 在 hydration 之前 `value === undefined`。

必需语义：

1. source 始终是已初始化的。
2. 对于可远程暴露的 state，source 和 replica 的值是 strict JSON。
3. 订阅已初始化的本地 state 或已 hydrate 的 replica state，会立即用一个全新的 delivery context 投递当前值。
4. 订阅 cold state 只进行注册，不立即投递。
5. subscription 建立会在获取 snapshot 之前安装 update capture。
6. 与 snapshot 竞争的 update 会被缓冲，并在 snapshot 之后无间隙地投递。
7. source API 暴露一个被跟踪的可变 state 和显式的 publication。每次 publication 刷出一个已解码的 operation 批次；connection adapter 为每个 client/state 流独立编码它，而 replica 仅按 sequence 顺序应用批次。
8. sequence 间隙会清除 readiness，并触发完整的重新订阅，或报告一个终态 binding error；陈旧 state 不得静默地继续作为当前 state。
9. 断开、provider 撤销、route 变更和替换都会清除 replica readiness。
10. 重新连接或替换会在后续 update 之前，在既有的 state facade 中安装一份完整的新 snapshot。
11. listener 异常会被隔离，并通过 host policy 上报。
12. 值是不可变数据。Chord 不会防御性地 clone 本地读取、本地写入或本地 listener 投递。Delta 应用会保留先前的值，并可能以结构共享方式复用未变更的数据，但调用方不得依赖 identity。

State identity 是结构性的：

```text
provider binding + service ID + optional keyed address + member name
```

没有单独的 state ID。

明确的非目标：

- 进程重启后的持久性或重建；
- event 历史；
- CRDT 合并或多写者；
- 离线 mutation 重放；
- 自动抑制未变更的值；以及
- 高频 stream transport。

Chord 暴露一个保留意图的 JSON delta 原语，并在内部将其 operation 批次用于远程 replicated state。初始 hydration 和重新连接会携带一次完整的 root 替换；producer 修改被跟踪的 state，并在 publication 时刷出紧凑的 operation。Replicated-state source 不选择 reducer，也不与 path encoder 交互。每一对 client/state 都拥有独立的 encoder，而 sequence 处理会在后续 operation 被应用之前拒绝间隙。

## 9. Symmetric RPC plumbing

### 9.1 没有 client/server mode

Chord 不得暴露 `Client`、`Server`、`SessionConnection` 或类似的拓扑 class。它在一个由应用提供的 duplex channel 之上暴露一个 symmetric peer。任一 endpoint 都可以注册 handler、提供 service、调用方法或订阅 state。

Application adapter 拥有：

- socket、pipe、WebSocket、worker 或 loopback 投递；
- framing 和重新连接策略；
- authentication 和 authorization；
- routing 和 target 选择；
- 进程所有权；
- attachment 或选择状态；以及
- 围绕 Chord message 的应用协议 envelope。

Chord 看到的是一个已连接的 peer 和已解码的 strict-JSON message。

### 9.2 RPC 层

通用 RPC peer 应拥有：

- 作用域为一个 peer connection 的 request ID 分配；
- request/response 关联；
- handler 注册；
- 取消 frame 和一个 request-local `AbortController`；
- 断开拒绝和 cleanup；
- 稳定的可序列化 error envelope；
- 有序的 notification 投递；
- 畸形消息拒绝；以及
- 可选的 context metadata hook。

channel 契约应当很小：发送一条 strict-JSON message、按顺序接收 message、观察 close 并 close。`send()` 应当可 await，以便 adapter 能够提供 backpressure。

peer 断开时：

- 拒绝出站 request；
- 中止入站 request context；
- 关闭 service subscription 和 keyed observation task；以及
- 不取消应用拥有的 job，也不执行持久的业务 mutation。

### 9.3 基于 RPC 的 service 协议

service 层为以下各项添加 transport 中立的 operation：

- catalogue 发现；
- singleton 和 keyed subscription 的 open/close；
- 完整的 subscription snapshot；
- method invocation；
- invocation 取消；
- replicated-state update；
- singleton unavailable/replaced event；以及
- keyed instance spawned/closed event。

wire 协议不包含 server ID、session ID、attachment ID、route、user identity 或 host kind。Pi router 可以使用自己的 control field 包装或转发 Chord envelope，而无需解析 service 业务 payload。

Provider catalogue 和 subscription state 必须来自真实的 service provision，而不是手写的应用 inventory。

### 9.4 Wire 错误与校验

Chord 需要为以下各项提供稳定的通用 error code：

- service 不被允许或不存在；
- mode 不匹配；
- member 不存在或使用了错误的 kind；
- keyed 实例不存在或已陈旧；
- 无效的 strict-JSON 值；
- 取消；
- 畸形的 RPC message；
- peer 已断开；以及
- 内部 provider 失败。

意外的 provider 异常默认会变成一个已净化的内部错误。Stack trace 和任意异常字段不会跨越 wire。应用可以通过 adapter 注册或映射额外的稳定 error code，但 Chord 不拥有应用 error taxonomy。

### 9.5 协议演进

第一版实现必须独立于任何应用协议来对 Chord 的 RPC/service envelope 进行版本化。版本协商可以是 peer handshake，也可以是 adapter 保证的 constructor 参数，但不兼容的 peer 必须在 service 调用被接纳之前失败。

跨 plugin generation 偏差的 member 和 DTO 兼容性是应用的责任。Chord 只保证其通用 envelope 语义。

## 10. Bundling

### 10.1 目的

bundler 将一个或多个由应用声明的 ESM 或 TypeScript plugin entry 转换为可独立加载的 Node CommonJS 产物。它不是包管理器或 plugin registry。

每个 entry 都独立构建。Chord 不假设诸如 `server`、`session`、`tui` 或 `web` 这样的名称；entry 名称是不透明的应用数据。

### 10.2 初始输入与输出

最初的 bundler 应接受：

- plugin identity 和可选的 version metadata；
- 从不透明 entry 名称到 TypeScript 或 JavaScript 源文件的映射；
- 输出目录；
- 由应用提供的 external-module allowlist；
- source-map 和 minification 选项；以及
- Node CommonJS 构建所需的可选 define/platform 设置。

包级 API 还接受一个 plugin 包目录，从 `package.json` 推导 identity 和 version，在这些文件存在时应用由应用提供的约定 entry 路径，并允许 `chord.facets` 覆盖或禁用约定。包发现不会安装依赖，也不会运行 lifecycle 脚本。

它应产出：

- 每个 entry 一个 content-addressed 的 CommonJS 文件；
- 启用时的 source map；
- 带版本的 strict-JSON manifest；
- content hash 或 integrity 值；
- 声明的 external import；以及
- 足以用于 diagnostics 和全新 generation 加载的 metadata。

写入应先使用一个临时输出目录，然后进行原子 rename，这样 loader 永远不会看到只写了一半的 generation。

### 10.3 Bundle 规则

- `@earendil-works/chord` 必须被 externalize，以便 plugin 使用 host 唯一的 runtime 和 branding symbol。
- 其他依赖默认会被 bundle。显式的 bundler API 使用一个应用 external allowlist；包级 API 还会将 peer dependency externalize，因为 host 提供它们。
- 对于 Node entry，可以允许使用 built-in module，但这并不是信任或 sandbox 策略。
- Dynamic import 必须通过 loader 受限的 `require` 降级，无法解析的 external 必须以确定性的方式报告。
- Bundle 输出不得依赖 Pi 的 repository path alias。
- 在输入未变更时重新构建应产生稳定的内容，已记录的 metadata 除外。
- Diagnostics 必须标识 entry 和原始 source 位置。

具体的 bundler 引擎是实现细节。在添加依赖之前，先通过一个覆盖 TypeScript 和 ESM 输入、CommonJS 输出、source map、external、content hashing 和程序化 diagnostics 的 spike 来选择它。

### 10.4 Bundle 加载

bundle loader 必须：

1. 解析并校验 manifest；
2. 选择一个由应用请求的 entry；
3. 在存在 integrity 时，于 activation 之前校验完整性；
4. 使用 `node:vm` 直接将其编译为 Node module 缓存之外的全新 generation；
5. 校验其 export 是 ID 唯一且非空的 plugin；
6. 返回 `LoadedPlugins`；以及
7. 提供幂等的 loader disposal。

Plugin 发现、安装、版本解析、下载、签名信任和更新策略仍然是应用的责任。

## 11. Pi 迁移边界

以下既有文件描述了应通过重写成为 Chord 职责的行为：

| 现有区域 | Chord 职责 |
|---|---|
| `packages/agent/src/plugins/services/types.ts` | service token、mode、远程契约检查、strict JSON、snapshot、update、connection 接口 |
| `packages/agent/src/plugins/services/replicated-state.ts` | 权威 replicated state 和投递语义 |
| `packages/agent/src/plugins/services/provider.ts` | provider 分类、调用、singleton 替换、keyed generation、snapshot |
| `packages/agent/src/plugins/services/namespace.ts` | 稳定的远程 facade、hydration、state update、keyed observation |
| `packages/coding-agent/src/experimental/facets.ts` | plugin environment、依赖 ledger、lifecycle graph、host、reload |
| `packages/coding-agent/src/experimental/facet-loader.ts` | static 和 combined loader，以及 loaded-generation 所有权 |
| `packages/protocol/src/protocol.ts` 的通用 service 部分 | Chord 拥有的带版本 service/RPC envelope |

以下内容必须保持在 Chord 之外：

| 现有区域 | 下游职责 |
|---|---|
| `packages/coding-agent/src/experimental/services/connection.ts` | Pi connection state、selected-session attachment、route 重新绑定、Pi client adapter |
| `packages/coding-agent/src/experimental/services/server.ts` | server 范围的 session directory 和管理实现 |
| `packages/coding-agent/src/experimental/services/worker.ts` | Session worker host 构造和 Pi protocol publication adapter |
| `packages/server`、`packages/client` 以及进程管理器 | framing、routing、authentication、attachment、进程 lifecycle、重新连接策略 |
| slash-command、model、account、transcript、TUI 和 agent-controller service | 应用契约和 plugin 实现 |
| `source-resolver.ts` 和 Pi 内部进程 entrypoint | Pi source 执行和进程策略 |

`packages/agent/docs/plugins.md`、`packages/agent/docs/rpc.md`、实验性 service 测试和远程 plugin fixture 是行为输入。它们不是规范性的 Chord API。一旦迁移完成，通用语义应记录在 Chord 中，而 Pi 文档应只覆盖其 host 特有的契约和 adapter。

只有在 Chord 通过其独立的一致性测试套件之后，才应进行迁移：

1. 在不修改 Pi 调用方的情况下实现 Chord；
2. 添加轻量的 Pi adapter 并迁移通用 service import；
3. 迁移实验性 plugin host 和 loader；
4. 改造 Pi 的 routed 协议以承载 Chord envelope；
5. 运行本地、loopback、framed、keyed-generation、reload 和 TUI 集成测试；以及
6. 仅在所有 consumer 都使用 Chord 之后，才删除重复的实验性通用实现。

除非另有要求，否则不需要兼容性 shim。

## 12. 建议的 source 布局

这是一种规划辅助，并不是要求立即创建所有文件。

```text
packages/chord/
  src/
    index.ts                 platform-neutral public API
    api.ts                   root-exported functions
    types.ts                 root-exported types, including strict JSON values
    context/
      index.ts               invocation context constants and functions
    errors.ts                lifecycle, service, and RPC errors
    services/
      types.ts               tokens, contracts, modes, snapshots
      state.ts               source and replica state primitives
      state-internals.ts     private replicated-state metadata
      provider.ts            singleton/keyed provider runtime
      facade.ts              stable local and remote facades
      host-bindings.ts       graph-facing service slots
    rpc/
      peer.ts                symmetric request/cancel plumbing
      protocol.ts            versioned generic envelopes and parsing
      services.ts            service protocol over a peer
      loopback.ts            deterministic in-memory duplex transport
    plugins/
      types.ts               plugin and environment types
      lifecycle.ts           activation and resource ownership
      graph.ts               validation and ordering
      host.ts                start, update, reload, dispose
      loader.ts              static and combined loaders
    node/
      bundle.ts              Node CommonJS bundler
      bundle-loader.ts       manifest validation and generation loading
  test/
    ...
  test-fixtures/
    bundled-plugin/
  README.md
  PLANNING.md
```

如果导出了仅限 Node 的 API，它们应使用单独的包 export，例如 `@earendil-works/chord/node` 或 `@earendil-works/chord/bundler`；import 主 runtime 不得加载仅限 Node 的 module。

## 13. 工作包

### WP0 — 契约决策与测试 harness

交付：

- 确定公共词汇和 invocation-context 形态；
- 确定已接纳调用的 unload 策略；
- 确定协议版本协商；
- 选择远程 context 位置是否固定且位于末尾；
- 创建确定性的 in-memory duplex 和可控 race 测试 helper；
- 添加阻止 Pi import 的 package-boundary 检查；以及
- 为有效和无效的远程契约添加仅编译的 fixture。

退出条件：后续每个工作包都能针对明确的行为，而无需 import 实验性实现。

### WP1 — 基础与 replicated state

交付：

- strict JSON 类型/检查；
- 中立 context、取消，以及可感知取消的等待；
- 可变权威 state；
- cold replica state；
- snapshot hydration、有序 update、clear 和 rehydrate；
- 借用式不可变值契约；以及
- listener 错误上报。

测试包括 cold/hydrated subscription、立即投递、source update 顺序、snapshot/update 竞争、sequence 间隙、取消、无效 JSON 和 listener 失败隔离。

### WP2 — Symmetric RPC peer

交付：

- 带版本的 peer envelope 和校验；
- request/response 关联；
- 入站 handler 分派；
- 取消和断开行为；
- 可序列化的已净化 error；
- 有序 notification；以及
- loopback transport。

测试包括从两个 peer 发起的 request、交叉并发 request、重复/未知 ID、预先中止的 request、取消隔离、畸形 message、发送失败、调用期间断开，以及 handler 异常。

### WP3 — Service provider 与 facade

交付：

- service token 和 locality policy；
- singleton 和 keyed provider 注册；
- 实现 member 分类；
- 本地 service slot 和稳定 facade；
- 基于 `RpcPeer` 的远程 method invocation；
- 从 provision 生成的 catalogue；
- keyed generation 和 stale-call fencing；以及
- service error 映射。

测试包括本地和 loopback 路径、已捕获方法稳定性、provider 撤销/替换、mode 错误、不受支持的 member、strict-JSON 参数/结果检查、仅本地隔离、keyed 复用和并发调用方。

### WP4 — 远程 state 与 service subscription

交付：

- 完整的 singleton 和 keyed subscription snapshot；
- 原子 snapshot/update 缓冲；
- state update publication；
- singleton unavailable/replaced event；
- keyed 目录 hydration 和有序协调；
- observer task 取消；以及
- connection 替换时的 clear/rehydrate。

测试包括迟到的 subscriber、与 hydration 竞争的 update、多个 state member、provider 替换、handler 之前的 keyed hydration、断开、重新连接、sequence 间隙、陈旧 frame 和 observer 错误。

### WP5 — Plugin host 与 graph

交付：

- plugin/environment API；
- 由 setup 推导的 ledger；
- graph 校验和拓扑排序；
- 本地和已连接 service 解析；
- lifecycle 所有权；
- 启动失败 cleanup；
- host disposal；以及
- static loader 集成。

测试包括 consumer 先于 provider 的 setup、缺失/重复/有歧义的 provider、mode 不匹配、环、异步 setup 拒绝、activation 顺序、逆序 cleanup、cleanup 聚合、connection hydration 失败，以及 service 访问守卫。

### WP6 — Generation 加载、卸载与重新加载

交付：

- combined loader；
- 完整的结构性 generation 替换；
- 保持形态的定向 reload；
- 稳定的存续 service slot；
- keyed 实例退役；
- 针对迟到调用和 update 的 generation fencing；
- 已接纳调用的 drain/cancel 策略；以及
- 精确的失败上报和 loader disposal 顺序。

测试包括加载失败 cleanup、保留旧 generation 的 setup 失败、保留硬性 consumer 时的 unload 拒绝、provider 间隙、已捕获的本地和远程方法、替换 snapshot、cutover 之后的 activation 失败、disposal 失败聚合、并发 update/dispose，以及旧 generation 的迟到 publication。

### WP7 — Node CommonJS bundler 与 bundle loader

交付：

- bundler-engine spike 与决策；
- 程序化 bundler API；
- 带版本的 manifest；
- 独立的 content-addressed entry；
- source map 和 diagnostics；
- Chord externalization；
- 原子输出替换；
- manifest/integrity 校验；以及
- Node module 缓存之外的全新 VM 编译 generation 加载。

测试会 bundle 一个应用中立的 fixture，其中包含两个不透明 entry 和一个第三方依赖，独立加载每个 entry、激活它、重新加载已变更的 source、证明未变更 source 的 hash 是稳定的、拒绝损坏的 manifest/integrity，并证明输出不解析任何 Pi 包。

### WP8 — Pi 采用

这项工作位于 Chord 的下游，而不是实现依赖。

交付：

- 用于 context metadata 和 routed RPC transport 的 Pi adapter；
- 实验性 service 和 plugin host consumer 的迁移；
- 在 Chord 之外保留 selected-session 和 TUI 行为；
- framed 集成和 reload 覆盖；以及
- 移除被取代的通用实验性代码。

退出条件：Pi 依赖 Chord，而 Chord 仍可独立打包且不包含任何 Pi import。

## 14. 必需的一致性矩阵

独立测试套件至少必须覆盖：

### Plugin graph 与 lifecycle

- 仅在 setup 期间声明；
- setup 期间 service 访问被拒绝；
- 确定性的 graph 排序；
- 缺失、重复、有歧义和成环的依赖；
- activation 和逆序 disposal；
- 启动和 disposal 失败聚合；
- 一个 graph 中的本地和已连接 provider；
- 完整的结构性 load/unload；以及
- 保持形态的 reload。

### Service

- singleton 和 keyed mode；
- 不受限制的本地契约；
- 远程 member 分类；
- strict JSON 和 `void` 结果；
- 稳定的本地和远程 facade；
- provider 撤销和替换；
- keyed generation fencing；
- 逐调用取消；以及
- connection 和 host 访问守卫。

### 复制

- 已初始化的 source 和 cold replica；
- 已 hydrate subscription 的立即投递；
- snapshot/update 无竞争；
- 有序 update 和间隙处理；
- 断开清除；
- 替换和重新连接时的 rehydration；
- observer 启动之前的 keyed state；以及
- listener/handler cleanup。

### RPC

- 两个方向上的 symmetric 调用；
- request 关联和取消隔离；
- 畸形和超大 message 策略；
- 已净化的 error；
- 断开 cleanup；
- subscription cleanup；
- 协议版本不匹配；以及
- 确定性的 in-memory 和 framed-adapter 测试。

### 加载与 bundling

- loader 顺序和逆序 disposal；
- 全新 generation 求值和垃圾回收资格；
- manifest 校验和完整性；
- 独立 entry；
- 依赖 bundling 和显式 external；
- source map 和 diagnostics；
- 原子输出；以及
- 在 monorepo 之外执行已打包的包。

Race 测试应控制精确的时间点，而不是依赖计时：subscription capture 与 state update、request 接纳与取消、provider 撤销与 invocation、实例 close 与调用、reload cutover 与 update publication，以及 host dispose 与 activation。

## 15. 最初实现的非目标

- Pi host API 或内置 Pi service；
- plugin 发现、安装、下载、registry 或包解析；
- 信任策略、代码签名、sandboxing 或 capability 安全；
- 网络 listener、socket framing、重新连接循环、routing 或 authentication；
- server/client 角色或固定进程拓扑；
- 持久 state、数据库集成、迁移或事务性应用写入；
- CRDT、离线写入或 mutation 重放；
- 任意对象 remoting、callback、远程 reference，或 reference 的垃圾回收；
- 序列化的 UI 树、远程 tool 或远程 hook；
- 通用 contribution registry；应用可以将这些作为 process-local service 暴露；
- 在不确定断开之后自动重试变更性调用；以及
- 与实验性 Pi API 或 wire 格式的向后兼容性。

## 16. 实现之前需要做出的决策

在 WP1/WP2/WP7 开始之前，以下决策应记录在本文档或小型 ADR 中：

1. 最终的公共名称：`Plugin` 还是 `Facet`、`Host`、`Peer` 和 `Connection`。
2. 确切的中立 context API 以及远程 method context 位置。
3. context metadata 传播是在第一个 RPC envelope 中，还是通过一个兼容的可选字段添加。
4. unload 期间已接纳 provider 调用的等待还是取消策略。
5. peer 协议协商和最大 message 大小的归属。
6. state sequence 间隙恢复：自动重新订阅还是终态 binding 失败。
7. bundler 引擎及其 runtime/development 依赖的位置。
8. manifest schema、integrity 算法和 external-module 解析契约。
9. 浏览器兼容的核心行为是立即需要测试的要求，还是仅作为架构约束。

这些决策都不应将 Pi 概念引入 Chord。

## 17. 完成的定义

Chord 的最初范围在以下条件满足时即告完成：

- 一个与 Pi 无关的独立应用可以定义本地和远程的 singleton/keyed service；
- 两个 symmetric peer 可以互相调用、取消调用、订阅、断开和 rehydrate；
- replicated state 满足上述 snapshot/update 和替换语义；
- plugin 从已校验的 graph 激活，并拥有所有已注册的资源；
- 一个运行中的 host 可以加载、卸载、结构性替换，并以保持形态的方式 reload plugin generation；
- 稳定的 service facade 按规范在 provider 替换后仍然存续；
- Node bundler 产出并重新加载独立的 content-addressed plugin entry；
- 所有 race 和 lifecycle 一致性测试均通过；
- 已打包的包可以在 Pi monorepo 之外工作；以及
- 自动化的边界检查证明 Chord 对 Pi 的其余部分没有 import 或依赖。
