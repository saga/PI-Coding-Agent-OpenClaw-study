# WP03 — 移除 drive deadlines

## 状态

完成。`DriveOptions.deadline` 和 `DriveOutcome` 的 `yielded` 分支已从 public types、active documentation、future package requirements、invariants、races 和 tests 中移除。过时的 `runtime2.md` 已删除。聚焦的 tests、`npm run check` 和 `./test.sh` 通过。

WP02 已在 `beac75ecc` 完成。保留无关的并发源码工作，尤其是当前 `packages/agent/src/harness/runtime2/lane.ts` 的改动、JSONL/fork 工作、plugins、RPC 和 experimental 目录。

## 问题

`DriveOptions.deadline` 以及对应的 `DriveOutcome { kind: "yielded" }` 并不提供正确性边界。

deadline 只在开始另一个 transition 或 effect 之前被检查。一个已被 admit 的 provider/tool/hook 可能运行超过它，而 host 无论如何都可能终止进程：

```text
check deadline
→ admit provider or tool
→ host limit expires while the effect is running
→ process dies with durable effect_pending
```

未知结果的 recovery 仍然是强制性的。因此 deadline 并不能防止进程丢失、限制已 admit 的工作、使 effects 恰好执行一次，也不能简化 recovery。Flue 风格的 tool memoization 依赖稳定的 invocation ids 和 durable memos，而非 drive deadlines。

相反，处理 deadline 会把 wall-clock 策略加入 durable core：

- 一个与 durable state 无关的 `yielded` public outcome；
- 在 hooks/effects/transitions 之前做 safe-boundary 检查；
- deadline 与 retry-timer 的仲裁；
- deadline 与 effect-admission 的 races；
- 针对 yields 的 convenience loops 与 event-bracket 行为。

Host 已经拥有调度与终止。进程丢失是一个受控的 crash 边界，可从 durable operation state 中恢复。

## 决定

彻底移除 drive deadlines：

```ts
interface DriveOptions {
  operationId: string;
  waitForRetry?: boolean;
  pollDeferred?: boolean;
}

type DriveOutcome =
  | { kind: "settled"; operationId: string; outcome: TerminalOperationOutcome }
  | { kind: "waiting"; operationId: string; reason: "retry"; notBefore: number }
  | { kind: "waiting"; operationId: string; reason: "deferred"; deferred: DeferredHandle }
  | { kind: "action_required"; operationId: string; action: ActionInfo };
```

WP03 中没有 deprecated alias、被忽略的 `deadline` 字段、compatibility overload、alternate timestamp option 或替代性的 pause flag。

下一个 drive package 使用直接的 durable transitions。Deterministic tests 会在不添加 production execution barriers 的情况下 gate commits 并控制 hooks、providers、tools 和 timers。

## Host 行为

Hosts 拥有执行预算：

```text
invoke drive
→ terminal or durable waiting result: schedule normally
→ planned shutdown: stop routing/releasing work and close session processes
→ forced termination: replacement attaches and recovers durable open operations
```

每个 session 一个进程的 host 可以停止路由工作并在退出前关闭，并使用进程终止作为针对不配合的 providers、tools、hooks、storage 或 event listeners 的硬性 fence。这一运维策略并不需要在 `DriveOptions` 中设置 wall-clock 字段。

WP03 不添加 `stopAfterCheckpoint`、`pause`、`quiesce` 或进程内 crash 模拟。这些想法仍在 direct durable-drive 设计之外。进程内的进程丢失模拟不是 public core primitive：旧的 continuation 需要 fencing，而进程隔离是实现 fencing 的可靠机制。

## 工作

### Public types

在 `packages/agent/src/harness/agent-harness.ts` 中：

- 删除 `DriveOptions.deadline`；
- 删除 `DriveOutcome` 的 `yielded` 分支；
- 原样保留 expected-id fencing、retry waiting、deferred waiting 和 manual action 分支。

当前不存在 runtime2 的 drive 实现，因此本 package 不添加任何执行行为或 owner。

### Normative documentation

完整更新 `packages/agent/docs/harness.md`：

- 从 non-goals/orientation 中移除 safe-yield scheduling 的表述；
- 仅移除 §3.6、§5.6 的 `before_drive` 行以及 invariant 22 中 cancellation/deadline 前置条件措辞里的 deadline 那一半；cancellation 前置条件保留；
- 从 drive-pass 伪代码中移除 deadline 检查与 yielded 返回；
- 从 pass joining、retry waiting、convenience composition、recovery 和 public method 的正文中移除 deadline 策略；
- 从 `DriveOptions` 中移除 `deadline`，从 `DriveOutcome` 中移除 `yielded`；
- 移除 deadline 专属的 event/turn 要求；
- 从 `before_drive` hook 时序中移除 deadline 表述；
- 从 future work 行中移除 deadline/yield 要求；
- 用明确的 no-wall-clock-policy invariant 替换 invariant 25，同时保留「已 admit 的 effect 正常 settle，或在 task loss 之后被 recover」这一规则；
- 从 race catalog 中移除 deadline races；
- 更新 drive-pass 词汇表。

不要改动通用 RPC timeout/deadline 文档，也不要改动无关的 process/model-catalog timeouts。那些是 invocation/transport 策略，而不是 `AgentLane.drive`。

删除过时的 `packages/agent/docs/runtime2.md`；`harness.md` 加上关联的交接内容是 active 工作唯一需要的实现计划与历史。

在其 handoff 与第 8 部分中将 WP02 标记为完成。添加 WP03 作为具体的清理 package。将原先的 R2/R3 drive 行作为历史性的 future 候选保留（去掉 deadline/yield 要求），直到经过评审的 direct-drive 交接内容取代它们。

### 删除

- `packages/agent/docs/runtime2.md`

### Type tests

扩展 `packages/agent/test/harness/types.test.ts`：

- 断言 `keyof DriveOptions` 恰好是 `"operationId" | "waitForRetry" | "pollDeferred"`；
- 断言 `DriveOutcome["kind"]` 不包含 `"yielded"`；
- 添加 `@ts-expect-error` 覆盖，证明调用方无法提供 `deadline`；
- 保留现有的 drive/result 签名。

编辑后运行聚焦的 type test。

### Downstream compatibility

在 protocol、server、coding-agent、examples 和 tests 中搜索结构性镜像或穷尽式 `DriveOutcome` switch。只更新因公开移除而被迫需要的 compile-time/type 兼容性。Coding-agent 的 experimental worker/remote-runtime 行为与测试不在范围内。

当前 protocol harness schemas 暴露的是 prompt/run/watch DTOs，而不是 `DriveOptions` 或 `DriveOutcome`；除非最终搜索证明并非如此，否则预期不需要修改 protocol。

## 非目标

WP03 不实现也不重新设计：

- `drive`、`resume`、prompt conveniences、operation ownership 或 latest-result lookup；
- manual actions 或 automatic barrier release；
- provider/tool execution、recovery、retry timers、deferred polling、abort 或 terminal settlement；
- checkpoint pause/quiesce；
- close admission 变更；
- worker/RPC cancellation 或 experimental remote prompting；
- storage/schema/migration 行为。

## 必需的检查

```bash
# No drive deadline/yield contract remains in active harness docs or source.
rg -n 'deadline|yield' \
  packages/agent/src/harness \
  packages/agent/test/harness \
  packages/agent/docs/harness.md \
  packages/agent/docs/work-packages

cd packages/agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/harness/types.test.ts

cd "$(git rev-parse --show-toplevel)"
git diff --check
npm run check
./test.sh
```

移除项的 grep 仍可能匹配本交接的历史问题说明。每一处剩余匹配都必须经过审查；任何 active API、normative behavior、future acceptance criterion 或 test expectation 都不得保留被移除的 contract。

## 评审

在实现之前：

1. Fable 对照完整的 docs/source 评审本交接。
2. 按用户的明确要求，`openai-codex/gpt-5.6-sol` 以 thinking level high 评审它。
3. 解决所有发现，并重复直到没有发现。

在实现之后，对最终 documentation/type diff 重复这两项评审。

## 停止条件

当满足以下条件时停止：

- `DriveOptions` 没有 wall-clock 预算；
- `DriveOutcome` 没有 `yielded` 分支；
- active normative docs 不包含 deadline/yield 行为；
- future drive 行不包含隐藏的 deadline 要求；
- type tests 证明移除完成；
- 无关的 timeout/deadline API 保持未被改动；
- 聚焦的 tests、`npm run check` 和 `./test.sh` 通过；
- 最终的 Fable 与 Codex 评审没有发现。

不要在本 package 中开始 direct durable-drive 的实现。
