#!/usr/bin/env python3
"""
PDF to Images & Markdown - 将 PDF 每页转换为图片和 Markdown
使用 pypdfium2 (PDF渲染+切分) + pdfplumber (文本提取)
License: Apache 2.0 + MIT (均可商业使用)
使用方法: python split_pdf.py <input.pdf> [output_dir] [dpi]
"""

import sys
import os

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


def pdf_page_to_image(pdf, page_num, output_path, dpi=150):
    """使用 pypdfium2 将 PDF 单页渲染为图片"""
    try:
        # 渲染页面为位图
        bitmap = pdf[page_num].render(scale=dpi/72)  # 72 是 PDF 默认 DPI
        # 转换为 PIL Image
        pil_image = bitmap.to_pil()
        # 保存为 PNG
        pil_image.save(output_path, "PNG")
        return True
    except Exception as e:
        print(f"  渲染图片失败: {e}")
        return False


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


def split_pdf(input_path, output_dir=None, dpi=150):
    if not os.path.exists(input_path):
        print(f"错误: 文件不存在 - {input_path}")
        return False
    
    if output_dir is None:
        output_dir = os.path.dirname(input_path) or "."
    
    # 创建子目录
    base_name = os.path.splitext(os.path.basename(input_path))[0]
    split_dir = os.path.join(output_dir, f"{base_name}-split")
    os.makedirs(split_dir, exist_ok=True)
    
    # 创建图片子目录
    images_dir = os.path.join(split_dir, "images")
    os.makedirs(images_dir, exist_ok=True)
    
    print(f"输出目录: {split_dir}")
    print(f"图片目录: {images_dir}")
    print(f"渲染 DPI: {dpi}")
    
    try:
        # 使用 pypdfium2 打开 PDF
        pdf = pdfium.PdfDocument(input_path)
        total_pages = len(pdf)
        print(f"总页数: {total_pages}")
        
        # 创建汇总 Markdown 文件
        summary_md = [f"# {base_name}\n", f"**总页数**: {total_pages}\n", f"**渲染 DPI**: {dpi}\n", "---\n"]
        
        for i in range(total_pages):
            page_idx = i + 1
            print(f"\n处理第 {page_idx}/{total_pages} 页...")
            
            # 1. 渲染页面为图片
            img_filename = f"{base_name}-page-{page_idx:03d}.png"
            img_path = os.path.join(images_dir, img_filename)
            
            if pdf_page_to_image(pdf, i, img_path, dpi):
                print(f"  ✓ 图片: {img_filename}")
            else:
                print(f"  ✗ 图片生成失败")
            
            # 2. 提取 Markdown
            md_content = extract_page_to_markdown(input_path, page_idx)
            
            if md_content:
                md_filename = f"{base_name}-page-{page_idx:03d}.md"
                md_path = os.path.join(split_dir, md_filename)
                
                # 添加页面分隔标记和图片引用
                full_md = f"<!-- 第 {page_idx} 页 -->\n\n"
                full_md += f"![第 {page_idx} 页](images/{img_filename})\n\n"
                full_md += f"{md_content}\n\n---\n"
                
                with open(md_path, "w", encoding="utf-8") as f:
                    f.write(full_md)
                
                print(f"  ✓ Markdown: {md_filename}")
                
                # 添加到汇总
                summary_md.append(f"## 第 {page_idx} 页\n\n")
                summary_md.append(f"![第 {page_idx} 页](images/{img_filename})\n\n")
                summary_md.append(md_content[:300] + "...\n" if len(md_content) > 300 else md_content + "\n")
                summary_md.append(f"[查看完整内容]({md_filename})\n\n---\n")
            else:
                # 即使没有文本也创建 Markdown 文件（只有图片）
                md_filename = f"{base_name}-page-{page_idx:03d}.md"
                md_path = os.path.join(split_dir, md_filename)
                
                full_md = f"<!-- 第 {page_idx} 页 -->\n\n"
                full_md += f"![第 {page_idx} 页](images/{img_filename})\n\n"
                full_md += "<!-- 本页无文本内容 -->\n\n---\n"
                
                with open(md_path, "w", encoding="utf-8") as f:
                    f.write(full_md)
                
                print(f"  ✓ Markdown: {md_filename} (无文本)")
                summary_md.append(f"## 第 {page_idx} 页\n\n")
                summary_md.append(f"![第 {page_idx} 页](images/{img_filename})\n\n")
                summary_md.append("*本页无文本内容*\n\n---\n")
        
        # 3. 保存汇总 Markdown
        summary_path = os.path.join(split_dir, f"{base_name}-summary.md")
        with open(summary_path, "w", encoding="utf-8") as f:
            f.write('\n'.join(summary_md))
        
        print(f"\n{'='*50}")
        print(f"✅ 完成!")
        print(f"   - 共处理 {total_pages} 页")
        print(f"   - 输出目录: {split_dir}")
        print(f"   - 图片目录: {images_dir}")
        print(f"   - 汇总文档: {summary_path}")
        print(f"{'='*50}")
        return True
        
    except Exception as e:
        print(f"错误: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("使用方法: python split_pdf.py <input.pdf> [output_dir] [dpi]")
        print("示例:")
        print("  python split_pdf.py document.pdf")
        print("  python split_pdf.py document.pdf ./output")
        print("  python split_pdf.py document.pdf ./output 200")
        print("\n参数:")
        print("  input.pdf   - 输入 PDF 文件")
        print("  output_dir  - 输出目录（可选，默认为 PDF 所在目录）")
        print("  dpi         - 渲染 DPI（可选，默认 150，建议 150-300）")
        sys.exit(1)
    
    input_pdf = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else None
    dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 150
    
    split_pdf(input_pdf, output_dir, dpi)
