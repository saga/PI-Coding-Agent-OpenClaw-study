# @earendil-works/chord

Chord 是一个用于由 plugin/extension 组装而成的系统的应用组合运行时。它提
供 facet、service、replicated state，以及一个可插拔的远程
service 边界。它作为 Pi monorepo 中的一个独立包进行开发，但它不是一个 Pi
包：它不依赖任何其他 Pi workspace 包，并且可以被不相关的应用使用。

## Chord 的用途

单个应用功能可能需要在多个环境中运行：例如，一个 agent worker、一个终端 UI，以及
一个远程 WebUI。Chord 提供了通用机制，让你能够以既对人类友好、又对 agent 友好
的方式编写这类 extension。

该设计包含若干相互关联的部分：

- **Plugin** 是同步的 setup 单元，用于声明它们所提供的和所要求的
  service。在每个 plugin 都声明了自己的形态之后，host 会校验完整的依赖
  graph、绑定 service、在 consumer 之前激活 provider，并以逆依
  赖顺序释放资源。这些单元被称为 *facet*。

- **Facet** 是 plugin 的组成部分。每个 facet 会被单独 bundle，
  并运行在它应当在其中运行的进程或环境中。你可以使用 facet 将一个 plugin 拆分为
  需要加载到不同进程和环境中的独立部分（例如 backend、browser、TUI 等）。

- **Service** 是带类型的、稳定的 token，具有一个 provider（
  **singleton**）或动态的 keyed 实例（**keyed**）。一个
  service 可以是 process-local 的，具有不受限制的 JavaScript
  契约，也可以是可远程暴露的。当 provider 断开或被替换时，consumer 仍保留一
  个稳定的 facade。

- **Replicated state** 将权威状态暴露给本地和远程已连接的
  consumer。Producer 修改被跟踪的 `state` proxy 并调用
  `publish(context)`；consumer 接收到完整的不可变值。Chord 每
  次 publication 刷出一个已解码的 operation 批次，而每个远程
  client/state 流拥有独立的 path-codec 状态。Replica 在断开或
  替换时变为未就绪，直到被重新 hydrate。

- **Delta tracking** 在 flush 时从被跟踪的 plain JSON 推
  导出紧凑的 operation。它保留字符串 append/front-truncation
  和数组 append 行为，而不保留变更历史；支持可持久化的 base 批次，并在应用不受信
  任的 operation 时对其进行校验。

- **Remote service sources** 公布 facet host 之外可用的
  service，并为其 facet 所需的 service 打开 binding。
  Binding 通过应用提供的 adapter 承载逻辑调用和 subscription。
  Chord 要求严格的 JSON 参数、结果、snapshot、update 和
  catalogue，但不规定 framing、routing、transport 或应用
  wire envelope。`JsonRepresentation<T>` 为具有未知
  payload 的应用数据推导出 wire-safe 类型，而
  `isJsonValue()` 在 adapter 边界处校验接收到的值。Symmetric
  RPC peer 被规划为该边界的一种可选实现。

- **Context** Chord 提供了一套类似 Go 的 context 系统，用于取消
  和调用作用域内的应用值。应用可以通过这些值携带权限或 telemetry，而无需 Chord
  依赖其中任何一项。

当前 runtime 从 `@earendil-works/chord` 导出 service
token、singleton 和 keyed provider、remote binding、
replicated state、facet host 和 facet loader。请从包根导
入公共类型和通用 runtime API。Context 常量与函数位于
`@earendil-works/chord/context`，因为它们的通用名称不应污染根
API。Chord 拥有的标识符使用 `chord.*` 命名空间，其保留的 service 前
缀是 `$chord.*`。

## 远程 service adapter

Chord 拥有其与 transport 无关的 service wire 语法。
Consumer adapter 使用
`createServiceCatalogueCall()`、
`createServiceSubscribeCall()` 和
`createServiceUnsubscribeCall()` 来发起
`$chord.service` 控制调用。
`createRemoteServiceEndpoint()` 为一个 provider
consumer 处理这些调用，包括 subscription 激活与清理。
`parseServiceCall()`、`parseServiceCatalogue()` 以
及已解码/wire snapshot 和 update parser 会在 adapter 建立
严格的 JSON 边界之后校验 Chord 语义。
`RemoteServiceErrorCode` 和
`REMOTE_SERVICE_ERROR_CODES` 定义了可以跨越该边界的 service
error。

Replicated state operation 在 provider 侧为每个
subscription 使用一个 `createServiceStateEncoder()`，
在 consumer 侧使用一个 `createServiceStateDecoder()`。这
些 registry 会为每一个 instance/member 状态创建独立的 Delta
path 字典，并在替换、不可用、关闭或全新 hydration 时重置它。应用可以将这些值放入
任何 routing、request、response 或 event envelope 中；
Chord 不规定该外层协议。

## 跟踪 JSON delta

从 `@earendil-works/chord/delta` 导入独立的 delta 原语：

```ts
import { apply, track } from "@earendil-works/chord/delta";

const changes = track({ output: "", count: 0 });
changes.flush(); // opening base batch
changes.state.output += "done\n";
changes.state.count += 1;

const ops = changes.flush();
const replica = apply({ output: "", count: 0 }, ops);
```

第一次 flush 总是一个完整的 base 批次。后续 flush 包含基于 path 的变更
。`applyImmutable()` 在保留先前 replica revision 的同时应用
这些批次。`replicatedState(initial)` 直接使用 tracking：

```ts
const status = env.replicatedState({ output: "", count: 0 });
status.state.output += "done\n";
status.state.count += 1;
status.publish(context);
```

`publish()` 执行一次 flush；远程 connection plumbing 会为
每一对 client/state 独立编码该 operation 批次。字符串赋值会将纯
append 和滚动窗口移动保留为 append 和 front-truncate
operation；不相关的重写则回退为 set。插入到被跟踪状态中的值会归 tracker 所
有，此后只能通过 `state` 进行修改。关于 mutation、数组、lifecycle 和
consumer-ownership 规则，参见 [Delta 指南
](src/delta/README.md)。

## Bundling 和加载 facet

`@earendil-works/chord/bundler` 使用 esbuild 将 ESM
或 TypeScript 应用 entry 转换为独立的、content-addressed 的
CommonJS 文件。包级 API 从 `package.json` 读取 plugin 身份
和构建配置，然后应用由 host 应用提供的 facet 路径约定：

```json
{
  "name": "@example/my-plugin",
  "version": "1.0.0",
  "type": "module",
  "peerDependencies": {
    "@earendil-works/chord": "^0.84.4"
  },
  "chord": {
    "facets": {
      "worker": "./src/custom-worker.ts",
      "presentation": false
    }
  }
}
```

```ts
import { bundleFacetPackage } from "@earendil-works/chord/bundler";

await bundleFacetPackage({
	packagePath: "/path/to/my-plugin",
	outdir: "/application-owned/plugin-builds/my-plugin",
	defaultFacets: {
		worker: "src/worker.ts",
		presentation: "src/presentation.ts",
	},
});
```

既有的约定文件会成为 entry，除非 `chord.facets` 覆盖或禁用它们。Peer
dependency 会被 externalize，并在加载时针对 host 解析。Chord
从不安装依赖，也不运行包 lifecycle 脚本。`bundleFacets()` 仍然作为更
低层的 API，提供给那些已经拥有显式 plugin 身份和 entry 映射的调用方。

输出目录包含每个 entry 一个 `.cjs` 文件，外加
`chord-facets.json`。通过仅限 Node 的 loader 加载一个由应用选定
的 entry：

```ts
import { createFacetBundleLoader } from "@earendil-works/chord/node";

const loader = createFacetBundleLoader({
	manifestPath: "/application-owned/plugin-builds/my-plugin/chord-facets.json",
	entry: "worker",
	resolveExternal: (specifier) => import.meta.resolve(specifier),
});
const loaded = await loader.load();
```

每次 `load()` 都会校验 SHA-256 完整性，并使用 `node:vm` 直接编译
CommonJS 主体，而不是把 plugin 放入 Node 的 CommonJS 或 ESM
模块缓存。External 由 host 解析，并通过受限的 `require` 加载；
esbuild 会降级 dynamic import，使它们使用同一路径。释放一个已退役的
generation 会释放 loader 的 facet 引用，一旦 plugin 拥有的资源
也不复存在，其编译后的代码就有资格被垃圾回收。

为了传输到另一个 Node host，`readFacetBundleArtifact()` 会
将一个经过校验的 manifest entry 与其 source 一起打包，而
`createFacetBundleArtifactLoader()` 会在针对接收方 host
解析 external 的同时，物化全新的临时 generation。

要重新加载，请加载一个 candidate，将其 facet 传给
`FacetHost.reload()`，在失败时释放该 candidate，并且只在
cutover 成功之后才释放已退役的 `LoadedFacets`。Host 会在旧
provider 仍保持路由的情况下激活并校验 candidate，然后直接替换每个
singleton，不存在不可用区间。因此，稳定的 service handle 在普通
reload 期间不会断开。Keyed 实例保持 incarnation 专属，替换会获得全新的
generation。Bundler 在替换先前的输出之前会写入一个完整的临时目录，因此
loader 不会观察到部分构建的 generation。

关于更广泛的 RPC 和 generation 加载架构，参见
[PLANNING.md](PLANNING.md)。
