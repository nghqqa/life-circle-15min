/**
 * 本地调用预算与用量计数（№13 调用预算面板的数据源）。
 *
 * 口径纪律：这里统计的是「本服务进程发出的真实上游请求」与「本地缓存命中」，
 * 用于预算自控与成本观察；它不代表百度开放平台账户的实时余额，界面不得表述为账户余额。
 *
 * 每日预算触顶时 provider/批量循环可以据此中止并保留已完成结果——
 * 与上游真实配额耗尽（302）走同一条优雅降级路径，但提示语明确区分两者。
 */

export interface UsageSnapshot {
  /** 统计日期（本地时区 YYYY-MM-DD），跨日自动归零 */
  date: string;
  /** 真实上游请求数（含重试，按服务分列） */
  requests: { place: number; route: number; geo: number; total: number };
  /** 本地缓存命中次数（等价于省下的上游请求） */
  cacheHits: number;
  /** 每日请求预算（BAIDU_LOCAL_DAILY_BUDGET，默认 2000；0 = 不限制） */
  dailyBudget: number;
  overBudget: boolean;
  /** 明示口径：本地计数，不是平台账户余额 */
  note: 'local-process-counter';
}

const state = {
  date: today(),
  place: 0,
  route: 0,
  geo: 0,
  cacheHits: 0
};

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dailyBudget(): number {
  const raw = process.env.BAIDU_LOCAL_DAILY_BUDGET;
  if (raw === undefined || raw.trim() === '') return 2000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2000;
}

function rollDayIfNeeded() {
  const now = today();
  if (state.date !== now) {
    state.date = now;
    state.place = 0;
    state.route = 0;
    state.geo = 0;
    state.cacheHits = 0;
  }
}

/** 真实上游请求计数（重试也各计一次）；service 由 API 路径推断 */
export function countUpstream(path: string) {
  rollDayIfNeeded();
  if (path.startsWith('/place/')) state.place += 1;
  else if (path.includes('routematrix') || path.includes('direction')) state.route += 1;
  else state.geo += 1;
}

export function countCacheHit() {
  rollDayIfNeeded();
  state.cacheHits += 1;
}

export function usageSnapshot(): UsageSnapshot {
  rollDayIfNeeded();
  const budget = dailyBudget();
  const total = state.place + state.route + state.geo;
  return {
    date: state.date,
    requests: { place: state.place, route: state.route, geo: state.geo, total },
    cacheHits: state.cacheHits,
    dailyBudget: budget,
    overBudget: budget > 0 && total >= budget,
    note: 'local-process-counter'
  };
}

/** 预算触顶判断：provider/批量循环在发起新请求前检查 */
export function overBudget(): boolean {
  return usageSnapshot().overBudget;
}
