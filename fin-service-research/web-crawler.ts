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
   * 截图检查页面状态，打印截图路径 + 页面文字摘要 + 期望状态描述。
   * 如果 throwOnAbnormal=true，则抛出异常暂停执行，等待 LLM 分析后决定下一步。
   *
   * @param description 当前正在做什么
   * @param expectedState 期望页面应该是什么状态（LLM 用来判断是否正常）
   * @param throwOnAbnormal 是否在截图后抛出异常暂停（默认 true）
   */
  async checkPageState(description: string, expectedState?: string, throwOnAbnormal: boolean = true): Promise<void> {
    const ts = Date.now();
    const label = description.replace(/[^a-z0-9]+/gi, '-').substring(0, 40);
    const screenshotPath = path.join(this.screenshotDir, `check-${label}-${ts}.png`);

    // 截图
    try {
      const buf = await this.mcpClient.takeScreenshot();
      if (buf) fs.writeFileSync(screenshotPath, buf);
    } catch {}

    // 抓页面文字摘要（前600字）
    let pageText = '';
    try {
      pageText = await this.mcpClient.evaluateScript('() => document.body.innerText.substring(0, 600)') || '';
    } catch {}

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📸 [PAGE CHECK] ${description}`);
    console.log(`   截图路径: ${screenshotPath}`);
    if (expectedState) {
      console.log(`   期望状态: ${expectedState}`);
    }
    console.log(`   页面文字摘要:\n${pageText}`);
    console.log(`${'='.repeat(60)}\n`);

    if (throwOnAbnormal) {
      throw new Error(
        `[PAGE CHECK PAUSE] "${description}" — LLM 请查看截图和页面文字，` +
        `判断是否符合期望状态"${expectedState || '未指定'}"，然后决定下一步操作`
      );
    }
  }

  abstract crawlAll(): Promise<T[]>;
  abstract crawlPage(page: P): Promise<T>;
  abstract saveResults(): void;
}
