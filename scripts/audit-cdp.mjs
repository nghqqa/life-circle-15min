// UI audit driver: connect to the managed Chrome via CDP, walk every tab,
// capture console errors/pageerrors/network failures, screenshot each panel.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const OUT = '/tmp/audit';
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const warnings = [];
const failedReqs = [];

const browser = await chromium.connectOverCDP('http://localhost:29229');
const ctx = browser.contexts()[0];
const page = ctx.pages().find(p => p.url().includes('localhost:5173')) || ctx.pages()[0];

page.on('console', m => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
  if (m.type() === 'warning') warnings.push(`[console.warn] ${m.text()}`);
});
page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`));
page.on('requestfailed', r => failedReqs.push(`[reqfail] ${r.url()} :: ${r.failure()?.errorText}`));
page.on('response', r => { if (r.status() >= 400) failedReqs.push(`[http${r.status()}] ${r.url()}`); });

await page.setViewportSize({ width: 1600, height: 1000 });

const tabs = ['体检报告', '对标清单', '灰色区域', '规划建议', '方案对比', '街道体检', '运行日志'];
const nav = page.locator('main section nav').first();
const found = await nav.locator('button').allTextContents();
console.log('TAB BUTTONS:', JSON.stringify(found));

for (const t of tabs) {
  try {
    await nav.locator('button', { hasText: t }).first().click({ timeout: 3000 });
    await page.waitForTimeout(600);
    const safe = t.replace(/\s+/g, '');
    await page.screenshot({ path: `${OUT}/tab-${safe}.png` });
    const text = await page.locator('main section').last().innerText().catch(() => '(no text)');
    console.log(`\n=== ${t} ===\n${text.slice(0, 1200)}`);
  } catch (e) {
    console.log(`\n=== ${t} === CLICK FAIL: ${e.message.split('\n')[0]}`);
  }
}

console.log('\n===== ERRORS ====='); errors.forEach(e => console.log(e));
console.log('===== WARNINGS ====='); warnings.forEach(w => console.log(w));
console.log('===== FAILED REQS ====='); failedReqs.forEach(f => console.log(f));
console.log('DONE');
await browser.close();
