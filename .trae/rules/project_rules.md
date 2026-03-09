# 项目规则

本项目用于研究 pi-coding-agent 和 OpenClaw 的源码实现。不更新 pi-mono 和 OpenClaw 的源码，只会在本地 clone 后进行研究。

**研究文档存放到 `glm5-studydoc/`、`kimi-studydoc/`、`minimax-studydoc/`、`qwen-studydoc/` 目录下**。

## 项目结构

```
PI-Coding-Agent-OpenClaw-study/
├── .trae/                          # Trae 配置目录
│   ├── rules/
│   │   └── project_rules.md        # 项目规则（本文件）
│   └── skills/
│       └── web-to-markdown/        # 网页转 Markdown 技能
├── pi-coding-agent-source-code/    # pi-mono 源码引用
│   ├── README.md
│   └── pi-mono/                    # git clone 的仓库
├── open-claw-source-code/          # OpenClaw 源码引用
│   ├── README.md
│   └── openclaw/                   # git clone 的仓库
├── glm5-studydoc/                  # GLM5 学习文档
├── kimi-studydoc/                  # Kimi 学习文档
├── minimax-studydoc/               # MiniMax 学习文档
├── qwen-studydoc/                  # Qwen 学习文档
└── README.md
```

## 源码更新命令

更新 pi-mono 源码：
```powershell
cd pi-coding-agent-source-code/pi-mono; git pull origin main
```

更新 OpenClaw 源码：
```powershell
cd open-claw-source-code/openclaw; git pull origin main
```

## 语言要求

- 文档和注释使用中文
- Skill name 使用英文

## 代码风格

- 遵循各子项目的代码规范
- 参考源码仓库的 AGENTS.md 和 CONTRIBUTING.md

## 执行规范

**严格遵守：不要额外多做没有要求的事情**

- 严格按照用户要求的步骤执行
- 不要擅自添加未要求的总结、分析或额外功能
- 完成指定任务后，仅报告必要信息（如文件保存路径）
- 如需额外操作，必须先询问用户意见
