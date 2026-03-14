import { MCPChromeDevToolsClient } from './web-crawler';
import * as fs from 'fs';

async function main() {
  const c = new MCPChromeDevToolsClient();
  await c.connect('debug-lu');

  console.log('→ 导航到 fidelity.lu...');
  await c.navigatePage('https://www.fidelity.lu/sustainable-investing/our-approach');
  await new Promise(r => setTimeout(r, 8000));

  // 截图看页面状态
  const shot = await c.takeScreenshot();
  if (shot) {
    fs.mkdirSync('./crawl-results/screenshots', { recursive: true });
    fs.writeFileSync('./crawl-results/screenshots/debug-lu-initial.png', shot);
    console.log('📸 截图: crawl-results/screenshots/debug-lu-initial.png');
  }

  // 看 evaluateScript 原始返回格式
  const raw = await c.evaluateScript('() => 42');
  console.log('RAW number:', typeof raw, JSON.stringify(raw));

  const rawArr = await c.evaluateScript('() => ["a","b","c"]');
  console.log('RAW array:', typeof rawArr, JSON.stringify(rawArr));

  // 页面上有多少链接
  const count = await c.evaluateScript('() => document.querySelectorAll("a").length');
  console.log('Link count:', count);

  // 前10个链接
  const hrefs = await c.evaluateScript('() => Array.from(document.querySelectorAll("a[href]")).map(a => a.href).slice(0, 10)');
  console.log('First 10 hrefs:', JSON.stringify(hrefs));

  // 页面文本前300字
  const text = await c.evaluateScript('() => document.body.innerText.substring(0, 300)');
  console.log('Body text:', text);

  await c.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
