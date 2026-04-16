# Hermes Agent 研究题目列表

## 已覆盖研究

| 报告 | 状态 |
|------|------|
| Token 消耗分析 | ✅ 完成 |
| 上下文压缩实现方案 | ✅ 完成 |
| PI-Coding-Agent 实现方案 | ✅ 完成 |
| Agent 架构分析 | ✅ 完成 |

---

## 待研究题目

### 一、核心系统研究

#### 1. [高优先级] Multi-Agent 委托与协调系统
```
研究内容：
- delegate_task 工具的实现机制
- 子 Agent 会话隔离与状态传递
- 主-子 Agent 间的任务分解策略
- 结果聚合与冲突处理
- 与 Memory 系统的集成

参考代码：
- tools/delegate_tool.py
- agent/memory_manager.py on_delegation()
```

#### 2. [高优先级] Skills 自我学习系统
```
研究内容：
- Skills 文档自动生成机制
- agentskills.io 标准解析
- 从对话中提取技能的工作流
- Skills 版本管理与更新策略
- Skills 索引与检索

参考代码：
- agent/skill_commands.py
- hermes_cli/skills_hub.py
- optional-skills/*/SKILL.md
```

#### 3. [高优先级] Tool Call 解析器系统
```
研究内容：
- 不同模型的 tool_call 格式差异
- 12+ 种解析器的实现对比（hermes, mistral, qwen, deepseek_v3 等）
- 正则表达式 vs 结构化解析
- 解析失败的降级策略

参考代码：
- environments/tool_call_parsers/
- environments/hermes_base_env.py tool_parser
```

### 二、记忆系统研究

#### 4. [中优先级] Memory Provider 架构对比
```
研究内容：
- 内置 SQLite Memory vs 外部 Provider
- Mem0: LLM 事实提取 + 语义搜索 + Rerank
- Honcho: 跨会话用户建模 + 方言推理
- OpenViking: 文件系统式知识分层
- SuperMemory/Holographic/ByteRover: 替代方案

参考代码：
- agent/memory_provider.py
- agent/memory_manager.py
- plugins/memory/*/README.md
```

#### 5. [中优先级] 记忆压缩 vs 检索对比
```
研究内容：
- 压缩方案：丢失信息换取简洁上下文
- 检索方案：保持完整历史，按需检索
- 混合策略的可能性
- 两种方案对 Agent 行为的影响

参考：
- minimax-studydoc/*/compaction_vs_retrieval_analysis.md
```

### 三、RL 训练系统

#### 6. [高优先级] Atropos RL 训练环境
```
研究内容：
- HermesAgentBaseEnv 的两阶段架构
- Phase 1 (OpenAI) vs Phase 2 (VLLM) 的权衡
- Reward Function 设计模式
- ToolContext 验证机制
- SWE-bench / Terminal-Bench 2 评测

参考代码：
- environments/hermes_base_env.py
- environments/agent_loop.py
- environments/tool_context.py
```

#### 7. [中优先级] 训练数据生成与分析
```
研究内容：
- Trajectory 保存格式
- 轨迹压缩算法
- 成功/失败轨迹的模式分析
- 数据增强策略
```

### 四、工具系统

#### 8. [高优先级] 工具注册与分发架构
```
研究内容：
- 自注册模式 vs 显式导入
- AST 扫描实现
- 工具可用性检查 (check_fn)
- 插件系统扩展
- MCP 工具集成

参考代码：
- tools/registry.py
- model_tools.py
- tools/mcp_tool.py
```

#### 9. [中优先级] 终端后端实现对比
```
研究内容：
- Local / Docker / SSH / Modal / Daytona / Singularity
- 沙箱隔离策略
- 异步安全处理
- 资源清理机制

参考代码：
- tools/environments/*.py
```

#### 10. [中优先级] 浏览器自动化工具
```
研究内容：
- Browserbase 集成
- 多标签页管理
- 视觉分析集成
- iframe 处理
```

### 五、安全与可靠性

#### 11. [高优先级] 提示注入防护
```
研究内容：
- _CONTEXT_THREAT_PATTERNS 检测
- 危险命令拦截
- 工具结果大小限制
- 会话隔离

参考代码：
- agent/prompt_builder.py
- tools/approval.py
```

#### 12. [中优先级] Provider 降级与错误恢复
```
研究内容：
- 多 Provider 自动切换链
- 支付错误检测与降级
- 连接错误处理
- 模型回退策略

参考代码：
- agent/auxiliary_client.py
- run_agent.py 错误处理
```

### 六、Gateway 与多平台

#### 13. [高优先级] 消息平台 Gateway 架构
```
研究内容：
- Telegram / Discord / Slack / WhatsApp 等平台适配
- Slash 命令统一处理
- Webhook vs Long Polling
- 消息队列与限流

参考代码：
- gateway/run.py
- gateway/platforms/
```

#### 14. [中优先级] ACP (Agent Coding Protocol) 适配器
```
研究内容：
- VS Code / Zed / JetBrains 集成
- 协议设计与消息格式
- 会话状态同步

参考代码：
- acp_adapter/
```

### 七、成本优化

#### 15. [高优先级] Provider 缓存策略对比
```
研究内容：
- Anthropic: 90% 折扣
- DeepSeek: 90% 折扣
- Kimi K2.5: 75% 折扣
- Gemini: 不支持
- 最佳 Provider 选择策略

参考：
- hermes-agent.ai/blog/hermes-agent-token-overhead
```

#### 16. [中优先级] 固定开销优化
```
研究内容：
- 工具定义 Token 占比分析 (46%)
- 系统提示优化
- Skills 按需加载
- 平台特定工具集

参考：
- GitHub Issue #4379 - Token overhead analysis
```

### 八、新兴技术方向

#### 17. [探索性] 本地模型集成
```
研究内容：
- Ollama 集成
- vLLM 服务端点
- LM Studio 兼容性
- 本地模型的 Token 效率
```

#### 18. [探索性] 多模态工具链
```
研究内容：
- Vision 分析集成
- 图像生成工具
- 文档 OCR 处理
```

#### 19. [探索性] Thinking Mode 与推理优化
```
研究内容：
- 内置 Thinking 块处理
- reasoning_content 提取
- 推理与工具调用的时序
```

---

## 推荐研究顺序

### 短期（1-2 周）
1. Tool Call 解析器系统 - 实用价值高
2. Multi-Agent 委托系统 - 扩展能力
3. Skills 自我学习系统 - 差异化特性

### 中期（1 个月）
4. Atropos RL 训练环境 - ML 方向
5. Memory Provider 对比 - 理解记忆架构
6. Provider 缓存策略 - 成本优化

### 长期（持续）
7. Gateway 多平台架构 - 生态扩展
8. 安全防护系统 - 生产部署
9. 本地模型集成 - 隐私场景

---

## 已有的 Mini-Claw/OpenClaw 相关研究

| 题目 | 路径 |
|------|------|
| 架构分析 | minimax-studydoc/openclaw研究/_dev_doc_oc/architecture_analysis.md |
| Token 优化 | minimax-studydoc/openclaw研究/_dev_doc_oc/token_optimization_analysis.md |
| Compaction 算法 | minimax-studydoc/openclaw研究/_dev_doc_oc/compaction_algorithm_analysis.md |
| Compaction vs Retrieval | minimax-studydoc/openclaw研究/_dev_doc_oc/compaction_vs_retrieval_analysis.md |
| Agent Loop 状态机 | minimax-studydoc/openclaw研究/_dev_doc_oc/agent_loop_state_machine_analysis.md |
| Prompt 合成策略 | minimax-studydoc/openclaw研究/_dev_doc_oc/prompt_composition_strategy_analysis.md |
| Session Lock 机制 | minimax-studydoc/openclaw研究/_dev_doc_oc/session_lock_mechanism_analysis.md |
| SOUL 文件分析 | minimax-studydoc/openclaw研究/_dev_doc_oc/soul_file_analysis.md |
| LangGraph 复制 | minimax-studydoc/openclaw研究/_dev_doc_oc/langgraph_replication_analysis.md |
| 24×7 持久运行 | minimax-studydoc/openclaw研究/_dev_doc_qwen/24×7 持久运行日志审计与失败恢复策略研究.md |
| PI-MONO 简化架构 | minimax-studydoc/openclaw研究/_dev_doc_qwen/pi-mono 简化 OpenClaw 架构研究报告.md |
| 主动执行 vs 被动响应 | minimax-studydoc/openclaw研究/_dev_doc_qwen/主动执行 vs 被动响应系统模型研究.md |
