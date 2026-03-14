# Bloomberg Terminal + ASKB 详细分析

> 来源：Bloomberg 官方公告、Markets Media、Forrester Blog、fi-desk.com
> 更新：2026 年 3 月

---

## 基本信息

| 项目 | 详情 |
|------|------|
| 公司 | Bloomberg L.P.（私有公司） |
| 产品 | Bloomberg Professional Service（Terminal）+ ASKB |
| 成立 | 1981 年 |
| 用户规模 | 约 32.5 万订阅用户 |
| 年费 | $24,240–$27,660/席位（两年合约） |
| 市场份额 | 约 33.4%（金融数据市场） |
| 目标用户 | 买方基金经理、卖方交易员、固定收益分析师、资产管理公司 |

---

## 核心产品能力

### 数据覆盖
- 全资产类别实时行情：股票、债券、外汇、大宗商品、衍生品
- 固定收益数据：Bloomberg BVAL 估值，业界最权威
- 新闻：Bloomberg News（每日 5,000 条原创报道 + 110 万条精选报道）
- 卖方研究：800+ 研究机构，含全球顶级投行
- Bloomberg Intelligence、BloombergNEF、Bloomberg Economics 自有研究
- 数亿份公司文件（财报、SEC 文件、电话会议记录）

### 核心工具
- Bloomberg Terminal 函数库（数千个专业函数）
- Bloomberg Query Language（BQL）：自定义数据查询
- Excel 插件（Bloomberg Add-in）
- Bloomberg Chat（IB）：金融专业人士即时通讯网络
- BQuant：Python 量化研究环境
- PORT：组合分析与风险归因

### 竞争优势
1. **固定收益数据无可替代**：BVAL 估值、债券流动性指标、信用利差数据是行业标准
2. **Bloomberg Chat 网络效应**：35 万用户的即时通讯网络，交易员报价、研究分发都在这里
3. **数据深度与广度**：覆盖全球所有主要市场，历史数据追溯数十年
4. **品牌信任**：机构投资者对 Bloomberg 数据的信任度极高，是"单一事实来源"

### 主要弱点
- 价格昂贵（$24K+/席位），中小机构难以承受
- 界面复杂，学习曲线陡峭，非交易员用户体验差
- 文本搜索能力弱：相同查询，Bloomberg 搜索结果远少于 AlphaSense
- 不原生提供专家电话记录（Expert Call Transcripts）
- 缺乏对非结构化研究内容的深度 AI 分析

---

## AI 战略：ASKB（2025-2026）

### 产品定位
ASKB 是 Bloomberg 于 2026 年 3 月推出的 Agentic AI 对话界面（Beta 版），被 Forrester 评为"受监管、数据密集型领域 Agentic AI 的先进案例"。

### 技术架构
- **多 Agent 系统**：由领域专用检索 Agent + 编排器（Orchestrator）组成
- **多 LLM 混合**：同时使用多个商业和开源大语言模型
- **数据基础**：所有回答基于 Bloomberg 专有数据，附带透明来源引用
- **BQL 代码生成**：AI 回答中自动生成 Bloomberg Query Language 代码，可直接在 Excel/BQuant 中使用

### 核心功能
1. **对话式 AI 查询**：自然语言提问，获取综合性回答
2. **ASKB Workflows**：多步骤研究工作流自动化（财报前准备、财报后分析、会议准备等）
3. **工作流模板库**：可保存、复用、跨团队共享工作流
4. **数据可视化**：自动生成图表，标注关键事件
5. **文档上传分析**：用户可上传 PDF/Word 文件，与 Bloomberg 数据联合分析
6. **移动端支持**：Bloomberg Professional App，支持 Apple Vision Pro

### Forrester 评价（2026 年 3 月）
> "Bloomberg 的 ASKB 代表了专为受监管、数据密集型领域设计的 Agentic AI 的先进案例。ASKB 作为 Bloomberg Terminal 的对话式前端，反映了企业将复杂工作流整合到统一 Agent 界面的更广泛趋势。"

Forrester 同时指出 ASKB 目前仍属于"Agentish"（类 Agentic）系统：能检索和综合信息，但尚未能自主采取行动。

### 战略意图
Bloomberg 推出 ASKB 的核心目的是**防御性护城河**：
- 应对 AlphaSense 等 AI 原生平台的竞争威胁
- 将 Bloomberg 的数据优势与 AI 交互能力结合，提升用户粘性
- 防止用户因 AI 功能不足而转向竞争对手

---

## 定价策略

| 类型 | 价格 |
|------|------|
| 标准席位（1 个） | $27,660/年 |
| 多席位（2+） | $24,240/年/席位 |
| 学术版（大学） | 低至 $3,000/年/席位 |
| Bloomberg Chat 独立订阅 | $10/月（需至少 1 个 Terminal 席位） |

---

## 对 Fidelity 的参考价值

- Bloomberg 数据 API（B-PIPE、Bloomberg Data License）是 Fidelity Research Platform 数据层的核心输入
- ASKB 的多 Agent 架构和 BQL 代码生成是 Fidelity AI 研究助手的参考设计
- Bloomberg Chat 的网络效应说明：研究平台的社交/协作功能是重要的粘性来源

---

*来源：[Bloomberg ASKB 公告](https://www.marketsmedia.com/bloomberg-introduces-agentic-ai-to-the-terminal/)、[Forrester Agentic AI in Financial Services](https://www.forrester.com/blogs/agentic-ai-is-on-the-cusp-of-transforming-financial-services/)、[Wall Street Prep 平台对比](https://www.wallstreetprep.com/knowledge/bloomberg-vs-capital-iq-vs-factset-vs-thomson-reuters-eikon/)*

*Content was rephrased for compliance with licensing restrictions.*
