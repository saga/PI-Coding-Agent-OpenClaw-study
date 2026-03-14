/**
 * Fidelity Sustainable Investing Crawler
 * 抓取 Fidelity International 关于 Sustainable Investing (SI) 的内容
 *
 * 运行:
 *   npx ts-node fidelity-si-crawler.ts
 *
 * 两个阶段：
 *   Phase 1: 直接抓取 SI 专题页 + 用多个搜索词搜索，收集所有文章链接
 *   Phase 2: 逐篇抓取正文，保存到 JSON
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseWebCrawler, CrawlResult } from './web-crawler';

// ============================================================================
// 类型定义
// ============================================================================

interface ArticleLink {
  title: string;
  url: string;
  source: string; // 来自哪个搜索词或页面
}

interface ArticleContent {
  title: string;
  url: string;
  date: string;
  source: string;
  body: string;
}

interface SICrawlResult extends CrawlResult {
  phase: 'links' | 'content';
  links?: ArticleLink[];
  articles?: ArticleContent[];
}

// ============================================================================
// 配置
// ============================================================================

const BASE_URL = 'https://www.fidelity.lu';
const OUTPUT_DIR = './crawl-results';

// SI 专题页（直接导航抓取）
const SI_PAGES = [
  'https://www.fidelity.lu/sustainable-investing/our-approach',
  'https://www.fidelity.lu/sustainable-investing',
];

// 搜索词列表（覆盖 SI 各维度）
const SEARCH_QUERIES = [
  'sustainable investing',
  'ESG integration',
  'stewardship engagement',
  'climate change',
  'responsible investing',
  'net zero',
  'biodiversity',
  'social impact',
];

// ============================================================================
// 主类
// ============================================================================

class FidelitySICrawler extends BaseWebCrawler<SICrawlResult, any> {
  private popupsHandled = false;  // 已废弃，保留兼容性
  private collectedLinks: ArticleLink[] = [];

  constructor() {
    super(OUTPUT_DIR);
  }

  async run(): Promise<void> {
    console.log('\n' + '='.repeat(70));
    console.log('Fidelity SI Crawler - Phase 1: 收集链接');
    console.log('='.repeat(70));

    await this.getMcpClient().connect('fidelity-si-crawler');

    try {
      // Phase 1: 收集链接
      await this.phase1CollectLinks();

      // 去重
      const unique = this.deduplicateLinks(this.collectedLinks);
      console.log(`\n📋 去重后共 ${unique.length} 个链接`);

      // 保存链接列表
      this.saveLinks(unique);

      // Phase 2: 逐篇抓取正文
      console.log('\n' + '='.repeat(70));
      console.log('Phase 2: 逐篇抓取正文');
      console.log('='.repeat(70));
      const articles = await this.phase2FetchArticles(unique);

      // 保存文章内容
      this.saveArticles(articles);

    } finally {
      await this.getMcpClient().disconnect();
    }
  }

  // ── Phase 1: 收集链接 ────────────────────────────────────────

  private async phase1CollectLinks(): Promise<void> {
    // 1a. 直接抓 SI 专题页的链接
    for (const pageUrl of SI_PAGES) {
      await this.collectFromPage(pageUrl, 'si-page');
    }

    // 1b. 用搜索词搜索
    for (const query of SEARCH_QUERIES) {
      await this.collectFromSearch(query);
      await this.delay(2000);
    }
  }

  private async collectFromPage(pageUrl: string, source: string): Promise<void> {
    console.log(`\n🔗 直接抓页面链接: ${pageUrl}`);

    await this.withTimeout(`navigate:${source}`, async () => {
      await this.getMcpClient().navigatePage(pageUrl);
      await this.delay(6000);
    });

    // 每次导航后都处理弹窗
    await this.withTimeout('handle-popups', () => this.handlePopups());

    const links: ArticleLink[] = await this.withTimeout(`extract-links:${source}`, () =>
      this.getMcpClient().evaluateScript(`() => {
        const SI_KEYWORDS = ['/sustainable', '/esg', '/responsible', '/stewardship',
          '/climate', '/net-zero', '/biodiversity', '/social', '/governance',
          '/articles/', '/insights/', '/solutions/', '/page/'];
        return Array.from(document.querySelectorAll('a[href]'))
          .map(a => ({ title: (a.innerText || a.textContent || '').trim().substring(0, 150), url: a.href }))
          .filter(a => a.url.startsWith('https://www.fidelity.lu'))
          .filter(a => SI_KEYWORDS.some(k => a.url.includes(k)))
          .filter(a => !a.url.includes('javascript:') && !a.url.endsWith('#'))
          .filter(a => a.title.length > 5)
          .filter((a, i, arr) => arr.findIndex(b => b.url === a.url) === i);
      }`)
    ) || [];

    console.log(`   找到 ${links.length} 个链接`);
    links.forEach(l => this.collectedLinks.push({ ...l, source }));
  }


  private async collectFromSearch(query: string): Promise<void> {
    const searchUrl = `${BASE_URL}/search/query/${encodeURIComponent(query)}`;
    console.log(`\n🔍 搜索: "${query}"`);

    await this.withTimeout(`navigate:search:${query}`, async () => {
      await this.getMcpClient().navigatePage(searchUrl);
      await this.delay(5000); // 等页面加载
    });

    // 每次导航后处理弹窗
    await this.withTimeout('handle-popups', () => this.handlePopups());

    // 截图记录搜索结果页状态，不暂停
    await this.checkPageState(
      `搜索 "${query}" 后的页面状态`,
      `搜索结果页应显示文章列表，不应有任何弹窗遮挡。如果有弹窗，说明 handlePopups 没有成功关闭它`,
      false
    );

    // LLM 确认页面正常后，提取链接
    const links: ArticleLink[] = await this.withTimeout(`extract-links:search:${query}`, () =>
      this.getMcpClient().evaluateScript(`() => {
        const SI_KEYWORDS = ['/sustainable', '/esg', '/responsible', '/stewardship',
          '/climate', '/net-zero', '/biodiversity', '/social', '/governance',
          '/articles/', '/insights/', '/solutions/', '/page/'];
        return Array.from(document.querySelectorAll('a[href]'))
          .map(a => ({ title: (a.innerText || a.textContent || '').trim().substring(0, 150), url: a.href }))
          .filter(a => a.url.startsWith('https://www.fidelity.lu'))
          .filter(a => SI_KEYWORDS.some(k => a.url.includes(k)))
          .filter(a => !a.url.includes('javascript:') && !a.url.endsWith('#'))
          .filter(a => a.title.length > 5)
          .filter((a, i, arr) => arr.findIndex(b => b.url === a.url) === i);
      }`)
    ) || [];

    console.log(`   "${query}" 找到 ${links.length} 个链接`);
    links.forEach(l => this.collectedLinks.push({ ...l, source: `search:${query}` }));
  }

  // ── Phase 2: 逐篇抓取正文 ────────────────────────────────────

  private async phase2FetchArticles(links: ArticleLink[]): Promise<ArticleContent[]> {
    const articles: ArticleContent[] = [];

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      console.log(`\n[${i+1}/${links.length}] 抓取: ${link.title.substring(0, 60)}`);
      console.log(`   URL: ${link.url}`);

      try {
        await this.withTimeout(`navigate:article:${i+1}`, async () => {
          await this.getMcpClient().navigatePage(link.url);
          await this.delay(5000);
        });

        const body: string = await this.withTimeout(`extract-body:${i+1}`, () =>
          this.getMcpClient().evaluateScript(`() => {
            const selectors = [
              'article', '.article-body', '.content-body', '.cmp-text',
              'main', '.main-content', '[role="main"]'
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el && el.innerText.trim().length > 200) {
                return el.innerText.trim().substring(0, 8000);
              }
            }
            return document.body.innerText.trim().substring(0, 8000);
          }`)
        ) || '';

        // 提取日期
        const urlDate = link.url.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || '';
        const bodyDate = body.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        const date = urlDate || (bodyDate ? `${bodyDate[3]}-${bodyDate[2]}-${bodyDate[1]}` : '');

        articles.push({
          title: link.title,
          url: link.url,
          date,
          source: link.source,
          body
        });

        console.log(`   ✅ 抓到 ${body.length} 字符`);

      // 每5篇截图检查一次，暂停让 LLM 判断
      if ((i + 1) % 5 === 0) {
        await this.checkPageState(
          `Phase 2 已抓取 ${i + 1}/${links.length} 篇，最后: ${link.title.substring(0, 40)}`,
          `应显示文章正文内容，不应有弹窗遮挡，body 长度 ${body.length} 字符`,
          false
        );
      }
      } catch (err) {
        console.error(`   ❌ 失败: ${err}`);
      }

      await this.delay(2000);
    }

    return articles;
  }

  // ── 弹窗处理 ─────────────────────────────────────────────────

  /**
   * 处理 fidelity.lu 的所有弹窗：
   * 1. "Confirm your client category" 弹窗 — 点击 "Institutional Investors"
   * 2. Cookie 同意弹窗 — 点击 Accept All
   * 3. 通用投资者类型弹窗（其他格式）
   */
  private async handlePopups(): Promise<void> {
      // 先截图，打印页面文字，仅记录不暂停
      await this.checkPageState('handlePopups 开始，检查弹窗状态', '页面应该有弹窗或正常内容，如果有"Confirm your client category"弹窗属于正常，等待处理', false);

      // 1. 投资者类型选择（整页或弹窗形式）
      // 按钮文字: "I am a professional client" (class: js-professional-investor)
      const r0 = await this.getMcpClient().evaluateScript(`() => {
        var candidates = Array.from(document.querySelectorAll('a,button,li,[role="button"]'));
        for (var i = 0; i < candidates.length; i++) {
          var el = candidates[i];
          var t = (el.innerText || el.textContent || '').trim();
          var cls = (el.className || '').toString();
          if (cls.includes('js-professional-investor') ||
              t === 'I am a professional client' ||
              t === 'Institutional Investors' || t === 'Professional Investors' ||
              t === 'Investment Professionals') {
            el.click();
            return 'Clicked: ' + t;
          }
        }
        return 'Not found';
      }`);
      console.log(`   投资者类型: ${r0}`);
      await this.delay(3000);

      // 2. Cookie 弹窗
      const r1 = await this.getMcpClient().evaluateScript(`() => {
        var selectors = ['#onetrust-accept-btn-handler','button[id*="accept"]','button[class*="accept"]'];
        for (var i = 0; i < selectors.length; i++) {
          var btn = document.querySelector(selectors[i]);
          if (btn && btn.offsetParent !== null) { btn.click(); return 'Clicked: ' + selectors[i]; }
        }
        var btns = document.querySelectorAll('button,a');
        for (var j = 0; j < btns.length; j++) {
          var t = (btns[j].innerText || '').toLowerCase();
          if ((t.includes('accept all') || t.includes('accept cookies')) && btns[j].offsetParent !== null) {
            btns[j].click(); return 'Clicked: ' + t;
          }
        }
        return 'Not found';
      }`);
      console.log(`   Cookie 弹窗: ${r1}`);
      await this.delay(1500);

      // 弹窗处理完成后截图确认，暂停让 LLM 判断
      await this.checkPageState('handlePopups 完成，确认弹窗已关闭', '弹窗应该已关闭，页面显示正常内容（文章列表或专题页），不应有任何遮挡弹窗');
    }


  // ── 去重 ─────────────────────────────────────────────────────

  private deduplicateLinks(links: ArticleLink[]): ArticleLink[] {
    const seen = new Set<string>();
    return links.filter(l => {
      if (seen.has(l.url)) return false;
      seen.add(l.url);
      return true;
    });
  }

  // ── 保存 ─────────────────────────────────────────────────────

  private saveLinks(links: ArticleLink[]): void {
    if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });
    const dateStr = this.formatDate(new Date());
    const file = path.join(this.outputDir, `si-links-${dateStr}.json`);
    fs.writeFileSync(file, JSON.stringify({ total: links.length, links }, null, 2), 'utf-8');
    console.log(`\n💾 链接列表保存: ${file}`);
  }

  saveResults(): void {}
  async crawlAll(): Promise<SICrawlResult[]> { return []; }
  async crawlPage(_task: any): Promise<SICrawlResult> { return { url: '', pageTitle: '', phase: 'links', crawlTime: '' }; }

  private saveArticles(articles: ArticleContent[]): void {
    const dateStr = this.formatDate(new Date());
    const file = path.join(this.outputDir, `si-articles-${dateStr}.json`);
    fs.writeFileSync(file, JSON.stringify({ total: articles.length, articles }, null, 2), 'utf-8');
    console.log(`\n💾 文章内容保存: ${file} (${articles.length} 篇)`);
  }
}

// ============================================================================
// 主函数
// ============================================================================

async function main(): Promise<void> {
  const crawler = new FidelitySICrawler();
  try {
    await crawler.run();
    console.log('\n✅ 全部完成');
  } catch (err) {
    console.error('\n❌ 执行失败:', err);
    process.exit(1);
  }
}

main();
