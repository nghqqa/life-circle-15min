import './style.css';
import {
  CATEGORIES,
  DEFAULT_CENTER,
  PERSONA_MAP,
  THRESHOLDS,
  buildAnalysisWarnings,
  buildChecklist,
  buildIsochroneModel,
  buildTimeField,
  contourPolylines,
  cumulativeOpportunities,
  dedupePois,
  analyzeGaps,
  computeScore,
  destination,
  fieldBounds,
  interpolationAccuracy,
  interpAngle,
  planFacilitiesFromCoverage,
  type AnalysisResult,
  type CategoryId,
  type ChannelName,
  type LatLng,
  type Poi,
  type PersonaId,
  type RouteProbe
} from '../shared/index.js';
import { ClientGateway, GatewayChain, MockGateway, ServerGateway, makeProbeDestinations, type Gateway } from './api.js';
import { fieldToDataUrl } from './fieldRender.js';
import { Hud, banner, CHANNEL_LABEL } from './hud.js';
import { MapView, type LayerKey } from './map.js';
import { getWorkbenchState, getWorkbenchSnapshot, setWorkbenchState, onWorkbenchChange, displayedPlanSites, setResult, switchTab } from './panels.js';
import { setupProjects } from './projectUi.js';
import { createProvenance } from '../shared/provenance.js';
import { assessmentUnavailableCategories, poiSearchWarnings, unqueriedPoiSearch, isPoiQuotaError } from '../shared/poiSearch.js';
import type { CrossingSegment, CrossingStats, PoiSearchCompleteness } from '../shared/types.js';
import type { ProjectSnapshot } from './projects.js';
import { openPrintableReport, downloadText, facilityCsv } from './exports.js';

// ---------- 全局状态 ----------

export const map = new MapView();
const hud = new Hud();
let projects: ReturnType<typeof setupProjects> | null = null;
let analyzing = false;
let locationRevision = 0;

const state = {
  center: DEFAULT_CENTER as LatLng,
  centerName: '',
  persona: 'adult' as PersonaId,
  minutes: 15,
  result: null as AnalysisResult | null,
  chain: null as GatewayChain | null,
  mock: false,
  hasServerAk: false,
  pickMode: false
};

declare global {
  interface Window {
    __LC_BROWSER_AK__?: string;
    __LC_CENTER__?: LatLng;
    __LC_MOCK_SEED__?: number;
    __LC_MOCK_CTX__?: { minutes: number; speed: number };
    __LC_MAP__?: any;
  }
}

// ---------- 初始化 ----------

async function init() {
  let cfg = { browserAk: '', hasServerAk: false, mock: true };
  try {
    const res = await fetch('/api/config');
    if (res.ok) cfg = await res.json();
  } catch {
    /* 无后端时直接进入演示模式 */
  }

  window.__LC_BROWSER_AK__ = cfg.browserAk;
  const gateways: Gateway[] = [];
  if (cfg.hasServerAk) gateways.push(new ServerGateway());
  if (cfg.browserAk) gateways.push(new ClientGateway());
  gateways.push(new MockGateway());
  state.mock = gateways.length === 1;

  const badge = document.getElementById('mode-badge')!;
  if (cfg.hasServerAk) {
    badge.textContent = '数据通道：服务端';
    badge.className = 'badge badge-ok';
  } else if (cfg.browserAk) {
    badge.textContent = '数据通道：浏览器直连';
    badge.className = 'badge badge-warn';
  } else {
    badge.textContent = '演示模式（合成数据）';
    badge.className = 'badge badge-warn';
  }
  state.hasServerAk = cfg.hasServerAk;

  state.chain = new GatewayChain(gateways, () => updateChannelCard());

  if (cfg.browserAk) {
    const ok = await map.init(cfg.browserAk, state.center, (p) => {
      // 仅在「图上选点」模式下接受地图点击，避免浏览地图时误改中心点
      closeDrawers();
      if (!state.pickMode) return;
      locationRevision++;
      state.center = p;
      state.centerName = '';
      map.setCenter(p, '中心点');
      setPickMode(false);
      void nameCenter(p);
    });
    window.__LC_MAP__ = map.map;
    if (!ok) document.getElementById('map-placeholder')?.classList.remove('hidden');
  } else {
    document.getElementById('map-placeholder')?.classList.remove('hidden');
  }

  buildLegend();
  bindUi();
  updateChannelCard();
  projects = setupProjects({
    restore: restoreProject,
    getResult: () => state.result,
    getWorkbench: getWorkbenchSnapshot,
    isBusy: () => analyzing
  });
  onWorkbenchChange(() => projects?.workbenchChanged());
}

function drawResult(result: AnalysisResult) {
  if (!map.ready) return;
  const bounds = fieldBounds(result.field);
  map.setCenter(result.center, result.centerName);
  map.setHeat(fieldToDataUrl(result.field), bounds.sw, bounds.ne);
  map.setRings(result.rings);
  map.setPois(result.pois);
  map.setGaps(result.gap.patches);
  map.setPlanSites(displayedPlanSites());
  map.setCrossings(result.crossingSegments ?? []);
}

function restoreProject(project: ProjectSnapshot) {
  locationRevision++;
  const result = project.result;
  state.result = result;
  state.center = { ...result.center };
  state.centerName = result.centerName;
  state.persona = result.persona;
  state.minutes = result.minutes;
  (document.getElementById('addr-input') as HTMLInputElement).value = result.centerName;
  (document.getElementById('persona') as HTMLSelectElement).value = result.persona;
  (document.getElementById('minutes') as HTMLSelectElement).value = String(result.minutes);
  setResult(result);
  setWorkbenchState(project.workbench);
  drawResult(result);
  switchTab('report');
}

function buildLegend() {
  const el = document.getElementById('legend-pois')!;
  el.innerHTML = CATEGORIES.map(
    (c) =>
      `<div class="item${c.core ? ' core' : ''}"><span class="dot" style="background:${c.color}"></span>${c.name}</div>`
  ).join('');
}

function bindUi() {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as unknown as T;

  $('btn-analyze').addEventListener('click', () => analyze().catch((e) => {
    console.error(e);
    hud.finish();
    banner(`分析失败：${(e as Error).message ?? e}`);
  }));

  $('btn-locate').addEventListener('click', async () => {
    const addr = ($('addr-input') as HTMLInputElement).value.trim();
    if (!addr || !state.chain) return;
    const revision = ++locationRevision;
    try {
      const r = await state.chain.geocode(addr);
      if (revision !== locationRevision || analyzing) return;
      state.center = { lat: r.value.lat, lng: r.value.lng };
      state.centerName = addr;
      map.setCenter(state.center, addr);
      if (!map.ready) hud.note(`已定位（BD-09）：${r.value.lat.toFixed(5)}, ${r.value.lng.toFixed(5)}`);
    } catch (e) {
      banner(`定位失败：${(e as Error).message}`);
    }
  });

  $('addr-input').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') $('btn-locate').click();
  });

  const pickBtn = $('btn-pick');
  pickBtn.addEventListener('click', () => setPickMode(!state.pickMode));

  // 窄屏抽屉
  $('btn-sidebar').addEventListener('click', () => {
    document.body.classList.toggle('sidebar-open');
    document.body.classList.remove('panel-open');
  });
  $('btn-panel').addEventListener('click', () => {
    document.body.classList.toggle('panel-open');
    document.body.classList.remove('sidebar-open');
  });

  $('persona').addEventListener('change', (e) => {
    state.persona = (e.target as HTMLSelectElement).value as PersonaId;
  });
  $('minutes').addEventListener('change', (e) => {
    state.minutes = Number((e.target as HTMLSelectElement).value);
  });

  const layers: [string, LayerKey][] = [
    ['ly-heat', 'heat'],
    ['ly-rings', 'rings'],
    ['ly-poi', 'poi'],
    ['ly-gap', 'gap'],
    ['ly-plan', 'plan'],
    ['ly-cross', 'cross']
  ];
  for (const [id, key] of layers) {
    $(id).addEventListener('change', (e) => map.toggleLayer(key, (e.target as HTMLInputElement).checked));
  }

  document.querySelectorAll('#panel-tabs button').forEach((b) => {
    b.addEventListener('click', () => switchTab((b as HTMLElement).dataset.tab!));
  });

  $('btn-print').addEventListener('click', () => {
    if (!state.result) return;
    try {
      if (openPrintableReport(state.result, getWorkbenchSnapshot()) === 'download') banner('预览窗口被浏览器阻止，已改为下载 HTML 报告；打开文件后可打印或另存 PDF。', 'warn');
    } catch { banner('报告生成失败，当前项目已保留；请下载项目快照备份后重试。', 'warn'); }
  });
  $('btn-facility-csv').addEventListener('click', () => {
    if (!state.result) return;
    try { downloadText(facilityCsv(state.result), '圈点-设施清单.csv', 'text/csv;charset=utf-8'); }
    catch { banner('设施表导出失败，当前数据未改动，请重试或下载项目快照。', 'warn'); }
  });
  $('btn-json').addEventListener('click', () => {
    try { exportJson(); }
    catch { banner('JSON 导出失败，当前数据未改动，请重试或下载项目快照。', 'warn'); }
  });
}

function setPickMode(on: boolean) {
  state.pickMode = on;
  const btn = document.getElementById('btn-pick');
  btn?.classList.toggle('on', on);
  document.getElementById('map')?.classList.toggle('picking', on);
  if (on) banner('选点模式：在地图上点击选择新的中心点', 'info', 3500);
}

/** 逆地理编码：为选定的中心点补一个可读地名（尽力而为，失败保持坐标显示） */
async function nameCenter(p: LatLng) {
  const revision = locationRevision;
  const chain = state.chain;
  if (!chain) return;
  try {
    const r = await chain.reverseGeocode(p);
    if (revision === locationRevision && state.center.lat === p.lat && state.center.lng === p.lng) {
      state.centerName = r.value;
      map.setCenter(p, r.value);
    }
  } catch {
    /* 保持坐标显示 */
  }
}

function closeDrawers() {
  document.body.classList.remove('sidebar-open', 'panel-open');
}

function updateChannelCard() {
  const el = document.getElementById('channel-list');
  const chain = state.chain;
  if (!el || !chain) return;
  el.innerHTML = chain
    .channels()
    .map(
      (c) =>
        `<div class="channel-item"><b>${CHANNEL_LABEL[c.name]}</b><span>${
          c.open ? '<span style="color:var(--bad)">熔断中</span>' : '<span style="color:var(--ok)">就绪</span>'
        } · 失败 ${c.fails}</span></div>`
    )
    .join('');
}

// ---------- 分析主流程 ----------

async function analyze() {
  const chain = state.chain;
  if (!chain || analyzing) return;
  analyzing = true;
  locationRevision++;
  setPickMode(false);
  projects?.setBusy(true);
  const btn = document.getElementById('btn-analyze') as HTMLButtonElement;
  btn.disabled = true;
  const controls = ['addr-input', 'btn-locate', 'btn-pick', 'persona', 'minutes'];
  controls.forEach((id) => (document.getElementById(id) as HTMLInputElement).disabled = true);

  const persona = PERSONA_MAP[state.persona];
  const steps = ['中心定位', '路网采样算路', '时间场与等时环', '设施 POI 检索', '盲区识别与评分', '补点规划求解', '过街设施扫描'];
  hud.start('正在体检…', steps);
  const stepUsage: AnalysisResult['steps'] = [];
  window.__LC_CENTER__ = state.center;
  window.__LC_MOCK_CTX__ = { minutes: state.minutes, speed: persona.speed };

  try {
    // 1) 中心定位（有地址输入时地理编码；无名称的中心点尝试逆地理编码补地名）
    hud.doing(0);
    const addr = (document.getElementById('addr-input') as HTMLInputElement).value.trim();
    if (addr && addr !== state.centerName) {
      try {
        const r = await chain.geocode(addr);
        state.center = { lat: r.value.lat, lng: r.value.lng };
        state.centerName = addr;
        stepUsage.push({ name: '中心定位', usage: { channel: r.channel, ms: r.ms } });
      } catch {
        banner('地理编码失败，使用当前中心点继续', 'warn');
        stepUsage.push({ name: '中心定位', usage: { channel: 'mock', ms: 0, note: '失败降级' } });
      }
    } else if (!state.centerName) {
      try {
        const r = await chain.reverseGeocode(state.center);
        state.centerName = r.value;
        stepUsage.push({ name: '中心定位', usage: { channel: r.channel, ms: r.ms, note: '逆地理编码' } });
      } catch {
        stepUsage.push({ name: '中心定位', usage: { channel: state.mock ? 'mock' : 'server', ms: 0, note: '使用当前中心点' } });
      }
    } else {
      stepUsage.push({ name: '中心定位', usage: { channel: state.mock ? 'mock' : 'server', ms: 0, note: '使用当前中心点' } });
    }
    map.setCenter(state.center, state.centerName || undefined);
    hud.done(0, 'server', 0);

    // 2) 扇形采样批量算路：先用 2 个探针预检通道健康度——
    //    服务端可用走 48 向批量；否则降为 16 向逐向 SDK 算路（预检探针复用为正北/正南方向）
    hud.doing(1, `路网探针 · 探测半径 ${Math.round(state.minutes * persona.speed)}m`);
    const probeM = state.minutes * persona.speed;
    const pre = await chain.routeMatrix(state.center, [
      destination(state.center, 0, probeM),
      destination(state.center, 180, probeM)
    ]);
    const useServer = pre.channel === 'server';
    const dirs = useServer ? THRESHOLDS.sampleDirs : 16;
    const dests = makeProbeDestinations(state.center, dirs, probeM);
    const probes: (RouteProbe | null)[] = new Array(dirs).fill(null);
    probes[0] = pre.value[0];
    probes[useServer ? 24 : 8] = pre.value[1];
    const restIdx = probes.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
    const rm = await chain.routeMatrix(
      state.center,
      restIdx.map((i) => dests[i])
    );
    restIdx.forEach((idx, k) => {
      probes[idx] = rm.value[k];
    });
    const okProbes = probes.filter((p) => p && p.ok).length;
    stepUsage.push({
      name: '路网采样算路',
      usage: { channel: rm.channel, ms: pre.ms + rm.ms, note: `${okProbes}/${dirs} 向成功` }
    });
    hud.done(1, rm.channel, pre.ms + rm.ms);

    // 3) 等时圈模型 + 时间场 + 等时环
    hud.doing(2, '空间插值生成连续步行时间场');
    const model = buildIsochroneModel(state.center, probes, {
      dirs,
      minutes: state.minutes,
      speed: persona.speed,
      probeM
    });
    const field = buildTimeField(model);
    const levels = [5, 10, state.minutes].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
    const rings = levels.map((level) => ({ level, lines: contourPolylines(field, level) }));
    hud.done(2, 'server', 0);

    // 3b) 插值精度自证：8 个抽样点全量算路 vs 模型估计
    let accuracy: AnalysisResult['accuracy'];
    try {
      const sb = [15, 60, 105, 150, 195, 240, 285, 330];
      const real = await chain.routeMatrix(
        state.center,
        sb.map((b) => destination(state.center, b, probeM * 0.6))
      );
      const realProbes = real.value
        .map((p, i) => ({ bearing: sb[i], straightM: probeM * 0.6, distM: p && p.ok ? p.distM : 0 }))
        .filter((p) => p.distM > 0);
      accuracy = interpolationAccuracy(
        state.center,
        realProbes,
        (theta) => interpAngle(model.factors, dirs, theta),
        persona.speed
      );
      if (accuracy.samples > 0) {
        stepUsage.push({
          name: '插值精度自证',
          usage: { channel: real.channel, ms: real.ms, note: `MAE ${accuracy.maeMinutes} 分钟（${accuracy.maePercent}%）` }
        });
      }
    } catch {
      /* 精度自证失败不影响主流程 */
    }

    // 4) POI 检索
    hud.doing(3, '民生设施分类检索…');
    const { pois, failedCategories, poiSearch, quotaExhausted, usedMock: poiUsedMock, poiOk } = await searchAllCategories(
      chain,
      (note) => hud.note(note),
      stepUsage
    );
    hud.done(3, 'server', 0);

    // 5) 盲区识别 + 评分 + 清单 + 累积机会（失败类别按「无法判断」贯通）
    hud.doing(4, '人口加权盲区聚合 · 四维评分');
    const unavailable = assessmentUnavailableCategories(failedCategories, poiSearch);
    const gap = analyzeGaps(field, unavailable.includes('residential') ? pois.filter((p) => p.category !== 'residential') : pois,
      { failedCategories: unavailable });
    if (unavailable.some((category) => ['market', 'pharmacy', 'primarySchool', 'residential'].includes(category))) {
      gap.coverageShare = null;
      gap.severeShare = null;
      gap.coverageUnavailable = true;
    }
    const score = computeScore(state.center, pois, gap, { failedCategories: unavailable });
    const checklist = buildChecklist(state.center, pois, { failedCategories: unavailable });
    const cumulative = cumulativeOpportunities(field, pois, state.minutes);
    hud.done(4, 'server', 0);

    // 6) 补点规划
    hud.doing(5, '贪心最大覆盖求解补点位置');
    const planSites = planFacilitiesFromCoverage(gap, gap.coveredMasks, field, persona.speed, {
      unknownCategories: unavailable
    });
    hud.done(5, 'server', 0);

    // 7) 过街设施扫描（可选）
    hud.doing(6);
    let crossings: { stats: CrossingStats; segments: CrossingSegment[] } | null = null;
    if (!quotaExhausted && (document.getElementById('ly-cross') as HTMLInputElement).checked) {
      crossings = await scanCrossings(chain, state.center, probeM, stepUsage);
    }
    hud.done(6, 'server', 0);

    // 警告：与共享引擎同一生成器，区分「数据缺失」「模型合成」「真实结论」
    const warnings = buildAnalysisWarnings({
      okProbes,
      degradedDirs: model.degradedDirs,
      probes: rm.value,
      probeStraightM: probeM,
      failedCategories,
      totalWeight: gap.totalWeight,
      poiOk
    });
    warnings.push(...poiSearchWarnings(poiSearch));
    if (quotaExhausted) warnings.unshift('已停止后续检索与过街扫描，避免继续消耗配额。');
    const generatedAt = new Date().toISOString();
    const mock = pre.channel === 'mock' || rm.channel === 'mock' || poiUsedMock;

    // 渲染
    const result: AnalysisResult = {
      center: state.center,
      centerName: state.centerName || `中心点 ${state.center.lat.toFixed(5)},${state.center.lng.toFixed(5)}`,
      persona: state.persona,
      minutes: state.minutes,
      generatedAt,
      provenance: createProvenance({ generatedAt, poiSearch, channels: stepUsage.map((s) => s.usage.channel), mock }),
      model,
      field,
      rings,
      pois,
      gap,
      score,
      checklist,
      planSites,
      cumulative,
      accuracy,
      warnings,
      failedCategories,
      poiSearch,
      incompleteCategories: unavailable,
      assessmentUnavailableCategories: unavailable,
      incomplete: unavailable.length > 0 || quotaExhausted,
      quotaExhausted,
      crossings: crossings?.stats ?? null,
      crossingSegments: crossings?.segments ?? [],
      steps: stepUsage,
      mock
    };
    state.result = result;

    setResult(result);
    drawResult(result);
    switchTab('report');
    projects?.analysisCompleted();
    hud.note(`完成：总分 ${score.total}（${score.grade}），发现 ${gap.patches.length} 个灰色区域，给出 ${planSites.length} 条补点建议`);
    hud.finish();
  } finally {
    analyzing = false;
    projects?.setBusy(false);
    btn.disabled = false;
    controls.forEach((id) => (document.getElementById(id) as HTMLInputElement).disabled = false);
    updateChannelCard();
  }
}

async function searchAllCategories(
  chain: GatewayChain,
  onNote: (s: string) => void,
  stepUsage: AnalysisResult['steps']
): Promise<{ pois: Poi[]; failedCategories: CategoryId[]; poiSearch: PoiSearchCompleteness[]; quotaExhausted: boolean; usedMock: boolean; poiOk: boolean }> {
  const tasks = CATEGORIES.flatMap((c) => c.keywords.map((kw) => ({ cat: c, kw })));
  const out: Poi[] = [];
  const poiSearch: PoiSearchCompleteness[] = [];
  let quotaExhausted = false;
  const failedKw = new Set<string>();
  let done = 0;
  let channel: ChannelName = 'server';
  let usedMock = false;
  let totalMs = 0;

  const t0 = performance.now();
  // 地点检索串行执行（个人 AK 并发上限约 2-3），请求间隔 450ms
  const worker = async () => {
    while (tasks.length) {
      const t = tasks.shift()!;
      if (quotaExhausted) {
        failedKw.add(t.kw);
        poiSearch.push(unqueriedPoiSearch(t.kw, t.cat.id, channel, 'skipped', true));
        continue;
      }
      try {
        const r = await chain.searchPoiDetailed({ query: t.kw, location: state.center, radiusM: THRESHOLDS.searchRadiusM }, t.cat.id);
        for (const p of r.value.pois) out.push({ ...p, category: t.cat.id });
        poiSearch.push(r.value.completeness);
        quotaExhausted ||= r.value.completeness.quotaExhausted;
        if (r.value.completeness.status === 'failed') failedKw.add(t.kw);
        channel = r.channel;
        if (r.channel === 'mock') usedMock = true;
        done++;
        onNote(`POI 检索 ${done}：${t.kw} → ${r.value.pois.length} 条（${CHANNEL_LABEL[r.channel]}）`);
      } catch (error) {
        done++;
        failedKw.add(t.kw);
        quotaExhausted = isPoiQuotaError(error);
        poiSearch.push(unqueriedPoiSearch(t.kw, t.cat.id, channel, 'failed', quotaExhausted));
      }
      await new Promise((res) => setTimeout(res, 450));
    }
  };
  await worker();

  totalMs = Math.round(performance.now() - t0);
  const failedCategories = CATEGORIES.filter((c) => c.keywords.every((kw) => failedKw.has(kw))).map((c) => c.id);
  const poiOk = CATEGORIES.filter((c) => c.scored).some((c) => poiSearch.some((s) => s.category === c.id && s.status === 'complete'));
  stepUsage.push({ name: '设施 POI 检索', usage: { channel, ms: totalMs, note: `共 ${out.length} 条` } });
  return { pois: dedupePois(out), failedCategories, poiSearch, quotaExhausted, usedMock, poiOk };
}

async function scanCrossings(
  chain: GatewayChain,
  center: LatLng,
  probeM: number,
  stepUsage: AnalysisResult['steps']
) {
  const t0 = performance.now();
  const stats = { scanned: 0, overpass: 0, underpass: 0, crosswalkHint: 0 };
  const segments: CrossingSegment[] = [];
  for (const b of [30, 90, 150, 210, 270, 330]) {
    const dest = destination(center, b, probeM * 0.6);
    try {
      const r = await chain.walkingGeo(center, dest);
      stats.scanned++;
      for (const s of r.value) {
        const text = s.text;
        stats.overpass += (text.match(/天桥/g) ?? []).length;
        stats.underpass += (text.match(/地下通道|地道/g) ?? []).length;
        stats.crosswalkHint += (text.match(/过街|人行横道|路口/g) ?? []).length;
        if (s.path.length >= 2) {
          const kind = /天桥/.test(text) ? 'overpass' : /地下通道|地道/.test(text) ? 'underpass' : /过街|人行横道|路口/.test(text) ? 'crosswalk' : 'walk';
          segments.push({ path: s.path, kind });
        }
      }
    } catch {
      /* 单方向失败忽略 */
    }
  }
  stepUsage.push({
    name: '过街设施扫描',
    usage: { channel: chain.activeChannel() ?? 'mock', ms: Math.round(performance.now() - t0), note: `${stats.scanned} 条路段` }
  });
  return { stats, segments };
}

function exportJson() {
  const r = state.result;
  if (!r) return;
  const plain = {
    center: r.center,
    centerName: r.centerName,
    persona: r.persona,
    minutes: r.minutes,
    generatedAt: r.generatedAt,
    provenance: r.provenance,
    poiSearch: r.poiSearch,
    incompleteCategories: r.incompleteCategories,
    incomplete: r.incomplete,
    quotaExhausted: r.quotaExhausted,
    model: { dirs: r.model.dirs, probeM: r.model.probeM, factors: r.model.factors, radiusM: r.model.radiusM, degradedDirs: r.model.degradedDirs },
    score: r.score,
    checklist: r.checklist,
    cumulative: r.cumulative,
    accuracy: r.accuracy,
    warnings: r.warnings,
    failedCategories: r.failedCategories,
    workbench: getWorkbenchState(),
    gap: {
      blindPoints: r.gap.blindPoints,
      coverageShare: r.gap.coverageShare,
      severeShare: r.gap.severeShare,
      patches: r.gap.patches.map((p) => ({
        id: p.id,
        centroid: p.centroid,
        weightShare: p.weightShare,
        missingCats: p.missingCats,
        dominant: p.dominant,
        maxNearestM: p.maxNearestM,
        severity: p.severity
      }))
    },
    planSites: r.planSites,
    crossings: r.crossings,
    steps: r.steps,
    mock: r.mock
  };
  downloadText(JSON.stringify(plain, null, 2), `life-circle-report-${Date.now()}.json`, 'application/json;charset=utf-8');
}

init().catch((e) => {
  console.error(e);
  banner(`初始化失败：${(e as Error).message}`);
});
