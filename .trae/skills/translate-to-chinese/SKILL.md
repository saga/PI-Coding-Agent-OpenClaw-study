---
name: "translate-to-chinese"
description: "Translate content to Chinese with bilingual output. Invoke when user explicitly requests translation with keywords like 'translate', '中文', or '翻译成中文' along with a URL, OR when user wants to translate current chat context or opened Markdown document."
---

# Translate to Chinese

此技能用于将英文内容翻译成中文，生成中英文交错的双语文档。支持翻译网页、当前聊天上下文或已打开的 Markdown 文档。

## 执行优先级

**此 skill 在以下情况时执行：**

### 情况 1：翻译网页
1. 用户输入包含 URL
2. **且** 用户明确包含以下翻译关键词之一：
   - "翻译" / "翻译成中文"
   - "中文"
   - "translate" / "translate to chinese"
   - "bilingual" / "双语"

### 情况 2：翻译当前上下文（高优先级）
1. **用户明确说"翻译"、"翻译成中文"等关键词**
2. **且** 满足以下任一条件：
   - 当前 chat context 中有被 **add to chat** 的 Markdown 文档
   - 用户在 IDE 中打开了 Markdown 文件（`.md`）
   - 用户说"翻译这个文档"、"翻译当前文件"等

**重要：仅粘贴网址（如 `https://example.com`）时，不要执行此 skill，应使用 web-to-markdown skill。**

## 调用时机

### 翻译网页
- ✅ 用户说"`https://example.com/article` 翻译成中文"
- ✅ 用户说"把这个页面翻译成中文：`https://example.com`"
- ✅ 用户说"翻译这个网页：`https://example.com`"

### 翻译当前上下文或已打开文档
- ✅ 用户说"翻译"（当前有 Markdown 文档在 chat context 中）
- ✅ 用户说"翻译成中文"（用户当前打开了 Markdown 文件）
- ✅ 用户说"翻译这个文档"
- ✅ 用户说"翻译当前文件"

**不要调用的情况：**
- ❌ 用户仅粘贴网址：`https://example.com/article`
- ❌ 用户说"下载这个页面"（无翻译关键词）

## 工作流程

### 分支 1：翻译网页

1. **提取 URL** - 从用户输入中提取网址
2. **调用 web-to-markdown** - 首先使用 web-to-markdown 技能下载网页并保存为 Markdown
3. **分段翻译** - 将内容分段落进行翻译（见下方翻译规范）
4. **生成双语文档** - 创建中英文交错的新文档

### 分支 2：翻译当前上下文或已打开的 Markdown 文档

1. **检测上下文** - 检查以下信号：
   - 用户是否将 Markdown 文件 **add to chat**
   - 用户当前是否在 IDE 中打开了 `.md` 文件
   - 用户是否明确说"翻译这个文档"、"翻译当前文件"

2. **获取内容** - 
   - 如果是 **add to chat** 的文档：读取该 Markdown 内容
   - 如果是 IDE 中打开的文件：读取当前打开的文件内容

3. **确认翻译** - 向用户确认：
   > "检测到您打开了 `{文件名}.md`，是否将其翻译成中文？"

4. **分段翻译** - 用户确认后，将内容分段落进行翻译（见下方翻译规范）

5. **生成双语文档** - 创建中英文交错的新文档，保存在原文件相同目录

### 翻译规范（通用）

- 保持原文结构，逐段翻译
- 如果段落内容较少，合并相邻段落一起翻译
- 翻译必须忠实原文，不能添加原文没有的内容
- 不能改变文章结构和内容，只做翻译
- **保留 Markdown 图片语法不翻译**：`![alt text](image-url)` 格式的图片标记保持原样
- **保留图片链接不翻译**：图片的 URL 路径保持原样

### 输出格式

- 格式：英文原文 + 中文翻译（直接交错，不使用 **[EN]** / **[CN]** 标签）
- 保存到与原 Markdown 相同的目录
- 文件名格式：`{原文件名}-bilingual.md`

## 双语文档格式示例

```markdown
# 文章标题

## 段落 1

Original English text here...

中文翻译内容...

## 段落 2

Next paragraph in English...

下一段的中文翻译...
```

## 示例

### 示例 1：翻译网页
用户请求：
> https://example.com/article 翻译成中文

执行动作：
1. 调用 web-to-markdown 下载网页到 `glm5-studydoc/article.md`
2. 读取 Markdown 内容
3. 分段翻译内容
4. 生成双语文档保存到 `glm5-studydoc/article-bilingual.md`

### 示例 2：翻译当前打开的文档
用户当前打开了 `glm5-studydoc/guide.md`，然后说：
> 翻译成中文

执行动作：
1. 检测到用户打开了 `guide.md`
2. 询问："检测到您打开了 `guide.md`，是否将其翻译成中文？"
3. 用户确认后，读取文件内容
4. 分段翻译内容
5. 生成双语文档保存到 `glm5-studydoc/guide-bilingual.md`

## 注意事项

- 翻译必须忠实原文，不得添加、删除或修改内容
- 保持原文的段落结构和格式
- 专业术语保持准确性
- 代码块、链接、图片路径保持不变
- **图片处理**：Markdown 图片语法 `![描述](图片链接)` 和图片链接保持原样，不进行翻译
- 短段落（少于100字）可以合并翻译以提高流畅度

## 图片处理规则

在翻译过程中，以下内容保持原样：

1. **Markdown 图片语法**：
   ```markdown
   ![图片描述](images/photo.jpg)
   ![alt text](https://example.com/image.png)
   ```
   以上格式保持原样，不翻译 `![` 和 `](...)` 部分

2. **图片链接**：
   - 本地图片路径：`images/photo.jpg`、`./assets/image.png`
   - 网络图片 URL：`https://example.com/image.png`
   这些链接保持原样，不进行翻译

3. **HTML 图片标签**（如有）：
   ```html
   <img src="images/photo.jpg" alt="description">
   ```
   保持标签和属性值原样
