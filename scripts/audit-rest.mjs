import { chromium } from 'playwright-core';
import fs from 'node:fs';
const OUT = '/tmp/audit';
const browser = await chromium.connectOverCDP('http://localhost:29229');
const ctx = browser.contexts()[0];
const page = ctx.pages().find(p => p.url().includes('localhost:5173')) || ctx.pages()[0];
await page.setViewportSize({ width: 1600, height: 1000 });

// street batch: capture the transient banner after click
await page.locator('button', { hasText: '街道体检' }).first().click();
await page.locator('input[placeholder*="街道"]').fill('东市街道');
await page.locator('#btn-street-start').click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/flow-street-after-click.png` });
const banner = await page.locator('#banner, .banner, [class*="banner"]').allTextContents().catch(() => []);
console.log('BANNERS:', JSON.stringify(banner));
const body = await page.locator('body').innerText();
console.log('contains 失败?', body.includes('失败'), '| contains AK?', body.includes('AK'));

// exports from 体检报告 tab
await page.locator('button', { hasText: '体检报告' }).first().click();
await page.waitForTimeout(400);
const [dlCsv] = await Promise.all([
  page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
  page.locator('#btn-facility-csv').click()
]);
console.log('CSV:', dlCsv ? dlCsv.suggestedFilename() : 'no download');
if (dlCsv) { await dlCsv.saveAs(`${OUT}/facilities.csv`); }

const [dlJson] = await Promise.all([
  page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
  page.locator('#btn-export-json').click()
]);
console.log('JSON:', dlJson ? dlJson.suggestedFilename() : 'no download');
if (dlJson) { await dlJson.saveAs(`${OUT}/report.json`); }

// full report page
const [popup] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null),
  page.locator('button', { hasText: '完整报告' }).first().click()
]);
if (popup) {
  await popup.waitForTimeout(1500);
  console.log('REPORT URL:', popup.url());
  await popup.screenshot({ path: `${OUT}/report-page-top.png`, fullPage: false });
  const txt = await popup.locator('body').innerText();
  console.log(txt.slice(0, 700));
} else {
  await page.screenshot({ path: `${OUT}/report-inline.png` });
  console.log('no popup; checking inline…');
}
await browser.close();
console.log('DONE');
