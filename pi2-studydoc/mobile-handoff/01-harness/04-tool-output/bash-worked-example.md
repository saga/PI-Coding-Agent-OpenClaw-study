# 实例演练：`bash` 端到端

一个工具穿过每一层。`execute` 做了简化 —— timeout 校验、
取消以及 exit-code 分支都被省略。输出路径上的所有内容都展示出来。

层级：exec env → `ToolOutput` sink → harness events → 持久化存储 → lane
状态 → facet → wire → consumer。

---

## 1. 工具

```ts
// packages/agent/src/harness/tools/bash.ts
export interface BashToolDetails { spillPath?: string; truncation?: ShellOutputTruncation }

export function createBashTool(): AgentHarnessTool<ExecutionToolContext, typeof bashSchema, BashToolDetails> {
  return {
    name: "bash",
    parameters: bashSchema,
    output: { retain: "tail", maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES },

    async execute(_id, { command, timeout }, signal, out, context) {
      const env = context.env;
      let view: ShellOutputView | undefined;

      const result = getOrThrow(await env.exec(command, {
        cwd: env.cwd,
        inheritEnv: true,
        timeout,
        capture: { limits: this.output, spill: true },
        onUpdate: (u) => {
          view = applyShellOutputUpdate(view, u);
          if (u.kind === "append") out.write(u.text);
          else out.replace(view.text);
          out.details.truncation = view.truncation;
          if (view.spillPath) out.details.spillPath = view.spillPath;
        },
      }, context));

      if (result.spillPath) out.details.spillPath = result.spillPath;
      if (result.truncation.truncated) out.write(`\n\n[${describe(result.truncation)}]`);
      if (result.exitCode) throw new Error(`Command exited with code ${result.exitCode}`);
    },
  };
}
```

从今天的实现中消失的东西有：滚动的 `tailOutput` 缓冲区、
`truncateTail`、`ensureFullOutputFile`、`createTempFile`、
`BASH_UPDATE_THROTTLE_MS`、`BASH_CHECKPOINT_INTERVAL_MS`、`updateDirty`、
`lastCheckpoint`、`scheduleOutputUpdate`、`emitOutputUpdate`、
`clearUpdateTimer`。大约 40 行工具本地的机制，被一个每个工具都能得到的捕获
策略所取代。

`execute` 返回 `void`。`details` 是一个字段，只设置一次 —— 并且注意该工具不再
计算 `truncation`，因为 env 拥有窗口，而工具不再知道被丢弃了什么。

## 2. exec env 在 source 处设上限

`env.exec` 在字节产生的地方应用 `ShellOutputLimits`。对于 sandbox host
而言，这意味着 `cat 1gb.txt` 永远不会把 1 GB 发到 agent 机器，而溢写
落在模型自己的 `read` 和 `grep` 运行的地方。参见 [`execenv.md`](../03-execenv/execenv.md)。

初始状态是一次有界的 `replace`。增长会发出 `append`；移动的 tail 会发出
`slide { drop, text }`；完整 turnover 回退为一次有界的 `replace`；metadata 移动总计值和 spill 路径而不重发文本。自适应发布器让小 slides 保持响应，并按 encoded size 间隔上限大小的 turnovers。

## 3. sink

`ToolOutput` 把这些折叠进 `ToolOutputState`：

```ts
{
  content: [{ type: "text", text: "…the retained window…" }],
  details: { spillPath: "/tmp/pi-session-x/bash-8f2.log" },
  usage: undefined,
  addedTools: undefined,
  terminate: false,
  truncation: { truncated: true, truncatedBy: "bytes", totalLines: 8123, totalBytes: 262144 },
}
```

`out.write(text)` 追加到 `content[0].text`；当 env 发送一个 `snapshot` 时，`out.replace(text)` 会赋值
整个保留视图，因为一次 append 无法表达淘汰。tracker（`delta.md`）以两种方式记录 intent：一次 append 是
一个 `a`，而整体赋值的窗口滑动会通过经过验证的
重叠检测变成 `t` + `a`。

## 4. Ops

一次 256 KB 的 build，跨约 20 次 flush，窗口 50 KB：

第一批是 base batch —— 它以 `r` 开头，携带初始状态。之后的一切
都是 deltas。重复出现的 content 路径在第二次使用时被 intern，之后
对它连续进行的 ops 会完全省略 id：

```jsonc
[["r",{"content":[{"type":"text","text":""}],"details":{},"terminate":false,"truncation":{…}}]]

[["a",["content",0,"text"],"make: Entering directory …\n"]]
[["#",0,["content",0,"text"]],["a",0,"cc -c src/a.c …\n"]]
[["a",0,"cc -c src/b.c …\n"]]
…
[["s",["details","spillPath"],"/tmp/pi-session-x/bash-8f2.log"]]
…
[["t",0,4096],["a","cc -c src/z.c\n"],["s",["truncation","totalBytes"],262144]]
```

Details 是一个 `s`，出现在二十次 flush 中的一次里。`t` + `a` 对就是窗口滑动。当前的 tracker 通过经过验证的重叠来恢复它；生产环境的重新测量表明通用路径已经可以忽略不计，因此没有添加显式的 append/truncate producer API（[decision](../01-delta/append-decision.md)）。

## 5. Harness events

```ts
{ type: "tool_start",  toolCallId: "call_7", toolName: "bash",
  args: { command: "make -j8" } }

{ type: "tool_update", toolCallId: "call_7", ops: [ … ] }

{ type: "tool_end",    toolCallId: "call_7", isError: false }
```

`tool_start` 只携带 identity —— 没有 `caps`，没有 `initial`。第一批是 base
batch，所以初始状态通过 update 通道到达，而 caps 已经
作为 `truncation.maxBytes` / `maxLines` 位于其中。

`tool_end` 不携带 content，也不携带 details。每一个字节都已经发出去了；
重发会复制任何 images。

## 6. 持久化存储

`pendingToolOutput(operationId, "call_7")`，**ephemeral-scoped** 到该 operation，
因此它存在于 `<session>.op_….jsonl` 中，并在 settle 时退役，而不是
永远持久化在主日志中。退役是一条主日志的 `retireScope` 记录，
因此它与 settle 写入原子地提交；unlink 是重放该记录的结果，
而不是事务的一部分（[scopes.md §5](../02-scopes/scopes.md)）。

一个 `list<WireOp[]>`，每次 flush 追加一个 encoded batch，base batches 打上 `"base"` 标签，这样 recovery 会用 `stopAtTag` 向后读取并停在那里（[scopes.md §11](../02-scopes/scopes.md#11-list-tags-and-stop-conditions)）。tracker 发出结构性的 ops；producer 周期性地调用 `rebase()` 来写入一个受上限约束的根替换并约束 recovery 重放。持久化间隔是 sink 策略。Shell 捕获只控制 source-state 与传输发布；memo、terminal 以及 recovery-base 的 flush 由 `ToolOutput` 强制触发。

Recovery 从那个状态播种一个新的 `ToolOutput` —— 它**不会**删除它，
而删除正是今天的 `clearReplayCheckpoint` 所做的事，这是一个 bug
（`harness-tools.md` §7.4）。如果 bash 已经 memo 了 "spilled to /tmp/…" 然后崩溃，一个丢弃了该状态的
replay 会创建第二个 spill 文件并丢失第一个。

memo 写入与这个 checkpoint 在同一事务中提交。两者都是
ephemeral-scoped，所以两者都落在同一个 sidecar 中 —— 而类型系统会拒绝一次
混合了 scopes 的 commit，因此这不会静默地回退。

## 7. Lane 状态与 facet

```ts
export function reduceLaneSnapshot(view: LaneView, event: HarnessEvent): void {
  switch (event.type) {
    case "tool_start":
      view.operation.tools.push({ id: event.toolCallId, name: event.toolName,
                                  args: event.args, output: undefined });
      return;
    case "tool_update": {
      const tool = view.operation.tools.find((t) => t.id === event.toolCallId);
      if (tool === undefined) return;                  // host will send a base batch
      tool.output = apply(tool.output, event.ops);
      return;
    }
    case "tool_end": {
      const i = view.operation.tools.findIndex(t => t.id === event.toolCallId);
      if (i >= 0) view.operation.tools.splice(i, 1);
      return;
    }
  }
}
```

Plain mutation，没有 Immer，没有返回值。一个针对视图从未见过的工具的事件
只是什么都不做；host 会发送一个 `replace`。

一个 lane facet 在 tracker 之下运行同一个函数，因此该 facet 自己的 ops
会针对**它自己的**形状产生 —— 那个形状不必是 `LaneView`，而且通常
也不是。该 facet 从不写入 op。

## 8. Wire 与 consumer

```jsonc
{ "seq": 0, "ops": [["r",{"transcript":[],"operation":null}]] }
{ "seq": 1, "ops": [ … ] }
```

一种形状：一批 ops。第一个是 base batch —— 它以 `r` 开头 ——
之后的一切都是 deltas。一个 gap、一次 reconnect、一次 provider
reload，或者一次无法全部应用的 fold，都走同一条路径：发送一个全新的 `replace`。

consumer 就是 `apply` —— 六个 verb，没有领域知识，没有库，没有工具
代码，作用于一个它拥有的普通可变对象。

## 9. 这次运行的代价

256 KB 的输出，约 20 次 flush，50 KB 窗口：

| | today | this design |
|---|---|---|
| durable writes | 每个 checkpoint 一个完整的 `AgentToolResult` | 结构性 ops 加上显式的周期性受上限约束的 base batches |
| durable location | 主日志，永远 | sidecar，settle 时 unlink |
| wire per flush | 整个 snapshot | 一个 `truncate` + 一个 `append` |
| details written | 每次 flush 都整体重建 | 一次 `set`，只做一次 |
| truncation logic | 在 `bash.ts` 中 | 在 exec env 中，由所有工具共享 |
| spill location | `/tmp`，由 OS 清理 | exec env，session-scoped |

details 那一行值得细细琢磨。关于 bash 的 details，什么都没有
改变 —— 它们一直都很小。改变的是它们不再搭乘在一个
每次 update 都被整体替换的容器里，这就是为什么目前任何地方的工具都不会费心去增量地
mutation 它们。
