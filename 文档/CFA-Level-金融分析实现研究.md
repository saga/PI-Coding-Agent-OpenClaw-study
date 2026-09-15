# CFA-Level 金融分析实现研究

**FinceptTerminal — 架构与算法参考手册**

---

## 概述

FinceptTerminal 中的 CFA-Level 金融分析功能分为两层实现：

- **C++ Qt UI 层** — 专业交易终端界面，负责风险指标、投资组合分析以及衍生品定价面板展示
- **嵌入式 Python 引擎** — 通过 `numpy`、`scipy`、`pandas` 和 `yfinance` 实现金融计算

两层通过 `PythonCliService`（C++ 桥接服务）使用 JSON 进行通信，Python 脚本以 JSON 输入调用并返回 JSON 输出。

---

## 1. 折现现金流（DCF）模型

### 1.1 架构

DCF 模型位于 **Analytics** 模块中：

```
scripts/Analytics/
├── equityInvestment/equity_valuation/dcf_models.py   # FCFF、DDM、剩余收益模型
└── corporateFinance/valuation/dcf_model.py            # 完整 DCF 模型（含 WACC）
```

UI 层通过 `PythonCliService`（C++ 桥接）调用这些模型，传入公司财务数据并获取内在价值估值。同时，`QuantLibScreen` 的 `analysis` 模块也提供 DCF 估值端点。

### 1.2 算法详解

#### 加权平均资本成本（WACC）

```
WACC = (E/V × Re) + (D/V × Rd × (1 − Tc))

其中：
  Re = Rf + β × MRP + 国家风险溢价 + 规模溢价
  E  = 权益市场价值
  D  = 债务市场价值
  V  = E + D
  Tc = 公司税率
```

**实现**（`DCFModel.calculate_wacc`）：
- 权益成本：`Rf + β × MRP + 国家风险 + 规模溢价`
- 税后债务成本：`Rd × (1 − Tc)`
- 输入验证：每个参数都有严格范围（如 beta ∈ [0.1, 3.0]，税率 ∈ [0, 50%]）

#### Beta 去杠杆化 / 再杠杆化

```
β_去杠杆化 = β_有杠杆 / (1 + (1 − Tc) × D/E)

β_再杠杆化 = β_去杠杆化 × (1 + (1 − Tc) × D/E_目标)
```

用于去除当前资本结构的影响，然后应用目标资本结构。

#### 公司自由现金流（FCFF）

```
NOPAT = EBIT × (1 − 税率)
FCFF  = NOPAT + 折旧摊销 − 资本支出 − 营运资本变动 + 股票激励

(股票激励 = SBC，非现金加回项)
```

#### 永续增长模型（终端价值）

```
TV = FCFF_最后一年 × (1 + g) / (WACC − g)

其中 g = 永续增长率，约束条件：g < WACC
```

终端价值的现值：
```
PV(TV) = TV / (1 + WACC)^n
```

#### 企业价值到权益价值的转换

```
权益价值 = 企业价值 + 现金 − 总债务 − 优先股
每股内在价值 = 权益价值 / 流通股数
```

#### 现金流预测引擎

FCFF 预测使用逐年增长率：
```
FCFF_n = FCFF_{n-1} × (1 + g_n)
```

支持维护性资本支出与增长性资本支出的分别处理。

---

## 2. 投资组合优化

### 2.1 入口点

| 层级 | 文件路径 | 角色 |
|---|---|---|
| C++ UI | `screens/portfolio/views/PortfolioOptimizationView.cpp` | 多标签优化界面 |
| Python 引擎 | `scripts/optimize_portfolio_weights.py` | 全部优化算法 |

### 2.2 数据获取

```python
# 使用 yfinance 下载日度复权收盘价
data = yf.download(symbols, period="1y", interval="1d", auto_adjust=True)
returns_df = close[available].pct_change().dropna()

# 年化参数
mean_ret = returns_df.mean().values × 252        # 预期年化收益向量
cov      = returns_df.cov().values × 252          # 年化协方差矩阵
```

### 2.3 优化策略

所有策略都通过 `scipy.optimize.minimize`（方法：`SLSQP`）求解约束优化：

```
minimize f(w)
subject to: Σw_i = 1,  0 ≤ w_i ≤ 1
```

#### 2.3.1 最大化夏普比率

```
max  (w^T μ − Rf) / √(w^T Σ w)
w

等价于：  min  −(w^T μ − Rf) / √(w^T Σ w)
```

RF（无风险利率）= 4% 年化。

#### 2.3.2 最小波动率

```
min  √(w^T Σ w)
w
```

#### 2.3.3 风险平价

每个资产对组合总风险的贡献均等：

```
MRC_i = (Σ w)_i / √(w^T Σ w)        # 边际风险贡献
RC_i  = w_i × MRC_i                 # 风险贡献

目标：  min Σ (RC_i − σ_组合 / n)²
```

风险平价确保对所有资产 `i, j` 有 `RC_i = RC_j`。

#### 2.3.4 层次风险平价（HRP）

```
1. 从收益率计算相关系数矩阵
2. 构建层次聚类树（Ward 链接）
3. 对协方差矩阵进行拟对角化
4. 递归二等分分配：
   - 按聚类顺序排序资产
   - 递归分配风险预算
5. 权重：w_i ∝ 1 / σ_i²  （逆方差，使用聚类排序）
```

#### 2.3.5 Black-Litterman 模型

```
Δ    = 2.5          # 风险厌恶系数
π    = Δ × Σ × w_eq # 隐含均衡收益
        (w_eq = 等权重作为市场先验)

max  (w^T π − Rf) / √(w^T Σ w)
w
```

BL 模型将市场隐含均衡收益与投资者观点结合。当前使用等权重市场先验，无自定义观点向量。

#### 2.3.6 目标收益

```
min  √(w^T Σ w)
w

subject to: Σw_i = 1,  w^T μ = r_target,  0 ≤ w_i ≤ 1
```

#### 2.3.7 等权重（1/N）

```
w_i = 1/n  对所有 i
```

### 2.4 有效前沿

通过从 `最小波动收益` 到 `最大收益 × 0.95` 改变目标收益构建：

```
对每个目标收益 t：
  min  √(w^T Σ w)
  s.t. Σw_i = 1,  w^T μ = t,  0 ≤ w_i ≤ 1

输出：40 个点（波动率, 收益, 夏普比率）
```

---

## 3. 风险指标

### 3.1 入口点

| 层级 | 文件路径 | 包含指标 |
|---|---|---|
| C++ UI | `screens/portfolio/views/PerformanceRiskView.cpp` | 夏普、索提诺、Beta、Alpha、波动率、回撤、VaR、CVaR |
| C++ UI | `screens/portfolio/views/RiskManagementView.cpp` | VaR、CVaR、集中度、压力测试 |
| C++ UI | `screens/portfolio/views/PortfolioOptimizationView.cpp` | 风险分解、压力情景 |

### 3.2 夏普比率

```
夏普 = (R_p − R_f) / σ_p

R_p   = 组合年化收益率（来自快照序列）
σ_p   = 组合年化波动率
R_f   = 4%（无风险利率）

日度计算：  日均收益 − 4%/252
日度波动率：  σ_daily = σ × √252

颜色编码：
  ≥ 1.0  → 绿色 （强风险调整收益）
  0–1.0  → 黄色
  < 0    → 红色
```

### 3.3 索提诺比率

```
索提诺 = (R_p − R_f) / σ_d

σ_d = 下行标准差 = √(Σ min(r_i, 0)² / n)
```

只将负收益视为风险。公式与夏普类似，但使用下行标准差替代总波动率。

### 3.4 Beta

```
β = Cov(R_p, R_m) / Var(R_m)

由于完整市场数据不可用，使用代理值：
  日均市场收益 ≈ 8%/252（年化市场假设）

β ≈ 组合日均收益 / 日均市场收益
约束在：[−3.0, 5.0]
```

Beta > 1 表示组合比市场波动大；Beta < 1 表示敏感度更低。

### 3.5 Alpha

```
Alpha = 组合年化收益 − 8%（基准）

从快照年化：
  总收益 = (期末 − 期初) / 期初
  年化收益 = 总收益 × 365 / 天数
  Alpha = 年化收益 − 0.08
```

正 Alpha 表示相对于 8% 年化基准的超额表现。

### 3.6 年化波动率

```
σ_年化 = σ_日度 × √252

其中 σ_日度 = √(Σ(r_i − r̄)² / n)   # 日度收益率的样本标准差
```

### 3.7 最大回撤

```
t 时刻的回撤 = (历史峰值_t − 价值_t) / 历史峰值_t
最大回撤 = 所有时刻回撤中的最大值
```

从组合净值快照追踪。峰值是净值序列的历史高点。

### 3.8 风险价值（VaR）— 参数法（正态分布）

```
VaR_95% = 组合市值 × σ_日度 × 1.645 / 100

1.645 = 95% 单尾置信的 z-score
σ_日度 = 日度波动率代理（来自日度变化百分比）
```

这是 **1 日、95% 参数法 VaR** — 假设日度收益率服从正态分布。

### 3.9 条件 VaR（期望短缺）

```
CVaR_95% = VaR × (φ(1.645) / 0.05) ≈ VaR × 1.546

φ(z) = z = 1.645 处的标准正态 PDF = 0.1031
0.05 = (1 − 0.95)
```

CVaR 是损失超过 VaR 阈值的条件期望损失。对正态分布，CVaR/VaR = φ(z)/(2×(1−z×φ(z)−Φ(z))) ≈ 1.546。

---

## 4. 衍生品定价

### 4.1 入口点

| 层级 | 文件路径 | 工具 |
|---|---|---|
| C++ UI | `screens/derivatives/DerivativesScreen.h/.cpp` | 债券、股票期权、外汇期权、利率互换、信用违约互换 |
| Python 引擎 | `scripts/derivatives_pricing.py` | 全部定价 + 希腊字母 |

### 4.2 Black-Scholes-Merton（BSM）期权定价

```
d1 = [ln(S/K) + (r − q + 0.5σ²)T] / (σ√T)
d2 = d1 − σ√T

看涨期权 = S·e^(−qT)·N(d1) − K·e^(−rT)·N(d2)
看跌期权 = K·e^(−rT)·N(−d2) − S·e^(−qT)·N(−d1)

其中：
  S  = 标的价格
  K  = 行权价
  T  = 到期时间（年）
  r  = 无风险利率（年化）
  q  = 股息率（年化）
  σ  = 波动率（年化）
  N() = 标准正态累积分布函数
```

### 4.3 希腊字母

由 BSM 偏导数推导：

| 希腊字母 | 公式 | 含义 |
|---|---|---|
| **Delta (Δ)** | ∂V/∂S = e^(−qT)·N(d1) [看涨] | 价格对标的的敏感度 |
| **Gamma (Γ)** | ∂²V/∂S² = e^(−qT)·φ(d1)/(S·σ·√T) | Delta 的敏感度 — 看涨看跌相同 |
| **Theta (Θ)** | ∂V/∂t（按天） | 时间衰减 — 除以 365 |
| **Vega (ν)** | ∂V/∂σ（每 1% 变动） | 对波动率的敏感度 — 缩放 ×0.01 |
| **Rho (ρ)** | ∂V/∂r（每 1% 变动） | 对利率的敏感度 — 缩放 ×0.01 |

### 4.4 隐含波动率

```
已知：S, K, T, r, 市场价格, q, 期权类型

求 σ，使得：BSM价格(S,K,T,r,σ,q,类型) = 市场价格

方法：Brent 求根法（scipy.optimize.brentq）
  搜索区间：[0.001, 10.0]
  容差：1e-8
```

### 4.5 Garman-Kohlhagen（外汇期权）

```
d1 = [ln(S/K) + (r_d − r_f + 0.5σ²)T] / (σ√T)
d2 = d1 − σ√T

看涨期权 = S·e^(−r_f T)·N(d1) − K·e^(−r_d T)·N(d2)
看跌期权 = K·e^(−r_d T)·N(−d2) − S·e^(−r_f T)·N(−d1)

其中 r_d = 本币利率，r_f = 外币利率
```

对 BSM 模型修改用于外汇 — 使用两个独立的利率而非单一的持有成本。

### 4.6 债券定价

```
现值 = Σ (C / (1+y/f)^(f×t_i)) + F/(1+y/f)^(f×T)

C    = 每期票息
y    = 到期收益率（年化）
f    = 每年付息次数
T    = 剩余到期年限
F    = 面值（100）

全价 = 票息现值 + 面值现值
净价 = 全价 − 应计利息

麦考林久期 = Σ [t_i × PV(C_i)] / 全价
凸性 = Σ [t_i² × PV(C_i)] / (全价 × (1+y/f)²)
```

### 4.7 利率互换估值

```
固定腿现值 = Σ (固定利率 × 计息期 × 名义本金 × e^(−r×t_i))
浮动腿现值 = 名义本金 × (1 − e^(−r×T))
互换价值 = 浮动腿现值 − 固定腿现值

平价互换利率 = (1 − e^(−rT)) / Σ 计息期×e^(−r×t_i)
```

单曲线估值，年复利。固定腿 = 固定票息序列；浮动腿 = 到期面值。

### 4.8 信用违约互换（CDS）

```
风险率 (λ) = 利差 / (1 − 回收率)

保费腿现值 = Σ (利差 × 计息期 × 名义 × S(t_i) × e^(−r×t_i))
  S(t) = 生存概率 = e^(−λt)

保护腿现值 = Σ (LGD × 名义 × (S(t_{i−1}) − S(t_i)) × e^(−r×t_i))
  LGD = 1 − 回收率

期初价值 = 保护腿现值 − 保费腿现值
盈亏平衡点差 = 保护腿现值 / 年金现值
```

按季度支付保费，保护腿按月度累算。

### 4.9 远期/期货定价

```
F = S × e^(c×T)

c = r − q + 存储成本 − 便利收益
  (持有成本 = 本币利率 − 外币收益率 − 存储成本 + 便利收益)
```

---

## 5. 系统架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│                        C++ Qt 应用程序                            │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ 投资组合     │  │ 风险管理     │  │ 衍生品               │  │
│  │ 优化         │  │ 视图         │  │ 屏幕                 │  │
│  │              │  │              │  │                       │  │
│  │ 有效前沿     │  │ VaR/CVaR     │  │ 债券/YTM/久期        │  │
│  │              │  │ 夏普/索提诺  │  │ Black-Scholes/Greeks  │  │
│  │              │  │ Beta/压力测试│  │ Garman-Kohlhagen FX   │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬───────────┘  │
│         │                 │                      │              │
│         └─────────────────┼──────────────────────┘              │
│                           │                                     │
│                    PythonCliService                             │
│                    (JSON 管道通信)                              │
└───────────────────────────┼─────────────────────────────────────┘
                            │
         ┌──────────────────┼──────────────────┐
         │                  │                  │
         ▼                  ▼                  ▼
┌─────────────────┐ ┌──────────────────┐ ┌────────────────────────┐
│ optimize_       │ │ derivatives_     │ │ Analytics/            │
│ portfolio_      │ │ pricing.py       │ │ equityInvestment/     │
│ weights.py      │ │                  │ │ equity_valuation/     │
│                 │ │ Black-Scholes    │ │ dcf_models.py         │
│ 最大夏普        │ │ Garman-Kohlhagen │ │                       │
│ 最小波动        │ │ 债券/YTM         │ │ corporateFinance/     │
│ 风险平价        │ │ 互换/CDS         │ │ valuation/            │
│ HRP             │ │ 远期             │ │ dcf_model.py          │
│ Black-Litterman │ │                  │ │                       │
└─────────────────┘ └──────────────────┘ └────────────────────────┘

Python 技术栈：numpy, scipy, pandas, yfinance, scipy.stats.norm, scipy.optimize
```

---

## 6. 关键源文件索引

| 组件 | 文件路径 |
|---|---|
| 投资组合优化 UI | `fincept-qt/src/screens/portfolio/views/PortfolioOptimizationView.cpp` |
| 投资组合优化引擎 | `fincept-qt/scripts/optimize_portfolio_weights.py` |
| 业绩与风险视图 | `fincept-qt/src/screens/portfolio/views/PerformanceRiskView.cpp` |
| 风险管理视图 | `fincept-qt/src/screens/portfolio/views/RiskManagementView.cpp` |
| 衍生品屏幕 | `fincept-qt/src/screens/derivatives/DerivativesScreen.h/.cpp` |
| 衍生品定价引擎 | `fincept-qt/scripts/derivatives_pricing.py` |
| 股票 DCF 模型 | `fincept-qt/scripts/Analytics/equityInvestment/equity_valuation/dcf_models.py` |
| 公司金融 DCF | `fincept-qt/scripts/Analytics/corporateFinance/valuation/dcf_model.py` |
| QuantLib 屏幕（18 模块，590+ 端点） | `fincept-qt/src/screens/quantlib/QuantLibScreen.cpp` |
| QuantLib 客户端 | `fincept-qt/src/services/quantlib/QuantLibClient.h/.cpp` |
| AI 量化实验室（qlib 集成） | `fincept-qt/scripts/ai_quant_lab/` |
| Alpha Arena 组合指标 | `fincept-qt/scripts/alpha_arena/core/portfolio_metrics.py` |
