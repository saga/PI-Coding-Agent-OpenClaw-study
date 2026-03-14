# Quant Research 研究计划 TODO

> 创建日期：2026-03-14
> 目标：系统性研究量化研究平台的竞争格局、功能设计和技术架构

---

## 一、竞争对手分析

### 1.1 专注量化/系统化投资的平台

- [x] **Two Sigma Venn** — 另类数据市场 + 因子分析平台，面向机构投资者 → `quant-remaining-competitors.md`
- [x] **Axioma (SimCorp)** — 风险模型 + 组合优化 → `barra-axioma-risk-models.md`
- [x] **Barra (MSCI)** — 多因子风险模型，行业标准 → `barra-axioma-risk-models.md`
- [x] **FactSet Alpha Testing** — 因子回测和 Alpha 研究模块 → `quant-competitive-landscape.md`
- [x] **Bloomberg PORT** — 组合分析和风险归因（Bloomberg 量化模块）→ `quant-remaining-competitors.md`
- [x] **Refinitiv Eikon Quant** — LSEG 旗下量化研究工具 → `quant-remaining-competitors.md`
- [x] **Qontigo (SimCorp)** — Axioma 风险模型 + STOXX 指数 → `barra-axioma-risk-models.md`

### 1.2 另类数据平台（量化 Alpha 来源）

- [x] **Quandl (Nasdaq Data Link)** — 另类数据市场 → `alternative-data-platforms.md`
- [x] **YipitData** — 消费数据、电商数据 → `alternative-data-platforms.md`
- [x] **Eagle Alpha** — 另类数据目录和评估平台 → `alternative-data-platforms.md`
- [x] **Neudata** — 另类数据搜索引擎 → `alternative-data-platforms.md`

### 1.3 量化回测/研究框架（开源 + 商业）

- [x] **QuantConnect (LEAN)** — 云端量化回测平台，开源引擎 → `quantconnect-lean.md`
- [x] **Quantopian 遗产分析** — 已关闭，但其设计理念影响深远 → `quant-remaining-competitors.md`
- [x] **Kensho (S&P Global)** — AI 驱动的量化分析，NLP + 事件研究 → `numerai-boosted-kensho.md`
- [x] **Numerai** — 众包量化模型平台，Meta-Model 架构 → `numerai-boosted-kensho.md`

### 1.4 AI/LLM 驱动的量化新兴平台

- [x] **Alpha-GPT / LLMQuant** — LLM 辅助因子发现，学术前沿 → `quant-remaining-competitors.md`
- [x] **Boosted.ai** — Agentic AI 投研平台 → `numerai-boosted-kensho.md`
- [x] **Kavout** — AI 量化评分（Kai Score）→ `quant-remaining-competitors.md`
- [x] **Sentient Investment Management** — 进化算法 + AI 量化 → `quant-remaining-competitors.md`

---

## 二、Research Platform 功能设计

> 文档：`fin-service-research/research-platform/research-platform-functional-design.md`

### 2.1 核心功能模块

- [x] **文档管理与搜索**（SuperSearch 深化）
  - 结构化 vs 非结构化文档统一检索
  - 权限控制（Chinese Wall）完整方案
  - 文档版本管理和生命周期

- [x] **量化研究支持模块**
  - 研究报告与量化信号的关联（NLP → 因子）
  - 分析师观点结构化提取（从 PDF 到数据库）
  - 研究知识图谱（公司/行业/分析师关系网络）

- [x] **数据发现与目录（Data Catalog）**
  - 内部数据资产目录
  - 外部数据源评估和接入流程
  - 数据血缘（Data Lineage）追踪

- [x] **协作与工作流**
  - 研究员协作工具（评论、标注、版本对比）
  - 研究发布审批流程
  - 跨团队知识共享（在合规约束下）

### 2.2 AI 增强功能

- [x] **智能摘要**：自动生成研究报告摘要
- [x] **观点追踪**：追踪分析师对某公司/行业观点的历史变化
- [x] **信号提取**：从研究文本中自动提取买卖信号、目标价
- [x] **问答系统**：基于内部研究库的 RAG 问答（SuperSearch 升级版）
- [x] **研究推荐**：基于用户行为推荐相关研究报告

### 2.3 量化与基本面研究融合

- [x] 基本面研究报告 → 量化因子的转化流程
- [x] 分析师预期数据与量化模型的集成
- [x] 事件驱动研究（财报、并购）与量化信号的联动

---

## 三、Quant 平台模块细化

### 3.1 数据层 → `quant-platform-data-layer.md`

- [x] **点对点数据库（Point-in-Time DB）设计**
- [x] **另类数据接入框架**
- [x] **实时数据流处理**

### 3.2 因子库 → `quant-platform-factor-library.md`

- [x] **因子分类体系**（Factor Zoo，含 A 股特殊因子）
- [x] **因子计算标准化框架**（去极值、行业/市值中性化、多市场适配）
- [x] **因子评估体系**（IC/ICIR、衰减曲线、相关性矩阵、分组回测）
- [x] **因子图书馆管理**（版本控制、注册规范、上线/下线流程）
- [x] **多因子合成**（等权、ICIR 加权、ML 合成对比）

### 3.3 回测引擎 → `quant-platform-backtest-engine.md`

- [x] **向量化回测引擎设计**（核心数据结构、交易成本模型、Brinson 归因）
- [x] **事件驱动回测引擎**（TWAP 执行模拟、滑点模型）
- [x] **回测质量保障**（前视偏差检测、幸存者偏差、Walk-Forward、多重假设检验）

### 3.4 MLOps 平台 → `quant-platform-mlops.md`

- [x] **实验追踪系统**（MLflow 规范、参数敏感性分析）
- [x] **特征存储**（Feast 设计、离线/在线一致性）
- [x] **模型上线流程**（审批流程、A/B 测试、蓝绿部署、回滚）
- [x] **模型监控**（Alpha 衰减检测、数据漂移 PSI、监控仪表盘）

### 3.5 组合优化与风险管理 → `quant-platform-portfolio-optimization.md`

- [x] **组合优化器**（MVO、风险平价、Black-Litterman，含约束处理）
- [x] **风险模型**（自建 vs 购买决策、A 股补充模型、压力测试、CVaR）

### 3.6 研究环境 → `quant-platform-portfolio-optimization.md`

- [x] **JupyterHub 平台设计**（多用户隔离、GPU 实例、权限控制）
- [x] **Research SDK**（标准化数据访问 API、因子计算工具、可视化组件）

---

## 四、其他新话题

### 4.1 行业趋势与前沿

- [x] **AI Agent 在量化投资中的应用** → `quant-industry-trends.md`
  - 自主因子发现（Alpha-GPT 范式深化）
  - 多 Agent 协作研究框架
  - LLM 辅助代码生成（量化研究员的 Copilot）

- [x] **大模型金融微调（FinLLM）** → `quant-industry-trends.md`
  - BloombergGPT 分析
  - FinBERT 系列模型
  - 自建金融 LLM 的可行性评估

- [x] **量化 ESG 投资** → `quant-industry-trends.md`
  - ESG 因子构建方法论
  - ESG 数据质量问题
  - ESG 与传统因子的融合策略

- [x] **加密资产量化研究** → `quant-industry-trends.md`
  - 链上数据（On-chain Data）作为另类因子
  - DeFi 协议数据
  - 加密市场微观结构

### 4.2 Fidelity International 专项

- [x] **Fidelity 量化研究现状调研** → `quant-fidelity-specific.md`
  - 现有量化团队规模和能力
  - 已有系统和工具盘点
  - 与竞争对手的差距分析

- [x] **Fidelity 多资产量化策略** → `quant-fidelity-specific.md`
  - 股票 + 固定收益 + 多资产的统一因子框架
  - 跨资产类别的风险模型
  - 目标日期基金的量化优化

- [x] **Fidelity 亚太市场量化挑战** → `quant-fidelity-specific.md`
  - 中国 A 股市场特殊性（涨跌停、T+1、退市制度）
  - 亚太数据质量和覆盖率问题
  - 多语言研究文档处理（中文、日文、韩文）

### 4.3 技术架构专题

- [x] **云原生量化平台架构** → `quant-tech-architecture.md`
  - AWS/Azure 上的量化平台设计
  - 成本优化（Spot 实例用于回测）
  - 多云策略

- [x] **实时量化信号系统** → `quant-tech-architecture.md`
  - 低延迟架构设计
  - 流式因子计算
  - 实时风险监控

- [x] **量化平台安全与合规** → `quant-tech-architecture.md`
  - 数据访问审计
  - 模型可解释性（监管要求）
  - 算法交易合规框架

---

## 执行优先级建议

| 优先级 | 任务 | 理由 |
|--------|------|------|
| P0 | 点对点数据库设计 | 一切量化研究的基础 |
| P0 | 因子库框架 + 评估体系 | 核心研究工具 |
| P1 | 回测引擎详细设计 | 验证因子有效性的关键 |
| P1 | 竞争对手：Axioma/Barra 分析 | 风险模型选型依据 |
| P1 | Research Platform 量化支持模块 | 基本面与量化融合 |
| P2 | MLOps 平台细化 | 模型工程化 |
| P2 | AI Agent 量化应用 | 前沿趋势 |
| P3 | 其他新话题 | 扩展视野 |

---

*此计划为动态文档，随研究进展持续更新*
