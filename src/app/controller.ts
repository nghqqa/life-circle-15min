import {
  CATEGORIES,
  DEFAULT_CENTER,
  PERSONAS,
  PERSONA_MAP,
  THRESHOLDS,
  destination,
  fieldBounds,
  type AnalysisResult,
  type CategoryId,
  type ChannelName,
  type LatLng,
  type Poi,
  type PersonaId,
  type RouteProbe
} from '../../shared/index.js';
import {
  runOrchestration,
  makeProbeDestinations,
  type OrchestratorBoundary,
  type OrchestratorEnv,
  type OrchestratorSupplement,
  type WalkingStepGeo
} from '../../shared/orchestrator.js';
import { API_BASE, ClientGateway, GatewayChain, MockGateway, ServerGateway, type Gateway } from '../api.js';
import { fieldToDataUrl } from '../fieldRender.js';
import { Hud, banner, CHANNEL_LABEL } from '../hud.js';
import type { LayerKey } from '../map.js';
import { map } from '../appRuntime.js';
import { getWorkbenchState, getWorkbenchSnapshot, setWorkbenchState, onWorkbenchChange, displayedPlanSites, setResult, switchTab, setServerJobsEnabled } from '../panels.js';
import { setupProjects } from '../projectUi.js';
import { createProvenance } from '../../shared/provenance.js';
import { assessmentUnavailableCategories, poiSearchWarnings, unqueriedPoiSearch, isPoiQuotaError } from '../../shared/poiSearch.js';
import type { CrossingSegment, CrossingStats, PoiSearchCompleteness } from '../../shared/types.js';
import { sampleTimeNearest } from '../../shared/timefield.js';
import { slimShareReport } from '../../shared/sharePayload.js';
import { worldPopCoverage } from '../../shared/worldpop.js';
import { getCachedRoute, setCachedRoute, routeCacheKey } from '../routeCache.js';
import type { ProjectSnapshot } from '../projects.js';
import { openPrintableReport, downloadText, facilityCsv } from '../exports.js';
import { downloadShareCard } from './shareCard.js';
import { parseOpenHours } from '../openHours.js';
import { addCorrection, listCorrections, undoCorrection, type CorrectionStatus } from '../corrections.js';
import { supplementPois } from '../supplements.js';
import { getBoundary, pointInBoundary } from '../boundary.js';

// ---------- 全局状态 ----------

const hud = new Hud();
let projects: ReturnType<typeof setupProjects> | null = null;
let analyzing = false;
let comparing = false;
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

export async function init() {
  let cfg = { browserAk: '', hasServerAk: false, mock: true };
  try {
    const res = await fetch(`${API_BASE}api/config`);
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
  setServerJobsEnabled(cfg.hasServerAk); // 无服务端部署跳过批量/usage 端点，避免静态站 404

  state.chain = new GatewayChain(gateways, () => updateChannelCard());

  if (cfg.browserAk) {
    const ok = await map.init(cfg.browserAk, state.center, (p) => {
      // 仅在「图上选点」模式下接受地图点击，避免浏览地图时误改中心点
      closeDrawers();
      if (!state.pickMode) return;
      pickCenter(p);
    }, (p, px) => showCtxMenu(p, px));
    window.__LC_MAP__ = map.map;
    if (!ok) document.getElementById('map-placeholder')?.classList.remove('hidden');
    else document.getElementById('map-type-switch')?.classList.remove('hidden');
  } else {
    document.getElementById('map-placeholder')?.classList.remove('hidden');
  }

  bindGlobal();
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
  map.setRoute(null);
  const boundaryNow = getBoundary();
  map.setBoundary(boundaryNow ? boundaryNow.polygons : null);
}

/** №5 点到设施真实路线核验：按需单次查询，真实路网距离与时间场估计并列展示，失败不伪装 */
async function verifyRouteToPoi(uid: string) {
  const r = state.result;
  const poi: Poi | undefined = r?.pois.find((p) => p.uid === uid);
  if (!r || !poi) {
    banner('未找到该设施，请重新体检后再核验。');
    return;
  }
  const key = routeCacheKey(state.center, poi);
  const fetchRoutePath = async (): Promise<LatLng[]> => {
    try {
      const res = await state.chain?.walkingGeo?.(state.center, poi);
      const steps = res?.value ?? [];
      const path = steps.flatMap((s: WalkingStepGeo) => s.path ?? []);
      return path.length >= 2 ? path : [state.center, poi];
    } catch {
      return [state.center, poi];
    }
  };
  const cached = getCachedRoute(key);
  if (cached && cached.channel !== 'mock') {
    // F1：合成兜底结果不是核验证据，不读取、不入缓存
    map.setRoute(cached.path ?? await fetchRoutePath());
    reportRoute(poi, cached.distM, `${cached.channel} · 缓存`, r);
    return;
  }
  if (cached) localStorage.removeItem(key);
  banner('正在获取真实步行路线…', 'info', 8000);
  try {
    const res = state.chain ? await state.chain.walkingRoute(state.center, poi) : null;
    const probe: RouteProbe | null = res?.value ?? null;
    if (!res || !probe || !probe.ok || res.channel === 'mock') {
      // F1：合成兜底（演示模式）返回的 ok 距离是估算，不是真实路网核验
      banner(res?.channel === 'mock'
        ? '当前为合成兜底通道：无法核验真实路网路线（展示的距离是估算，不写入核验缓存）。'
        : '路线核验失败：步行规划通道当前不可用。系统不伪装估计结果，请稍后重试或更换通道。');
      return;
    }
    const path = await fetchRoutePath();
    setCachedRoute(key, probe.distM, res.channel, path);
    map.setRoute(path);
    reportRoute(poi, probe.distM, res.channel, r);
  } catch (err) {
    banner(`路线核验失败：${String((err as Error)?.message ?? err)}。系统不伪装估计结果。`);
  }
}

function reportRoute(poi: Poi, distM: number, channel: string, r: AnalysisResult) {
  const realMin = distM / r.model.speed;
  const estMin = sampleTimeNearest(r.field, poi);
  const delta = realMin - estMin;
  banner(
    `路线核验 · ${poi.name}：真实路网 ${distM}m ≈ ${realMin.toFixed(1)} 分钟（通道 ${CHANNEL_LABEL[channel as keyof typeof CHANNEL_LABEL] ?? channel}）· 时间场估计 ${estMin.toFixed(1)} 分钟（偏差 ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}）`,
    'info', 10000
  );
  map.flyTo(poi);
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
  // persona/minutes 已是 antd Select（React 受控）：经事件同步，不再写 DOM
  window.dispatchEvent(new CustomEvent('lc:controls', { detail: { persona: result.persona, minutes: result.minutes } }));
  setResult(result);
  setWorkbenchState(project.workbench);
  drawResult(result);
  switchTab('report');
}

function bindGlobal() {
  // POI 弹窗动作统一入口：BMapGL 弹窗容器会 stopPropagation，body 委托收不到；
  // 弹窗内按钮改走 inline onclick → window.__lcPoiAct；弹窗外元素仍走此委托
  const poiAction = (ds: DOMStringMap) => {
    if (ds.routeUid) { void verifyRouteToPoi(ds.routeUid); return; }
    if (ds.hoursUid) {
      const uid = ds.hoursUid;
      const poi = state.result?.pois.find((p) => p.uid === uid);
      if (!state.hasServerAk) {
        banner('演示模式无营业时间数据：状态未知，未知 ≠ 全天营业。');
        return;
      }
      banner('正在查询商户申报的营业时间…', 'info', 6000);
      fetch(`${API_BASE}api/baidu/place/v2/detail?uid=${encodeURIComponent(uid)}`)
        .then((res) => res.json())
        .then((data) => {
          const raw: string | undefined = data?.result?.detail_info?.open_time ?? data?.result?.open_time;
          const parsed = parseOpenHours(raw);
          const name = poi?.name ?? '该设施';
          const label = parsed.status === 'open' ? '营业中' : parsed.status === 'closed' ? '当前未营业' : '营业时间未知';
          banner(`${name}：${label}（${parsed.note}）`, parsed.status === 'unknown' ? 'warn' : 'info', 10000);
        })
        .catch(() => banner('营业时段查询失败：商户申报数据不可用，状态保持未知。'));
      return;
    }
    if (ds.corrSave) {
      const uid = ds.corrSave;
      // React 弹窗直接把 status/note 放 dataset；保留 DOM 读取作兼容回退
      const status = (ds.corrStatus ?? (document.querySelector(`[data-corr-status="${uid}"]`) as HTMLSelectElement)?.value) as CorrectionStatus;
      const note = ds.corrNote ?? (document.querySelector(`[data-corr-note="${uid}"]`) as HTMLInputElement)?.value ?? '';
      const poi = state.result?.pois.find((p) => p.uid === uid);
      const rec = addCorrection(uid, poi?.name ?? '', poi ? { lat: poi.lat, lng: poi.lng } : { lat: 0, lng: 0 }, poi?.source ?? 'unknown', status, note);
      if (rec) banner(`已标注「${poi?.name ?? uid}」：${status}。标注仅作现场记录，未计入评分；可随时撤销。`, 'info', 10000);
      return;
    }
    if (ds.corrUndoUid) {
      const left = undoCorrection(ds.corrUndoUid);
      banner(left ? '已撤销最新一条标注，历史可继续回退。' : '标注已全部撤销。', 'info');
    }
  };
  // React 弹窗直接传 dataset 对象；body 委托仍处理弹窗外/测试用的 data-* 元素
  (window as unknown as Record<string, unknown>).__lcPoiAct = (ds: Record<string, string>) => poiAction(ds);
  document.body.addEventListener('click', (event) => {
    const el = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-route-uid],[data-hours-uid],[data-corr-save],[data-corr-undo-uid]')
      : null;
    if (el) poiAction(el.dataset);
  });
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('ctx-menu');
    if (menu && !menu.contains(e.target as Node)) hideCtxMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideCtxMenu();
  });
}

// ---------- JSX 绑定层（React props 调用） ----------
export const ui = {
  projects: () => projects,
  channelItems: () => channelItems,
  locate: async () => {
    const addr = (document.getElementById('addr-input') as HTMLInputElement).value.trim();
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
  },
  runAnalyze: () => analyze().catch((e) => {
    console.error(e);
    hud.finish();
    banner(`分析失败：${(e as Error).message ?? e}`);
  }),
  // 人群公平性对比：同一坐标对另外两个人群复跑纯计算核心（不重定位、不刷 HUD）
  comparePersonas: async (r: AnalysisResult): Promise<Partial<Record<PersonaId, AnalysisResult | null>>> => {
    const chain = state.chain;
    const out: Partial<Record<PersonaId, AnalysisResult | null>> = { [r.persona]: r };
    if (!chain || analyzing || comparing) return out;
    comparing = true;
    const prevCtx = window.__LC_MOCK_CTX__;
    try {
      for (const p of PERSONAS) {
        if (p.id === r.persona) continue;
        try {
          out[p.id] = await runLocalAnalysis(chain, {
            center: r.center,
            centerName: r.centerName,
            persona: p.id,
            minutes: r.minutes,
            crossingsOn: false
          });
        } catch {
          out[p.id] = null;
        }
      }
    } finally {
      window.__LC_MOCK_CTX__ = prevCtx;
      comparing = false;
    }
    return out;
  },
  togglePick: () => setPickMode(!state.pickMode),
  setPersona: (v: PersonaId) => { state.persona = v; },
  setMinutes: (v: string) => { state.minutes = Number(v); },
  toggleLayer: (key: LayerKey, on: boolean) => map.toggleLayer(key, on),
  selectTab: (t: string) => switchTab(t),
  ctxAction: (act: string) => {
    const menu = document.getElementById('ctx-menu');
    const p = (menu as unknown as Record<string, unknown>)?._pending as LatLng | undefined;
    hideCtxMenu();
    if (!p || !act) return;
    pickCenter(p);
    if (act === 'analyze') void analyze().catch((e) => {
      console.error(e); hud.finish(); banner(`分析失败：${(e as Error).message ?? e}`);
    });
  },
  setMapType: (m: '2d' | 'satellite' | '3d') => map.setMapType(m),
  toggleDrawer: (which: 'sidebar' | 'panel') => {
    document.body.classList.toggle(`${which}-open`);
    document.body.classList.remove(which === 'sidebar' ? 'panel-open' : 'sidebar-open');
  },
  collapseInit: () => {
    const uiState = JSON.parse(localStorage.getItem('lc-ui') ?? '{}');
    const apply = () => {
      document.body.classList.toggle('sb-off', !!uiState.sb);
      document.body.classList.toggle('panel-off', !!uiState.panel);
      const l = document.getElementById('edge-left'), r = document.getElementById('edge-right');
      if (l) l.textContent = uiState.sb ? '▶' : '◀';
      if (r) r.textContent = uiState.panel ? '◀' : '▶';
    };
    apply();
    return (side: 'left' | 'right') => {
      if (side === 'left') uiState.sb = !uiState.sb; else uiState.panel = !uiState.panel;
      localStorage.setItem('lc-ui', JSON.stringify(uiState));
      apply();
    };
  },
  print: () => {
    if (!state.result) return;
    try {
      if (openPrintableReport(state.result, getWorkbenchSnapshot()) === 'download') banner('预览窗口被浏览器阻止，已改为下载 HTML 报告；打开文件后可打印或另存 PDF。', 'warn');
    } catch { banner('报告生成失败，当前项目已保留；请下载项目快照备份后重试。', 'warn'); }
  },
  facilityCsv: () => {
    if (!state.result) return;
    try { downloadText(facilityCsv(state.result), '圈点-设施清单.csv', 'text/csv;charset=utf-8'); }
    catch { banner('设施表导出失败，当前数据未改动，请重试或下载项目快照。', 'warn'); }
  },
  share: async () => {
    if (!state.result) return;
    banner('正在创建只读分享…', 'info', 6000);
    try {
      const res = await fetch(`${API_BASE}api/baidu/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(slimShareReport(state.result)) });
      const data = await res.json();
      if (data.status !== 0) { banner(`分享失败：${data.message ?? '未知错误'}`); return; }
      const url = `${location.origin}${API_BASE}api/baidu/share/${data.id}`;
      try { await navigator.clipboard.writeText(url); banner(`只读分享已创建并复制链接：${url}（固定版本快照，无交互；存储上限 100 份 FIFO）`, 'info', 12000); }
      catch { banner(`只读分享已创建：${url}（固定版本快照，无交互）`, 'info', 12000); }
    } catch (err) {
      banner(`分享失败：${String((err as Error)?.message ?? err)}。演示模式/离线环境无分享服务。`);
    }
  },
  shareCard: () => {
    if (!state.result) return;
    try { downloadShareCard(state.result); banner('分享图卡已生成下载（含诊断结论与处方建议，可直接引用）', 'info', 6000); }
    catch { banner('图卡生成失败，请重试或使用完整报告导出。', 'warn'); }
  },
  exportJson: () => {
    try { exportJson(); }
    catch { banner('JSON 导出失败，当前数据未改动，请重试或下载项目快照。', 'warn'); }
  },
  closeDrawers: () => closeDrawers()
};

function setPickMode(on: boolean) {
  state.pickMode = on;
  const btn = document.getElementById('btn-pick');
  btn?.classList.toggle('on', on);
  document.getElementById('map')?.classList.toggle('picking', on);
  if (on) banner('选点模式：在地图上点击选择新的中心点', 'info', 3500);
}

/** 选点/右键共用：更新中心点并逆地理补名 */
function pickCenter(p: LatLng) {
  locationRevision++;
  state.center = p;
  state.centerName = '';
  map.setCenter(p, '中心点');
  setPickMode(false);
  void nameCenter(p);
}

/** 地图右键菜单：设为中心点 / 设为中心点并体检 */
function showCtxMenu(p: LatLng, px: { x: number; y: number }) {
  const menu = document.getElementById('ctx-menu');
  const wrap = document.getElementById('map-wrap');
  if (!menu || !wrap) return;
  menu.classList.remove('hidden');
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const bw = wrap.clientWidth, bh = wrap.clientHeight;
  menu.style.left = `${Math.max(4, Math.min(px.x, bw - mw - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(px.y, bh - mh - 4))}px`;
  (menu as any)._pending = p;
}

function hideCtxMenu() {
  document.getElementById('ctx-menu')?.classList.add('hidden');
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

let channelItems: { label: string; open: boolean; fails: number }[] = [];

function updateChannelCard() {
  const chain = state.chain;
  if (!chain) return;
  channelItems = chain.channels().map((c) => ({ label: CHANNEL_LABEL[c.name], open: c.open, fails: c.fails }));
  window.dispatchEvent(new CustomEvent('lc:channel'));
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
  const controls = ['addr-input', 'btn-locate', 'btn-pick'];
  controls.forEach((id) => (document.getElementById(id) as HTMLInputElement).disabled = true);
  window.dispatchEvent(new CustomEvent('lc:busy', { detail: true }));

  const persona = PERSONA_MAP[state.persona];
  const steps = ['中心定位', '路网采样算路', '时间场与等时环', '设施 POI 检索', '盲区识别与评分', '补点规划求解', '过街设施扫描'];
  hud.start('正在体检…', steps);
  const step0Steps: AnalysisResult['steps'] = [];
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
        step0Steps.push({ name: '中心定位', usage: { channel: r.channel, ms: r.ms } });
      } catch {
        banner('地理编码失败，使用当前中心点继续', 'warn');
        step0Steps.push({ name: '中心定位', usage: { channel: 'mock', ms: 0, note: '失败降级' } });
      }
    } else if (!state.centerName) {
      try {
        const r = await chain.reverseGeocode(state.center);
        state.centerName = r.value;
        step0Steps.push({ name: '中心定位', usage: { channel: r.channel, ms: r.ms, note: '逆地理编码' } });
      } catch {
        step0Steps.push({ name: '中心定位', usage: { channel: state.mock ? 'mock' : 'server', ms: 0, note: '使用当前中心点' } });
      }
    } else {
      step0Steps.push({ name: '中心定位', usage: { channel: state.mock ? 'mock' : 'server', ms: 0, note: '使用当前中心点' } });
    }
    map.setCenter(state.center, state.centerName || undefined);
    hud.done(0, 'server', 0);

    const result = await runAnalysisForUi({
      center: state.center,
      centerName: state.centerName,
      persona: state.persona,
      minutes: state.minutes,
      crossingsOn: (document.getElementById('ly-cross') as HTMLInputElement).checked,
      onStep: (i, detail) => hud.doing(i, detail),
      onStepDone: (i, ch, ms) => hud.done(i, ch, ms),
      onNote: (s) => hud.note(s)
    });
    result.steps = [...step0Steps, ...(result.steps ?? [])];
    state.result = result;

    setResult(result);
    drawResult(result);
    switchTab('report');
    projects?.analysisCompleted();
    hud.note(`完成：总分 ${result.score.total}（${result.score.grade}），发现 ${result.gap.patches.length} 个灰色区域，给出 ${result.planSites.length} 条补点建议`);
    void fetch(`${API_BASE}api/baidu/usage`).then((res) => res.json()).then((data) => {
      const u = data?.usage;
      if (u) hud.note(`今日上游请求 ${u.requests.total}${u.dailyBudget > 0 ? `/${u.dailyBudget}` : ''} · 缓存命中 ${u.cacheHits} · 本地进程计数，非平台账户余额${u.overBudget ? ' · 已触顶暂停' : ''}`);
    }).catch(() => { /* 演示模式无此端点 */ });
    hud.finish();
  } finally {
    analyzing = false;
    projects?.setBusy(false);
    btn.disabled = false;
    controls.forEach((id) => (document.getElementById(id) as HTMLInputElement).disabled = false);
    window.dispatchEvent(new CustomEvent('lc:busy', { detail: false }));
    updateChannelCard();
  }
}

// ---------- 统一分析入口：服务端流式编排优先，无后端时本地跑同一份共享编排器 ----------

interface AnalysisRunOpts {
  center: LatLng;
  centerName: string;
  persona: PersonaId;
  minutes: number;
  crossingsOn: boolean;
  onStep?: (idx: number, detail?: string) => void;
  onStepDone?: (idx: number, channel: ChannelName, ms: number) => void;
  onNote?: (s: string) => void;
}

/** 浏览器侧环境适配：GatewayChain（三级通道降级）直接满足 OrchestratorEnv 结构 */
function localEnv(chain: GatewayChain): OrchestratorEnv {
  return {
    routeMatrix: (origin, dests) => chain.routeMatrix(origin, dests),
    searchPoiDetailed: (params, category, onPage) => chain.searchPoiDetailed(params, category, onPage),
    walkingGeo: (origin, dest) => chain.walkingGeo(origin, dest),
    activeChannel: () => chain.activeChannel()
  };
}

function currentSupplements(center: LatLng): OrchestratorSupplement[] {
  return supplementPois(center, THRESHOLDS.searchRadiusM);
}

function currentBoundary(): OrchestratorBoundary | null {
  const b = getBoundary();
  if (!b) return null;
  return {
    name: b.name,
    vertexCount: b.vertexCount,
    rings: b.polygons.map((ring) => ring.map(([lat, lng]) => ({ lat, lng }))),
    holes: (b.holes ?? []).map((ring) => ring.map(([lat, lng]) => ({ lat, lng }))),
    contains: (p) => pointInBoundary(p, b)
  };
}

/** 本地兜底：与服务端完全同一份共享编排器，仅数据环境换成浏览器通道链 */
async function runLocalAnalysis(chain: GatewayChain, opts: AnalysisRunOpts): Promise<AnalysisResult> {
  return runOrchestration(localEnv(chain), {
    center: opts.center,
    centerName: opts.centerName,
    persona: opts.persona,
    minutes: opts.minutes,
    crossingsOn: opts.crossingsOn,
    supplements: currentSupplements(opts.center),
    boundary: currentBoundary(),
    fetchPopCoverage: async (center, ring, radiusM) => {
      try {
        const res = await fetch(`${API_BASE}api/popcoverage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ center, ring, radiusM })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json())?.popCoverage ?? null;
      } catch {
        // 无后端（静态部署）时浏览器直连 WorldPop 公开接口（免密钥、CORS 开放）
        return await worldPopCoverage(center, ring, radiusM);
      }
    },
    setMockCtx: (ctx) => { window.__LC_MOCK_CTX__ = ctx; },
    onStep: opts.onStep,
    onStepDone: opts.onStepDone,
    onNote: opts.onNote
  });
}

/**
 * 服务端流式编排：POST /api/analyze/stream（SSE）。
 * 服务端跑与本地完全相同的共享编排器（同一 AK、同一缓存），页级进度逐帧转发进 HUD。
 * 仅在收到任何事件前的失败才允许回退本地——收到事件后的失败如实上报，
 * 避免同一请求在两条通道各跑一遍（重复消耗配额）。
 */
async function runServerAnalysis(opts: AnalysisRunOpts): Promise<AnalysisResult> {
  const res = await fetch(`${API_BASE}api/analyze/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lat: opts.center.lat,
      lng: opts.center.lng,
      centerName: opts.centerName,
      persona: opts.persona,
      minutes: opts.minutes,
      crossingsOn: opts.crossingsOn,
      supplements: currentSupplements(opts.center),
      boundary: currentBoundary()
    })
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) throw new Error('非流式响应');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let result: AnalysisResult | null = null;
  let gotEvent = false;
  const handle = (evt: any) => {
    gotEvent = true;
    if (evt.type === 'doing') opts.onStep?.(evt.index, evt.detail);
    else if (evt.type === 'done') opts.onStepDone?.(evt.index, evt.channel, evt.ms);
    else if (evt.type === 'note') opts.onNote?.(evt.text);
    else if (evt.type === 'result') result = evt.report;
    else if (evt.type === 'error') {
      const e = new Error(String(evt.message ?? '服务端分析失败'));
      (e as any).afterEvents = true;
      throw e;
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line) handle(JSON.parse(line.slice(6)));
    }
  }
  if (!result) {
    const e = new Error('流式分析未返回报告');
    (e as any).afterEvents = gotEvent;
    throw e;
  }
  return result;
}

/** UI 统一入口：有服务端 AK 走流式（启动前失败自动回退本地），否则直接本地 */
async function runAnalysisForUi(opts: AnalysisRunOpts): Promise<AnalysisResult> {
  const chain = state.chain;
  if (!chain) throw new Error('数据通道未初始化');
  if (state.hasServerAk) {
    try {
      return await runServerAnalysis(opts);
    } catch (err) {
      // 收到事件后的失败（含服务端上报 error/无报告）如实终止，不回退——避免同一请求双通道各跑一遍重复消耗配额
      if ((err as any)?.afterEvents) throw err;
      hud.note(`服务端编排不可用（${(err as Error).message}），改用本地通道继续`);
    }
  }
  return runLocalAnalysis(chain, opts);
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
    corrections: listCorrections(),
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


