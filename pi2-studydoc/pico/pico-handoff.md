# Handoff：pico 待定决策

`packages/agent/docs/pico/` 的剩余补充内容，需在实现之前与 `pico-v3.md`、
`pico-usage-guide.md` 与 `pico-work.md` 对齐。已纳入的决策与被拒绝或已被取代的提案均省略。
分两部分：先是 harness 补充，然后是 presentation 补充，后者还需要 task provenance 与类型化 preview 访问。

---

# Part 1 — Harness

## 1.1 Preview 投递被合并

Scratch commit 从不会被延迟，但发往 watcher 的 `task_output` 投递会按 task 合并到
一个 frame interval（规则见 `docs/mobile-handoff/01-harness/04-tool-output/rate-limiting.md`），
因此一个快速 stream 每个 frame 只产生一个 event，而不是每个 token 一个。没有这一点，TUI 会
按 token 重绘。

位置：§9.4，紧邻 tracker 段落。

## 1.2 Hook handler 接收 task 的 scratch

一个等待人（审批、提问）的 handler 必须能够持久化地 memo 其答案，
否则等待中途崩溃会重新询问，答案之后崩溃也会再次询问。在 handler 的 context 中给它 `scratch` 与
task id，并陈述该模式：在一次 scratch commit 中 read-then-set，先写者胜；答案之前崩溃会重新询问，
答案之后崩溃会 replay 到同一个答案；memo 随 task 退役。这取代了 `plugins.md` 的 `memoOnce` 与 invocation-memo API，并且
正是 question extension 所需的同一种形态。

```typescript
h.hooks.on(toolKind, 'before_tool', async ({ toolName, args, scratch, taskId }, call) => {
  if (toolName !== 'bash') return;
  const decision = scratchValue<'allow' | 'deny'>('approval');
  let d = await scratch(sc => sc.value(decision).get(), call);
  if (d === undefined) {
    const answer = await approvals.ask(taskId, args, call); // keyed instance every presentation observes
    d = await scratch(async sc => {
      const stored = await sc.value(decision).get();
      if (stored !== undefined) return stored;
      sc.value(decision).set(answer);
      return answer;
    }, call);
  }
  return d === 'allow' ? { args } : { block: { reason: 'denied by user' } };
});
```

位置：§8.7 以及指南的 Hooks 部分。

## 1.3 预算所有权转移

work plan 已经指出，任意 tool-work adoption 尚未解决。在所有权设计确定后，给它一个单独的包：
在预算过期后收养一个非委托 tool 的进行中工作，需要在源 invocation
释放其 slot 之前，显式转移 effect 与 sink 的所有权。job-first 路径先发布。

位置：`pico-work.md`。

---

# Part 2 — Presentation

## 2.1 Task provenance 是 `byTaskId`，不是 `JobState.origin`

`origin: { tool, task, callId }` 是针对某种 harness 以通用方式知晓的东西的、类别特定的 enum。
用一个由 `Tx` 从提交 invocation 填充的字段取代它：

```typescript
interface Task { …; readonly byTaskId?: Id }   // task whose commit created it; absent = created outside any task
```

tool 的 job 其 `byTaskId` = 该 tool task，因此 renderer 读取该 task、`toolKind.is(t)`，
并使用该 tool 的 component。schedule 是一个自身 state 中带 `every` 的 job；没有其他东西标记它。
Subagent task 将 `byTaskId` 链到 `run`/`spawn` tool。`Entry.byTaskId` 已存在；这
使 task 变得对称。从 `JobState` 中、从 §8.3 的 bash 示例中以及从
notice 文本中移除 `origin`（从创建它的 task 派生）。

位置：§5.1、§8.3、§8.6。

## 2.2 `!cmd` 是 client 拥有的 task 类别

用户运行的 bash 由 UI 发起，而非由 model 或某个 tool 发起，因此它是自成一类的类别，由
coding agent（或其 bash plugin）拥有，与 `jobKind` 共享 exec-into-scratch helper。其
settlement 把 transcript 写入记录在与 `settle` 同一次 commit 中，因此在此期间崩溃的 client
不会留下任何需要修复的东西。使用 `tx.write`：它在安全时立即 append，否则排队
直到下一个 turn 边界：

```typescript
type UserBashInput = { cmd: string; cwd: string; includeInContext: boolean; limits?: ShellOutputLimits };
type UserBashStates = UserBashInput & (
  | { status: 'planned' }
  | { status: 'running' }
  | { status: 'done'; exitCode: number }
  | { status: 'killed' }
  | { status: 'lost' }
);
function userBashInput(state: UserBashStates): UserBashInput {
  return { cmd: state.cmd, cwd: state.cwd, includeInContext: state.includeInContext,
    ...(state.limits === undefined ? {} : { limits: state.limits }) };
}

const userBashKind = defineTaskKind<UserBashStates>()({
  kind: 'pi.user_bash',
  initialStatus: 'planned',
  roles: { planned: 'start', running: 'inflight', done: 'terminal', killed: 'terminal', lost: 'terminal' },
  preview: { init: async scratch => (await scratch.value(output).get()) ?? emptyOutput() },

  async execute(task, runtime, call) {
    await runtime.commit(tx => tx.patch(task, 'running', userBashInput(task.state)), call);
    const result = await execIntoScratch(runtime, task.state, call);       // same helper as jobKind
    const out = runtime.preview.state;
    await runtime.commit(tx => {
      tx.write(userBashKind.entry, {
        data: { cmd: task.state.cmd, exitCode: result.exitCode, output: out },
        model: task.state.includeInContext ? [userBashMessage(task.state.cmd, out, result.exitCode)] : undefined,
      });
      tx.settle(task, 'done', { ...userBashInput(task.state), exitCode: result.exitCode });
    }, call);
  },
  async recover(task, runtime, call) {
    await runtime.commit(tx => tx.settle(task, 'lost', userBashInput(task.state)), call);
  },
  async abort(task, runtime, call) {
    await runtime.commit(tx => tx.settle(task, 'killed', userBashInput(task.state)), call);
  },
});

// the "!" handler
await c.commit(tx => tx.task(userBashKind, {
  background: true, state: { status: 'planned', cmd, cwd, includeInContext, limits },
}), call);
// Escape → h.abortTask(id, call); the renderer's task_start / task_output / entry cases do the rest
```

这是任何 client 拥有的“会运行且应出现在 transcript 中的东西”的模式：一个
kind，而不是内置项上的一个 flag。把它用作指南中 client 定义 task kind 的示例；它比
reminder 更好。

位置：指南的“Writing Kinds”。

## 2.3 两种渲染风格都是一等的

§9.4 把 `apply(view)` diffing 呈现为渲染方式。它是两种方式之一，另一种是
coding agent 的 interactive 模式保持不变：

- **Event-driven**：generation 上的 `task_start` 生成一个 streaming component；`task_output` 从 view 的 preview
  更新它；tool 上的 `task_start` 生成一个 tool component；`task_end` 使其退役；
  `entry` 完成收尾。记账是一个 streaming component 加一个 map，与今天一样。
- **View-driven**：`apply(view)` 与上次绘制的内容做 diff，用于在 turn 中途
  接入或 resnapshot 的 client。

view 在两者中都是权威的：它是 client 在 attach 时渲染的内容，并且它在
listener 运行之前就已被 fold。相应地重写“The view is authoritative and the events are wake-ups”
段落，并以 event 开关引导指南的 Rendering 部分。

从 `packages/coding-agent/src/modes/interactive/interactive-mode.ts`（`handleEvent`、
`renderSessionEntries`）的映射：

| interactive 模式 | pico |
|---|---|
| `agent_start` / `turn_start` / `message_start(assistant)` | `task_start`, `generationKind.is(t)` |
| `message_update`，包括由 streaming tool call 诞生（以 call id 为 key）的 tool component | generation 上的 `task_output`；preview 是部分的 `AssistantMessage` |
| `message_end`；aborted/error → pending tool 获得 error result，否则 `setArgsComplete` | `entry`, `assistantKind.is(e)` |
| `tool_execution_start` / `_update` / `_end` | tool task 上的 `task_start` / `task_output` / `task_end`；结果经 `entry`、`toolResultKind.is(e)`，以 `e.key` 为 key |
| `compaction_start` / `_end` | `task_start` / `task_end`，`collapseKind.is(t)`；在 summary `entry` 上重新渲染 |
| `auto_retry_start` / `_end` | `task_update` 到/从 `retry_wait`；失败在 `task_end` `failed` 上 |
| `summarization_retry_*` | collapse task 上的 `task_update` |
| `agent_end` / `agent_settled` | 任意 `task_end` 之后：view 中没有活动的前台 task |
| `queue_update` | `inbox` |
| `thinking_level_changed` | `value`，`addr === generationKind.config.thinking` |
| `session_info_changed` | session watch `value` |
| `entry_appended(custom)` | 某个 plugin 或未注册 kind 的 `entry` |
| `bash_execution_update` | `pi.user_bash` task 上的 `task_output`（2.2） |

比今天多一个 map：tool task id → call id，因为 tool component 是在
assistant message 流式输出期间（以 call id）创建的，之后才与其 task 关联。

## 2.4 类型化 preview 访问

Renderer 不应做类型转换。view 提供由 kind 见证的类型化 accessor，
与 reducer 和 wire 使用的原始 map 并列：

```typescript
interface ConversationView {
  readonly previews: ReadonlyMap<Id, JsonValue>;                          // raw, kind-free
  preview<S extends TaskStateBase, H extends HookPoints, C extends ConfigSpec, P, R extends TaskRoles<S>>(
    kind: TaskKind<S, H, C, P, R>, task: Id): P | undefined; // typed; undefined if missing or another kind
}
const msg = w.view.preview(generationKind, event.task);   // AssistantMessage | undefined
const out = w.view.preview(toolKind, event.task);         // ToolOutputState | undefined
```

在 `task_*` 情形中，`kind.is(task)` 已经收窄了 `task.state`。

位置：§9.4 以及当前每个做类型转换的示例。

## 2.5 Renderer registry 与 layout

渲染有两项职责，client 将它们分开：

- **Renderer**，每个 kind 一个，可替换：`renderers.entry(kind, previous => …)` 与
  `renderers.task(kind, previous => ({ start, output?, update?, end }))`。内置项以
  相同方式注册，因此 plugin 通过在同一 kind 下重新注册并接收
  先前的 renderer 来替换或包装它。未注册的 kind 获得通用回退：entry 用 model 文本或折叠的
  数据，task 用 kind + status + preview。Renderer 从不设置 component 的父子关系。
- **Layout**，是对已渲染 block 的有序列表的纯函数：
  `Layout = (blocks: Block[], view) => LayoutNode[]`，其中 node 是一个 block 或一个 group
  `{ key, label, collapsed, children }`。按注册顺序应用；client 按 key 将
  树与 chat container 对账，并按 key 保留 open/closed 状态。

按 exchange 对 tool call 分组，以及把一次 run 折叠直到其最终答案，各自大约是十
行 layout 代码，并且它们可以组合。attach 时的 hydration 与实时渲染共享一条路径：从 `view.entries` 与 `view.tasks` 构建
block，运行 layout，对账。今天 handler 的非渲染
关注点（retry 与 compaction 的 Escape-handler 交换、working indicator、
summary 后重新渲染、shutdown 检查）留在 mode 中；plugin 不得劫持
Escape。

这仅是 presentation 侧的，是 `plugins.md` 已为 tool
renderer 描述的 contribution 形态，在 wire 上以 kind string 为 key，在代码中以 kind object 为 key。它属于指南的
Rendering 部分，以及 `pico-work.md` 的 package 20，作为 TUI 的对等目标。
