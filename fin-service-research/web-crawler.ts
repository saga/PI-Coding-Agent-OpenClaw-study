/**
 * Web Crawler Base Module
 * 提供 MCP Chrome DevTools 客户端和基础爬虫功能
 * 
 * 安装依赖:
 *   npm install @modelcontextprotocol/sdk sharp ssim.js
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

// ============================================================================
// MCP Chrome DevTools 客户端
// ============================================================================

export class MCPChromeDevToolsClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private browserAlreadyRunning: boolean = false;

  async connect(clientName: string = 'web-crawler'): Promise<void> {
    console.log('🔌 连接到 MCP Chrome DevTools...');

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
// 基础爬虫类
// ============================================================================

export abstract class BaseWebCrawler<T extends CrawlResult, P extends PageConfig> {
  protected results: T[] = [];
  protected mcpClient: MCPChromeDevToolsClient;
  protected outputDir: string;
  protected screenshotDir: string;

  constructor(outputDir: string = './crawl-results') {
    this.mcpClient = new MCPChromeDevToolsClient();
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

  protected delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  protected formatDate(date: Date): string {
    return date.toISOString().split('T')[0].replace(/-/g, '');
  }

  async compareScreenshots(
    actionName: string,
    action: () => Promise<any>,
    pageName: string
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
      result.analysis = `截图已保存，页面在 "${actionName}" 操作后没有变化，可能需要人工检查。`;
    } else if (changed) {
      console.log(`     ✅ 页面已变化`);
      if (fs.existsSync(prePath)) {
        fs.unlinkSync(prePath);
      }
    }

    return result;
  }

  abstract crawlAll(): Promise<T[]>;
  abstract crawlPage(page: P): Promise<T>;
  abstract saveResults(): void;
}
