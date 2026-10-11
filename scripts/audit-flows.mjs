// Interactive flow audit: persona/minutes switching, plan adopt/skip,
// A/B compare, street batch, exports, project save/rename/delete,
// address locate — all under demo mode.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const OUT = '/tmp/audit';
fs.mkdirSync(OUT, { recursive: true });
const errors = [];
const failedReqs = [];

const browser = await chromium.connectOverCDP('http://localhost:29229');
const ctx = browser.contexts()[0];
const page = ctx.pages().find(p => p.url().includes('localhost:5173')) || ctx.pages()[0];
page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`); });
page.on('response', r => { if (r.status() >= 400) failedReqs.push(`[http${r.status()}] ${r.url()}`); });
await page.setViewportSize({ width: 1600, height: 1000 });

const log = (s) => console.log(`\n### ${s}`);
const sel = (id) => page.locator(`#${id}`);

// ---------- 1. persona switch: adult → elderly ----------
log('P1 persona switch adult→elderly');
await sel('persona').selectOption('elderly');
await page.waitForTimeout(400);
// does changing persona auto reanalyze or need 开始体检?
const analyzeBtn = page.locator('button', { hasText: '开始体检' }).first();
console.log('analyze btn disabled?', await analyzeBtn.isDisabled().catch(() => 'n/a'));

// ---------- 2. minutes switch ----------
log('P2 minutes 15→10');
await sel('minutes').selectOption('10');
await page.waitForTimeout(400);

// ---------- 3. re-run analysis with elderly/10min ----------
log('P3 re-analyze elderly/10min');
await analyzeBtn.click();
await page.waitForSelector('text=正在体检', { timeout: 10000 }).catch(() => console.log('no 正在体检 indicator'));
// wait until report tab shows new result or busy clears
await page.waitForTimeout(25000);
await page.screenshot({ path: `${OUT}/flow-elderly-10min.png` });
const report = await page.locator('main section').last().innerText().catch(() => '');
console.log(report.slice(0, 800));

// ---------- 4. plan adoption ----------
log('P4 plan adopt');
const nav = page.locator('main section nav').first();
await nav.locator('button', { hasText: '规划建议' }).first().click();
await page.waitForTimeout(500);
const adoptBtn = page.locator('button', { hasText: '采纳' }).first();
if (await adoptBtn.count()) {
  await adoptBtn.click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/flow-adopt.png` });
  const t = await page.locator('main section').last().innerText().catch(() => '');
  console.log(t.slice(0, 900));
} else console.log('no 采纳 button — no suggestions?');

// ---------- 5. A/B compare record ----------
log('P5 record plan A');
await nav.locator('button', { hasText: '方案对比' }).first().click();
await page.waitForTimeout(500);
const recA = page.locator('button', { hasText: '记录为 A' }).first();
if (await recA.count()) {
  await recA.click();
  await page.waitForTimeout(800);
  // possible confirm dialog
  const dlg = page.locator('text=确认').first();
  if (await dlg.count()) console.log('confirm dialog appeared');
  await page.screenshot({ path: `${OUT}/flow-planA.png` });
  const t = await page.locator('main section').last().innerText().catch(() => '');
  console.log(t.slice(0, 900));
} else console.log('no 记录为 A button');

// ---------- 6. street batch ----------
log('P6 street batch');
await nav.locator('button', { hasText: '街道体检' }).first().click();
await page.waitForTimeout(400);
const addrInput = page.locator('input[placeholder*="街道"]').first();
console.log('street input count:', await addrInput.count());
if (await addrInput.count()) {
  await addrInput.fill('东市街道');
  const startBtn = page.locator('button', { hasText: /^开始/ }).last();
  await startBtn.click();
  await page.waitForTimeout(12000);
  await page.screenshot({ path: `${OUT}/flow-street.png` });
  const t = await page.locator('main section').last().innerText().catch(() => '');
  console.log(t.slice(0, 1000));
}

// ---------- 7. exports ----------
log('P7 exports');
// CSV
const csvBtn = page.locator('button', { hasText: '设施 CSV' }).first();
if (await csvBtn.count()) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
    csvBtn.click()
  ]);
  console.log('CSV download:', dl ? await dl.suggestedFilename() : 'none');
}
// JSON
const jsonBtn = page.locator('button', { hasText: '导出 JSON' }).first();
if (await jsonBtn.count()) {
  const [dl2] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
    jsonBtn.click()
  ]);
  console.log('JSON download:', dl2 ? await dl2.suggestedFilename() : 'none');
}
// PDF report page
const pdfBtn = page.locator('button', { hasText: '完整报告' }).first();
if (await pdfBtn.count()) {
  const [popup] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null),
    pdfBtn.click()
  ]);
  if (popup) {
    await popup.waitForTimeout(1500);
    await popup.screenshot({ path: `${OUT}/flow-report-page.png` });
    console.log('report page url:', popup.url());
    console.log((await popup.locator('body').innerText().catch(() => '')).slice(0, 600));
  } else {
    // maybe in-place drawer/dialog
    await page.screenshot({ path: `${OUT}/flow-report-inline.png` });
    console.log('no popup — inline?');
  }
}

// ---------- 8. project save/rename/delete ----------
log('P8 project ops');
const nameInput = page.locator('aside input').first();
console.log('project name value:', await nameInput.inputValue().catch(() => 'n/a'));

// ---------- 9. address locate in demo ----------
log('P9 address locate demo');
const addr = page.locator('input[placeholder*="地址"]').first();
await addr.fill('上饶市信州区');
const locBtn = page.locator('button', { hasText: /^定位$/ }).first();
await locBtn.click();
await page.waitForTimeout(1500);
console.log('center input after locate:', await addr.inputValue().catch(() => 'n/a'));

console.log('\n===== ERRORS ====='); errors.forEach(e => console.log(e));
console.log('===== FAILED REQS ====='); failedReqs.forEach(f => console.log(f));
console.log('DONE');
await browser.close();
