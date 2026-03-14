/**
 * Fidelity Content Fetcher
 * 深度抓取 Fidelity International 网站的具体内容页面
 *
 * 运行:
 *   npx ts-node fidelity-content-fetcher.ts
 *
 * 支持两种模式：
 *   - insight-cards：抓取 investment-insight 页面的卡片列表（按日期过滤）
 *   - search-and-fetch：搜索关键词 → 获取文章链接 → 逐篇抓取正文
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

interface ContentItem {
  title: string;
  url: string;
  date: string;
  type: string;
  meta: string;
  summary: string;
  /** 完整正文（search-and-fetch 模式下填充） */
  body?: string;
}

interface FetchResult extends CrawlResult {
  taskName: string;
  items: ContentItem[];
}

interface FetchTask extends PageConfig {
  taskName: string;
  contentType: 'insight-cards' | 'search-and-fetch';
  /** insight-cards：只保留最近多少天，默认 30 */
  recentDays?: number;
  /** search-and-fetch：搜索关键词 */
  searchQuery?: string;
  /** search-and-fetch：最多抓取几篇正文，默认 10 */
  maxArticles?: number;
}

// ============================================================================
// 配置
// ============================================================================

const FETCH_TASKS: FetchTask[] = [
  // 任务一：抓取 investment-insight 卡片列表（最近30天）- 暂时禁用
  // {
  //   taskName: 'investment-insight',
  //   contentType: 'insight-cards',
  //   url: 'https://professionals.fidelity.co.uk/perspectives/investment-insight',
  //   name: 'investment-insight',
  //   waitForTexts: ['investment', 'insight'],
  //   recentDays: 30
  // },
  // 任务二：搜索 Iran conflict 2026 相关文章并抓取正文
  {
    taskName: 'iran-conflict-search',
    contentType: 'search-and-fetch',
    url: 'https://professionals.fidelity.co.uk/perspectives/investment-insight',
    name: 'iran-conflict-search',
    waitForTexts: ['insight'],
    searchQuery: 'Iran conflict 2026',
    maxArticles: 10
  }
];

const OUTPUT_DIR = './crawl-results';
const BASE_URL = 'https://professionals.fidelity.co.uk';

// ============================================================================
// 主类
// ============================================================================

class FidelityContentFetcher extends BaseWebCrawler<FetchResult, FetchTask> {
  private popupsHandled = false;

  constructor() {
    super(OUTPUT_DIR);
  }

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
    console.log(`\n🔄 任务: ${task.taskName} [${task.contentType}]`);
    console.log(`🔗 URL: ${task.url}`);
    console.log('-'.repeat(60));

    try {
      // 1. 导航
      console.log('  → 导航到页面...');
      await this.getMcpClient().navigatePage(task.url);
      try { await this.getMcpClient().waitFor(task.waitForTexts, 30000); } catch {}
      console.log('  → 额外等待 6 秒...');
      await this.delay(6000);

      // 2. 弹窗（只处理一次，后续页面 session 已记住）
      if (!this.popupsHandled) {
        console.log('  → 处理弹窗...');
        await this.handleInitialPopups();
        this.popupsHandled = true;
      }

      // 3. 按 contentType 分发
      let items: ContentItem[] = [];
      if (task.contentType === 'insight-cards') {
        items = await this.extractInsightCards(task);
      } else if (task.contentType === 'search-and-fetch') {
        items = await this.searchAndFetch(task);
      }

      console.log(`  ✅ 找到 ${items.length} 条内容`);
      const title = await this.getMcpClient().evaluateScript('() => document.title');
      return { url: task.url, pageTitle: title || task.taskName, taskName: task.taskName, items, crawlTime: new Date().toISOString() };

    } catch (error) {
      console.error(`❌ 任务失败: ${task.taskName}`, error);
      return { url: task.url, pageTitle: task.taskName, taskName: task.taskName, items: [], crawlTime: new Date().toISOString() };
    }
  }

  // ── 弹窗处理 ────────────────────────────────────────────────

  private async handleInitialPopups(): Promise<void> {
    const r1 = await this.getMcpClient().evaluateScript(`() => {
      for (const el of document.querySelectorAll('a,button')) {
        const t = (el.innerText || '').trim();
        if (t === 'Institutional Investors' || t.includes('Institutional')) {
          el.click(); return 'Clicked: ' + t;
        }
      }
      return 'Not found';
    }`);
    console.log(`     投资者弹窗: ${r1}`);
    await this.delay(2000);

    const r2 = await this.getMcpClient().evaluateScript(`() => {
      for (const sel of ['#onetrust-accept-btn-handler','button[id*="accept"]','button[class*="accept"]']) {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null) { btn.click(); return 'Clicked: ' + sel; }
      }
      for (const btn of document.querySelectorAll('button,a')) {
        const t = (btn.innerText || '').toLowerCase();
        if ((t.includes('accept all') || t.includes('accept cookies')) && btn.offsetParent !== null) {
          btn.click(); return 'Clicked by text: ' + t;
        }
      }
      return 'Not found';
    }`);
    console.log(`     Cookie 弹窗: ${r2}`);
    await this.delay(1500);
  }

  // ── insight-cards 模式 ───────────────────────────────────────

  private async extractInsightCards(task: FetchTask): Promise<ContentItem[]> {
    const recentDays = task.recentDays ?? 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - recentDays);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    const raw: ContentItem[] = await this.getMcpClient().evaluateScript(`() => {
      const results = [];
      document.querySelectorAll('.card-article-teaser-content').forEach(c => {
        const a = c.querySelector('h3 a');
        if (!a) return;
        const title = a.innerText.trim();
        const href = a.getAttribute('href') || '';
        const url = href.startsWith('http') ? href : '${BASE_URL}' + href;
        const type = c.querySelector('.section-label')?.innerText.trim() || 'Article';
        const metaEl = c.querySelector('.card-meta,.meta,[class*="meta"]');
        const meta = metaEl ? metaEl.innerText.trim() : c.innerText.replace(title,'').trim().substring(0,150);
        const summary = c.querySelector('p')?.innerText.trim().substring(0,300) || '';
        const urlDate = (href.match(/\\d{4}-\\d{2}-\\d{2}/) || [])[0] || '';
        const md = meta.match(/(\\d{2})\\/(\\d{2})\\/(\\d{4})/);
        const date = urlDate || (md ? md[3]+'-'+md[2]+'-'+md[1] : '');
        results.push({ title, url, date, type, meta, summary });
      });
      return results;
    }`) || [];

    return raw.filter(item => !item.date || item.date >= cutoffStr);
  }

  // ── search-and-fetch 模式 ────────────────────────────────────

  private async searchAndFetch(task: FetchTask): Promise<ContentItem[]> {
    const query = task.searchQuery || '';
    const maxArticles = task.maxArticles ?? 10;
    console.log(`  → 搜索: "${query}"`);

    // 直接导航到搜索结果页（绕过搜索框触发问题）
    const searchUrl = `${BASE_URL}/search/query/${encodeURIComponent(query)}`;
    console.log(`  → 导航到搜索结果页: ${searchUrl}`);
    await this.getMcpClient().navigatePage(searchUrl);

    // 轮询等待搜索结果（每3秒检查一次，最多30秒）
    console.log('  → 等待搜索结果（最多30秒，轮询中）...');
    let searchLinks: { text: string; href: string }[] = [];
    for (let i = 0; i < 10; i++) {
      await this.delay(3000);
      searchLinks = await this.getMcpClient().evaluateScript(`() => {
        return Array.from(document.querySelectorAll('a[href*="/articles/"], a[href*="/page/"]'))
          .map(a => ({ text: (a.innerText || a.textContent || '').trim().substring(0, 120), href: a.href }))
          .filter(a => a.text.length > 5)
          .filter((a, i, arr) => arr.findIndex(b => b.href === a.href) === i); // 去重
      }`) || [];
      console.log(`     第${i+1}次检查: ${searchLinks.length} 条结果`);
      if (searchLinks.length > 0) break;
      if (i === 2) {
        const debug = await this.getMcpClient().evaluateScript(`() => document.body.innerText.substring(0, 500)`);
        console.log(`     [debug] 页面内容: ${debug}`);
      }
    }

    console.log(`  → 找到 ${searchLinks.length} 个搜索结果，抓取前 ${maxArticles} 篇正文`);

    const items: ContentItem[] = [];
    const toFetch = searchLinks.slice(0, maxArticles);

    for (const link of toFetch) {
      console.log(`  → 抓取: ${link.text.substring(0, 60)}...`);
      await this.getMcpClient().navigatePage(link.href);
      await this.delay(5000);

      const body: string = await this.getMcpClient().evaluateScript(`() =>
        (document.querySelector('body')?.innerText || '').trim().substring(0, 6000)
      `) || '';

      // 从 URL 或正文提取日期
      const urlDateMatch = link.href.match(/\d{4}-\d{2}-\d{2}/);
      const bodyDateMatch = body.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      let date = '';
      if (urlDateMatch) {
        date = urlDateMatch[0];
      } else if (bodyDateMatch) {
        date = `${bodyDateMatch[3]}-${bodyDateMatch[2]}-${bodyDateMatch[1]}`;
      }

      items.push({
        title: link.text,
        url: link.href,
        date,
        type: 'Article',
        meta: '',
        summary: body.substring(0, 300),
        body
      });

      await this.delay(2000);
    }

    return items;
  }

  // ── 保存结果 ─────────────────────────────────────────────────

  saveResults(): void {
    if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });
    const dateStr = this.formatDate(new Date());

    for (const result of this.results) {
      const output = {
        source: result.url,
        taskName: result.taskName,
        crawlTime: result.crawlTime,
        total: result.items.length,
        items: result.items
      };
      const jsonFile = path.join(this.outputDir, `${result.taskName}-${dateStr}.json`);
      fs.writeFileSync(jsonFile, JSON.stringify(output, null, 2), 'utf-8');
      console.log(`💾 ${jsonFile}`);
    }

    const total = this.results.reduce((s, r) => s + r.items.length, 0);
    console.log(`\n📊 总任务: ${this.results.length}，总条目: ${total}`);
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
