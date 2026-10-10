import { CATEGORY_MAP, PERSONA_MAP, THRESHOLDS } from '../shared/config.js';
import { applySiteCoverage, planFacilitiesFromCoverage } from '../shared/planner.js';
import { localDistM } from '../shared/geo.js';
import type { AnalysisResult, GapPatch, LatLng, PlanSite } from '../shared/types.js';
import { renderCharts } from './charts.js';
import { banner, CHANNEL_LABEL } from './hud.js';
import { map } from './main.js';

/** 右侧报告面板：体检报告 / 国标清单 / 灰色区域 / 规划建议 / 街道体检 / 运行日志 */

let currentResult: AnalysisResult | null = null;
let currentTab = 'report';

// ---- 交互式规划工作台状态（新分析时重置）----
let acceptedSites: PlanSite[] = [];
let rejectedSites: PlanSite[] = [];

// ---- 街道批量体检状态 ----
interface StreetCommunity {
  name: string;
  center: LatLng;
  score: number;
  grade: string;
  coverageShare: number;
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
  }
  currentResult = r;
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
  footer.classList.toggle('hidden', currentTab !== 'report' || !currentResult);
  const r = currentResult;
  switch (currentTab) {
    case 'report':
      if (!r) { body.innerHTML = '<div class="empty-tip">先完成一次体检</div>'; break; }
      body.innerHTML = reportHtml(r); animateGrade(r.score.total); renderCharts(r);
      break;
    case 'checklist': if (r) body.innerHTML = checklistHtml(r); break;
    case 'gaps': if (r) body.innerHTML = gapsHtml(r); break;
    case 'plan': body.innerHTML = r ? planHtml(r) : '<div class="empty-tip">先完成一次体检</div>'; wirePlanActions(); break;
    case 'street': body.innerHTML = streetHtml(); wireStreet(); break;
    case 'log': if (r) body.innerHTML = logHtml(r); break;
  }
  body.querySelectorAll('[data-fly]').forEach((el) => {
    el.addEventListener('click', () => {
      const [lat, lng] = ((el as HTMLElement).dataset.fly ?? '0,0').split(',').map(Number);
      map.flyTo({ lat, lng });
    });
  });
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

function reportHtml(r: AnalysisResult): string {
  const g = r.score.grade;
  const dim = r.score.dims;
  const rows = r.score.details
    .map(
      (d) => `<tr>
        <td><span class="dot" style="background:${CATEGORY_MAP[d.category].color}"></span>${d.name}</td>
        <td class="num">${d.count}</td>
        <td class="num">${d.nearestM != null ? d.nearestM + 'm' : '—'}</td>
        <td class="num">${Math.round(d.completeness * 100)}%</td>
      </tr>`
    )
    .join('');
  return `
  <div class="rpt-grade">
    <div class="grade-circle" style="background:${gradeColor(g)}"><span>${g}</span><b>${r.score.total}</b></div>
    <div>
      <div class="rpt-title">${escapeHtml(r.centerName || '所选中心点')}</div>
      <div class="rpt-sub">${PERSONA_MAP[r.persona].name} · 步行 ${r.minutes} 分钟 · 速度 ${PERSONA_MAP[r.persona].speed}m/min<br/>
      ${new Date(r.generatedAt).toLocaleString('zh-CN')}${r.mock ? ' · <span class="mock-flag">演示数据</span>' : ''}</div>
    </div>
  </div>
  <div class="kpi-row">
    <div class="kpi"><b>${Math.round(dim.completeness * 100)}</b><span>完整度</span></div>
    <div class="kpi"><b>${Math.round(dim.proximity * 100)}</b><span>临近度</span></div>
    <div class="kpi"><b>${Math.round(dim.coverage * 100)}</b><span>人口覆盖率</span></div>
  </div>
  <div class="rpt-summary"><span class="sum-label">诊断</span>${escapeHtml(r.score.summary)}</div>
  <div class="sec-title">四维体检（雷达）</div>
  <div id="chart-radar" class="chart-box"></div>
  <div class="sec-title">设施完整度（柱状：实际 vs 理想）</div>
  <div id="chart-bar" class="chart-box"></div>
  <div class="sec-title">分类明细</div>
  <table class="tbl">
    <thead><tr><th>类别</th><th>数量</th><th>最近</th><th>完整度</th></tr></thead>
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
    .map(
      (c) => `<tr>
      <td>${escapeHtml(c.name)}<br/><span style="color:var(--ink-2);font-size:11px">${escapeHtml(c.basis)}</span></td>
      <td class="num">≤${c.thresholdM}m</td>
      <td class="num">${c.nearestM != null ? c.nearestM + 'm' : '—'}</td>
      <td>${c.met ? '<span class="pill ok">达标</span>' : '<span class="pill bad">缺失</span>'}</td>
    </tr>`
    )
    .join('');
  const metCount = r.checklist.filter((c) => c.met).length;
  return `
  <div class="rpt-summary">
    「完整社区」对标清单：${metCount}/${r.checklist.length} 项达标。
    阈值参考《完整居住社区建设标准（试行）》《社区生活圈规划技术指南》通行口径取整，为可配置参考基线。
  </div>
  <table class="tbl">
    <thead><tr><th>设施项</th><th>阈值</th><th>实测最近</th><th>判定</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function gapsHtml(r: AnalysisResult): string {
  const g = r.gap;
  const head = `
  <div class="kpi-row">
    <div class="kpi"><b>${g.blindPoints}</b><span>盲区点位(格)</span></div>
    <div class="kpi"><b>${g.patches.length}</b><span>灰色斑块</span></div>
    <div class="kpi"><b>${Math.round((1 - g.coverageShare) * 100)}%</b><span>居住权重未全覆盖</span></div>
  </div>
  <div class="rpt-sub" style="margin-bottom:10px">
    盲区点位 = 步行时间圈内缺失任一核心设施（菜市场/药店/小学，1km 口径）的网格；
    缺 ≥2 项的连通区域聚合为灰色斑块，按住宅小区密度（人口代理）加权排序。
  </div>`;
  if (!g.patches.length) {
    return head + '<div class="empty-tip">步行圈内核心设施覆盖良好，未发现灰色区域。</div>';
  }
  const rows = g.patches
    .map(
      (p) => `<tr>
      <td>#${p.id} ${p.severity === 'severe' ? '<span class="pill bad">重度</span>' : '<span class="pill mid">中度</span>'}</td>
      <td>${p.missingCats.map((c) => CATEGORY_MAP[c].name).join('、')}</td>
      <td class="num">${(p.weightShare * 100).toFixed(0)}%</td>
      <td class="num">${p.maxNearestM > 0 ? p.maxNearestM + 'm' : '无'}</td>
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
  const head = `
  <div class="rpt-summary">
    <span class="sum-label">工作台</span>规划引擎基于贪心最大覆盖给出补点建议。<b>采纳</b>一条建议后，
    其服务盘即刻写入覆盖状态并重新求解剩余建议；<b>跳过</b>则不再在该位置 400m 内重复推荐。
  </div>`;
  if (!r.planSites.length && !acceptedSites.length) {
    return head + '<div class="empty-tip">当前覆盖率良好，暂无补点建议。</div>';
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
  const cov: Record<string, Uint8Array> = {};
  for (const k of Object.keys(r.gap.coveredMasks)) cov[k] = Uint8Array.from(r.gap.coveredMasks[k]);
  for (const s of acceptedSites) applySiteCoverage(cov, s.category, s.latLng, r.field);
  const sites = planFacilitiesFromCoverage(
    r.gap,
    cov,
    r.field,
    PERSONA_MAP[r.persona].speed,
    { topK: THRESHOLDS.planTopK + rejectedSites.length }
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
    <label class="lbl" for="street-addr">街道 / 片区地址</label>
    <input id="street-addr" style="width:100%;height:32px;margin:6px 0;border:1px solid var(--line-2);border-radius:8px;padding:0 10px;font-size:13px" placeholder="如：上饶市信州区东市街道" />
    <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
      <label class="lbl">采样半径</label>
      <select id="street-radius" style="height:30px">
        <option value="1500">1.5 km</option>
        <option value="2500" selected>2.5 km</option>
        <option value="3000">3 km</option>
      </select>
      <label class="lbl">采样点上限</label>
      <select id="street-max" style="height:30px">
        <option value="6">6</option>
        <option value="10" selected>10</option>
        <option value="14">14</option>
      </select>
      <button id="btn-street-start" class="btn primary" style="margin-left:auto">开始</button>
    </div>
  </div>
  <div id="street-status"></div>`;
}

function wireStreet() {
  const btn = document.getElementById('btn-street-start');
  btn?.addEventListener('click', async () => {
    if (btn.classList.contains('btn-busy')) return;
    const addr = (document.getElementById('street-addr') as HTMLInputElement)?.value.trim();
    if (!addr) { banner('请先输入街道 / 片区地址', 'warn'); return; }
    btn.classList.add('btn-busy');
    btn.textContent = '提交中…';
    try {
      const res = await fetch('/api/batch/street', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: addr,
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

function startPolling() {
  if (streetPollTimer) clearInterval(streetPollTimer);
  streetPollTimer = setInterval(async () => {
    if (!streetJobId) return;
    try {
      const res = await fetch(`/api/batch/status/${streetJobId}`);
      const data = await res.json();
      if (data.status !== 0) return;
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
    <div class="rpt-summary"><span class="sum-label">进行中</span>${s.done}/${s.total} 完成 · 当前：${escapeHtml(s.current)}</div>
    ${s.communities.length ? communityTable(s.communities) : ''}`;
    return;
  }
  if (s.status === 'error') {
    el.innerHTML = `<div class="rpt-summary"><span class="sum-label" style="color:var(--bad)">失败</span>${escapeHtml(s.error ?? '未知错误')}</div>`;
    return;
  }
  const sum = s.summary ?? {};
  const dist = Object.entries(sum.gradeDist ?? {})
    .map(([g, n]) => `${g} 级 ×${n}`)
    .join(' · ');
  el.innerHTML = `
  <div class="kpi-row">
    <div class="kpi"><b>${sum.avgScore ?? '—'}</b><span>街道均分</span></div>
    <div class="kpi"><b>${s.total}</b><span>采样小区</span></div>
    <div class="kpi"><b>${s.communities.filter((c) => c.score >= 0).length}</b><span>有效样本</span></div>
  </div>
  <div class="rpt-summary"><span class="sum-label">汇总</span>等级分布：${escapeHtml(dist || '—')}；
  ${sum.best ? `最优 <b>${escapeHtml(shortName(sum.best.name))}（${sum.best.score}）</b>` : ''}
  ${sum.worst ? `、最差 <b>${escapeHtml(shortName(sum.worst.name))}（${sum.worst.score}）</b>` : ''}。
  地图上已按等级着色标注各小区。</div>
  ${communityTable(s.communities)}
  <div class="rpt-sub">说明：小区评分未覆盖时显示「-」；重复发起任务会命中服务端缓存，速度快得多。</div>`;
}

function communityTable(communities: StreetCommunity[]): string {
  const sorted = [...communities].sort((a, b) => b.score - a.score);
  const rows = sorted
    .map(
      (c) => `<tr>
      <td>${escapeHtml(shortName(c.name))}</td>
      <td class="num">${c.score >= 0 ? c.score : '—'}</td>
      <td>${c.grade === '-' ? '—' : `<span class="pill ${c.grade === 'A' || c.grade === 'B' ? 'ok' : c.grade === 'C' ? 'mid' : 'bad'}">${c.grade}</span>`}</td>
      <td class="num">${c.score >= 0 ? Math.round(c.coverageShare * 100) + '%' : '—'}</td>
      <td>${c.dominantMissing ? CATEGORY_MAP[c.dominantMissing as keyof typeof CATEGORY_MAP]?.name ?? c.dominantMissing : '—'}</td>
      <td><button class="btn ghost plan-loc" data-fly="${c.center.lat},${c.center.lng}">定位</button></td>
    </tr>`
    )
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
