import { CATEGORY_MAP, PERSONA_MAP, THRESHOLDS } from '../shared/config.js';
import { measurePlan, type PlanScenarios } from '../shared/comparison.js';
import type { AnalysisResult, LatLng, PlanSite } from '../shared/types.js';
import type { WorkbenchSnapshot } from './projects.js';

export const htmlText = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const percent = (v: number | null) => v === null ? '无法评估' : `${(v * 100).toFixed(1)}%`;
const statusNames = { complete: '已取完', truncated: '达到上限', partial: '部分结果', unknown: '总量未知', failed: '检索失败', skipped: '未执行' };
const sourceNames = { server: '服务端', client: '浏览器端', mock: '演示数据' };

/** UTF-8 BOM for spreadsheets; protect textual cells from formula execution. */
export function makeCsv(rows: (string | number | null | undefined)[][]): string {
  return '\ufeff' + rows.map(row => row.map(value => {
    let text = value == null ? '' : String(value);
    if (typeof value === 'string' && (/^[\s\u0000-\u001f]*[=+@-]/.test(value) || /^[\t\r\n]/.test(value))) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  }).join(',')).join('\r\n') + '\r\n';
}
export function facilityCsv(r: AnalysisResult): string {
  return makeCsv([
    ['报告编号', '中心点', '分析时间', '数据模式', '采样口径', '设施编号', '名称', '类别', '用途', '地址', '纬度', '经度', '坐标系', '来源', '类别检索状态', '采集时间', '规则版本', '规则指纹'],
    ...r.pois.map(p => {
      const searches = (r.poiSearch ?? []).filter(s => s.category === p.category);
      return [r.provenance?.reportId, r.centerName, r.generatedAt, r.mock ? '含演示数据' : '实际检索',
        `中心周边 ${THRESHOLDS.searchRadiusM} 米已取样本，非圈内全量`, p.uid, p.name, CATEGORY_MAP[p.category].name,
        p.category === 'residential' ? '住宅人口代理' : '服务设施', p.address, p.lat, p.lng, 'BD-09', sourceNames[p.source],
        searches.length ? searches.map(s => `${s.keyword}:${statusNames[s.status]}`).join('；') : '未记录完整性',
        searches.filter(s => s.pagesFetched > 0).map(s => s.collectedAt).sort()[0], r.provenance?.ruleVersion, r.provenance?.ruleFingerprint];
    })
  ]);
}
export interface ExportCommunity {
  name: string; center: LatLng; score: number; grade: string; coverageShare: number | null;
  coverageUnavailable?: boolean; dominantMissing: string | null; error?: string;
}
export function weakCommunityCsv(
  communities: ExportCommunity[],
  jobId: string,
  exportedAt = new Date().toISOString(),
  meta: { persona?: string; ruleVersion?: string } = {}
): string {
  const personaName = meta.persona && meta.persona !== 'adult'
    ? ({ adult: '一般成人', elderly: '老年人', child: '儿童(陪同)' } as Record<string, string>)[meta.persona] ?? meta.persona
    : '一般成人';
  const valid = communities.filter(c => !c.error && Number.isFinite(c.score) && c.score >= 0);
  const coverage = (c: ExportCommunity) => c.coverageUnavailable || c.coverageShare == null ? null : c.coverageShare;
  return makeCsv([
    ['任务编号', '导出时间', '口径', '人群', '规则版本', '成功样本数', '失败样本数', '小区', '纬度', '经度', '坐标系', '评分', '等级', '居住权重覆盖率', '主要缺失', '判定原因'],
    ...valid.filter(c => c.score < 75 || (coverage(c) !== null && coverage(c)! < 0.8)).sort((a, b) => a.score - b.score).map(c => [
      jobId, exportedAt, '片区住宅抽样，非行政全域普查；数据模式和规则以原批量任务为准', personaName, meta.ruleVersion ?? '', valid.length, communities.length - valid.length,
      c.name, c.center.lat, c.center.lng, 'BD-09', c.score, c.grade, percent(coverage(c)),
      c.dominantMissing ? CATEGORY_MAP[c.dominantMissing as keyof typeof CATEGORY_MAP]?.name ?? c.dominantMissing : '',
      [c.score < 75 ? '评分低于75' : '', coverage(c) !== null && coverage(c)! < 0.8 ? '居住权重覆盖率低于80%' : '', coverage(c) === null ? '覆盖率无法评估' : ''].filter(Boolean).join('；')
    ])
  ]);
}
export function comparisonTable(r: AnalysisResult, scenarios: PlanScenarios = {}): string {
  const columns = [measurePlan(r, []), ...(['A', 'B'] as const).map(k => scenarios[k] ? measurePlan(r, scenarios[k]!.acceptedSites, scenarios[k]!.baselineKey) : null)];
  const rows: [string, (m: NonNullable<typeof columns[number]>) => string][] = [
    ['补点数', m => String(m.siteCount)], ['三件套全覆盖', m => percent(m.coverage)],
    ['新增覆盖（百分点）', m => m.gainPoints === null ? '无法评估' : `+${m.gainPoints.toFixed(1)}`],
    ['剩余薄弱住宅格', m => m.remainingCells === null ? '无法评估' : String(m.remainingCells)],
    ['剩余缺口权重', m => percent(m.remainingShare)]
  ];
  const reasons = [...new Set(columns.flatMap(m => m?.reason ? [m.reason] : []))];
  return `<table class="tbl comparison-table"><thead><tr><th>指标</th><th>现状</th><th>方案 A</th><th>方案 B</th></tr></thead><tbody>${rows.map(([name, render]) => `<tr><th>${name}</th>${columns.map(m => `<td>${m ? render(m) : '未记录'}</td>`).join('')}</tr>`).join('')}</tbody></table>
    ${reasons.map(s => `<p class="rpt-sub">${htmlText(s)}</p>`).join('')}`;
}

/** Standalone vector map from analysis geometry; never requests tiles or map APIs. */
export function reportMapSvg(r: AnalysisResult, sites: PlanSite[]): string {
  const height = 380, width = 640, margin = 30;
  const extentLat = Math.max(0.00001, (r.field.latMax - r.center.lat) * 2);
  const extentLng = Math.max(0.00001, (r.center.lng - r.field.lngMin) * 2);
  const scale = (height - 2 * margin) / extentLat;
  const cos = Math.cos(r.center.lat * Math.PI / 180);
  const x = (lng: number) => width / 2 + (lng - r.center.lng) * scale * cos;
  const y = (lat: number) => height / 2 - (lat - r.center.lat) * scale;
  const inside = (p: LatLng) => Math.abs(p.lat - r.center.lat) <= extentLat / 2 && Math.abs(p.lng - r.center.lng) <= extentLng / 2;
  const paths = (lines: LatLng[][], color: string, fill: string, stroke = 1.5) => lines.filter(line => line.length > 1).map(line => `<path d="${line.map((p, i) => `${i ? 'L' : 'M'}${x(p.lng).toFixed(2)},${y(p.lat).toFixed(2)}`).join(' ')}" fill="${fill}" stroke="${color}" stroke-width="${stroke}"/>`).join('');
  const pois = r.pois.filter(inside).map(p => `<circle cx="${x(p.lng).toFixed(2)}" cy="${y(p.lat).toFixed(2)}" r="${p.category === 'residential' ? 1.5 : 2.5}" fill="${p.category === 'residential' ? '#a6b3c0' : '#27678c'}"><title>${htmlText(p.name)}</title></circle>`).join('');
  // Co-located different facilities are valid; combine marker labels rather than hiding one.
  const groups: { x: number; y: number; labels: number[] }[] = [];
  sites.forEach((s, i) => {
    if (!inside(s.latLng)) return;
    const px = x(s.latLng.lng), py = y(s.latLng.lat);
    const near = groups.find(g => Math.hypot(g.x - px, g.y - py) < 14);
    if (near) near.labels.push(i + 1); else groups.push({ x: px, y: py, labels: [i + 1] });
  });
  const points = groups.map(g => {
    const label = g.labels.join('/'), w = Math.max(18, label.length * 7 + 6);
    return `<g><rect x="${(g.x - w / 2).toFixed(2)}" y="${(g.y - 9).toFixed(2)}" width="${w}" height="18" rx="9" fill="#bd4624"/><text x="${g.x.toFixed(2)}" y="${(g.y + 3.5).toFixed(2)}" fill="white" text-anchor="middle" font-size="10">${label}</text></g>`;
  }).join('');
  const scaleM = extentLat * 111320 / (height - 2 * margin);
  const barM = scaleM * 100 > 1000 ? 1000 : 500;
  const offMap = sites.filter(s => !inside(s.latLng)).length;
  return `<svg class="report-map" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="生活圈空间示意：等时线、灰色区域、设施和已采纳补点">
    <rect width="640" height="380" fill="#f4f7fa"/>
    ${r.gap.patches.map(p => paths(p.outline, '#d69681', '#f4d4c580')).join('')}
    ${r.rings.map(ring => paths(ring.lines, ring.level === r.minutes ? '#166c64' : '#78a8a0', 'none', ring.level === r.minutes ? 2.5 : 1)).join('')}
    ${pois}${points}<path d="M316,190h8 M320,186v8" stroke="#0f172a" stroke-width="2"/>
    <text x="610" y="28" font-size="16">N ↑</text><path d="M30,350h${(barM / scaleM).toFixed(2)}" stroke="#334155" stroke-width="3"/>
    <text x="30" y="370" font-size="11">${barM} m（约）</text>
    ${offMap ? `<text x="300" y="370" font-size="11">另有 ${offMap} 个采纳点在图幅外，见坐标表</text>` : ''}</svg>`;
}
function siteTable(sites: PlanSite[], title: string): string {
  if (!sites.length) return `<div class="small-section"><h3>${htmlText(title)}（0 处）</h3><p>无</p></div>`;
  return `<h3>${htmlText(title)}（${sites.length} 处）</h3><table><thead><tr><th>序号</th><th>类别</th><th>纬度 / 经度（BD-09）</th><th>原始推荐依据<br>（非当前重算收益）</th></tr></thead><tbody>${sites.map((s, i) => `<tr><td>${i + 1}</td><td>${CATEGORY_MAP[s.category].name}</td><td>${s.latLng.lat.toFixed(6)}, ${s.latLng.lng.toFixed(6)}</td><td>${htmlText(s.rationale)}</td></tr>`).join('')}</tbody></table>`;
}
export function printableReport(r: AnalysisResult, w: WorkbenchSnapshot): string {
  const p = r.provenance;
  const table = (headers: string[], rows: string[][]) => `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>圈点体检报告 · ${htmlText(r.centerName)}</title>
  <style>body{font:14px/1.65 "Microsoft YaHei",sans-serif;color:#243846;background:#eef2f5;margin:0}main{max-width:900px;background:white;margin:24px auto;padding:36px}h1{font-size:28px;color:#12695f}h2{font-size:20px;border-bottom:2px solid #dae9e5;padding-bottom:8px;margin-top:28px}h3{font-size:16px}p{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;font-size:12px;margin:14px 0;table-layout:fixed;overflow-wrap:anywhere}th,td{border:1px solid #d5dfe5;padding:7px;text-align:left}th{background:#eff6f4}thead{display:table-header-group}tr{break-inside:avoid}.notice{background:#fff3df;padding:12px;border-left:4px solid #bc742b}.report-map{width:100%;max-height:380px;display:block}.map-block,.small-section{break-inside:avoid}.legend{font-size:12px;color:#526776}.toolbar{position:sticky;top:0;padding:12px;background:#163f39;color:white;text-align:center}button{font:inherit;padding:6px 18px;cursor:pointer}h2,h3{break-after:avoid}@page{size:A4;margin:15mm;@bottom-center{content:"圈点 · 第 " counter(page) " 页";font-size:9px;color:#62707b}}@media print{body{background:white;font-size:11px}main{padding:0;margin:0;max-width:none}.toolbar{display:none}h1{font-size:24px}h2{font-size:17px}table{font-size:10px}.report-map{max-height:85mm}.section-break{break-before:page}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body>
  <div class="toolbar"><button id="print-report">打印 / 另存为 PDF</button>　报告已包含图表与方案，打印时建议关闭浏览器页眉页脚。</div><main>
  <h1>圈点 · 15 分钟生活圈体检报告</h1><h2>${htmlText(r.centerName)}</h2>
  <p>${PERSONA_MAP[r.persona].name} · 步行 ${r.minutes} 分钟 · ${r.field.speed} m/min<br>分析时间：${htmlText(r.generatedAt)}<br>中心：${r.center.lat.toFixed(6)}, ${r.center.lng.toFixed(6)}（BD-09）</p>
  <p class="notice">${r.mock ? '演示数据，仅用于展示流程。' : '基于本次已取得的设施样本。'}住宅小区密度作为人口代理，非实际人口数；补点收益是 ${THRESHOLDS.coreRadiusM} 米直线服务半径下的模型估算，需结合用地、预算和实地调研验证。</p>
  <p><b>现状评分 ${r.score.total} / 100（${r.score.grade}）</b> · 三件套全覆盖：${percent(r.gap.coverageShare)}<br>完整度 ${percent(r.score.dims.completeness)} · 临近度 ${percent(r.score.dims.proximity)} · 覆盖 ${percent(r.score.dims.coverage)} · 多样性 ${percent(r.score.dims.diversity)}</p><p>${htmlText(r.score.summary)}</p>
  <div class="map-block">${reportMapSvg(r, w.acceptedSites)}<p class="legend">无底图空间示意（BD-09）：绿色线为等时线，浅橙色为现状灰色区域，蓝点为设施，灰点为住宅，橙色编号为当前已采纳补点，十字为中心。相邻补点合并编号，精确位置见坐标表。图幅内展示，未生成的等时线不补绘。</p></div>
  <h2>设施与参考标准</h2><p>周边已取样本与步行圈内可达统计分别展示；数量为已取下界，不能将未查到解释为不存在。对标阈值是项目参考基线。</p>
  ${table(['类别', '周边已取', '圈内可达样本', '数据完整性'], r.score.details.map(d => [htmlText(d.name), String(r.pois.filter(poi => poi.category === d.category).length), String(r.cumulative?.byCategory[d.category] ?? '未记录'), d.missingData ? '数据不完整' : '见来源记录']))}
  ${table(['参考设施项 / 依据', '阈值 / 最近距离', '判定'], r.checklist.map(c => [htmlText(c.name) + '<br>' + htmlText(c.basis), `${c.thresholdM} m / ${c.nearestM === null ? '未查得' : `${c.nearestM} m`}`, c.met === null ? '无法判断' : c.met ? '达标' : '缺失']))}
  <h2>现状灰色区域</h2>${table(['斑块', '缺失类别', '住宅代理权重占比', '最远直线距离'], r.gap.patches.map(g => [String(g.id), g.missingCats.map(c => CATEGORY_MAP[c].name).join('、'), percent(g.weightShare), g.maxNearestM > 0 ? `${g.maxNearestM} m` : '无法给出']))}
  <h2 class="section-break">方案 A / B 对比</h2><p>两套方案固定同一社区、人群、时长、样本与规则。只计已采纳补点；重叠服务盘去重。全覆盖指菜市场、药店、小学三类齐全的住宅代理权重占比；新增覆盖为相对现状提升的百分点。现状总评分不随模拟补点改写。</p>
  ${comparisonTable(r, w.scenarios)}
  ${(['A', 'B'] as const).map(k => { const s = w.scenarios?.[k]; return s ? `<h3>方案 ${k} · 记录于 ${htmlText(s.savedAt)}</h3><div class="map-block">${reportMapSvg(r, s.acceptedSites)}</div>${siteTable(s.acceptedSites, `方案 ${k} 已采纳`)}${siteTable(s.rejectedSites, `方案 ${k} 已跳过（不计收益）`)}` : `<p>方案 ${k} 尚未记录。</p>`; }).join('')}
  <h2>当前工作台选择</h2><p>当前选择可能与已记录的 A / B 不同，以下保留实际工作状态。</p>${siteTable(w.acceptedSites, '当前已采纳')}${siteTable(w.rejectedSites, '当前已跳过（不计收益）')}
  <h2>数据来源、完整性与版本</h2><p>报告编号：${htmlText(p?.reportId ?? '未记录')}<br>应用 / 算法：${htmlText(p ? `${p.applicationVersion} / ${p.algorithmVersion}` : '未记录')}<br>规则：${htmlText(p ? `${p.ruleVersion} / ${p.ruleFingerprint}` : '未记录')}<br>通道：${htmlText(p?.channels.map(c => sourceNames[c]).join('、') ?? '未记录')}<br>设施最早采集：${htmlText(p?.poiCollectedAt ?? '未记录')}；缓存命中 ${p?.poiCacheHits ?? '未知'} / ${p?.poiQueries ?? '未知'} 次。路线缓存原始采集时间未记录。</p>
  <p>“已取完”表示关键词的上游返回已取尽，非现实设施普查。无版本记录或旧规则项目仅保留历史结果。</p>
  ${table(['关键词', '通道', '已取 / 上游总数', '分页 / 上限', '完整性', '采集时间'], (r.poiSearch ?? []).map(s => [htmlText(s.keyword), sourceNames[s.source] + (s.cacheHit ? '（缓存）' : ''), `${s.fetchedCount} / ${s.reportedTotal ?? '未知'}`, `${s.pagesFetched} / ${s.pageLimit}`, statusNames[s.status], htmlText(s.collectedAt)]))}
  <h3>口径与警告</h3>${r.warnings?.length ? `<ul>${r.warnings.map(s => `<li>${htmlText(s)}</li>`).join('')}</ul>` : '<p>本次未记录额外警告，请结合上表完整性与模型口径使用。</p>'}
  </main><script>
  // 浏览器扩展（截图/便签类）会把悬浮控件注入页面并被一起打印——打印前后只保留本报告自己的节点
  function __lcCleanInjected() {
    var h = document.documentElement, b = document.body;
    Array.prototype.slice.call(h.children).forEach(function (n) { if (n.tagName !== 'HEAD' && n.tagName !== 'BODY') n.remove(); });
    Array.prototype.slice.call(b.children).forEach(function (n) {
      if (n.tagName !== 'MAIN' && n.id !== 'lc-toolbar' && n.tagName !== 'SCRIPT') n.remove();
    });
  }
  __lcCleanInjected();
  setTimeout(__lcCleanInjected, 400);
  setTimeout(__lcCleanInjected, 1500);
  document.getElementById('print-report').addEventListener('click', function () {
    __lcCleanInjected();
    setTimeout(window.print, 60);
  });
  </script></body></html>`;
}
export function downloadText(text: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function openPrintableReport(r: AnalysisResult, w: WorkbenchSnapshot): 'preview' | 'download' {
  const contents = printableReport(r, w);
  const popup = window.open('', '_blank');
  if (!popup) { downloadText(contents, '圈点-完整体检报告.html', 'text/html;charset=utf-8'); return 'download'; }
  popup.opener = null;
  popup.document.open(); popup.document.write(contents); popup.document.close();
  return 'preview';
}
