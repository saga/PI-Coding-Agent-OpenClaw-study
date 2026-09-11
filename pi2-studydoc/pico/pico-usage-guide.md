# pico

pi 的持久化 agent harness：一个 session 文件，任意数量的对话，每一项工作
都记录为一个 task，崩溃后依然存活，还有一个任何 UI 都能渲染的视图。

**注意**：本指南讲的是如何使用这个 harness。`pico-v3.md` 是设计文档，也是
解释事情为何如此的参考。

## 目录

- [心智模型](#the-mental-model)
- [Call 与取消](#calls-and-cancellation)
- [安装](#installation)
- [快速开始](#quick-start)
- [Session 与对话](#sessions-and-conversations)
  - [打开](#opening)
  - [重新打开时会发生什么](#what-happens-on-reopen)
  - [关闭](#closing)
- [配置](#configuration)
  - [由 kind 声明的设置](#settings-declared-by-kinds)
  - [读取与写入](#reading-and-writing)
  - [什么是可回退的](#what-is-rewindable)
- [系统提示与工具装配](#system-prompt-and-tool-loadout)
  - [工作原理](#how-it-works)
  - [响应 hook](#answering-the-hook)
  - [更改装配](#changing-the-loadout)
  - [来自 plugin 的 section](#sections-from-plugins)
  - [subagent 有自己的](#subagents-have-their-own)
  - [Compaction、fork 与重启](#compaction-forks-and-restarts)
- [提示](#prompting)
  - [prompt、accept、drive](#prompt-accept-drive)
  - [忙碌时的输入](#input-while-busy)
  - [中止](#aborting)
- [观察](#watching)
  - [视图](#the-view)
  - [事件](#events)
  - [渲染](#rendering)
  - [远程客户端](#remote-clients)
  - [Session 观察](#session-watch)
- [Fork](#forks)
- [Compaction 与重置](#compaction-and-reset)
- [Subagent](#subagents)
- [Job 与 Schedule](#jobs-and-schedules)
- [Plugin state](#plugin-state)
  - [值与列表](#values-and-lists)
  - [原子提交](#atomic-commits)
- [编写工具](#writing-tools)
  - [sink](#the-sink)
  - [诊断](#diagnostics)
  - [长时间运行的工具](#long-running-tools)
- [Hook](#hooks)
- [编写 kind](#writing-kinds)
  - [Entry kind](#entry-kinds)
  - [Task kind](#task-kinds)
- [Recovery](#recovery)
- [存储后端](#storage-backends)

## 心智模型

一个 **session** 是一个存储文件（或 SQLite 中的一组行）。它容纳若干**对话**。一个
对话有三样东西：

- 一个 **transcript**：一个只追加的不可变 **entry** 列表。用户消息、助手消息、
  工具结果、摘要、系统指令，以及 plugin 想记录的任何东西。Entry 永远不会被编辑
  或重排。
- **task**：工作的单位。生成一个响应是一个 task，运行一个工具是一个 task，
  compaction、运行一个后台进程，或 plugin 想完成的任何事也是如此。一个 task
  有一个随运行而变化的 status，并在每一步都写入存储，这正是崩溃
  可恢复的原因。
- **state**：带键的 **value** 和 **list**，用于当前使用的模型、plan mode、一个游戏
  棋盘，或 plugin 需要记住的任何东西。

模型看到的东西，即 **context**，并不是作为列表存储的。每个 entry 可以存储 `model`
消息、一个 **head** 边界，以及省略或替换更早 model 消息的 **edit**。harness
前置最新的 head，从其存储的边界向前读取，折叠保留的 edit，然后执行
请求本地的工具与 provider 归一化。Compaction 追加一个 head；工具结果剪枝
追加一个 edit。Fork、compaction 和重置永远不会改变旧的 entry。

每个 id 都是一个 session 序列号，在构建写入时铸造，永不改变：

```typescript
type Id = number;
```

所有写入都通过 **commit** 发生：一个在 session 唯一写入线上运行的闭包，
其中内部的一切一起落地，要么就完全不落地。Task 并发运行；写入从不并发。

没有东西会自行运行。打开一个 session 不会启动任何东西。**drive** 一个对话才
使其 task 执行，而 `prompt` 不过是 accept + drive + 读取答案。一个 UI **watch**
一个对话，并得到一个可以直接渲染的**视图**。

## Call 与取消

每一个异步的 harness、对话与 task-runtime 操作都接受一个必需的末尾 `Call`。
`Call` 是 Chord `Context` 的类型别名：它携带一个 abort signal、telemetry parent，以及
对于 task 代码来说，一个私有的带类型调用标识。它不是模型 context。不需要
任何强制转换或准入辅助函数。纯访问器、同步注册，以及事务内部的方法
不接受 Call。

```typescript
import type { Call } from '@earendil-works/pi-agent';
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context';

const call: Call = BACKGROUND_CONTEXT; // host call, without cancellation
const { context: waitingCall, cancel } = withCancel(call);
const waiting = conversation.drive(waitingCall);
cancel();                            // removes this waiter; does not abort durable work
await waiting;                       // rejects with cancellation
```

Task 接收 `(task, runtime: TaskRuntime, call: Call)` 并转发 `call`。工具接收
`(toolCallId, params, out, runtime: ToolRuntime, call: Call)`。环境/provider/hook 操作
解释该 signal；自定义 handler 必须配合。为嵌套 telemetry 或更紧的
deadline 派生一个 Call 并继续向下传递。driver 不会把 drive 调用方的 signal
继承进 task 执行。

该行通过一个私有的 `createContextKey<Invocation>` 读取 task 标识；Chord 从
`call.value(key)` 返回正确的类型。派生的 call 保留那个精确的对象。陈旧的 task
写入会 reject。没有调用标识会通过 RPC 序列化；受信任的 host 绑定在本地
提供它。故意使用一个无关的 host Call 或忽略取消，是一种进程内逃逸，
不是 facade 或类型能够阻止的事情。

## 安装

```bash
npm install @earendil-works/pi-agent
```

## 快速开始

```typescript
import { Harness, JsonlStorage, systemSections, type Call } from '@earendil-works/pi-agent';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { readTool, writeTool, bashTool } from '@earendil-works/pi-agent/tools';
import { generationKind } from '@earendil-works/pi-agent/kinds';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const call: Call = BACKGROUND_CONTEXT;

// One file per session. Reopening the same file resumes it.
const storage = await JsonlStorage.open('./session.jsonl');

// The built-in kinds (generation, tool, post_tools, collapse, job; the entry kinds) and the
// subagent and job tools are registered by open. You add models and the tools you want. Nothing runs yet.
const h = await Harness.open(storage, {
  models: builtinModels(),
  tools: [readTool, writeTool, bashTool],
  // Address/value pairs, applied only when creating the root; reopening preserves stored settings.
  rootValues: [
    [generationKind.config.model, { provider: 'anthropic', modelId: 'claude-opus-5' }],
    [generationKind.config.thinking, 'high'],
    [generationKind.config.selectedTools, ['read', 'write', 'bash']],
  ],
}, call);

const c = await h.root(call);

// Configuration is durable state; this hook edits the prepared section payloads.
// The harness stores changed payloads and rendered system messages before each request.
c.hooks.on(generationKind, 'system_instructions', ({ sections, config }, call) => {
  sections.set(systemSections.identity, 'You are a careful engineer working in this repository.');
  sections.set(systemSections.environment, { cwd: process.cwd() });
  return { tools: h.tools.select(config.selectedTools) }; // complete tool definitions
}, { subtree: true });

// Watch the conversation. `view` is a plain object a UI renders from; attach whenever you like,
// the view is complete as of the moment you attach and events follow from there.
const w = await h.watch(c.id, { tail: 100 }, call);
w.start(event => {
  if (event.type === 'task_output') {
    // the generation's preview is the partial assistant message; a tool's is its output so far
    const preview = w.view.previews.get(event.task);
    process.stdout.write(renderPreview(preview));
  }
  if (event.type === 'entry') console.log(`\n[entry ${event.entry.id} ${event.entry.kind}]`);
});

// accept the input, drive the conversation until it is idle, return the answer to that input
const answer = await c.prompt({ input: 'Inspect the parser and list the public API' }, call);
console.log(answer?.model[0]?.content);

w.unsubscribe();
await h.close(call);   // cancels nothing durable; reopening the file continues exactly here
```

运行它，中途杀掉它，再运行一次：第二次运行会恢复当时在途的一切
（发布一个部分答案，重跑或报告一个被中断的工具）并继续。这就是
全部要点。

下面的片段假设 `h`、`c` 和 `call` 像这样设置好。Call 之前的可选选项在
未使用时以 `undefined` 传入。一个 task 或 hook 总是转发它所收到的 Call，
而不是这个 host root。

## Session 与对话

### 打开

`Harness.open(storage, options, call)` 接收存储后端以及定义行为的一切：

| 选项 | 它是什么 |
|---|---|
| `models` | 一个 pi-ai `Models` 集合 |
| `tools` | 模型可以调用的东西，除了内置的 `subagent` 和 `job` 工具之外；一个 `ToolRegistry` 或一个数组 |
| `kinds` | plugin 的 entry kind 与 task kind，加入到内置项之上 |
| `replace` | 一个按名称替换掉的内置 kind（`{ generation: myGenerationKind }`）；它必须保留 status 与 hook 名称 |
| `rootValues` | 显式的初始 root 配置，只在全新 root 的创建 commit 中应用 |
| `sections` | 初始的自定义带类型 section 定义，在内置项之外 |

注册表提供实现，而不是选择。注册 read/write/edit/bash 并不会
自动选中它们。通过 `rootValues` 提供初始的 model/thinking/selectedTools，或者
在生成之前配置这个全新对话。在重新打开时，`rootValues` 被忽略：持久
配置优先。子项继承其 spawn 策略所选中的值；fork 在 fork 点继承
可回退的配置。缺少必需的 generation 配置是一个错误。

内置 kind 由 `open` 自身注册，因为没有它们，`accept`、`prompt`、`steer` 和
`collapse` 无法工作。通过 `h.kinds` 引用任何已注册的东西：

```typescript
h.kinds.generation   // config: model, thinking, selectedTools, ...; hooks: system_instructions, before_request, on_yield
h.kinds.tool         // hooks: before_tool, after_tool
h.kinds.collapse     // hooks: before_collapse
h.kinds.job
```

一个 replacement 通常是一个 wrapper，对它不改变的一切都委托给原始实现：

```typescript
import { generationKind } from '@earendil-works/pi-agent/kinds';
const h = await Harness.open(storage, { models, tools, replace: {
  generation: { ...generationKind, async execute(task, runtime, call) { await audit(task); return generationKind.execute(task, runtime, call); } },
}}, call);
```

Open 检查记录的 kind 字符串而不扫描 transcript，并报告活跃工作，但
不启动任何东西。一个未注册的历史 entry kind 会被报告，而不是被拒绝：它存储的
`model`、`head` 和 `edits` 仍然构建 context，而它的带类型数据与自定义渲染器
不可用。缺失的活跃 task kind 按照前台/后台状态来处理：

```typescript
const { start, inflight, orphaned, parked } = await h.inspect(call);
// start: tasks that never began or must begin again (a planned tool, a retry, a scheduled job)
// inflight: tasks the last process was running when it stopped; recover() will handle them
// orphaned: foreground tasks whose kind is missing (a plugin was uninstalled); settled at open
// parked:   background tasks whose kind is missing; they resume when it is registered again
```

### 重新打开时会发生什么

什么都没有，直到有东西 drive 一个对话。`h.drive()` 启动并恢复整个 session 中
符合条件的前台与后台工作；`c.drive()` 对单个对话的归属
scope 做同样的事。每个 promise 在其 scope 没有活跃前台 task 时 resolve。
它挂载的后台工作在此之后继续被服务。UI 通常对它显示的内容挂一个
watch 并 drive 那个。

```typescript
const h = await Harness.open(storage, opts, call);
void h.drive(call).catch(error => console.error(error)); // resume; report session faults
```

### 关闭

```typescript
await h.close(call);         // cancel in-process work, write nothing; everything resumes on the next open
await h.shutdown(call);      // mark live tasks, wait for abort cleanup, close; queued input survives
```

`close` 是正常的退出方式：它在 commit 线上停止准入，然后在它之外发出 signal
并 join 所拥有的调用，不写入 task 结果。更早的线上操作已经完成；
更晚的 mutation 会 reject。Close 等待实际的调用完成，与调用方的取消无关。
一个不配合的 task 可以无限期地拖延它。

`shutdown` 关闭正常准入，并且只原子地标记活跃 task。排队的输入及其排队的
结果记录仍然存储着，包括在空闲对话中。新的 abort handler 会 resolve 它们
已经在运行的输入组并完成清理。内置的子项清理只标记 task，从不排空
子项队列，包括在崩溃并重新打开之后。Shutdown 在关闭之前等待活跃 task 和正在运行的
call 都消失。保留的队列在重新打开/drive 时不会通过推断产生任何工作。

一旦被准入，调用方的取消不会放弃 shutdown。重复的生命周期调用共享
完成；显式的 close 打断 shutdown 会使 shutdown reject。Task 的 call 不能调用
host 生命周期方法。

## 配置

### 由 kind 声明的设置

不存在 settings 对象。一个 task kind 声明它读取的值，带类型，而这个声明
就是该地址被拼写出来的唯一地方：

```typescript
generationKind.config
// {
//   model:         conversationValue<ModelRef>('pi.model', { rewind: true }),
//   thinking:      conversationValue<ThinkingLevel>('pi.thinking', { rewind: true }),
//   selectedTools: conversationValue<string[]>('pi.tools.selected', { rewind: true }),
//   profile:       conversationValue<string>('pi.prompt.profile', { rewind: true }),
//   budgetMs:      conversationValue<number>('pi.tool.budget', { rewind: false }),
// }
```

一个 UI 可以通过遍历已注册 kind 的 `config` 列出某个对话被配置成了什么；
plugin 以同样的方式声明自己的值（见 [Task kind](#task-kinds)）。

### 读取与写入

```typescript
// all of a kind's values, one batched read
const { model, thinking } = await c.config(generationKind).get(call);

// some of them, one commit
await c.config(generationKind).set({ thinking: 'low' }, call);

// `settings` is config(generationKind), because that is what every UI touches
await c.settings.set({ model: { provider: 'openai', modelId: 'gpt-5.6' } }, call);

// one value, one point read, by its declared address
const tools = await c.value(generationKind.config.selectedTools).get(call);
```

一次更改就是一个普通的 commit：它以 `value` 事件的形式出现在 watch 流中，
下一次 generation 会拾取它。内存中没有任何可能与存储不一致的缓存。

### 什么是可回退的

一个值要么是 **rewindable**（它的历史被保留，在某个 entry 处的 fork 看到
当时生效的值），要么是 **sticky**（仅当前；是 UI 的当下，而不是对话的
历史）。Model、thinking 和 selected tools 是可回退的：在昨天的答案处 fork
得到昨天的 model。像 `ui.expanded` 这样的东西是 sticky 的。

由 `spawn` 创建的子项不继承历史；它们被显式初始化（见
[Subagent](#subagents)）。

## 系统提示与工具装配

### 工作原理

Pico 只向 pi-ai 发送 `{ messages }`：没有并行的顶层 `systemPrompt` 或 `tools`。被托管的
系统 entry 包含精确渲染出的 pi-ai 消息，包括完整的工具添加/移除。Pi-ai
拥有原生/回退翻译以及尽力而为的缓存保留。

配置更改仍然是普通的持久值写入。系统 entry 单独记录
为请求准备好的指令——而不是送达的证明。Host 文件、发现缓存、回调与
渲染器函数不被存储。Section JSON 载荷与最终渲染文本会被存储，因此
缺失的 plugin 不能让历史请求依赖于它的渲染器。

目标 pi-ai 系统消息 API 与 messages-only 适配器行为是集成前提
（[#9116](https://github.com/earendil-works/pi/pull/9116)，coding-agent 集成在
[#9117](https://github.com/earendil-works/pi/pull/9117)）。它们在审阅时还是 open 的；本指南描述的是
预期的契约，而不是声称那些 PR 已经实现了商定的适配器行为。

### 响应 hook

一个带类型的 section token 命名载荷及其追加时渲染器：

```typescript
interface SystemSection<T> {
  readonly key: string;
  render(value: T): string;
}

const rulesSection = defineSystemSection<string[]>({
  key: 'myplugin.rules',
  render: rules => rules.map(rule => `- ${rule}`).join('\n'),
});
await h.sections.register(rulesSection, call);
```

Token 在存储中使用稳定的字符串键。载荷必须可 JSON 表示；更改一个已注册的
载荷类型需要一个兼容的替换或迁移。带类型的 token 提供正常的 get/set
推断，plugin 代码中无需强制转换。内置项通过 `systemSections` 导出 token，例如
identity、environment 和 skills；它们的值来自 host，而不是来自注册表。

每次 generation 都从上一个持久 prepared state 播种一份私有的有序 section draft。Handler
顺序运行，先是 harness 全局的，最后是最内层对话的，编辑同一份 draft：

```typescript
c.hooks.on(generationKind, 'system_instructions', ({ sections, config }, call) => {
  sections.set(systemSections.identity, 'You are a coding assistant.');
  sections.set(systemSections.skills, skillsCache.current); // complete typed skill data
  sections.set(rulesSection, ['Run relevant tests.']);       // authoritative base for later transforms
  return { tools: h.tools.select(config.selectedTools) };  // complete selected JSON definitions
}, { subtree: true });
```

该 draft 提供：

```typescript
interface SystemSectionDraft {
  get<T>(section: SystemSection<T>): T | undefined;
  set<T>(section: SystemSection<T>, value: T): void;
  delete(section: string | { readonly key: string }): void;
  wrap<T>(section: SystemSection<T>, transform: (text: string) => string): void;
}
```

`get` 返回一份所拥有的副本；用 `set` 来更改 draft。已有的键保留它们的位置；新的
键追加。`delete` 是显式的——null 仍然是有效的载荷。带类型的 get/set/wrap 需要
已注册的兼容定义；删除即使在其定义不可用时也可以使用一个稳定的键。
不存在排序配置，而且仅重排不会发出任何更新。

Handler 完成后，被触及的 section 在线上之外渲染。Wrapper 在渲染之后按注册顺序
应用。冻结后的结果会与存储的载荷和渲染文本做 diff。数据改变
而渲染未变会产生一个仅元数据的系统 entry（`model: []`）；渲染改变而
数据未变仍然会产生一个系统消息更新。没有任何历史读取会运行这些函数。

### 来自 plugin 的 section

一个更晚的 handler 可以修改内置 section 的结构化载荷，而不是解析它的散文：

```typescript
c.hooks.on(generationKind, 'system_instructions', ({ sections }, call) => {
  const skills = sections.get(systemSections.skills); // typed skill array | undefined
  sections.set(systemSections.skills,
    (skills ?? []).filter(skill => skill.name !== 'deploy'));
});
```

向同一个键追加就是普通的带类型 get-and-set：

```typescript
c.hooks.on(generationKind, 'system_instructions', ({ sections }, call) => {
  sections.set(rulesSection, [
    ...(sections.get(rulesSection) ?? []),
    'Check migration safety.',
  ]);
  sections.wrap(rulesSection, text => `Repository policy:\n${text}`);
});
```

这个例子依赖于更早的 host handler 在每一次准备时把 `rulesSection` 重置回
它的权威基准。没有那次重置，反复向一个持久化种子追加会累积文本。
整条变换链在再次应用时必须产生相同的结果，或者从一个刷新过的基准开始；
当各个 handler 相互作用时，单个幂等是不够的。

Wrapper 是准备本地的。未被触及的 section 保留它们存储的渲染文本，包括
当贡献它的 plugin 消失时的旧 wrapper 输出。显式的 set/wrap 或渲染器替换
会重新计算它。刷新基准会有意从当前安装的 handler 重建 wrapper；我们
不承诺在那次刷新中保留缺失的 wrapper。

Skills 发现可以留在 hook 所有者的闭包中，或一个 host service 中。以有界的
时间间隔观察本地变化或轮询一个远程源；hook 调用读取缓存的 snapshot。
刷新失败不是移除：保留最后一次成功的 snapshot。当源确实消失时，
基础 hook 会显式删除它的 section。如果一个 handler 失败并被跳过，丢弃它的
draft mutation/wrapper，而不是更早 handler 的更改；一个半完成的刷新绝不能
移除指令。没有发现回调或私有缓存 state 被附加到存储的 section 上。

### 更改装配

配置在被更改时会被持久保存：

```typescript
await c.settings.set({ selectedTools: ['read', 'grep'] }, call);
```

下一次准备会渲染最终 draft 并将它与之前的 prepared state 比较。一个
transcript 可能看起来像这样（`readDefinition` 等指的是完整的 JSON 定义，
而不是可执行函数）：

```text
100 user
110 system baseline: identity + rules; add read/write
120 assistant
125 config write: selectedTools=read/grep             (durable state, not a transcript entry)
130 user
140 system delta: changed rules; remove write; add grep
150 assistant
```

存储的 baseline：

```typescript
const baseline: SystemEntry = {
  id: 110, conversationId: 1, kind: 'system',
  data: { baseline: true, sections: [
    { key: 'pi.identity', action: 'set',
      value: 'You are a coding assistant.', rendered: 'You are a coding assistant.' },
    { key: 'myplugin.rules', action: 'set',
      value: ['Run relevant tests.'], rendered: '- Run relevant tests.' },
  ] },
  model: [{
    role: 'system',
    content: '## pi.identity\nYou are a coding assistant.\n\n' +
      '## myplugin.rules\n- Run relevant tests.',
    toolsAdded: [readDefinition, writeDefinition], timestamp: 1000,
  }],
};
```

一个 plugin 修改 rules 之后存储的更改：

```typescript
const change: SystemEntry = {
  id: 140, conversationId: 1, kind: 'system',
  data: { sections: [{ key: 'myplugin.rules', action: 'set',
    value: ['Run relevant tests.', 'Check migration safety.'],
    rendered: '- Run relevant tests.\n- Check migration safety.',
  }] },
  model: [{
    role: 'system',
    content: 'The myplugin.rules section now reads:\n' +
      '- Run relevant tests.\n- Check migration safety.',
    toolsRemoved: [writeDefinition], toolsAdded: [grepDefinition], timestamp: 2000,
  }],
};
```

工具定义只存在于 SystemMessage 字段中，不在 section 数据里重复。按名称
结构化地比较定义；schema/description 改变就是一次完整的 `toolsAdded`
upsert。移除包含之前完整的已存储定义。先应用移除，再应用添加。仅工具的
更改可以有空的指令内容。提供工具的 hook 替换完整的期望装配；最后提供的
列表胜出，没有列表就意味着没有期望的工具。

显式的 section 删除存储 `{ key, action: 'remove' }` 以及一条说明该 section
不再适用的系统消息。省略一个 hook 或注销它的定义不是删除。

Pico 发送：

```typescript
const request = {
  messages: [user100, ...baseline.model, assistant120, user130, ...change.model],
}; // no top-level systemPrompt or tools
```

对于不受支持的 provider/model 组合，pi-ai 会把系统消息在它们的历史位置
翻译成用 `<system>` 括起来的用户消息，并推导出它所需的任何批量 wire 工具
声明。Pico 从不提升 baseline，也不把更改压平成重写过的顶层提示。缓存保留
是尽力而为的；一条回退的用户消息没有原生系统优先级。

### Subagent 有自己的

子项显式选择它们的持久配置。Subtree handler 提供默认值，内层 hook 可以
替换内置载荷或添加 section：

```typescript
const childId = await c.spawn({ prompt: 'Audit the tests',
  values: { inherit: [generationKind.config.model],
    set: [[generationKind.config.selectedTools, ['read', 'grep']]] },
}, call);
const child = await h.conversation(childId, call);
child.hooks.on(generationKind, 'system_instructions', ({ sections }, call) => {
  sections.set(systemSections.identity, AUDITOR_IDENTITY);
});
```

定义可以最初通过 `Harness.open(..., { sections: [...] }, call)` 提供，或稍后
通过 `h.sections.register/replace/remove` 更改。注册是可变的进程状态，在线上
串行化；一个在途的准备保留它的定义 snapshot。`register` 拒绝重复的键；
`replace` 是显式的且必须兼容；`remove` 注销代码而不擦除已存储的 section。
Entry/task 注册表遵循平行的 `h.entryKinds`/`h.taskKinds` API。Task kind 的移除
在该 kind 存在活跃 task 时会 reject。打开时缺失的 kind 会使前台 task 成为
orphaned 并使后台 task 进入 parked，如 [打开](#opening) 中所述；注册会为一个
已挂载 scope 中 parked 的工作恢复 recovery，绝不复活终态 task。

### Compaction、fork 与重启

规范的 section state 从 fork 可见的被托管系统 entry 重建回最近的 baseline，
然后向前折叠。Model head 与 projection 省略不会擦除这些 section 载荷。
这使用已有的索引 kind 扫描，外加一个可选的 prepared-state 缓存。一个全新的
baseline 会 checkpoint 整个 state；不需要额外的全 state 值或 token/渲染器
序列化。

因此，在没有某个 plugin 的情况下重启会保留它的 JSON 载荷与渲染文本——
即使 compaction 已把它的原始 baseline 从模型 context 中移除。未被触及的
未知 section 也会出现在下一次全新的 baseline 中。重新注册一个兼容定义会
恢复带类型的编辑；显式删除是 host 移除一个被遗弃 section 的方式。

每次 generation 都存储 `state.requestThrough`，一个包含式的 transcript 截断点。
它在线上之外运行 hook/渲染器之前捕获规范的 section state 与定义。随后准备
会在线上检查没有受管 section 写入改变它的种子；如果有，就重复准备。仅 head
的更改不会使 section 数据变陈旧，但可能需要一个 baseline 而不是一个 delta。

一个线上操作提交系统 entry 与 inflight intent/cutoff，让活跃 context 缓存赶上，
并在整个批次持久化之后捕获一个不可变的有效 entry 引用数组。之后的缓存更新
不会改变那个数组或它的替换 projection。请求本地的变换会复制它们所修改的
东西。重建一个更早的 cutoff 会读取存储，而不回退活跃缓存。

```text
prepare through 51 → requestThrough=51; capture request snapshot
60 summary lands  → live cache changes, request snapshot does not
70 answer lands   → answer to the already prepared request
```

一个可用的 model baseline 必须跟在最新的 head entry 之后。否则下一次准备
会追加一个完整的 baseline，为被取代但仍保留的受管系统 entry 携带普通的
省略 edit：

```text
10 user; 11 baseline; 20 assistant; 30 user; 31 managed delta; 35 job notice; 40 assistant; 50 user
60 summary, head=30
context at 60: [60 summary, 30 user, 31 delta, 35 notice, 40 assistant, 50 user]
70 assistant
80 user
81 system baseline, edits:[{ target:31, action:omit }]
context at 81: [60 summary, 30 user, 35 notice, 40 assistant, 50 user, 70 assistant, 80 user, 81 baseline]
```

Baseline 停留在它被追加的尾部位置。它的 edit 省略受管的 baseline/delta，
而不是带有 role=system 的无关通知。这种原子的 baseline 取代是唯一被允许的
对受管系统 projection 的 edit；针对它们的任意 omit/replace edit 会 reject。
改为通过 section draft 更改它们的指令。在准备之前，旧的保留 delta 仍然可见。
通用的 head 写入方与 context projection 不需要任何系统专属的回调或隐藏过滤。

重复的 head 使用同样的机制。在计划的省略之后折叠有效的工具声明；添加所有
期望的工具，并显式移除仍留在其他系统消息中的不想要声明。`baseline:true` 是
pico 元数据，不是 pi-ai 能理解的 reset 命令。

被当前 baseline 省略的、已被取代的 entry 绝不能导致重复的 baseline。

在配置更改之后崩溃会保留它们。在系统追加之后、请求之前崩溃会保留准备好
的指令；未改变的数据/渲染不会产生重复的 delta。Fork 只继承它们可见的
section 历史与可回退的 config。当前 host 源或渲染器的更改可以产生一个新的
prepared 更新，但绝不重新渲染旧的 model 消息。

```typescript
// Fork the earlier loadout example at 120: baseline 110 selected read/write, before the grep change.
const b = await c.fork({ at: 120 }, call);
await b.settings.set({ selectedTools: ['read'] }, call);
await b.prompt({ input: '...' }, call); // toolsRemoved=[write]; 110 remains the visible baseline
```

`before_request` 可以变换一份私有的 request 副本，它必须保持 messages-only。
这些更改不会改变已存储的 section state。在没有可选的单独捕获的情况下，
transcript 并不是任意变换后 request 的精确审计。工具调用校验使用变换之后
实际提供的定义，外加正常的实现与权限检查。

## 提示

### prompt、accept、drive

`prompt` 是三件事：accept 输入，drive 对话直到它空闲，读取该输入的
显式结果。

```typescript
const answer = await c.prompt({ input: 'Inspect the parser' }, call);
// AssistantEntry | undefined (the run ended without an answer)
```

这些部分可以单独使用。`inputId` 始终是被接受的 `pi.inbox` 列表元素的 id，
即使空闲 accept 在同一个 commit 中放置并移除它。Generation 与
`post_tools` 显式携带 input id，因此结果查找从不扫描 transcript：

```typescript
const { inputId } = await c.accept({ input: 'Inspect the parser', requestId: 'req-42' }, call);
const outcome = await c.drive(call);                          // 'idle' | 'closed'
const result = await c.result(inputId, call);                 // one sticky-value point read
const answer = result?.status === 'done' && result.answer
  ? await h.getEntry(assistantKind, result.answer, call)
  : undefined;
```

一个 result 从 `queued` 移动到 `placed`（它的 entry 在 transcript 中），然后到
`done` 或 `unanswered`。当欠一个答案时，`done` 携带作答的 entry；一个仅 context
的 `write` 是 `done` 且没有答案，就在放置它的那个 commit 中。`unanswered`
命名原因：

```typescript
switch (result.status) {
  case 'queued':     return 'waiting to start';
  case 'placed':     return 'working';
  case 'done':       return result.answer ? render(result.answer) : 'noted';
  case 'unanswered':
    return result.reason === 'terminated' ? 'the run stopped itself'
         : result.reason === 'aborted'    ? 'cancelled'
         : 'the model could not be reached';
}
```

终态 result 永不改变。

`accept` 就是「用户按下了回车」：空闲时，它在一个 commit 中放置 entry 并创建
一个 generation；忙碌时，它排队，默认作为 `followUp`。传入 `whenBusy: 'steer'`
改为打断正在运行的 turn，或者传入 `whenBusy: 'reject'`，如果调用方坚持要知道。
无论哪种方式，你都会得到一个 `inputId`，而 `result(inputId)` 告诉你发生了什么，
因此调用方从不需要先检查是否有 run 正在进行。

一个 request key 在 session 的生命周期内命名一次 accept。丢失了响应的调用方
用同一个 key 重试并拿回同一个 `inputId`；没有东西被写两次，也没有东西
被比较：

```typescript
const { inputId } = await c.accept({ input, requestId: 'req-42' }, call);   // safe to repeat
const existing = await h.acceptance('req-42', call);                        // or look it up explicitly
```

`c.drive(call)` 在该对话的前台集合空闲时 resolve：那条归属链中没有
generation、tool 或自动 collapse 是活跃的。`h.drive(call)` 在 session 中任何地方
都没有活跃前台 task 时 resolve。两者都会启动符合条件的后台工作，并在它们
resolve 之后继续服务它。在有一个周期性 schedule 活跃时，一个单独的完全
静止等待可能有意永不返回。

### 忙碌时的输入

`accept` 覆盖了常见情况。当调用方想要一个特定 mode 时，`queueInput` 是显式
形式，它是一个接受 tagged union 的方法，而不是四个方法：

```typescript
const steer  = await c.queueInput({ mode: 'steer', input: 'Focus on the tokenizer first' }, call);
const follow = await c.queueInput({ mode: 'followUp', input: 'Then write the tests' }, call);
const next   = await c.queueInput({ mode: 'nextRun', input: 'Remind me to commit' }, call);
const note   = await c.queueInput({ mode: 'write', kind: noteKind,
                                    entry: { data: { text: 'user stepped away' } } }, call);
```

| mode | 落地于 | 要求 |
|---|---|---|
| `steer` | 下一个 post_tools，或一个最终答案 | 在 post_tools 加入正在运行的组；在一个答案之后启动下一个 |
| `followUp` | 一个最终答案之后 | 启动下一个组 |
| `nextRun` | 下一个空闲的 `accept` | 加入那次 accept 的组 |
| `write` | 下一个安全边界 | 什么都不要求；`done` 且没有答案 |

当一个 generation 发出 call 时，它的 settlement 会创建每个 tool 加上恰好一个
携带当前 input id 的 `post_tools`。那个 task 放置 write 与 steering，扩展这些
id 并创建续接的 generation。一个最终答案的 generation 会 resolve 它当前的组，
然后把 steer/followUp 项放入一个新的组。`nextRun` 保持排队，直到之后某次
空闲的 `accept`。

该队列暴露完整的 entry draft，因此 UI 可以直接渲染文本与图像。持久与
watch 更新是 append/remove/clear 操作，而不是整个数组的替换。任何项在
落地之前都可以被撤回：

```typescript
await c.abortInput(steer.inputId, call);              // 'aborted' | 'not_found'
```

### 中止

```typescript
await c.abort(call);          // every live foreground task of this conversation, and of conversations they own
await h.abortTask(id, call);    // one background task: a job, a schedule
```

一个 abort mark 是一个持久请求，而不是终态 settlement：

```text
100 generation streaming, execute invocation A running
110 abort=true commits; A can no longer write main state or scratch
    line releases; A's signal fires; provider exits; A returns
    driver removes A and starts abort invocation B with a fresh Call
120 B commits optional display-only partial, cancelled input results, terminal aborted status
    scratch is retired; B returns
```

在正常 settlement 中不存在 mark/signal 分支。如果 mark 胜出，`runtime.commit` 会在
它的闭包运行之前 reject `TaskCancelled`；execute 展开，该 kind 的 `abort()` 写入
持久的取消结果。如果正常 settlement 先胜出，该 task 已经是终态。标准 effect 会
配合地观察该 signal；不存在 effect 门，因此一个 operation 可能在 signal
送达之前就开始，然后取消。取消不会撤销外部 effect。

`abortTask` 恰好标记一个 task；如果它不被拥有或未被挂载，清理会等待之后的
某次 drive。对话 abort 标记当前的前台归属闭包。新的父项清理会显式取消
它的前台子项以及记录在案的非 detached job。排队的 `steer`/`followUp` 被移除
并标记为 cancelled；`write`/`nextRun` 保留。这是显式的对话 abort 策略。
Shutdown 与内置 task abort 清理只标记 task，并保留所有排队项及其排队结果。

一个 generation 的 abort handler 在与 settlement 相同的 commit 中更新它显式的
输入组。这里 `inputResult(id)` 是持有该输入结果的 sticky value 地址：

```typescript
async abort(task, runtime, call) {
  await runtime.commit(async tx => {
    for (const id of task.state.inputs) {
      const address = inputResult(id);
      const r = await tx.value(address).get();
      if (r?.status !== 'placed') throw new Error(`Invalid active input ${id}`);
      tx.value(address).set({ status: 'unanswered', requestId: r.requestId, entry: r.entry, reason: 'aborted' });
    }
    tx.settle(task, 'aborted', { inputs: task.state.inputs });
  }, call);
}
```

driver 从不自行 resolve input result。Tool kind 与 generation kind 拥有各自的
结果。它们只能恢复已提交的 scratch；缺失的最终 usage 是未知，而不是零。
Runtime scratch 写入在取消之后也会 reject：await/catch 它们。Harness sink 处理
并排空它们自己的 scratch promise，并丢弃迟到的回调，绝不静默地重新创建
已退役的 scratch。

## 观察

### 视图

一个 UI 从不读取存储或解析 commit。它 watch 一个对话并得到一个**视图**：
一个 harness 保持最新的普通 JSON 对象，外加说明什么发生了变化的带类型
事件。

```typescript
const w = await h.watch(c.id, { tail: 100, values: [myPlugin.config.mode] }, call);
w.view    // ConversationView, captured atomically with the subscription
w.start(listener);
w.resnapshot(call);     // fresh capture, same subscription (if the client fell behind)
w.unsubscribe();
```

```typescript
interface ConversationView {
  conversation: Conversation;
  entries: Entry[];                        // the last `tail` entries; page older ones with h.entries(id, { before })
  context: Id[];                           // what the model currently sees, as entry ids
  tasks: Task[];                           // live tasks, typed by kind
  inbox: Element<QueuedInput>[];           // queued input
  values: Map<Address, JsonValue>;         // every value the registered kinds declare, plus the ones you asked for
  previews: Map<Id, JsonValue>;            // per live task: what it is producing right now
  faulted: boolean;
  readAt: Id;
}
```

`previews` 是流式所在的地方。每个 task kind 定义它的 preview 是什么：
generation 的是部分的 `AssistantMessage`，tool 的是它目前为止的
`ToolOutputState`，job 的是它的进程输出的同样形状。

### 事件

```typescript
type InboxOp =
  | { type: 'append'; item: Element<QueuedInput> }
  | { type: 'remove'; id: Id }
  | { type: 'clear' };

type ConversationEvent =
  | { type: 'entry';       entry: Entry }
  | { type: 'task_start';  task: Task }
  | { type: 'task_update'; task: Task; previous: Task }
  | { type: 'task_end';    task: Task }
  | { type: 'task_output'; task: Id; ops: DeltaOp[] }      // already applied to view.previews
  | { type: 'value';       addr: Address; value: JsonValue | undefined }
  | { type: 'inbox';       ops: InboxOp[] }
  | { type: 'context';     ids: Id[] }                      // a head or edit changed derived context
  | { type: 'fault';       error: unknown }
  | { type: 'closed' };
```

视图是权威的，事件只是一次唤醒：当 listener 运行时，`w.view` 已经被折叠。
Inbox operation 按 commit 合并；一次空闲 accept 的 append 与立即 remove 不发出
inbox 事件。一个渲染器可以完全忽略事件载荷而仍然正确。因为每一片
工作都是一个已知 kind 的 task，四个 task 事件覆盖了以往每种情况都需要一个
名字的东西：

| 你想知道 | 看 |
|---|---|
| 一个 turn 开始 / 结束 | `task_start` / `task_end`，其中 `generationKind.is(task)` |
| 一个 retry 被安排 | `task_update`，status `retry_wait`，`state.attempt`，`state.notBefore` |
| 响应正在流式传输 | generation 上的 `task_output`；`view.previews.get(task)` |
| 一个 tool 正在运行 / 它的输出 | tool task 上的 `task_start` / `task_output` / `task_end` |
| compaction 开始 / 结束 | `task_start` / `task_end`，其中 `collapseKind.is(task)` |
| model 改变了 | `value`，且 `addr === generationKind.config.model` |
| 排队的输入改变了 | `inbox` |

同一个 commit 的事件一起、按顺序到达，因此一个已完成的 task 与它的后继
从不显示为空闲间隙。

### 渲染

一个渲染器是视图的函数，与它上次绘制的内容做 diff。已 settle 的 entry 以
id 为键并且只被追加；活跃的东西以 task id 为键，而一个 tool block 在 task
settle 且它的 result entry 出现时保留它的键，因此没有任何东西被拆掉重建：

```typescript
function render(view: ConversationView, event?: ConversationEvent) {
  transcript.sync(view.entries);

  const gen = view.tasks.find(t => generationKind.is(t));
  streaming.set(gen ? view.previews.get(gen.id) as AssistantMessage : undefined);
  status.set(
    gen?.state.status === 'retry_wait' ? `retrying (${gen.state.attempt}/${gen.state.maxAttempts})` :
    gen?.state.status === 'deferred'   ? 'waiting for provider' :
    view.tasks.some(collapseKind.is) ? 'compacting…' : undefined);

  for (const t of view.tasks.filter(toolKind.is))
    toolBlocks.upsert(t.id, { call: t.state.call, phase: t.state.status, output: view.previews.get(t.id) as ToolOutputState });

  for (const t of view.tasks.filter(jobKind.is))
    jobBlocks.upsert(t.id, { tool: t.state.origin?.tool ?? 'job', output: view.previews.get(t.id) as ToolOutputState });

  queue.set(view.inbox.map(i => i.value));
  working.set(view.tasks.some(t => !t.background));
  statusLine.set({ model: view.values.get(generationKind.config.model) });
}
```

Tool 组件按工具名注册一次，并被喂以一种形状 `ToolOutputState`，无论它来自
一个活跃 tool task 的 preview、一个已 settle 的 `tool_result` entry，还是一个
该 tool 启动的 job（`state.origin.tool` 说明是哪个组件）。

### 远程客户端

视图是普通 JSON，每个事件都与它的变化成比例，因此一个没有 harness 的进程
（mini 的 TUI、一部手机）在相同事件上运行相同的折叠。`applyEvent(view, event)`
被导出且不需要任何 kind；preview op 是 Chord delta op，客户端用同一个模块
应用它们。

```typescript
// worker (has the harness)                            // ui process
const w = await h.watch(c.id, { tail: 100 }, call);          on('view',  m => { view = m.view; render(view); });
send({ type: 'view', view: w.view });
w.start(e => send({ type: 'event', event: e }));       on('event', m => { applyEvent(view, m.event); render(view, m.event); });
```

### Session 观察

不属于单个对话的东西：对话列表、session value、usage 总计、fault，以及
report（一个 hook 抛出了异常，一个 task kind 行为不端并被停止）。

```typescript
const sw = await h.watch(call);
sw.view.conversations;  sw.view.values;  sw.view.faulted;
sw.start(e => {
  if (e.type === 'usage')  status.setCost(e.totals);
  if (e.type === 'report') log.warn(e.kind, e.task, e.error);
  if (e.type === 'conversation') tree.refresh();
});
```

## Fork

一个 fork 是一个新的对话，其 transcript 以源的一个共享前缀开始。没有东西
被复制，源中也没有东西被删除。它携带在该 entry 处可见的 context、规范的
prepared 指令与可回退的值。它下一次准备可能会追加来自当前 host 源的更改；
它不重写继承来的消息。

```typescript
const alt = await c.fork({ at: answer.id }, call);                           // the source keeps running, untouched
await alt.prompt({ input: 'Try a different implementation' }, call);

const back = await c.fork({ at: earlier.id, abort: true }, call); // "go back": aborts the source's foreground first
```

任何 transcript entry 都是有效的 fork 点，包括一个带有未作答工具调用的
assistant，或若干个结果中的一个。request projection 为一次成功的未完成
交换提供缺失的结果，而不继承或执行源 task。UI 把哪个对话当作「当前」是
UI 的事；harness 只有对话。

```typescript
const all = await h.conversations(undefined, call);
const independent = all.items.filter(x => x.owner === undefined);   // root and forks: their own drive scopes
const children = await h.conversations({ parent: c.id }, call);           // forks of c; owned children use ownedFrom
```

## Compaction 与重置

Compaction 追加一个 summary entry，它的 model 消息与第一个保留的 entry id
存储在 entry 上。context 变成该 summary 加上从那个边界开始的 transcript。
它作为后台 task 运行，并可能在模型继续工作时运行：与此同时落地的普通
entry 保留在 prepared 边界之后。只有竞争性的 head 会使 summary 变陈旧；
edit entry 不会。

```typescript
const collapseId = await c.collapse(undefined, call);
const collapseId = await c.collapse({ instructions: 'keep the API decisions verbatim' }, call);
```

阈值与溢出 compaction 发生在 generation 内部；无需调用任何东西。Reset
重新开始 context，无论有没有 handoff 消息：

```typescript
await c.reset({ handoff: 'Continue from here: we settled on a recursive-descent parser.' }, call);
await c.reset(undefined, call);                                                        // /clear
```

无论如何，transcript 都保留一切；只有 context 改变。

## Subagent

一个 subagent 就是一个对话。没有单独的对象可以交谈：模型得到一个带有
`command` 参数的 tool，而 API 得到一个对话句柄。

```typescript
// the model calls:
subagent({ command: 'run',    prompt: 'Audit the tests', context: 'fresh', tools: ['read', 'grep'] })  // waits for the answer
subagent({ command: 'spawn',  prompt: 'Profile the build' })                                            // returns the child's id
subagent({ command: 'send',   id: 88, text: 'also check CI' })
subagent({ command: 'status', id: 88 })
subagent({ command: 'wait',   id: 88 })
subagent({ command: 'stop',   id: 88 })
```

```typescript
// the API
const childId = await c.spawn({ prompt: 'Profile the build', context: 'fresh',
                                values: { inherit: [generationKind.config.model] } }, call);
const child = await h.conversation(childId, call);
await child.accept({ input: 'also check CI' }, call);
await child.drive(call);          // or let h.drive() / the parent's drive carry it
await child.abort(call);
```

`run` 在 drive 子项的同时让调用中的 tool 保持 inflight，因此子项是父项前台的
一部分：abort 父项会到达它。`spawn` 立即 settle 该 tool；子项被 detached，
在父项继续时运行，只有 `child.abort()`（或 `stop` 命令）会结束它。无论哪种
方式，子项都由 drive 父项树的任何东西来 drive，而且它像任何对话一样在
重启后存活。

## Job 与 Schedule

一个 job 是一个运行进程的后台 task：持久、可恢复、可杀死，其输出被流式
传输进它的 preview。模型通常从 `bash` 得到一个（被要求转入后台，或运行
超过它的 budget），并通过 `job` tool 控制它：

```typescript
job({ command: 'wait',   id: 91, budgetMs: 30_000 })
job({ command: 'status', id: 91 })
job({ command: 'stop',   id: 91 })
job({ command: 'list' })
```

从 API 看，一个 job 是一个 task；一个 schedule 是一个带有 `every` 的 job：

```typescript
const dev = await c.commit(tx => tx.task(jobKind, { background: true,
  state: { status: 'planned', cmd: 'npm run dev', cwd } }), call);

const nightly = await c.commit(tx => tx.task(jobKind, { background: true,
  state: { status: 'planned', cmd: 'npm test', cwd, every: 24 * 3600_000, notBefore: tonightAt(2) } }), call);

await h.abortTask(nightly, call);          // ends the schedule wherever it is
```

一个 schedule 是一个 task 循环 `planned → running → planned`；没有一串 run id
需要追踪。一个起始 call 提前返回的 job 在完成时追加一个 `notice` entry，
因此模型在它下一次 turn 时无需轮询就能得知。它的输出留在 task 中（活跃时
是 preview，之后是终态 state），不在 transcript 中。

## Plugin state

### 值与列表

声明一次地址；通过 handle 或在 commit 内部读写。该地址携带 scope（session
或对话）、rewind 策略与载荷类型。

```typescript
const planMode = conversationValue<boolean>('plan.mode', { rewind: true });
const moves    = conversationList<Move>('game.moves', { rewind: true });
const expanded = conversationValue<boolean>('ui.expanded', { rewind: false });
const name     = sessionValue<string>('pi.session.name');

await c.value(planMode).set(true, call);
const on = await c.value(planMode).get(call);
const then = await c.value(planMode).get(entryId, call);            // as of an entry: rewindable only

const elementId = await c.list(moves).append({ x: 1, y: 2 }, call);
const page = await c.list(moves).read({ limit: 50 }, call);
await c.list(moves).remove(elementId, call);
await c.list(moves).clear(call);

await h.value(name).set('parser work', call);
```

可回退的 state 正是让 plugin 在 fork 中存活的东西：在一次 move 之前的
fork 看不到该 move，在 plan mode 打开之前的 fork 没有打开它。无需注册，
无需重新推导。

### 原子提交

任何必须一起落地的东西都放进一个 commit：session 写入线上的一个闭包。
它内部的读取是异步的，并看到已提交的 state；在一个 async builder 中 await
它们。写入是同步的，id 在返回时即为最终；一次 throw 会丢弃一切。Await
存储读取不会释放该线。绝不在一个 builder 内部 await 外部 effect、driver
等待或另一个 commit。

```typescript
const entry = await c.commit(tx => {
  tx.value(planMode).set(false);                                          // rewindable state first
  const id = tx.entry(myPlugin.noteKind, { data: { text: 'plan accepted' } });
  tx.value(expanded).set(true);                                           // sticky state may follow
  tx.task(myPlugin.reminderKind, { background: true,                      // tasks anywhere
    state: { status: 'scheduled', about: id, at: Date.now() + 3600_000 } });
  return id;
}, call);
```

### 追加 Entry

`tx.entry` 立即追加并返回 entry id。把它用于属于你 task 正在做的事情一部分
的 entry，以及模型永远看不到的 entry（只有 `data`，没有 `model`）。

对于一个模型*会*读取的 entry，若从 turn 之外写入，使用 `tx.write`（或
`c.write`）：

```typescript
await c.write(noteKind, { data: { text: 'user stepped away' },
                          model: [noteMessage('user stepped away')] }, call);
```

当对话中没有活跃的 turn task 时，它立即追加，否则排队并在下一个 post_tools
或最终答案边界落地。这不是风格偏好：在一个 assistant 的工具调用与它们的
结果之间追加一个模型可见的 entry，会改变下一次 request 重放的 prefix，
provider 会拒绝这一点，而且这会使 Anthropic thinking signature 失效。
`tx.entry` 会 reject 这一种情况，而不是破坏下一次 request，而错误会指向这里。

一个 drive 自己 turn 的 kind 声明 `turn: true`，这会让它与内置的 generation、
tool、post_tools 和 collapse kind 一起进入那个检查。

直接写 entry 时还有两件事：追加一个 `user` entry 与请求一个答案不是一回事
（没有东西会通过推断运行；使用 `accept`），而且一个 head entry 只能收窄
context，绝不能拓宽它，也不能拆分一次交换。

### 写入顺序

一条规则：可回退的对话 value/list 写入必须在同一个 commit 中先于 entry。
这使与一个 entry 一起写入的 state 对该 entry 处的 fork 可见，同时排除更晚的
commit。Session state 与 sticky 对话 state 可以出现在任何位置，因为 fork
从不重建它们的历史；因此它们可以引用一个新的 entry id。Task 也可以出现在
任何位置。一个违规的 builder 调用会在任何东西被持久化之前 throw。

## 编写工具

### sink

一个 tool 的 `execute` 不返回任何东西。它产生的一切都经过一个 sink，因此
输出在发生时流式传输到 UI，在一个地方被有界一次，并 settle 成一个
transcript、模型与每个渲染器共享的 `ToolOutputState`。失败就是一次 throw；
harness 会设置 `isError`。

```typescript
import { Type, type Tool } from '@earendil-works/pi-agent';

export const countLinesTool: Tool<{ i: string; path: string; pattern?: string }, { lines: number; matching: number }> = {
  name: 'count_lines',
  description: 'Count lines in a file, optionally only those matching a pattern',
  parameters: Type.Object({
    i: Type.String({ description: 'What you are trying to find out' }),   // intent: streams first, shows in the UI
    path: Type.String(),
    pattern: Type.Optional(Type.String()),
  }),
  output: { maxBytes: 64_000, maxLines: 200, retain: 'head' },            // the sink enforces this
  replay: 'safe',                                                         // read-only: may be rerun after a crash

  async execute(toolCallId, params, out, runtime, call) {
    const lines = getOrThrow(await runtime.env.readTextLines(params.path, {}, call));   // ExecutionEnv: FileSystem & Shell
    const re = params.pattern ? new RegExp(params.pattern) : undefined;
    let matching = 0;
    for (const [i, line] of lines.entries()) {
      if (re && !re.test(line)) continue;
      matching++;
      out.write(`${i + 1}: ${line}\n`);                                  // bounded by `output`; the sink truncates and diags
    }
    if (matching > 200) out.diag('warn', `showing 200 of ${matching} matching lines`, 'cap');
    out.details.lines = lines.length;                                     // typed, for UIs
    out.details.matching = matching;
  },
};
```

该 sink：

| call | 效果 |
|---|---|
| `write(text)` / `replace(text)` / `image(img)` | 模型读取的内容 |
| `details` | 该 tool 为 UI 准备的带类型对象；修改它 |
| `usage(u)` | 累积 |
| `addTools(names)` | 从下一个 turn 起更改装配 |
| `terminate(true)` | 在这次交换之后停止该 turn，无论该 call 是否失败 |
| `handoff(message)` | 在这次交换之后请求一次 context reset（`new_context` 所做的） |
| `delegate(jobId)` | 这次 call 的工作作为那个 job 继续 |
| `diag(severity, message, code?)` | 关于该 call 的评论，被排除在数据之外 |

一个 tool 绝不触碰 transcript、它的兄弟或该队列。它可以做的是通过
`runtime.commit(..., call)` 在它自己的对话中创建东西：一个 job、一个子对话。
该 runtime 提供对话查找、读取与取消方法，而不是一个原始的 host 生命周期
Harness。

### 诊断

任何*关于*该 call 而不是它的输出的东西都经过 `diag`：截断、一个溢出的
文件、一个被更正的路径、「自你读取以来该文件在磁盘上已改变」。harness
发出它自己拥有的那些（sink 自身报告截断与溢出）；一个 tool 只添加它独自
知道的东西。

Tool settlement 把输出放在前面，评论放在它之后，并把那条精确的消息存储在
entry `model` 中。非消息细节、usage、控制标志、诊断与截断元数据成为 entry
`data`。UI 把两者结合起来，并按严重程度把诊断渲染为 callout：

```text
...last matching line
<harness>
[warn] stopped at 500 matches
</harness>
```

### 长时间运行的工具

一个 call 不能永远阻塞一个 turn。运行进程的 tool 先创建一个 job，并用来自
config 的 budget 等待它；如果 budget 用完，该 call 用它已有的东西 settle，
而工作继续：

```typescript
async execute(toolCallId, params, out, runtime, call) {
  const job = await runtime.commit(async tx => {
    const task = await tx.getTask(toolKind, runtime.taskId);
    if (task?.state.status !== 'running') throw new Error('Expected a running tool');
    const { status, ...payload } = task.state;
    const id = tx.task(jobKind, { background: true,
      state: { status: 'planned', cmd: params.cmd, cwd: params.cwd ?? runtime.env.cwd,
               origin: { tool: 'bash', task: runtime.taskId, callId: toolCallId } } });
    tx.patch(task, status, { ...payload, jobId: id, cancelJobOnAbort: !params.background });
    return id;
  }, call);

  if (params.background) { out.delegate(job); out.write(`started job ${job}`); return; }

  const done = await runtime.waitForTask(job, { budgetMs: runtime.budgetMs }, call);
  const output = await runtime.jobOutput(job, call);
  out.replace(output.text); out.capture(output.truncation);
  if (done) {
    out.details.exitCode = output.exitCode;
    if (output.exitCode) out.diag('warn', `exit code ${output.exitCode}`, 'exit');
  } else {
    out.delegate(job);
    out.diag('info', `still running as job ${job}; use job wait / status / stop`, 'budget');
  }
}
```

该 job 从第一个字节起就拥有它的输出；该 tool 复制一份 snapshot。创建会
原子地把清理引用存储在 tool 上。一次持久 abort 会 reject execute mutation，
包括 catch handler 的写入，因此新的 tool kind abort handler 会读取那个引用
并取消那个非 detached job。已经终态的 job 算作成功的清理；check-and-mark
必须是原子的，或者处理那个结果。

该 tool kind 成功的 delegation settlement 会把 job 标记为 detached，并通过
一个以 job id 为键的单独 sticky 通知记录请求一个 notice。Job 完成会原子地
消费它；如果当 delegation 提交时该 job 已经终态，delegation 会自行放置该
notice。把这个协议应用于 exited、killed 和 lost 结果，包括 abort 与 recovery。
父项绝不 patch 一个正在运行的 job 的 state。这覆盖了两种完成/delegation 顺序。

一个 UI 用 `bash` 的组件渲染该 job 的输出。在 budget 过期之后收养一个任意
的未完成 tool promise 仍然是一个未定的集成设计：它需要一次显式的
effect/sink 所有权转移。上面最初的 job-first 路径不会与任何调用竞争，
也不会抛弃任何调用。

## Hook

Hook 属于运行它们的那个 kind。一个 kind 声明它的点及其类型；你按 kind 与点
注册 handler，harness 全局或限定到某个对话。Handler 在写入线之外运行，
它们的决定会在一个 commit 内部被重新校验，因此它们可以花任意长的时间
（一次人工批准就是一个会等待的 hook）。

```typescript
// policy: everywhere
h.hooks.on(toolKind, 'before_tool', async ({ toolName, args, conversationId }, call) => {
  const conversation = await h.conversation(conversationId, call);
  if (toolName === 'write' && await conversation?.value(planMode).get(call))
    return { block: { reason: 'plan mode: no edits' } };
  if (toolName === 'bash' && !(await ui.approve(args, { signal: call.abortSignal })))
    return { block: { reason: 'denied by user' } };
  return { args };                                       // may rewrite arguments
});

h.hooks.on(toolKind, 'after_tool', async ({ toolCallId, output }, call) => { metrics.record(output.usage); });

h.hooks.on(generationKind, 'before_request', async ({ request }, call) => ({ request: withTracing(request) }));

h.hooks.on(generationKind, 'on_yield', async ({ answer, conversationId }, call) => {
  if (await goalIncomplete(conversationId, call)) return { continue: 'The goal is not met yet; continue.' };
});

h.hooks.on(collapseKind, 'before_collapse', async ({ reason, entries }, call) => {
  if (reason === 'manual' && entries.length < 10) return { decline: true };
});

// instructions: per conversation (see System Prompt and Tool Loadout)
c.hooks.on(generationKind, 'system_instructions', handler, { subtree: true });
```

点及其失败行为：

| kind | point | 返回 | 抛出时 |
|---|---|---|---|
| generation | `system_instructions` | 编辑 section draft；可选的完整工具 | 报告，跳过 |
| generation | `before_request` | 一个变换后的 request | 报告，跳过 |
| generation | `after_response` | 无 | 报告 |
| generation | `on_yield` | `{ continue?: string }` | 报告，跳过 |
| tool | `before_tool` | `{ args? }` 或 `{ block }` | **阻塞该 tool** |
| tool | `after_tool` | 无 | 报告 |
| collapse | `before_collapse` | `{ decline? \| instructions? \| summary? }` | 报告，跳过 |

这些失败策略排除取消控制错误，它们会传播以展开该调用。一个 handler 接收
活跃的 Call 作为它的最后一个参数，并且必须把它转发给 wait/effect。harness
await 它实际的返回，而不是一个被抛弃的竞速 promise。一个 handler 可能在
崩溃后再次运行，因此它的外部副作用需要自己的幂等性。

## 编写 kind

Kind 是你用新行为而不是新 state 扩展 harness 的方式。一个 entry kind 是一个
不可变 transcript 形状的带类型名称；一个 task kind 说明一种工作如何运行。

### Entry kind

Entry facet 会组合。`data` 是可选的 kind 专属 JSON，用于逻辑与自定义 UI
渲染；`model` 是一个可选的已存储 `Message[]`；`head` 与 `edits` 是可选的
已存储 context 控制。读取时不会派生任何 facet。

```typescript
interface NoteData { text: string; pinned?: boolean }
type NoteEntry = EntryBase & EntryData<NoteData>;

export const noteKind = defineEntryKind<NoteEntry>('myplugin.note');

await c.commit(tx => tx.entry(noteKind, {
  data: { text: 'Parser plan accepted', pinned: false },
}), call);                                                        // transcript/UI only; the model sees nothing
```

一个同时想要带类型数据与一条 model 消息的 plugin 把追加时的转换放在一个
普通 helper 中：

```typescript
type PinnedEntry = EntryBase & EntryData<NoteData> & ModelProjection<UserMessage>;
export const pinnedKind = defineEntryKind<PinnedEntry>('myplugin.pinned');

function appendPinned(tx: ConversationTx, data: NoteData, timestamp: number): Id {
  return tx.entry(pinnedKind, {
    data,
    model: [{ role: 'user', content: `<pinned>${data.text}</pinned>`, timestamp }],
  });
}
```

Head 与 edit 以同样的方式提供：

```typescript
type WindowEntry = EntryBase & EntryData<{ retainFrom: Id }> & ContextHead;
export const windowKind = defineEntryKind<WindowEntry>('myplugin.window');

tx.entry(windowKind, {
  data: { retainFrom },
  head: retainFrom,                     // first retained entry, inclusive
});

type ToolResultEditEntry = EntryBase & ContextEdits;
export const toolResultEditKind = defineEntryKind<ToolResultEditEntry>('myplugin.tool_result_edit');

tx.entry(toolResultEditKind, {
  edits: replacement === undefined
    ? [{ target, action: 'omit' }]
    : [{ target, action: 'replace', messages: replacement }],
});
```

一个追加 draft 中的 `head: 'self'` 会存储新的 entry id，这正是 reset 与
handoff 丢弃更早一切的方式。Commit 校验要求一个已存储的 head 边界不能
移动到前一个可见边界之前。Edit 按 transcript 顺序应用；每个 target 最新的
edit 胜出。当 context 应该改变时，追加另一个 head 或 edit；在 context 读取
期间不运行任何 entry kind 回调。

读取按 kind 带类型，或是不带类型再收窄：

```typescript
const note = await h.getEntry(noteKind, id, call);     // NoteEntry | undefined (also undefined for another kind)
const any = await h.getEntry(id, call);                // Entry | undefined
if (noteKind.is(any)) any.data.pinned;
```

一个缺失的 plugin 会移除那种收窄及其自定义渲染器，但不会移除 context
行为：该 entry 的 model 消息、head 与 edit 独立于 kind 存储。

### Task kind

一个 task kind 声明它的 status 及其 role、它的 config、它的 hook，以及三个
函数。Task 写入会把映射后的 role 具体化到持久 task 行上；存储与 driver 读取
那个字段而不运行 kind 代码。Status 图可以包含环，因为一个 task 是一个逻辑
operation：retry、deferred poll 与周期性 schedule 保持它们稳定的 task id。
Recovery 只使用当前 status、state、role 与 scratch。

这里有一个只触发一次的 reminder：

```typescript
type ReminderStates =
  | { status: 'scheduled'; about: Id; at: number }
  | { status: 'firing';    about: Id; at: number }
  | { status: 'done';      about: Id; at: number; fired: boolean }
  | { status: 'aborted';   about: Id; at: number };

export const reminderKind = defineTaskKind<ReminderStates>()({
  kind: 'myplugin.reminder',
  initialStatus: 'scheduled',
  roles: { scheduled: 'start', firing: 'inflight', done: 'terminal', aborted: 'terminal' },
  config: { intervalMs: conversationValue<number>('myplugin.reminder.interval', { rewind: false }) },
  hooks: { before_fire: { failClosed: false } },

  async execute(task, runtime, call) {
    if (task.state.at > runtime.now()) await runtime.sleep(task.state.at, call);        // throws on cancellation
    await runtime.commit(tx => tx.patch(task, 'firing', common(task)), call);   // intent before any effect
    const { skip } = await runtime.hooks(reminderKind).run('before_fire', { about: task.state.about }, call);
    await runtime.commit(tx => {
      if (!skip) tx.write(noticeKind, { model: [noticeMessage(`Reminder: see entry ${task.state.about}`)] });
      tx.settle(task, 'done', { ...common(task), fired: !skip });               // a marked task's commit rejects
    }, call);
  },

  async recover(task, runtime, call) { return this.execute(task, runtime, call); },      // safe to redo
  async abort(task, runtime, call)   {
    await runtime.commit(tx => tx.settle(task, 'aborted', common(task)), call);
  },

  // no preview: nothing to show while sleeping
});

const common = (t: Task<ReminderStates>) => ({ about: t.state.about, at: t.state.at });
```

`defineTaskKind<ReminderStates>()` 绑定所声明的 union；后面的调用推断出字面的
role map。保留那个被推断出的 kind 类型，以便编译器知道 patch 与 settle 接受
哪些 status。Kind 定义会拒绝缺失/多余的 role 条目、一个非 start 的初始
status、一个被声明的 `orphaned` status，以及每个 variant 共享字段的类型或
可选性不一致。

State 是一个按 status 区分的 tagged union。**`patch` 与 `settle` 都接受一个
status 及其完整载荷，载荷内部没有第二个 status。** Patch 接受非终态 target；
settle 接受终态 target。不存在无 status 的部分 patch，也不存在与旧 state 的
隐式合并：

```typescript
tx.patch(task, 'firing', { about: task.state.about, at: later });
tx.settle(task, 'done', { about: task.state.about, at: task.state.at, fired: true });
// Rejected: missing fired, extra fields, wrong field types, or using done with patch.
```

对于一个同 status 的更新，收窄该 state，解构出 `status`，并用你的更改展开
剩余载荷。一次转换必须提供目标 variant 的字段，而不是展开前一个 variant 的
无关字段。已存储的 state 变成 `{ ...payload, status }`。Task snapshot 保持
不可变；如果之后的某次写入需要自那个 snapshot 以来提交的 state，就再次
读取该 task。

带类型的 task 为完整 state union 与 role map 保留一个仅编译器的见证；
没有字段或回调被添加到存储。只给定一个 id 时，在 patch 或 settle 之前通过
它的 kind 读取。这些类型检查即使在变量/展开上也会拒绝可见的多余顶层键，
并保留 status 与载荷之间的相关性。它们无法检测被强制转换或更窄的静态
类型擦除的字段；wire 校验与线上调用/存活检查仍然适用。

harness 添加 `orphaned`，带有每个 variant 共有的字段：对这个 reminder 来说
是 `about` 与 `at`，而不是 `fired`。共有的可选字段保持可选。这使用共同的
键（union 上的 `keyof`），而不是不兼容 status 的字面 TypeScript 交集。
带类型的读取包含 orphaned；kind 执行方法只接收已声明的 variant。你永远
不通过 patch/settle 写 orphaned；一个 dependent 在与其它终态结果相同的
switch 中处理它。

一次执行遵循、而 driver 强制执行的规则：

1. 在任何外部 effect 之前提交一个 inflight status。在那之前崩溃会重跑
   `execute`；在那之后崩溃会走 `recover`。
2. 你可以阻塞在世界之上：一个 provider 流、一个进程、一个子对话、一次
   sleep。driver 并发运行执行；一个被阻塞的不会拖住任何东西。
3. 在返回之前做一次已提交的 status 转换或 settle，取消/close 展开除外。
   活跃 task 的 epoch 计数实际转换，因此 `planned → running → planned` 是
   有效的。同 status/仅 state 的 patch 与 abort mark 不计入。一个 abort handler
   必须 settle。
4. 对于前置条件优先使用 `after`；drive 子项或使用有界的 job-wait API。
   把 Call 转发给每一次等待。已知的 self/dependency 等待会 reject；绝不用
   竞速抛弃一个未完成的 task/tool/hook。

一个等待 `after` 的前台 task 是活跃的，因此它的对话保持忙碌，直到依赖
settle。依赖一个后台 job 在该 job 结束时没问题；依赖一个周期性 schedule
会让对话永远忙碌，因此改为在你自己的 execute 内部等待。

scheduler 在 commit 线上运行，从整个已提交批次更新 live-task/dependency
索引，并在线上之外启动 effect。它在打开时扫描一次存储，而不是每次 call
之后。只有一个调用拥有每个 task，但不同的 task 并发运行。重复的 drive
共享一个 attachment，并只创建临时的 waiter。历史上已完成的子项从不被遍历。

一个逃出 task kind 的意外错误，或一次未改变的返回，会使 session fault：
挂起的 drive 立即 reject，准入停止，正在运行的调用被 signal 并 join，然后
存储关闭。领域内的 tool/provider 错误必须由它们的 kind settle。重新打开不
启动任何东西；在 drive 之前 inspect 并标记工作，或安装一个能 settle 一个
损坏的持久 task 的 replacement kind。

一个带有 `preview` 的 kind 决定 task 运行时 UI 看到什么：`preview.init(scratch)`
在挂载或重新打开时构建它一次，之后该 kind 原地修改 `runtime.preview.state`
（generation 把流事件应用到一个部分消息；一个 tool 的 preview 就是它的
sink）。harness 在每次 scratch commit 之后把 Chord delta tracker 刷进
`task_output` op，因此一个 token 只花费一个 append op，而不是整个对象的 diff。

## Recovery

没有什么需要写的。在一次崩溃之后：

```typescript
const h = await Harness.open(storage, opts, call);
await h.drive(call);
```

| 当时在运行什么 | 会发生什么 |
|---|---|
| 一个 generation，流式中 | 它的帧在 scratch 中：部分结果被发布，然后在 budget 内 retry 或失败 |
| 一个 generation，在 retry 之间 | 它睡完剩余的 backoff 再试一次 |
| 一个带有 `replay: 'safe'` 的 tool | 再次运行 |
| 任何其他 tool | 一个「interrupted」错误结果；该 turn 继续 |
| 一个 `run` subagent tool | 找到它的子项并再次 drive 它 |
| 一个 job | 如果它这么说过就重跑，否则记录 `lost` |
| 一个已调度的 job | 睡到它的时间 |

后继者与决定它们的 settlement 在同一个 commit 中写入，因此一次崩溃绝不会
留下「工具已完成，但没人启动下一个 turn」：post_tools 已经存在且可启动。

## 存储后端

| backend | 加载 | 适合 |
|---|---|---|
| `MemoryStorage` | 一切 | 测试、临时 session |
| `JsonlStorage` | 一切，来自一个只追加文件加上每个活跃 task 一个 scratch 文件 | 本地 session；默认 |
| `SqliteStorage` | 只加载查询返回的东西 | 长 session、一个文件中的许多 session、服务器 |

三者以相同的结果回答相同的查询。Entry 不可变并被整体读取；索引查询在
解码之前选出相关 entry。Value 在每次 set 时被整体存储；list 存储
append/remove/clear 操作。不存在自动的 value diffing 或 Chord 存储 codec。
Chord delta 只用于 preview/watch 送达。流式 scratch 追加紧凑的 assistant 帧
或显式输出操作，而不是带有反复增长的 partial snapshot 的原始 provider 事件。

JSONL 通过重放完整的主批次来重新打开，然后为存活的活跃 task 重放 scratch。
每个文件的序列空隙是预期的；下一个 id 取两者中最大的完整批次端点。已退役
的 scratch 即使 unlink 失败也会被忽略；它之后的 main settlement 已经覆盖
它的 id。只有未终止的末行会被丢弃并在进一步追加之前移除；格式错误的完整
main/live-scratch 批次会使打开失败。

```text
main ends at 100; live scratch ends at 150 → reopen lastSeq=150, next write=151
main settles task at 151; scratch unlink fails → ignore retired scratch, lastSeq=151
```

一致性套件在所有后端之间比较同一个 mutation 流。当 value 增长时，反复的
整体 value set 会写入二次方数量的字节；增量 list 无需隐藏编码即可避免
这一点。

```typescript
const storage = await SqliteStorage.open('./sessions.db', { session: 'parser-work' });
```
