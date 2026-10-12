// 端到端验证：UI 走 /api/analyze/stream（服务端编排），数字应与 /api/analyze 一致
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const browser = await chromium.launch({ headless: false });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
const notes = [];
let streamSeen = false;
page.on('request', (r) => { if (r.url().includes('/api/analyze/stream')) streamSeen = true; });

await page.goto('http://localhost:8807/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#addr-input', { timeout: 30000 });
// 监听 HUD note：hud.note 写入的元素在日志页签/HUD 区
await page.evaluate(() => {
  (window).__streamNotes = [];
  window.addEventListener('lc:busy', (e) => { (window).__busy = e.detail; });
});
await page.fill('#addr-input', '上饶市信州区中心广场');
await page.click('#btn-locate');
await page.waitForTimeout(3000);
await page.click('#btn-analyze');
// 轮询等完成 + 期间抓 HUD 文本
let hudText = '';
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(3000);
  hudText = await page.evaluate(() => document.querySelector('#hud')?.innerText ?? document.body.innerText.match(/POI 检索[^\n]*/g)?.join(' | ') ?? '');
  const busy = await page.evaluate(() => (window).__busy);
  if (busy === false && i > 2) break;
}
const data = await page.evaluate(() => {
  const gc = document.querySelector('.grade-circle');
  const body = document.getElementById('panel-body')?.innerText ?? '';
  const log = document.querySelector('[data-tab="log"]')?.innerText ?? '';
  return {
    grade: gc?.querySelector('span')?.textContent,
    score: gc?.querySelector('b')?.textContent,
    report: body.slice(0, 1200),
    logText: log.slice(0, 2000)
  };
});
writeFileSync('.tmp-ui-b.json', JSON.stringify({ ...data, streamSeen, hudText }, null, 2));
console.log('stream请求发出:', streamSeen, '| UI总分:', data.score, data.grade);
console.log('HUD文本样本:', String(hudText).split('\n').filter(l => l.includes('POI 检索')).slice(0, 3));
await browser.close();
