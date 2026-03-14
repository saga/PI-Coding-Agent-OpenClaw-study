# Context Hub 源码管理指南

本目录用于管理 `Context Hub` 仓库的源代码引用。

## 目录结构

```
context-hub-source-code/      # Context Hub 源码目录
└── context-hub/              # 克隆的仓库
```

## 初始化（首次设置）

```powershell
# 克隆 Context Hub 仓库
git clone https://github.com/andrewyng/context-hub.git context-hub-source-code/context-hub
```

## 更新到最新版本

```powershell
# 进入源码目录并拉取最新代码
cd context-hub-source-code/context-hub
git pull origin main
```

或者一行命令：

```powershell
cd context-hub-source-code/context-hub; git pull origin main
```

## 切换到特定版本/标签

```powershell
# 查看所有标签
cd context-hub-source-code/context-hub
git tag

# 切换到特定标签
git checkout v1.0.0

# 切换回 main 分支
git checkout main
```

## 查看当前版本

```powershell
cd context-hub-source-code/context-hub
git log -1 --oneline
```

## 安装和运行

```powershell
cd context-hub-source-code/context-hub

# 全局安装 CLI
npm install -g @aisuite/chub

# 查看帮助
chub --help

# 搜索文档
chub search openai

# 获取文档
chub get openai/chat --lang py
```

## 仓库信息

- **仓库地址**: https://github.com/andrewyng/context-hub
- **默认分支**: main
- **包管理器**: npm

## 主要特性

- **版本化文档** - 针对不同编程语言的 API 文档版本
- **增量获取** - 只获取需要的文件，减少 token 消耗
- **注解功能** - 代理可以添加本地笔记，跨会话持久化
- **反馈机制** - 对文档进行投票，反馈给维护者改进
- **代理技能** - 可扩展的技能系统

## CLI 命令

| 命令 | 用途 |
|------|------|
| `chub search [query]` | 搜索文档和技能 |
| `chub get <id> [--lang py\|js]` | 按 ID 获取文档 |
| `chub annotate <id> <note>` | 添加注解 |
| `chub annotate <id> --clear` | 清除注解 |
| `chub annotate --list` | 列出所有注解 |
| `chub feedback <id> <up\|down>` | 投票反馈 |
