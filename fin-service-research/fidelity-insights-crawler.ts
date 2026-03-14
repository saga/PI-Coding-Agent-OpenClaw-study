/**
 * Fidelity Insights Crawler
 * 爬取 Fidelity International 网站的研究洞察内容
 * 
 * 运行:
 *   npx ts-node fidelity-insights-crawler.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { 
  BaseWebCrawler, 
  MCPChromeDevToolsClient, 
  CrawlResult, 
  PageConfig 
} from './web-crawler';

// ============================================================================
// 类型定义
// ============================================================================

interface InsightItem {
  title: string;
  url: string;
  type: string;
  date?: string;
  readTime?: string;
  authors?: string;
  tags?: string[];
  summary?: string;
  sourcePage: string;
}

interface FidelityCrawlResult extends CrawlResult {
  insights: InsightItem[];
}

interface FidelityPageConfig extends PageConfig {
  insightSection: string;
}

// ============================================================================
// 配置
// ============================================================================

const TARGET_PAGES: FidelityPageConfig[] = [
  {
    url: "https://professionals.fidelity.co.uk/solutions/research-powered-investing",
    name: "research-powered-investing",
    insightSection: "Our latest insights",
    waitForTexts: ["Our latest insights", "Research"]
  },
  {
    url: "https://professionals.fidelity.co.uk/solutions/equities",
    name: "equities",
    insightSection: "Our latest equities insights",
    waitForTexts: ["Our latest equities insights", "Equities"]
  },
  {
    url: "https://professionals.fidelity.co.uk/solutions/fixed-income",
    name: "fixed-income",
    insightSection: "Our latest fixed income insights",
    waitForTexts: ["Our latest fixed income insights", "Fixed Income"]
  },
  {
    url: "https://professionals.fidelity.co.uk/solutions/multi-asset",
    name: "multi-asset",
    insightSection: "Our latest multi-asset insights",
    waitForTexts: ["Our latest multi-asset insights", "Multi Asset"]
  },
  {
    url: "https://professionals.fidelity.co.uk/solutions/sustainable-investing",
    name: "sustainable-investing",
    insightSection: "Our latest sustainable investing insights",
    waitForTexts: ["Our latest sustainable investing insights", "Sustainable"]
  },
  {
    url: "https://professionals.fidelity.co.uk/solutions/private-assets",
    name: "private-assets",
    insightSection: "Our latest private assets insights",
    waitForTexts: ["Our latest private assets insights", "Private Assets"]
  }
];

const OUTPUT_DIR = './crawl-results';

// ============================================================================
// Fidelity 爬虫类
// ============================================================================

class FidelityInsightsCrawler extends BaseWebCrawler<FidelityCrawlResult, FidelityPageConfig> {
  constructor() {
    super(OUTPUT_DIR);
  }

  async crawlAll(): Promise<FidelityCrawlResult[]> {
    console.log('🚀 Fidelity Insights Crawler 启动');
    console.log(`📋 目标页面数: ${TARGET_PAGES.length}`);
    console.log('=' .repeat(60));

    await this.getMcpClient().connect('fidelity-insights-crawler');

    try {
      for (const page of TARGET_PAGES) {
        const result = await this.crawlPage(page);
        this.results.push(result);
        await this.delay(2000);
      }
    } finally {
      await this.getMcpClient().disconnect();
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ 爬取完成!');
    const totalInsights = this.results.reduce((sum, r) => sum + r.insights.length, 0);
    console.log(`📊 总页面数: ${this.results.length}`);
    console.log(`📊 总洞察数: ${totalInsights}`);

    this.saveResults();
    return this.results;
  }

  async crawlPage(page: FidelityPageConfig): Promise<FidelityCrawlResult> {
    console.log(`\n🔄 正在爬取: ${page.name}`);
    console.log(`🔗 URL: ${page.url}`);
    console.log(`🎯 洞察区域: ${page.insightSection}`);
    console.log('-'.repeat(60));

    try {
      console.log('  → 步骤 1: 导航到页面...');
      await this.getMcpClient().navigatePage(page.url);

      console.log('  → 步骤 1b: 额外等待 6 秒...');
      await this.delay(6000);

      console.log('  → 步骤 1c: 检查并处理 cookie 弹窗...');
      await this.handleCookieConsent(page.name);

      console.log('  → 步骤 2: 等待页面加载...');
      await this.getMcpClient().waitFor(page.waitForTexts, 36000);
      
      console.log('  → 步骤 2b: 额外等待 8 秒...');
      await this.delay(8000);

      console.log('  → 步骤 3: 获取页面标题...');
      const titleResult = await this.getMcpClient().evaluateScript('() => document.title');
      const pageTitle = titleResult || page.name;
      console.log(`     标题: ${pageTitle}`);

      console.log('  → 步骤 4: 提取洞察内容...');
      const insights = await this.extractInsightsFromPage(page.url);
      console.log(`     找到 ${insights.length} 条洞察`);

      insights.slice(0, 3).forEach((insight, i) => {
        console.log(`     ${i + 1}. ${insight.title.substring(0, 60)}...`);
      });

      return {
        url: page.url,
        pageTitle,
        insights,
        crawlTime: new Date().toISOString()
      };

    } catch (error) {
      console.error(`❌ 爬取失败: ${page.name}`, error);
      return {
        url: page.url,
        pageTitle: page.name,
        insights: [],
        crawlTime: new Date().toISOString()
      };
    }
  }

  private async handleCookieConsent(pageName: string): Promise<void> {
    const selectInvestorTypeScript = `() => {
      const links = document.querySelectorAll('a, button');
      for (const link of links) {
        const text = (link.innerText || '').trim();
        if (text === 'Institutional Investors' || text.includes('Institutional')) {
          link.click();
          return 'Selected: ' + text;
        }
      }
      return 'No investor type selector found';
    }`;

    const comparison = await this.compareScreenshots(
      'select-investor-type',
      async () => {
        const result = await this.getMcpClient().evaluateScript(selectInvestorTypeScript);
        console.log(`     投资者类型选择: ${result}`);
        await this.delay(2000);
        return result;
      },
      pageName
    );

    if (!comparison.changed) {
      console.log(`     ⚠️ 投资者类型选择可能失败，截图已保存`);
    }

    const handleCookiesScript = `() => {
      const acceptButtons = [
        '#onetrust-accept-btn-handler',
        'button[id*="accept"]',
        'button[class*="accept"]',
        '[data-testid="accept-all"]',
        '.cc-accept',
        '.cookie-accept'
      ];
      
      for (const selector of acceptButtons) {
        try {
          const btn = document.querySelector(selector);
          if (btn && btn.offsetParent !== null) {
            btn.click();
            return 'Clicked cookie: ' + selector;
          }
        } catch (e) {}
      }
      
      const buttons = document.querySelectorAll('button, a');
      for (const btn of buttons) {
        const text = (btn.innerText || '').toLowerCase();
        if (text.includes('accept all') || text.includes('accept cookies')) {
          if (btn.offsetParent !== null) {
            btn.click();
            return 'Clicked by text: ' + text;
          }
        }
      }
      
      return 'No cookie popup found';
    }`;

    const cookieComparison = await this.compareScreenshots(
      'accept-cookies',
      async () => {
        const result = await this.getMcpClient().evaluateScript(handleCookiesScript);
        console.log(`     Cookie 处理: ${result}`);
        await this.delay(1000);
        return result;
      },
      pageName
    );

    if (!cookieComparison.changed) {
      console.log(`     ℹ️ Cookie 弹窗可能不存在或已处理`);
    }
  }

  private async extractInsightsFromPage(sourceUrl: string): Promise<InsightItem[]> {
    const insights: InsightItem[] = [];

    const extractScript = `() => {
      const cards = document.querySelectorAll('.card-article-teaser, .card');
      const results = [];
      
      cards.forEach(card => {
        const link = card.querySelector('h3 a, h2 a, .card-read-more a');
        if (link && link.href) {
          const title = link.innerText.trim();
          const url = link.href;
          
          const typeEl = card.querySelector('.section-label');
          const type = typeEl ? typeEl.innerText.trim() : 'Article';
          
          const dateEl = card.querySelector('.icon-calendar-14');
          const date = dateEl ? dateEl.innerText.trim() : '';
          
          const readTimeEl = card.querySelector('.icon-clock');
          const readTime = readTimeEl ? readTimeEl.innerText.trim() : '';
          
          const authorsEl = card.querySelector('.icon-person');
          const authors = authorsEl ? authorsEl.innerText.trim() : '';
          
          const summaryEl = card.querySelector('p');
          const summary = summaryEl ? summaryEl.innerText.trim().substring(0, 500) : '';
          
          if (title && url && !results.find(i => i.url === url)) {
            results.push({ title, url, type, date, readTime, authors, summary });
          }
        }
      });
      
      return results.slice(0, 15);
    }`;

    try {
      const result = await this.getMcpClient().evaluateScript(extractScript);
      console.log('     [DEBUG] 提取结果:', JSON.stringify(result).substring(0, 500));
      
      if (Array.isArray(result)) {
        result.forEach(item => {
          insights.push({
            title: item.title,
            url: item.url,
            type: item.type || 'Article',
            date: item.date,
            readTime: item.readTime,
            authors: item.authors,
            summary: item.summary,
            sourcePage: sourceUrl
          });
        });
      }
    } catch (error) {
      console.log('     提取失败:', error);
    }

    return insights;
  }

  saveResults(): void {
    const output = {
      crawlTime: new Date().toISOString(),
      totalPages: this.results.length,
      totalInsights: this.results.reduce((sum, r) => sum + r.insights.length, 0),
      results: this.results
    };

    const jsonFile = path.join(this.outputDir, `fidelity-insights-${this.formatDate(new Date())}.json`);
    fs.writeFileSync(jsonFile, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\n💾 汇总 JSON: ${jsonFile}`);

    const mdFile = path.join(this.outputDir, `fidelity-insights-report-${this.formatDate(new Date())}.md`);
    this.saveMarkdownReport(mdFile, output);
    console.log(`💾 Markdown 报告: ${mdFile}`);

    this.results.forEach(result => {
      const safeName = result.pageTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const pageFile = path.join(this.outputDir, `fidelity-${safeName}-${this.formatDate(new Date())}.json`);
      fs.writeFileSync(pageFile, JSON.stringify(result, null, 2), 'utf-8');
    });
  }

  private saveMarkdownReport(filepath: string, data: any): void {
    let content = '# Fidelity International 研究洞察报告\n\n';
    content += `**爬取时间**: ${data.crawlTime}\n\n`;
    content += `**总页面数**: ${data.totalPages}\n`;
    content += `**总洞察数**: ${data.totalInsights}\n\n`;
    content += '---\n\n';

    for (const result of data.results) {
      content += `## ${result.pageTitle}\n\n`;
      content += `**URL**: ${result.url}\n\n`;

      if (result.insights.length > 0) {
        content += '### 最新洞察\n\n';
        for (const insight of result.insights) {
          content += `#### [${insight.title}](${insight.url})\n\n`;
          content += `- **类型**: ${insight.type}\n`;
          if (insight.date) {
            content += `- **日期**: ${insight.date}\n`;
          }
          if (insight.readTime) {
            content += `- **阅读时间**: ${insight.readTime}\n`;
          }
          if (insight.authors) {
            content += `- **作者**: ${insight.authors}\n`;
          }
          if (insight.tags && insight.tags.length > 0) {
            content += `- **标签**: ${insight.tags.join(', ')}\n`;
          }
          if (insight.summary) {
            content += `\n${insight.summary}\n`;
          }
          content += '\n';
        }
      } else {
        content += '*暂无洞察内容*\n\n';
      }

      content += '---\n\n';
    }

    fs.writeFileSync(filepath, content, 'utf-8');
  }
}

// ============================================================================
// 主函数
// ============================================================================

let globalCrawler: FidelityInsightsCrawler | null = null;

async function main(): Promise<void> {
  console.log('\n' + '='.repeat(80));
  console.log('Fidelity Insights Crawler');
  console.log('使用 MCP SDK 调用 Chrome DevTools');
  console.log('='.repeat(80));

  globalCrawler = new FidelityInsightsCrawler();

  try {
    await globalCrawler.crawlAll();
    console.log('\n' + '='.repeat(80));
    console.log('✅ 所有页面爬取完成!');
    console.log(`📁 结果保存在: ${OUTPUT_DIR}/`);
    console.log('='.repeat(80));
  } catch (error) {
    console.error('\n❌ 爬虫执行失败:', error);
    process.exit(1);
  }
}

main();

export { FidelityInsightsCrawler, InsightItem, FidelityCrawlResult, FidelityPageConfig };
