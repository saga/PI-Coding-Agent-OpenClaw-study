/**
 * Fidelity Content Fetcher
 * 深度抓取 Fidelity International 网站的具体内容页面
 *
 * 运行:
 *   npx ts-node fidelity-content-fetcher.ts
 *
 * 与 fidelity-insights-crawler.ts 的区别：
 *   - insights-crawler：抓取各板块首页的文章列表（广度）
 *   - content-fetcher：抓取具体内容页面的正文、数据、图表（深度）
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  BaseWebCrawler,
  CrawlResult,
  PageConfig
} from './web-crawler';

// ============================================================================
// 类型定义
// ============================================================================

/** 单个卡片/内容条目 */
interface ContentItem {
  title: string;
  url: string;
  date: string;
  type: string;
  meta: string;
  summary: string;
}

/** 单次任务的抓取结果 */
interface FetchResult extends CrawlResult {
  taskName: string;
  items: ContentItem[];
}

/** 抓取任务配置 */
interface FetchTask extends PageConfig {
  taskName: string;
  contentType: string;
  /** 只保留最近多少天内的内容，默认 30 */
  recentDays?: number;
}

// ============================================================================
// 配置
// ============================================================================

const FETCH_TASKS: FetchTask[] = [
  {
    taskName: 'investment-insight',
    contentType: 'insight-cards',
    url: 'https://professionals.fidelity.co.uk/perspectives/investment-insight',
    name: 'investment-insight',
    waitForTexts: ['investment', 'insight'],
    recentDays: 30
  }
];

const OUTPUT_DIR = './crawl-results';

// ============================================================================
// 主类
// ============================================================================

class FidelityContentFetcher extends BaseWebCrawler<FetchResult, FetchTask> {
  constructor() {
    super(OUTPUT_DIR);
  }

  /** 实现基类抽象方法 */
  async crawlAll(): Promise<FetchResult[]> {
    console.log('🚀 Fidelity Content Fetcher 启动');
    console.log(`📋 任务数: ${FETCH_TASKS.length}`);
    console.log('='.repeat(60));

    await this.getMcpClient().connect('fidelity-content-fetcher');

    try {
      for (const task of FETCH_TASKS) {
        const result = await this.crawlPage(task);
        this.results.push(result);
        await this.delay(2000);
      }
    } finally {
      await this.getMcpClient().disconnect();
    }

    console.log('\n' + '='.repeat(60));
    const totalItems = this.results.reduce((sum, r) => sum + r.items.length, 0);
    console.log(`✅ 完成！总任务: ${this.results.length}，总条目: ${totalItems}`);
    this.saveResults();
    return this.results;
  }

  async crawlPage(task: FetchTask): Promise<FetchResult> {
    console.log(`\n🔄 任务: ${task.taskName} — ${task.url}`);
    console.log('-'.repeat(60));

    try {
      // 1. 导航
      console.log('  → 导航到页面...');
      await this.getMcpClient().navigatePage(task.url);

      // 2. 等待加载 + 额外 6 秒
      console.log('  → 等待页面加载...');
      try { await this.getMcpClient().waitFor(task.waitForTexts, 30000); } catch {}
      console.log('  → 额外等待 6 秒...');
      await this.delay(6000);

      // 3. 处理弹窗
      console.log('  → 处理弹窗...');
      await this.handleInitialPopups();

      // 4. 提取内容
      console.log('  → 提取内容...');
      const items = await this.extractContent(task);
      console.log(`     找到 ${items.length} 条（过滤后）`);

      const title = await this.getMcpClient().evaluateScript('() => document.title');
      return { url: task.url, pageTitle: title || task.taskName, taskName: task.taskName, items, crawlTime: new Date().toISOString() };

    } catch (error) {
      console.error(`❌ 任务失败: ${task.taskName}`, error);
      return { url: task.url, pageTitle: task.taskName, taskName: task.taskName, items: [], crawlTime: new Date().toISOString() };
    }
  }

  /** 处理投资者类型弹窗 + Cookie 弹窗 */
  private async handleInitialPopups(): Promise<void> {
    const r1 = await this.getMcpClient().evaluateScript(`() => {
      const links = document.querySelectorAll('a, button');
      for (const link of links) {
        const text = (link.innerText || '').trim();
        if (text === 'Institutional Investors' || text.includes('Institutional')) {
          link.click(); return 'Clicked: ' + text;
        }
      }
      return 'Not found';
    }`);
    console.log(`     投资者弹窗: ${r1}`);
    await this.delay(2000);

    const r2 = await this.getMcpClient().evaluateScript(`() => {
      const selectors = ['#onetrust-accept-btn-handler','button[id*="accept"]','button[class*="accept"]'];
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn && (btn as HTMLElement).offsetParent !== null) { btn.click(); return 'Clicked: ' + sel; }
      }
      const btns = document.querySelectorAll('button, a');
      for (const btn of btns) {
        const t = ((btn as HTMLElement).innerText || '').toLowerCase();
        if ((t.includes('accept all') || t.includes('accept cookies')) && (btn as HTMLElement).offsetParent !== null) {
          btn.click(); return 'Clicked by text: ' + t;
        }
      }
      return 'Not found';
    }`);
    console.log(`     Cookie 弹窗: ${r2}`);
    await this.delay(1500);
  }

  /** 根据 contentType 分发提取逻辑 */
  private async extractContent(task: FetchTask): Promise<ContentItem[]> {
    switch (task.contentType) {
      case 'insight-cards':
        return this.extractInsightCards(task);
      default:
        console.log(`     ⚠️ 未知 contentType: ${task.contentType}`);
        return [];
    }
  }

  /**
   * 提取 investment-insight 页面的卡片列表
   * 过滤：只保留最近 recentDays 天内的内容
   */
  private async extractInsightCards(task: FetchTask): Promise<ContentItem[]> {
    const recentDays = task.recentDays ?? 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - recentDays);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    const script = `() => {
      const contents = document.querySelectorAll('.card-article-teaser-content');
      const results = [];
      contents.forEach(c => {
        const a = c.querySelector('h3 a');
        if (!a) return;
        const title = a.innerText.trim();
        const href = a.getAttribute('href') || '';
        const url = href.startsWith('http') ? href : 'https://professionals.fidelity.co.uk' + href;
        const typeEl = c.querySelector('.section-label');
        const type = typeEl ? typeEl.innerText.trim() : 'Article';
        const metaEl = c.querySelector('.card-meta, .meta, [class*="meta"]');
        const meta = metaEl ? metaEl.innerText.trim() : c.innerText.replace(title, '').trim().substring(0, 150);
        const summaryEl = c.querySelector('p');
        const summary = summaryEl ? summaryEl.innerText.trim().substring(0, 300) : '';
        // 从 URL 或 meta 解析日期
        const urlDate = (href.match(/\\d{4}-\\d{2}-\\d{2}/) || [])[0] || '';
        const metaDate = (meta.match(/(\\d{2})\\/(\\d{2})\\/(\\d{4})/) || []);
        const date = urlDate || (metaDate.length ? metaDate[3] + '-' + metaDate[2] + '-' + metaDate[1] : '');
        results.push({ title, url, date, type, meta, summary });
      });
      return results;
    }`;

    const raw: ContentItem[] = await this.getMcpClient().evaluateScript(script) || [];

    // 过滤最近 N 天
    return raw.filter(item => {
      if (!item.date) return true; // 无日期的保留
      return item.date >= cutoffStr;
    });
  }

  saveResults(): void {
    if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });

    const dateStr = this.formatDate(new Date());
    const totalItems = this.results.reduce((sum, r) => sum + r.items.length, 0);

    for (const result of this.results) {
      const output = {
        source: result.url,
        crawlTime: result.crawlTime,
        filter: '最近30天',
        total: result.items.length,
        schema: { title: '文章标题', url: '完整链接', date: '日期(YYYY-MM-DD)', type: '内容类型', meta: '元信息', summary: '摘要(前300字符)' },
        items: result.items
      };
      const jsonFile = path.join(this.outputDir, `${result.taskName}-cards-${dateStr}.json`);
      fs.writeFileSync(jsonFile, JSON.stringify(output, null, 2), 'utf-8');
      console.log(`💾 ${jsonFile}`);
    }

    console.log(`\n📊 总任务: ${this.results.length}，总条目: ${totalItems}`);
  }
}

// ============================================================================
// 主函数
// ============================================================================

async function main(): Promise<void> {
  console.log('\n' + '='.repeat(80));
  console.log('Fidelity Content Fetcher');
  console.log('='.repeat(80));
  const fetcher = new FidelityContentFetcher();
  try {
    await fetcher.crawlAll();
    console.log(`\n📁 结果保存在: ${OUTPUT_DIR}/`);
  } catch (error) {
    console.error('\n❌ 执行失败:', error);
    process.exit(1);
  }
}

main();

export { FidelityContentFetcher, ContentItem, FetchResult, FetchTask };
