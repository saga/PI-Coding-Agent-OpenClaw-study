import { MCPChromeDevToolsClient } from './web-crawler';
import * as fs from 'fs';

async function main() {
  const c = new MCPChromeDevToolsClient();
  await c.connect('debug-search');

  // 先处理弹窗
  await c.navigatePage('https://www.fidelity.lu/sustainable-investing/our-approach');
  await new Promise(r => setTimeout(r, 6000));

  await c.evaluateScript(`() => {
    for (const el of document.querySelectorAll('a,button')) {
      const t = (el.innerText || '').trim();
      if (t.includes('Accept') || t.includes('accept')) { el.click(); return; }
    }
  }`);
  await new Promise(r => setTimeout(r, 2000));

  // 导航到搜索页
  console.log('→ 导航到搜索页...');
  await c.navigatePage('https://www.fidelity.lu/search/query/sustainable%20investing');
  await new Promise(r => setTimeout(r, 10000)); // 等10秒让结果加载

  // 截图
  const shot = await c.takeScreenshot();
  if (shot) {
    fs.writeFileSync('./crawl-results/screenshots/search-result-debug.png', shot);
    console.log('📸 截图: crawl-results/screenshots/search-result-debug.png');
  }

  // 输出页面所有文字内容（前2000字）
  const text = await c.evaluateScript('() => document.body.innerText.substring(0, 2000)');
  console.log('\n=== 页面文字内容 ===\n', text);

  // 输出所有链接
  const allLinks = await c.evaluateScript(`() =>
    Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.href + ' | ' + (a.innerText||'').trim().substring(0,60))
      .filter(s => !s.includes('javascript:'))
      .slice(0, 40)
  `);
  console.log('\n=== 所有链接 ===');
  (allLinks as string[]).forEach(l => console.log(' ', l));

  // 输出页面 DOM 结构（主要容器）
  const structure = await c.evaluateScript(`() => {
    const containers = document.querySelectorAll('main, [class*="search"], [class*="result"], [class*="article"], [id*="search"], [id*="result"]');
    return Array.from(containers).map(el => ({
      tag: el.tagName,
      id: el.id,
      className: el.className.substring(0, 80),
      childCount: el.children.length,
      text: el.innerText.substring(0, 100)
    }));
  }`);
  console.log('\n=== 关键容器 ===', JSON.stringify(structure, null, 2));

  await c.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
