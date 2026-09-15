# Chord Delta

Chord Delta 将 JSON 值从权威 producer 同步到一个有序 replica。它可从
`@earendil-works/chord/delta` 获取。

一次变更由一个 `Op` 表示：一个用于替换、设置、删除、更新字符串或拼接数组的
JSON 元组。Producer 使用 `track()`；replica 使用 `apply()` 或
`applyImmutable()`。

```ts
import { apply, track } from "@earendil-works/chord/delta";

const tracker = track({ output: "", entries: [] as string[] });
let replica = apply(undefined, tracker.flush());

tracker.state.output += "done\n";
tracker.state.entries.push("result");
replica = apply(replica, tracker.flush());
```

第一次 `flush()` 返回一个包含完整值的 operation。之后的每次 flush 返回将先前
已发布的值转换为当前值所需的 operation。当值未发生变化时，它返回 `[]`。

`applyImmutable()` 只复制已变更路径上的容器，并共享未变更的子树。它不会修改、
clone 或 freeze 任何一个完整输入。Chord 的 replicated-state producer 修改一个
被跟踪的 proxy 并发布 operation 批次；consumer 仍然观察到完整的不可变值。

## 发送或存储变更

`flush()` 产生带有完整 path 的已解码 `Op[]`。这在本地使用时很方便，但会在 wire
或磁盘上重复较长的 path。

`encoder()` 压缩这些 path 并返回 `WireOp[]`。`decoder()` 校验编码后的元组、恢复
完整 path，并返回 `apply()` 所需的 `Op[]`：

```ts
import { apply, decoder, encoder, track } from "@earendil-works/chord/delta";

const tracker = track({ output: "" });
const enc = encoder(); // producer side
const dec = decoder(); // consumer side
let replica: { output: string } | undefined;

const send = () => {
	const ops = tracker.flush();
	const wire = enc.encode(ops); // serialize or store WireOp[] here
	const received = dec.decode(wire);
	replica = apply(replica, received);
};
```

对本地应用而言，编码是可选的。切勿将 `WireOp[]` 直接传给 `apply()`。

encoder 和 decoder 是有状态的。为每个有序流使用一对。encoder 会为跨批次使用的
path 分配数字 ID；decoder 会记住相应的定义。一个 complete-value operation 会
重置两个 path 字典，因此重放可以从该批次开始并使用全新的 decoder。

path 省略只在一个批次内局部有效。数字 path ID 可以跨批次。每个独立 hydrate 的
replicated-state 流都需要自己的 encoder 和 decoder。不要在 state member 或
subscription 之间共享一对，即使它们的批次使用同一个有序 transport connection。

## Operation 词汇表

path 是对象 key 和数组 index 组成的数组：

```ts
["operation", "message", "content", 0, "text"]
```

### 已解码的 `Op`

`track().flush()` 返回这些元组，而 `apply()` 接受它们：

| 元组 | 含义 |
| --- | --- |
| `["r", value]` | 替换完整的值。 |
| `["s", path, value]` | 设置一个 property 或数组元素。 |
| `["d", path]` | 删除一个对象 property。 |
| `["a", path, text]` | 向字符串追加。 |
| `["t", path, count]` | 从字符串前端移除 UTF-16 code unit。 |
| `["p", path, index, remove, items]` | 拼接数组。 |

除 `r` 之外，每个已解码的 operation 都携带其完整 path。`s`、`d`、`a` 和 `t`
不能寻址 root。`p` 可以寻址 root 数组。

### 已编码的 `WireOp`

`PathRef` 要么是内联 path，要么是非负的数字 path ID。`WireOp` 支持以下元组：

| 元组 | 含义 |
| --- | --- |
| `["r", value]` | 完整替换；与已解码形式相同。 |
| `["#", id, path]` | 定义一个数字 path ID。 |
| `["s", pathRef, value]` | 使用内联或 interned path 进行设置。 |
| `["s", value]` | 使用本批次中先前的 path 进行设置。 |
| `["d", pathRef]` | 使用内联或 interned path 进行删除。 |
| `["d"]` | 使用先前的 path 进行删除。 |
| `["a", pathRef, text]` | 使用内联或 interned path 进行追加。 |
| `["a", text]` | 使用先前的 path 进行追加。 |
| `["t", pathRef, count]` | 使用内联或 interned path 进行前端截断。 |
| `["t", count]` | 使用先前的 path 进行前端截断。 |
| `["p", pathRef, index, remove, items]` | 使用内联或 interned path 进行拼接。 |
| `["p", index, remove, items]` | 使用先前的 path 进行拼接。 |

例如，对同一个 path 的相邻已解码 operation：

```ts
[
	["t", ["output"], 200],
	["a", ["output"], "next chunk"],
]
```

编码为：

```ts
[
	["t", ["output"], 200],
	["a", "next chunk"], // reuses ["output"]
]
```

当 `output` 在稍后的批次中再次被使用时，encoder 会在其第二次显式使用时定义
一个 ID：

```ts
[
	["#", 0, ["output"]],
	["a", 0, "more"],
]
```

后续批次可以直接使用 `0`，直到某个 complete-value operation 重置该字典。

## 产生变更

像普通对象一样读取和修改 `tracker.state`：

```ts
tracker.state.status = "running";
tracker.state.settings.theme = "dark";
tracker.state.messages.push(message);
delete tracker.state.retry;
```

只有 flush 时的值会被发布：

```ts
tracker.state.status = "starting";
tracker.state.status = "running";
tracker.flush(); // one set to "running"
```

替换一个对象或数组是有效的。Delta 会将其 property 和元素与先前已发布的值进行
比较：

```ts
tracker.state.settings = {
	...plainSettings,
	theme: "dark",
};
```

未变更的 property 不产生任何 operation。已变更的嵌套字符串和数组仍然使用 string
和 splice operation。

### 字符串

追加文本会产生一个 `a` operation：

```ts
tracker.state.output += "next line\n";
```

当旧的后缀与新前缀匹配时，将有界文本窗口向前移动会产生 `t` 后跟 `a`：

```ts
tracker.state.output = tracker.state.output.slice(200) + nextChunk;
```

不相关的替换会产生 `s`。

### 数组

使用普通的数组方法：

```ts
tracker.state.messages.push(first);
tracker.state.messages.push(second);
tracker.state.messages.splice(3, 1, replacement);
```

在一次 flush 之前的所有 `push()` 调用会产生一个尾部 `p`。对较早元素的变更保持
独立，无论它们发生在这些 push 之前还是之后。对新 push 元素的变更会包含在被
push 的值中。

支持前端或中间插入、移除、排序、反转、`fill()` 和 `copyWithin()`。结构性变更与
对索引已移动的元素的编辑相结合时，可能会按位置比较并发布保留下来的后缀：

```ts
tracker.state.items.shift();
tracker.state.items[0].status = "changed";
// A shift followed by push in the same flush has the same issue.
```

此时发出的数据规模可能随保留下来的后缀或整个数组而变化，而不只是随已变更的
元素变化。当批处理在你的控制之下时，请在编辑新索引处的元素之前先 flush 结构性
变更。

不支持稀疏数组。写入超出下一个 index 的位置会抛错。增大 `length` 会创建显式的
`null` 元素；减小它会移除元素。

`fill()` 和 `copyWithin()` 保持正常的 JavaScript reference 语义。不要用它们将
一个可变对象放到多个活动 path 上。

### 可选 property

可选对象 property 使用缺失（absence）。它们不需要 `null`：

```ts
type Settings = { label?: string; count: number };
const tracker = track<Settings>({ count: 0 });

tracker.state.label = "active";
tracker.state.label = undefined; // produces d
// `delete tracker.state.label` is equivalent
```

`undefined` 只作为删除对象 property 的赋值语法被接受。它不是 JSON 值。初始对象
和被赋值的对象不能包含自己的 `undefined` 值，数组元素也不能是 `undefined`。当
某个数组位置或显式空值必须保持存在时，请使用 `null`。

## State 所有权

传给 `track()` 的对象会归 tracker 所有。之后被赋值进 state 或插入数组的对象也
是如此。

插入之后，保留的 reference 可以被读取，但不得修改，也不得插入到另一个活动
位置。tracker 依赖这条所有权规则；它不会递归校验值，也不会检测 alias：

```ts
const item = { status: "new" };
tracker.state.item = item;

tracker.state.item.status = "ready"; // supported: tracked mutation
item.status = "broken"; // unsupported: bypasses tracking
tracker.state.other = item; // unsupported: one object at two live paths
```

同样的限制也适用于跨多个独立的数组调用：

```ts
tracker.state.items.push(item);
tracker.state.items.push(item); // unsupported alias
```

当值必须出现在多个 path 上时，请使用不同的对象。通过 `tracker.state` 执行
mutation；不要把从 `tracker.state` 读取的 proxy 再放回被跟踪的 state。

被跟踪的 state 必须是一棵可变的 JSON 树：

- 字符串、布尔值、有限数字、`null`、数组和 plain object；
- 没有环，也没有一个可变对象被存储在多个位置；
- 没有稀疏数组、accessor、被 freeze 的对象、symbol、class、function、`Map` 或
  `Set`。

不要在会改变索引的数组操作期间保留子 proxy。请从其新索引再次读取该子对象。

## Tracker 生命周期

```ts
tracker.flush(); // publish changes since the previous flush
tracker.rebase(); // make the next flush a complete replacement
tracker.discard(); // accept current changes without publishing them
tracker.state = replacement; // replace the root; next flush is complete
```

`discard()` 有意阻止当前变更到达既有 replica。只有在那些 replica 不需要这些被
丢弃的变更时才使用它。

`apply()` 会从其输入批次中采纳对象和数组 payload。不要在应用之前 freeze 一个
批次，也不要把一个 in-memory 批次应用到多个可变 replica，除非每个 replica 都
拥有该批次。一个已序列化并解码的批次已经分离。`applyImmutable()` 则将其先前的
值和 operation payload 视为不可变，因此一个批次可以安全地在进程内扇出。

`decode()`、`apply()` 或 `applyImmutable()` 的错误会终止该流。丢弃它的 decoder
和 replica，然后从之后的某个 base 批次恢复。`apply()` 不是事务性的；失败
operation 之前的 operation 可能已经改变了 replica。

## 限制

- Delta 假设只有一个权威写者和有序投递。sequence number、间隙检测、重试和持久化
  策略属于周围的协议或存储格式。
- 对象 identity 不会被复制。被跟踪的可变 state 必须是一棵树；不可变输入可以共享
  reference，但 replica 不必保留它们。
- 对象 key 的插入顺序不会被复制。不要使用序列化后的 key 顺序来比较或 hash
  replica。
- 会改变索引的数组操作可能会发布更宽的数组区域，如“数组”一节所述。
- 名为 `__proto__`、`constructor` 或 `prototype` 的对象值 key 可以被读取和
  序列化，但不能通过该 key 进行修改。请改为替换最近的一个以普通方式命名的父级。
