/**
 * 抓取单篇文章 — 使用 BaseWebCrawler.executePage 核心流程
 * 目标: https://www.fidelityinternational.com/articles/expert-opinions/ais-big-breakthrough-wont-happen-this-year-c236d3
 * 运行: npx ts-node fetch-single-article.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { BaseWebCrawler, CrawlResult, PageConfig } from './web-crawler';

const TARGET_URL = 'https://www.fidelityinternational.com/articles/expert-opinions/ais-big-breakthrough-wont-happen-this-year-c236d3';
const OUTPUT_DIR = './fidelity-international-research';

interface ArticleResult extends CrawlResult {
  body: string;
}

class SingleArticleFetcher extends BaseWebCrawler<ArticleResult, PageConfig> {
  constructor() {
    super(OUTPUT_DIR);
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  async run(): Promise<void> {
    await this.getMcpClient().connect('fetch-article');
    try {
      await this.executePage(TARGET_URL, {
        // 阶段3: fidelityinternational.com 需要先点投资者类型，再处理 cookie
        // 默认 handlePopup 已覆盖投资者类型关键词，这里直接复用
        // 阶段6: 保存结果
        onSave: async (content, pageTitle, url) => {
          if (content.length < 200) {
            console.log('⚠️  正文太短，可能未成功提取，请查看截图');
            return;
          }
          const slug = url.split('/').pop() || 'article';
          const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
          const filename = `fidelityinternational-${slug}-${date}.json`;
          const outputPath = path.join(OUTPUT_DIR, filename);
          const result = { url, pageTitle, crawlTime: new Date().toISOString(), body: content };
          fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
          console.log(`\n✅ 已保存: ${outputPath}`);
        },
      });
    } finally {
      await this.getMcpClient().disconnect();
    }
  }

  saveResults(): void {}
  async crawlAll(): Promise<ArticleResult[]> { return []; }
  async crawlPage(_p: PageConfig): Promise<ArticleResult> {
    return { url: '', pageTitle: '', crawlTime: '', body: '' };
  }
}

async function main() {
  const fetcher = new SingleArticleFetcher();
  await fetcher.run();
}

main().catch(console.error);
