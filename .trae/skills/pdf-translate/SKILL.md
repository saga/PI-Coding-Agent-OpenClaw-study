---
name: "pdf-translate"
description: "Download PDF from URL, save locally, and translate content to rigorous Chinese. Invoke when user provides a PDF URL with translation keywords like '翻译', 'translate', or '中文'. Supports pagination with user confirmation for long documents."
---

# PDF Translate

此技能用于从 URL 下载 PDF 文件，保存到本地，然后将内容翻译成严谨的中文。

## 执行优先级

**此 skill 仅在满足以下条件时执行：**
1. 用户输入包含 PDF 的 URL（以 `.pdf` 结尾或明确是 PDF 链接）
2. **且** 用户明确包含以下翻译关键词之一：
   - "翻译" / "翻译成中文"
   - "中文"
   - "translate" / "translate to chinese"

**重要：仅粘贴 PDF 网址（如 `https://example.com/doc.pdf`）时，不要执行此 skill，应询问用户意图。**

## 调用时机

**仅在以下明确情况下调用此技能：**
- ✅ 用户说"`https://example.com/doc.pdf` 翻译成中文"
- ✅ 用户说"翻译这个 PDF：`https://example.com/file.pdf`"
- ✅ 用户说"`https://example.com/paper.pdf` 中文翻译"

**不要调用的情况：**
- ❌ 用户仅粘贴 PDF 网址：`https://example.com/doc.pdf`
- ❌ 用户说"下载这个 PDF"（无翻译关键词）

## 工作流程

1. **下载 PDF** - 从 URL 下载 PDF 文件
   - 使用 `Invoke-WebRequest` (PowerShell) 下载 PDF
   - 保存到 `glm5-studydoc/` 目录（或用户指定的目录）
   - 文件名从 URL 提取或使用默认名称

2. **切分 PDF 并提取 Markdown** - 按页切分并提取文本
   - 使用 `split_pdf.py` 脚本（pypdfium2 + pdfplumber）
   - 安装依赖: `pip install pypdfium2 pdfplumber`
   - 命令: `python split_pdf.py <input.pdf> [output_dir]`
   - 输出目录结构:
     ```
     {原文件名}-split/
     ├── {原文件名}-page-001.pdf    # 单页 PDF
     ├── {原文件名}-page-001.md     # Markdown 文本
     ├── {原文件名}-page-002.pdf
     ├── {原文件名}-page-002.md
     └── {原文件名}-summary.md      # 汇总文档
     ```
   - Markdown 文件包含页面分隔标记 `<!-- 第 X 页 -->`
   - 表格转换为 Markdown 表格格式
   - 图片位置标记为 `<图片 N>`

3. **逐页翻译** - 将切分后的每页 PDF 内容翻译成中文
   - 由于 AI 无法直接读取 PDF，需要用户手动提取文本或使用 OCR
   - 翻译必须忠实原文，不能添加原文没有的内容
   - 保持原文结构和格式
   - **如果是 PDF 中的图片，在翻译结果中添加 `<图片>` 占位符表示**

4. **用户确认** - 每完成一批次后：
   - 展示已翻译的内容摘要
   - **询问用户意见**："是否继续翻译下一批？" 或 "是否需要调整？"
   - 根据用户反馈继续、调整或停止

5. **保存结果** - 将所有翻译内容合并保存：
   - 文件名格式：`{原文件名}-translated.md`
   - 保存到与原 PDF 相同的目录

## 翻译要求

- **忠实原文**：不得添加、删除或修改原文内容
- **严谨准确**：专业术语翻译准确，保持学术/技术文档的严谨性
- **结构保持**：保留原文的章节结构、列表、表格等格式
- **图片处理**：对于 PDF 中的图片，使用 `<图片>` 占位符标记位置
- **批注保留**：如有脚注或批注，在相应位置保留

## 分页处理

对于多页 PDF（超过 10 页）：

```
批次 1: 第 1-10 页 → 翻译 → 用户确认
批次 2: 第 11-20 页 → 翻译 → 用户确认
批次 3: 第 21-30 页 → 翻译 → 用户确认
...
```

**每次用户确认时必须询问：**
- "已翻译第 X-Y 页，是否继续？"
- "翻译质量如何？是否需要调整风格或术语？"

## 输出格式

```markdown
# {原文标题} - 中文翻译

**来源**: {PDF URL}
**页数**: {总页数}
**翻译日期**: {日期}

---

## 第 1-10 页

[翻译内容...]

<图片>

[继续翻译...]

---

## 第 11-20 页

[翻译内容...]

---
```

## 示例

用户请求：
> https://example.com/paper.pdf 翻译成中文

执行动作：
1. 下载 PDF 到 `glm5-studydoc/paper.pdf`
2. 切分 PDF 到 `glm5-studydoc/split_pages/paper-page-001.pdf` 等文件
3. 提示用户需要手动提取文本或使用 OCR
4. 用户逐页提供文本内容，AI 进行翻译
5. 合并所有翻译内容保存到 `glm5-studydoc/paper-translated.md`

## 注意事项

- **环境要求**: 需要安装 Python 和两个库：
  ```bash
  pip install pypdfium2 pdfplumber
  ```
- **License**: 
  - pypdfium2: Apache 2.0（可商业使用）
  - pdfplumber: MIT（可商业使用）
- **引擎**: pypdfium2 使用 Google PDFium 引擎，pdfplumber 使用 pdfminer.six
- **文本提取**: 脚本会自动提取 Markdown，但复杂排版可能需要手动调整
- **扫描版 PDF**: 需要 OCR 处理后才能提取文本
- **数学公式**: 保持原样或用 LaTeX 表示
- **代码块**: 保持原样，仅翻译注释
