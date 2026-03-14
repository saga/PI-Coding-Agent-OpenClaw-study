/**
 * Web Crawler Base Module
 * 提供 MCP Chrome DevTools 客户端和基础爬虫功能
 * 支持 Chrome 内置 AI (Prompt API)
 * 
 * 安装依赖:
 *   npm install @modelcontextprotocol/sdk sharp ssim.js
 * 
 * Chrome 内置 AI 配置:
 *   1. 访问 chrome://flags/#optimization-guide-on-device-model 设为 Enabled
 *   2. 访问 chrome://flags/#prompt-api-for-gemini-nano 设为 Enabled
 *   3. 重启 Chrome
 * 
 * 参考:
 *   https://developer.chrome.com/docs/ai/get-started
 *   https://developer.chrome.com/docs/ai/prompt-api
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

    if (useExistingChrome) {
      try {
        this.transport = new StdioClientTransport({
          command: "npx",
          args: ["-y", "chrome-devtools-mcp@latest"]
        });
      } catch {
        this.transport = new StdioClientTransport({
          command: "npx",
          args: ["-y", "chrome-devtools-mcp@latest", "--isolated"]
        });
      }
    } else {
      this.transport = new StdioClientTransport({
        command: "npx",
        args: ["-y", "chrome-devtools-mcp@latest", "--isolated"]
      });
    }

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

  async navigatePage(url: string): Promise<any> {
    if (!this.client) throw new Error('MCP client not connected');

    const result = await this.client.callTool({
      name: "navigate_page",
      arguments: { type: "url", url }
    });
    
    return this.parseToolResult(result);
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
   * 检查 Chrome 内置 AI 可用性
   */
  async checkAvailability(): Promise<ChromeAIStatus> {
    const script = `async () => {
      if (!('LanguageModel' in self)) {
        return { available: false, availability: 'unavailable', error: 'LanguageModel API not available' };
      }
      
      try {
        const availability = await LanguageModel.availability();
        
        if (availability === 'available') {
          const params = await LanguageModel.params();
          return { 
            available: true, 
            availability: 'available',
            params: {
              defaultTopK: params.defaultTopK,
              maxTopK: params.maxTopK,
              defaultTemperature: params.defaultTemperature,
              maxTemperature: params.maxTemperature
            }
          };
        }
        
        return { available: false, availability: availability };
      } catch (e) {
        return { available: false, availability: 'unavailable', error: e.message };
      }
    }`;

    const result = await this.mcpClient.evaluateScript(script);
    return result as ChromeAIStatus;
  }

  /**
   * 发送 prompt 到 Chrome 内置 AI
   */
  async prompt(
    message: string, 
    options?: { 
      topK?: number; 
      temperature?: number;
      systemPrompt?: string;
    }
  ): Promise<string> {
    const script = `async () => {
      const options = ${JSON.stringify(options || {})};
      
      try {
        // 检查可用性
        const availability = await LanguageModel.availability();
        if (availability !== 'available') {
          return JSON.stringify({ error: 'Model not available', availability });
        }
        
        // 创建会话
        const sessionOptions = {};
        if (options.topK !== undefined) sessionOptions.topK = options.topK;
        if (options.temperature !== undefined) sessionOptions.temperature = options.temperature;
        if (options.systemPrompt) sessionOptions.systemPrompt = options.systemPrompt;
        
        const session = await LanguageModel.create(sessionOptions);
        
        // 发送 prompt
        const response = await session.prompt(${JSON.stringify(message)});
        
        // 关闭会话
        session.destroy();
        
        return JSON.stringify({ success: true, response });
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    }()`;

    const result = await this.mcpClient.evaluateScript(script);
    
    try {
      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      if (parsed.error) {
        throw new Error(parsed.error);
      }
      return parsed.response;
    } catch (e) {
      throw new Error(`Chrome AI prompt failed: ${result}`);
    }
  }

  /**
   * 流式发送 prompt 到 Chrome 内置 AI
   */
  async promptStreaming(
    message: string,
    onChunk: (chunk: string) => void,
    options?: {
      topK?: number;
      temperature?: number;
      systemPrompt?: string;
    }
  ): Promise<string> {
    const script = `async () => {
      const options = ${JSON.stringify(options || {})};
      
      try {
        const availability = await LanguageModel.availability();
        if (availability !== 'available') {
          return JSON.stringify({ error: 'Model not available', availability });
        }
        
        const sessionOptions = {};
        if (options.topK !== undefined) sessionOptions.topK = options.topK;
        if (options.temperature !== undefined) sessionOptions.temperature = options.temperature;
        if (options.systemPrompt) sessionOptions.systemPrompt = options.systemPrompt;
        
        const session = await LanguageModel.create(sessionOptions);
        
        // 流式响应
        const stream = await session.promptStreaming(${JSON.stringify(message)});
        let fullResponse = '';
        
        for await (const chunk of stream) {
          fullResponse += chunk;
        }
        
        session.destroy();
        
        return JSON.stringify({ success: true, response: fullResponse });
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    }()`;

    const result = await this.mcpClient.evaluateScript(script);
    
    try {
      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      if (parsed.error) {
        throw new Error(parsed.error);
      }
      return parsed.response;
    } catch (e) {
      throw new Error(`Chrome AI streaming prompt failed: ${result}`);
    }
  }

  /**
   * 分析截图变化原因（使用 AI）
   */
  async analyzeScreenshotChange(
    preActionDescription: string,
    postActionDescription: string,
    expectedChange: string
  ): Promise<string> {
    const prompt = `You are analyzing web page screenshots to detect changes.

Before action: ${preActionDescription}
After action: ${postActionDescription}
Expected change: ${expectedChange}

Please analyze:
1. Did the expected change occur?
2. If not, what might be the reason?
3. What should be done to achieve the expected change?

Provide a concise analysis in Chinese.`;

    return this.prompt(prompt, {
      systemPrompt: 'You are a web automation expert analyzing page changes.',
      temperature: 0.3
    });
  }

  /**
   * 提取页面内容摘要
   */
  async summarizeContent(content: string, maxLength: number = 500): Promise<string> {
    const prompt = `Please summarize the following web content in Chinese (max ${maxLength} characters):

${content.substring(0, 3000)}

Summary:`;

    return this.prompt(prompt, {
      systemPrompt: 'You are a content summarizer. Provide concise summaries in Chinese.',
      temperature: 0.5
    });
  }

  /**
   * 分类内容
   */
  async classifyContent(content: string, categories: string[]): Promise<string> {
    const prompt = `Classify the following content into one of these categories: ${categories.join(', ')}

Content: ${content.substring(0, 1000)}

Category:`;

    return this.prompt(prompt, {
      systemPrompt: 'You are a content classifier. Return only the category name.',
      temperature: 0.1
    });
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

  abstract crawlAll(): Promise<T[]>;
  abstract crawlPage(page: P): Promise<T>;
  abstract saveResults(): void;
}
