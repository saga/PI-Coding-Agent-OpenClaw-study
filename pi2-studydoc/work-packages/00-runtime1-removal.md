# WP00 — Runtime1 移除

## 状态

完成。无 tag。Runtime2 是唯一的公开实现。在其执行路径不完整期间不要发布。

## 目标

让 runtime2 成为唯一的公开 harness 实现，删除 runtime1 及其过时的测试，然后在添加 runtime2 行为之前停止。

## 前置条件

- 已批准的 acceptance/hook 重新设计与 durability 交接内容已存在于 `harness.md`、`values.md`、`assistant-durability.md` 和 `tool-durability.md` 中。
- 现有测试是证据，而不是权威。

## 工作，按顺序

1. **对齐契约。** 将已批准的 acceptance/hook 重新设计并入 `harness.md`，包括 durable 的 `starting`、无 hook 的原子 acceptance、driver 拥有的 `before_run`、`before_drive`、request-local 的 system-prompt 变换、可信 restore，以及移除 process-origin activation 语义。审计 §§0.4、1.2、3.1–3.6、4.1–4.2、4.5、5.1–5.2、5.5–5.6 以及第 8–9 部分；移除每一处过时的 `BeforeResumePrepared`、`before_resume`、`resumeData`、`systemPromptOverride`、stable-ID 路由、reservation 和 `fresh | continue | resume` activation 引用。一旦 `harness.md` 及关联的交接内容拥有 active contract，就删除过时的 runtime 规划文档。
2. **删除前先收割。** 检查 `agent-harness-runtime.test.ts`、`agent-harness-r2/r3/r4.test.ts` 和旧的 `restore.test.ts`。将独有的场景保留在详细的 future 行或一个临时的分类清单中；明确丢弃旧的 reservation、`before_resume`、`resumeData`、持久化的 hook prompt override、semantic restore audit 以及 `outcome_ready` 之前的 tool-crash 行为。
3. **移除仅属于 runtime1 的公开成员。** 删除 `before_resume`、`BeforeResumePrepared`、`resumeData`、`systemPromptOverride` 和 stable hook-ID 路由。添加已批准的 `before_drive` 与 `transform_context` 形状。更新 telemetry schema 源并重新生成其文档。不要在此实现 `starting` 或 acceptance 行为。
4. **切换 factory。** 添加 `packages/agent/src/harness/runtime2/index.ts`，让 `agent-harness.ts` 指向它，并添加一个 constructor-selection 回归测试。验证实验性的 coding-agent worker 仍能创建 harness、订阅事件并关闭它。
5. **删除下面列出的 runtime1 源码与测试。**
6. **在 `main` 或某个 pull-request 分支上更新 `[Unreleased]`**，以记录公开的破坏性移除和暂时不完整的 factory。仓库策略禁止在 `dev` 上编辑 changelog，因此 WP00 只做记录，而不在此执行这一面向发布的步骤。
7. 运行保留的测试与检查。修复每一处失败；不要恢复 compatibility shims。

## 删除

```text
packages/agent/src/harness/runtime/**
packages/agent/src/harness/restore.ts
packages/agent/test/harness/agent-harness-runtime.test.ts
packages/agent/test/harness/agent-harness-r2.test.ts
packages/agent/test/harness/agent-harness-r3.test.ts
packages/agent/test/harness/agent-harness-r4.test.ts
packages/agent/test/harness/restore.test.ts
packages/agent/test/harness/scratch/r1.ts
packages/agent/test/harness/scratch/r2.ts
packages/agent/test/harness/scratch/r3.ts
packages/agent/test/harness/scratch/r4.ts
```

## 保留

- 所有 `test/harness/runtime2/**` 测试；
- Session、Branch、storage、repository、backend-conformance 和 instrumentation 测试；
- execution 的 assistant/tool/primitives 测试；
- config、hooks、events、telemetry、compaction 和 branch-summary 的代码/测试；
- `types.test.ts`，为缩减后的 public contract 更新；
- `packages/agent/src/agent-loop.ts` 保持不变。

不要将过时的 runtime1 测试套件参数化以针对 runtime2 运行，也不要保留 runtime1 smoke 套件。

## 验收

- 没有任何源码 import 引用 `harness/runtime/*`。
- 公开的 `AgentHarness.create()` 选择 runtime2。
- Runtime2 的创建、事件、inspection、close 和 fault 测试通过。
- 以下 coding-agent 测试通过：
  - `experimental-remote-runtime.test.ts`
  - `experimental-session-worker-manager.test.ts`（被移除的 `experimental-session-worker.test.ts` 的上游替代）
  - `experimental-session-worker-lifecycle.test.ts`
- 每个被修改的测试都能单独通过。
- Agent 与 root 的 TypeScript 通过。
- `git diff --check` 与 `npm run check` 通过。

## 结果

- 已接受的 hook/drive contract 在 `harness.md` 中具有规范性；过时的 acceptance/resume contract 已不存在。
- Runtime1 源码、用于校验的 restore、过时的测试套件以及 R1–R4 scratch 场景均已删除。
- `AgentHarness.create()` 经由 `runtime2/index.ts` 解析；一个 constructor-selection 回归测试证明了这一点。
- 场景收割为 future 行补充了缺失的 tool-close、identity-preflight、recovery-ordering、turn-bracket 和 telemetry 用例。
- 在本交接起草之后，上游添加了两个真实的 remote prompt 测试。它们仍然存在，但被跳过，并带有 R2 重新启用的要求，因为 runtime2 的执行是有意不完整的。Worker 创建、attachment、lifecycle、operation correlation 和 close 覆盖率通过。

## 非目标

- 不实现 bound-value/list。
- 不实现 `starting` 或原子 acceptance。
- 不实现 drive owner、provider、retry、deferred 或 tool execution。
- 不做 runtime1 parity 工作、兼容层、archaeology tag 或发布。

## 停止条件

当 runtime1 已不存在、runtime2 是公开 factory、保留的覆盖率全绿且所有检查都通过时停止。报告删除内容与收割到的场景；不要开始另一个 work package。
