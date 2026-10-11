import { chromium } from 'playwright-core';
import fs from 'node:fs';
const OUT = '/tmp/audit';
const browser = await chromium.connectOverCDP('http://localhost:29229');
const ctx = browser.contexts()[0];
const page = ctx.pages().find(p => p.url().includes('localhost:5173')) || ctx.pages()[0];
await page.setViewportSize({ width: 1600, height: 1000 });

const errors = [];
page.on('pageerror', e => errors.push(e.message));

// JSON export (id = btn-json)
const [dlJson] = await Promise.all([
  page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
  page.locator('#btn-json').click()
]);
console.log('JSON:', dlJson ? dlJson.suggestedFilename() : 'no download');
if (dlJson) await dlJson.saveAs(`${OUT}/report.json`);

// full report / PDF (id = btn-print)
const [popup] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null),
  page.locator('#btn-print').first().click()
]);
if (popup) {
  await popup.waitForTimeout(1800);
  console.log('REPORT URL:', popup.url());
  await popup.screenshot({ path: `${OUT}/report-page.png` });
  console.log((await popup.locator('body').innerText()).slice(0, 800));
} else {
  await page.screenshot({ path: `${OUT}/report-inline.png` });
  console.log('inline dialog — screenshot taken');
  const t = await page.locator('body').innerText();
  console.log(t.slice(-600));
}

// project ops: rename current project, save-as, delete
const projName = page.locator('aside input').first();
await projName.fill('审计测试项目');
await page.locator('button', { hasText: '保存' }).first().click();
await page.waitForTimeout(800);
const sel2 = page.locator('aside select').first();
console.log('saved options:', await sel2.locator('option').allTextContents());

// export project file
const [dlProj] = await Promise.all([
  page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
  page.locator('button', { hasText: '导出项目' }).first().click()
]);
console.log('PROJ:', dlProj ? dlProj.suggestedFilename() : 'no download');
if (dlProj) await dlProj.saveAs(`${OUT}/project.json`);

// delete it
await page.locator('button', { hasText: '删除' }).first().click();
await page.waitForTimeout(800);
console.log('options after delete:', await sel2.locator('option').allTextContents());

console.log('ERRORS:', errors);
await browser.close();
console.log('DONE');
