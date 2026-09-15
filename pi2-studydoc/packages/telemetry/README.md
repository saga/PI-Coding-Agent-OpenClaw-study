# @earendil-works/pi-telemetry

面向 pi package 的厂商中立 telemetry 契约与类型化 schema 工具。

此 package 提供：

- 一个显式的、基于回调的 `TelemetryContext` / `TelemetrySpan` 契约；
- 一个共享的 `NOOP_TELEMETRY_CONTEXT`；
- 一个参考 `InMemoryTelemetryContext` 实现；
- 可序列化的 schema 定义，并带有推断出的 TypeScript 类型；
- 没有 exporter、没有全局 current-span 状态，也不依赖任何 telemetry backend。

应用程序可以使用内存参考实现，或为 OpenTelemetry、Sentry、日志或其他 backend 提供适配器。Pi package 显式传递 telemetry context，并单独定义其领域 schema。

## 目录

- [安装](#installation)
- [Telemetry 概念](#telemetry-concepts)
- [核心 Context API](#core-context-api)
- [适配器契约](#adapter-contract)
- [无操作 Context](#no-op-context)
- [内存参考适配器](#in-memory-reference-adapter)
- [适配器一致性](#adapter-conformance)
- [类型化 Schema](#typed-schemas)
  - [起始与完成 Attribute](#start-and-completion-attributes)
- [Schema 元数据](#schema-metadata)
- [Pi Package 集成](#pi-package-integration)
- [安全性与可移植性](#security-and-portability)
- [API 参考](#api-reference)
- [开发](#development)
- [许可证](#license)

## 安装

```bash
npm install @earendil-works/pi-telemetry
```

## Telemetry 概念

Telemetry 描述程序在运行时做了什么。此 package 使用 span、attribute、event、status 和显式 context 来建模这些工作：

| 概念 | 通俗含义 |
|---|---|
| **Span** | 一次 operation 的计时记录，例如加载一个账户或发起一次 AI 请求。它在工作开始前开始，在工作完成时结束。 |
| **Parent and child spans** | Operation 可以包含更小的 operation。一个请求 span 可能包含一次 cache 查找和一次数据库查询。它们共同构成一棵显示时间花在哪里的树。 |
| **Attribute** | 附加到 span 的一个具名事实，例如 `provider: "openai"`、`cache.hit: true` 或 `item_count: 12`。Attribute 描述该 operation 及其结果。 |
| **Event** | 在 span 期间某一时点发生的具名事件，例如 `retry.scheduled` 或 `cache.lookup`。Event 没有持续时间，并可以携带自己的 attribute。 |
| **Status** | 该 operation 的结果：`ok` 或 `error`。错误 status 可以包含错误名称和消息。 |
| **Context** | 一个句柄，标识新工作属于 span 树中的什么位置。从某个 context 启动 span 会使其成为该 context 的子节点。 |

例如，加载一个账户可能产生如下 telemetry：

```text
example.account.load                         span
├─ attributes: account.id=123, found=true   facts about the span
├─ event: example.cache.lookup              occurrence during the span
│  └─ attribute: cache.hit=false            fact about the event
└─ status: ok                               final outcome
```

Span 是诊断数据，而非业务状态。记录它不得改变账户加载是否运行、成功、失败或被持久化。适配器将这些通用概念转换为 OpenTelemetry、Sentry、日志或其他 backend 所使用的对应概念。

## 核心 Context API

`TelemetryContext` 围绕回调启动一个 span。该回调接收一个 `TelemetrySpan`，它同时也是子 span 的显式父 context。

```typescript
import {
  NOOP_TELEMETRY_CONTEXT,
  type TelemetryContext,
} from '@earendil-works/pi-telemetry';

async function loadAccount(
  accountId: string,
  telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT,
) {
  return telemetryContext.startSpan(
    {
      name: 'example.account.load',
      attributes: { 'example.account.id': accountId },
    },
    async (span) => {
      const account = await readAccount(accountId);
      span.setAttributes({ 'example.account.found': account !== undefined });
      return account;
    },
  );
}
```

将回调 span 传递给更低层的工作以创建显式嵌套：

```typescript
return telemetryContext.startSpan({ name: 'example.parent' }, async (parentSpan) => {
  return parentSpan.startSpan({ name: 'example.child' }, async (childSpan) => {
    childSpan.addEvent('example.cache.lookup', { 'example.cache.hit': true });
    return performWork();
  });
});
```

没有公开的 `end()` 方法。`startSpan()` 拥有结算权，并保持 span 打开，直到回调的值或 promise 结算。对于由正常返回值表示的预期失败，请显式设置 status：

```typescript
return telemetryContext.startSpan({ name: 'example.save' }, async (span) => {
  const result = await save();
  if (!result.ok) {
    span.setStatus({
      status: 'error',
      error: { name: 'SaveError', message: result.reason },
    });
  }
  return result;
});
```

## 适配器契约

适配器实现 `TelemetryContext`，并将通用 API 桥接到其 backend。它必须：

- 创建一个子 span，并同步地、恰好一次地调用回调；
- 保留回调的返回值和 rejection 值，在同步抛出后返回以相同值 rejected 的 promise；
- 保持原生 span 打开，直到返回的 promise 结算；
- 除非设置了显式 status，否则将正常完成视为 `ok`，将抛出/rejection 视为错误；
- 使重复的 `setStatus()` 调用以最后写入为准；
- 合并 `setAttributes()` 调用，后定义的值替换先前的值，`undefined` 被忽略；
- 使记录方法同步、被动且不抛出；
- 忽略结算之后所做的调用；
- 原子地忽略失败的记录调用，抑制 backend 失败，并且仍然恰好执行一次业务回调。

适配器可以在内部激活 backend 原生的 ambient context 以实现自动埋点，但 pi 代码始终通过 `TelemetryContext` 参数传播父级。Exporter 缓冲、刷新、采样、backend ID 以及 backend 特有的 context 对象都属于适配器。使用[适配器一致性套件](#adapter-conformance)检查这些可观察语义。

## 无操作 Context

当 telemetry 是可选的时，使用 `NOOP_TELEMETRY_CONTEXT`：

```typescript
import { NOOP_TELEMETRY_CONTEXT } from '@earendil-works/pi-telemetry';

const result = await NOOP_TELEMETRY_CONTEXT.startSpan(
  { name: 'example.operation' },
  () => runOperation(),
);
```

no-op context：

- 同步调用回调；
- 保留返回值和异步 rejection，并将同步抛出转换为以相同值 rejected 的 promise；
- 使用一个共享的冻结惰性 span，嵌套 span 也是如此；
- 不检查也不保留名称、attribute、event 或 status。

## 内存参考适配器

`InMemoryTelemetryContext` 是 backend 中立的参考实现。它适用于测试、本地诊断，以及有意想要无 exporter 的进程本地捕获的应用程序：

```typescript
import { InMemoryTelemetryContext } from '@earendil-works/pi-telemetry';

const telemetry = new InMemoryTelemetryContext();

await telemetry.startSpan(
  { name: 'example.operation', attributes: { input: 'demo' } },
  async (span) => {
    span.addEvent('example.started');
    span.setAttributes({ output_count: 3 });
  },
);

console.log(telemetry.getSpans());
```

`getSpans()` 按 span 启动顺序返回分离的 snapshot。每个 `RecordedTelemetrySpan` 包含确定性的数字 ID、父 ID、合并后的 attribute、有序 event、最终 status、结算状态和确定性的结束序列。它不记录任何时间戳。

该适配器可以安全地作为普通的 `TelemetryContext` 使用，但存储是无界的且为进程本地。创建一个新实例以隔离测试或记录范围，并且除非调用者的数据策略允许，否则不要捕获敏感的 attribute。

## 适配器一致性

`@earendil-works/pi-telemetry/testing` 导出一个与 runner 无关、以分组用例建模的一致性套件。fixture 提供一个全新的 context，并将其 backend 已完成的 span 转换为规范化的 `RecordedTelemetrySpan` snapshot：

```typescript
import {
  createTelemetryAdapterConformance,
  type TelemetryAdapterFixture,
} from '@earendil-works/pi-telemetry/testing';
import { describe, it } from 'vitest';

const conformance = createTelemetryAdapterConformance(async () => {
  const adapter = createMyTelemetryAdapter();
  return {
    context: adapter.context,
    getSpans: async () => adapter.normalizedSpans(),
    async [Symbol.asyncDispose]() {
      await adapter.close();
    },
  } satisfies TelemetryAdapterFixture;
});

for (const group of new Set(conformance.map((testCase) => testCase.group))) {
  describe(group, () => {
    for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
      it(testCase.name, () => testCase.run());
    }
  });
}
```

该套件检查同步单次接纳、结果与 rejection 的同一性、自动和显式 status、attribute 合并、event 排序、结算后调用的惰性、嵌套与并发父子关系，以及对不可读 telemetry 载荷失败的抑制。`getSpans()` 在返回前可能刷新异步 exporter。testing 子路径使用 Node 的 assertion API；根 telemetry package 保持运行时中立。

## 类型化 Schema

低层 span API 有意接受开放名称和 attribute bag，以便适配器保持通用。领域 package 可以定义封闭的、可序列化的 schema，并从中推断出确切的 TypeScript 类型。

```typescript
import {
  createTypedSpanStarter,
  defineTelemetrySchema,
} from '@earendil-works/pi-telemetry';

export const EXAMPLE_TELEMETRY_SCHEMA = defineTelemetrySchema({
  version: 1,
  spans: {
    'example.read': {
      description: 'Read one resource',
      parents: { kind: 'any' },
      startAttributes: {
        'example.resource': {
          type: 'string',
          required: true,
          values: ['account', 'project'],
          description: 'Resource kind',
        },
      },
      endAttributes: {
        'example.item_count': {
          type: 'number',
          description: 'Number of returned items',
        },
      },
      events: {
        'example.cache': {
          description: 'Cache lookup result',
          attributes: {
            'example.cache.hit': {
              type: 'boolean',
              required: true,
              description: 'Whether the cache contained the resource',
            },
          },
        },
      },
      status: {
        default: 'ok',
        errorWhen: 'The read throws or returns an error result',
      },
    },
  },
} as const);

const startSpan = createTypedSpanStarter(
  telemetryContext,
  [EXAMPLE_TELEMETRY_SCHEMA],
);
```

该 starter 为每个 span 暴露一个 overload，并在编译期检查名称和 attribute。联合取值的名称必须在调用前收窄，从而保留每个运行时名称与其 attribute schema 之间的关系。其回调接收一个基于相同 schema 的子 starter，且已绑定到回调 span：

```typescript
await startSpan(
  'example.read',
  { 'example.resource': 'account' },
  async (span, startChildSpan) => {
    span.addEvent('example.cache', { 'example.cache.hit': true });
    const accounts = await readAccounts();
    span.setAttributes({ 'example.item_count': accounts.length });

    await startChildSpan(
      'example.read',
      { 'example.resource': 'project' },
      async (childSpan) => {
        const projects = await readProjects();
        childSpan.setAttributes({ 'example.item_count': projects.length });
      },
    );

    return accounts;
  },
);
```

### 起始与完成 Attribute

`startAttributes` 和 `endAttributes` 描述某个 attribute 通常在何时已知，而非单独的运行时存储：

| Schema 字段 | 值如何被记录 | 必需性 |
|---|---|---|
| `startAttributes` | 在创建 span 时传入类型化 starter 的 `attributes` 参数 | 每个定义显式设置 `required: true` 或 `false` |
| `endAttributes` | 稍后通过 schema 范围内的 span 的 `setAttributes()` 方法添加 | 始终可选 |

这两组都会成为同一个 backend span 上的普通 attribute。不存在单独的 end-attribute 载荷或 end 回调。在前面的示例中，`example.resource` 在 `example.read` 启动时已知，而 `example.item_count` 只有在 `readAccounts()` 返回后才已知：

```typescript
await startSpan(
  'example.read',
  { 'example.resource': 'account' }, // required start attribute
  async (span) => {
    const accounts = await readAccounts();
    span.setAttributes({
      'example.item_count': accounts.length, // optional completion attribute
    });
    return accounts;
  },
); // resolving the callback settles the span
```

“End”意味着完成时的丰富化：end attribute 可以在回调处于活动状态期间的任意时刻设置，并且在不可用时可以省略。调用 `setAttributes()` 零次是有效的。这对早期失败、取消以及并非每条路径上都存在的 provider 特有数据很重要。

重复的 `setAttributes()` 调用会合并到同一个 attribute bag。后定义的值会替换同一键的先前值，而 `undefined` 被忽略。schema 范围内的方法只接受当前 span 声明的 end attribute。

Attribute 不会结束 span。从回调返回、resolve、抛出或 reject 决定结算；`startSpan()` 执行实际的结束 operation。结算之后所做的适配器调用是惰性的。

一个 starter 可以组合多个独立版本化的 schema：

```typescript
import { AGENT_TELEMETRY_SCHEMAS } from '@earendil-works/pi-agent-core';

const startAgentSpan = createTypedSpanStarter(
  telemetryContext,
  AGENT_TELEMETRY_SCHEMAS,
);
```

内联 schema 数组会自动保留其元组类型。单独声明的数组应使用 `as const`。数组中字面量重复的 span 名称会在编译期被拒绝；schema 在运行时不会被合并、检查或保留。

从 schema 派生的类型会拒绝缺失的必需 attribute、未知键、无效的封闭集合值、未声明的 event，以及空 schema 上的 attribute。End attribute 始终是可选的丰富化；类型系统不要求调用 `setAttributes()`。

`defineTelemetrySchema()` 是一个类型化的恒等函数。它返回普通的 JSON 可序列化数据，不执行任何运行时验证或父规则强制。

## Schema 元数据

受支持的 attribute 类型有：

- `string`、`number` 和 `boolean`；
- `string[]`、`number[]` 和 `boolean[]`。

Attribute 定义支持：

- `values`：标量值的封闭集合；
- `elementValues`：数组元素的封闭集合；
- `examples`：文档示例；
- `sensitive`：标记需要特殊处理的数据；
- `cardinality`：记录预期的 `low` 或 `high` 基数。

Start 和 event attribute 声明 `required`。End attribute 不声明；参见[起始与完成 Attribute](#start-and-completion-attributes)。

父级 metadata 是描述性的 schema 数据：

- `{ kind: 'any' }`：根 span 或任意调用者 span；
- `{ kind: 'root_or_external' }`：根 span 或 schema 之外的调用者拥有的 span；
- `{ kind: 'spans', spans: [...] }`：仅限列出的 schema span。

适配器不需要理解 schema 对象。埋点辅助函数和测试使用它们来保持发出的名称和 attribute 一致。

## Pi Package 集成

Package 所有权被有意拆分：

- `@earendil-works/pi-telemetry` 拥有厂商中立的契约、no-op 和内存参考 context、schema 工具以及适配器一致性套件；
- `@earendil-works/pi-ai` 在 provider 请求选项中接受并传播 `telemetryContext`，但不拥有任何 telemetry schema；
- `@earendil-works/pi-agent-core` 拥有并导出 pi AI-request 和 harness schema、它们合并后的只读 schema 元组以及类型化 span 辅助函数。

```typescript
import {
  AGENT_TELEMETRY_SCHEMAS,
  AI_TELEMETRY_SCHEMA,
  HARNESS_TELEMETRY_SCHEMA,
  startAiSpan,
  startHarnessSpan,
} from '@earendil-works/pi-agent-core';
```

pi schema 使用 pi 拥有的 `pi.ai.*`、`pi.harness.*` 和 `pi.session.*` 名称。适配器可以将它们转换为 backend 约定，而无需更改发出的 pi 词汇表。

## 安全性与可移植性

Telemetry 是进程本地诊断，而非持久的应用状态。不要在记录、消息、snapshot 或延迟句柄中持久化 `TelemetryContext`、`TelemetrySpan` 或 backend 原生的 trace 对象。

Attribute 值被有意限制为原始标量和数组。领域埋点应避免 prompt、completion、tool 参数或输出、文件内容、provider 载荷、header、凭据以及自由形式的错误详情，除非其 schema 和数据策略明确允许。

该 package 不使用 `AsyncLocalStorage` 或其他运行时特有的 ambient context API。它适用于 Node.js、Bun、浏览器和 worker；backend 适配器仍对其自身的运行时兼容性负责。

## API 参考

### 核心类型和值

| 导出 | 用途 |
|---|---|
| `TelemetryContext` | 启动由回调管理的子 span |
| `TelemetrySpan` | 记录 attribute、event 和 status；同时也充当子 context |
| `SpanOptions` | Span 名称和可选的 start attribute |
| `SpanAttributes` / `AttributeValue` | 开放的适配器级 attribute bag 和受支持的值 |
| `SpanStatus` | 显式的 `ok` 或 `error` status |
| `NOOP_TELEMETRY_CONTEXT` | 用于禁用 telemetry 的共享被动 context |
| `InMemoryTelemetryContext` | 具有确定性进程本地记录的参考适配器 |
| `RecordedTelemetrySpan` | 规范化捕获的 span snapshot |
| `RecordedTelemetryEvent` | 规范化捕获的 event snapshot |

### Schema 定义与推断

| 导出 | 用途 |
|---|---|
| `defineTelemetrySchema()` | 用于可序列化 schema 数据的类型化恒等辅助函数 |
| `createTypedSpanStarter()` | 将父 context 绑定到一个或多个 schema 词汇表 |
| `TypedSpanStarter` | 具有递归子绑定回调的确切 starter 类型 |
| `TelemetrySchemaDefinition` | 顶层 schema 形状 |
| `TelemetrySpanDefinition` | Span metadata、父级、attribute、event 和 status 规则 |
| `TelemetryAttributeType` | 受支持的标量和数组类型名称 |
| `TelemetryAttributeMetadata` | 描述、敏感性和基数 metadata |
| `TelemetryAttributeDefinition` | Attribute 类型、允许的值、示例和 metadata |
| `TelemetryStartAttributeDefinition` | 带必需性的 start attribute 定义 |
| `TelemetryEventAttributeDefinition` | 带必需性的 event attribute 定义 |
| `TelemetryEventDefinition` | Event 描述和 attribute 定义 |
| `TelemetryParentDefinition` | 开放、外部根或有限 schema 父规则 |
| `TelemetrySchemaSpanName` | 已声明 span 名称的联合 |
| `TelemetrySchemaSpanStartAttributes` | 为一个 span 推断出的确切 start attribute |
| `TelemetrySchemaSpanEndAttributes` | 为一个 span 推断出的可选 end attribute |
| `TelemetrySchemaSpanEventName` | 由一个 span 声明的 event 联合 |
| `TelemetrySchemaSpanEventAttributes` | 为一个 event 推断出的确切 attribute |
| `SchemaTelemetrySpan` | 限定到一个 schema span 的 span 视图 |
| `TelemetrySchemaSpanUnion` | schema 中所有 span 的可辨识联合 |
| `InferStartAttributes` | 从 start 定义推断出的必需和可选值 |
| `InferOptionalAttributes` | 从 end 定义推断出的可选值 |
| `InferEventAttributes` | 从 event 定义推断出的必需和可选值 |
| `InferRequiredAndOptionalAttributes` | 用于带必需性定义的共享推断工具 |
| `ExactTelemetryAttributes` | 拒绝预期 attribute 集合之外的键 |

### Testing 子路径

| 导出 | 用途 |
|---|---|
| `createTelemetryAdapterConformance()` | 创建与 runner 无关的适配器一致性用例 |
| `TelemetryAdapterFixture` | 为一个用例提供全新 context 和规范化 snapshot 读取器 |
| `TelemetryAdapterFixtureFactory` | 创建隔离的 fixture |
| `TelemetryAdapterConformanceCase` | 测试 runner 执行的分组用例 |

## 开发

从此 package 目录：

```bash
npm test
npm run build
```

repository 范围的类型检查、格式化、lint 和 smoke 检查通过以下命令运行：

```bash
npm run check
```

## 许可证

MIT
