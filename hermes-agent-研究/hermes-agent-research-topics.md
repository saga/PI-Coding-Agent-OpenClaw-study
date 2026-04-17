# Hermes Agent 研究题目列表

**生成日期**: 2026-04-16  
**参考来源**: 已有研究报告（hermes-agent-研究/*.md）

---

## 一、核心架构研究

### 1.1 工具系统架构

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **自注册工具模式的实现细节** | 研究 tools/*.py 的自动发现和注册机制，AST 扫描如何工作 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **工具集（Toolset）组合与继承机制** | 研究 debuging/toolsets 如何继承和组合其他工具集 | ⭐⭐⭐⭐ | ⭐⭐ |
| **工具可用性检查（check_fn）的运行时实现** | 研究工具在运行时如何判断可用性（如 Docker 是否安装） | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| **并行工具执行的调度策略** | 研究哪些工具可以并行执行，路径冲突检测如何实现 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **工具结果大小限制与预算管理** | 研究 BudgetConfig 如何限制单个工具结果和单轮总计 | ⭐⭐⭐ | ⭐⭐ |

### 1.2 提示工程系统

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **多层系统提示组装机制** | 研究 identity + platform + environment + skills + memory 的组装顺序 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **SOUL.md/AGENTS.md/CLAUDE.md 的优先级和合并策略** | 研究项目上下文文件如何被读取和注入到系统提示 | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| **Skills 索引的动态生成与缓存** | 研究 skills catalog 如何从 Markdown 文件生成并注入到系统提示 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **平台特定提示的路由机制** | 研究 CLI/Telegram/Discord/WhatsApp 如何注入不同的平台提示 | ⭐⭐⭐⭐ | ⭐⭐⭐ |

### 1.3 LLM Provider 抽象层

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **多 Provider 自动路由与降级策略** | 研究 AUTO_PROVIDER_CHAIN 如何实现自动降级（支付错误 → 下一个） | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Anthropic 提示缓存的断点策略** | 研究 "system_and_3" 策略如何在 4 个位置设置 cache_control | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **OpenAI/Codex/Anthropic 消息格式的适配器模式** | 研究 auxiliary_client.py 如何统一不同 API 的格式 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Provider 解析与路由的优先级链** | 研究从环境变量到配置文件的 Provider 解析顺序 | ⭐⭐⭐⭐ | ⭐⭐⭐ |

---

## 二、记忆系统研究

### 2.1 内置记忆系统

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **冻结快照模式的完整实现** | 研究 _system_prompt_snapshot 如何在 session start 时捕获并保持不变 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **MEMORY.md + USER.md 的双存储设计** | 研究 Agent notes 和 User profile 的职责分离 | ⭐⭐⭐⭐⭐ | ⭐⭐ |
| **字符级别的容量管理与警告机制** | 研究 2200/1375 chars 限制如何强制保持记忆质量 | ⭐⭐⭐⭐⭐ | ⭐⭐ |
| **substring matching 的实现细节** | 研究 replace/remove 操作如何使用短子串匹配而非完整文本 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **文件锁的并发写入保护机制** | 研究 fcntl/mbvcrt 如何防止多进程冲突 | ⭐⭐⭐⭐ | ⭐⭐⭐ |

### 2.2 外部 Memory Provider

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **MemoryManager 的 Provider 编排机制** | 研究内置 + 外部 Provider 如何并行运行（不替换） | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **8 个外部 Provider 插件的实现对比** | 对比 Honcho/OpenViking/Mem0/Hindsight/Holographic/RetainDB/ByteRover/Supermemory | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **Provider 插件的动态加载与 is_available() 检查** | 研究插件如何在运行时判断依赖是否安装 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **hermes memory setup 的交互式配置流程** | 研究 CLI 如何引导用户配置外部 Provider | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| **自动迁移机制（旧版 Honcho → 新版 Plugin）** | 研究如何检测旧版配置并自动迁移 | ⭐⭐⭐⭐ | ⭐⭐⭐ |

### 2.3 Session Search

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **SQLite FTS5 全文索引的实现** | 研究 state.db 如何存储所有会话历史并支持全文搜索 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **LLM 摘要生成的触发条件与策略** | 研究何时触发 Gemini Flash 摘要生成 | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| **跨会话召回的查询优化** | 研究 session_search 如何排除当前 session 并召回相关历史 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Lineage tracking（跨压缩/恢复的父子关系）** | 研究 session 如何维护父子关系（压缩后） | ⭐⭐⭐ | ⭐⭐⭐⭐ |

---

## 三、上下文管理研究

### 3.1 上下文压缩

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **ContextCompressor 的五阶段算法** | 研究预裁剪 → 头部保护 → 尾部保护 → LLM 摘要 → 迭代更新 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **智能工具结果裁剪（99.3% → 98.9% 空间节省）** | 研究如何将工具输出压缩为 1 行摘要并保留关键信息 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **反抖动保护（<10% 节省率跳过压缩）** | 研究如何防止无效压缩循环 | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| **摘要生成的增量更新策略** | 研究如何复用前一次摘要进行增量更新 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Token 预算的尾部保护算法** | 研究如何从后向前计算 Token 预算并保留最近 ~20K tokens | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |

### 3.2 Token 消耗优化

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **Prompt Caching 的 84% 命中率实测分析** | 研究为什么 Hermes 能达到如此高的缓存命中率 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **平台特定工具集的懒加载策略** | 研究如何禁用不需要的工具以减少 ~1,300 tokens 开销 | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| **懒加载 Skills 的实现机制** | 研究技能文件如何按需加载而非一次性加载所有 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **DeepSeek 90% 缓存折扣的实际效果** | 研究使用 DeepSeek 相比 Claude Sonnet 的成本优势 | ⭐⭐⭐⭐ | ⭐⭐⭐ |

---

## 四、自进化系统研究

### 4.1 自进化技能系统

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **计数器监控机制（iters_since_skill）** | 研究工具调用迭代计数器如何递增和重置 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **后台审查线程的独立 Agent 实现** | 研究审查 Agent 如何使用相同的模型但更少的迭代 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **审查提示词的三种模式（memory/skill/combined）** | 研究不同审查场景使用不同的提示词 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **技能文件的 SKILL.md 结构与 frontmatter** | 研究技能文件的 YAML 元数据和支持文件结构 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **技能版本管理与更新策略** | 研究技能如何从 v1.0 渐进式进化到 v2.0 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |

### 4.2 主动保存机制

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **memory 工具的 WHEN TO SAVE 指导** | 研究系统提示如何训练 Agent 主动保存记忆 | ⭐⭐⭐⭐⭐ | ⭐⭐ |
| **skill_manage 工具的触发条件** | 研究何时触发技能审查（10 次迭代 + skill_manage 可用） | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **主动保存 vs 被动保存的用户体验对比** | 研究 Hermes 的主动保存机制如何减少用户提醒 | ⭐⭐⭐⭐ | ⭐⭐⭐ |

---

## 五、多平台与网关研究

### 5.1 网关-代理分离架构

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **Gateway 消息标准化（Telegram/Discord/Slack/WhatsApp）** | 研究不同平台的消息如何被标准化为统一格式 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **多平台共享状态的实现** | 研究用户在 Telegram 发消息后，Slack 能看到相同上下文 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **ACP（Agent Communication Protocol）标准接口** | 研究 VS Code/Cursor/JetBrains 如何通过 ACP 集成 Hermes | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Gateway bug（额外 5,000 tokens 开销）的修复分析** | 研究 Gateway 修复前后 Token 消耗的变化 | ⭐⭐⭐⭐ | ⭐⭐⭐ |

### 5.2 多终端后端抽象

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **6 种终端后端的统一接口（Local/Docker/SSH/Daytona/Singularity/Modal）** | 研究 tools/terminal 如何根据 backend 参数路由到不同后端 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **Docker 后端的容器生命周期管理** | 研究如何创建、复用和清理 Docker 容器 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **SSH 后端的连接池与复用策略** | 研究 SSH 连接如何被复用以减少开销 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |

---

## 六、RL 与训练研究

### 6.1 Atropos 集成

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **HermesAgentBaseEnv 的两阶段操作** | 研究 Phase 1（OpenAI Server）和 Phase 2（VLLM）的区别 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **Trajectory 导出的完整流程** | 研究如何导出 states/actions/rewards 用于 RL 训练 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **ToolContext 验证的沙箱实现** | 研究如何在 Agent 的沙箱中运行 pytest 验证 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **奖励计算的自定义策略** | 研究如何根据任务完成情况计算奖励分数 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |

---

## 七、安全与可靠性研究

### 7.1 安全机制

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **提示注入检测的正则表达式模式** | 研究 _CONTEXT_THREAT_PATTERNS 如何检测 ignore instructions 等攻击 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **危险命令检测（rm/rmdir/sed -i）** | 研究 _DESTRUCTIVE_PATTERNS 如何拦截危险命令 | ⭐⭐⭐⭐⭐ | ⭐⭐ |
| **工具结果大小限制（15000/50000/2000）** | 研究 BudgetConfig 如何防止工具结果过大 | ⭐⭐⭐⭐ | ⭐⭐ |
| **memory 工具的安全扫描（injection/exfiltration）** | 研究写入前如何扫描不可见 Unicode 字符等攻击 | ⭐⭐⭐⭐ | ⭐⭐⭐ |

### 7.2 错误处理与重试

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **FailoverReason 枚举与分类** | 研究 RATE_LIMIT/CONTEXT_OVERFLOW/MODEL_NOT_FOUND 等错误分类 | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| **API 调用的自动重试策略** | 研究不同错误类型的重试次数和退避策略 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **上下文溢出时的自动压缩触发** | 研究 CONTEXT_OVERFLOW 如何触发 ContextCompressor | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |

---

## 八、配置与扩展研究

### 8.1 配置系统

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **CLI 配置文件的加载与合并策略** | 研究 cli-config.yaml 如何与全局配置合并 | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| **环境变量与配置文件的优先级** | 研究 API key 从环境变量还是配置文件读取 | ⭐⭐⭐⭐ | ⭐⭐ |
| **hermes config get/set 命令的实现** | 研究 CLI 如何读写配置文件 | ⭐⭐⭐⭐ | ⭐⭐⭐ |

### 8.2 插件系统

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **Memory Provider 插件的动态加载机制** | 研究 plugins/memory/*.py 如何被动态导入 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **MCP 工具的集成与注册** | 研究外部 MCP 工具如何注册到 ToolRegistry | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **外部技能目录（external_dirs）的只读加载** | 研究如何从外部目录加载技能但不允许修改 | ⭐⭐⭐⭐ | ⭐⭐⭐ |

---

## 九、性能与优化研究

### 9.1 缓存策略

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **Prefix Cache 稳定性（冻结快照模式）** | 研究系统提示前缀如何保持稳定以提高缓存命中率 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **LLM 摘要的缓存复用** | 研究压缩摘要如何在后续压缩中复用 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **工具结果摘要的缓存** | 研究工具输出摘要如何避免重复生成 | ⭐⭐⭐⭐ | ⭐⭐⭐ |

### 9.2 并发与异步

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **后台审查线程的非阻塞实现** | 研究审查 Agent 如何在后台运行而不阻塞主任务 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **并行工具执行的调度器** | 研究哪些工具可以并行执行以及路径冲突检测 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **文件锁的跨平台实现（fcntl vs msvcrt）** | 研究 Unix 和 Windows 如何实现文件锁 | ⭐⭐⭐⭐ | ⭐⭐⭐ |

---

## 十、未充分研究的领域（高潜力）

### 10.1 新兴研究方向

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **Cron 调度器的独立会话实现** | 研究定时任务如何在独立会话中运行（不继承之前上下文） | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Agent 自我评估与反思机制** | 研究 Agent 如何在任务完成后评估自己的表现 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **多轮对话中的主动提问策略** | 研究 Agent 如何在信息不足时主动向用户提问 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **技能的自动版本控制与回滚** | 研究技能如何版本化并在效果差时回滚到旧版本 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **工具调用的预算动态调整** | 研究如何根据任务复杂度动态调整 max_iterations | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |

### 10.2 与 pi-coding-agent 的集成点

| 题目 | 研究内容 | 重要性 | 难度 |
|------|---------|--------|------|
| **自进化技能系统在 pi-coding-agent 的实现方案** | 基于 hermes-agent 的实现，在 pi-coding-agent SDK 中实现相同功能 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **Context Compression 在 pi-coding-agent 的集成** | 借鉴 Hermes 的 ContextEngine 架构，在 pi-coding-agent 中实现 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Memory Provider 插件化架构在 pi-coding-agent 的实现** | 实现类似 MemoryManager 的插件化记忆系统 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **工具注册系统的 SDK 集成方案** | 研究如何在 pi-coding-agent SDK 中实现自注册工具模式 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **网关-代理分离架构在 pi-coding-agent 的应用** | 研究如何在 pi-coding-agent 中实现多平台统一接口 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |

---

## 十一、研究优先级建议

### 11.1 高优先级（核心功能）

1. **冻结快照模式的完整实现** - 最核心的创新点
2. **自进化技能系统** - 最值得借鉴的功能
3. **Context Compression 五阶段算法** - 性能优化关键
4. **Prompt Caching 的 84% 命中率分析** - 成本优化核心
5. **自注册工具模式** - 工具系统基础

### 11.2 中优先级（重要增强）

1. **Memory Provider 插件化架构**
2. **网关-代理分离架构**
3. **多终端后端抽象**
4. **ACP 标准接口**
5. **Session Search 的 FTS5 实现**

### 11.3 低优先级（高级功能）

1. **RL/Atropos 集成**
2. **Cron 调度器**
3. **工具并行执行调度**
4. **后台审查线程**
5. **技能版本控制**

---

## 十二、研究方法建议

### 12.1 代码分析

1. **阅读核心源码文件**（run_agent.py, memory_tool.py, context_engine.py）
2. **追踪关键调用链**（从 CLI 入口到核心逻辑）
3. **分析设计模式**（策略模式、工厂模式、观察者模式）

### 12.2 实验验证

1. **构建最小复现**（简化版 Hermes Agent）
2. **测量性能指标**（Token 消耗、响应时间、缓存命中率）
3. **对比实验**（有/无冻结快照、有/无压缩）

### 12.3 文档研究

1. **官方文档**（hermes-agent.nousresearch.com/docs）
2. **GitHub Issues**（搜索关键词：context compression, memory, skills）
3. **社区讨论**（HuggingFace, Discord, Twitter）

---

## 十三、参考资料索引

### 13.1 已有研究报告

- hermes-agent-研究/hermes-agent-design-patterns.md
- hermes-agent-研究/hermes-agent-self-evolving-skills.md
- hermes-agent-研究/context-compression-implementation-report.md
- hermes-agent-研究/token-consumption-analysis-report.md
- hermes-agent-研究/hermes-agent-memory-provider-default-configuration.md
- hermes-agent-研究/hermes-agent-frozen-snapshot-explained.md
- hermes-agent-研究/hermes-agent-memory-research.md
- hermes-agent-研究/hermes-agent-analysis-report.md

### 13.2 官方文档

- [Hermes Agent Docs](https://hermes-agent.nousresearch.com/docs)
- [Memory Providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers.md)
- [Context Compression](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)
- [Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills.md)

### 13.3 源码仓库

- [hermes-agent GitHub](https://github.com/NousResearch/hermes-agent)
- [hermes-agent-source-code/](file:///Users/saga/code-repos/PI-Coding-Agent-OpenClaw-study/hermes-agent-source-code/)

---

**文档生成日期**: 2026-04-16  
**研究团队**: PI-Coding-Agent-OpenClaw-study
