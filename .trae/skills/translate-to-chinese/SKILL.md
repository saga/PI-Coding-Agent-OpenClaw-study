---
name: "translate-to-chinese"
description: "Download webpage and translate content to Chinese with bilingual output. ONLY invoke when user explicitly requests translation with keywords like 'translate', '中文', or '翻译成中文' along with a URL. Do NOT invoke for bare URLs without translation keywords."
---

# Translate to Chinese

此技能用于下载英文网页并将其翻译成中文，生成中英文交错的双语文档。

## 执行优先级

**此 skill 仅在满足以下条件时执行：**
1. 用户输入包含 URL
2. **且** 用户明确包含以下翻译关键词之一：
   - "翻译" / "翻译成中文"
   - "中文"
   - "translate" / "translate to chinese"
   - " bilingual" / "双语"

**重要：仅粘贴网址（如 `https://example.com`）时，不要执行此 skill，应使用 web-to-markdown skill。**

## 调用时机

**仅在以下明确情况下调用此技能：**
- ✅ 用户说"`https://example.com/article` 翻译成中文"
- ✅ 用户说"把这个页面翻译成中文：`https://example.com`"
- ✅ 用户说"翻译这个网页：`https://example.com`"
- ✅ 用户说"`https://example.com` 中文翻译"

**不要调用的情况：**
- ❌ 用户仅粘贴网址：`https://example.com/article`
- ❌ 用户说"下载这个页面"（无翻译关键词）
- ❌ 用户说"保存这个链接"（无翻译关键词）

## 工作流程

1. **提取 URL** - 从用户输入中提取网址
2. **调用 web-to-markdown** - 首先使用 web-to-markdown 技能下载网页并保存为 Markdown
3. **分段翻译** - 将内容分段落进行翻译：
   - 保持原文结构，逐段翻译
   - 如果段落内容较少，合并相邻段落一起翻译
   - 翻译必须忠实原文，不能添加原文没有的内容
   - 不能改变文章结构和内容，只做翻译
4. **生成双语文档** - 创建中英文交错的新文档：
   - 格式：英文原文 + 中文翻译
   - 保存到与原 Markdown 相同的目录
   - 文件名格式：`{原文件名}-bilingual.md`

## 输出格式

```markdown
# 文章标题

## 段落 1

**[EN]**
Original English text here...

**[CN]**
中文翻译内容...

## 段落 2

**[EN]**
Next paragraph in English...

**[CN]**
下一段的中文翻译...
```

## 示例

用户请求：
> https://example.com/article 翻译成中文

执行动作：
1. 调用 web-to-markdown 下载网页到 `glm5-studydoc/article.md`
2. 读取 Markdown 内容
3. 分段翻译内容
4. 生成双语文档保存到 `glm5-studydoc/article-bilingual.md`

## 注意事项

- 翻译必须忠实原文，不得添加、删除或修改内容
- 保持原文的段落结构和格式
- 专业术语保持准确性
- 代码块、链接、图片路径保持不变
- 短段落（少于100字）可以合并翻译以提高流畅度
