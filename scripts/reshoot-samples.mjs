// 统一编排器后的样例重截：A 成人/老年 + B 成人/老年（React UI · SSE 流式）
import { chromium } from 'playwright';
import { appendFileSync, writeFileSync } from 'node:fs';

const SHOT = 'docs/data/screenshots';
const results = {};
const browser = await chromium.launch({ headless: false });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
const log = (...a) => { const line = `[${new Date().toTimeString().slice(0, 8)}] ${a.join(' ')}`; console.log(line); appendFileSync('.tmp-reshoot2.log', line + '\n'); };

async function selectAntd(id, label) {
  const dd = `.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="${label}"]`;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
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

async function runSample(tag, addr, persona, shot) {
  await selectAntd('persona', persona);
  await page.fill('#addr-input', addr);
  await page.click('#btn-locate');
  await page.waitForTimeout(3000);
  const done = page.evaluate(() => new Promise((res) => {
    let idle = false;
    const h = (e) => { if (e.detail === true) idle = false; if (e.detail === false && !idle) { idle = true; window.removeEventListener('lc:busy', h); res('done'); } };
    window.addEventListener('lc:busy', h);
    setTimeout(() => res('timeout'), 240000);
  }));
  await page.click('#btn-analyze');
  const r = await done;
  await page.waitForTimeout(2500);
  const data = await page.evaluate(() => {
    const gc = document.querySelector('.grade-circle');
    const text = document.getElementById('panel-body')?.innerText ?? '';
    return {
      grade: gc?.querySelector('span')?.textContent,
      score: gc?.querySelector('b')?.textContent,
      text: ['人口覆盖率', '累积机会', 'WorldPop'].map((k) => text.match(new RegExp(k + '[^\\n]{0,90}'))?.[0] ?? '').filter(Boolean).join(' || ')
    };
  });
  results[tag] = { ...data, wait: r };
  log(tag, r, data.grade, data.score, data.text.slice(0, 200));
  if (shot) await page.screenshot({ path: `${SHOT}/${shot}.png` });
}

await page.goto('http://localhost:8807/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#addr-input', { timeout: 60000 });
log('页面就绪');

await runSample('A-adult', '江西师范大学数字产业学院', '一般成人', 'A-adult');
await runSample('A-elderly', '江西师范大学数字产业学院', '老年人', 'A-elderly');
await runSample('B-adult', '上饶市信州区中心广场', '一般成人', 'B-urban');
await runSample('B-elderly', '上饶市信州区中心广场', '老年人', null);

writeFileSync('.tmp-reshoot2-results.json', JSON.stringify(results, null, 2));
log('ALL DONE');
await browser.close();
