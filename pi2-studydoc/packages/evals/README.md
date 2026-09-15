# Pi evals

Pi evals 是针对 Pi 工作流的行为性、模型驱动的检查。它们将真实的 `AgentSession` 适配到 `vitest-evals`，在隔离的临时项目目录和 agent 目录中运行
它，并附加原生 Pi session 产物。
使用它们来度量端到端行为，并比较 prompt、tool、skill、模型或其他 harness 配置。

## 运行 evals

从 repository 根目录使用默认 provider 和模型运行：

```bash
npm run eval -- --provider openai --model gpt-5.6-sol
```

等价的环境变量是：

```bash
PI_PROVIDER=openai PI_MODEL=gpt-5.6-sol npm run eval
```

CLI 值优先，并成为未显式选择模型的 harness 的默认值。Provider 和 model 必须一起提供。当每个执行的 harness 都配置自己的模型时，runner 也允许没有默认值。
认证来自 Pi 正常的 `ModelRuntime`，包括 Pi 订阅凭据和 provider API-key
环境变量。

额外的参数会转发给 Vitest：

```bash
npm run eval -- src/extensions.eval.ts
npm run eval -- -t "creates and uses the extension"
npm run eval -- src/docs.eval.ts -t "session-format\.md"
```

在一次调用中将所有比较性 customization eval 运行五次：

```bash
npm run eval -- \
  src/extensions.eval.ts src/models.eval.ts src/providers.eval.ts \
  --provider openai --model gpt-5.6-sol \
  --repetitions 5
```

`--repetitions` 适用于用 `evalHarnessTable(...)` 声明的套件。套件中显式的 `repetitions` 值
会覆盖命令行默认值。`PI_EVAL_REPETITIONS=5` 等价于命令行选项。在开发 eval 时使用一次重复，
在报告提升时使用五次。

## 报告与产物

每次调用都会在 Vitest 结果之后打印一份复合的 `Eval Comparisons` 报告。当多个比较性文件
在同一次调用中运行时，此报告为每个 eval set 包含一个 section。例如，使用示意性值：

```text
Eval Comparisons
  Add model to existing provider
     Baseline  system-prompt-without-docs
    Candidate  default-system-prompt (5/5 pairs)
    Pass rate  +60.0 pp (candidate 80.0%, baseline 20.0%)
       Tokens  +1200.0 (candidate 24000.0, baseline 22800.0)
      Latency  -850.0ms (candidate 14000.0ms, baseline 14850.0ms)
    Est. cost  +$0.0100 (candidate $0.1200, baseline $0.1100)

  Add OpenAI-compatible provider
    ...

  Add custom streaming provider
    ...
```

runner 在启动时打印被忽略的 `.eval/` 产物目录。它包含：

- `report.txt`：不带颜色代码的终端比较报告。
- `report.json`：与结构化 JSON 相同的聚合比较数据。
- `runs.jsonl`：每个完成的 harness 运行一条记录。
- `sessions/`：原生 Pi session JSONL attachment。
- `sources/`：由各个 eval 记录的源 attachment。

该报告涵盖使用 `evalHarnessTable(...)` 的比较性套件。普通 eval 仍会出现在 Vitest 摘要和
`runs.jsonl` 中，但不会出现在 baseline-versus-candidate 比较报告中。产物可能包含 prompt、响应、
源代码和 tool 输出。

## 编写 evals

关于通用套件、judge、assertion 和规范化
trace 的指导，请遵循 [`vitest-evals`](https://github.com/getsentry/vitest-evals)。Pi 特有的 eval 使用来自 `src/pi-harness.ts` 的 `createPiCodingAgentHarness(...)`，并将一个 harness 绑定
到每个 `describeEval(...)` 套件：

```ts
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createPiCodingAgentHarness } from "./pi-harness.ts";

const harness = createPiCodingAgentHarness({ noTools: "all" });

describeEval("Pi smoke", { harness }, (it) => {
	it("answers a factual question", async ({ run }) => {
		const result = await run("What is the capital of France? Reply with only the city name.");
		expect(result.output).toBe("Paris");
	});
});
```

### 配置 Pi harness

`createPiCodingAgentHarness(...)` 接受：

- `name`：报告和比较所使用的稳定 harness 标识。
- `model`：可选的 `{ provider, id }` 选择。它会覆盖 runner 的默认模型。
- `noTools`：Pi 的 tool 禁用配置。
- `tools`：被评估 agent 可用的 tool 名称的可选 allowlist。
- `customTools`：为被评估 agent 注册的自定义 tool 定义。
- `transformSystemPrompt`：在 eval 开始前转换完整的默认 prompt。
- `output`：将最终响应和 `AgentSession` 转换为 JSON 安全的领域结果。

显式选择的模型使模型比较 harness 独立于 runner 默认值：

```ts
const harness = createPiCodingAgentHarness({
	name: "claude-opus-4-6",
	model: { provider: "anthropic", id: "claude-opus-4-6" },
});
```

一次运行接受一个 prompt，或一串 prompt 和 reload 步骤。当前面的
prompt 创建或更改 Pi 资源时，reload 步骤很有用：

```ts
const result = await run([
	{ type: "prompt", content: "Create a Pi extension." },
	{ type: "reload" },
	{ type: "prompt", content: "Use the extension." },
]);
```

### 转换 harness 输出

使用 `output` 暴露场景特有的、JSON 安全的行为，而无需将该行为添加到通用 Pi 适配器：

```ts
const harness = createPiCodingAgentHarness({
	output: ({ response, session }) => ({
		response,
		activeTools: session.getActiveToolNames(),
		extensionErrors: session.resourceLoader.getExtensions().errors,
	}),
});
```

在 `result.output` 上断言应用行为。在 `result.session` 上断言模型和 tool trace，使用
`vitest-evals` 辅助函数，例如 `toolCalls(...)`。

### 编写比较性 eval set

使用 `evalHarnessTable(...)` 配合 Vitest 原生的 `describe.for(...)` 对多个 harness 运行相同的输入。
Harness 可以在 prompt、tool、skill、模型或任何其他 Pi 配置上不同：

```ts
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

const TargetTaskJudge = createJudge<string, string>("TargetTaskJudge", ({ output }) => ({
	score: output === "expected result" ? 1 : 0,
}));

const harnessTable = evalHarnessTable(
	"target skill effectiveness",
	{
		baseline: withoutTargetSkillHarness,
		candidate: withTargetSkillHarness,
		repetitions: 6,
	},
);

describe.for(harnessTable)("$name repetition $repetition", ({ harness }) => {
	describeEval("target skill effectiveness", { harness, judges: [TargetTaskJudge], judgeThreshold: null }, (it) => {
		it("completes the target task", async ({ run }) => {
			await run("Complete the target task.");
		});
	});
});
```

比较性套件应使用确定性或模型驱动的 judge 记录正确性，并设置 `judgeThreshold: null`。
这会将低分保留为观察结果，而不是让 Vitest 调用失败。仅对套件不变量和基础设施契约使用硬断言。
`expect.soft(...)` 仍会使测试失败，不是评分机制。

Pi harness 在删除其临时工作区之前会 snapshot 原生 session JSONL。一个仅用于 eval 的 `afterEach` hook
会在 reporter 运行之前将该 snapshot 注册到显式的 Vitest 测试任务上。

Harness 名称在 eval set 内必须稳定且唯一。分组键会将 repetition 与一个非空字符串
`input.id`（如果可用）结合，否则与严格规范 JSON 输入的 SHA-256 哈希结合。对一种处理使用 `candidate`，
对多种处理使用 `candidates`。每个 candidate 只与所声明的 baseline 比较。对于每个匹配的
输入和 repetition，reporter 根据每次运行记录的平均 judge 分数计算通过率提升，将至少为
`1` 的分数视为通过。提升是 candidate 通过率减去 baseline 通过率，以百分点为单位。缺失的
judge 分数会报告为不完整观察。Tokens、latency 和估计成本保持为单独的
candidate-minus-baseline 配对差值；缺失的 telemetry 保持不可用。如果执行顺序随机化成为
必要，请使用 Vitest 内置的序列打乱。

关于比较性 eval 方法论、repetition 策略、可信 judge 和 telemetry 解读，请参阅 [`skill-eval-harness`](https://github.com/adewale/skill-eval-harness/) 指南。
