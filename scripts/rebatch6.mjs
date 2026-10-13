// 6 份历史样本在统一编排器（当前 main）上重测 → docs/data/batches/2026-10-13.json
// 用法: node scripts/rebatch6.mjs   （8807 已启动最新构建）
import { writeFileSync } from 'node:fs';

const BASE = 'http://localhost:8807';
const runs = {
  'A-adult':    { center: { lat: 28.505089, lng: 118.023892 }, persona: 'adult' },
  'A-elderly':  { center: { lat: 28.505089, lng: 118.023892 }, persona: 'elderly' },
  'B-adult':    { center: { lat: 28.437628310999735, lng: 117.97341184157126 }, persona: 'adult' },
  'B-elderly':  { center: { lat: 28.437628310999735, lng: 117.97341184157126 }, persona: 'elderly' },
  'C-adult':    { center: { lat: 28.42315, lng: 117.97654 }, persona: 'adult' },
  'C-elderly':  { center: { lat: 28.42315, lng: 117.97654 }, persona: 'elderly' }
};

const out = { date: '2026-10-13', runs: {} };
for (const [label, { center, persona }] of Object.entries(runs)) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat: center.lat, lng: center.lng, persona, minutes: 15 })
  });
  const data = await res.json();
  if (data.status !== 0) { console.error(label, 'FAILED', data.message); process.exit(1); }
  const r = data.report;
  const resi = (r.poiSearch ?? []).find((p) => p.category === 'residential');
  const covText = r.gap?.coverageUnavailable
    ? '无法评估'
    : `${Math.round((r.gap?.coverageShare ?? 0) * 1000) / 10}%`;
  out.runs[label] = {
    label, center, persona,
    总分: r.score.total, 等级: r.score.grade,
    完整度: r.score.dims?.completeness ?? null, 临近度: r.score.dims?.proximity ?? null,
    人口覆盖: covText,
    机会: `${r.cumulative?.total ?? 0}处/${r.cumulative?.categoriesCovered ?? 0}类`,
    MAE: r.accuracy?.maeMinutes ?? null,
    灰斑: r.gap?.patches?.length ?? 0,
    补点: r.planSites?.length ?? 0,
    警告: r.warnings ?? [],
    report: r
  };
  console.log(label, `${r.score.total}/${r.score.grade}`, '覆盖', covText,
    `机会 ${r.cumulative?.total}处/${r.cumulative?.categoriesCovered}类`,
    `MAE ${r.accuracy?.maeMinutes}`, `住宅 ${resi?.fetchedCount}/${resi?.reportedTotal}`,
    `${Math.round((Date.now() - t0) / 1000)}s`);
}
writeFileSync('docs/data/batches/2026-10-13.json', JSON.stringify(out, null, 1));
console.log('saved docs/data/batches/2026-10-13.json');
