# Coding agent suite 测试

使用 `test/suite/` 放置围绕 `AgentSession` 和 `AgentSessionRuntime` 的、基于 harness 的新测试套件。

规则：
- 使用 `test/suite/harness.ts`
- 使用来自 `packages/ai/src/providers/faux.ts` 的 faux provider
- 不要使用真实 provider API、真实 API key、网络调用或有偿 token
- 保持这些测试 CI 安全且确定性
- 不要使用或扩展遗留的 `test/test-harness.ts` 路径，除非缺失的能力迫使你这样做
