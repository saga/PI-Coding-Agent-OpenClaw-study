import { MCPChromeDevToolsClient } from './web-crawler';

async function main() {
  const c = new MCPChromeDevToolsClient();
  await c.connect('debug');
  await c.navigatePage('https://professionals.fidelity.co.uk/perspectives/investment-insight');
  await new Promise(r => setTimeout(r, 7000));

  // 查找所有可见的 overlay/modal/gate 元素
  const overlays = await c.evaluateScript(`() => {
    var els = document.querySelectorAll('[class*="overlay"],[class*="modal"],[class*="popup"],[class*="gate"],[id*="gate"],[id*="overlay"],[class*="investor"],[class*="professional"]');
    return Array.from(els).filter(el => el.offsetParent !== null).map(el => ({
      tag: el.tagName, id: el.id,
      cls: (el.className||'').toString().substring(0,100),
      text: (el.innerText||'').trim().substring(0,150)
    }));
  }`);
  console.log('OVERLAYS:', JSON.stringify(overlays, null, 2));

  // 查找所有可见按钮和链接
  const btns = await c.evaluateScript(`() => {
    return Array.from(document.querySelectorAll('button,a'))
      .filter(el => el.offsetParent !== null)
      .map(el => ({
        tag: el.tagName,
        cls: (el.className||'').toString().substring(0,80),
        text: (el.innerText||el.textContent||'').trim().substring(0,80),
        href: el.getAttribute('href')||''
      }))
      .filter(el => el.text.length > 2)
      .slice(0, 30);
  }`);
  console.log('BUTTONS:', JSON.stringify(btns, null, 2));

  await c.disconnect();
}

main().catch(console.error);
