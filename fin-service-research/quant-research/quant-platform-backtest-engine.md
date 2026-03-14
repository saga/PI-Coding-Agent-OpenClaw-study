# Quant 平台模块细化：回测引擎设计

> 日期：2026-03-14
> 覆盖：向量化回测、事件驱动回测、回测质量保障

---

## 一、两种回测模式

| 模式 | 速度 | 真实度 | 适用场景 |
|------|------|--------|---------|
| 向量化回测 | 快（秒级） | 低（忽略执行细节） | 因子研究初期筛选，参数扫描 |
| 事件驱动回测 | 慢（分钟级） | 高（模拟逐笔执行） | 策略上线前最终验证 |

---

## 二、向量化回测引擎

### 2.1 核心数据结构

```python
from dataclasses import dataclass
import pandas as pd

@dataclass
class BacktestConfig:
    start_date:      str
    end_date:        str
    rebalance_freq:  str = "monthly"   # daily / weekly / monthly
    universe:        str = "liquid_universe_v2"
    benchmark:       str = "MSCI_ACWI"
    initial_capital: float = 1_000_000_000  # 10 亿

@dataclass
class BacktestResult:
    returns:          pd.Series       # 组合日收益率
    positions:        pd.DataFrame    # 每期持仓权重
    turnover:         pd.Series       # 每期换手率
    factor_exposures: pd.DataFrame    # 每期因子暴露
    attribution:      pd.DataFrame    # 绩效归因
    stats:            dict            # 汇总统计（Sharpe、最大回撤等）
```

### 2.2 向量化回测核心流程

```python
class VectorizedBacktester:

    def run(
        self,
        signal: pd.DataFrame,        # index=date, columns=ticker, values=因子值
        config: BacktestConfig,
        cost_model: CostModel,
        optimizer: PortfolioOptimizer
    ) -> BacktestResult:

        rebalance_dates = self._get_rebalance_dates(config)
        positions = pd.DataFrame()

        for date in rebalance_dates:
            # 1. 获取点对点数据（防前视偏差）
            universe = self.pit_db.get_universe(date, config.universe)
            signal_t = signal.loc[date, universe].dropna()

            # 2. 组合优化
            weights = optimizer.optimize(
                signal    = signal_t,
                risk_model= self.risk_model.get(date),
                constraints= config.constraints
            )

            # 3. 计算换手率和交易成本
            prev_weights = positions.iloc[-1] if len(positions) > 0 else None
            turnover = self._compute_turnover(prev_weights, weights)
            cost = cost_model.estimate(turnover, date)

            positions.loc[date] = weights

        # 4. 计算收益率序列
        returns = self._compute_returns(positions, cost_model)

        # 5. 绩效归因
        attribution = self._brinson_attribution(positions, config.benchmark)

        return BacktestResult(
            returns=returns,
            positions=positions,
            turnover=self._compute_turnover_series(positions),
            attribution=attribution,
            stats=self._compute_stats(returns)
        )
```

### 2.3 交易成本模型

```python
class CostModel:
    """
    交易成本模型：冲击成本 + 借贷成本 + 税费
    """

    def estimate(self, turnover: pd.Series, date: date) -> float:
        # 1. 市场冲击成本（与成交量相关）
        # 使用 Almgren-Chriss 模型的简化版
        impact_cost = 0.0
        for ticker, trade_size in turnover.items():
            adv = self.adv_data.loc[date, ticker]  # 日均成交量
            participation_rate = abs(trade_size) / adv
            # 冲击成本随参与率的平方根增长
            impact_cost += 0.1 * participation_rate ** 0.5 * abs(trade_size)

        # 2. 借贷成本（做空时）
        short_positions = turnover[turnover < 0]
        borrow_cost = short_positions.abs().sum() * self.borrow_rate / 252

        # 3. 佣金和税费
        commission = turnover.abs().sum() * self.commission_rate

        return impact_cost + borrow_cost + commission
```

### 2.4 绩效归因（Brinson 归因）

```
Brinson 归因将超额收益分解为三部分：

超额收益 = 配置效应 + 选股效应 + 交互效应

配置效应（Allocation Effect）：
  因为行业权重偏离基准而产生的收益
  = (组合行业权重 - 基准行业权重) × (基准行业收益 - 基准总收益)

选股效应（Selection Effect）：
  在同一行业内，因为选股不同而产生的收益
  = 基准行业权重 × (组合行业收益 - 基准行业收益)

交互效应（Interaction Effect）：
  配置和选股共同作用
  = (组合行业权重 - 基准行业权重) × (组合行业收益 - 基准行业收益)
```

---

## 三、事件驱动回测引擎

### 3.1 架构设计

```
事件驱动回测引擎核心组件：

┌─────────────────────────────────────────────────────┐
│                  事件驱动回测引擎                      │
│                                                     │
│  [事件队列]          [策略逻辑]        [执行模拟]      │
│  ├── MarketEvent    ├── on_bar()      ├── 订单簿模拟  │
│  ├── SignalEvent    ├── on_signal()   ├── 滑点模型    │
│  ├── OrderEvent     └── on_fill()    └── 部分成交    │
│  └── FillEvent                                      │
│                                                     │
│  [数据处理器]        [组合管理器]      [风险管理器]     │
│  ├── 历史数据回放    ├── 持仓追踪      ├── 仓位限制    │
│  └── 点对点数据      └── 现金管理     └── 止损逻辑    │
└─────────────────────────────────────────────────────┘
```

### 3.2 执行算法模拟

```python
class TWAPExecutor:
    """
    TWAP（时间加权平均价格）执行算法模拟
    将大单拆分为多个小单，在指定时间窗口内均匀执行
    """

    def execute(
        self,
        order: Order,
        market_data: MarketData,
        execution_window_minutes: int = 60
    ) -> list[Fill]:

        fills = []
        slices = execution_window_minutes  # 每分钟执行一份
        slice_size = order.quantity / slices

        for i in range(slices):
            minute_data = market_data.get_minute_bar(order.ticker, i)

            # 滑点模型：成交价 = VWAP ± 随机滑点
            slippage = self._estimate_slippage(slice_size, minute_data.volume)
            fill_price = minute_data.vwap + slippage * order.direction

            fills.append(Fill(
                ticker    = order.ticker,
                quantity  = slice_size,
                price     = fill_price,
                timestamp = minute_data.timestamp
            ))

        return fills
```

---

## 四、回测质量保障

### 4.1 前视偏差检测

```python
class LookAheadBiasDetector:
    """自动检测回测代码中的前视偏差"""

    def check(self, backtest_code: str) -> list[Warning]:
        warnings = []

        # 检查 1：是否使用了点对点数据库
        if "pit_db" not in backtest_code:
            warnings.append(Warning(
                level="ERROR",
                message="未使用点对点数据库，存在前视偏差风险"
            ))

        # 检查 2：财务数据是否有延迟
        if re.search(r'financial_data.*period_end.*<=.*date', backtest_code):
            warnings.append(Warning(
                level="ERROR",
                message="使用 period_end 过滤财务数据，应使用 available_date"
            ))

        # 检查 3：是否使用了未来数据
        future_patterns = [
            r'shift\(-\d+\)',      # 负数 shift = 使用未来数据
            r'future_return',
            r'next_period'
        ]
        for pattern in future_patterns:
            if re.search(pattern, backtest_code):
                warnings.append(Warning(
                    level="ERROR",
                    message=f"检测到可能的前视偏差：{pattern}"
                ))

        return warnings
```

### 4.2 幸存者偏差处理

```
幸存者偏差的来源：
  只使用当前存在的股票做回测
  忽略了历史上退市、被收购、破产的公司
  → 导致回测收益虚高（因为"坏"公司已经消失了）

解决方案：
  使用含退市股的完整历史成分股数据
  数据要求：
  ├── 记录每只股票的上市日期和退市日期
  ├── 退市原因（破产/被收购/主动退市）
  └── 退市前的最后价格（用于计算最终收益）

验证方法：
  对比"含退市股"和"不含退市股"的回测结果
  差异 > 2% 年化收益 → 幸存者偏差显著
```

### 4.3 Walk-Forward 验证框架

```
Walk-Forward 验证防止过拟合：

传统回测（有过拟合风险）：
  训练期：2005-2020（15年）→ 优化参数
  测试期：2020-2024（4年）→ 验证
  问题：测试期只有一次，可能运气好

Walk-Forward 验证：
  窗口 1：训练 2005-2012，测试 2013
  窗口 2：训练 2006-2013，测试 2014
  窗口 3：训练 2007-2014，测试 2015
  ...
  窗口 N：训练 2016-2023，测试 2024

  每个窗口独立优化参数，测试期不参与优化
  最终结果 = 所有测试期的拼接收益序列
  → 更真实反映策略的样本外表现
```

### 4.4 多重假设检验（防止数据挖掘）

```
问题：测试 100 个因子，即使随机，也有 5 个会在 5% 显著性水平下"显著"

解决方案：Bonferroni 校正 / BHY 校正

BHY 校正（Benjamini-Hochberg-Yekutieli）：
  1. 将所有因子的 p-value 从小到大排序
  2. 计算调整后的显著性阈值：α × k / (N × C(N))
     其中 k = 排名，N = 总测试数，C(N) = Σ(1/i)
  3. 只有通过调整后阈值的因子才认为显著

实践建议：
  - 记录所有测试过的因子（包括失败的）
  - 使用 t-statistic > 3.0（而非 > 2.0）作为显著性标准
  - 要求样本外验证（不同时间段、不同市场）
```

---

## 五、回测报告标准

每次回测必须输出标准化报告，包含：

| 指标 | 说明 |
|------|------|
| 年化收益率 | 几何平均年化 |
| 年化波动率 | 日收益率标准差 × √252 |
| Sharpe Ratio | (年化收益 - 无风险利率) / 年化波动 |
| 最大回撤 | 峰值到谷值的最大跌幅 |
| Calmar Ratio | 年化收益 / 最大回撤 |
| 年均换手率 | 双边换手率 |
| 平均持仓数 | 每期平均持有股票数 |
| IC 均值 / ICIR | 因子预测能力 |
| 因子暴露 | 对 Barra 风格因子的暴露 |
| 分年度收益 | 每年的收益率（识别特定年份异常） |

---

*参考来源：Almgren-Chriss 市场冲击模型、Brinson-Hood-Beebower 归因模型、Harvey et al. (2016) 多重假设检验论文、QuantConnect LEAN 回测引擎设计*
