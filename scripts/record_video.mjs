// 视频素材录制：1080P 真实 UI 走查（对应《视频分镜-20261013》shot2-shot7）
// 用法: node scripts/record_video.mjs  （8807 已启动最新构建、缓存热）
import { chromium } from 'playwright';

const OUT = '.tmp-video';
const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } }
});
const page = await ctx.newPage();
const log = (...a) => console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...a);
const pause = (ms) => page.waitForTimeout(ms);

async function selectAntd(id, label) {
  const dd = `.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="${label}"]`;
  await page.keyboard.press('Escape');
  await pause(250);
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(`#${sel}`)?.closest('.ant-select') ?? document.querySelector(`#${sel}`);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  await page.mouse.click(box.x, box.y);
  await page.waitForSelector(dd, { timeout: 5000 });
  await page.click(dd);
  await pause(250);
}

async function analyze(addr) {
  await page.fill('#addr-input', addr);
  await page.click('#btn-locate');
  await pause(2500);
  await page.click('#btn-analyze');
  const done = page.evaluate(() => new Promise((res) => {
    let idle = false;
    const h = (e) => { if (e.detail === true) idle = false; if (e.detail === false && !idle) { idle = true; window.removeEventListener('lc:busy', h); res('done'); } };
    window.addEventListener('lc:busy', h);
    setTimeout(() => res('timeout'), 180000);
  }));
  await done;
  await pause(2500);
}

await page.goto('http://localhost:8807/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#addr-input', { timeout: 60000 });
await pause(2500);
log('== shot2 定位体检（A）==');
await analyze('江西师范大学数字产业学院');
await pause(1500);
// 报告缓慢滚动展示
await page.locator('#panel-body').evaluate?.(() => {});
for (let i = 1; i <= 6; i++) { await page.mouse.wheel(0, 160); await pause(700); }
log('== shot3 对照（B）==');
await analyze('上饶市信州区中心广场');
for (let i = 1; i <= 8; i++) { await page.mouse.wheel(0, 170); await pause(650); }
log('== shot4 老年人 + 三人群 ==');
await selectAntd('persona', '老年人');
await page.click('#btn-analyze');
await page.waitForFunction(() => !document.querySelector('#btn-analyze.matches\\/\\?') ?? true).catch(() => {});
await pause(45000);
for (let i = 1; i <= 5; i++) { await page.mouse.wheel(0, 170); await pause(600); }
const cmp = page.locator('button:has-text("生成三人群对比")');
if (await cmp.count()) { await cmp.first().click(); await pause(30000); }
log('== shot5 规划与导出 ==');
await selectAntd('persona', '一般成人');
await analyze('上饶市信州区中心广场');
await page.locator('.ant-tabs-tab:has-text("规划")').click();
await pause(2500);
const accept = page.locator('[data-act="accept"], button:has-text("采纳")').first();
if (await accept.count()) { await accept.click(); await pause(3000); }
await page.locator('.ant-tabs-tab:has-text("对比")').click();
await pause(2000);
const rec = page.locator('button:has-text("记录为方案 A"), button:has-text("记录为 A"), button:has-text("记为 A")').first();
if (await rec.count()) { await rec.click(); await pause(3000); }
for (let i = 1; i <= 4; i++) { await page.mouse.wheel(0, 170); await pause(600); }
log('== shot6 街道批量 ==');
await page.locator('.ant-tabs-tab:has-text("街道")').click();
await pause(1200);
await selectAntd('street-persona', '一般成人');
await page.fill('#street-addr', '上饶市信州区东市街道');
await page.click('#btn-street-start');
for (let i = 0; i < 20; i++) { await pause(15000); const t = await page.evaluate(() => document.body.innerText.includes('最近任务') ? document.body.innerText.match(/(\d+)\/(\d+)/)?.[0] : ''); log('batch', t); if (t && t.split('/')[0] === t.split('/')[1]) break; }
await pause(6000);
for (let i = 1; i <= 6; i++) { await page.mouse.wheel(0, 170); await pause(600); }
log('== shot7 API 文档 ==');
const docs = await ctx.newPage();
await docs.setViewportSize({ width: 1920, height: 1080 });
await docs.goto('http://localhost:8807/api/docs', { waitUntil: 'domcontentloaded' });
await pause(6000);
for (let i = 1; i <= 5; i++) { await docs.mouse.wheel(0, 200); await pause(700); }
await docs.close();
await page.close();
const v = await page.video();
log('raw video:', await v?.path());
await browser.close();
