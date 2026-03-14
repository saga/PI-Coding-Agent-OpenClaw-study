# 金融 Research Platform 建设方案

**适用场景：** 中大型资产管理公司，equity research 为核心业务，数据来源包括内部数据和外部 market data，现有数据基础设施以 on-prem SQL Server 为主，管理层期望向云端迁移。

**文档性质：** 架构设计研究报告，从 business overview 到工程落地方案。

---

## 一、为什么要建这个平台

### 1.1 现状的核心问题

大多数传统资产管理公司的 research 数据基础设施，都面临同一组问题：

**数据孤岛严重。** 内部数据（持仓、交易、历史研究）在 on-prem SQL Server 里，外部 market data（FactSet、Bloomberg、S&P、Morningstar 等）分散在各自的终端或 FTP 落地文件里，分析师每天要在多个系统之间手工复制数据，效率极低，出错率高。

**数据新鲜度不足。** On-prem 架构的数据更新通常是批处理，T+1 甚至更慢。季报发布后，分析师需要等待数据入库才能开始建模，错过最佳发布窗口。

**扩展性受限。** 每次新增一个 market data 供应商，都需要 IT 介入，开发新的数据接入管道，周期长、成本高。

**AI 能力无法落地。** 现代 AI agent 需要统一的数据访问层。分散的数据孤岛让 AI 无法有效工作，或者只能依赖 LLM 的训练数据（存在时效性风险）。

**合规和审计困难。** 每个数字从哪来、经过了哪些变换、谁在什么时候用了它——这些问题在现有架构下很难回答，但监管机构越来越关注这些。

### 1.2 目标状态

建设完成后，平台应该能回答：

- 分析师需要一个数字，能在 30 秒内从统一入口拿到，来源可信，时效性有保障
- AI agent 生成的报告里每一个数字，都能追溯到原始数据源
- 新增一个 market data 供应商，接入时间从数周缩短到数天
- 合规审计时，能自动生成完整的数据使用报告

---

## 二、平台整体架构

### 2.1 架构分层

```
┌─────────────────────────────────────────────────────────────────┐
│                        消费层 (Consumption Layer)                │
│   分析师工作台  │  AI Research Agent  │  BI/报表  │  API 对外    │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                      数据产品层 (Data Product Layer)              │
│   Equity Research DB  │  Market Data DB  │  Risk & Portfolio DB  │
│         (Snowflake PRODUCT schema)                               │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                      数据加工层 (Transformation Layer)            │
│              dbt (RAW → CURATED → PRODUCT)                       │
│         数据质量检查  │  业务逻辑  │  指标计算                    │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                      数据摄取层 (Ingestion Layer)                 │
│  内部数据管道          │  外部 Market Data 管道                   │
│  On-prem SQL Server    │  FactSet / Bloomberg / S&P / Morningstar │
│  → Fivetran/DMS → S3  │  → MCP / API / FTP → S3                 │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                      原始数据层 (Raw Storage)                     │
│              Snowflake RAW schema  +  S3 Data Lake               │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                      治理层 (Governance Layer)                    │
│         数据血缘  │  访问控制  │  数据目录  │  审计日志            │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心设计原则

**单一数据真相（Single Source of Truth）**
所有数据最终汇聚到 Snowflake，任何消费方都从 Snowflake 读取，不允许绕过平台直接访问原始系统。

**数据分层（Medallion Architecture）**
RAW → CURATED → PRODUCT 三层，每层有明确的职责边界。RAW 层是原始数据的忠实镜像，CURATED 层做清洗和标准化，PRODUCT 层面向具体业务场景。

**数据可追溯（Data Lineage First）**
每一个数据点从进入平台开始，就记录其来源、变换路径和消费记录。这不是事后补充的功能，而是架构的核心约束。

**AI-Ready**
平台的数据结构和 API 设计，从一开始就考虑 AI agent 的消费方式，包括结构化数据访问、实时查询能力和引用追踪机制。

---

## 三、数据摄取层详细设计

### 3.1 内部数据迁移：On-Prem SQL Server → Snowflake

这是迁移工程的核心，也是风险最高的环节。

**推荐方案：Fivetran（托管 ELT）**

对于 on-prem SQL Server 到 Snowflake 的迁移，Fivetran 是最稳妥的选择，原因如下：

- SQL Server + Snowflake 是 Fivetran 最成熟的连接器组合，有大量生产案例
- CDC（Change Data Capture）基于 SQL Server transaction log，不影响生产库性能
- 全量加载和增量同步的切换由 Fivetran 自动管理，不需要手工操作
- 出问题有 Fivetran 官方支持，不依赖内部团队排查

**迁移分阶段执行：**

第一阶段（第 1-2 周）：选 1-2 张核心表，跑通全量同步到 Snowflake RAW 层，验证数据完整性和格式。

第二阶段（第 3-4 周）：在这些表上开启 CDC，验证增量变更正确落入 Snowflake，延迟满足业务要求。

第三阶段（第 5-8 周）：扩展到全部目标表，按业务优先级排序，高频使用的表优先迁移。

第四阶段（第 9-12 周）：建设 CURATED 和 PRODUCT 层，开放消费者访问，逐步替代对 on-prem 的直接访问。

**关键注意事项：**

SQL Server 需要开启 MS-CDC，这会让 transaction log 保留更长时间，需要监控磁盘空间。初始全量加载期间，建议在业务低峰时段运行，并提前和业务方沟通数据可用性。

**S3 作为中间层（可选但推荐）**

即使使用 Fivetran，也建议在 S3 保留一份原始数据副本，作为：
- 合规备份（金融监管通常要求数据保留 5-7 年）
- 重跑缓冲（Snowflake 出问题时可以从 S3 重新加载）
- 未来其他消费方的接入点（如 Spark 分析、ML 训练）

### 3.2 外部 Market Data 接入

这是平台持续扩展的核心能力，也是区别于传统架构的关键。

**现有 MCP 生态的价值**

现代金融数据供应商（FactSet、S&P Global、Morningstar、Daloopa、LSEG 等）都在快速推进 MCP（Model Context Protocol）接口，这意味着：

- AI agent 可以直接通过标准化接口查询这些数据源
- 不需要为每个供应商开发独立的数据管道
- 数据可以按需实时获取，而不是批量同步

**两种接入模式并存：**

模式 A：实时 MCP 查询（适合 AI agent 工作流）
分析师或 AI agent 在生成报告时，通过 MCP 接口实时查询 FactSet、S&P 等数据源，结果直接用于报告生成，同时记录引用信息。这种模式延迟最低，数据最新鲜，但依赖外部服务可用性。

模式 B：批量同步到 Snowflake（适合历史分析和模型训练）
通过 API 或 FTP 将 market data 批量同步到 Snowflake，建立历史数据库。这种模式支持复杂的历史分析和跨数据源关联查询，但有一定延迟。

**推荐策略：两种模式结合**

- 实时行情、最新财报、分析师预期：MCP 实时查询
- 历史价格、历史财务数据、行业数据：批量同步到 Snowflake
- 新增供应商时：优先评估是否有 MCP 接口，有则优先用 MCP，无则建批量管道

**新增供应商的标准化流程：**

每次新增 market data 供应商，按以下步骤执行：
1. 评估数据格式和接口类型（MCP / REST API / FTP / 数据库直连）
2. 在 Snowflake RAW 层创建对应的 schema 和表结构
3. 建立数据摄取管道（Fivetran connector 或自定义 pipeline）
4. 在 dbt 中建立 CURATED 层的标准化转换
5. 更新数据目录，注册新的数据资产
6. 通知消费方新数据可用

---

## 四、数据加工层：dbt 转换设计

### 4.1 三层架构详细说明

**RAW 层（原始镜像）**

- 1:1 映射源系统的表结构，不做任何业务逻辑转换
- 保留所有历史版本，包括 CDC 的 UPDATE/DELETE 记录
- 命名规范：`RAW_DB.{source_system}.{table_name}`
- 例：`RAW_DB.SQL_SERVER.EARNINGS_ACTUALS`、`RAW_DB.FACTSET.CONSENSUS_ESTIMATES`

**CURATED 层（清洗标准化）**

- 处理 CDC 的 upsert 逻辑，合并成当前最新状态
- 数据类型标准化（日期格式、货币单位、ticker 格式统一）
- 去重、空值处理、异常值标记
- 跨数据源的 entity resolution（同一家公司在不同数据源的 ID 映射）
- 命名规范：`CURATED_DB.RESEARCH.{entity_name}`

**PRODUCT 层（业务数据产品）**

面向具体消费场景的宽表，每个数据产品有明确的 owner 和 SLA：

| 数据产品 | 内容 | 主要消费方 | 更新频率 |
|---------|------|-----------|---------|
| `EQUITY_COVERAGE_UNIVERSE` | 覆盖股票的基本信息、评级、价格目标 | 分析师、AI agent | 实时 |
| `EARNINGS_ACTUALS_HISTORY` | 历史财报数据，标准化格式 | 建模、AI agent | 季度 |
| `CONSENSUS_ESTIMATES` | 分析师预期，多数据源聚合 | 分析师、AI agent | 日内 |
| `FINANCIAL_MODEL_INPUTS` | 财务建模所需的标准化输入 | Excel 模型、AI agent | 日内 |
| `MARKET_DATA_DAILY` | 日度行情、估值指标 | BI、AI agent | 日度 |
| `RESEARCH_REPORTS_REGISTRY` | 已发布研究报告的元数据 | 合规、知识管理 | 实时 |

### 4.2 数据质量框架

dbt 内置的测试框架用于保障数据质量：

- **唯一性测试**：主键不重复
- **非空测试**：关键字段不为空
- **引用完整性**：外键关系正确
- **业务规则测试**：如 EPS 不能为负（除非亏损），价格目标必须为正数
- **时效性测试**：数据更新时间不超过 SLA 阈值

数据质量问题自动触发告警，通知数据 owner 处理，不静默失败。

---

## 五、AI Research Agent 集成

### 5.1 Agent 架构

```
分析师请求
    ↓
AI Research Agent（LLM + Skills）
    ↓
数据访问层（统一接口）
    ├── Snowflake 查询（内部数据 + 历史 market data）
    ├── MCP 实时查询（FactSet、S&P、Morningstar 等）
    └── SEC EDGAR（公开文件）
    ↓
引用追踪层（Citation Context）
    ↓
报告生成（DOCX / XLSX / 图表）
    ↓
引用注入（每个数字附来源）
    ↓
血缘回写（数据目录更新）
```

### 5.2 Skills 体系

基于 Agent Skills 标准，平台内置以下 skill 集合：

**Equity Research Skills**
- `earnings-analysis`：季报更新报告（8-12 页，24-48 小时内发布）
- `initiating-coverage`：首次覆盖报告（30-50 页，5 步骤工作流）
- `earnings-preview`：季报前情景分析
- `morning-note`：每日晨报（7am 前就绪）
- `sector-overview`：行业全景报告
- `thesis-tracker`：投资逻辑维护和更新
- `idea-generation`：系统化选股和投资想法生成
- `catalyst-calendar`：催化剂事件追踪

**Financial Modeling Skills**
- `dcf-model`：DCF 估值模型（含敏感性分析）
- `comps-analysis`：可比公司分析
- `3-statement-model`：三表联动财务模型
- `lbo-model`：杠杆收购模型
- `audit-xls`：Excel 模型审计

**数据源优先级（所有 skill 遵循）**
1. Snowflake PRODUCT 层（内部标准化数据，最可信）
2. MCP 机构数据源（FactSet、S&P、Daloopa 等，实时）
3. SEC EDGAR（官方文件，权威但有延迟）
4. 公司 IR 页面、财报电话会议记录
5. Web search（仅作降级，不用于机构级报告的核心数字）

### 5.3 引用追踪机制

这是平台合规能力的核心。每次 agent 从任何数据源取数，都生成一条引用记录：

```
引用记录包含：
- 唯一运行 ID（报告级别）
- 时间戳（UTC）
- 数据源类型（Snowflake / MCP / SEC / Web）
- 具体来源（表名 / API endpoint / 文件 URL）
- 查询内容（SQL / API 参数）
- 对应报告字段名
- 实际取到的值
```

所有引用记录汇聚成报告级别的 manifest 文件，同时：
- 在报告输出中以脚注形式呈现（每个数字有来源标注）
- 在 Excel 模型中以单元格 comment 形式嵌入
- 回写到数据目录，形成完整的数据血缘图

### 5.4 Hallucination 防护

金融报告中的数字错误有法律风险，必须有系统性防护：

- **强制实时查询**：所有财务数字必须从数据源实时获取，禁止使用 LLM 训练数据中的数字
- **日期验证**：每次查询前检查数据时效性，超过 3 个月的数据必须重新获取
- **交叉验证**：关键数字（EPS、Revenue、价格目标）在多个数据源之间交叉验证
- **人工审核节点**：价格目标和评级变更在发布前必须有分析师确认步骤
- **来源强制标注**：没有来源的数字不允许出现在最终报告中

---

## 六、数据治理与合规

### 6.1 访问控制

Snowflake 的 RBAC 体系按以下角色设计：

| 角色 | 权限范围 | 典型用户 |
|------|---------|---------|
| `RESEARCH_ANALYST` | PRODUCT 层读取 | 分析师 |
| `RESEARCH_SENIOR` | PRODUCT + CURATED 层读取 | 高级分析师、PM |
| `DATA_ENGINEER` | RAW + CURATED 层读写 | 数据工程师 |
| `PLATFORM_ADMIN` | 全部权限 | 平台管理员 |
| `AI_AGENT` | PRODUCT 层读取 + 引用写入 | AI agent 服务账号 |
| `COMPLIANCE` | 全部只读 + 审计日志 | 合规团队 |

敏感数据（客户信息、交易对手、内部评级）在 CURATED 层做列级脱敏，PRODUCT 层只暴露脱敏后的数据。

### 6.2 审计日志

Snowflake 原生的 Query History 和 Access History 记录所有数据访问行为：
- 谁在什么时候查询了什么数据
- 查询了哪些列（Enterprise 版本支持列级追踪）
- 查询结果是否被导出

这些日志保留 90 天（Snowflake 默认），建议同步到 S3 长期存储，满足金融监管的数据保留要求。

### 6.3 数据目录

建议使用数据目录工具（Collibra、Alation 或 Snowflake 原生的 Horizon）管理：
- 数据资产注册（每张表、每个字段的业务含义）
- 数据血缘可视化（从原始数据到报告的完整路径）
- 数据质量指标（新鲜度、完整性、准确性）
- 数据 owner 和 SLA 管理

---

## 七、基础设施与运维

### 7.1 Snowflake 配置建议

**计算资源**
- 分析师查询：Medium 仓库（按需启动，15 分钟自动挂起）
- dbt 转换：Large 仓库（调度时段运行）
- AI agent：Small 仓库（高并发，多个 agent 同时运行）
- 报表 / BI：Medium 仓库（独立，避免影响分析师查询）

**存储优化**
- RAW 层：Time Travel 7 天（数据量大，成本控制）
- CURATED 层：Time Travel 14 天
- PRODUCT 层：Time Travel 30 天（业务数据，需要更长的回溯能力）
- 按 ticker 和日期建立 clustering key，提升查询性能

**成本控制**
- Resource Monitor 设置月度预算上限，超限自动告警
- 定期审查仓库使用情况，识别低效查询
- 历史数据按访问频率分层存储（热数据 / 冷数据）

### 7.2 监控告警体系

以下监控项必须在上线前配置：

| 监控项 | 工具 | 告警阈值 |
|-------|------|---------|
| 数据摄取延迟 | Fivetran + CloudWatch | 超过 SLA 30 分钟 |
| dbt 转换失败 | dbt Cloud 告警 | 任何失败立即通知 |
| 数据质量测试失败 | dbt + PagerDuty | 关键表失败立即通知 |
| Snowflake 仓库挂起 | Snowflake Resource Monitor | 超过预算 80% 告警 |
| MCP 服务不可用 | 自定义健康检查 | 连续 3 次失败告警 |
| AI agent 引用追踪失败 | 应用日志 | 任何失败记录，批量告警 |

### 7.3 灾备和业务连续性

- Snowflake 原生多可用区，单区故障自动切换
- S3 数据湖作为 Snowflake 的备份，极端情况下可以重新加载
- 关键 dbt 模型的增量逻辑设计为幂等，失败后可以安全重跑
- MCP 服务降级策略：主服务不可用时自动切换到备用数据源或缓存数据

---

## 八、迁移路线图

### Phase 1：基础设施建设（第 1-3 个月）

**目标：** 跑通核心数据管道，内部数据上 Snowflake

- 第 1-2 周：Snowflake 账号配置，RBAC 设计，网络连接（VPN / PrivateLink）
- 第 3-4 周：Fivetran 配置，选核心表做全量迁移验证
- 第 5-6 周：开启 CDC，验证增量同步
- 第 7-8 周：扩展到全部目标表
- 第 9-12 周：dbt RAW → CURATED 层建设，数据质量测试

**验收标准：** 内部数据在 Snowflake 可查，延迟满足 T+1 要求，数据质量测试通过率 >99%

### Phase 2：Market Data 接入（第 3-6 个月）

**目标：** 主要外部数据源接入 Snowflake，MCP 实时查询可用

- 第 1-4 周：优先级最高的 2-3 个 market data 供应商批量同步接入
- 第 5-8 周：MCP 接口配置和测试（FactSet、S&P、Morningstar）
- 第 9-12 周：PRODUCT 层数据产品建设，开放分析师访问

**验收标准：** 分析师可以从 Snowflake 获取所需的 80% 数据，MCP 实时查询可用

### Phase 3：AI Agent 上线（第 6-9 个月）

**目标：** AI agent 可以生成带引用的专业研究报告

- 第 1-4 周：Agent 数据访问层开发，引用追踪机制实现
- 第 5-8 周：核心 skill 集成测试（earnings-analysis、dcf-model、comps-analysis）
- 第 9-12 周：分析师试用，收集反馈，迭代优化

**验收标准：** AI agent 生成的报告每个数字有来源，分析师满意度 >70%

### Phase 4：平台成熟（第 9-18 个月）

**目标：** 平台成为 research 工作流的核心基础设施

- 数据目录完善，所有数据资产有 owner 和 SLA
- 完整的数据血缘图，从原始数据到报告全链路可追溯
- 新增 market data 供应商的标准化接入流程 <1 周
- 合规审计报告自动生成

---

## 九、关键风险与应对

**风险 1：迁移期间数据双写**
迁移过程中，on-prem 和 Snowflake 同时存在，分析师可能从两个地方取数，导致数据不一致。
应对：明确切换时间表，每张表迁移完成后立即停止对 on-prem 的直接访问，强制走 Snowflake。

**风险 2：Market data 供应商合同限制**
部分 market data 合同限制数据存储在第三方云平台。
应对：迁移前逐一审查合同条款，必要时重新谈判或选择合规的存储方式（如 Snowflake 私有部署）。

**风险 3：分析师抵触新工具**
分析师习惯了现有工作流，对新平台有抵触情绪。
应对：早期让核心分析师参与设计，优先解决他们最痛的问题，用结果说话而不是强制推行。

**风险 4：AI agent 数据错误的法律风险**
AI 生成的报告如果包含错误数字，可能引发法律责任。
应对：强制人工审核节点，明确标注 AI 辅助生成，建立错误追踪和纠正机制。

**风险 5：Snowflake 成本超预期**
T 级别数据加上 AI agent 的高频查询，Snowflake 成本可能超出预算。
应对：从第一天就设置 Resource Monitor，定期审查查询效率，对高成本查询做优化。

---

## 十、成功指标

| 指标 | 基线（迁移前） | 目标（18 个月后） |
|------|-------------|----------------|
| 季报更新报告发布时间 | 48-72 小时 | <24 小时 |
| 数据获取时间（分析师） | 30-60 分钟/报告 | <5 分钟/报告 |
| 新增 market data 供应商接入时间 | 4-8 周 | <1 周 |
| 数据来源可追溯率 | <20% | >95% |
| 分析师工具满意度 | 基线调研 | 提升 30% |
| 合规审计准备时间 | 数天 | <4 小时（自动生成） |
