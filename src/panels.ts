import { CATEGORY_MAP, PERSONA_MAP, THRESHOLDS } from '../shared/config.js';
import { applySiteCoverage, planFacilitiesFromCoverage } from '../shared/planner.js';
import { localDistM } from '../shared/geo.js';
import type { AnalysisResult, GapPatch, LatLng, PlanSite } from '../shared/types.js';
import { renderCharts } from './charts.js';
import { banner, CHANNEL_LABEL } from './hud.js';
import { map } from './main.js';
import type { WorkbenchSnapshot } from './projects.js';
import { APPLICATION_VERSION, ALGORITHM_VERSION, RULE_VERSION, ruleFingerprint } from '../shared/provenance.js';
import { captureScenario, comparisonBaseline, type PlanScenarios } from '../shared/comparison.js';
import { comparisonTable, downloadText, weakCommunityCsv } from './exports.js';

/** 右侧报告面板：体检报告 / 国标清单 / 灰色区域 / 规划建议 / 街道体检 / 运行日志 */

let currentResult: AnalysisResult | null = null;
let currentTab = 'report';

// ---- 交互式规划工作台状态（新分析时重置）----
let acceptedSites: PlanSite[] = [];
let rejectedSites: PlanSite[] = [];
let scenarios: PlanScenarios = {};
let workbenchListener: (() => void) | null = null;

export function onWorkbenchChange(listener: () => void) { workbenchListener = listener; }
export function getWorkbenchSnapshot(): WorkbenchSnapshot {
  return structuredClone({ acceptedSites, rejectedSites, ...(Object.keys(scenarios).length ? { scenarios } : {}) });
}
export function setWorkbenchState(snapshot: WorkbenchSnapshot) {
  acceptedSites = structuredClone(snapshot.acceptedSites);
  rejectedSites = structuredClone(snapshot.rejectedSites);
  scenarios = structuredClone(snapshot.scenarios ?? {});
}
export function displayedPlanSites(): PlanSite[] {
  return currentResult ? [...acceptedSites, ...currentSites(currentResult)] : [];
}

// ---- 街道批量体检状态 ----
interface StreetCommunity {
  name: string;
  center: LatLng;
  score: number;
  grade: string;
  coverageShare: number | null;
  coverageUnavailable?: boolean;
  dominantMissing: string | null;
  error?: string;
}
let streetJobId: string | null = null;
let streetPollTimer: ReturnType<typeof setInterval> | null = null;
let streetLastSnapshot: { status: string; done: number; total: number; current: string; communities: StreetCommunity[]; summary: any; error?: string } | null = null;

export function setResult(r: AnalysisResult | null) {
  if (r !== currentResult) {
    acceptedSites = [];
    rejectedSites = [];
    scenarios = {};
  }
  currentResult = r;
}

/** 工作台决策快照（导出 JSON 时随报告持久化） */
export function getWorkbenchState() {
  return {
    acceptedSites: acceptedSites.map((s) => ({
      category: s.category,
      latLng: s.latLng,
      coveredCells: s.coveredCells,
      beforePct: s.beforePct,
      afterPct: s.afterPct
    })),
    rejectedSites: rejectedSites.map((s) => ({ category: s.category, latLng: s.latLng })),
    currentSuggestions: currentResult ? currentSites(currentResult).length : 0,
    ...(Object.keys(scenarios).length ? { scenarios: structuredClone(scenarios) } : {})
  };
}

export function switchTab(tab: string) {
  currentTab = tab;
  document.querySelectorAll('#panel-tabs button').forEach((b) => {
    b.classList.toggle('on', (b as HTMLElement).dataset.tab === tab);
  });
  render();
}

export function render() {
  const body = document.getElementById('panel-body')!;
  const footer = document.getElementById('panel-footer')!;
  if (!currentResult && currentTab !== 'street') {
    body.innerHTML = `
    <div class="empty-tip">
      <div class="empty-title">三步完成一次生活圈体检</div>
      <ol>
        <li><b>定位中心点</b>：输入地址，或在地图上直接选点；</li>
        <li><b>选择人群</b>：老年人速度更慢，可达范围更小；</li>
        <li><b>点击「开始体检」</b>，查看右侧各页签的报告与规划建议。</li>
      </ol>
    </div>`;
    footer.classList.add('hidden');
    return;
  }
  footer.classList.toggle('hidden', !['report', 'compare'].includes(currentTab) || !currentResult);
  const r = currentResult;
  switch (currentTab) {
    case 'report':
      if (!r) { body.innerHTML = '<div class="empty-tip">先完成一次体检</div>'; break; }
      body.innerHTML = reportHtml(r); animateGrade(r.score.total); renderCharts(r);
      break;
    case 'checklist': if (r) body.innerHTML = checklistHtml(r); break;
    case 'gaps': if (r) body.innerHTML = gapsHtml(r); break;
    case 'plan': body.innerHTML = r ? planHtml(r) : '<div class="empty-tip">先完成一次体检</div>'; wirePlanActions(); break;
    case 'compare': if (r) { body.innerHTML = compareHtml(r); wireComparison(); } break;
    case 'street': body.innerHTML = streetHtml(); wireStreet(); break;
    case 'log': if (r) body.innerHTML = logHtml(r); break;
  }
  // Delegate to the stable container: polling replaces street-result buttons later.
  body.onclick = (event) => {
    const el = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-fly]') : null;
    if (!el || !body.contains(el)) return;
    const [lat, lng] = (el.dataset.fly ?? '').split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) map.flyTo({ lat, lng });
  };
}

/** 评分数字滚动动画（尊重系统减少动效偏好） */
function animateGrade(total: number) {
  const el = document.querySelector('#panel-body .grade-circle b');
  if (!el) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = String(total);
    return;
  }
  const t0 = performance.now();
  const dur = 650;
  const tick = (now: number) => {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = String(Math.round(total * eased));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function gradeColor(grade: string): string {
  return { A: '#2f9e44', B: '#74b816', C: '#f08c00', D: '#e8590c', E: '#e03131' }[grade] ?? '#666';
}

function sameRules(r: AnalysisResult): boolean {
  return !!r.provenance && (r.provenance.applicationVersion === APPLICATION_VERSION && r.provenance.ruleVersion === RULE_VERSION &&
    r.provenance.algorithmVersion === ALGORITHM_VERSION && r.provenance.ruleFingerprint === ruleFingerprint());
}

function dataQualityHtml(r: AnalysisResult): string {
  const statuses = { complete: '已取完', truncated: '达到上限', partial: '部分结果', unknown: '总量未知', failed: '检索失败', skipped: '未执行' };
  const p = r.provenance;
  const source = p ? `<div class="rpt-sub report-source">
    报告编号：${escapeHtml(p.reportId)}<br/>
    版本：${escapeHtml(p.applicationVersion)} · ${escapeHtml(p.algorithmVersion)}<br/>
    规则：${escapeHtml(p.ruleVersion)} / ${escapeHtml(p.ruleFingerprint)}<br/>
    数据通道：${p.channels.map((c) => CHANNEL_LABEL[c]).join('、')}；坐标 BD-09；住宅小区作为人口代理。<br/>
    设施最早采集：${p.poiCollectedAt ? new Date(p.poiCollectedAt).toLocaleString('zh-CN') : '无可用采集记录'}；
    ${p.poiCacheHits}/${p.poiQueries} 次检索全部命中缓存。路线缓存的原始采集时间暂未记录。
  </div>` : '<div class="rpt-sub">此报告未记录版本与采集来源，请重新体检以建立完整记录。</div>';
  const searches = r.poiSearch ?? [];
  const rows = searches.map((s) => `<tr>
    <td>${escapeHtml(s.keyword)}<br/><span class="rpt-sub">${CHANNEL_LABEL[s.source]}${s.cacheHit ? ' · 缓存' : ''}</span></td>
    <td class="num">${s.fetchedCount} / ${s.reportedTotal ?? '未知'}</td>
    <td><span class="pill ${s.status === 'complete' ? 'ok' : 'mid'}">${statuses[s.status]}</span><br/>
    <span class="rpt-sub">${s.pagesFetched}/${s.pageLimit} 页</span></td>
  </tr>`).join('');
  return `<div class="sec-title">数据完整性与来源</div>
    ${!sameRules(r) ? '<div class="rpt-summary">此项目的算法或规则与当前版本不同，已保留历史结果。请重新体检后继续规划。</div>' : ''}
    ${source}
    <div class="rpt-sub">“已取完”仅表示本次关键词返回结果已取尽，不代表现实设施普查。数量为去重后已取 / 上游原始总数；达到上限时不会继续消耗配额。</div>
    ${searches.length ? `<table class="tbl data-quality"><thead><tr><th>关键词 / 来源</th><th>已取 / 总数</th><th>检索状态</th></tr></thead><tbody>${rows}</tbody></table>` : ''}`;
}

function reportHtml(r: AnalysisResult): string {
  const g = r.score.grade;
  const dim = r.score.dims;
  const cum = r.cumulative;
  const cumBy = cum?.byCategory ?? {};
  const rows = r.score.details
    .map((d) => {
      const inCircle = d.category === 'residential' ? '—' : String(cumBy[d.category] ?? 0);
      const missingTag = d.missingData ? ' <span class="pill mid">数据不完整</span>' : '';
      const foundCount = r.pois.filter((p) => p.category === d.category).length;
      return `<tr>
        <td><span class="dot" style="background:${CATEGORY_MAP[d.category].color}"></span>${escapeHtml(d.name)}${missingTag}</td>
        <td class="num">${foundCount}${d.missingData ? '（已取）' : ''}</td>
        <td class="num">${inCircle}</td>
        <td class="num">${d.nearestM != null ? d.nearestM + 'm' : '—'}</td>
        <td class="num">${d.missingData ? '—' : Math.round(d.completeness * 100) + '%'}</td>
      </tr>`;
    })
    .join('');
  return `
  <div class="rpt-grade">
    <div class="grade-circle" style="background:${gradeColor(g)}"><span>${g}</span><b>${r.score.total}</b></div>
    <div>
      <div class="rpt-title">${escapeHtml(r.centerName || '所选中心点')}</div>
      <div class="rpt-sub">${PERSONA_MAP[r.persona].name} · 步行 ${r.minutes} 分钟 · 速度 ${r.field.speed}m/min<br/>
      ${new Date(r.generatedAt).toLocaleString('zh-CN')}${r.mock ? ' · <span class="mock-flag">演示数据</span>' : ''}</div>
    </div>
  </div>
  <div class="kpi-row">
    <div class="kpi"><b>${Math.round(dim.completeness * 100)}</b><span>完整度</span></div>
    <div class="kpi"><b>${Math.round(dim.proximity * 100)}</b><span>临近度</span></div>
    <div class="kpi"><b>${r.score.coverageUnavailable ? '—' : Math.round((dim.coverage ?? 0) * 100)}</b><span>人口覆盖率${r.score.coverageUnavailable ? '（无法评估）' : ''}</span></div>
  </div>
  ${r.cumulative ? `<div class="rpt-sub" style="margin:-6px 0 10px">累积机会（已取样本口径）：${r.minutes} 分钟步行圈内查得设施 <b>${r.cumulative.total}</b> 处 · 覆盖 <b>${r.cumulative.categoriesCovered}</b>/10 类${r.cumulative.missingCategories.length ? ' · 样本中未查得：' + escapeHtml(r.cumulative.missingCategories.map((c) => CATEGORY_MAP[c as keyof typeof CATEGORY_MAP]?.name ?? c).join('、')) : ''}</div>` : ''}
  ${r.accuracy && r.accuracy.samples > 0 ? `<div class="rpt-sub" style="margin:-6px 0 10px">插值精度核验：抽样 ${r.accuracy.samples} 个算路点${r.mock ? '（当前含演示数据，仅供流程验证）' : ''}，模型估计平均绝对误差 <b>${r.accuracy.maeMinutes} 分钟（${r.accuracy.maePercent}%）</b>，最大偏差 ${r.accuracy.worstPercent}%</div>` : ''}
  ${r.warnings?.length ? `<div class="rpt-summary" style="background:var(--warn-soft)"><span class="sum-label" style="color:var(--warn)">口径与警告</span>${r.warnings.map((w) => escapeHtml(w)).join('；')}</div>` : ''}
  <div class="rpt-summary"><span class="sum-label">诊断</span>${escapeHtml(r.score.summary)}</div>
  ${r.score.missingDataCategories?.length ? `<div class="rpt-sub" style="margin:-8px 0 10px;color:var(--warn)">※ ${escapeHtml(r.score.missingDataCategories.join('、'))}检索失败或不完整，已取数量仅供参考，相关类别未计入评分。</div>` : ''}
  ${dataQualityHtml(r)}
  <div class="sec-title">四维体检（雷达）</div>
  <div id="chart-radar" class="chart-box"></div>
  <div class="sec-title">设施完整度（柱状：实际 vs 理想）</div>
  <div id="chart-bar" class="chart-box"></div>
  <div class="sec-title">分类明细</div>
  <div class="rpt-sub" style="margin-bottom:4px">口径说明：「数量」为 2km 半径检索所得（周边统计）；「圈内可达」为步行 ${r.minutes} 分钟内真实可抵（时间场判定）；「1km 盲区」为评分细则口径（直线）。</div>
  <table class="tbl">
    <thead><tr><th>类别</th><th>数量</th><th>圈内可达</th><th>最近</th><th>完整度</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="sec-title">过街便利度</div>
  ${
    r.crossings
      ? `<div class="rpt-sub">扫描 ${r.crossings.scanned} 条步行路段：过街天桥 ${r.crossings.overpass} 处 · 地下通道 ${r.crossings.underpass} 处 · 平面过街提示 ${r.crossings.crosswalkHint} 处。<br/>过街设施影响老年人等人群的实际步行可达性，已纳入速度折减。</div>`
      : '<div class="rpt-sub">未启用过街设施扫描。</div>'
  }
  `;
}

function checklistHtml(r: AnalysisResult): string {
  const rows = r.checklist
    .map((c) => {
      const verdict =
        c.met === null
          ? '<span class="pill mid">无法判断</span>'
          : c.met
            ? '<span class="pill ok">达标</span>'
            : '<span class="pill bad">缺失</span>';
      return `<tr>
      <td>${escapeHtml(c.name)}<br/><span style="color:var(--ink-2);font-size:11px">${escapeHtml(c.basis)}</span></td>
      <td class="num">≤${c.thresholdM}m</td>
      <td class="num">${c.nearestM != null ? c.nearestM + 'm' : '—'}</td>
      <td>${verdict}</td>
    </tr>`;
    })
    .join('');
  const judged = r.checklist.filter((c) => c.met !== null);
  const metCount = judged.filter((c) => c.met).length;
  const unknownCount = r.checklist.length - judged.length;
  return `
  <div class="rpt-summary">
    「完整社区」对标清单：${metCount}/${judged.length} 项达标${unknownCount ? `，另有 ${unknownCount} 项因检索失败无法判断` : ''}。
    阈值参考《完整居住社区建设标准（试行）》《社区生活圈规划技术指南》通行口径取整，为可配置参考基线。
  </div>
  <table class="tbl">
    <thead><tr><th>设施项</th><th>阈值</th><th>实测最近</th><th>判定</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function gapsHtml(r: AnalysisResult): string {
  const g = r.gap;
  const covText =
    g.coverageShare == null
      ? '无法评估<span style="font-size:10px">（无居住采样）</span>'
      : `${Math.round(g.coverageShare * 100)}%`;
  const head = `
  <div class="kpi-row">
    <div class="kpi"><b>${g.blindPoints}</b><span>盲区点位(格)</span></div>
    <div class="kpi"><b>${g.patches.length}</b><span>灰色斑块</span></div>
    <div class="kpi"><b>${g.coverageShare == null ? '—' : Math.round(g.coverageShare * 100) + '%'}</b><span>居住权重全覆盖</span></div>
  </div>
  ${g.coverageShare == null ? '<div class="rpt-sub" style="color:var(--warn);margin-bottom:10px">住宅样本缺失或核心类别数据不完整，三件套全覆盖率无法评估。请查看报告的数据完整性记录。</div>' : ''}
  <div class="rpt-sub" style="margin-bottom:10px">
    盲区点位 = 步行时间圈内缺失任一核心设施（菜市场/药店/小学，1km 口径）的网格；
    缺 ≥2 项的连通区域聚合为灰色斑块，按住宅小区密度（人口代理）加权排序。
  </div>`;
  if (!g.patches.length) {
    return head + `<div class="empty-tip">${r.incomplete ? '检索数据不完整，当前没有可确认的灰色区域；不能据此判断覆盖良好。' : '步行圈内未发现灰色区域，请结合住宅样本与数据口径查看。'}</div>`;
  }
  const rows = g.patches
    .map(
      (p) => `<tr>
      <td>#${p.id} ${p.severity === 'severe' ? '<span class="pill bad">重度</span>' : '<span class="pill mid">中度</span>'}</td>
      <td>${p.missingCats.map((c) => CATEGORY_MAP[c].name).join('、')}</td>
      <td class="num">${(p.weightShare * 100).toFixed(0)}%</td>
      <td class="num">${p.maxNearestM > 0 ? Math.round(p.maxNearestM) + 'm' : '无'}</td>
      <td><button class="btn ghost plan-loc" data-fly="${p.centroid.lat},${p.centroid.lng}">定位</button></td>
    </tr>`
    )
    .join('');
  return `${head}
  <table class="tbl">
    <thead><tr><th>斑块</th><th>缺失</th><th>居住权重</th><th>最远距离</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function planHtml(r: AnalysisResult): string {
  if (!sameRules(r)) return '<div class="rpt-summary">此项目的算法或规则与当前版本不同。历史结果仍可查看和导出；请重新体检后继续规划。</div>';
  const head = `
  <div class="rpt-summary">
    <span class="sum-label">工作台</span>规划引擎基于贪心最大覆盖给出补点建议。<b>采纳</b>一条建议后，
    其服务盘即刻写入覆盖状态并重新求解剩余建议；<b>跳过</b>则不再在该位置 400m 内重复推荐。
  </div>`;
  if (!r.planSites.length && !acceptedSites.length) {
    return head + `<div class="empty-tip">${r.incomplete ? '检索数据不完整，当前没有可可靠推荐的补点；请核验数据后再规划。' : '当前暂无补点建议，请结合覆盖率与住宅样本判断。'}</div>`;
  }
  const parts: string[] = [head];
  if (acceptedSites.length) {
    parts.push('<div class="sec-title">已采纳方案</div>');
    for (const s of acceptedSites) {
      parts.push(`
      <div class="plan-card accepted">
        <h4><span class="rank">✓</span> 补建「${CATEGORY_MAP[s.category].name}」<span class="gain-chip">已纳入覆盖模拟</span></h4>
        <div class="plan-meta"><span>坐标 ${s.latLng.lat.toFixed(5)}, ${s.latLng.lng.toFixed(5)}</span></div>
        <div class="plan-loc">
          <button class="btn ghost" data-fly="${s.latLng.lat},${s.latLng.lng}">定位</button>
          <button class="btn ghost" data-act="undo-accept" data-id="${siteId(s)}">撤销</button>
        </div>
      </div>`);
    }
  }
  if (rejectedSites.length) {
    parts.push('<div class="sec-title">已跳过</div>');
    for (const s of rejectedSites) {
      parts.push(`
      <div class="plan-card skipped">
        <h4><span class="rank" style="background:#8a93a6">–</span> ${CATEGORY_MAP[s.category].name}（${s.latLng.lat.toFixed(4)}, ${s.latLng.lng.toFixed(4)}）</h4>
        <div class="plan-loc"><button class="btn ghost" data-act="undo-reject" data-id="${siteId(s)}">恢复推荐</button></div>
      </div>`);
    }
  }
  const sites = currentSites(r);
  parts.push(`<div class="sec-title">当前建议（${sites.length}）</div>`);
  if (!sites.length) {
    parts.push('<div class="empty-tip">已无进一步补点建议：或覆盖率良好，或剩余缺口不在可推荐范围。</div>');
  }
  for (const s of sites) {
    parts.push(`
    <div class="plan-card">
      <h4><span class="rank">${s.rank}</span> 建议补建「${CATEGORY_MAP[s.category].name}」<span class="gain-chip">+${Math.round((s.afterPct - s.beforePct) * 10) / 10}pp</span></h4>
      <div>${escapeHtml(s.rationale)}</div>
      <div class="plan-meta">
        <span>坐标 ${s.latLng.lat.toFixed(5)}, ${s.latLng.lng.toFixed(5)}</span>
        <span>服务盘折算 ≈ ${s.estWalkMin} 分钟步行</span>
      </div>
      <div class="plan-loc">
        <button class="btn ghost" data-fly="${s.latLng.lat},${s.latLng.lng}">定位</button>
        <button class="btn ghost" data-act="accept" data-id="${siteId(s)}">采纳</button>
        <button class="btn ghost" data-act="reject" data-id="${siteId(s)}">跳过</button>
      </div>
    </div>`);
  }
  return parts.join('');
}

function siteId(s: PlanSite): string {
  return `${s.category}-${s.latLng.lat.toFixed(5)}-${s.latLng.lng.toFixed(5)}`;
}

/** 依据已采纳/已跳过状态重算当前建议 */
function currentSites(r: AnalysisResult): PlanSite[] {
  if (!sameRules(r)) return [];
  const cov: Record<string, Uint8Array> = {};
  for (const k of Object.keys(r.gap.coveredMasks)) cov[k] = Uint8Array.from(r.gap.coveredMasks[k]);
  for (const s of acceptedSites) applySiteCoverage(cov, s.category, s.latLng, r.field);
  const sites = planFacilitiesFromCoverage(
    r.gap,
    cov,
    r.field,
    PERSONA_MAP[r.persona].speed,
    {
      topK: THRESHOLDS.planTopK + rejectedSites.length,
      unknownCategories: r.assessmentUnavailableCategories ?? r.failedCategories ?? []
    }
  );
  return sites.filter((s) =>
    rejectedSites.every((rj) => localDistM(s.latLng.lat, s.latLng.lng, rj.latLng.lat, rj.latLng.lng) > 400)
  );
}

function wirePlanActions() {
  const body = document.getElementById('panel-body')!;
  const refresh = () => {
    if (currentResult && map.ready) {
      map.setPlanSites([...acceptedSites, ...currentSites(currentResult)]);
    }
    render();
    workbenchListener?.();
  };
  body.querySelectorAll('[data-act]').forEach((el) => {
    el.addEventListener('click', () => {
      if (!currentResult) return;
      const act = (el as HTMLElement).dataset.act;
      const id = (el as HTMLElement).dataset.id;
      const take = (arr: PlanSite[]) => arr.find((s) => siteId(s) === id);
      const suggestions = currentSites(currentResult);
      if (act === 'accept') {
        const s = take(suggestions);
        if (s) { acceptedSites.push(s); refresh(); }
      } else if (act === 'reject') {
        const s = take(suggestions);
        if (s) { rejectedSites.push(s); refresh(); }
      } else if (act === 'undo-accept') {
        acceptedSites = acceptedSites.filter((s) => siteId(s) !== id);
        refresh();
      } else if (act === 'undo-reject') {
        rejectedSites = rejectedSites.filter((s) => siteId(s) !== id);
        refresh();
      }
    });
  });
}

function compareHtml(r: AnalysisResult): string {
  const editable = sameRules(r);
  return `<div class="rpt-summary"><span class="sum-label">方案对比</span>先在「规划建议」采纳补点，再把当前选择记录为 A 或 B。两套方案共用本次体检基线，记录后可继续调整；跳过的点不计入收益。</div>
    <p class="rpt-sub">${escapeHtml(r.centerName)} · ${PERSONA_MAP[r.persona].name} · ${r.minutes} 分钟<br>当前已采纳 ${acceptedSites.length} 处，已跳过 ${rejectedSites.length} 处。</p>
    ${!editable ? '<p class="rpt-summary">此项目使用历史规则，方案只可查看。请重新体检后继续规划。</p>' : ''}
    <div class="comparison-actions">${(['A', 'B'] as const).map(k => `<div class="plan-card"><b>方案 ${k}</b><p class="rpt-sub">${scenarios[k] ? `已记录 ${scenarios[k]!.acceptedSites.length} 处补点<br>${escapeHtml(new Date(scenarios[k]!.savedAt).toLocaleString('zh-CN'))}` : '尚未记录'}</p>
      <button class="btn ghost" data-scenario-save="${k}" ${editable ? '' : 'disabled'}>${scenarios[k] ? '更新' : '记录'}为 ${k}</button>
      <button class="btn ghost" data-scenario-load="${k}" ${editable && scenarios[k] ? '' : 'disabled'}>载入 ${k}</button></div>`).join('')}</div>
    <div class="comparison-tools"><button class="btn ghost" id="compare-plan">去调整补点</button><button class="btn ghost" id="compare-reset" ${editable ? '' : 'disabled'}>清空当前选择</button></div>
    <p class="rpt-sub">清空或载入只改变当前工作台，已记录的 A / B 保留；覆盖记录前会提醒确认。</p>
    ${comparisonTable(r, scenarios)}
    <div class="rpt-sub">全覆盖：菜市场、药店、小学三类服务齐全的住宅代理权重占比。新增覆盖相对现状计算，重叠服务范围去重。剩余薄弱住宅格只统计有住宅权重的格点。${THRESHOLDS.coreRadiusM} 米直线半径模拟，非真实人口数；现状总分不随补点重算。数据不完整时不提供改善结论。</div>`;
}
function wireComparison() {
  const refresh = () => { if (currentResult && map.ready) map.setPlanSites(displayedPlanSites()); render(); workbenchListener?.(); };
  document.getElementById('compare-plan')?.addEventListener('click', () => switchTab('plan'));
  document.getElementById('compare-reset')?.addEventListener('click', () => {
    if (!currentResult || !sameRules(currentResult)) return;
    if ((acceptedSites.length || rejectedSites.length) && !window.confirm('清空当前工作台的采纳和跳过选择？已记录的 A / B 会保留。')) return;
    acceptedSites = []; rejectedSites = []; refresh();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-scenario-save]').forEach(button => button.addEventListener('click', () => {
    if (!currentResult || !sameRules(currentResult)) return;
    const slot = button.dataset.scenarioSave as 'A' | 'B';
    if (scenarios[slot] && !window.confirm(`用当前选择覆盖已记录的方案 ${slot}？`)) return;
    scenarios[slot] = captureScenario(currentResult, { acceptedSites, rejectedSites }); refresh();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-scenario-load]').forEach(button => button.addEventListener('click', () => {
    if (!currentResult || !sameRules(currentResult)) return;
    const saved = scenarios[button.dataset.scenarioLoad as 'A' | 'B'];
    if (!saved || saved.baselineKey !== comparisonBaseline(currentResult)) { banner('方案基线不同，无法载入。', 'warn'); return; }
    if ((acceptedSites.length || rejectedSites.length) && !window.confirm('载入此方案将替换当前工作台选择；尚未记录的调整将丢失。是否继续？')) return;
    acceptedSites = structuredClone(saved.acceptedSites); rejectedSites = structuredClone(saved.rejectedSites); refresh();
  }));
}

function logHtml(r: AnalysisResult): string {
  const lines = r.steps
    .map(
      (s) =>
        `<div class="log-line"><b>${escapeHtml(s.name)}</b> — 通道 ${CHANNEL_LABEL[s.usage.channel]} · ${s.usage.ms}ms${s.usage.cacheHit ? ' · 缓存命中' : ''}${s.usage.note ? ' · ' + escapeHtml(s.usage.note) : ''}</div>`
    )
    .join('');
  const mock = r.mock ? '<div class="log-line log-warn">当前处于演示数据模式（未配置 AK 或上游全部熔断）</div>' : '';
  return `${mock}${lines}`;
}

// ---------- 街道级批量体检 ----------

function streetHtml(): string {
  return `
  <div class="rpt-summary"><span class="sum-label">街道体检</span>
    输入街道 / 片区地址，系统检索片区内住宅小区作为采样点，逐个完整体检后给出街道排名。
    任务在服务端串行执行，首次约 1-3 分钟（受上游限流），结果服务端缓存。
  </div>
  <div class="plan-card">
    <label class="lbl" for="street-addr">街道 / 片区 / 城区地址</label>
    <input id="street-addr" style="width:100%;height:32px;margin:6px 0;border:1px solid var(--line-2);border-radius:8px;padding:0 10px;font-size:13px" placeholder="如：上饶市信州区东市街道 / 上饶市信州区" />
    <div style="display:flex;gap:8px;align-items:center;margin-top:4px;flex-wrap:wrap">
      <label class="lbl">范围</label>
      <select id="street-scope" style="height:30px">
        <option value="street" selected>街道体检</option>
        <option value="district">城区试点</option>
      </select>
      <label class="lbl">采样半径</label>
      <select id="street-radius" style="height:30px">
        <option value="1500">1.5 km</option>
        <option value="2500" selected>2.5 km</option>
        <option value="3000">3 km</option>
        <option value="5000">5 km</option>
        <option value="6500">6.5 km</option>
      </select>
      <label class="lbl">采样点上限</label>
      <select id="street-max" style="height:30px">
        <option value="6">6</option>
        <option value="10" selected>10</option>
        <option value="16">16</option>
        <option value="24">24</option>
      </select>
      <button id="btn-street-start" class="btn primary" style="margin-left:auto">开始</button>
    </div>
    <div class="rpt-sub" id="street-scope-note" style="margin-top:6px">街道体检：半径 ≤3km、≤16 个采样点。切到「城区试点」可扩大到 8km / 30 点，结果将按街道分组排名（约 3-6 分钟，企业配额）。</div>
  </div>
  <div id="street-status"></div>
  <div id="street-usage" class="rpt-sub" style="margin-top:8px"></div>`;
}

function wireStreet() {
  const scopeSel = document.getElementById('street-scope') as HTMLSelectElement | null;
  scopeSel?.addEventListener('change', () => {
    const d = scopeSel.value === 'district';
    const radius = document.getElementById('street-radius') as HTMLSelectElement | null;
    const max = document.getElementById('street-max') as HTMLSelectElement | null;
    if (radius) radius.value = d ? '5000' : '2500';
    if (max) max.value = d ? '16' : '10';
    const note = document.getElementById('street-scope-note');
    if (note) {
      note.textContent = d
        ? '城区试点：半径可至 8km、最多 30 个采样点，结果将按街道分组排名（约 3-6 分钟，企业配额）。'
        : '街道体检：半径 ≤3km、≤16 个采样点。切到「城区试点」可扩大到 8km / 30 点，结果将按街道分组排名。';
    }
  });
  const btn = document.getElementById('btn-street-start');
  btn?.addEventListener('click', async () => {
    if (btn.classList.contains('btn-busy')) return;
    const addr = (document.getElementById('street-addr') as HTMLInputElement)?.value.trim();
    if (!addr) { banner('请先输入街道 / 片区地址', 'warn'); return; }
    const scope = (document.getElementById('street-scope') as HTMLSelectElement)?.value ?? 'street';
    btn.classList.add('btn-busy');
    btn.textContent = '提交中…';
    try {
      const res = await fetch('/api/batch/street', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: addr,
          scope,
          radiusM: Number((document.getElementById('street-radius') as HTMLSelectElement).value),
          maxCommunities: Number((document.getElementById('street-max') as HTMLSelectElement).value)
        })
      });
      const data = await res.json();
      if (data.status !== 0 || !data.jobId) {
        banner(`任务发起失败：${data.message ?? '未知错误'}`);
        return;
      }
      streetJobId = data.jobId;
      streetLastSnapshot = { status: 'running', done: 0, total: data.total ?? 0, current: '排队中…', communities: [], summary: null };
      startPolling();
    } catch (e) {
      banner(`任务发起失败：${(e as Error).message}`);
    } finally {
      btn.classList.remove('btn-busy');
      btn.textContent = '开始';
    }
  });
  if (streetJobId && streetLastSnapshot?.status === 'running' && !streetPollTimer) startPolling();
  updateStreetStatus();
}

/** №13 调用预算面板：本地进程计数（非平台账户余额），预算与命中一目了然 */
async function refreshUsageLine() {
  const el = document.getElementById('street-usage');
  if (!el) return;
  try {
    const res = await fetch('/api/usage');
    const data = await res.json();
    const u = data.usage;
    if (!u) return;
    const budget = u.dailyBudget > 0 ? `${u.requests.total}/${u.dailyBudget}` : `${u.requests.total}（未设上限）`;
    el.textContent = `今日上游请求 ${budget}（检索 ${u.requests.place} · 算路 ${u.requests.route} · 编码 ${u.requests.geo}）· 缓存命中 ${u.cacheHits} · 本地进程计数，非平台账户余额${u.overBudget ? ' · 已触顶暂停' : ''}`;
  } catch { /* 演示模式/离线环境无此端点 */ }
}

function startPolling() {
  if (streetPollTimer) clearInterval(streetPollTimer);
  streetPollTimer = setInterval(async () => {
    if (!streetJobId) return;
    try {
      const res = await fetch(`/api/batch/status/${streetJobId}`);
      const data = await res.json();
      if (data.status !== 0) return;
      void refreshUsageLine();
      streetLastSnapshot = {
        status: data.job.status,
        done: data.job.done,
        total: data.job.total,
        current: data.job.current,
        communities: data.job.communities ?? [],
        summary: data.job.summary,
        error: data.job.error
      };
      updateStreetStatus();
      if (data.job.status !== 'running' && streetPollTimer) {
        clearInterval(streetPollTimer);
        streetPollTimer = null;
        if (data.job.status === 'done' && map.ready && data.job.communities?.length) {
          map.setBatchResults(data.job.communities);
          const last = data.job.communities[data.job.communities.length - 1];
          map.flyTo({ lat: last.center.lat, lng: last.center.lng }, 13);
        }
      }
    } catch {
      /* 轮询失败下轮重试 */
    }
  }, 3000);
}

function updateStreetStatus() {
  const el = document.getElementById('street-status');
  if (!el) return;
  const s = streetLastSnapshot;
  if (!streetJobId || !s) {
    el.innerHTML = '<div class="empty-tip">发起任务后，这里显示进度与街道排名</div>';
    return;
  }
  if (s.status === 'running') {
    el.innerHTML = `
    <div class="rpt-summary"><span class="sum-label">进行中</span>${s.done}/${s.total} 完成 · 当前：${escapeHtml(s.current)}
    <button id="btn-street-cancel" class="btn ghost" style="margin-left:8px;height:26px;padding:0 10px;font-size:12px">取消任务</button></div>
    ${s.communities.length ? communityTable(s.communities) : ''}`;
    el.querySelector('#btn-street-cancel')?.addEventListener('click', async () => {
      if (!streetJobId) return;
      try {
        await fetch(`/api/batch/cancel/${streetJobId}`, { method: 'POST' });
      } catch { /* 轮询会反映最终状态 */ }
    });
    return;
  }
  if (s.status === 'cancelled') {
    el.innerHTML = `<div class="rpt-summary"><span class="sum-label" style="color:var(--warn)">已取消</span>任务已停止，已完成的 ${s.done} 个小区结果保留。</div>${communityTable(s.communities)}`;
    return;
  }
  if (s.status === 'error') {
    // 预算触顶/失败也保留已完成社区结果（可见、可导出），错误文本说明原因
    el.innerHTML = `<div class="rpt-summary"><span class="sum-label" style="color:var(--bad)">失败</span>${escapeHtml(s.error ?? '未知错误')}</div>${s.communities?.length ? communityTable(s.communities) : ''}`;
    return;
  }
  const sum = s.summary ?? {};
  const dist = Object.entries(sum.gradeDist ?? {})
    .map(([g, n]) => `${g} 级 ×${n}`)
    .join(' · ');
  const weakRows = (sum.weakList ?? [])
    .map((w: any) => {
      const covText = w.coverageShare == null ? '无法评估' : Math.round(w.coverageShare * 100) + '%';
      return `<tr><td>${escapeHtml(shortName(w.name))}</td><td class="num">${w.score}</td><td class="num">${covText}</td><td>${w.dominantMissing ? CATEGORY_MAP[w.dominantMissing as keyof typeof CATEGORY_MAP]?.name ?? w.dominantMissing : '—'}</td></tr>`;
    })
    .join('');
  el.innerHTML = `
  <div class="kpi-row">
    <div class="kpi"><b>${sum.avgScore ?? '—'}</b><span>街道均分</span></div>
    <div class="kpi"><b>${s.total}</b><span>采样小区</span></div>
    <div class="kpi"><b>${sum.scoreGap ?? 0}</b><span>最优最差极差</span></div>
  </div>
  <div class="rpt-summary"><span class="sum-label">汇总</span>等级分布：${escapeHtml(dist || '—')}；
  ${sum.best ? `最优 <b>${escapeHtml(shortName(sum.best.name))}（${sum.best.score}）</b>` : ''}
  ${sum.worst ? `、最差 <b>${escapeHtml(shortName(sum.worst.name))}（${sum.worst.score}）</b>` : ''}。
  地图上已按等级着色标注各小区。</div>
  ${(sum.weakList ?? []).length ? `<div class="sec-title">公平性视角 · 薄弱小区清单</div>
  <table class="tbl"><thead><tr><th>小区</th><th>评分</th><th>覆盖率</th><th>主要缺失</th></tr></thead><tbody>${weakRows}</tbody></table>
  <div class="rpt-sub">公平性口径：评分 &lt; 75 或人口覆盖率 &lt; 80% 判定为薄弱小区——资源应优先向这些片区倾斜。</div>` : ''}
  ${(s.summary?.streetGroups ?? []).length ? `<div class="sec-title">城区试点 · 街道分组排名</div>
  <table class="tbl"><thead><tr><th>街道</th><th>小区数</th><th>均分</th><th>薄弱</th><th>最优</th><th>最差</th></tr></thead>
  <tbody>${(s.summary?.streetGroups ?? []).map((g: any) => `<tr>
    <td>${escapeHtml(g.street)}</td><td class="num">${g.count}</td><td class="num"><b>${g.avgScore}</b></td>
    <td class="num">${g.weakCount || '—'}</td>
    <td class="num">${g.bestScore}　</td><td class="num">${g.worstScore}</td></tr>`).join('')}</tbody></table>` : ''}
  ${communityTable(s.communities.filter((c: any) => c.score >= 0))}
  <button id="btn-weak-csv" class="btn ghost">导出薄弱社区 CSV</button>
  <div class="rpt-sub">说明：排名为<b>片区抽样口径</b>（采样半径内住宅小区），非行政街道全域普查；小区评分未覆盖时显示「-」；重复发起任务会命中服务端缓存，速度快得多。</div>`;
  document.getElementById('btn-weak-csv')?.addEventListener('click', () => {
    try { if (streetJobId) downloadText(weakCommunityCsv(s.communities, streetJobId), '圈点-薄弱社区.csv', 'text/csv;charset=utf-8'); }
    catch { banner('薄弱社区表导出失败，任务结果已保留，请重试。', 'warn'); }
  });
}

function communityTable(communities: (StreetCommunity & { coverageUnavailable?: boolean })[]): string {
  const sorted = [...communities].sort((a, b) => b.score - a.score);
  const rows = sorted
    .map((c) => {
      const covText = c.coverageUnavailable || c.coverageShare == null ? '无法评估' : Math.round(c.coverageShare * 100) + '%';
      return `<tr>
      <td>${escapeHtml(shortName(c.name))}</td>
      <td class="num">${c.score >= 0 ? c.score : '—'}</td>
      <td>${c.grade === '-' ? '—' : `<span class="pill ${c.grade === 'A' || c.grade === 'B' ? 'ok' : c.grade === 'C' ? 'mid' : 'bad'}">${c.grade}</span>`}</td>
      <td class="num">${covText}</td>
      <td>${c.dominantMissing ? CATEGORY_MAP[c.dominantMissing as keyof typeof CATEGORY_MAP]?.name ?? c.dominantMissing : '—'}</td>
      <td><button class="btn ghost plan-loc" data-fly="${c.center.lat},${c.center.lng}">定位</button></td>
    </tr>`;
    })
    .join('');
  return `<table class="tbl">
    <thead><tr><th>小区</th><th>评分</th><th>等级</th><th>覆盖率</th><th>主要缺失</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function shortName(name: string): string {
  return name.replace(/^江西省上饶市信州区/, '').replace(/^上饶市信州区/, '');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export type { GapPatch, PlanSite };
