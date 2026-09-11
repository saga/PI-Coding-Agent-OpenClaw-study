# pi — 设计 handoff

按编号顺序工作。每个单元自包含且可独立测试；
后面的单元使用前面的单元。

```
01-harness/
  01-delta/            op vocabulary, tracker, applier, codec   [LANDED IN CHORD]
  02-scopes/           storage scopes and list tags              [STEP 1 ACTIONABLE]
  03-execenv/          bounded Shell output, capture, spill      [PRODUCTION CODE + TESTS]
  04-tool-output/      the ToolOutput sink                       [SPEC ONLY]
  05-assistant-output/ assistant partials, symmetric with 04     [SPEC ONLY]
02-plugins/
  01-facets/           the facet system                          [SPEC ONLY]
  02-sandbox/          isolated-vm membrane                      [CODE + 412 tests]
```

把所有内容建立在 `origin/dev` 的干净 checkout 之上。

## 先读这个

**三个单元交付可工作的代码。四个是规范。** 上面的表格说明了
是哪些。不要假设某份文档描述的东西已经存在。

**`01-delta/FINDINGS.md` 是历史证据，不是实现队列。** 生产代码位于 `packages/chord/src/delta/index.ts`：flush 时脏跟踪修复了 D1，生产环境重新测量关闭了 D2。显式的 append/truncate API 被拒绝；见 [`01-harness/01-delta/append-decision.md`](01-harness/01-delta/append-decision.md)。handoff 旁边的代码仍然是原型和基准证据。

**如果文档和代码不一致，以代码为准** — 修正文档并在
commit 中说明。

**先移植测试，再实现。** 每一组的注释都解释了它所防范的
失败，其中若干失败是静默的：输出错误，
却不抛异常。

**用 `node --experimental-strip-types` 做基准测试，绝不通过 transpiler。**
通过 `tsx` 测量这个模块会把结果夸大 2.6 倍。`FINDINGS.md` D5 列出了
另外五个测量陷阱，每一个都曾产生过一个自信的错误结论。

## 单元状态

| unit | 交付 | 状态 |
| --- | --- | --- |
| **01-delta** | `packages/chord` 中的生产实现和测试；此处为原型证据 | 已落地；D1 已修复，显式 text API 在生产重新测量后被拒绝 |
| **02-scopes** | 规范 + [可执行的 Step 1 handoff](01-harness/02-scopes/implementation-handoff.md) + `scopes.variance.ts` | Step 1 scopes/list tags 可执行，尚未实现；JSONL Chord encoding/address interning 推迟到单独批准的 Step 2 |
| **03-execenv** | `packages/agent` 中的生产实现；此处为原型证据 | 受源限界的自适应输出、惰性 spill 背压，以及 bash 迁移已落地；bash 临时的 checkpoint 节奏接下来移到 `ToolOutput` |
| **04-tool-output** | 规范 + 设计笔记 | **尚未构建。** op encoding 的每一项测量都依赖这一部分 |
| **05-assistant-output** | 规范 | 尚未构建。与 04 形态相同；在其之后做 |
| **02-plugins/01-facets** | 规范，约 1800 行 | 尚未构建。§14 已重写以匹配 sandbox PoC |
| **02-plugins/02-sandbox** | 可工作的 PoC，412 个断言 | `npm install && npm run audit` |

## 建议顺序

1. **`02-scopes` Step 1** — 遵循[可执行的实现 handoff](01-harness/02-scopes/implementation-handoff.md)；在其单独的 Step 2 之前停下来等待批准。
2. **`04-tool-output`** — 为通用工具、Chord event/durable 批次、terminal flush 和原子 memo checkpoint 复用已落地的自适应 publisher。
3. **05**，然后 **02-plugins**。

## `origin/dev` 上与本设计无关的活跃 bug

- `drive/tools.ts:257` — `clearReplayCheckpoint` 在重新执行 replay-safe 工具之前
  删除 `pendingToolOutput`。Memo 的存在是为了让被 replay 的工具跳过工作，而
  被跳过的工作不发出任何东西，所以今天 memoised 工作的输出会丢失。改为从
  它 seed（`harness-tools.md` §7.4）。
- `runtime/progress.ts:44` — `commitWrite(item)` 在调用时捕获值
  并以 fire-and-forget 方式写入，因此较旧的 checkpoint 可能落在较新的之后。
- memo 和 checkpoint 是两个事务（`drive/tools.ts:112` vs
  `progress.ts:44`）。它们必须是一个（`harness-tools.md` §7.5）。

**预期的测试变动：** 九个测试断言旧的 cleanup write set，一旦
`retireScope` 取代逐地址的 delete 就会失败。那正是这次变更落地。

## 环境

- 每个交付的 `.ts` 文件都需要 Node 22+。它们在
  `node --experimental-strip-types` 下运行，无需构建步骤，也没有依赖。
- 在 pi 仓库中，测试从包内运行：
  `cd packages/agent && npx vitest run --config vitest.harness.config.ts`。
  根 vitest 配置**不**为 `@earendil-works/pi-ai` 设置别名；
  每个包的 harness 配置会设置。
- 从仓库根目录用 `npx tsgo --noEmit` 做类型检查。**基线是约 788 个
  预先存在的错误**，几乎全在 `packages/ai/test`。只统计：
  `grep "error TS" | grep -E "packages/(agent|session-backends)/src"`。
- `packages/ai` 无法离线构建 — model data 在构建时获取。
