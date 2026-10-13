// 用 wangwangit 网页版批量生成 8 段晓晓旁白 → .tmp-video/s*.mp3
// 用法: node scripts/gen_tts_web.mjs
import { chromium } from 'playwright';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const OUT = '.tmp-video';
// 从 video_build.py 抽取 SEGS 的 text 字段（单一代码来源）
const py = readFileSync('scripts/video_build.py', 'utf8');
const SEGS = [...py.matchAll(/id='(s\d)'/g)].map(m => m[1]).map((id, i) => {
  const after = py.slice(py.indexOf(`id='${id}'`));
  const tm = after.match(/text='([\s\S]*?)'\)/);
  if (!tm) throw new Error('解析失败 ' + id);
  return { id, text: tm[1].replaceAll('\\u300c', '「').replaceAll('\\u300d', '」') };
});
if (SEGS.length !== 8) throw new Error('SEGS 解析数量不对: ' + SEGS.length);

const browser = await chromium.launch({ headless: false });
const page = await (await browser.newContext()).newPage();
await page.goto('https://tts.wangwangit.com', { waitUntil: 'domcontentloaded', timeout: 40000 });
await page.waitForSelector('#text', { timeout: 20000 });
await page.waitForTimeout(3000);

const voiceOk = await page.evaluate(() => {
  const sel = document.querySelector('#voice');
  const opt = [...sel.options].find(o => o.value.includes('Xiaoxiao') || o.textContent.includes('晓晓'));
  if (!opt) return null;
  sel.value = opt.value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return opt.value + '|' + opt.textContent;
});
console.log('voice:', voiceOk);
if (!voiceOk) { console.error('未找到晓晓选项'); process.exit(1); }

for (const { id, text } of SEGS) {
  const dst = `${OUT}/${id}.mp3`;
  if (existsSync(dst)) { console.log(id, '已存在跳过'); continue; }
  await page.fill('#text', text);
  await page.waitForTimeout(400);
  const btn = page.locator('button:has-text("转换"), button:has-text("生成"), button:has-text("合成"), button:has-text("开始")').first();
  await btn.click();
  console.log(id, '已提交，等待音频…');
  let ready = false;
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(2000);
    ready = await page.evaluate(() => {
      const a = document.querySelector('audio');
      const d = document.querySelector('a[download]');
      return !!(a && a.src && a.src.startsWith('blob') && d && d.href && d.href.startsWith('blob'));
    });
    if (ready) break;
    if (i % 15 === 14) console.log(id, `${(i + 1) * 2}s…`);
  }
  if (!ready) { console.error(id, '超时未就绪'); process.exit(2); }
  const b64 = await page.evaluate(async () => {
    const d = document.querySelector('a[download]');
    const res = await fetch(d.href);
    const buf = await res.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  writeFileSync(dst, Buffer.from(b64, 'base64'));
  console.log(id, 'saved', dst, Math.round(b64.length * 0.75 / 1024), 'KB');
}
console.log('ALL TTS DONE');
await browser.close();
