# AWS RDS SQL Server → Snowflake 数据产品方案

**场景：** 金融 Research 数据（T级别），从 AWS RDS SQL Server 同步到企业 Snowflake，供内部消费者生成报表和分析使用。

**推荐方案：** AWS DMS (CDC模式) + S3 Landing Zone + Snowpipe

---

## 一、为什么选这个方案

T级别的金融数据，核心诉求是：不影响生产库性能、数据一致性有保障、运维成本可控。

AWS DMS 的 CDC（Change Data Capture）模式直接读取 SQL Server 的 transaction log，不对业务查询产生额外压力。S3 作为中间层天然解耦了生产端和消费端，Snowpipe 则让数据准实时落入 Snowflake，整条链路全托管，没有自建组件需要维护。

---

## 二、整体架构

```
AWS RDS SQL Server (生产库)
        ↓  transaction log (CDC)
   AWS DMS Replication Instance
        ↓  Parquet / CSV
   S3 Landing Zone (staging bucket)
        ↓  S3 Event Notification
   Snowpipe (自动摄取)
        ↓
   Snowflake RAW 层
        ↓  dbt / Snowflake Tasks
   Snowflake CURATED / PRODUCT 层
        ↓
   消费端（报表 / BI / 分析师）
```

---

## 三、各环节详细说明

### 3.1 AWS DMS 配置要点

**初始全量加载（Full Load）**

第一次需要把存量 T 级别数据全部迁移到 S3。DMS 支持并行表加载，可以按 schema 或表分批执行，避免单次任务过大。全量期间建议在业务低峰时段运行，并监控 RDS 的 CPU 和 IOPS。

**切换 CDC 增量模式**

全量完成后，DMS 切换到 CDC 模式，持续捕获 INSERT / UPDATE / DELETE 操作。SQL Server 需要开启 MS-CDC（Microsoft Change Data Capture），这是 DMS CDC 的前提条件。AWS RDS 上可以通过存储过程直接开启，不需要修改实例配置。

**Replication Instance 选型**

T 级别数据建议选 r5 系列（内存优化型），给 DMS 足够的缓冲内存处理 transaction log。网络上，DMS Replication Instance 和 RDS 实例应在同一 VPC，减少延迟和数据传输费用。

**目标端格式**

写入 S3 推荐用 Parquet 格式，压缩比高，Snowflake 读取效率好。按日期和表名分区存储，便于后续管理和重跑。

---

### 3.2 S3 Landing Zone 设计

S3 不只是临时中转，它同时承担以下角色：

- 原始数据备份（可保留 30-90 天，满足金融合规要求）
- 重跑缓冲（Snowpipe 失败时可以重新触发摄取）
- 多消费方接入点（除 Snowflake 外，未来可以接 EMR、Athena 等）

目录结构建议按 `s3://bucket/source=rds-sqlserver/schema=research/table=xxx/dt=YYYY-MM-DD/` 组织，方便按时间范围管理生命周期策略。

敏感字段（如客户信息、交易对手）建议在 DMS 的 transformation rule 里做脱敏或 mask，在数据离开 RDS 之前就处理掉，不要把脱敏工作留到 Snowflake 侧。

---

### 3.3 Snowpipe 自动摄取

Snowpipe 通过监听 S3 的 SQS 事件通知，在新文件到达时自动触发摄取，延迟通常在 1-3 分钟以内。对于金融 research 数据（日内几次刷新或 T+1），这个延迟完全满足需求。

Snowpipe 写入的是 Snowflake 的 RAW 层，保持和 S3 文件结构一致，不做任何业务逻辑转换。这样 RAW 层始终是原始数据的忠实镜像，出问题时可以从这里重新加工。

---

### 3.4 Snowflake 分层设计

金融 research 场景建议三层架构：

**RAW 层**
DMS + Snowpipe 直接写入，1:1 映射 SQL Server 的表结构。这层只做摄取，不做任何业务逻辑。保留所有历史版本（包括 CDC 的 UPDATE/DELETE 记录）。

**CURATED 层**
对 RAW 层做清洗、标准化、去重。处理 CDC 的 upsert 逻辑（把 INSERT/UPDATE/DELETE 合并成当前最新状态）。这层是分析师和 BI 工具的主要数据来源。可以用 dbt 或 Snowflake Tasks 驱动转换。

**PRODUCT 层（Data Product）**
面向具体消费场景的宽表或聚合表。比如 equity research 的标准财务指标表、行业对比表等。这层对外暴露，通过 Snowflake 的 RBAC 控制不同消费者的访问权限。

---

### 3.5 权限与数据共享

Snowflake 内部消费者（报表团队、分析师）通过 RBAC 角色授权，按 schema 或表粒度控制访问。

如果需要跨 Snowflake account 共享（比如给外部合作方），可以用 Snowflake Secure Data Sharing，数据不需要复制，直接授权读取，成本和安全性都更优。

---

## 四、关键风险和注意事项

**SQL Server MS-CDC 对 transaction log 的影响**
CDC 会让 transaction log 保留更长时间（直到 CDC 读取完毕才能截断）。需要监控 RDS 的存储空间，适当调大 log retention 配置，避免磁盘告警。

**DMS 任务中断恢复**
DMS CDC 任务中断后，可以从上次的 checkpoint 续跑，不会丢数据。但如果中断时间过长，SQL Server 的 transaction log 可能已经被截断，这时需要重新做一次全量加载。建议配置 CloudWatch 告警，DMS 任务异常时立即通知。

**T 级别初始全量的时间窗口**
T 级别数据的全量加载可能需要数天。需要提前规划好时间窗口，并和业务方沟通好在全量期间数据的可用性。全量完成后切 CDC 的那个时间点，是数据一致性最关键的节点，需要验证。

**Snowflake 存储成本**
T 级别数据进 Snowflake 后，注意合理设置 Time Travel 保留天数（默认 90 天会显著增加存储成本），以及 Fail-safe 的成本。RAW 层可以设置较短的 Time Travel（7 天），PRODUCT 层按需设置。

**金融合规**
S3 和 Snowflake 都需要开启加密（S3 SSE-KMS，Snowflake Tri-Secret Secure 或默认加密）。访问日志需要保留，Snowflake 的 Query History 和 Access History 是审计的重要依据。

---

## 五、方案对比（为什么不选其他方案）

| 方案 | 优点 | 不选的原因 |
|------|------|-----------|
| AWS DMS + S3 + Snowpipe（推荐） | 全托管、成本可控、S3解耦 | — |
| Fivetran | 开箱即用、维护成本最低 | T级别数据按MAR计费，成本较高 |
| Debezium + Kafka | 秒级延迟 | 架构复杂，research数据不需要秒级 |
| 定时全量导出 | 实现简单 | T级别数据全量导出时间窗口太长，且对RDS压力大 |



---

## 附录：工程落地建议

核心原则：把复杂度转移给托管服务和专业厂商，让内部团队只负责他们能做好的部分。

### A.1 用 Fivetran 替换 DMS 这段

DMS 的 CDC 配置有一定门槛——MS-CDC 开启、Replication Instance 调优、任务中断恢复、checkpoint 管理，对经验不足的团队来说每一步都是潜在的坑。Fivetran 把这些全部封装掉，连接器配置完即可运行，出问题有 Fivetran 官方支持。

费用比 DMS 高，但如果算上团队踩坑的时间成本和风险，Fivetran 往往更划算。T 级别数据的 Fivetran 费用可以在方案评审时单独做一次 ROI 测算。

### A.2 Snowflake 侧用 dbt Cloud 替代自建 Tasks

RAW → CURATED → PRODUCT 的转换逻辑，如果让团队自己写 Snowflake Tasks 和 Stored Procedure，很容易出现逻辑错误且难以排查。dbt Cloud 提供 UI 调度、数据测试框架、自动文档生成，弱团队上手快，出错时也有清晰的错误日志可以追踪。

### A.3 关键节点引入 AWS PS 或 Snowflake PS 陪跑

初始全量加载、CDC 切换、Snowflake 分层设计这几个节点是最容易出问题的地方。花钱请 AWS Professional Services 或 Snowflake Professional Services 陪跑第一次，内部团队跟着学，比自己摸索快得多，也稳得多。PS 团队会留下文档和 runbook，后续维护有据可查。

### A.4 分阶段落地，每阶段有明确验收标准

不要一次性上全套。建议按以下顺序推进：

- 第一阶段：选一张核心表，跑通 S3 → Snowpipe → RAW 层的全量同步，验证数据完整性
- 第二阶段：在这张表上开启 CDC，验证增量变更正确落入 Snowflake
- 第三阶段：扩展到全部目标表
- 第四阶段：建设 CURATED 和 PRODUCT 层，开放消费者访问

每个阶段稳定后再进入下一阶段，失败了也只影响一小块，不会全盘崩溃。

### A.5 监控和告警依赖工具，不依赖人工巡检

弱团队最怕的是"出了问题不知道"。以下监控项必须在上线前配置好：

- DMS 任务状态异常 → CloudWatch Alarm + SNS 通知
- S3 文件长时间未到达 → CloudWatch 自定义指标告警
- Snowpipe 摄取延迟或错误 → Snowflake PIPE_USAGE_HISTORY 监控
- Snowflake 仓库挂起或查询超时 → Snowflake Resource Monitor

出问题第一时间通知到人，不依赖人工定期检查。

### A.6 总结

能买服务就不要自建，能用 UI 就不要写代码，能分阶段就不要一次上线。把团队的精力集中在业务逻辑上，基础设施层让托管服务兜底。
