#!/usr/bin/env python3
"""
PDF Splitter - 将 PDF 按页切分成多个文件，并提取为 Markdown
使用 pypdfium2 (切分) + pdfplumber (文本提取)
License: Apache 2.0 + MIT (均可商业使用)
使用方法: python split_pdf.py <input.pdf> [output_dir]
"""

import sys
import os
import re

try:
    import pypdfium2 as pdfium
except ImportError:
    print("请先安装 pypdfium2: pip install pypdfium2")
    sys.exit(1)

try:
    import pdfplumber
except ImportError:
    print("请先安装 pdfplumber: pip install pdfplumber")
    sys.exit(1)


def extract_page_to_markdown(pdf_path, page_num):
    """使用 pdfplumber 提取单页内容并转换为 Markdown"""
    markdown_content = []
    
    with pdfplumber.open(pdf_path) as pdf:
        if page_num < 1 or page_num > len(pdf.pages):
            return None
        
        page = pdf.pages[page_num - 1]
        
        # 提取文本
        text = page.extract_text()
        if text:
            # 清理文本
            text = text.strip()
            # 尝试识别标题（简单启发式：短行、大写、无标点结尾）
            lines = text.split('\n')
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                
                # 简单的标题检测
                if len(line) < 100 and line.isupper() and not line.endswith(('.', '?', '!')):
                    markdown_content.append(f"## {line}")
                elif len(line) < 50 and line.endswith(':') and not line[0].islower():
                    markdown_content.append(f"### {line}")
                else:
                    markdown_content.append(line)
        
        # 提取表格
        tables = page.extract_tables()
        if tables:
            markdown_content.append("\n<!-- 表格 -->")
            for table in tables:
                if table:
                    # 转换为 Markdown 表格
                    markdown_content.append("")
                    for i, row in enumerate(table):
                        # 清理单元格
                        clean_row = [str(cell).replace('\n', ' ') if cell else "" for cell in row]
                        markdown_content.append("| " + " | ".join(clean_row) + " |")
                        if i == 0:
                            markdown_content.append("| " + " | ".join(["---"] * len(row)) + " |")
                    markdown_content.append("")
        
        # 提取图片标记
        images = page.images
        if images:
            markdown_content.append(f"\n<!-- 页面包含 {len(images)} 个图片 -->")
            for img_idx, img in enumerate(images, 1):
                markdown_content.append(f"<图片 {img_idx}>")
    
    return '\n'.join(markdown_content)


def split_pdf(input_path, output_dir=None):
    if not os.path.exists(input_path):
        print(f"错误: 文件不存在 - {input_path}")
        return False
    
    if output_dir is None:
        output_dir = os.path.dirname(input_path) or "."
    
    # 创建子目录
    base_name = os.path.splitext(os.path.basename(input_path))[0]
    split_dir = os.path.join(output_dir, f"{base_name}-split")
    os.makedirs(split_dir, exist_ok=True)
    
    print(f"输出目录: {split_dir}")
    
    try:
        # 使用 pypdfium2 切分 PDF
        pdf = pdfium.PdfDocument(input_path)
        total_pages = len(pdf)
        print(f"总页数: {total_pages}")
        
        # 创建汇总 Markdown 文件
        summary_md = [f"# {base_name}\n", f"**总页数**: {total_pages}\n", "---\n"]
        
        for i in range(total_pages):
            page_idx = i + 1
            
            # 1. 切分 PDF 单页
            new_pdf = pdfium.PdfDocument.new()
            new_pdf.import_pages(pdf, [i])
            
            pdf_filename = f"{base_name}-page-{page_idx:03d}.pdf"
            pdf_path = os.path.join(split_dir, pdf_filename)
            with open(pdf_path, "wb") as output_file:
                output_file.write(new_pdf.write())
            
            print(f"已创建 PDF: {pdf_filename}")
            
            # 2. 提取 Markdown
            md_content = extract_page_to_markdown(input_path, page_idx)
            
            if md_content:
                md_filename = f"{base_name}-page-{page_idx:03d}.md"
                md_path = os.path.join(split_dir, md_filename)
                
                # 添加页面分隔标记
                full_md = f"<!-- 第 {page_idx} 页 -->\n\n{md_content}\n\n---\n"
                
                with open(md_path, "w", encoding="utf-8") as f:
                    f.write(full_md)
                
                print(f"已创建 Markdown: {md_filename}")
                
                # 添加到汇总
                summary_md.append(f"## 第 {page_idx} 页\n")
                summary_md.append(md_content[:500] + "...\n" if len(md_content) > 500 else md_content + "\n")
                summary_md.append(f"[查看完整内容]({md_filename})\n\n---\n")
            else:
                print(f"警告: 第 {page_idx} 页无文本内容")
        
        # 3. 保存汇总 Markdown
        summary_path = os.path.join(split_dir, f"{base_name}-summary.md")
        with open(summary_path, "w", encoding="utf-8") as f:
            f.write('\n'.join(summary_md))
        
        print(f"\n✅ 完成!")
        print(f"   - 共切分 {total_pages} 页")
        print(f"   - PDF 文件: {split_dir}")
        print(f"   - 汇总文档: {summary_path}")
        return True
        
    except Exception as e:
        print(f"错误: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("使用方法: python split_pdf.py <input.pdf> [output_dir]")
        print("示例: python split_pdf.py document.pdf ./output")
        sys.exit(1)
    
    input_pdf = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else None
    
    split_pdf(input_pdf, output_dir)
