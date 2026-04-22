# CFA-Level Analytics Implementation Guide

**FinceptTerminal — Architecture & Algorithm Reference**

---

## Overview

CFA-Level Analytics in FinceptTerminal is implemented across two layers:

- **C++ Qt UI Layer** — Professional trading terminal screens rendering risk metrics, portfolio analytics, and derivatives panels
- **Embedded Python Engine** — Financial computation via `numpy`, `scipy`, `pandas`, and `yfinance`

The two layers communicate via JSON over an internal CLI bridge (`PythonCliService`). The Python scripts are invoked with JSON input and return JSON output.

---

## 1. Discounted Cash Flow (DCF) Models

### 1.1 Architecture

DCF models live in the **Analytics** module:

```
scripts/Analytics/
├── equityInvestment/equity_valuation/dcf_models.py   # FCFF, DDM, RI models
└── corporateFinance/valuation/dcf_model.py            # Full DCF with WACC
```

The UI layer invokes these via `PythonCliService` (C++ bridge), passing company financials and receiving intrinsic value estimates. The `QuantLibScreen` also exposes DCF Valuation endpoints through its `analysis` module.

### 1.2 Algorithm Details

#### Weighted Average Cost of Capital (WACC)

```
WACC = (E/V × Re) + (D/V × Rd × (1 − Tc))

Where:
  Re = Rf + β × MRP + CountryRisk + SizePremium
  E  = Market value of equity
  D  = Market value of debt
  V  = E + D
  Tc = Corporate tax rate
```

**Implementation** (`DCFModel.calculate_wacc`):
- Cost of Equity: `Rf + β × MRP + CountryRisk + SizePremium`
- After-tax Cost of Debt: `Rd × (1 − Tc)`
- Input validation: each parameter has hard bounds (e.g., beta ∈ [0.1, 3.0], tax rate ∈ [0, 50%])

#### Beta Unleveraging / Releveraging

```
βUnlevered = βLevered / (1 + (1 − Tc) × D/E)

βRelevered = βUnlevered × (1 + (1 − Tc) × D/E_target)
```

Used to strip out the effect of the current capital structure and reapply the target structure.

#### Free Cash Flow to Firm (FCFF)

```
NOPAT = EBIT × (1 − Tax Rate)
FCFF  = NOPAT + D&A − CapEx − ΔNWC + SBC

(SBC = stock-based compensation, non-cash add-back)
```

#### Terminal Value (Gordon Growth Model)

```
TV = FCFF_final × (1 + g) / (WACC − g)

where g = terminal growth rate, constrained: g < WACC
```

Present value of terminal value:
```
PV(TV) = TV / (1 + WACC)^n
```

#### Enterprise Value to Equity Value

```
Equity Value = Enterprise Value + Cash − Total Debt − Preferred Stock
Intrinsic Value per Share = Equity Value / Shares Outstanding
```

#### Projection Engine

FCFF projections use year-by-year growth rates:
```
FCFF_n = FCFF_{n-1} × (1 + g_n)
```

Supports separate maintenance vs. growth CapEx breakdown.

---

## 2. Portfolio Optimization

### 2.1 Entry Points

| Layer | File | Role |
|---|---|---|
| C++ UI | `screens/portfolio/views/PortfolioOptimizationView.cpp` | Tab-based optimization interface |
| Python Engine | `scripts/optimize_portfolio_weights.py` | All optimization algorithms |

### 2.2 Data Fetching

```python
# Uses yfinance to download daily adjusted close prices
data = yf.download(symbols, period="1y", interval="1d", auto_adjust=True)
returns_df = close[available].pct_change().dropna()

# Annualised parameters
mean_ret = returns_df.mean().values × 252        # expected annual return vector
cov      = returns_df.cov().values × 252          # annualised covariance matrix
```

### 2.3 Optimization Strategies

All strategies solve constrained optimization via `scipy.optimize.minimize` (method: `SLSQP`):

```
minimize f(w)
subject to: Σw_i = 1,  0 ≤ w_i ≤ 1
```

#### 2.3.1 Maximum Sharpe Ratio

```
max  (w^T μ − Rf) / √(w^T Σ w)
w

Equivalent to:  min  −(w^T μ − Rf) / √(w^T Σ w)
```

RF (risk-free rate) = 4% annual.

#### 2.3.2 Minimum Volatility

```
min  √(w^T Σ w)
w
```

#### 2.3.3 Risk Parity

Each asset contributes equally to total portfolio risk:

```
MRC_i = (Σ w)_i / √(w^T Σ w)        # Marginal Risk Contribution
RC_i  = w_i × MRC_i                 # Risk Contribution

Objective:  min Σ (RC_i − σ_portfolio / n)²
```

Risk Parity ensures `RC_i = RC_j` for all assets `i, j`.

#### 2.3.4 Hierarchical Risk Parity (HRP)

```
1. Compute correlation matrix from returns
2. Build hierarchical clustering tree (Ward linkage)
3. Quasi-diagonalise the covariance matrix
4. Recursive bisection allocation:
   - Sort assets by cluster order
   - Allocate risk budget recursively
5. Weights: w_i ∝ 1 / σ_i²  (inverse variance, using clustered ordering)
```

#### 2.3.5 Black-Litterman Model

```
Δ    = 2.5          # Risk aversion coefficient
π    = Δ × Σ × w_eq # Implied equilibrium returns
        (w_eq = equal-weight as market prior)

max  (w^T π − Rf) / √(w^T Σ w)
w
```

BL blends the market-implied equilibrium with investor views. Currently uses equal-weight market prior without custom view vectors.

#### 2.3.6 Target Return

```
min  √(w^T Σ w)
w

subject to: Σw_i = 1,  w^T μ = r_target,  0 ≤ w_i ≤ 1
```

#### 2.3.7 Equal Weight (1/N)

```
w_i = 1/n  for all i
```

### 2.4 Efficient Frontier

Built by varying target return from `min_vol_return` to `max_return × 0.95`:

```
For each target return t:
  min  √(w^T Σ w)
  s.t. Σw_i = 1,  w^T μ = t,  0 ≤ w_i ≤ 1

Output: 40 points (volatility, return, Sharpe)
```

---

## 3. Risk Metrics

### 3.1 Entry Points

| Layer | File | Metrics |
|---|---|---|
| C++ UI | `screens/portfolio/views/PerformanceRiskView.cpp` | Sharpe, Sortino, Beta, Alpha, Vol, Drawdown, VaR, CVaR |
| C++ UI | `screens/portfolio/views/RiskManagementView.cpp` | VaR, CVaR, Concentration, Stress Test |
| C++ UI | `screens/portfolio/views/PortfolioOptimizationView.cpp` | Risk decomposition, stress scenarios |

### 3.2 Sharpe Ratio

```
Sharpe = (R_p − R_f) / σ_p

R_p   = annualised portfolio return (from snapshot series)
σ_p   = annualised portfolio volatility
R_f   = 4% (risk-free rate)

Daily:  daily_mean − 4%/252
Daily:  daily_vol = σ × √252

Color coding:
  ≥ 1.0  → GREEN  (strong risk-adjusted return)
  0–1.0  → YELLOW
  < 0    → RED
```

### 3.3 Sortino Ratio

```
Sortino = (R_p − R_f) / σ_d

σ_d = downside deviation = √(Σ min(r_i, 0)² / n)
```

Only negative returns are treated as risk. Identical formula to Sharpe but with downside deviation instead of total volatility.

### 3.4 Beta

```
β = Cov(R_p, R_m) / Var(R_m)

Since full market data is not available, uses a proxy:
  daily_market_return ≈ 8%/252 (annual market assumption)

β ≈ daily_mean_portfolio / daily_mean_market
Clamped to: [−3.0, 5.0]
```

Beta > 1 means portfolio is more volatile than the market; Beta < 1 means less sensitive.

### 3.5 Alpha

```
Alpha = Annualised Portfolio Return − 8% (benchmark)

Annualised from snapshots:
  total_return = (last − first) / first
  ann_return   = total_return × 365 / days
  alpha        = ann_return − 0.08
```

Positive alpha indicates outperformance vs. the 8% annual benchmark.

### 3.6 Annualised Volatility

```
σ_annual = σ_daily × √252

Where σ_daily = √(Σ(r_i − r̄)² / n)   # sample std dev of daily returns
```

### 3.7 Maximum Drawdown

```
Drawdown at time t = (Peak_t − Value_t) / Peak_t
Max Drawdown = max over all t of Drawdown_t
```

Tracked from portfolio NAV snapshots. Peak is the running maximum of the NAV series.

### 3.8 Value at Risk (VaR) — Parametric (Normal)

```
VaR_95% = Portfolio_MV × σ_daily × 1.645 / 100

1.645 = z-score for 95% one-tailed confidence
σ_daily = daily volatility proxy (from day-change %)
```

This is a **1-day, 95% parametric VaR** — assumes normally distributed daily returns.

### 3.9 Conditional VaR (Expected Shortfall)

```
CVaR_95% = VaR × (φ(1.645) / 0.05) ≈ VaR × 1.546

φ(z) = standard normal PDF at z = 1.645 = 0.1031
0.05 = (1 − 0.95)
```

CVaR is the expected loss given that the loss exceeds the VaR threshold. For a normal distribution, CVaR/VaR = φ(z)/(2×(1−z×φ(z)−Φ(z))) ≈ 1.546.

---

## 4. Derivatives Pricing

### 4.1 Entry Points

| Layer | File | Instruments |
|---|---|---|
| C++ UI | `screens/derivatives/DerivativesScreen.h/.cpp` | Bonds, Equity Options, FX Options, IR Swaps, CDS |
| Python Engine | `scripts/derivatives_pricing.py` | All pricing + Greeks |

### 4.2 Black-Scholes-Merton (BSM) Option Pricing

```
d1 = [ln(S/K) + (r − q + 0.5σ²)T] / (σ√T)
d2 = d1 − σ√T

Call = S·e^(−qT)·N(d1) − K·e^(−rT)·N(d2)
Put  = K·e^(−rT)·N(−d2) − S·e^(−qT)·N(−d1)

Where:
  S  = spot price
  K  = strike price
  T  = time to expiry (years)
  r  = risk-free rate (annual)
  q  = dividend yield (annual)
  σ  = volatility (annual)
  N() = standard normal CDF
```

### 4.3 Greeks

From BSM partial derivatives:

| Greek | Formula | Interpretation |
|---|---|---|
| **Delta (Δ)** | ∂V/∂S = e^(−qT)·N(d1) [call] | Price sensitivity vs. spot |
| **Gamma (Γ)** | ∂²V/∂S² = e^(−qT)·φ(d1)/(S·σ·√T) | Delta sensitivity — same for call/put |
| **Theta (Θ)** | ∂V/∂t (per day) | Time decay — divided by 365 |
| **Vega (ν)** | ∂V/∂σ per 1% move | Sensitivity to vol — scaled ×0.01 |
| **Rho (ρ)** | ∂V/∂r per 1% move | Sensitivity to rate — scaled ×0.01 |

### 4.4 Implied Volatility

```
Given: S, K, T, r, market_price, q, option_type

Find σ such that: BSM_price(S,K,T,r,σ,q,type) = market_price

Method: Brent's root-finding (scipy.optimize.brentq)
  search interval: [0.001, 10.0]
  tolerance: 1e-8
```

### 4.5 Garman-Kohlhagen (FX Options)

```
d1 = [ln(S/K) + (r_d − r_f + 0.5σ²)T] / (σ√T)
d2 = d1 − σ√T

Call = S·e^(−r_f T)·N(d1) − K·e^(−r_d T)·N(d2)
Put  = K·e^(−r_d T)·N(−d2) − S·e^(−r_f T)·N(−d1)

Where r_d = domestic rate, r_f = foreign rate
```

Modified BSM for FX — accounts for two separate interest rates instead of a single cost-of-carry.

### 4.6 Bond Pricing

```
PV = Σ (C / (1+y/f)^(f×t_i)) + F/(1+y/f)^(f×T)

C    = coupon per period
y    = YTM (annual)
f    = coupon frequency per year
T    = time to maturity in years
F    = face value (100)

Dirty Price = PV of coupons + PV of par
Clean Price = Dirty Price − Accrued Interest

Macaulay Duration = Σ [t_i × PV(C_i)] / Dirty Price
Convexity         = Σ [t_i² × PV(C_i)] / (Dirty Price × (1+y/f)²)
```

### 4.7 Interest Rate Swap Valuation

```
Fixed Leg PV = Σ (fixed_rate × dt × notional × e^(−r×t_i))
Floating Leg PV = notional × (1 − e^(−r×T))
Swap Value = Floating PV − Fixed PV

Par Swap Rate = (1 − e^(−rT)) / Σ dt×e^(−r×t_i)
```

Single-curve valuation with annual compounding. Fixed leg = series of fixed coupons; floating leg = par notional at maturity.

### 4.8 Credit Default Swap (CDS)

```
Hazard Rate (λ) = Spread / (1 − Recovery)

Premium Leg PV = Σ (spread × dt × notional × S(t_i) × e^(−r×t_i))
  S(t) = survival probability = e^(−λt)

Protection Leg PV = Σ (LGD × notional × (S(t_{i−1}) − S(t_i)) × e^(−r×t_i))
  LGD = 1 − Recovery Rate

Upfront Value = Protection PV − Premium PV
Breakeven Spread = Protection PV / Annuity PV
```

Quarterly premium payments, monthly protection leg accrual.

### 4.9 Forward/Futures Pricing

```
F = S × e^(c×T)

c = r − q + storage − convenience
  (cost of carry = domestic rate − foreign yield − storage + convenience yield)
```

---

## 5. System Architecture Summary

```
┌──────────────────────────────────────────────────────────────────┐
│                      C++ Qt Application                          │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ Portfolio    │  │ Risk Mgmt    │  │ Derivatives           │  │
│  │ Optimisation │  │ View         │  │ Screen                │  │
│  │ View         │  │              │  │                       │  │
│  │              │  │ VaR/CVaR     │  │ Bond/YTM/Duration    │  │
│  │ Efficient    │  │ Sharpe/      │  │ Black-Scholes/Greeks  │  │
│  │ Frontier     │  │ Sortino/Beta │  │ Garman-Kohlhagen FX   │  │
│  │              │  │ Stress Test  │  │ Swap & CDS pricing    │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬───────────┘  │
│         │                 │                      │              │
│         └─────────────────┼──────────────────────┘              │
│                           │                                     │
│                    PythonCliService                             │
│                    (JSON over pipe)                             │
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
│ Max Sharpe      │ │ Garman-Kohlhagen │ │                       │
│ Min Vol         │ │ Bond/YTM         │ │ corporateFinance/     │
│ Risk Parity     │ │ Swap/CDS         │ │ valuation/            │
│ HRP             │ │ Forward          │ │ dcf_model.py          │
│ Black-Litterman │ │                  │ │                       │
└─────────────────┘ └──────────────────┘ └────────────────────────┘

Python Stack: numpy, scipy, pandas, yfinance, scipy.stats.norm, scipy.optimize
```

---

## 6. Key Source Files Reference

| Component | File Path |
|---|---|
| Portfolio Optimization UI | `fincept-qt/src/screens/portfolio/views/PortfolioOptimizationView.cpp` |
| Portfolio Optimization Engine | `fincept-qt/scripts/optimize_portfolio_weights.py` |
| Performance & Risk View | `fincept-qt/src/screens/portfolio/views/PerformanceRiskView.cpp` |
| Risk Management View | `fincept-qt/src/screens/portfolio/views/RiskManagementView.cpp` |
| Derivatives Screen | `fincept-qt/src/screens/derivatives/DerivativesScreen.h/.cpp` |
| Derivatives Pricing Engine | `fincept-qt/scripts/derivatives_pricing.py` |
| Equity DCF Models | `fincept-qt/scripts/Analytics/equityInvestment/equity_valuation/dcf_models.py` |
| Corporate Finance DCF | `fincept-qt/scripts/Analytics/corporateFinance/valuation/dcf_model.py` |
| QuantLib Screen (18 modules, 590+ endpoints) | `fincept-qt/src/screens/quantlib/QuantLibScreen.cpp` |
| QuantLib Client | `fincept-qt/src/services/quantlib/QuantLibClient.h/.cpp` |
| AI Quant Lab (qlib integration) | `fincept-qt/scripts/ai_quant_lab/` |
| Alpha Arena Portfolio Metrics | `fincept-qt/scripts/alpha_arena/core/portfolio_metrics.py` |
