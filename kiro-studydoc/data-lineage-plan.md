# Equity Research 数据血缘实施计划

**技术栈：** Collibra + Snowflake + AWS RDS SQL Server  
**场景：** AI Agent（pi-coding-agent）生成 equity research 报告，每个数字需可追溯

---

## 一、先把问题说清楚

你面对的"数据血缘"实际上是两个不同层次的问题，必须分开处理：

**层次 A：基础设施血缘（你已有工具）**  
数据从 SQL Server → Snowflake → 报告的物理流转路径。Collibra 擅长这个。

**层次 B：AI 生成内容的引用血缘（新问题）**  
Agent 在生成报告时，每一句话、每一个数字，来自哪个数据源、哪个文件、哪个时间点。这是 Collibra 不直接解决的问题，需要在 Agent 层自己构建。

两层都要做，但优先级和工具不同。

---

## 二、现有技术栈的能力边界

### Collibra 能做什么

- Snowflake：原生支持，通过 Edge + JDBC 连接，自动 harvest 表/列级技术血缘（DDL、视图、存储过程）
- SQL Server（AWS RDS）：通过 Edge + JDBC 支持，可 harvest schema 和存储过程血缘
- 两者之间的 ETL 血缘：如果用 AWS Glue 或 dbt 做数据搬运，Collibra 支持 OpenLineage 标准，可以接收运行时血缘事件

**重要提醒：** Collibra CLI lineage harvester 已宣布 2026-07-31 EOL，必须迁移到 Edge 方式。如果你还在用 CLI harvester，这是短期计划的第一件事。

### Collibra 不能直接做什么

- 追踪 AI Agent 在运行时"读了哪个 Snowflake 表、引用了哪个数字"
- 把 Agent 的数据消费行为注册回 Collibra 的血缘图
- 在 Word/Excel 报告里嵌入可点击的 Collibra 资产链接

### Snowflake 的原生能力

- `QUERY_HISTORY` 视图：记录所有 SQL 查询，含执行时间、用户、查询文本
- `ACCESS_HISTORY` 视图：列级别的读写记录（需要 Enterprise 版本）
- 这两个视图是构建 Agent 数据消费血缘的关键原材料

---

## 三、短期计划（0-3 个月）：让现有系统可追溯

目标：在不大改架构的前提下，让 Agent 生成的报告里每个数字有来源。

### Step 1：修复 Collibra 基础连接（第 1-2 周）

**SQL Server（AWS RDS）→ Collibra：**
```
1. 在 AWS VPC 内部署 Collibra Edge（Docker 容器）
2. 配置 JDBC 连接到 RDS SQL Server
3. 添加 Technical Lineage capability
4. 运行初始 harvest，注册 research domain 的表/列资产
5. 验证 Collibra 中能看到 SQL Server 的 schema 血缘
```

**Snowflake → Collibra：**
```
1. 在 Collibra 中配置 Snowflake JDBC 连接（通过 Edge）
2. 启用 SQL API 模式（比 JDBC 模式血缘更完整）
3. 运行 harvest，注册 Snowflake 的表/视图/存储过程血缘
4. 配置定期同步（建议每日）
```

**产出：** Collibra 中有完整的 SQL Server ↔ Snowflake 技术血缘图。

### Step 2：构建 Agent 引用追踪层（第 2-4 周）

这是核心工程工作。在 Agent 每次查询数据时，记录一个"引用事件"。

**设计一个轻量的 Citation Context 对象：**

```python
@dataclass
class CitationContext:
    run_id: str           # 本次报告生成的唯一 ID
    timestamp: str        # ISO 8601
    source_type: str      # "snowflake" | "rds_sqlserver" | "sec_edgar" | "mcp_factset" | "web"
    source_ref: str       # 表名/文件名/URL
    query_or_path: str    # 具体 SQL 或文件路径
    field_name: str       # 对应报告中的字段名（如 "Q3_Revenue"）
    value: str            # 实际值
    collibra_asset_id: str  # Collibra 中对应资产的 UUID（可选，有则填）
```

**在 Agent 的数据获取函数里注入追踪：**

```python
def fetch_from_snowflake(query: str, field_name: str, run_id: str) -> tuple[Any, CitationContext]:
    result = snowflake_conn.execute(query)
    
    # 从 Snowflake QUERY_HISTORY 获取刚才这条查询的 query_id
    query_id = get_last_query_id()
    
    citation = CitationContext(
        run_id=run_id,
        timestamp=datetime.utcnow().isoformat(),
        source_type="snowflake",
        source_ref=extract_table_from_query(query),
        query_or_path=query,
        field_name=field_name,
        value=str(result),
        collibra_asset_id=lookup_collibra_id(extract_table_from_query(query))
    )
    return result, citation
```

**把所有 citation 存到一个 run-level 的 manifest 文件：**

```json
{
  "run_id": "report-AAPL-Q3-2026-03-14-001",
  "report_file": "AAPL_Q3_2026_Earnings_Update.docx",
  "generated_at": "2026-03-14T06:30:00Z",
  "citations": [
    {
      "field_name": "Q3_Revenue",
      "value": "$94.9B",
      "source_type": "snowflake",
      "source_ref": "RESEARCH_DB.FINANCIALS.EARNINGS_ACTUALS",
      "query_or_path": "SELECT revenue FROM ... WHERE ticker='AAPL' AND quarter='Q3_2026'",
      "collibra_asset_id": "a1b2c3d4-...",
      "timestamp": "2026-03-14T06:28:11Z"
    },
    {
      "field_name": "Consensus_EPS",
      "value": "$1.60",
      "source_type": "mcp_factset",
      "source_ref": "FactSet Consensus Estimates",
      "query_or_path": "https://mcp.factset.com/...",
      "collibra_asset_id": null,
      "timestamp": "2026-03-14T06:28:45Z"
    }
  ]
}
```

### Step 3：在报告输出中嵌入引用（第 3-4 周）

Agent 生成 DOCX 时，每个数字后面自动附上脚注或内联引用：

```
Q3 revenue of $94.9B¹ beat consensus of $93.2B² by 1.8%...

---
¹ Source: Snowflake RESEARCH_DB.FINANCIALS.EARNINGS_ACTUALS, 2026-03-14 06:28 UTC
  [Collibra Asset Link]
² Source: FactSet Consensus Estimates, retrieved 2026-03-14 06:28 UTC
```

对于 Excel 模型，在每个蓝色输入单元格的 comment 里写入：
```
Source: Snowflake RESEARCH_DB.FINANCIALS.EARNINGS_ACTUALS
Query run: 2026-03-14 06:28 UTC | Run ID: report-AAPL-Q3-2026-03-14-001
Collibra: [asset UUID]
```

### Step 4：把 Agent 消费行为回写 Collibra（第 4-6 周）

利用 Collibra REST API，把 Agent 的数据消费注册为血缘关系：

```python
def register_agent_lineage_in_collibra(citation: CitationContext, report_asset_id: str):
    """
    在 Collibra 中创建：
    [Snowflake 表/列] --[used by]--> [Report Asset]
    """
    collibra_api.create_lineage_edge(
        source_asset_id=citation.collibra_asset_id,
        target_asset_id=report_asset_id,
        relation_type="used_by",
        attributes={
            "run_id": citation.run_id,
            "timestamp": citation.timestamp,
            "agent": "pi-coding-agent",
            "field": citation.field_name
        }
    )
```

这样在 Collibra 的血缘图里，你能看到：
```
RDS SQL Server.research_db.earnings
    → Snowflake.RESEARCH_DB.FINANCIALS.EARNINGS_ACTUALS
        → [Report] AAPL_Q3_2026_Earnings_Update.docx
```

**短期计划产出：**
- Collibra 有完整的 SQL Server + Snowflake 技术血缘
- 每份报告有 citation manifest JSON 文件
- 报告内每个数字有来源脚注
- Collibra 血缘图延伸到 AI 生成的报告

---

## 四、长期 Vision（6-18 个月）：端到端可信数据链

### Vision 描述

任何一份 equity research 报告里的任何一个数字，都能在 30 秒内回答：
1. 这个数字从哪来？（原始数据源）
2. 经过了哪些变换？（ETL 路径）
3. 是谁/什么系统生成的？（Agent + 模型版本）
4. 什么时候生成的？（时间戳）
5. 有没有人审核过？（审核状态）
6. 这个数字影响了哪些其他报告？（下游影响分析）

这就是**完整的 AI 内容血缘**，覆盖从原始数据到最终报告的全链路。

### 架构演进路径

**阶段一（短期，已描述）：** 手工注入 + manifest 文件

**阶段二（3-6 个月）：OpenLineage 标准化**

把 Agent 的数据消费行为用 OpenLineage 标准格式发出，Collibra 原生支持接收 OpenLineage 事件：

```json
{
  "eventType": "COMPLETE",
  "eventTime": "2026-03-14T06:28:11Z",
  "run": {
    "runId": "report-AAPL-Q3-2026-03-14-001"
  },
  "job": {
    "namespace": "equity-research-agent",
    "name": "earnings-analysis"
  },
  "inputs": [{
    "namespace": "snowflake://account.snowflakecomputing.com",
    "name": "RESEARCH_DB.FINANCIALS.EARNINGS_ACTUALS"
  }],
  "outputs": [{
    "namespace": "reports://equity-research",
    "name": "AAPL_Q3_2026_Earnings_Update.docx"
  }]
}
```

Collibra 接收这个事件后，自动在血缘图里创建关系，不需要手工调用 Collibra API。

**阶段三（6-12 个月）：Claim-level 血缘**

不只是"这份报告用了这张表"，而是"报告第 3 页第 2 段的 $94.9B 来自 Snowflake 表的第 X 行"。

这需要在 Agent 生成文本时，维护一个 claim → citation 的映射：

```python
class ClaimCitationMapper:
    """
    追踪 Agent 生成的每一个声明（claim）和其对应的数据来源
    """
    def record_claim(self, claim_text: str, citations: list[CitationContext]):
        self.claims.append({
            "claim": claim_text,
            "citations": citations,
            "location": self.current_section  # 报告中的位置
        })
```

最终报告里每个段落都有可展开的"数据来源"侧边栏，类似学术论文的引用系统。

**阶段四（12-18 个月）：Collibra 作为统一血缘中枢**

```
原始数据层
├── AWS RDS SQL Server (research domain)
│   └── Collibra Edge → 自动 harvest schema 血缘
└── Snowflake
    └── Collibra Edge → 自动 harvest + SQL API 血缘

ETL 层
└── AWS Glue / dbt
    └── OpenLineage emitter → Collibra 接收运行时血缘

AI Agent 层
└── pi-coding-agent
    └── OpenLineage emitter → Collibra 接收 Agent 消费血缘

报告层
└── DOCX / XLSX 报告
    └── 注册为 Collibra Report 资产，关联所有上游血缘

查询层（新增）
└── Collibra API → 任意报告的完整血缘图
└── Collibra UI → 分析师可视化查看数据来源
```

---

## 五、步骤设计总览

```
Week 1-2   ████ Collibra Edge 部署 + SQL Server/Snowflake 连接
Week 3-4   ████ Citation Context 对象 + Agent 追踪注入
Week 5-6   ████ 报告内引用嵌入 + Collibra 回写
Week 7-8   ████ 测试验证 + 分析师反馈
Month 3    ████ OpenLineage 标准化改造
Month 4-6  ████ Claim-level 血缘 MVP
Month 6-12 ████ Collibra 统一血缘中枢
Month 12+  ████ 下游影响分析 + 合规报告自动化
```

---

## 六、SA 需要特别注意的风险点

**风险 1：Collibra CLI harvester EOL**  
2026-07-31 CLI harvester 停止支持。如果现在还在用 CLI 方式，必须在短期计划里优先迁移到 Edge，否则会影响现有血缘功能。

**风险 2：Snowflake ACCESS_HISTORY 需要 Enterprise 版本**  
列级别的访问历史需要 Snowflake Enterprise 或以上。如果是 Standard 版本，只能做表级血缘，精度会下降。确认你的 Snowflake 版本。

**风险 3：Agent 的 MCP 数据源没有 Collibra 资产对应**  
FactSet、Daloopa 等外部 MCP 服务的数据不在你的 Collibra 里。这部分血缘只能靠 citation manifest 文件记录，无法在 Collibra 血缘图里显示。接受这个限制，或者在 Collibra 里手工创建"外部数据源"资产作为占位符。

**风险 4：报告文件不是结构化数据**  
DOCX/XLSX 文件本身不是 Collibra 原生支持的资产类型。需要在 Collibra 里创建自定义资产类型（Report Asset），并通过 API 手工注册每份报告。这有一定的维护成本。

**风险 5：Agent 并发生成多份报告时的 run_id 冲突**  
如果多个分析师同时触发 Agent，需要确保 run_id 全局唯一（建议用 UUID v4 + 时间戳组合）。
