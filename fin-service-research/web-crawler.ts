/**
 * Web Crawler Base Module
 * 提供 MCP Chrome DevTools 客户端和基础爬虫功能
 * 使用外部 LLM（Anthropic Claude）进行页面分析，不依赖 Chrome 内置 AI
 *
 * 安装依赖:
 *   npm install @modelcontextprotocol/sdk sharp ssim.js
 *
 * 环境变量:
 *   ANTHROPIC_API_KEY  - Anthropic Claude API Key（用于截图分析和挂起恢复）
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from 'fs';
import * as path from 'path';
import sharp from "sharp";
import { ssim } from "ssim.js";

// ============================================================================
// 类型定义
// ============================================================================

export interface CrawlResult {
  url: string;
  pageTitle: string;
  crawlTime: string;
}

export interface PageConfig {
  url: string;
  name: string;
  waitForTexts: string[];
}

export interface ScreenshotComparison {
  preActionPath: string;
  postActionPath: string;
  changed: boolean;
  similarity: number;
  analysis?: string;
}

export type LanguageModelAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

export interface LanguageModelParams {
  defaultTopK: number;
  maxTopK: number;
  defaultTemperature: number;
  maxTemperature: number;
}

export interface ChromeAIStatus {
  available: boolean;
  availability: LanguageModelAvailability;
  params?: LanguageModelParams;
  error?: string;
}

export interface MCPConfig {
  command?: string;
  args?: string[];
  chromeUrl?: string;
}

/**
 * executePage 各阶段 hook 回调接口
 * 每个 hook 都是可选的，未提供时使用默认实现
 */
export interface ExecutePageHooks {
  /** 阶段1: navigate 完成后，拿到页面文字和截图路径 */
  afterNavigate?: (pageText: string, screenshotPath: string) => Promise<void>;
  /** 阶段2: cookie banner 处理，返回 true 表示已点击处理 */
  handleCookie?: (pageText: string) => Promise<boolean>;
  /** 阶段3: 弹窗/投资者类型处理，返回 true 表示已点击处理 */
  handlePopup?: (pageText: string) => Promise<boolean>;
  /** 阶段4: 判断页面是否就绪可提取，返回 true 表示就绪 */
  isPageReady?: (pageText: string, screenshotPath: string) => Promise<boolean>;
  /** 阶段5: 自定义内容提取，返回提取到的文本 */
  extractContent?: () => Promise<string>;
  /** 阶段6: 拿到内容后保存 */
  onSave?: (content: string, pageTitle: string, url: string) => Promise<void>;
  /** 重试耗尽时调用，返回 true 表示用户已介入可继续，false 抛出错误 */
  onRetryExhausted?: (reason: string, screenshotPath: string) => Promise<boolean>;
  /** 最大就绪检查重试次数，默认 3 */
  maxRetries?: number;
  /** 每步等待毫秒数，默认 3000 */
  stepDelay?: number;
}

// ============================================================================
// MCP Chrome DevTools 客户端
// ============================================================================

export class MCPChromeDevToolsClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private browserAlreadyRunning: boolean = false;
  private config: MCPConfig = {};

  async connect(clientName: string = 'web-crawler', useExistingChrome: boolean = true): Promise<void> {
    console.log('🔌 连接到 MCP Chrome DevTools...');

    // 始终用 --isolated，避免与已有 Chrome profile 冲突
    // useExistingChrome 保留参数签名兼容性，但不再影响行为
    this.transport = new StdioClientTransport({
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest", "--isolated"]
    });

    this.client = new Client(
      { name: clientName, version: "1.0.0" },
      { capabilities: {} }
    );

    await this.client.connect(this.transport);

    try {
      const listResult = await this.client.callTool({
        name: "list_pages",
        arguments: {}
      });
      const parsed = this.parseToolResult(listResult);
      if (parsed && parsed.pages && parsed.pages.length > 0) {
        this.browserAlreadyRunning = true;
        console.log(`✅ MCP 连接成功 (${parsed.pages.length} 个页面)`);
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

  async navigatePage(url: string): Promise<any> {
    if (!this.client) throw new Error('MCP client not connected');

    const result = await this.client.callTool({
      name: "navigate_page",
      arguments: { type: "url", url }
    });

    const parsed = this.parseToolResult(result);
    if (this.isErrorResponse(parsed)) throw new Error(`navigatePage failed: ${parsed.message}`);
    return parsed;
  }

  async waitFor(texts: string[], timeout: number = 15000): Promise<any> {
    if (!this.client) throw new Error('MCP client not connected');

    const result = await this.client.callTool({
      name: "wait_for",
      arguments: { text: texts, timeout }
    });

    return this.parseToolResult(result);
  }

  async takeSnapshot(verbose: boolean = true): Promise<any> {
    if (!this.client) throw new Error('MCP client not connected');

    const result = await this.client.callTool({
      name: "take_snapshot",
      arguments: { verbose }
    });

    return this.parseToolResult(result);
  }

  async evaluateScript(script: string): Promise<any> {
    if (!this.client) throw new Error('MCP client not connected');

    const result = await this.client.callTool({
      name: "evaluate_script",
      arguments: { function: script }
    });

    const parsed = this.parseToolResult(result);
    if (this.isErrorResponse(parsed)) throw new Error(`evaluateScript failed: ${parsed.message}`);
    return parsed;
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
    
    if (result.content && Array.isArray(result.content)) {
      const imageContent = result.content.find((c: any) => c.type === 'image');
      if (imageContent && imageContent.data) {
        return Buffer.from(imageContent.data, 'base64');
      }
    }
    return null;
  }

  async click(uid: string): Promise<any> {
    if (!this.client) throw new Error('MCP client not connected');

    const result = await this.client.callTool({
      name: "click",
      arguments: { uid }
    });
    
    return this.parseToolResult(result);
  }

  async fill(uid: string, value: string): Promise<any> {
    if (!this.client) throw new Error('MCP client not connected');

    const result = await this.client.callTool({
      name: "fill",
      arguments: { uid, value }
    });
    
    return this.parseToolResult(result);
  }

  private parseToolResult(result: any): any {
    if (!result) return null;
    
    if (result.content && Array.isArray(result.content)) {
      const textContent = result.content.find((c: any) => c.type === 'text');
      if (textContent && textContent.text) {
        const text = textContent.text;
        
        if (text.includes('The browser is already running')) {
          return { error: 'browser_already_running', message: text };
        }
        
        const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          try {
            return JSON.parse(jsonMatch[1]);
          } catch {}
        }
        
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
    }
    
    return result;
  }
  
  isErrorResponse(result: any): boolean {
    return result && result.error === 'browser_already_running';
  }
}

// ============================================================================
// 图像比较工具
// ============================================================================

export class ImageComparator {
  static async compareWithSSIM(img1: Buffer, img2: Buffer): Promise<number> {
    interface GrayImage {
      data: Uint8ClampedArray;
      width: number;
      height: number;
    }

    const loadGray = async (buffer: Buffer): Promise<GrayImage> => {
      const { data, info } = await sharp(buffer)
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      
      return {
        data: new Uint8ClampedArray(data),
        width: info.width,
        height: info.height
      };
    };

    const gray1 = await loadGray(img1);
    const gray2 = await loadGray(img2);

    try {
      const result = ssim(gray1 as any, gray2 as any);
      return result.mssim;
    } catch {
      return 0;
    }
  }

  static async compareBuffers(img1: Buffer | null, img2: Buffer | null): Promise<{ changed: boolean; similarity: number }> {
    if (!img1 || !img2) return { changed: false, similarity: 0 };
    if (img1.length !== img2.length) return { changed: true, similarity: 0 };
    
    try {
      const similarity = await this.compareWithSSIM(img1, img2);
      return { changed: similarity < 0.98, similarity };
    } catch (error) {
      for (let i = 0; i < img1.length; i++) {
        if (img1[i] !== img2[i]) return { changed: true, similarity: 0 };
      }
      return { changed: false, similarity: 1 };
    }
  }
}

// ============================================================================
// Chrome 内置 AI 客户端 (Prompt API)
// ============================================================================

export class ChromeAIClient {
  private mcpClient: MCPChromeDevToolsClient;
  private sessionCreated: boolean = false;

  constructor(mcpClient: MCPChromeDevToolsClient) {
    this.mcpClient = mcpClient;
  }

  /**
   * Chrome 内置 AI 已禁用。
   * 脚本由 LLM 驱动执行，截图/错误信息直接输出给 LLM 判断，无需内置 AI。
   */
  async checkAvailability(): Promise<ChromeAIStatus> {
    return { available: false, availability: 'unavailable', error: 'Chrome built-in AI disabled. Script is driven by external LLM.' };
  }

  async prompt(_message: string, _options?: any): Promise<string> {
    throw new Error('[ChromeAI disabled] Use screenshot + external LLM to analyze page state.');
  }

  async promptStreaming(_message: string, _onChunk: (chunk: string) => void, _options?: any): Promise<string> {
    throw new Error('[ChromeAI disabled] Use screenshot + external LLM to analyze page state.');
  }

  async analyzeScreenshotChange(_pre: string, _post: string, _expected: string): Promise<string> {
    return '[ChromeAI disabled] Screenshot saved to disk. LLM should inspect the file and decide next action.';
  }

  async summarizeContent(_content: string, _maxLength?: number): Promise<string> {
    return '[ChromeAI disabled] Pass content directly to external LLM for summarization.';
  }

  async classifyContent(_content: string, _categories: string[]): Promise<string> {
    return '[ChromeAI disabled] Pass content directly to external LLM for classification.';
  }
}

// ============================================================================
// 基础爬虫类
// ============================================================================

export abstract class BaseWebCrawler<T extends CrawlResult, P extends PageConfig> {
  protected results: T[] = [];
  protected mcpClient: MCPChromeDevToolsClient;
  protected aiClient: ChromeAIClient;
  protected outputDir: string;
  protected screenshotDir: string;

  protected lastScreenshot: Buffer | null = null;

  constructor(outputDir: string = './crawl-results') {
    this.mcpClient = new MCPChromeDevToolsClient();
    this.aiClient = new ChromeAIClient(this.mcpClient);
    this.outputDir = outputDir;
    
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    this.screenshotDir = path.join(outputDir, 'screenshots');
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }
  }

  getMcpClient(): MCPChromeDevToolsClient {
    return this.mcpClient;
  }

  getAiClient(): ChromeAIClient {
    return this.aiClient;
  }

  protected delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 带超时的操作 wrapper。
   * 超过 timeoutMs（默认60秒）未完成，自动截图保存到磁盘，
   * 然后抛出错误（含截图路径），由驱动 LLM 查看截图决定下一步。
   */
  protected async withTimeout<T>(
    label: string,
    fn: () => Promise<T>,
    timeoutMs: number = 60000
  ): Promise<T> {
    const ts = Date.now();
    const screenshotPath = path.join(
      this.screenshotDir,
      `timeout-${label.replace(/[^a-z0-9]+/gi, '-')}-${ts}.png`
    );

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(async () => {
        try {
          const buf = await this.mcpClient.takeScreenshot();
          if (buf) fs.writeFileSync(screenshotPath, buf);
        } catch {}
        reject(new Error(
          `[TIMEOUT] "${label}" 超过 ${timeoutMs/1000}s 未完成。` +
          `截图已保存: ${screenshotPath} — LLM 请查看截图判断页面状态并决定下一步`
        ));
      }, timeoutMs)
    );

    return Promise.race([fn(), timeoutPromise]);
  }

  protected formatDate(date: Date): string {
    return date.toISOString().split('T')[0].replace(/-/g, '');
  }

  async compareScreenshots(
    actionName: string,
    action: () => Promise<any>,
    pageName: string,
    expectedChange?: string
  ): Promise<ScreenshotComparison> {
    const timestamp = Date.now();
    const safeName = actionName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const prePath = path.join(this.screenshotDir, `${pageName}-${safeName}-pre-${timestamp}.png`);
    const postPath = path.join(this.screenshotDir, `${pageName}-${safeName}-post-${timestamp}.png`);

    const preScreenshot = await this.mcpClient.takeScreenshot();
    if (preScreenshot) {
      fs.writeFileSync(prePath, preScreenshot);
      console.log(`     📸 操作前截图: ${prePath}`);
    }

    const actionResult = await action();

    await this.delay(1000);

    const postScreenshot = await this.mcpClient.takeScreenshot();
    if (postScreenshot) {
      fs.writeFileSync(postPath, postScreenshot);
      console.log(`     📸 操作后截图: ${postPath}`);
    }

    const { changed, similarity } = await ImageComparator.compareBuffers(preScreenshot, postScreenshot);
    console.log(`     📊 相似度: ${(similarity * 100).toFixed(2)}%`);
    
    const result: ScreenshotComparison = {
      preActionPath: prePath,
      postActionPath: postPath,
      changed,
      similarity
    };

    if (!changed && preScreenshot && postScreenshot) {
      console.log(`     ⚠️ 页面没有变化，保存截图用于分析`);
      
      // 尝试使用 AI 分析原因
      if (expectedChange) {
        try {
          const aiAnalysis = await this.aiClient.analyzeScreenshotChange(
            `Screenshot saved at ${prePath}`,
            `Screenshot saved at ${postPath}`,
            expectedChange
          );
          result.analysis = aiAnalysis;
          console.log(`     🤖 AI 分析: ${aiAnalysis.substring(0, 200)}...`);
        } catch (error) {
          result.analysis = `截图已保存，页面在 "${actionName}" 操作后没有变化，可能需要人工检查。`;
          console.log(`     ⚠️ AI 分析不可用: ${error}`);
        }
      } else {
        result.analysis = `截图已保存，页面在 "${actionName}" 操作后没有变化，可能需要人工检查。`;
      }
    } else if (changed) {
      console.log(`     ✅ 页面已变化`);
      if (fs.existsSync(prePath)) {
        fs.unlinkSync(prePath);
      }
    }

    return result;
  }

  /**
   * 检查 Chrome 内置 AI 是否可用
   */
  async checkAIAvailability(): Promise<ChromeAIStatus> {
    return this.aiClient.checkAvailability();
  }

  /**
   * 使用 AI 提取内容摘要
   */
  async summarizeWithAI(content: string): Promise<string> {
    return this.aiClient.summarizeContent(content);
  }

  /**
   * 截图检查页面状态。
   * 流程：
   *   1. 截图，与上次截图用 SSIM 比较是否有变化
   *   2. 抓页面文字摘要
   *   3. 打印固定 prompt 供 LLM 回答：
   *      - 当前页面是否 404 / Not Found？
   *      - 当前页面是否有弹出窗口？
   *      - 如果 SSIM 显示无变化，额外问：没有变化是否正常？
   *   4. throwOnAbnormal=true 时抛出异常暂停，等 LLM 决定下一步
   */
  async checkPageState(description: string, expectedState?: string, throwOnAbnormal: boolean = false): Promise<{ pageText: string; screenshotPath: string }> {
    const ts = Date.now();
    const label = description.replace(/[^a-z0-9]+/gi, '-').substring(0, 40);
    const screenshotPath = path.join(this.screenshotDir, `check-${label}-${ts}.png`);

    // 截图
    let currentScreenshot: Buffer | null = null;
    try {
      currentScreenshot = await this.mcpClient.takeScreenshot();
      if (currentScreenshot) fs.writeFileSync(screenshotPath, currentScreenshot);
    } catch {}

    // SSIM 比较与上次截图
    let ssimResult: { changed: boolean; similarity: number } = { changed: true, similarity: 1 };
    if (this.lastScreenshot && currentScreenshot) {
      ssimResult = await ImageComparator.compareBuffers(this.lastScreenshot, currentScreenshot);
    }
    const noChange = !ssimResult.changed;

    // 更新上次截图
    if (currentScreenshot) this.lastScreenshot = currentScreenshot;

    // 抓页面文字摘要（前600字）
    let pageText = '';
    try {
      pageText = await this.mcpClient.evaluateScript('() => document.body.innerText.substring(0, 600)') || '';
    } catch {}

    // 构建固定 prompt
    const ssimInfo = this.lastScreenshot && currentScreenshot
      ? `SSIM相似度: ${(ssimResult.similarity * 100).toFixed(1)}% — 页面${noChange ? '【无变化】' : '【有变化】'}`
      : 'SSIM: 无上次截图可比较';

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📸 [PAGE CHECK] ${description}`);
    console.log(`   截图路径: ${screenshotPath}`);
    if (expectedState) console.log(`   期望状态: ${expectedState}`);
    console.log(`   ${ssimInfo}`);
    console.log(`   页面文字摘要:\n${pageText}`);
    console.log(`\n--- LLM 请回答以下问题 ---`);
    console.log(`Q1: 当前页面是否是 404 / Not Found / 无搜索结果 页面？`);
    console.log(`Q2: 当前页面是否有弹出窗口（popup/modal/overlay）遮挡内容？`);
    console.log(`Q3: 当前页面需要用户做什么动作才能继续（例如：点击某个按钮、选择投资者类型、填写表单等）？`);
    if (noChange) {
      console.log(`Q4: [SSIM 显示页面无变化] 在"${description}"操作后页面没有变化，这是正常的吗？如果不正常，可能的原因是什么？`);
    }
    console.log(`${'='.repeat(60)}\n`);

    if (throwOnAbnormal) {
      throw new Error(
        `[PAGE CHECK PAUSE] "${description}" — ` +
        `截图: ${screenshotPath} | ${ssimInfo} | ` +
        `LLM 请回答: Q1=是否404? Q2=是否有弹窗? Q3=需要做什么动作? ${noChange ? 'Q4=无变化是否正常?' : ''} ` +
        `然后决定下一步操作`
      );
    }

    return { pageText, screenshotPath };
  }

  abstract crawlAll(): Promise<T[]>;
  abstract crawlPage(page: P): Promise<T>;
  abstract saveResults(): void;

  // ============================================================================
  // executePage — 核心通用抓取流程，各阶段可通过 hooks 定制
  // ============================================================================

  /**
   * 执行单页抓取的标准流程：
   *   1. navigate → 截图判断
   *   2. 处理 cookie banner
   *   3. 处理弹窗（投资者类型等）
   *   4. 检查页面是否就绪（最多 maxRetries 次）
   *   5. 提取内容
   *   6. 保存
   *
   * 每个阶段都有默认实现，通过 hooks 传入回调可覆盖。
   */
  async executePage(url: string, hooks: ExecutePageHooks = {}): Promise<string> {
    const {
      afterNavigate,
      handleCookie,
      handlePopup,
      isPageReady,
      extractContent,
      onSave,
      onRetryExhausted,
      maxRetries = 3,
      stepDelay = 3000,
    } = hooks;

    // ── 阶段1: Navigate ──────────────────────────────────────────
    console.log(`\n🔗 [executePage] 导航到: ${url}`);
    await this.mcpClient.navigatePage(url);
    await this.delay(stepDelay);

    const { pageText: textAfterNav, screenshotPath: ssAfterNav } =
      await this.checkPageState('阶段1-navigate完成', `刚导航到 ${url}，判断页面初始状态`);
    if (afterNavigate) await afterNavigate(textAfterNav, ssAfterNav);

    // ── 阶段2: 弹窗（先处理，避免 cookie 点击后弹窗才出现）────
    console.log('\n🪟 [阶段2] 处理弹窗...');
    const popupHandled = handlePopup
      ? await handlePopup(textAfterNav)
      : await this._defaultHandlePopup();
    if (popupHandled) {
      await this.delay(stepDelay);
      await this.checkPageState('阶段2-弹窗处理后', '弹窗应已关闭，页面应显示正常内容');
    }

    // ── 阶段3: Cookie ────────────────────────────────────────────
    console.log('\n🍪 [阶段3] 处理 cookie banner...');
    const cookieHandled = handleCookie
      ? await handleCookie(textAfterNav)
      : await this._defaultHandleCookie();
    if (cookieHandled) {
      await this.delay(stepDelay);
      await this.checkPageState('阶段3-cookie处理后', 'cookie banner 应已关闭，页面正常显示');
    }

    // ── 阶段4: 页面就绪检查（最多 maxRetries 次）────────────────
    console.log('\n✅ [阶段4] 检查页面是否就绪...');
    let ready = false;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const { pageText, screenshotPath } = await this.checkPageState(
        `阶段4-就绪检查第${attempt}次`,
        '页面应无弹窗遮挡，有实际内容可提取，无404'
      );
      ready = isPageReady
        ? await isPageReady(pageText, screenshotPath)
        : await this._defaultIsPageReady(pageText);

      if (ready) break;

      console.log(`   ⚠️ 第 ${attempt}/${maxRetries} 次检查未就绪`);
      if (attempt === maxRetries) {
        const shouldContinue = onRetryExhausted
          ? await onRetryExhausted(`页面经过 ${maxRetries} 次检查仍未就绪`, screenshotPath)
          : false;
        if (!shouldContinue) {
          throw new Error(
            `[executePage] 页面未就绪，已重试 ${maxRetries} 次。截图: ${screenshotPath}\n` +
            `请查看截图，判断需要做什么操作，然后重新运行或手动介入。`
          );
        }
      }
      await this.delay(stepDelay);
    }

    // ── 阶段5: 提取内容 ──────────────────────────────────────────
    console.log('\n📄 [阶段5] 提取内容...');
    const content = extractContent
      ? await extractContent()
      : await this._defaultExtractContent();

    const pageTitle: string = await this.mcpClient.evaluateScript(
      `() => document.title || document.querySelector('h1')?.innerText || ''`
    ) || '';

    console.log(`   标题: ${pageTitle}`);
    console.log(`   内容长度: ${content.length} 字符`);
    await this.checkPageState('阶段5-提取完成', `内容已提取 ${content.length} 字符，标题: ${pageTitle}`);

    // ── 阶段6: 保存 ──────────────────────────────────────────────
    if (onSave) {
      await onSave(content, pageTitle, url);
    }

    return content;
  }

  // ── 内部工具方法 ─────────────────────────────────────────────

  /** 截图 + 抓页面文字，返回路径和文字 */
  private async _snapshot(label: string): Promise<{ pageText: string; screenshotPath: string }> {
    const ts = Date.now();
    const safe = label.replace(/[^a-z0-9]+/gi, '-').substring(0, 40);
    const screenshotPath = path.join(this.screenshotDir, `exec-${safe}-${ts}.png`);

    let currentScreenshot: Buffer | null = null;
    try {
      currentScreenshot = await this.mcpClient.takeScreenshot();
      if (currentScreenshot) fs.writeFileSync(screenshotPath, currentScreenshot);
    } catch {}

    // SSIM 与上次比较
    if (this.lastScreenshot && currentScreenshot) {
      const { changed, similarity } = await ImageComparator.compareBuffers(this.lastScreenshot, currentScreenshot);
      console.log(`   📸 [${label}] SSIM: ${(similarity * 100).toFixed(1)}% — ${changed ? '有变化' : '无变化'} → ${screenshotPath}`);
    } else {
      console.log(`   📸 [${label}] → ${screenshotPath}`);
    }
    if (currentScreenshot) this.lastScreenshot = currentScreenshot;

    let pageText = '';
    try {
      pageText = await this.mcpClient.evaluateScript('() => document.body.innerText.substring(0, 800)') || '';
    } catch {}

    return { pageText, screenshotPath };
  }

  /** 默认 cookie 处理：优先 reject，其次 accept */
  protected async _defaultHandleCookie(): Promise<boolean> {
    const result = await this.mcpClient.evaluateScript(`() => {
      var selectors = [
        '#onetrust-reject-all-handler',
        'button[id*="reject-all"]',
        '#onetrust-accept-btn-handler',
        'button[id*="accept-all"]',
        'button[class*="accept-all"]'
      ];
      for (var i = 0; i < selectors.length; i++) {
        var btn = document.querySelector(selectors[i]);
        if (btn && btn.offsetParent !== null) { btn.click(); return 'clicked:' + selectors[i]; }
      }
      var btns = Array.from(document.querySelectorAll('button,a'));
      for (var j = 0; j < btns.length; j++) {
        var t = (btns[j].innerText || '').toLowerCase().trim();
        if ((t === 'accept all' || t === 'reject all' || t === 'accept cookies') && btns[j].offsetParent !== null) {
          btns[j].click(); return 'clicked:' + t;
        }
      }
      return 'not-found';
    }`);
    const found = result !== 'not-found';
    console.log(`   Cookie: ${result}`);
    return found;
  }

  /** 默认弹窗处理：投资者类型选择，宽泛匹配 */
  protected async _defaultHandlePopup(): Promise<boolean> {
    const result = await this.mcpClient.evaluateScript(`() => {
      var candidates = Array.from(document.querySelectorAll('a,button,li,[role="button"],div[class*="investor"],div[class*="professional"]'));
      var keywords = [
        'investment professional', 'professional investor', 'institutional investor',
        'i am a professional', 'professional client', 'identify as an investment professional',
        'investment professionals', 'institutional investors', 'financial intermediar'
      ];
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        var t = (el.innerText || el.textContent || '').trim().toLowerCase();
        var cls = (el.className || '').toString();
        if (cls.includes('js-professional-investor')) { el.click(); return 'clicked:js-professional-investor'; }
        for (var k = 0; k < keywords.length; k++) {
          if (t.includes(keywords[k])) { el.click(); return 'clicked:' + t.substring(0, 60); }
        }
      }
      return 'not-found';
    }`);
    const found = result !== 'not-found';
    console.log(`   弹窗: ${result}`);
    return found;
  }

  /** 默认页面就绪判断：没有明显弹窗且有足够文字内容 */
  private async _defaultIsPageReady(pageText: string): Promise<boolean> {
    const lower = pageText.toLowerCase();
    const hasBlocker =
      lower.includes('404') ||
      lower.includes('not found') ||
      lower.includes('confirm your') ||
      lower.includes('select your') ||
      lower.includes('choose your');
    const hasContent = pageText.length > 300;
    return !hasBlocker && hasContent;
  }

  /** 默认内容提取：常见正文选择器 */
  private async _defaultExtractContent(): Promise<string> {
    return await this.mcpClient.evaluateScript(`() => {
      var selectors = [
        'article', '.article-body', '.article__body', '.content-body',
        '.cmp-text', '[class*="article-content"]', 'main', '[role="main"]'
      ];
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (el && el.innerText && el.innerText.trim().length > 300) {
          return el.innerText.trim().substring(0, 10000);
        }
      }
      return document.body.innerText.trim().substring(0, 10000);
    }`) || '';
  }
}
