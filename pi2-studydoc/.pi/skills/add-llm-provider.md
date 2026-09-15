---
name: add-llm-provider
description: 向 packages/ai 添加新 LLM provider 的检查清单。涵盖核心类型、provider 实现、惰性注册、model 生成、完整测试矩阵、coding-agent 接线以及文档。
---

# 添加一个新的 LLM Provider（packages/ai）

一个新的 provider 会触及多个文件。按顺序完成这些步骤。

## 1. 核心类型（`packages/ai/src/types.ts`）

- 将 API identifier 添加到 `Api` 类型联合中（例如 `"bedrock-converse-stream"`）。
- 创建一个扩展 `StreamOptions` 的 options interface。
- 向 `ApiOptionsMap` 添加映射。
- 将 provider 名称添加到 `KnownProvider` 类型联合中。

## 2. Provider 实现（`packages/ai/src/providers/`）

创建一个 provider 文件，导出：

- `stream<Provider>()`，返回 `AssistantMessageEventStream`。
- `streamSimple<Provider>()`，用于 `SimpleStreamOptions` 映射。
- Provider 特定的 options interface。
- Message/tool 转换函数。
- 发出标准化事件（`text`、`tool_call`、`thinking`、`usage`、`stop`）的响应解析。

## 3. Provider 导出与惰性注册

- 在 `packages/ai/package.json` 中添加一个指向 `./dist/providers/<provider>.js` 的包子路径导出。
- 在 `packages/ai/src/index.ts` 中为那些应保持从根入口可用的 provider option 类型添加 `export type` 再导出。
- 通过惰性加载器 wrapper 在 `packages/ai/src/providers/register-builtins.ts` 中注册该 provider；不要在那里静态 import provider 实现模块。
- 在 `packages/ai/src/env-api-keys.ts` 中添加凭据检测。

## 4. Model 生成（`packages/ai/scripts/generate-models.ts`）

- 添加从 provider 来源 fetch/解析 model 的逻辑。
- 映射到标准化的 `Model` interface。

## 5. 测试（`packages/ai/test/`）

- 始终将该 provider 添加到 `stream.test.ts`，并至少包含一个具有代表性的 model，即使它复用了现有的 API 实现（例如 `openai-completions`）。
- 在适用的情况下将该 provider 添加到更广泛的矩阵中：`tokens.test.ts`、`abort.test.ts`、`empty.test.ts`、`context-overflow.test.ts`、`unicode-surrogate.test.ts`、`tool-call-without-result.test.ts`、`image-tool-result.test.ts`、`total-tokens.test.ts`、`cross-provider-handoff.test.ts`。
- 对于 `cross-provider-handoff.test.ts`，至少添加一个 provider/model 对。如果该 provider 暴露多个 model 家族（例如 GPT 和 Claude），则为每个家族至少添加一对。
- 对于非标准认证，创建一个带有凭据检测的 utility（例如 `bedrock-utils.ts`）。

## 6. Coding Agent（`packages/coding-agent/`）

- `src/core/model-resolver.ts`：将默认 model ID 添加到 `defaultModelPerProvider`。
- `src/core/provider-display-names.ts`：添加 API-key 登录显示名称，以便 `/login` 及相关 UI 为内置 API-key 认证显示该 provider。
- `src/cli/args.ts`：添加环境变量文档。
- `README.md`：添加 provider 设置说明。
- `docs/providers.md`：添加设置说明、环境变量和 `auth.json` key。

## 7. 文档

- `packages/ai/README.md`：添加到 provider 表格，记录 options/auth，添加环境变量。
- `packages/ai/CHANGELOG.md`：在 `## [Unreleased]` 下添加条目。
