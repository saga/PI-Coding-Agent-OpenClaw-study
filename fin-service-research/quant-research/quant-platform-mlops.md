# Quant 平台模块细化：MLOps 平台设计

> 日期：2026-03-14
> 覆盖：实验追踪、特征存储、模型上线流程、模型监控

---

## 一、整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                      MLOps 平台                               │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  实验追踪    │  │  特征存储    │  │  模型注册表  │         │
│  │  MLflow     │  │  Feast      │  │  MLflow     │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  流水线调度  │  │  数据版本   │  │  模型监控    │         │
│  │  Airflow    │  │  Delta Lake │  │  自定义      │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└──────────────────────────────────────────────────────────────┘
```

---

## 二、实验追踪系统（MLflow）

### 2.1 实验元数据规范

量化研究的每次实验必须记录以下信息：

```python
import mlflow

def run_factor_experiment(factor_config: dict) -> str:
    """标准化的因子实验追踪"""

    with mlflow.start_run(experiment_name="factor_research") as run:

        # 1. 记录参数
        mlflow.log_params({
            "factor_id":       factor_config["id"],
            "universe":        factor_config["universe"],
            "start_date":      factor_config["start_date"],
            "end_date":        factor_config["end_date"],
            "neutralization":  str(factor_config["neutralization"]),
            "rebalance_freq":  factor_config["rebalance_freq"],
        })

        # 2. 运行回测
        result = run_backtest(factor_config)

        # 3. 记录指标
        mlflow.log_metrics({
            "mean_ic":         result.mean_ic,
            "icir":            result.icir,
            "sharpe_ratio":    result.sharpe,
            "annual_return":   result.annual_return,
            "max_drawdown":    result.max_drawdown,
            "annual_turnover": result.turnover,
        })

        # 4. 记录产出物
        mlflow.log_artifact("backtest_report.html")
        mlflow.log_artifact("ic_decay_curve.png")
        mlflow.log_artifact("quintile_returns.png")

        # 5. 记录代码版本
        mlflow.set_tag("git_commit", get_git_hash())
        mlflow.set_tag("data_version", get_data_version())

    return run.info.run_id
```

### 2.2 实验对比与可视化

```
MLflow UI 支持的对比功能：

并排对比多个实验：
  实验 A：momentum_12_1，IC=0.042，Sharpe=0.85
  实验 B：momentum_6_1，IC=0.038，Sharpe=0.79
  实验 C：momentum_12_1 + 行业中性化，IC=0.051，Sharpe=0.92
  → 结论：行业中性化显著提升因子质量

参数敏感性分析：
  扫描 lookback_days: [63, 126, 189, 252]
  扫描 skip_days: [5, 10, 21]
  → 热力图展示不同参数组合的 IC 值
  → 识别参数稳健区间（避免过拟合到特定参数）
```

---

## 三、特征存储（Feature Store）

### 3.1 解决的核心问题

```
没有特征存储时的问题（Training-Serving Skew）：

研究员在 Jupyter 里：
  momentum = prices.pct_change(252) - prices.pct_change(21)
  → 回测 Sharpe = 0.92

工程师上线时重新实现：
  momentum = (close - close.shift(252)) / close.shift(252)
             - (close - close.shift(21)) / close.shift(21)
  → 线上结果与回测不一致（细节差异：复权方式、缺失值处理）

有特征存储后：
  研究员定义一次计算逻辑
  离线回测 和 线上推理 都从同一个特征存储读取
  → 完全一致
```

### 3.2 Feast 特征存储设计

```python
# 特征定义（一次定义，到处使用）
from feast import FeatureView, Field, FileSource
from feast.types import Float32

# 数据源
prices_source = FileSource(
    path="s3://quant-data/features/prices/",
    timestamp_field="date"
)

# 特征视图定义
momentum_features = FeatureView(
    name="momentum_features",
    entities=["ticker"],
    ttl=timedelta(days=1),
    schema=[
        Field(name="momentum_12_1",  dtype=Float32),
        Field(name="momentum_6_1",   dtype=Float32),
        Field(name="momentum_1m",    dtype=Float32),
    ],
    source=prices_source,
)
```

```python
# 离线训练（回测）
training_data = store.get_historical_features(
    entity_df=pd.DataFrame({
        "ticker": universe,
        "event_timestamp": rebalance_dates
    }),
    features=["momentum_features:momentum_12_1"]
).to_df()

# 在线推理（实盘信号生成）
online_features = store.get_online_features(
    features=["momentum_features:momentum_12_1"],
    entity_rows=[{"ticker": t} for t in universe]
).to_df()
```

### 3.3 离线 vs 在线特征

| 维度 | 离线特征 | 在线特征 |
|------|---------|---------|
| 用途 | 回测、模型训练 | 实盘信号生成 |
| 存储 | S3 + Parquet | Redis |
| 延迟 | 分钟级 | 毫秒级 |
| 数据量 | 全历史 | 最新一期 |
| 更新频率 | 每日批量 | 实时/每日 |

---

## 四、模型上线流程

### 4.1 上线审批流程

```
模型上线流程（从研究到生产）：

[研究阶段]
研究员完成因子/模型开发
  ├── 回测报告（含 Walk-Forward 验证）
  ├── 代码审查（防前视偏差）
  └── MLflow 实验记录
      │
      ▼
[Staging 阶段]（30 天）
部署到 Staging 环境
  ├── 实时计算，与生产数据对比
  ├── 监控覆盖率和异常值
  └── 与现有生产模型的相关性分析
      │
      ▼
[审批]
量化研究主管审批
  ├── 回测结果合理性
  ├── 经济学逻辑
  └── 风险评估（容量、流动性）
      │
      ▼
[生产部署]
  ├── 蓝绿部署（新旧版本并行运行 1 周）
  ├── 逐步增加新模型权重（10% → 50% → 100%）
  └── 监控生产指标
```

### 4.2 A/B 测试框架

```python
class ModelABTest:
    """
    量化模型 A/B 测试
    在真实资金上对比新旧模型，控制风险
    """

    def __init__(self, model_a: str, model_b: str, split_ratio: float = 0.1):
        self.model_a = model_a      # 现有生产模型
        self.model_b = model_b      # 新模型（候选）
        self.split_ratio = split_ratio  # 10% 资金用于测试新模型

    def get_signal(self, date: date, universe: list[str]) -> pd.Series:
        signal_a = self.registry.get_signal(self.model_a, date, universe)
        signal_b = self.registry.get_signal(self.model_b, date, universe)

        # 混合信号：90% 旧模型 + 10% 新模型
        return (1 - self.split_ratio) * signal_a + self.split_ratio * signal_b

    def evaluate(self, start_date: date, end_date: date) -> ABTestReport:
        """评估 A/B 测试结果，决定是否全量切换"""
        perf_a = self._compute_performance(self.model_a, start_date, end_date)
        perf_b = self._compute_performance(self.model_b, start_date, end_date)

        return ABTestReport(
            model_a_sharpe = perf_a.sharpe,
            model_b_sharpe = perf_b.sharpe,
            improvement    = perf_b.sharpe - perf_a.sharpe,
            recommendation = "PROMOTE" if perf_b.sharpe > perf_a.sharpe + 0.1 else "KEEP_A"
        )
```

### 4.3 模型回滚方案

```
回滚触发条件（任一满足即触发）：
├── 生产 IC 连续 5 天 < 0
├── 组合收益连续 10 天跑输基准 > 2%
├── 数据覆盖率下降 > 20%
└── 系统异常（计算错误、数据缺失）

回滚操作（自动化）：
1. 停止新模型信号生成
2. 切换回上一个稳定版本（MLflow Model Registry 中的 "Production" 标签）
3. 发送告警通知（邮件 + Slack）
4. 记录回滚原因和时间戳

回滚时间目标：< 5 分钟
```

---

## 五、模型监控

### 5.1 Alpha 衰减检测

```python
class AlphaDecayMonitor:
    """监控生产模型的 Alpha 是否在衰减"""

    def check_daily(self, model_id: str) -> MonitorReport:
        # 滚动 30 天 IC
        ic_30d = self._compute_rolling_ic(model_id, window=30)

        # 与历史基准对比
        ic_baseline = self.registry.get_baseline_ic(model_id)

        decay_ratio = ic_30d / ic_baseline

        alerts = []
        if decay_ratio < 0.5:
            alerts.append(Alert(
                level="WARNING",
                message=f"模型 {model_id} IC 衰减至历史水平的 {decay_ratio:.0%}，建议审查"
            ))
        if decay_ratio < 0.2:
            alerts.append(Alert(
                level="CRITICAL",
                message=f"模型 {model_id} IC 严重衰减，建议暂停使用"
            ))

        return MonitorReport(ic_30d=ic_30d, decay_ratio=decay_ratio, alerts=alerts)
```

### 5.2 数据漂移监控

```
监控维度：

特征分布漂移（PSI - Population Stability Index）：
  PSI = Σ (实际占比 - 预期占比) × ln(实际占比 / 预期占比)
  PSI < 0.1：稳定
  0.1 ≤ PSI < 0.2：轻微漂移，需关注
  PSI ≥ 0.2：显著漂移，需调查

覆盖率监控：
  今日有效信号股票数 / 历史平均
  阈值：< 80% 触发告警

异常值监控：
  因子值超过 ±5σ 的股票比例
  阈值：> 1% 触发告警
```

### 5.3 监控仪表盘

```
生产模型监控仪表盘（每日自动更新）：

┌─────────────────────────────────────────────────────┐
│  模型：momentum_composite_v3.2  状态：✅ 正常         │
│                                                     │
│  今日 IC：0.038    30日均 IC：0.041    基准：0.042    │
│  衰减比率：97.6%   ✅ 正常                           │
│                                                     │
│  覆盖率：2,847 / 3,000 (94.9%)  ✅ 正常              │
│  异常值比例：0.3%  ✅ 正常                            │
│                                                     │
│  数据到达时间：18:32（预期 18:30）⚠️ 轻微延迟          │
│                                                     │
│  近 30 日累计超额收益：+1.82%  ✅ 正常                │
└─────────────────────────────────────────────────────┘
```

---

*参考来源：MLflow 官方文档、Feast 特征存储文档、Uber Michelangelo MLOps 架构、Two Sigma 模型管理实践*
