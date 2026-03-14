/**
 * Fidelity Insights Crawler
 * 爬取 Fidelity International 网站的研究洞察内容
 * 使用 MCP SDK 调用 Chrome DevTools MCP
 * 
 * MCP 配置: d:\temp\PI-Coding-Agent-OpenClaw-study\.trae\mcp.json
 * 
 * 安装依赖:
 *   npm install @modelcontextprotocol/sdk
 * 
 * 运行:
 *   npx ts-node fidelity-insights-crawler.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from 'fs';
import * as path from 'path';

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

interface CrawlResult {
  url: string;
  pageTitle: string;
  insights: InsightItem[];
  crawlTime: string;
}

interface PageConfig {
  url: string;
  name: string;
  insightSection: string;
  waitForTexts: string[];
}

// ============================================================================
// 配置
// ============================================================================

const TARGET_PAGES: PageConfig[] = [
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
// MCP 客户端
// ============================================================================

class MCPChromeDevToolsClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private chromePid: number | null = null;
  private browserAlreadyRunning: boolean = false;

  async connect(): Promise<void> {
    console.log('🔌 连接到 MCP Chrome DevTools...');

    // 创建 transport，连接到 chrome-devtools MCP
    // 使用 --isolated 启动独立的浏览器实例，避免与现有 Chrome 冲突
    this.transport = new StdioClientTransport({
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest", "--isolated"]
    });

    // 创建 client
    this.client = new Client(
      {
        name: "fidelity-insights-crawler",
        version: "1.0.0"
      },
      {
        capabilities: {}
      }
    );

    // 连接
    await this.client.connect(this.transport);
    
    // 检查浏览器是否已经在运行
    try {
      const listResult = await this.client.callTool({
        name: "list_pages",
        arguments: {}
      });
      const parsed = this.parseToolResult(listResult);
      
      if (parsed && parsed.pages && parsed.pages.length > 0) {
        this.browserAlreadyRunning = true;
        console.log(`✅ MCP 连接成功 (已连接到现有浏览器，${parsed.pages.length} 个页面)`);
      } else {
        console.log('✅ MCP 连接成功');
      }
    } catch {
      console.log('✅ MCP 连接成功');
    }
  }

  isBrowserAlreadyRunning(): boolean {
    return this.browserAlreadyRunning;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    console.log('🔌 MCP 连接已关闭');
  }

  getChromePid(): number | null {
    return this.chromePid;
  }

  async closeChrome(): Promise<void> {
    // 如果浏览器是之前就运行的，不关闭它
    if (this.browserAlreadyRunning) {
      console.log('⚠️ 浏览器是之前就运行的，不关闭');
      return;
    }
    
    if (this.chromePid) {
      console.log(`🔴 关闭 Chrome 进程 (PID: ${this.chromePid})...`);
      try {
        // 使用 taskkill 关闭特定 PID 的进程
        const { execSync } = require('child_process');
        execSync(`taskkill /F /PID ${this.chromePid}`, { stdio: 'ignore' });
        console.log(`✅ Chrome 进程 ${this.chromePid} 已关闭`);
      } catch (error) {
        console.log(`⚠️ 关闭 Chrome 进程失败: ${error}`);
      }
      this.chromePid = null;
    }
  }

  async navigatePage(url: string): Promise<any> {
    if (!this.client) throw new Error('MCP client not connected');

    const result = await this.client.callTool({
      name: "navigate_page",
      arguments: {
        type: "url",
        url: url
      }
    });
    
    // 解析 MCP 返回结果
    return this.parseToolResult(result);
  }

  async waitFor(texts: string[], timeout: number = 15000): Promise<any> {
    if (!this.client) throw new Error('MCP client not connected');

    const result = await this.client.callTool({
      name: "wait_for",
      arguments: {
        text: texts,
        timeout: timeout
      }
    });
    
    return this.parseToolResult(result);
  }

  async takeSnapshot(verbose: boolean = true): Promise<any> {
    if (!this.client) throw new Error('MCP client not connected');

    const result = await this.client.callTool({
      name: "take_snapshot",
      arguments: {
        verbose: verbose
      }
    });
    
    return this.parseToolResult(result);
  }

  async evaluateScript(script: string): Promise<any> {
    if (!this.client) throw new Error('MCP client not connected');

    const result = await this.client.callTool({
      name: "evaluate_script",
      arguments: {
        function: script
      }
    });
    
    return this.parseToolResult(result);
  }

  async takeScreenshot(filePath?: string): Promise<Buffer | null> {
    if (!this.client) throw new Error('MCP client not connected');

    const args: any = {};
    if (filePath) {
      args.filePath = filePath;
    }

    const result = await this.client.callTool({
      name: "take_screenshot",
      arguments: args
    });
    
    // 解析结果，返回 base64 图像数据
    if (result.content && Array.isArray(result.content)) {
      const imageContent = result.content.find((c: any) => c.type === 'image');
      if (imageContent && imageContent.data) {
        return Buffer.from(imageContent.data, 'base64');
      }
    }
    return null;
  }

  /**
   * 解析 MCP tool 返回结果
   * MCP 返回的是 CallToolResult，内容在 content 数组中
   */
  private parseToolResult(result: any): any {
    if (!result) return null;
    
    // MCP 返回格式: { content: [{ type: 'text', text: '...' }] }
    if (result.content && Array.isArray(result.content)) {
      const textContent = result.content.find((c: any) => c.type === 'text');
      if (textContent && textContent.text) {
        const text = textContent.text;
        
        // 检测错误消息
        if (text.includes('The browser is already running')) {
          return { error: 'browser_already_running', message: text };
        }
        
        // 处理 markdown 代码块中的 JSON
        const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          try {
            return JSON.parse(jsonMatch[1]);
          } catch {
            // 继续尝试其他方式
          }
        }
        
        try {
          // 尝试解析 JSON
          const parsed = JSON.parse(text);
          return parsed;
        } catch {
          // 如果不是 JSON，返回原始文本
          return text;
        }
      }
    }
    
    return result;
  }
  
  /**
   * 检查结果是否是错误
   */
  isErrorResponse(result: any): boolean {
    return result && result.error === 'browser_already_running';
  }
}

// ============================================================================
// 爬虫类
// ============================================================================

interface ScreenshotComparison {
  preActionPath: string;
  postActionPath: string;
  changed: boolean;
  analysis?: string;
}

class FidelityInsightsCrawler {
  private results: CrawlResult[] = [];
  private mcpClient: MCPChromeDevToolsClient;
  private screenshotDir: string;

  constructor() {
    this.mcpClient = new MCPChromeDevToolsClient();
    
    // 确保输出目录存在
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    this.screenshotDir = path.join(OUTPUT_DIR, 'screenshots');
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }
  }

  getMcpClient(): MCPChromeDevToolsClient {
    return this.mcpClient;
  }

  /**
   * 截图比较功能
   * 在操作前后截图，比较是否有变化
   */
  async compareScreenshots(
    actionName: string,
    action: () => Promise<any>,
    pageName: string
  ): Promise<ScreenshotComparison> {
    const timestamp = Date.now();
    const safeName = actionName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const prePath = path.join(this.screenshotDir, `${pageName}-${safeName}-pre-${timestamp}.png`);
    const postPath = path.join(this.screenshotDir, `${pageName}-${safeName}-post-${timestamp}.png`);

    // 操作前截图
    const preScreenshot = await this.mcpClient.takeScreenshot();
    if (preScreenshot) {
      fs.writeFileSync(prePath, preScreenshot);
      console.log(`     📸 操作前截图: ${prePath}`);
    }

    // 执行操作
    const actionResult = await action();

    // 等待一下让页面稳定
    await this.delay(1000);

    // 操作后截图
    const postScreenshot = await this.mcpClient.takeScreenshot();
    if (postScreenshot) {
      fs.writeFileSync(postPath, postScreenshot);
      console.log(`     📸 操作后截图: ${postPath}`);
    }

    // 比较截图
    const changed = this.compareImages(preScreenshot, postScreenshot);
    
    const result: ScreenshotComparison = {
      preActionPath: prePath,
      postActionPath: postPath,
      changed
    };

    if (!changed && preScreenshot && postScreenshot) {
      console.log(`     ⚠️ 页面没有变化，保存截图用于分析`);
      result.analysis = `截图已保存，页面在 "${actionName}" 操作后没有变化，可能需要人工检查。`;
    } else if (changed) {
      console.log(`     ✅ 页面已变化`);
      // 如果有变化，可以删除前置截图，只保留后置
      if (fs.existsSync(prePath)) {
        fs.unlinkSync(prePath);
      }
    }

    return result;
  }

  /**
   * 比较两个图像是否相同
   */
  private compareImages(img1: Buffer | null, img2: Buffer | null): boolean {
    if (!img1 || !img2) return false;
    if (img1.length !== img2.length) return true; // 大小不同，肯定有变化
    
    // 简单的字节比较
    for (let i = 0; i < img1.length; i++) {
      if (img1[i] !== img2[i]) return true;
    }
    
    return false; // 完全相同
  }

  /**
   * 爬取所有目标页面
   */
  async crawlAll(): Promise<CrawlResult[]> {
    console.log('🚀 Fidelity Insights Crawler 启动');
    console.log(`📋 目标页面数: ${TARGET_PAGES.length}`);
    console.log('=' .repeat(60));

    // 连接 MCP
    await this.mcpClient.connect();

    try {
      for (const page of TARGET_PAGES) {
        const result = await this.crawlPage(page);
        this.results.push(result);

        // 延迟避免请求过快
        await this.delay(2000);
      }
    } finally {
      // 确保断开连接
      await this.mcpClient.disconnect();
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ 爬取完成!');
    const totalInsights = this.results.reduce((sum, r) => sum + r.insights.length, 0);
    console.log(`📊 总页面数: ${this.results.length}`);
    console.log(`📊 总洞察数: ${totalInsights}`);

    this.saveResults();
    return this.results;
  }

  /**
   * 爬取单个页面
   */
  async crawlPage(page: PageConfig): Promise<CrawlResult> {
    console.log(`\n🔄 正在爬取: ${page.name}`);
    console.log(`🔗 URL: ${page.url}`);
    console.log(`🎯 洞察区域: ${page.insightSection}`);
    console.log('-'.repeat(60));

    try {
      // 步骤 1: 导航到页面
      console.log('  → 步骤 1: 导航到页面...');
      await this.mcpClient.navigatePage(page.url);

      // 额外等待，确保动态内容加载完成
      console.log('  → 步骤 1b: 额外等待 6 秒...');
      await this.delay(6000);

      // 步骤 1b: 处理 cookie 弹窗
      console.log('  → 步骤 1c: 检查并处理 cookie 弹窗...');
      await this.handleCookieConsent(page.name);

      // 步骤 2: 等待页面加载
      console.log('  → 步骤 2: 等待页面加载...');
      await this.mcpClient.waitFor(page.waitForTexts, 36000);
      
      // 额外等待，确保动态内容加载完成
      console.log('  → 步骤 2b: 额外等待 8 秒...');
      await this.delay(8000);

      // 步骤 3: 获取页面标题
      console.log('  → 步骤 3: 获取页面标题...');
      const titleResult = await this.mcpClient.evaluateScript('() => document.title');
      const pageTitle = titleResult || page.name;
      console.log(`     标题: ${pageTitle}`);

      // 步骤 4: 使用 JavaScript 直接提取洞察内容
      console.log('  → 步骤 4: 提取洞察内容...');
      const insights = await this.extractInsightsFromPage(page.url);
      console.log(`     找到 ${insights.length} 条洞察`);

      // 打印前3条洞察的标题
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

  /**
   * 从 MCP 快照中提取洞察内容
   */
  private extractInsightsFromSnapshot(
    snapshot: any,
    sourceUrl: string,
    insightSection: string
  ): InsightItem[] {
    const insights: InsightItem[] = [];

    if (!snapshot || !snapshot.children) {
      console.log('     警告: 快照数据为空');
      return insights;
    }

    // 递归查找包含洞察区域的节点
    const findInsightSection = (node: any): any | null => {
      if (!node) return null;

      // 检查当前节点是否包含洞察区域标题
      if (node.name && (
        node.name.includes(insightSection) ||
        node.name.includes('Latest insights') ||
        node.name.includes('Our latest')
      )) {
        return node;
      }

      // 递归检查子节点
      if (node.children && Array.isArray(node.children)) {
        for (const child of node.children) {
          const found = findInsightSection(child);
          if (found) return found;
        }
      }

      return null;
    };

    // 查找洞察区域
    const insightNode = findInsightSection(snapshot);

    if (!insightNode) {
      console.log(`     警告: 未找到洞察区域 "${insightSection}"`);
      return insights;
    }

    // 从洞察区域提取文章
    this.extractArticlesFromNode(insightNode, insights, sourceUrl);

    return insights;
  }

  /**
   * 使用 JavaScript 直接从页面提取洞察内容
   */
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
      const result = await this.mcpClient.evaluateScript(extractScript);
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

  /**
   * 从节点中提取文章
   */
  private extractArticlesFromNode(node: any, insights: InsightItem[], sourceUrl: string): void {
    if (!node) return;

    // 查找链接节点（文章）
    if (node.role === 'link' && node.name && node.url) {
      // 检查是否是文章链接（排除导航链接）
      if (this.isArticleLink(node.url)) {
        const insight: InsightItem = {
          title: node.name,
          url: this.normalizeUrl(node.url, sourceUrl),
          type: this.detectContentType(node),
          sourcePage: sourceUrl
        };
        insights.push(insight);
      }
    }

    // 递归处理子节点
    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        this.extractArticlesFromNode(child, insights, sourceUrl);
      }
    }
  }

  /**
   * 判断是否是文章链接
   */
  private isArticleLink(url: string): boolean {
    // 排除导航链接和外部链接
    const excludePatterns = [
      'javascript:',
      '#',
      '/solutions/',
      '/funds/',
      '/about-fidelity/',
      '/perspectives/',
      '/search/',
      'linkedin.com',
      'youtube.com'
    ];

    return !excludePatterns.some(pattern => url.includes(pattern));
  }

  /**
   * 规范化 URL
   */
  private normalizeUrl(url: string, baseUrl: string): string {
    if (url.startsWith('http')) {
      return url;
    }
    if (url.startsWith('/')) {
      return 'https://professionals.fidelity.co.uk' + url;
    }
    return url;
  }

  /**
   * 检测内容类型
   */
  private detectContentType(node: any): string {
    const text = JSON.stringify(node).toLowerCase();
    
    if (text.includes('webcast') || text.includes('webinar')) {
      return 'Webcast';
    }
    if (text.includes('video')) {
      return 'Video';
    }
    if (text.includes('podcast')) {
      return 'Podcast';
    }
    if (text.includes('report') || text.includes('whitepaper')) {
      return 'Report';
    }
    
    return 'Article';
  }

  /**
   * 保存结果
   */
  private saveResults(): void {
    const output = {
      crawlTime: new Date().toISOString(),
      totalPages: this.results.length,
      totalInsights: this.results.reduce((sum, r) => sum + r.insights.length, 0),
      results: this.results
    };

    // 保存为 JSON
    const jsonFile = path.join(OUTPUT_DIR, `fidelity-insights-${this.formatDate(new Date())}.json`);
    fs.writeFileSync(jsonFile, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\n💾 汇总 JSON: ${jsonFile}`);

    // 保存为 Markdown
    const mdFile = path.join(OUTPUT_DIR, `fidelity-insights-report-${this.formatDate(new Date())}.md`);
    this.saveMarkdownReport(mdFile, output);
    console.log(`💾 Markdown 报告: ${mdFile}`);

    // 保存每个页面的单独结果
    this.results.forEach(result => {
      const safeName = result.pageTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const pageFile = path.join(OUTPUT_DIR, `fidelity-${safeName}-${this.formatDate(new Date())}.json`);
      fs.writeFileSync(pageFile, JSON.stringify(result, null, 2), 'utf-8');
    });
  }

  /**
   * 保存 Markdown 报告
   */
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

  /**
   * 格式化日期
   */
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0].replace(/-/g, '');
  }

  /**
   * 处理 cookie 弹窗和用户类型选择
   */
  private async handleCookieConsent(pageName: string = 'unknown'): Promise<void> {
    // 先处理用户类型选择弹窗（使用截图比较）
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
        const result = await this.mcpClient.evaluateScript(selectInvestorTypeScript);
        console.log(`     投资者类型选择: ${result}`);
        await this.delay(2000);
        return result;
      },
      pageName
    );

    if (!comparison.changed) {
      console.log(`     ⚠️ 投资者类型选择可能失败，截图已保存`);
    }

    // 处理 cookie 弹窗（使用截图比较）
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
        const result = await this.mcpClient.evaluateScript(handleCookiesScript);
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

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
  await globalCrawler.crawlAll();

  // 正确关闭浏览器
  await globalCrawler.getMcpClient().disconnect();
  await globalCrawler.getMcpClient().closeChrome();

  console.log('\n' + '='.repeat(80));
  console.log('✅ 所有页面爬取完成!');
  console.log(`📁 结果保存在: ${OUTPUT_DIR}/`);
  console.log('='.repeat(80));
}

// 运行爬虫
main().catch(error => {
  console.error('❌ 爬虫执行失败:', error);
  process.exit(1);
});

// 导出关闭函数，用于外部调用关闭特定 Chrome 进程
export function getChromePid(): number | null {
  return globalCrawler?.getMcpClient()?.getChromePid() || null;
}

export { FidelityInsightsCrawler, MCPChromeDevToolsClient };
export type { InsightItem, CrawlResult, PageConfig };
