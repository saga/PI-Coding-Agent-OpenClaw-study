---
name: "kexue-fetcher"
description: "Fetch kexue.fm articles as Markdown with local images. Invoke when user provides a kexue.fm URL or asks to download/convert articles from 科学空间."
---

# Kexue.fm Article Fetcher

Fetch articles from kexue.fm (科学空间), convert to well-formatted Markdown, download images locally, and save to the specified directory.

## When to Invoke

- User provides a URL from `kexue.fm` and asks to download/save/convert it
- User asks to fetch articles from 科学空间
- User wants to batch-download multiple kexue.fm article links from a file

## Workflow

### Step 1: Fetch Article Content

Use `WebFetch` to retrieve the article from the given kexue.fm URL (format: `https://www.kexue.fm/archives/XXXX`).

### Step 2: Extract Metadata

From the fetched content, extract:
- **Title**: The article's `<h1>` or main heading
- **Author**: 苏剑林 (default for kexue.fm)
- **Date**: Publication date from the article header
- **Source URL**: The original article URL

### Step 3: Download Images

1. Identify all image URLs in the article. kexue.fm images typically follow patterns:
   - `https://www.kexue.fm/usr/uploads/YYYY/MM/NNNNNNNNNN.ext`
   - Image references in `<img>` tags or markdown `![]()` syntax

2. Download each image using `curl` to the target `images/` directory:
   ```bash
   cd <target-dir>/images && curl -sO <image-url> && mv <original-filename> <descriptive-name>.<ext>
   ```

3. Choose descriptive filenames based on the article context (e.g., `deltanet-short-conv.png`, `maxlogit-explosion.png`). Use English, lowercase, hyphen-separated names.

4. If the `images/` directory does not exist, create it first:
   ```bash
   mkdir -p <target-dir>/images
   ```

### Step 4: Convert to Markdown

Create a well-formatted Markdown file with:

1. **Header block** with author, date, and source link:
   ```markdown
   # <Article Title>

   > **作者**：苏剑林 | **日期**：YYYY-MM-DD | **来源**：[科学空间](<source-url>)
   ```

2. **Content body**:
   - Convert all LaTeX formulas to proper Markdown LaTeX syntax (`$...$` for inline, `$$...$$` for display)
   - Replace original image URLs with local paths: `![alt text](images/<local-filename>.ext)`
   - Preserve section headings (`##`, `###`, etc.)
   - Preserve code blocks with proper language tags
   - Preserve tables and lists
   - Convert numbered equations to LaTeX display math

3. **Footer block** with citation info:
   ```markdown
   ---

   **转载地址**：<source-url>

   **引用格式**：

   苏剑林. (Mon. DD, YYYY). 《<Article Title>》[Blog post]. Retrieved from <source-url>

   ```bibtex
   @online{kexuefm-<id>,
     title={<Article Title>},
     author={苏剑林},
     year={<YYYY>},
     month={<Mon>},
     url={\url{<source-url>}},
   }
   ```
   ```

### Step 5: Save File

Save the Markdown file to the target directory with a descriptive English filename:
- Use lowercase, hyphen-separated names
- Filename should reflect the article topic
- Example: `linear-attention-short-conv.md`, `qk-clip-muon-scaleup.md`

### Step 6: Batch Processing (if multiple URLs)

If the user provides a file containing multiple URLs (e.g., `index.md`), process them sequentially:

1. Read the file to extract all kexue.fm URLs
2. Create a todo list to track progress
3. For each URL, repeat Steps 1-5
4. Update the todo list after each article is completed
5. Report the final summary with all saved files

## Important Notes

- **Image path**: Always use relative paths like `images/filename.png` in the Markdown, not absolute paths
- **LaTeX formatting**: Carefully convert all math expressions. Common patterns:
  - Inline: `$x_t$`, `$S_t$`, `$\eta_t$`
  - Display: `$$S_t = S_{t-1} - \eta_t(S_{t-1}k_t - v_t)k_t^\top$$`
  - Matrices: Use `\begin{bmatrix}...\end{bmatrix}`
  - Cases: Use `\begin{cases}...\end{cases}`
- **Skip existing**: If a markdown file for an article already exists in the target directory, skip it and note it in the summary
- **Error handling**: If an image download fails, keep the original URL and note the failure
- **Language**: Article content should remain in its original language (Chinese). Metadata headers use Chinese labels (作者, 日期, 来源)
