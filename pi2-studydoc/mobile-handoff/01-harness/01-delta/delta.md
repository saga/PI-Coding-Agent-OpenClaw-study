# Delta 跟踪与 Op 词汇表

> **生产状态：** 已落地于 `packages/chord/src/delta/index.ts`，测试位于 `packages/chord/test/delta.test.ts`。Chord 拥有无依赖的 `Op`/`WireOp`、tracker、applier、codec 和验证边界；Session storage、Harness 和 facets 使用它。本文档旁边的实现和测试是历史原型和基准证据，不是生产源码。
>
> 已落地的 tracker 在 `flush()` 时从脏树和基线计算 delta，而不是为每次 mutation 保留一个 op。这解决了 FINDINGS D1。生产环境重新测量也关闭了 FINDINGS D2：通用字符串路径低于周围的 replication/rendering 成本，因此显式的 append/truncate API 被拒绝（[decision](append-decision.md)）。

一个机制覆盖 assistant partials、tool output、tool details、lane state 和任意 facet state — 在 wire 上和 durable storage 中。

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/delta.test.ts
# run from packages/chord
```

## 1. 为什么不用现有的库

Immer、Valtio、Mutative 和 Colyseus 都**记录 effect，而不是 intent**。字符串
是一个叶子，所以 `text += chunk` 是对整个新字符串的一次写入；不存在
一种表示能让库知道你做了 append。`unshift` 是
同样的故事 — 引擎会移动每一个索引，所以每一个都是一次写入。

四个都测过：

| operation | 它们发出什么 |
| --- | --- |
| 40 KB 上的 `text += "x"` | 携带 40 KB 的 `replace` |
| 100 个元素上的 `arr.unshift(x)` | ~100 次 index 写入 |
| `arr.pop()` | 对 `length` 路径的一次写入，而它不是一个 document location |

Immer 自己的 pitfalls 页面陈述了这个保证：patch 是正确的，且
**明确不是最小的**。Colyseus 记录了同样的数组弱点 — 移除
20 个元素中的第一个要多花 38 字节。

我们自己把 base 与 result 做 diff 也不能修复它。一个 differ 看到的是两个
值，而不是 intent。前缀比较能捕获纯增长，但一个从前面丢弃*并且*
append 的滚动窗口既不是旧值的前缀也不是其后缀；
在 5000 个元素上测量，回退结果是
`{index: 0, remove: 5000, items: 5000}` — 一次完整替换，恰恰发生在
该优化存在的那个场景中。

所以收益并不来自盲目的整值 differ。tracker 记录哪些路径和数组操作变脏，然后在 `flush()` 时只把这些子树与其已接受的基线比较。

## 2. Ops

**元组就是形态。处处如此。不存在 keyed 变体。**

```ts
export type Seg = string | number;
export type Path = readonly Seg[];
/** Non-empty: `s`/`d`/`a`/`t` cannot target the root. Enforced by the type. */
export type NonEmptyPath = readonly [Seg, ...Seg[]];

export type Op =
  | readonly ["r", JsonValue]                            // replace the value
  | readonly ["s", NonEmptyPath, JsonValue]              // set
  | readonly ["d", NonEmptyPath]                         // delete
  | readonly ["a", NonEmptyPath, string]                 // append
  | readonly ["t", NonEmptyPath, number]                 // truncate, in chars
  | readonly ["p", Path, number, number, JsonValue[]]    // splice: index, remove, items
```

Interning、id 引用和省略的路径**不**在这里 — 它们位于
`WireOp` 中，只存在于 `encode` 和 `decode` 之间（§4）。

**`r` 是唯一替换整个值的 op。** 它是 op 而不是
frame kind，原因与 `a` 和 `t` 存在相同：它们是 `s` 的特化，
更小且陈述 intent。

不要把替换编码为根路径上的 set。Base-batch 检测是一个
**正确性边界** — recovery 在那里停止（§9）— 所以它必须是 token
比较 `ops[0]?.[0] === "r"`，而不是路径检查。一个检查路径的
谓词必须处理二元素 arity 形式，其中 `op[1]` 是一个值
而不是路径，并且会误分类 `["s", []]`。

**只有 `p` 可以以 root 为目标**，而且只是因为被跟踪的值本身可以是一个
数组 — 在 root 数组上 `entries.push(x)` 是 `["p", [], 3, 0, [x]]`。一个
覆盖其整个目标的 `p` 在 flush 时会被规范化为 `r`（root）或 `s`
（nested），所以 root 的 `p` 始终是部分修改。另外四个动词
接受一个 `NonEmptyPath`：`["s", [], v]` 和 `["d", []]` 无法通过类型检查。

**不要添加一个 keyed 的内存形态并在序列化边界配一个 codec。**
同一个东西的两种表示意味着两个 applier、两个大小估算，以及一个
没人需要的转换。Ops 在内存中、wire 上和磁盘上都是元组；
可读性正是 debug formatter 的用途。

六个动词。没有 `move`、`copy` 或 `test`：前两个是针对
我们没有的场景的大小优化，而 `test` 属于我们没有的冲突模型，
因为恰好只有一个权威写入者。

`chars` 计数 UTF-16 code unit，与 `String.prototype.slice` 一致。**不是字节。**
字节上限是生产者的关切，永远不会跨过边界。

该格式是 JSON-Patch-*形态*的，而非 RFC 6902 一致。这不花任何代价：
RFC 6902 自 2013 年以来没有继任者，仍然有同样的六个 op，而且
任何地方都没有添加字符串 splice。Immer 也从未一致过。

## 3. tracker

State 是**普通 TypeScript**。没有容器，没有 handle，没有 schema，没有
decorator。你正常地 mutate。

```ts
const t = track(laneView);
t.state.operation.streamingMessage.content[0].text += delta;   // -> append
t.state.transcript.push(entry);                         // -> splice
t.state.tools[0].details.failures.push({ name, msg });  // -> splice
delete t.state.config.model;                            // -> delete
const ops = t.flush();
```

三种机制，每种情况一个：

**对象** — 普通的 `set` / `deleteProperty` trap。

**数组 — 在 `get` trap 中拦截 mutator 方法。** `arr.push(x)` 首先经过
`get(arr, "push")`，所以 tracker 返回它自己的函数，记录
`splice(len, 0, [x])` 然后委托。Intent 是在引擎执行其 index 写入*之前*
被捕获的，这就是为什么 `unshift` 是一个 op 而不是
O(n)。这是其他库都不做的事情。

**字符串 — 在 `set` trap 上做脏标记，在 `flush()` 时做 overlap 检测。** 字符串是原始值，所以没有什么可拦截的。给定已接受的 `prev` 和最终的 `next`，找出 `prev` 的最长后缀，它是 `next` 的前缀：

```
overlap === prev.length  ->  append(next.slice(overlap))
overlap > 0              ->  truncate(prev.length - overlap) + append(rest)
overlap === 0            ->  set(next)
```

始终正确，因为 overlap 是**被验证的**，不是猜的。滚动
窗口可以工作：

```ts
s.out = s.out.slice(4) + "!!!";
// ["truncate", ["out"], 4]
// ["append",   ["out"], "!!!"]
```

### 3.1 Overlap 不得使用手写的 KMP

KMP failure function 在渐近意义上是对的，但**实践中慢 47 倍**，
因为它在 JS 中逐字符运行。在一个 50 KB 字符串上的 2000 次窗口滑动中
测量：KMP 为 2870 ms，原生探测为 61 ms。

探测方法：在 `prev` 中 `indexOf` `next` 的一个短头部，用 `endsWith` 验证每个
候选。两者都是原生的。在 200 次窗口滑动中验证与 KMP 相同。

先运行一条 `startsWith` 快速路径，所以纯 append — 占主导的情况 — 完全
跳过探测。

### 3.2 实现必须遵守的规则

**插入的值被收养；发出的 payload 在 flush 时被克隆。** 调用者可以保留只读引用，但不得在 tracker 之外 mutate 被收养的对象。`flush()` 克隆 payload 并推进一个克隆的已接受基线，所以发出的 ops 永远不会别名生产者的 state。

**`x = undefined` 规范化为 `delete`。** JSON 没有 `undefined`，而且在
一次 `JSON.stringify` 往返之后，一个值缺失的 `set`
与一个丢失的值无法区分。

**`arr.length = n` 被翻译，绝不作为路径发出。** 收缩变成一个
splice，增长变成 null 的 splice。`length` 是一个真实的 mutation，但不是一个
document location — 这是 Immer 附带发布的 bug（issue 208）。像早期原型那样
静默丢弃它，意味着 `arr.length = 0` 永远不会到达 replica。

**数字数组 key 被规范化为数字。** Proxy trap 传递 `"0"`；
路径携带 `0`。Valtio 附带发布的是字符串形式，这在大小和
比较上都更差。

**Proxy 按对象和路径缓存**，所以 `s.a === s.a`，proxy 不会
在每次访问时重建。

**Scope 只是 `JsonValue`，而且它必须被检查，而不是被假设。**
`structuredClone` 不是 JSON 检查 — 它会愉快地克隆 `Map`、`Set`、`Date` 和
`RegExp`，结果随后与 `JSON.stringify` 产生的东西不同，
所以生产者和 replica 静默分歧。在记录时断言该值并
拒绝 symbol key。见 §7.4 了解没有它会泄漏什么。

**恰好有两个 op 到达 root**，applier 的 root 分支必须处理
二者：`r` 始终，以及当被跟踪的值本身是数组时的 `p`。
`s`/`d`/`a`/`t` 按类型不可能，这使得该分支的 fallthrough 可证明
不可达。在那里只处理 `r` 会通过每一个手写测试，却会在
第一个产生 root splice 的随机化序列上失败。

**事务链内对同一地址的两次写入。** 当一个 commit 中对
同一地址发出若干写入时，每一次都必须针对上一次的结果记录，而不是针对事务前的状态。applier 按顺序 replay 它们；任何其他做法都会把第二次应用到一个过时的 base 上。这在暴露它的工作负载中并没有触发 — 如果触发了它会静默损坏。

### 3.2.1 替换整个值

对 `state` 赋值会替换它：

```ts
tracker.state = next;    // emits ["r", next]; discards ops recorded before it
```

`state` **必须是 tracker 上的 setter**，而不是普通属性。没有它，
`tracker.state = next` 会把 proxy 换成一个普通对象，之后每一次
mutation 都静默不被跟踪 — 没有错误，没有 ops，`target` 不变。它也是
任何人都会首先尝试的事情。

先前的 ops 被丢弃，因为它们描述了一个不再存在的值。

只有*完整*替换才会折叠为 `r`。重写值的一部分时，ops
会存活，因为它们确实更便宜：

```
partial rewrite        2 op(s), base=false
    ["s",["user"],{"id":"u2","name":"bob"}]
    ["s",["items"],["x"]]
```

### 3.2.2 第一次 flush 是一个 base batch

`track()` 打开一个流，而消费者从空开始，所以第一次 flush
总是发出 `["r", value]` — 携带在它之前所做的任何 mutation：

```ts
const t = track({ x: 0, l: [] });
t.state.x = 100;
t.state.l.push("xyz");
t.flush();      // [["r", { x: 100, l: ["xyz"] }]]
t.state.x = 101;
t.flush();      // [["s", ["x"], 101]]
```

要求生产者先记住一个 `rebase()` 会在运行时失败，在
消费者中，远离错误发生的地方。

### 3.2.3 稍后强制一个 base batch

```ts
tracker.rebase();        // next flush is ["r", value]; value unchanged
```

丢弃待处理的 ops 是正确的：proxy 直接 mutate target，所以
值已经携带了它们。在已落地的实现中 `tracker.state = tracker.state` 具有同样的效果，但 `rebase()` 直接陈述了 intent。

**没有任何东西会自行产生 base batch。** `flush()` 发出 ops；替换
只有在生产者要求时才发生。所以一串 append 会无限期地保持为
一串 delta。

Recovery 从最后一个 base batch replay（§9）。来自 `delta.examples.ts`，
一个向 50 KB 滚动窗口进行 500 次 durable 写入的 bash 形态工作负载：

| | 写入的 batch | recovery 时要 replay 的 |
| --- | --- | --- |
| 从不 | 500 | **499** |
| 每 50 次 `rebase()` | 500 | 0 |

两个调用者需要这个：

- **一个 durable sink。** `pendingToolOutput` 在命令运行期间每个 checkpoint
  累积一个 batch。一个运行十分钟的 `make -j8` 否则会在 resume 时留下
  数百个 batch 要折叠。每 N 次 checkpoint 让“最多 N
  个 batch 要 replay”成为一项策略而不是偶然。
- **resubscribe 时的 facet host。** `facets.md` §9.2 要求每个订阅的
  第一个 batch 是 base batch，而看到 gap 的消费者会
  resubscribe 以获取一个。host 必须能够按需产生一个，而不是
  等一个碰巧发生。

### 3.3 已知缺口

- `sort` / `reverse` / `fill` / `copyWithin` 把数组标记为脏并发出产生的结构性/index 变化，而不是保留生产者的方法 intent。只有当某个被测量的工作负载需要时才添加专门的 op。
- 一个手动的 index-shift 循环（`for (…) a[i] = a[i+1]`）仍然可能花费 O(n) 次 set。正确，非最小，且不可避免 — 生产者确实写入了每一个元素。
- 滚动窗口字符串赋值仍然在 flush 时运行 overlap 发现，这是故意的：生产测量不足以证明 text 专用的 tracker state 或 API surface 是合理的（[decision](append-decision.md)）。

### 3.4 字符串算法必须遵守的约束

其中每一项都很容易以一种能通过手写测试的方式出错。

**固定长度的探测无法找到比探测更短的 overlap。** 头部
必须确实出现在 `a` 中：`"abcdefgh"` -> `"defghxyz"` overlap 为 5，而
一个 64 字符的头部无法出现在一个 8 字符的字符串中。先尝试长头部，
然后回退到单字符头部。一个只使用 50 KB 字符串（其中
overlap 巨大）的测试会针对一个有问题的实现通过。

**限制候选扫描的范围。** 重复性输出 — 一个 build log，或一连串同一
个字符 — 会让一个长头部在数千个位置匹配，每个位置都要花一次完整的
`endsWith`。无界时，一个 50 KB 窗口上的 2000 次滑动需要 4.7 s，而有界时为 93 ms。
超出上界返回 0，这会发出一个 set：更大，但永不出错。

**在任何东西依赖于此之前先做 property test。** 3000 次随机 mutation
往返在第一次运行时就发现了 §3.2 中的 root-splice 漏洞；手写的
用例则不会。`delta.test.ts` 是要移植的测试套件。

## 4. codec

两个词汇表，不是一个。

`Op` 是 tracker 产生、`apply` 消费的东西。**路径始终是
内联的。** 它对字典一无所知。

`WireOp` 是跨过边界的东西。它恰好添加两种压缩：

```
["#", id, path]     defines an id, emitted on a path's SECOND use
a numeric PathRef   references a previously defined id
a shortened tuple   reuses the previous op's path; arity disambiguates
```

`encoder().encode(ops): WireOp[]` 和 `decoder().decode(wire): Op[]` 是二者存在的唯一地方。把它们排除在 `Op` 之外意味着 `apply` 没有 id 解析、没有 `#`
分支，也没有 previous-path 状态 — 从热路径中移除了三个分支 —
而且脏树生成在编码之前始终使用内联路径。

`["r", value]` 不携带路径，所以它编码为自身。这就是为什么 `isBase`
在两种词汇表上都原样工作。

### 4.1 两条容易出错的规则

**每个流一个 encoder/decoder 对。** id 表跨越整个订阅
或文件：在 batch 3 中被 intern 的路径会在 batch 40 中被引用。一个在
batch 40 订阅的第二个消费者从未见过该定义，所以它需要自己的
encoder。在消费者之间共享一个会把无法解析的 id 交给
迟到的订阅者，而 base batch 也救不了它 — `["r", value]` 不携带引用，
会让表保持为空。

**在 base batch 上重置表。** 读者用一个新的 decoder 从*最后一个* base batch
replay，所以一个 base batch 之后的一切都必须是自包含的。在
一次替换中携带 id 会发出对读者从未见过的定义的引用：

```
  4    : [["a",0,"x4"],["a",1,"y4"]]
  5 BASE: [["r",{…}]]
  6    : [["a",0,"x6"]]        <- id 0 was defined in batch 1
  -> RECOVERY FAILED: PathError - unresolvable path: 0
```

**Arity 省略的作用域限于一个 batch。** 让它跨 batch 会使一个 batch 的
第一个 op 依赖于前一个 batch 的最后一个，所以跳过或
重排 batch 的读者会解码到错误的路径。id 是唯一的跨 batch 状态，
而字典使它们显式化。

### 4.2 在第二次使用时 intern，而不是第一次

一个定义的成本高于它所替换的路径，所以在第一次使用时 intern
会在每一条恰好只写一次的路径上亏本 — 而大多数路径都是如此。在一个批量
工作负载上测量：**首次使用为 255.5 KB，完全不做 interning 为 179.6 KB。**

### 4.3 测量结果

Wire 字节 vs 内联路径，往返已验证：

| stream | inline | wire | 节省 |
| --- | --- | --- | --- |
| 一条热路径（一个滚动 tool-output 窗口） | 11,290 B | 7,538 B | **33.2%** |
| 四条交替路径（lane state） | 14,160 B | 11,032 B | **22.1%** |
| 200 条不同路径 | 16,455 B | 16,035 B | 2.6% |

省略在第一种情况下起作用，interning 在第二种情况下起作用。在第三种情况下
两者都无济于事，而定义还要花一点成本 — 这正是第二次使用
interning 存在以加以约束的情况。

## 5. Flush 发出 ops，并丢弃死掉的

`flush()` 针对最后已接受的基线为脏路径计算 ops。它不为每次 mutation 保留一个 op，所以重复和交错的写入以变化的状态为界，而不是以写入次数为界。没有大小比较或替换启发式：替换是生产者通过赋值 `state` 或调用 `rebase()` 所要求的东西。

一个较早的设计把 op 字节与值的序列化大小比较，并在 ops 更大时
替换。它被移除了。与无条件发出 ops 相比，在六个工作负载上测量，它改变了其中两个的输出 — 两者都要求在单次 flush 中改变数百条不同的路径。harness 和
replication 路径都不这么做：`LaneSnapshot` 一次折叠一个 event，而
最宽的情况（`run_end`）触及四个字段。该规则花费了每次 flush 的
比较、一个运行中的大小估算，以及一条针对无法维持它的 ops 的
失效规则。

### 5.1 脏树折叠

已落地的 tracker 只记录哪些子树是脏的。在 flush 时它把每个脏子树已接受的基线与它的最终值比较，并发出存活下来的结构性变化。对同一个字段的重复写入自然折叠；对两个字段的交替写入保留两条脏路径，而不是每次 mutation 一个 op；父替换在最终比较允许的地方包含脏后代。`packages/chord/test/delta.test.ts` 把交错的滚动窗口情况钉在 1,000 次交替写入后最多三个 op。

这取代了原型的向后 dead-op pass 和仅相邻的 coalescer。不要把这些算法移植到 Chord：flush 时生成才是 D1 的修复。

> **对象 key 顺序不是被复制的 invariant。** 值会往返，但在一次 flush 内的删除再重新插入活动可能在 replica 上产生不同的插入顺序。不要对被复制的值做哈希或内容寻址，并在显示顺序重要的地方显式排序。

## 6. 没有 frame 类型

逻辑 batch 是 `Op[]`；transport 和 durable storage 携带带状态编码的 `WireOp[]`。不要包裹任何一个 batch。

**`seq` 不属于 payload。** 它会防范一个我们并不拥有的有损
transport：一个 durable list 元素已经携带来自
storage 的 `seq`，进程内 callback 不会跳过，而 SSE 要么按顺序投递要么
中断 — 中断意味着 resubscribe，而 resubscribe 意味着一个 base batch。storage 的 `seq` 的第二份拷贝
只可能与第一份不一致。SSE binding 盖上 `id:`，
那才是 transport metadata 所属的地方。

**其他任何东西也不需要包裹。** 一旦替换是一个 op（§2），
`kind` 判别符就是多余的，而且地址已经说明一个 batch
属于哪个值。剩下的只会是一个包着数组的 struct。

一个生产者 batch 就是 `Op[]`，它的编码边界形式是 `WireOp[]`。一个 **base batch** 是其第一个 op 为 `r` 的 batch；
`isBase(ops)` 是 `ops[0]?.[0] === "r"`，这是精确的而不是启发式的，因为 flush
保证 `r` 出现在索引 0 处或者根本不出现（§5）。

frame 过去所做的一切现在都由已经存在的东西完成：

| 过去在 frame 上 | 现在 |
| --- | --- |
| `seq` | list 元素的 `seq`，或 SSE 的 `id:` |
| `kind: "replace"` | `r` op |
| 它属于哪个值 | 地址 |
| “这是一个 snapshot” | `"base"` storage tag |

**Resubscription 是一个 base batch 加上缓冲的 batch** — 与 lane
adapter 已经为 harness 所做的一样：先 snapshot，然后是客户端追赶期间
累积的任何东西。没有 `Last-Event-ID`，也没有跨订阅的
resume；那将需要一个保留的 op log，而 §5 刻意不保留。

一个看到 gap、无法解析路径或冷连接的消费者走一条
路径：请求一个 base batch。这就是为什么没有 `Rebase` 类型。

成本，直白地说：**消费者无法仅从 payload 检测陈旧。** 它依赖 transport 报告中断。对于 SSE 和进程内，这是可靠的。如果有损或多路复用的 transport 出现，sequencing 放在该 transport 的信封上 — 而不是回到 ops 中。

## 7. 安全性

Ops 来自一个 facet、一个 plugin compartment，或一个其 details 可能回显
model output 的 tool。**它们都不是可信输入**，而不受信任
数据与可信机制相遇的边界正是本设计必须守住的地方。

参照点是 CVE-2025-55182 — React Server Components 中的 RCE，CVSS 10.0，
已在野被利用。他们的 Flight 协议是一种紧凑的带标签 wire 格式，
会重建结构，所以相似之处是真实的。失败是*“未能
正确验证结构……把假对象当作真的”*：一个伪造的
Chunk 被解析为 Promise，并暴露了包含用于到达
`Function` 的 gadget 的内部状态。

**我们在结构上更安全，而且不是因为勤勉：**

| | Flight | ops |
| --- | --- | --- |
| 能描述运行时对象 | 能 — Chunk 解析为 Promise | 不能 |
| 能引用代码或模块 | 能 — client components | 不能 |
| 值 | 任意对象图 | `JsonValue` |
| 伪造 payload 的最坏情况 | RCE | 损坏的 replica state |

Flight *必须*引用代码；那是它的工作。一个 op 只能把一个 `JsonValue` 放在
一条路径上，所以 gadget chain 中没有第一环。这就是为什么攻击者无法
在 `Object.prototype` 上植入一个不解析的 `then`：一个仅数据的 `then` 不可
调用，而当 `then` 不可调用时 `await` 正常解析。

> **规则：任何 op 都不得命名 host 会解析的东西。** 不是 mutation 名，不是
> component id，不是模块引用。Mutation 名因一个
> 无关的原因被移除（§8）；这是永远不要重新引入它们的第二个、也是更好的理由，
> 因为正是这个成分让 Flight 可被利用。

### 7.1 路径是危险的部分

`JSON.parse` 本身是安全的 — `{"__proto__":{}}` 变成一个*自有*属性。
危险在于 `parent[key]`，而这正是应用一条路径所做的事。

单个 key 是不够的。`x["__proto__"] = v` 交换的是 *x 自己的*父对象，这是
局部的。需要一次**遍历** — `x["__proto__"]["polluted"] = v` — 才能到达共享的
prototype，而一条路径恰恰就是一次遍历。

`constructor` 比 `__proto__` 更糟，因为 `({}).constructor.constructor` 是
`Function`。这个梯子在这里被关闭，仅仅是因为 op 值不能是函数；
它通过拒绝该 segment 而被正确地关闭。

**保留路径 segment：`__proto__`、`constructor`、`prototype`。** 在
记录时*和*应用时都被拒绝，包括通过一个 interned 的 path id。

它们作为 *segment* 被保留，而不是作为值。一个带有字面量
`"__proto__"` key 的对象作为整值可以正常复制；只有*穿过*它的路径
被拒绝。这是对可 mutate 内容的一项真实限制 — 记录它，
不要假装它不存在。

针对同一危险的另外两项措施：

- **用 `Object.defineProperty` 写入**，绝不用赋值，这样继承的 setter
  无法运行。
- **只解析自有属性**（`Object.hasOwn`），这样一次遍历无法逃逸到
  prototype 链中，继承的 getter 也无法触发。这第二次
  阻止了 `constructor`，因为它是继承的。

prototype pollution 在这里实际给攻击者带来的东西比它最初
看起来的要窄：**它翻转默认值，它不覆写显式值。** 一个自有
属性会遮蔽。所以 `{name:"bob", isAdmin:false}` 不受影响；一个被读作
`opts.skipSandbox` 的 option bag 则不然。我们自己的 `ShellExecOptions`、`ShellOutputCaptureOptions`、
`ListReadOptions` 和 `TrackerOptions` 正是那种形态。还要注意
`"x" in {}` 和 `const {x = false} = {}` 在 pollution 下都会撒谎 — 这就是
applier 使用 `Object.hasOwn` 的原因。

### 7.2 数组索引

一个索引可以寻址一个已存在的元素，或恰好 append 到末尾之后一位。

这不是一个任意的上限；这是让值保持为 `JsonValue` 的东西。一个稀疏
数组无法在一次 JSON 往返后存活 — 空洞序列化为 `null` 并作为
真实属性返回 — 所以在一个长度为 3 的数组上 `arr[7] = x` 已经产生了
replica 无法匹配的 state。拒绝该写入比分歧更诚实。

它作为副作用而非目的移除了一种拒绝服务：
`["s",["xs",4294967290],1]` 否则会从一个 op 分配一个 42.9 亿条目的数组。
增长仍然可用且仍然成比例，因为
`arr.length = n` 被作为显式 null 的 splice 发出，其 op 大小随
间隔增长。

### 7.3 在 decode 时验证 op 结构

这是应用在我们身上的 RSC 教训。decoder 不得信任元组形态。
与一个未验证的 applier 相比测量：

| 格式错误的 op | 结果 |
| --- | --- |
| `["p",["xs"],0,0,"not-an-array"]` | 字符串被展开进数组：`["n","o","t",…]` |
| `["s","a",9]` — path 是一个字符串 | 被接受；`"a".slice(0,-1)` 是 `""`，所以它写到了 root |
| `["ZZZ",["a"],9]` | 被静默忽略，replica 分歧且没有错误 |

验证：verb 已知，arity 与 verb 匹配，path 是字符串和
非负整数的数组，`p` 携带整数 index 和 count 以及一个 items 数组，
`#` 定义一个数组路径。未知 verb 是一个**错误**，不是 no-op — 静默
跳过它正是较新生产者的 op 消失、replica 漂移的方式。

**每个词汇表一个验证器。** `assertValidOp` 守卫 `apply` 并拒绝 id、
短形式和 `#`；`assertValidWireOp` 守卫 `decode` 并允许它们。
用 wire 语法验证一个已解码的 op 比它自己的类型更宽松：一个
二元素 `["s", value]` 会通过，然后 `apply` 会把这个值读作
路径。

### 7.4 tracker 的笼子在类型上泄漏，而不是形态

一个 facet 无法伪造一个 op：它 mutate 普通对象，而 tracker 构建
元组，所以形态在构造上就是良构的。值和 key 是另一回事，
而 `structuredClone` **不是**一个 JSON 检查。

| 一个 facet 写入什么 | 会发生什么 |
| --- | --- |
| 一个函数 | 抛出（`DataCloneError`） |
| 一个 BigInt，一个循环 | 抛出 |
| `new Map([[1,2]])` | op 携带 `{}`，生产者保留一个真正的 Map — **静默分歧** |
| `new Date(0)` | op 携带一个 ISO 字符串，生产者保留一个 Date |
| `state[Symbol("s")] = 1` | 发出 `["s",[null],1]` — **来自我们自己 tracker 的一个格式错误的 op** |

所以 tracker 必须在记录时检查给它的东西，也就是错误所在之处：

- **拒绝 symbol key。** 它们不是 path segment。
- **对每一个被记录的值断言 `JsonValue`。** 显式拒绝 `Map`、`Set`、`Date`、
  `RegExp`、typed array 和 class instance。§3.2 中的 scope 限制
  曾是一条注释；它必须成为一个检查。

state 上的一个 getter 是安全的 — trap 记录计算出的结果 — 而一个
*看起来*像 op 的 facet 值嵌套在 `["s", path, value]` 内部，永远不能
被读作一个顶层 op，因为没有任何东西会扁平化。

### 7.5 Applier

```ts
export function apply<T>(target: T | undefined, ops: readonly Op[]): T;
```

六个动词，没有领域知识，没有库，没有 tool code，没有 registry 查找，以及
**没有 path 表** — id 和省略的路径在 `apply` 看到任何东西之前由 `decode` 解析（§4）。

它返回该值，而不是就地 mutate，因为 `r` 会直接替换它。
针对一个**消费者拥有的普通可变对象**运行。它不得被指向
一个由 Immer 产生的值，后者会深度冻结并会抛出。

任何语言的一页代码，这正是让非 JS 消费者保持可行的性质。Colyseus 基于同样的基础为 C#、Lua 和 Haxe 提供 decoder。

## 8. 这从代码库中移除了什么

具体的删除，而不是原则上的简化：

- **Immer**，从 harness 和 facet 层移除。见 §1 了解为什么一个
  产生 patch 的库无法服务于这个目的。
- **按类型的 reducer。** 只有一个 applier，`apply(target, ops)`，没有
  领域知识，也没有 registry。没人会为 `ToolOutputState` 或
  某个 plugin 的形态写一个 fold。
- **`detailMutations` 和 `initialDetails`**，以及随之而来的关于
  `details: unknown` 强制特殊处理的论点。一个结构性 tracker 永远不需要
  这个类型。
- **作为 reducer 返回值的 `Rebase`。** 一个无法应用的 fold 会让 state
  保持不变，而 host 发送一个 base batch。
- **wire 上的 Mutation 名**，以及由此而来的 mutation 名版本偏移。名字
  永远不会跨过边界，所以添加或重命名一个不是破坏性变更。

以及三件不要构建的事，每一件在读到 §1 之前看起来都合理：

- **一个盲目的整值 differ。** 已落地的 tracker 只把脏子树与其已接受的基线比较；它不扫描无关的 state。
- **一个 keyed op 形态加上一个 codec。** 元组处处是形态（§2）。
- **一个 frame wrapper。** 传输的是 `Op[]`（§6）。

## 9. Durable 形态

一个被跟踪的值存储为**编码的 `WireOp[]` batch 的列表**，每次 flush 追加一个。Base batch 携带 storage tag `"base"`；每个值一个带状态的 decoder 在 `apply` 之前解码它们。

Recovery 向后读到最后一个 base batch 并向前应用：

```ts
readList(address, { order: "desc", stopAtTag: "base", limit: 100 })
```

`stopAtTag` 是一个*页内*停止条件：如果页中没有 base batch，
消费者用 cursor 再次翻页。tag 位于 storage record 上，
在 `seq` 旁边，从不在值内部，所以 storage 永远不解析 ops。见
[scopes.md](../02-scopes/scopes.md) §11。

这正是让“一次替换截断 recovery”（§5）成为现实而非
空想的东西 — 读者在最后一个 base batch 处停止，而不是从头
replay。

## 10. 未决问题

- 前缀 interning（在 path head 上的一个 trie），如果出现一个有许多
  共享长前缀的不同路径的工作负载。第二次使用 interning（§4）移除了
  病态情况；这个会走得更远。
- 数组重排是否需要专门的 op；已落地的 tracker 目前把数组标记为脏并发出产生的结构性/index 变化。
- 跨语言 replica：applier 是任何语言的一页代码，但
  interning 表和 wire framing 没有为非 JS 消费者规定。

JSONL 日志中的 Address interning 是与 path interning 相同的技巧，应用
在 `namespace` + `key` 之上的一层。它**不是**一个未决问题 — 它
在 [scopes.md](../02-scopes/scopes.md) §12 中规定，并且是与本文这一个不同的字典。
