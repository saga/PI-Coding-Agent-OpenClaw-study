# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个 AI 编程 Agent 源码研究项目，研究以下开源 Agent 的实现：

| Agent | 仓库 | 本地路径 |
|-------|------|----------|
| pi-mono (PI Coding Agent) | github.com/badlogic/pi-mono | `pi-coding-agent-source-code/pi-mono/` |
| OpenClaw | github.com/openclaw/openclaw | `open-claw-source-code/openclaw/` |
| Hermes Agent | github.com/NousResearch/hermes-agent | `hermes-agent-source-code/` |
| Context Hub | github.com/andrewyng/context-hub | `context-hub-source-code/context-hub/` |

**不直接修改上述源码仓库**，仅 clone 到本地进行研究分析。

## 研究文档目录

研究文档按生成模型分类存放（文档使用中文）：

- `glm5-studydoc/` — GLM5 模型生成的分析文档
- `kimi-studydoc/` — Kimi 模型生成的分析文档
- `minimax-studydoc/` — MiniMax 模型生成的分析文档
- `qwen-studydoc/` — Qwen 模型生成的分析文档
- `deepseek-studydoc/` — DeepSeek 模型生成的分析文档（Transformer 架构深入分析）
- `kiro-studydoc/` — Kiro 模型生成的分析文档（数据血缘、金融研究平台设计等）
- `hermes-agent-研究/` — Hermes Agent 综合研究报告（Memory Provider、Multi-Agent 委托、Skills 自学习等）

## 其他重要目录

- `fin-service-research/` — 金融研究平台调研（TypeScript 项目，含爬虫、RAG 架构分析、竞品对比）
- `.trae/skills/` — 自定义技能（web-to-markdown、pdf-translate、kexue-fetcher、translate-to-chinese）
- `.kiro/steering/guidance.md` — Kiro 工作规范

## 工作规范

**来自 `.trae/rules/project_rules.md`：**
- 文档和注释使用**中文**，Skill 名称使用英文
- 严格遵守：**不要额外多做没有要求的事情**，按用户要求的步骤执行
- 完成指定任务后，仅报告必要信息
- 如需额外操作，必须先询问用户

**来自 `.kiro/steering/guidance.md`：**
- 默认所有输出写成 Markdown 文档（中文），保存到 repo 中。未指定目录时先询问
- 写代码前必须先跟用户确认需求和方案，得到明确同意后再动手
- 写大文件时分多次写，每次不超过 50 行

## 源码更新命令

```bash
# 更新 pi-mono
cd pi-coding-agent-source-code/pi-mono && git pull origin main

# 更新 OpenClaw
cd open-claw-source-code/openclaw && git pull origin main

# 更新 Hermes Agent
cd hermes-agent-source-code && git pull origin main

# 更新 Context Hub
cd context-hub-source-code/context-hub && git pull origin main
```

## 技术环境

- **Python**: 3.14（由 `.python-version` 和 uv 管理）
- **包管理**: uv（`pyproject.toml` + `uv.lock`）
- **主要依赖**: pdfplumber, pydantic, langgraph, langchain_openai, openai, httpx, mermaid-py
- **运行**: `uv run python main.py`
- `fin-service-research/` 是独立的 TypeScript/Node.js 项目，有自己的 `package.json`
