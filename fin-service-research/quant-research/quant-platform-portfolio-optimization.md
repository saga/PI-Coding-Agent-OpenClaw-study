# Quant 平台模块细化：组合优化与风险管理

> 日期：2026-03-14
> 覆盖：组合优化器、风险模型、压力测试、研究环境

---

## 一、组合优化器设计

### 1.1 均值-方差优化（MVO）

```python
import cvxpy as cp
import numpy as np

class MeanVarianceOptimizer:
    """
    Markowitz 均值-方差优化
    目标：最大化 风险调整后收益（Sharpe Ratio）
    """

    def optimize(
        self,
        expected_returns: np.ndarray,   # 预期收益向量（N,）
        cov_matrix: np.ndarray,         # 协方差矩阵（N×N）
        constraints: OptConstraints
    ) -> np.ndarray:

        N = len(expected_returns)
        w = cp.Variable(N)              # 权重变量

        # 目标函数：最大化预期收益 - λ × 组合方差
        risk_aversion = constraints.risk_aversion  # 风险厌恶系数
        objective = cp.Maximize(
            expected_returns @ w - risk_aversion * cp.quad_form(w, cov_matrix)
        )

        # 约束条件
        cons = [
            cp.sum(w) == 1,                          # 权重之和为 1
            w >= constraints.min_weight,             # 最小权重（通常 0，禁止做空）
            w <= constraints.max_weight,             # 最大单股权重（如 5%）
        ]

        # 行业约束（偏离基准不超过 ±5%）
        if constraints.industry_bounds:
            for industry, (lb, ub) in constraints.industry_bounds.items():
                industry_mask = self._get_industry_mask(industry)
                cons.append(industry_mask @ w >= lb)
                cons.append(industry_mask @ w <= ub)

        # 换手率约束
        if constraints.max_turnover and self.prev_weights is not None:
            cons.append(
                cp.norm(w - self.prev_weights, 1) <= constraints.max_turnover
            )

        prob = cp.Problem(objective, cons)
        prob.solve(solver=cp.OSQP)

        return w.value
```

### 1.2 风险平价（Risk Parity）

```python
class RiskParityOptimizer:
    """
    风险平价：每个资产对组合总风险的贡献相等
    适合多资产配置，不依赖预期收益估计
    """

    def optimize(self, cov_matrix: np.ndarray) -> np.ndarray:
        N = cov_matrix.shape[0]
        w = cp.Variable(N, pos=True)  # 权重必须为正

        # 风险贡献 = w_i × (Σw)_i / (w^T Σ w)
        # 目标：最小化风险贡献的方差（使各资产风险贡献相等）
        portfolio_var = cp.quad_form(w, cov_matrix)
        risk_contrib  = cp.multiply(w, cov_matrix @ w)

        # 等风险贡献 ↔ 最小化 Σ(RC_i - RC_j)^2
        objective = cp.Minimize(cp.sum_squares(risk_contrib - portfolio_var / N))

        cons = [cp.sum(w) == 1]
        prob = cp.Problem(objective, cons)
        prob.solve()

        return w.value / w.value.sum()
```

### 1.3 Black-Litterman 模型

```
Black-Litterman 解决 MVO 的两个核心问题：
1. 预期收益难以估计（MVO 对输入极度敏感）
2. 优化结果极端集中（少数股票权重过高）

BL 的思路：
  从市场均衡收益出发（隐含收益）
  + 投资者的主观观点（Views）
  → 混合后的预期收益（更稳健）
  → 输入 MVO 得到更分散的组合

示例：
  市场均衡：台积电预期收益 12%
  分析师观点：台积电将跑赢市场 5%（置信度 70%）
  BL 混合后：台积电预期收益 15.2%（介于两者之间）
```

---

## 二、风险模型

### 2.1 自建 vs 购买的决策框架

```
决策矩阵：

                    自建成本低    自建成本高
覆盖市场标准化程度高  → 购买（Barra）  → 购买（Barra）
覆盖市场特殊性强     → 混合策略      → 自建补充模型

Fidelity 建议：
├── 全球股票：购买 Barra GEM 或 Axioma WW5.1
├── A 股：自建补充模型（Barra 对 A 股覆盖不足）
└── 固定收益：购买 Axioma 固收风险模型
```

### 2.2 自建多因子风险模型（A 股补充）

```python
class CustomRiskModel:
    """
    针对 A 股市场的自建多因子风险模型
    补充 Barra 对 A 股覆盖的不足
    """

    STYLE_FACTORS = [
        "value", "quality", "momentum", "low_vol",
        "size", "liquidity",
        # A 股特有因子
        "northbound_flow",   # 北向资金流向
        "margin_balance",    # 融资余额变化
        "limit_up_reversal", # 涨停反转
    ]

    def estimate_covariance(
        self,
        date: date,
        universe: list[str]
    ) -> np.ndarray:
        """
        估计协方差矩阵
        = 因子协方差 + 特异性风险
        """
        # 因子暴露矩阵（N × K）
        B = self._get_factor_exposures(date, universe)

        # 因子协方差矩阵（K × K）
        F = self._estimate_factor_covariance(date)

        # 特异性风险（对角矩阵）
        D = self._estimate_specific_risk(date, universe)

        # 总协方差 = B × F × B^T + D
        return B @ F @ B.T + D
```

### 2.3 压力测试框架

```
压力测试类型：

历史情景（Historical Scenarios）：
  ├── 2008 金融危机（2008-09 ~ 2009-03）
  ├── 2020 新冠冲击（2020-02 ~ 2020-03）
  ├── 2022 加息周期（2022-01 ~ 2022-12）
  └── 2015 A 股股灾（2015-06 ~ 2015-08）

假设情景（Hypothetical Scenarios）：
  ├── 利率突然上升 200bp
  ├── 美元指数上涨 15%
  ├── 中美关系恶化（科技股下跌 30%）
  └── 全球经济衰退（GDP 下降 3%）

压力测试输出：
  ├── 组合在各情景下的预期损失
  ├── 最脆弱的持仓（贡献最大损失的股票）
  └── 对冲建议（哪些工具可以降低尾部风险）
```

### 2.4 尾部风险管理（CVaR）

```
VaR vs CVaR：

VaR（Value at Risk）：
  "在 95% 置信水平下，最大损失不超过 X"
  问题：不关心超过 VaR 的极端损失有多大

CVaR（Conditional VaR / Expected Shortfall）：
  "在最坏的 5% 情景下，平均损失是多少"
  更好地捕捉尾部风险

组合优化中加入 CVaR 约束：
  minimize: -expected_return
  subject to: CVaR(95%) ≤ max_cvar_limit
```

---

## 三、研究环境（JupyterHub）

### 3.1 平台设计

```
JupyterHub 多用户研究环境：

用户隔离：
  每个研究员独立的 Jupyter Server（Docker 容器）
  独立的文件系统（个人工作目录）
  共享只读数据目录（因子库、市场数据）

资源配置：
  标准实例：4 CPU / 16GB RAM（日常研究）
  大内存实例：16 CPU / 64GB RAM（大规模回测）
  GPU 实例：4× A100（深度学习模型训练）

数据访问权限：
  通过 Research SDK 访问数据（自动注入权限过滤）
  禁止直接访问生产数据库
  所有数据访问记录审计日志
```

### 3.2 Research SDK 标准工具库

```python
# 研究员的标准工作流（一行代码完成常见任务）
from fidelity_quant import data, factors, backtest, viz

# 获取数据（自动处理权限、点对点、复权）
prices = data.get_prices(["AAPL", "MSFT"], "2020-01-01", "2024-12-31")
fundamentals = data.get_fundamentals(universe, as_of="2024-03-31")

# 计算因子（自动标准化、中性化）
momentum = factors.momentum(prices, lookback=252, skip=21)
value = factors.book_to_price(fundamentals)

# 快速回测
result = backtest.run(
    signal=momentum,
    start="2015-01-01",
    end="2024-12-31",
    rebalance="monthly"
)

# 可视化
viz.ic_decay(result)
viz.quintile_returns(result)
viz.drawdown(result)
```

---

## 四、todo-plan 第三大类完成状态

所有模块文档已完成：

| 模块 | 文档 | 状态 |
|------|------|------|
| 数据层（PIT DB、另类数据、实时流） | `quant-platform-data-layer.md` | ✅ |
| 因子库（分类、计算、评估、管理） | `quant-platform-factor-library.md` | ✅ |
| 回测引擎（向量化、事件驱动、质量保障） | `quant-platform-backtest-engine.md` | ✅ |
| MLOps（实验追踪、特征存储、上线、监控） | `quant-platform-mlops.md` | ✅ |
| 组合优化与风险管理 | `quant-platform-portfolio-optimization.md` | ✅ |

---

*参考来源：Markowitz (1952) 均值-方差理论、Black-Litterman (1990) 模型、Axioma 优化器文档、CVXPY 文档、JupyterHub 官方文档*
