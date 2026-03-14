# 上游同步说明

**同步日期：** 2026-03-14  
**上游仓库：** https://github.com/anthropics/financial-services-plugins  
**合并范围：** 本地 `093b63d` → 上游 `b881b3c`（含 PR #24、#27、#29、#35）  
**注意：** 所有 `*-cn` 目录均未受影响，保持原样。

---

## 一、新增 Skill

### financial-analysis

| Skill | 路径 | 说明 |
|---|---|---|
| `audit-xls` | `financial-analysis/skills/audit-xls/SKILL.md` | 电子表格审计工具。支持三种范围：选区、单表、整个模型。模型级审计包含资产负债表平衡校验、现金流对账、循环引用检测，以及 DCF/LBO/三表/并购模型的专项 bug 检查。 |
| `clean-data-xls` | `financial-analysis/skills/clean-data-xls/SKILL.md` | 数据清洗工具。处理空白字符、大小写不一致、文本型数字、日期格式混乱、重复行、混合类型列等问题。优先使用公式（如 `=TRIM()`）而非直接覆盖原始数据。 |
| `deck-refresh` | `financial-analysis/skills/deck-refresh/SKILL.md` | PPT 数字更新工具。用于季度刷新、财报更新、可比公司滚动等场景。四阶段流程：获取新数据 → 全文扫描所有数字变体 → 展示变更计划并获批准 → 执行并报告。 |
| `ib-check-deck` | `financial-analysis/skills/ib-check-deck/SKILL.md` | 投行 PPT 质检工具（原 `check-deck` 重构版）。四维检查：数字一致性、数据与叙述对齐、语言规范、视觉格式。附带 Python 脚本 `extract_numbers.py` 用于跨页数字提取与比对。 |

### private-equity

| Skill | 路径 | 说明 |
|---|---|---|
| `ai-readiness` | `private-equity/skills/ai-readiness/SKILL.md` | 投资组合 AI 就绪度扫描。逐家公司评估"三关"（数据是否就绪、是否有负责人、能否 30 天内试点），输出跨组合公司的 AI 机会优先级排名，并识别可在多家公司复用的"打法"。 |

---

## 二、重命名 / 重构

| 变更 | 说明 |
|---|---|
| `3-statements` → `3-statement-model` | Skill 及对应 command 均已重命名。内容大幅扩充：新增 Office JS vs Python 环境判断、公式优先原则（禁止硬编码）、分步骤与用户确认流程、专业蓝灰配色规范。 |
| `check-deck` → `ib-check-deck` | 原 `check-deck` 和 `check-model` 合并重构为 `ib-check-deck`，定位更聚焦于投行场景，并新增数字提取脚本。 |

---

## 三、内容更新

| 文件 | 变更摘要 |
|---|---|
| `financial-analysis/skills/competitive-analysis/SKILL.md` | 大幅精简重写。去掉原有的"CRITICAL STANDARDS"章节，改为两阶段流程（先获取需求和大纲审批，再构建），描述更聚焦于竞争格局 deck 的构建。 |
| `financial-analysis/skills/comps-analysis/SKILL.md` | 内容更新，细节调整。 |
| `financial-analysis/skills/dcf-model/SKILL.md` | 内容更新，细节调整。 |
| `financial-analysis/skills/lbo-model/SKILL.md` | 内容更新，细节调整。 |
| `financial-analysis/commands/debug-model.md` | command 描述更新。 |
| `financial-analysis/skills/ib-check-deck/scripts/extract_numbers.py` | 新增 Python 脚本（305 行）。解析 markdown 格式的 PPT 内容，提取所有数字及其上下文，支持单位归一化（$500M / $500MM / $500,000,000 → 同一数字），输出 JSON 供一致性检查使用。修复了 `thousand` 被误匹配为 `trillion` 的 bug。 |

---

## 四、新增 Command

| Command | 路径 | 说明 |
|---|---|---|
| `ai-readiness` | `private-equity/commands/ai-readiness.md` | 触发 `ai-readiness` skill，扫描投资组合公司的 AI 机会。 |

---

## 五、文件统计

本次同步共变更 **21 个文件**，新增 881 行，删除 533 行。
