// README 实测数据重制：当前 main 引擎重跑 A/B 样本与街道/城区批量，重截 React UI 截图
// 用法: node scripts/reshoot.mjs   （需 8807 服务已启动最新构建）
import { chromium } from 'playwright';
import { appendFileSync, writeFileSync } from 'node:fs';

const BASE = 'http://localhost:8807';
const SHOT = 'docs/data/screenshots';
const results = {};

const browser = await chromium.launch({ headless: false });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
page.on('pageerror', (e) => log('PAGE-ERR', String(e).slice(0, 150)));

const log = (...a) => { const line = `[${new Date().toTimeString().slice(0, 8)}] ${a.join(' ')}`; console.log(line); appendFileSync('.tmp-reshoot.log', line + '\n'); };

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('goto-err', String(e).slice(0, 100)));
try {
  await page.waitForSelector('#addr-input', { state: 'visible', timeout: 60000 });
} catch {
  log('应用未挂载，重试加载');
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForSelector('#addr-input', { state: 'visible', timeout: 60000 });
}
log('页面就绪');

async function runAnalyze(tag, settle = 2500) {
  const done = page.evaluate(() => new Promise((res) => {
    let idle = false;
    const h = (e) => { if (e.detail === true) idle = false; if (e.detail === false && !idle) { idle = true; window.removeEventListener('lc:busy', h); res('done'); } };
    window.addEventListener('lc:busy', h);
    setTimeout(() => res('timeout'), 240000);
  }));
  await page.click('#btn-analyze');
  const r = await done;
  await page.waitForTimeout(settle);
  const data = await page.evaluate(() => {
    const gc = document.querySelector('.grade-circle');
    const report = document.querySelector('#panel-body')?.innerText ?? document.body.innerText;
    return {
      grade: gc?.querySelector('span')?.textContent ?? null,
      score: gc?.querySelector('b')?.textContent ?? null,
      text: (report.match(/累积机会[^\n]*/)?.[0] ?? '') + ' | ' + (report.match(/人口覆盖率[^\n]*/)?.[0] ?? report.match(/覆盖率[^\n]{0,60}/)?.[0] ?? ''),
    };
  });
  results[tag] = { ...data, wait: r };
  log(tag, r, data.grade, data.score, data.text.slice(0, 300));
  return data;
}

async function selectAntd(id, label) {
  const dd = `.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="${label}"]`;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  // 原生鼠标坐标点击，绕开 antd 内部 span 的命中拦截
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(`#${sel}`)?.closest('.ant-select') ?? document.querySelector(`#${sel}`);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  await page.mouse.click(box.x, box.y);
  await page.waitForSelector(dd, { timeout: 5000 });
  await page.click(dd);
  await page.waitForTimeout(300);
}

async function locate(addr) {
  await page.fill('#addr-input', addr);
  await page.click('#btn-locate');
  await page.waitForTimeout(3000);
}

// ── 样本 A ──
log('== 样本 A ==');
await locate('江西师范大学数字产业学院');
await runAnalyze('A-adult');
await page.screenshot({ path: `${SHOT}/A-adult.png` });
await selectAntd('persona', '老年人');
await runAnalyze('A-elderly');
await page.screenshot({ path: `${SHOT}/A-elderly.png` });

// ── 样本 B ──
log('== 样本 B ==');
await selectAntd('persona', '一般成人');
await locate('上饶市信州区中心广场');
await runAnalyze('B-adult');
await page.screenshot({ path: `${SHOT}/B-urban.png` });
await selectAntd('persona', '老年人');
await runAnalyze('B-elderly');

// ── 街道批量 ──
log('== 街道批量 ==');
await page.click('.ant-tabs-tab:has-text("街道")');
await page.waitForTimeout(800);
async function batch(scopeLabel, addr, scope, tag, max) {
  await selectAntd('street-scope', scopeLabel);
  await page.fill('#street-addr', addr);
  const started = Date.now();
  await page.click('#btn-street-start');
  let job = null;
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(15000);
    try {
      const jobs = await (await fetch(`${BASE}/api/batch/jobs`)).json();
      job = jobs.jobs.find((j) => j.centerName?.includes(addr.replace('上饶市', '').slice(0, 4)) && (j.status === 'done' || j.status === 'running' || j.status === 'interrupted'));
      const latest = jobs.jobs[0];
      log(tag, 'poll', latest?.status, `${latest?.done}/${latest?.total}`, `${Math.round((Date.now() - started) / 1000)}s`);
      if (latest?.status === 'done' && latest?.createdAt > started - 60000) { job = latest; break; }
    } catch { /* ignore */ }
  }
  if (!job || job.status !== 'done') { log(tag, 'FAILED', job?.status); return null; }
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${SHOT}/${tag}.png` });
  const detail = await (await fetch(`${BASE}/api/batch/status/${job.id}`)).json();
  const rows = detail.job.communities.map((c) => ({ name: c.name, score: c.score, grade: c.grade, cov: c.coverageUnavailable ? null : Math.round(c.coverageShare * 1000) / 10, weak: c.dominantMissing }));
  const summary = detail.job.summary;
  results[tag] = { id: job.id, seconds: Math.round((Date.now() - started) / 1000), rows, summary };
  log(tag, 'DONE', `${job.done}/${job.total}`, `${results[tag].seconds}s`, JSON.stringify(summary).slice(0, 160));
  return rows;
}
await batch('街道体检', '上饶市信州区东市街道', 'street', 'street-batch', 10);
await batch('城区试点', '上饶市信州区', 'district', 'district-pilot', 16);

writeFileSync('.tmp-reshoot-results.json', JSON.stringify(results, null, 2));
log('ALL DONE');
await browser.close();
