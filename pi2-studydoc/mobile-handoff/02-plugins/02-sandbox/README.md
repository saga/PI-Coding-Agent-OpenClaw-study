# facet sandbox — isolated-vm

**未经修改的 pi facet 代码运行在无 ambient authority 的 V8 isolate 中。**
完整 JIT，因此约为 native 的 1.8×，而非 WASM 解释器所需的 8–17×。

```bash
npm install
npm run demo     # a facet: contributions, components, commands, callbacks
npm run audit    # escape audit — the interesting one
npm run bench    # crossing cost, isolate cost, 300 components
npm test         # 412 property assertions
```

Node 22+（`--experimental-strip-types`）。关于 QuickJS-WASM 的等价实现，见
`../facet-sandbox-poc`。

## 安全声明，以及为何它是结构性的

isolated-vm **可以**被不安全地使用，而这正是 `facets.md` §14.2 所
反对的。这个陷阱在于把一个 host 对象的 live handle 交给 guest——通过
`derefInto()`，或从一次 host 调用返回一个 `Reference`——之后
guest 就会沿着该对象的 prototype chain 走入 host realm。

这个 membrane 使这一点变得不可能，**靠的是构造（by construction），而非小心谨慎（by care）**：

1. `encode()` 是 host 值到达 guest 的唯一途径，它是
   带 replacer 的 `JSON.stringify`。**它的输出是一个 string。** 一个 string 无法
   携带引用。
2. Host 可调用对象从不跨越。它们变成进入 `hostTable` 的一个整数 id，而
   它完全存在于 host 侧。guest 收到的是一个 **number**。
3. 交给 guest 的 `Reference` 恰好只有**一个**——`__invokeRef`，即
   唯一的 call-in 点。
4. `derefInto()` 恰好只用一次，作用于 guest **自己的** global。任何 host
   对象都从未成为它的参数。

guest 对 host 的全部视野就是 `{ number, string }`。没有对象
图，因此没有东西可遍历。

### 审计结果（`npm run audit`）

```
Ambient authority:
  require / process / fetch          ["undefined","undefined","undefined"]
  global names visible               64 globals

Classic escape ladders:
  Function('return process')()       undefined
  constructor walk on host data      undefined

The isolated-vm Reference footgun:
  __invokeRef.deref()                blocked: TypeError   ("Cannot dereference
                                     this from current isolate")
  __invokeRef.copySync()             blocked: TypeError
  __invokeRef.getSync('constructor') blocked: TypeError
  derefInto() is callable?           inert (object)
  invoke derefInto() result          blocked: TypeError
  host globals via derefInto()       no host globals

Resource bounds:
  spinning guest interrupted         after 205ms
  isolate usable afterwards          true
```

在第一版草稿中，有一个探针给出了**误报（false positive）**：测试 `f.deref === undefined`
以证明返回的 host function 是 Proxy 而非 Reference。
membrane 的 proxy 对*每一个*属性都返回 proxy，所以 `f.deref` 是 truthy 的。
这不是泄漏——调用它会路由到 `hostFn["deref"]`，而它并不存在
并在 host 侧抛错。现在审计改为调用它，而不是检查其不存在。

## 性能

| | isolated-vm | QuickJS | native |
| --- | --- | --- | --- |
| 300 个 markdown 组件，小 | **70 ms** | 494 ms | ~40 ms |
| 300 个 markdown 组件，典型 | **108 ms** | 1118 ms | 64 ms |
| 300 个 markdown 组件，大 | **419 ms** | 4260 ms | ~150 ms |
| 146 KB bundle 加载 | **35 ms** | 104 ms | — |
| membrane 跨越 | **4.5 µs** | 7–17 µs | — |
| 每个 compartment | 1080 KB, 5.5 ms | **77 KB, 0.8 ms** | — |

**在典型规模下约为 native 的 1.8×。** QuickJS 是 8–17×，且随输入规模增大而更差。

isolate 的**内存开销比 QuickJS runtime 高 14×**（1080 KB 对 77 KB），且
创建更慢。对少量 facet 而言这无关紧要；对数百个
则不然。

`Intl.Segmenter` 在这里**存在**，而这正是在 QuickJS 下复用
`packages/tui` 组件的唯一硬性阻碍。仅此一点就可能决定选择。

## 局限

**预算不嵌套。** 一个 timeout 只约束一次 `evalSync`。一个 guest function
被 *host* 重新进入——一个 contribution callback、一个 component method——得到的
是 `callGuestRef` 自己的预算，而不是外层的预算。这在
`property-test.ts` 中被显式断言；在一个 50 ms 的外层预算下，一个失控的 callback 花了 5005 ms。
约束 facet 的总时间需要单独的计账。

**Async 是一个 settle-callback，而非原生 promise。** `applySync` 是同步的，
因此 host Promise 无法跨越。host 返回一个 token，guest 针对它构建一个真正的
Promise，host 再通过回调进入来 settle 它。已验证：guest
连续执行了两次 `await`，期间 host event loop 跳动了 22 次。

**原生 addon，而 ABI 矩阵是真实存在的。** `isolated-vm` 提供 prebuilds，
只有在没有匹配项时才回退到 `node-gyp rebuild`——这就是安装
只需一秒而非一小时的原因。它**不是**在构建 V8；V8 已经在 Node
二进制中。但覆盖面很窄：

| 版本 | engines | prebuilds |
| --- | --- | --- |
| **6.2.0** | `>=22.0.0` | linux-x64/arm64, darwin-arm64, win32-x64 — abi127, abi137 |
| 7.0.1 | `>=24.0.0` | — |
| 7.0.0 | `>=26.0.0` | — |

darwin-**x64** 在所有地方都缺失。在 Node 22 上安装 `isolated-vm@7` 会
落到源码构建，并且**在没有 Python 和 C++ 工具链时会失败**——
已在此处验证。另请注意，尽管 7.0.1 已存在，6.2.0 仍是 npm 上的 `latest`，
因为它晚一天发布。

该项目**不是弃置软件（abandonware）**——从 6.0.1（2025 年 7 月）到 7.0.1（2026 年 8 月），
一直在积极发布。§14.2 的「maintenance mode」说法已经过时，应予
更正。真正的风险有所不同：采用它会把你的最低 Node
版本与他们的绑定在一起，而他们在一年之内就在 6.x 中放弃了 Node 20、在 7.x 中放弃了 Node 22。
发布 SEA builds 会把这一点从每个用户的安装过程转移到你的 CI。

**内存：引用会释放，但是惰性的。** `WeakRef` + `FinalizationRegistry`
interning 表从 QuickJS membrane 原样移植过来并且有效——20 000
次跨越后变为 **0 个 live ref**。但 finalization 并不及时：
在一次强制 GC 之后 200 ms，仍有 5 000 个 ref 处于 live 状态。在持续 churn 之下，ref 积累的速度
快于 collector 回收它们的速度，而一个 32 MB 的 isolate 确实触及了它的上限。

其后果是一条 API 规则，而不是一个 membrane 修复：**不要在
hot path 中创建引用。** 在 construct 时调用 `slots.claim(factory)` 是永远只有一个引用；而一个
每帧都返回新闭包的 component method 则是每帧一个。

**触及 `memoryLimit` 会干净地杀死 facet。** 它会抛出一个可捕获的
`"Isolate was disposed during execution due to memory limit"`，而 host
会存活下来——但该 isolate 已死且不可恢复，因此 teardown 必须容忍一个
已经被 dispose 的 isolate。对它调用 `dispose()` 会抛出 `"Isolate is already
disposed"`；membrane 对此做了防护。

> **不要在一个承压的 isolate 上调用 `isolate.getHeapStatisticsSync()`。** 在
> 测试期间它**中止了整个进程**——一次硬崩溃，而非异常。
> 一个 `heapMB()` 辅助函数被从 membrane 中移除，而不是发布出去。

**仍然是一个进程、一个引擎。** 一个独立的 isolate 是远比 SES 更强的
边界，但 Figma 选择 QuickJS 的理由是：*不同的 VM* 不会
混淆对象，因为其表示形式不同。在这里，保证来自 V8 的
isolate 边界加上 membrane 的纪律——很强，且在结构上
如上所述被强制执行，但不是同一类别的声明。

## 文件

- `src/membrane.ts` — membrane。安全论证在头部注释中。
- `src/facet-example.js` — 未经修改的 facet 代码：`ctx.use()`、`slots.claim()`
  带一个闭包、返回给 host 的一个 class 实例、一个 subscribe callback。
- `src/demo-facet.ts` — 加载它并演练四种边界跨越。
- `src/escape-audit.ts` — 上面的审计。
- `src/property-test.ts` — 412 条断言：随机 `JsonValue` 双向
  round-trip、跨越时的 identity、callables、错误传播、
  GC 下的引用释放、双向 prototype pollution、预算、async、disposal。
- `src/bench.ts` — 上面的数字。
- `src/markdown-bundle.js` — 真正的 pi `Markdown` 组件，经 esbuild 打包。
