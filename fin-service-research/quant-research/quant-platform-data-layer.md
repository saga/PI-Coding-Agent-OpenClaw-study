# Quant 平台模块细化：数据层设计

> 日期：2026-03-14
> 覆盖：点对点数据库、另类数据接入框架、实时数据流处理

---

## 一、点对点数据库（Point-in-Time Database）

### 1.1 核心概念

点对点数据（Point-in-Time，PIT）是量化回测的基础。它解决的问题是：**在历史某个时间点，研究员实际能看到什么数据？**

```
错误示例（有前视偏差）：
  回测日期：2023-03-31
  使用数据：2022-Q4 财报（EPS = 4.52）
  问题：该财报实际发布于 2023-05-10，在 2023-03-31 根本不存在！

正确做法（点对点）：
  回测日期：2023-03-31
  可用数据：2022-Q3 财报（发布于 2023-02-15，EPS = 4.21）
  → 只使用在该日期之前已公开的数据
```

### 1.2 双时间戳数据模型

每条记录必须有两个时间戳：

```sql
-- 点对点财务数据表设计
CREATE TABLE financial_data_pit (
    -- 主键
    record_id       BIGSERIAL PRIMARY KEY,

    -- 业务标识
    ticker          VARCHAR(20) NOT NULL,
    data_source     VARCHAR(50) NOT NULL,   -- 'compustat', 'factset', etc.

    -- 双时间戳（核心）
    period_end      DATE NOT NULL,          -- 数据描述的时间（如 2022-12-31）
    available_date  DATE NOT NULL,          -- 数据实际可用时间（如 2023-02-15）

    -- 版本管理（财务数据经常被追溯修订）
    revision_num    INT NOT NULL DEFAULT 1,
    is_latest       BOOLEAN NOT NULL DEFAULT TRUE,

    -- 财务指标
    revenue         NUMERIC(20, 2),
    net_income      NUMERIC(20, 2),
    eps_diluted     NUMERIC(10, 4),
    total_assets    NUMERIC(20, 2),
    -- ... 更多字段

    -- 元数据
    created_at      TIMESTAMP DEFAULT NOW(),
    data_quality    SMALLINT DEFAULT 100    -- 0-100 质量评分
);

-- 关键索引
CREATE INDEX idx_pit_ticker_available
    ON financial_data_pit (ticker, available_date);

CREATE INDEX idx_pit_ticker_period
    ON financial_data_pit (ticker, period_end, revision_num DESC);
```

### 1.3 时间旅行查询

```sql
-- 查询：在 2023-03-31 这一天，能看到的最新财务数据
SELECT DISTINCT ON (ticker)
    ticker,
    period_end,
    available_date,
    revenue,
    eps_diluted
FROM financial_data_pit
WHERE available_date <= '2023-03-31'   -- 关键：只看这天之前已发布的
  AND is_latest = TRUE
ORDER BY ticker, available_date DESC;  -- 取最新的一条
```

```python
# Python SDK 封装
class PointInTimeDB:

    def get_fundamentals(
        self,
        tickers: list[str],
        as_of_date: date,           # 回测日期
        fields: list[str] = None
    ) -> pd.DataFrame:
        """
        获取在 as_of_date 这天实际可用的最新财务数据
        严格防止前视偏差
        """
        query = """
            SELECT DISTINCT ON (ticker) ticker, period_end, {fields}
            FROM financial_data_pit
            WHERE ticker = ANY(%(tickers)s)
              AND available_date <= %(as_of_date)s
              AND is_latest = TRUE
            ORDER BY ticker, available_date DESC
        """.format(fields=", ".join(fields or ["*"]))

        return pd.read_sql(query, self.conn, params={
            "tickers": tickers,
            "as_of_date": as_of_date
        })
```

### 1.4 财务数据修订版本管理

财务数据经常被追溯修订（Restatement），需要保留所有历史版本：

```
示例：Apple 2022-Q4 EPS 的修订历史

revision_num | available_date | eps_diluted | 说明
-------------|----------------|-------------|-----
1            | 2023-02-02     | 1.88        | 初始发布
2            | 2023-04-15     | 1.89        | 小幅修订（会计调整）
3            | 2023-08-01     | 1.88        | 再次修订

回测时：
- 2023-03-01 的回测 → 使用 revision 1（eps = 1.88）
- 2023-05-01 的回测 → 使用 revision 2（eps = 1.89）
```

### 1.5 数据覆盖范围

| 数据类型 | 历史深度 | 更新频率 | 关键挑战 |
|---------|---------|---------|---------|
| 季度财务数据 | 20+ 年 | 季度 | 修订版本管理 |
| 年度财务数据 | 30+ 年 | 年度 | 会计准则变化 |
| 分析师预期 | 10+ 年 | 日更 | 预期修订追踪 |
| 指数成分股 | 20+ 年 | 月更 | 进出时间精确记录 |
| 公司行为 | 20+ 年 | 事件驱动 | 复权因子计算 |

---

## 二、另类数据接入框架

### 2.1 标准化接入 Pipeline

所有另类数据源通过统一框架接入，避免每个数据源单独开发：

```
┌─────────────────────────────────────────────────────────────┐
│                  另类数据接入框架                              │
│                                                             │
│  数据源（API/SFTP/S3）                                       │
│       │                                                     │
│       ▼                                                     │
│  [Connector 层]          每个数据源一个 Connector             │
│  ├── RavenPackConnector                                     │
│  ├── YipitDataConnector                                     │
│  └── CustomConnector（可扩展）                               │
│       │                                                     │
│       ▼                                                     │
│  [标准化层]              统一数据格式                          │
│  ├── 字段映射（source_field → standard_field）               │
│  ├── 时区标准化（统一为 UTC）                                  │
│  ├── 股票代码标准化（各市场代码 → 内部 ID）                     │
│  └── 缺失值处理策略                                           │
│       │                                                     │
│       ▼                                                     │
│  [质量检测层]                                                │
│  ├── 完整性检查（覆盖率是否达标）                               │
│  ├── 异常值检测（统计方法）                                    │
│  ├── 时效性检查（数据是否按时到达）                             │
│  └── 与历史数据一致性检查                                      │
│       │                                                     │
│       ▼                                                     │
│  [存储层]                                                   │
│  ├── 原始数据：S3（不可修改，保留原始）                         │
│  ├── 清洗数据：Delta Lake（支持时间旅行）                       │
│  └── 特征数据：Feature Store（供模型直接使用）                  │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 数据评估标准

新数据源接入前必须通过评估：

```python
class AltDataEvaluator:
    """另类数据信号质量评估"""

    def evaluate(self, dataset: AltDataset, universe: list[str]) -> EvalReport:

        # 1. 覆盖率评估
        coverage = len(set(dataset.tickers) & set(universe)) / len(universe)
        # 目标：核心股票池覆盖率 > 70%

        # 2. 历史深度
        history_years = (dataset.end_date - dataset.start_date).days / 365
        # 目标：至少 5 年历史

        # 3. 信号有效性（IC 分析）
        ic_series = self._compute_ic(dataset, forward_returns_1m)
        mean_ic   = ic_series.mean()    # 目标：|IC| > 0.03
        icir      = mean_ic / ic_series.std()  # 目标：ICIR > 0.5

        # 4. 信号衰减
        ic_decay = {
            "1w":  self._compute_ic(dataset, forward_returns_1w).mean(),
            "1m":  self._compute_ic(dataset, forward_returns_1m).mean(),
            "3m":  self._compute_ic(dataset, forward_returns_3m).mean(),
        }

        # 5. 与现有因子的相关性（避免重复）
        correlation_with_existing = self._compute_factor_correlation(dataset)
        # 目标：与现有因子相关性 < 0.5（保证独特性）

        return EvalReport(
            coverage=coverage,
            history_years=history_years,
            mean_ic=mean_ic,
            icir=icir,
            ic_decay=ic_decay,
            factor_correlation=correlation_with_existing,
            recommendation="ADOPT" if self._passes_threshold(...) else "REJECT"
        )
```

### 2.3 数据质量监控

```
监控指标（每日自动检查）：

覆盖率监控：
  今日覆盖股票数 / 历史平均覆盖股票数
  阈值：< 80% 触发告警

时效性监控：
  数据到达时间 vs 预期到达时间
  阈值：延迟 > 2 小时触发告警

异常值监控：
  今日数据分布 vs 历史分布（KS 检验）
  阈值：p-value < 0.01 触发告警

信号稳定性监控：
  滚动 30 天 IC vs 历史 IC
  阈值：IC 下降 > 50% 触发人工审查
```

---

## 三、实时数据流处理

### 3.1 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                    实时数据流架构                               │
│                                                              │
│  数据源                                                       │
│  ├── Bloomberg B-PIPE（实时行情）                              │
│  ├── 新闻 API（RavenPack 实时流）                              │
│  └── 内部交易系统（订单流）                                     │
│       │                                                      │
│       ▼                                                      │
│  [Kafka Topics]                                              │
│  ├── market.prices（实时价格，每 tick）                        │
│  ├── market.news（实时新闻情绪）                               │
│  └── market.signals（计算后的实时信号）                         │
│       │                                                      │
│       ▼                                                      │
│  [Flink 流处理]                                               │
│  ├── 实时因子计算（短期动量、成交量异常）                         │
│  ├── 实时情绪聚合（新闻情绪 → 公司层面评分）                     │
│  └── 实时风险监控（组合 VaR 实时更新）                           │
│       │                                                      │
│       ▼                                                      │
│  [实时存储]                                                   │
│  ├── Redis（毫秒级延迟，最新信号缓存）                           │
│  ├── TimescaleDB（秒级延迟，时序数据）                          │
│  └── Kafka（原始流数据，7 天保留）                              │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 实时因子计算示例

```python
# Flink 实时动量因子计算（概念示意）
class RealtimeMomentumFactor(ProcessFunction):
    """
    实时计算短期价格动量
    输入：实时 tick 数据
    输出：每分钟更新的动量信号
    """

    def process_element(self, tick: PriceTick, ctx: Context):
        ticker = tick.ticker
        price  = tick.price

        # 更新滚动窗口（过去 20 分钟的价格）
        self.price_window[ticker].append((tick.timestamp, price))
        self._cleanup_old_ticks(ticker, minutes=20)

        # 计算短期动量
        if len(self.price_window[ticker]) >= 2:
            oldest_price = self.price_window[ticker][0][1]
            momentum_20m = (price - oldest_price) / oldest_price

            # 输出信号
            yield Signal(
                ticker    = ticker,
                factor    = "momentum_20m",
                value     = momentum_20m,
                timestamp = tick.timestamp
            )
```

### 3.3 实时 vs 批量处理的边界

| 场景 | 处理方式 | 延迟要求 | 技术 |
|------|---------|---------|------|
| 日内价格动量 | 实时流处理 | < 1 秒 | Kafka + Flink |
| 新闻情绪信号 | 准实时 | < 5 分钟 | Kafka + Python |
| 日频因子计算 | 批量处理 | 收盘后 2 小时 | Airflow + Spark |
| 月频因子更新 | 批量处理 | 月末 T+1 | Airflow |
| 风险模型更新 | 批量处理 | 每日 | Airflow |

---

*参考来源：Delta Lake 文档、Apache Kafka 官方文档、Apache Flink 官方文档、Two Sigma 数据工程实践*
