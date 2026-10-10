import { CATEGORY_MAP, PERSONA_MAP } from '../shared/config.js';
import type { AnalysisResult, GapPatch, PlanSite } from '../shared/types.js';
import { renderCharts } from './charts.js';
import { CHANNEL_LABEL } from './hud.js';
import { map } from './main.js';

/** 右侧报告面板：体检报告 / 国标清单 / 灰色区域 / 规划建议 / 运行日志 */

let currentResult: AnalysisResult | null = null;
let currentTab = 'report';

export function setResult(r: AnalysisResult | null) {
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
  if (!currentResult) {
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
  footer.classList.remove('hidden');
  const r = currentResult;
  switch (currentTab) {
    case 'report': body.innerHTML = reportHtml(r); animateGrade(r.score.total); renderCharts(r); break;
    case 'checklist': body.innerHTML = checklistHtml(r); break;
    case 'gaps': body.innerHTML = gapsHtml(r); break;
    case 'plan': body.innerHTML = planHtml(r); break;
    case 'log': body.innerHTML = logHtml(r); break;
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
    规划引擎：在灰色区域内以「贪心最大覆盖」求解补点位置，目标为人口加权覆盖率提升最大化。
    点击定位查看建议落点与 1km 服务盘。
  </div>`;
  if (!r.planSites.length) {
    return head + '<div class="empty-tip">当前覆盖率良好，暂无补点建议。</div>';
  }
  return (
    head +
    r.planSites
      .map(
        (s) => `
    <div class="plan-card">
      <h4><span class="rank">${s.rank}</span> 建议补建「${CATEGORY_MAP[s.category].name}」<span class="gain-chip">+${Math.round((s.afterPct - s.beforePct) * 10) / 10}pp</span></h4>
      <div>${escapeHtml(s.rationale)}</div>
      <div class="plan-meta">
        <span>坐标 ${s.latLng.lat.toFixed(5)}, ${s.latLng.lng.toFixed(5)}</span>
        <span>服务盘折算 ≈ ${s.estWalkMin} 分钟步行</span>
      </div>
      <div class="plan-loc"><button class="btn ghost" data-fly="${s.latLng.lat},${s.latLng.lng}">地图定位</button></div>
    </div>`
      )
      .join('')
  );
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export type { GapPatch, PlanSite };
