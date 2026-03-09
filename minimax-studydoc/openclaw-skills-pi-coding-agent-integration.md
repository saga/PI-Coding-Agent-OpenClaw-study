# OpenClaw Skills 和功能在 pi-coding-agent 上的集成研究

## 摘要

本文分析 OpenClaw 源码中实现的 skills 和功能，评估在 pi-coding-agent 上直接使用所需的核心库支持。OpenClaw 基于 pi-mono 生态构建，其技能系统（Skills System）是其核心功能模块之一。

---

## 一、OpenClaw Skills 系统概述

### 1.1 Skills 目录结构

OpenClaw 的 skills 存放在 `skills/` 目录下，每个 skill 都是一个独立的子目录，包含：

- **SKILL.md** - Skill 定义文件（YAML frontmatter + Markdown 描述）
- **scripts/** - 辅助脚本（可选）
- **references/** - 参考文档（可选）

### 1.2 Skills 分类

OpenClaw 提供了 **55+** 个内置 skills，按功能可分为以下类别：

| 类别 | Skills 数量 | 示例 |
|------|-------------|------|
| 开发者工具 | 10+ | github, gh-issues, gitg, coding-agent, discord, slack |
| AI 模型集成 | 6+ | gemini, openai-image-gen, openai-whisper, nano-banana-pro |
| 生产力工具 | 15+ | notion, obsidian, bear-notes, apple-notes, trello |
| 系统工具 | 10+ | tmux, 1password, sherpa-onnx-tts, voice-call |
| 媒体处理 | 5+ | video-frames, spotify-player, songsee, openhue |
| 其他 | 10+ | weather, skill-creator, clawhub, blogwatcher |

---

## 二、Skills 格式规范

### 2.1 SKILL.md 结构

每个 skill 使用 YAML frontmatter 定义元数据：

```yaml
---
name: skill-name
description: "技能描述，说明使用场景"
metadata:
  {
    "openclaw": {
      "emoji": "🎯",
      "requires": { "bins": ["cli-tool"] },
      "install": [
        { "kind": "brew", "formula": "tool-name", "bins": ["tool"] }
      ]
    }
  }
---
```

### 2.2 元数据字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | Skill 名称 |
| `description` | string | 技能描述 |
| `metadata.openclaw.emoji` | string | 显示图标 |
| `metadata.openclaw.requires.bins` | string[] | 必需的二进制工具 |
| `metadata.openclaw.requires.anyBins` | string[] | 任一必需的二进制工具 |
| `metadata.openclaw.requires.env` | string[] | 必需的环境变量 |
| `metadata.openclaw.install` | array | 安装说明 |

---

## 三、核心依赖分析

### 3.1 pi-coding-agent 核心库

OpenClaw 的 skills 系统依赖于 `@mariozechner/pi-coding-agent` 包，主要使用以下导出：

#### 类型导出

| 类型 | 用途 |
|------|------|
| `Skill` | Skill 数据结构定义 |
| `SkillEntry` | Skill 条目（包含 skill、frontmatter、metadata） |
| `SkillSnapshot` | Skill 快照（用于会话） |
| `SessionManager` | 会话管理器 |
| `AgentSession` | Agent 会话配置 |
| `ExtensionAPI` | 扩展 API |
| `ExtensionContext` | 扩展上下文 |

#### 函数导出

| 函数 | 用途 |
|------|------|
| `loadSkillsFromDir` | 从目录加载 skills |
| `codingTools` | 核心工具集 |
| `createReadTool` | 创建读取工具 |
| `estimateTokens` | Token 估算 |
| `generateSummary` | 摘要生成 |
| `compact` | 会话压缩 |

### 3.2 pi-agent-core 库

`@mariozechner/pi-agent-core` 提供基础类型：

| 类型 | 用途 |
|------|------|
| `AgentMessage` | 会话消息 |
| `AgentTool` | 工具定义 |
| `AgentToolResult` | 工具执行结果 |

---

## 四、在 pi-coding-agent 上使用 OpenClaw Skills 所需的库

### 4.1 核心依赖（必需）

要在 pi-coding-agent 上支持 OpenClaw 风格的 skills，需要以下库：

```json
{
  "dependencies": {
    "@mariozechner/pi-coding-agent": "^0.55.3",
    "@mariozechner/pi-agent-core": "^0.55.3"
  }
}
```

### 4.2 OpenClaw 源码复用分析

以下 OpenClaw 模块可以直接移植或参考：

| 模块 | 文件路径 | 复用可行性 | 说明 |
|------|----------|------------|------|
| Skills 类型定义 | `src/agents/skills/types.ts` | **高** | 定义 Skill、SkillEntry、SkillSnapshot 等类型 |
| Skills 加载 | `src/agents/skills/workspace.ts` | **高** | loadWorkspaceSkillEntries、buildWorkspaceSkillSnapshot |
| Frontmatter 解析 | `src/agents/skills/frontmatter.ts` | **高** | parseFrontmatter、resolveSkillInvocationPolicy |
| Skills 配置 | `src/agents/skills/config.ts` | **中** | resolveSkillConfig、isBundledSkillAllowed |
| Skills 过滤 | `src/agents/skills/filter.ts` | **中** | normalizeSkillFilter、matchesSkillFilter |
| 环境覆盖 | `src/agents/skills/env-overrides.ts` | **中** | applySkillEnvOverrides |

### 4.3 Skills 分类所需依赖

根据 skills 类型，还需要额外依赖：

| Skill 类型 | 依赖 | 说明 |
|-----------|------|------|
| GitHub 操作 | `gh` CLI | 系统已安装 |
| AI 模型 | 各模型 SDK | 见下表 |
| Apple 生态 | AppleScript/osascript | macOS 系统 |
| 密码管理 | `op` (1Password CLI) | 需安装 |
| TTS/语音 | `sherpa-onnx-tts` | 需安装 |

---

## 五、Skills 系统实现要点

### 5.1 必需的实现组件

要在 pi-coding-agent 上实现 OpenClaw 风格的 Skills 系统，需要实现以下组件：

#### 5.1.1 Skills 加载器

```typescript
// 核心功能
import { loadSkillsFromDir } from "@mariozechner/pi-coding-agent";
import type { Skill, SkillEntry } from "@mariozechner/pi-coding-agent";

// 加载 skills
const skills = await loadSkillsFromDir("./skills");
```

#### 5.1.2 Frontmatter 解析

```typescript
// 解析 SKILL.md 的 frontmatter
import { parseFrontmatter } from "./frontmatter";

const content = readFileSync("skills/github/SKILL.md", "utf-8");
const { metadata, body } = parseFrontmatter(content);
```

#### 5.1.3 Skill 过滤和选择

```typescript
// 根据环境过滤 skills
import { filterWorkspaceSkillEntries } from "./filter";

const filtered = filterWorkspaceSkillEntries(skills, {
  platform: process.platform,
  hasBin: (bin) => which(bin) !== null,
});
```

#### 5.1.4 Skill 快照构建

```typescript
// 构建 Skill 快照用于会话
import { buildWorkspaceSkillSnapshot } from "./workspace";

const snapshot = await buildWorkspaceSkillSnapshot({
  workspaceDir: process.cwd(),
  filter: ["github", "coding-agent"],
});
```

### 5.2 扩展系统（如需自定义行为）

OpenClaw 的扩展系统基于 pi-coding-agent 的 Extension API：

```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// 示例：上下文修剪扩展
export function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event, ctx: ExtensionContext) => {
    // 自定义逻辑
    return { messages: prunedMessages };
  });
}
```

---

## 六、推荐集成方案

### 6.1 最小可行集成（MVP）

如需快速在 pi-coding-agent 上支持 OpenClaw Skills，推荐以下方案：

1. **直接使用 pi-coding-agent 内置的 Skills 功能**
   - `loadSkillsFromDir` 函数已内置
   - 只需创建符合格式的 `SKILL.md` 文件

2. **复用 OpenClaw 的 skills 目录**
   - 将 `skills/` 目录复制到项目
   - 配置 skills 加载路径

3. **实现必要的工具包装**
   - 工具策略管道（Tool Policy Pipeline）
   - 工作区根目录保护

### 6.2 完整集成

如需完整复现 OpenClaw 的 Skills 系统，需要：

1. 复制 `src/agents/skills/` 目录下的所有文件
2. 适配类型引用（移除 OpenClaw 特定依赖）
3. 实现环境检测和 binary 检查
4. 添加 skill 安装支持（brew/node/uv）

---

## 七、结论与建议

### 7.1 核心结论

1. **Skills 系统是 OpenClaw 的重要组成部分**，提供了 55+ 个预置 skills，覆盖开发者工作流的各个方面。

2. **Skills 格式是标准化的**，基于 YAML frontmatter + Markdown，兼容 pi-coding-agent 的 `Skill` 类型。

3. **核心依赖明确**：只需 `@mariozechner/pi-coding-agent` 和 `@mariozechner/pi-agent-core` 两个包即可支持基础的 Skills 功能。

4. **Skills 实现代码可复用**：OpenClaw 的 `src/agents/skills/` 目录下的代码可以直接移植或参考。

### 7.2 实施建议

| 阶段 | 任务 | 复杂度 |
|------|------|--------|
| Phase 1 | 在 pi-coding-agent 中配置 skills 目录 | 低 |
| Phase 2 | 复制 skills 定义文件 | 低 |
| Phase 3 | 移植 skills 加载和过滤逻辑 | 中 |
| Phase 4 | 实现 binary 检测和安装引导 | 中 |
| Phase 5 | 添加自定义扩展支持 | 高 |

---

## 参考资料

- OpenClaw 源码：`open-claw-source-code/openclaw/`
- Skills 目录：`open-claw-source-code/openclaw/skills/`
- Skills 核心实现：`open-claw-source-code/openclaw/src/agents/skills/`
- pi-coding-agent 包：`@mariozechner/pi-coding-agent`
