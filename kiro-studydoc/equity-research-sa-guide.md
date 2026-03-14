# Equity 金融服务领域：Solution Architect 关键注意事项

**日期：** 2026-03-14  
**来源：** equity-research skills 分析 + 金融服务领域知识

---

## 一、这个领域在做什么

Equity Research（股票研究）是买方/卖方机构中的核心分析职能。从 skills 的工作流可以看出，这套系统覆盖了一个分析师的完整日常：

| 工作流 | 对应 Skill | 产出物 |
|---|---|---|
| 首次覆盖一家公司 | `initiating-coverage` | 30-50页研报 + Excel模型 + 25-35张图表 |
| 季报后快速更新 | `earnings-analysis` | 8-12页更新报告（24-48小时内） |
| 季报前预判 | `earnings-preview` | 1页情景分析 |
| 更新财务模型 | `model-update` | 更新后的Excel + 估值变化 |
| 维护投资逻辑 | `thesis-tracker` | 论点评分卡 |
| 寻找新投资标的 | `idea-generation` | 5-10个候选标的 |
| 每日晨会 | `morning-note` | 1页晨报（2分钟可读完） |
| 行业全景 | `sector-overview` | 20-30页行业报告 |
| 催化剂追踪 | `catalyst-calendar` | 事件日历 + Excel |

---

## 二、SA 需要理解的核心业务特征

### 2.1 时效性是第一约束

这是整个系统最重要的非功能性需求。

- 季报更新报告必须在**24-48小时**内发出
- 晨报必须在**7am 晨会前**就绪
- 季报电话会议结束后，分析师立刻开始写报告

**SA 含义：**
- 数据管道的延迟直接影响业务价值，SLA 要求极高
- 任何依赖外部数据源（MCP/API）的系统，必须有**降级策略**（fallback to web search / cached data）
- 批处理架构不适合这个场景，需要**流式/实时**数据处理

### 2.2 数据来源的层级与可信度

从 skills 中可以看到明确的数据优先级：

```
MCP 机构数据源（FactSet、S&P Kensho、Daloopa）
    ↓ 不可用时降级
SEC EDGAR 官方文件（10-K、10-Q）
    ↓ 不可用时降级
公司 IR 页面、财报电话会议记录
    ↓ 最后手段
Web Search（数据质量最低，不可用于机构级报告）
```

**SA 含义：**
- 系统架构必须支持**多数据源聚合**，并维护数据来源的可追溯性
- 每一个数据点都需要记录来源（文件名、日期、URL）——这是合规要求，不是可选项
- 数据源的**可用性监控**是关键基础设施，任何一个 MCP 服务挂掉都会影响报告质量

### 2.3 输出物的格式复杂度

这套系统的输出不是简单文本，而是：

- **DOCX**：带嵌入图表、可点击超链接、Times New Roman 字体、机构级排版
- **XLSX**：多 Tab 财务模型，含公式（不能是硬编码值）、颜色编码（蓝=输入，黑=公式，绿=跨表引用）
- **PNG/JPG**：300 DPI 专业图表，25-35张
- **ZIP**：打包交付

**SA 含义：**
- 需要 Office 文件处理能力（python-docx、openpyxl 或 Office JS Add-in）
- 图表生成需要 matplotlib/seaborn 等库，且对质量要求高（300 DPI）
- 文件存储和版本管理是必要基础设施
- 如果是 Web 应用，需要考虑大文件的下载/预览体验

### 2.4 合规与引用是硬性要求

`earnings-analysis` skill 中有大量篇幅专门讲引用规范，这不是风格偏好，而是**监管要求**：

- 每个数据点必须有来源（文件名 + 日期 + URL）
- 所有 URL 必须是可点击超链接（不是纯文本）
- 必须引用 SEC EDGAR 链接
- 必须区分 GAAP 和 adjusted 数字

**SA 含义：**
- 系统需要维护**数据血缘（data lineage）**，从原始数据到最终报告的每一步都可追溯
- 超链接生成需要自动化，不能依赖人工添加
- 审计日志是必要功能，不是可选项
- 如果使用 AI 生成内容，必须有机制防止 AI 捏造数据来源（hallucination 风险极高）

---

## 三、系统架构层面的关键决策点

### 3.1 Excel Add-in vs. 独立文件生成

Skills 中反复出现这个判断：

```
If running inside Excel (Office Add-in / Office JS): 使用 Office JS API
If generating standalone .xlsx: 使用 Python/openpyxl
```

这是两种完全不同的架构路径：

| 维度 | Office Add-in | 独立文件生成 |
|---|---|---|
| 用户体验 | 在 Excel 内实时操作 | 下载文件后打开 |
| 公式处理 | Excel 原生计算 | 需要 recalc.py 后处理 |
| 部署复杂度 | 需要 Office 365 + Add-in 注册 | 任何环境均可 |
| 适合场景 | 分析师桌面工作流 | 批量生成、服务端处理 |

**SA 建议：** 如果目标用户是分析师日常使用，优先考虑 Add-in 路径；如果是后台批量生成报告，选独立文件生成。两者不要混用。

### 3.2 MCP 集成架构

这套系统依赖 11 个外部 MCP 服务（FactSet、Daloopa、S&P Global 等），每个都是付费机构数据服务。

**关键风险：**
- 每个服务都有独立的认证、限流、SLA
- 服务中断会直接阻塞分析师工作流
- 数据格式不统一，需要标准化层

**推荐架构：**

```
[Agent / LLM]
      ↓
[数据聚合层 - 统一接口]
      ↓
┌─────┬─────┬─────┬─────┐
│FactSet│Daloopa│S&P│EDGAR│
└─────┴─────┴─────┴─────┘
      ↓
[缓存层 - Redis/本地]  ← 降低 API 调用成本，提供降级能力
```

### 3.3 长任务的状态管理

`initiating-coverage` skill 是一个 5 步骤的长流程，每步产出不同文件，步骤间有严格依赖关系。这不是一个单次 LLM 调用能完成的任务。

**SA 含义：**
- 需要**任务状态持久化**（用户可以跨 session 继续）
- 需要**检查点机制**（每步完成后保存，失败可从上一步恢复）
- 文件路径管理需要规范化（skill 中建议了标准目录结构）
- 考虑使用 Spec（Kiro）或类似的任务编排机制

### 3.4 AI Hallucination 风险管理

这是 equity research 场景中最高优先级的风险。Skills 中有明确警告：

> "CRITICAL: TRAINING DATA IS OUTDATED — BEFORE STARTING, search for latest earnings, verify dates"

分析师报告中的错误数字会直接影响投资决策，法律责任极重。

**SA 必须设计的防护机制：**

1. **数据验证层**：AI 生成的数字必须与原始数据源交叉验证
2. **日期检查**：强制要求 agent 验证数据时效性（>3个月的数据需要重新获取）
3. **人工审核节点**：关键数字（价格目标、EPS 估计）在发布前必须有人工确认步骤
4. **来源追踪**：每个数字必须能追溯到具体文件和行号

### 3.5 模型公式 vs. 硬编码值

Skills 中反复强调这一点，这是财务建模的核心原则：

> "Every projection cell MUST be an Excel formula — never a pre-computed value"

**SA 含义：**
- 如果用 Python 生成 Excel，必须写入公式字符串（`ws["D15"] = "=D14*(1+B5)"`），而不是计算结果
- 需要 `recalc.py` 这样的后处理步骤来验证公式正确性
- 测试策略需要包含"修改假设后模型是否正确联动"的验证

---

## 四、数据流与集成点

```
外部数据源
├── SEC EDGAR（免费，官方）
├── FactSet MCP（付费，机构级）
├── S&P Kensho MCP（付费）
├── Daloopa MCP（付费，结构化财务数据）
├── Aiera MCP（财报电话会议）
├── LSEG MCP（金融分析）
└── Web Search（降级用）
         ↓
    数据聚合 & 标准化
         ↓
    Agent（LLM + Skills）
         ↓
    文件生成
    ├── DOCX（python-docx / Office JS）
    ├── XLSX（openpyxl / Office JS）
    └── PNG（matplotlib / seaborn）
         ↓
    存储 & 分发
    ├── 文件系统 / S3
    ├── 邮件分发
    └── 内部研究平台
```

---

## 五、非功能性需求清单

| 需求 | 具体要求 | 优先级 |
|---|---|---|
| 时效性 | 季报更新 <48h，晨报 <7am | P0 |
| 数据可追溯性 | 每个数字有来源文件+日期+URL | P0 |
| Hallucination 防护 | 数字交叉验证，日期检查 | P0 |
| 数据源高可用 | MCP 服务降级策略 | P1 |
| 文件格式质量 | DOCX/XLSX 符合机构标准 | P1 |
| 图表质量 | 300 DPI，专业配色 | P1 |
| 任务状态持久化 | 长流程跨 session 恢复 | P1 |
| 合规审计日志 | 所有操作可追溯 | P1 |
| 公式完整性 | Excel 公式不能是硬编码值 | P2 |
| 版本管理 | 报告版本历史 | P2 |

---

## 六、常见陷阱

**陷阱 1：把 AI 当数据库用**  
LLM 的训练数据有截止日期，财务数据会过时。必须强制 agent 从实时数据源获取数字，不能依赖模型记忆。

**陷阱 2：忽略 Excel 公式要求**  
直接把计算结果写入 Excel 单元格，看起来没问题，但模型无法响应假设变化。这是财务建模的根本性错误。

**陷阱 3：低估引用工作量**  
自动生成可点击超链接、维护 SEC EDGAR 链接格式、处理不同数据源的引用格式——这些工程量比预期大得多。

**陷阱 4：单体 LLM 调用处理长流程**  
`initiating-coverage` 的完整流程需要数小时，产出数十个文件。必须设计为有状态的多步骤工作流，而不是一次性调用。

**陷阱 5：忽视 Office 环境差异**  
Office Add-in（Office JS）和独立文件生成（openpyxl）的 API 完全不同，merged cell 的处理方式也不同。混用会导致难以调试的错误。
