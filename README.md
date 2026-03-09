# PI-Coding-Agent-OpenClaw-study

本项目用于研究 pi-coding-agent 和 OpenClaw 的源码实现。不更新 pi-mono 和 OpenClaw 的源码，只会在本地 clone 后进行研究。

**研究文档存放到 `glm5-studydoc/`、`kimi-studydoc/`、`minimax-studydoc/`、`qwen-studydoc/` 目录下**。

## 项目结构

```
PI-Coding-Agent-OpenClaw-study/
├── .trae/                          # Trae 配置目录
│   ├── rules/project_rules.md      # 项目规则
│   └── skills/                     # 自定义技能
├── pi-coding-agent-source-code/    # pi-mono 源码引用
│   └── pi-mono/                    # git clone 仓库
├── open-claw-source-code/          # OpenClaw 源码引用
│   └── openclaw/                   # git clone 仓库
├── glm5-studydoc/                  # GLM5 学习文档
├── kimi-studydoc/                  # Kimi 学习文档
├── minimax-studydoc/               # MiniMax 学习文档
└── qwen-studydoc/                  # Qwen 学习文档
```

## 源码仓库

| 项目 | 仓库地址 | 本地目录 |
|------|----------|----------|
| pi-mono | https://github.com/badlogic/pi-mono | `pi-coding-agent-source-code/pi-mono` |
| OpenClaw | https://github.com/openclaw/openclaw | `open-claw-source-code/openclaw` |

## 更新源码

```powershell
# 更新 pi-mono
cd pi-coding-agent-source-code/pi-mono; git pull origin main

# 更新 OpenClaw
cd open-claw-source-code/openclaw; git pull origin main
```

## 学习文档

各子目录包含不同 LLM 模型对源码的分析研究文档：

- **glm5-studydoc/** - GLM5 模型的分析文档
- **kimi-studydoc/** - Kimi 模型的分析文档
- **minimax-studydoc/** - MiniMax 模型的分析文档
- **qwen-studydoc/** - Qwen 模型的分析文档

## 自定义技能

- **web-to-markdown** - 下载网页并转换为 Markdown 格式保存到本地
 