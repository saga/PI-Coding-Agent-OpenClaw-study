# Prompt engineering | OpenAI API

> 来源：https://developers.openai.com/api/docs/guides/prompt-engineering/

## 概述

通过 OpenAI API，你可以使用大型语言模型从提示生成文本，就像使用 ChatGPT 一样。模型可以生成几乎任何类型的文本响应——如代码、数学方程、结构化 JSON 数据或类人散文。

## 选择模型

生成内容时需要选择使用哪个模型。以下是选择模型时需要考虑的几个因素：

| 模型类型 | 特点 |
|---------|------|
| **Reasoning 模型** | 生成内部思维链分析输入提示，擅长理解复杂任务和多步规划。通常比 GPT 模型更慢、更贵 |
| **GPT 模型** | 快速、高效、高度智能，但需要更明确的任务指令 |
| **大/小模型** | 大模型更擅长理解提示和跨领域解决问题，小模型通常更快更便宜 |

**推荐**：gpt-4.1 提供了智能、速度和成本效益的可靠组合。

## Prompt Engineering

Prompt engineering 是为模型编写有效指令的过程，使其持续生成满足要求的内容。

由于模型生成的内容是非确定性的，提示获得所需输出是艺术与科学的结合。但你可以应用技术和最佳实践来持续获得良好结果。

### 建议

- 将生产应用固定到特定模型快照（如 gpt-4.1-2025-04-14）以确保行为一致
- 构建 evals 来衡量提示的行为，以便在迭代或更改模型版本时监控提示性能

## 消息角色和指令遵循

你可以使用 `instructions` API 参数或消息角色向模型提供不同权限级别的指令。

### 角色优先级

| 角色 | 说明 |
|------|------|
| **developer** | 应用开发者提供的指令，优先级高于用户消息 |
| **user** | 最终用户提供的指令，优先级低于开发者消息 |
| **assistant** | 模型生成的消息 |

可以将 developer 和 user 消息类比为编程语言中的函数及其参数：
- **developer 消息**：提供系统规则和业务逻辑，如函数定义
- **user 消息**：提供应用 developer 消息指令的输入和配置，如函数参数

### 示例

```javascript
import OpenAI from "openai";
const client = new OpenAI();

const response = await client.responses.create({
    model: "gpt-5",
    reasoning: { effort: "low" },
    instructions: "Talk like a pirate.",
    input: "Are semicolons optional in JavaScript?",
});

console.log(response.output_text);
```

## 可重用提示

在 OpenAI 仪表板中，你可以开发可重用的提示，在 API 请求中使用，而不是在代码中指定提示内容。这样你可以更轻松地构建和评估提示，并部署改进版本的提示而无需更改集成代码。

### 使用方式

1. 在仪表板中创建带有占位符（如 `{{customer_name}}`）的可重用提示
2. 在 API 请求中使用 `prompt` 参数

```javascript
const response = await client.responses.create({
    model: "gpt-5",
    prompt: {
        id: "pmpt_abc123",
        version: "2",
        variables: {
            customer_name: "Jane Doe",
            product: "40oz juice box"
        }
    }
});
```

## 构建提示

使用 Markdown 和 XML 标签可以帮助构建提示结构，使其在开发过程中更易读。

### 提示结构

通常，developer 消息按以下顺序包含以下部分：

1. **Identity（身份）**：描述助手的目的、沟通风格和高级目标
2. **Instructions（指令）**：提供模型如何生成所需响应的指导
3. **Examples（示例）**：提供可能的输入及所需输出的示例
4. **Context（上下文）**：提供模型生成响应所需的额外信息

### 示例提示

```markdown
# Identity
You are coding assistant that helps enforce the use of snake case variables in JavaScript code, and writing code that will run in Internet Explorer version 6.

# Instructions
* When defining variables, use snake case names (e.g. my_variable) instead of camel case names (e.g. myVariable).
* To support old browsers, declare variables using the older "var" keyword.
* Do not give responses with Markdown formatting, just return the code as requested.

# Examples
<user_query>
How do I declare a string variable for a first name?
</user_query>
<assistant_response>
var first_name = "Anna";
</assistant_response>
```

### Prompt Caching

构建消息时，应将预期在 API 请求中反复使用的内容放在提示的开头，并作为 JSON 请求体中传递的前几个 API 参数。这样可以最大化 prompt caching 的成本和延迟节省。

## Few-shot Learning

Few-shot learning 允许你通过在提示中包含少量输入/输出示例来引导大型语言模型完成新任务，而无需微调模型。

```markdown
# Identity
You are a helpful assistant that labels short product reviews as Positive, Negative, or Neutral.

# Instructions
* Only output a single word in your response with no additional formatting or commentary.
* Your response should only be one of the words "Positive", "Negative", or "Neutral" depending on the sentiment of the product review you are given.

# Examples
<product_review id="example-1">
I absolutely love this headphones — sound quality is amazing!
</product_review>
<assistant_response id="example-1">
Positive
</assistant_response>
```

## 包含相关上下文信息

在提示中包含模型可用于生成响应的额外上下文信息通常很有用。这种技术有时称为检索增强生成（RAG）。

### 上下文窗口规划

模型在生成请求期间只能处理一定量的数据。此内存限制称为上下文窗口，以 token 定义。

不同模型的上下文窗口大小从低 100k 到 100 万 token 不等。

## GPT-5 模型提示

GPT 模型（如 gpt-5）受益于在提示中明确提供完成任务所需的逻辑和数据的精确指令。GPT-5 特别具有高度可引导性，对良好指定的提示响应良好。

### GPT-5 提示最佳实践

#### 编码任务

- 定义代理角色
- 使用示例强制结构化工具使用
- 要求彻底测试正确性
- 设置 Markdown 标准

#### 前端工程

推荐使用以下库：
- **样式/UI**：Tailwind CSS, shadcn/ui, Radix Themes
- **图标**：Lucide, Material Symbols, Heroicons
- **动画**：Motion

#### 代理任务

- 彻底规划任务以确保完全解决
- 为主要工具使用决策提供清晰的前言
- 使用 TODO 工具有序跟踪工作流和进度

```markdown
Remember, you are an agent - please keep going until the user's query is completely resolved, before ending your turn and yielding back to the user. Decompose the user's query into all required sub-requests, and confirm that each is completed. Do not stop after completing only part of the request.
```

## Reasoning 模型提示

提示 reasoning 模型与提示 GPT 模型有一些不同：

- **Reasoning 模型**：像资深同事，只需给出目标，信任其处理细节
- **GPT 模型**：像初级同事，需要明确指令才能创建特定输出

## 下一步

- 在 Playground 中构建提示
- 使用 Structured Outputs 生成 JSON 数据
- 查看完整 API 参考

## 其他资源

- [OpenAI Cookbook](https://cookbook.openai.com/) - 示例代码和第三方资源
- 提示库和工具
- 提示指南
- 视频课程
- 高级提示推理论文
