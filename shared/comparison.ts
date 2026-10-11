import { CORE_CATEGORIES } from './config.js';
import { applySiteCoverage } from './planner.js';
import { APPLICATION_VERSION, ALGORITHM_VERSION, RULE_VERSION, ruleFingerprint } from './provenance.js';
import type { AnalysisResult, PlanSite } from './types.js';

export type ScenarioSlot = 'A' | 'B';
export interface PlanScenario {
  baselineKey: string;
  savedAt: string;
  acceptedSites: PlanSite[];
  rejectedSites: PlanSite[];
}
export type PlanScenarios = Partial<Record<ScenarioSlot, PlanScenario>>;
export interface PlanMetrics {
  siteCount: number;
  coverage: number | null;
  gainPoints: number | null;
  remainingCells: number | null;
  remainingShare: number | null;
  reason?: string;
}
export function currentPlanningRules(r: AnalysisResult): boolean {
  const p = r.provenance;
  return !!p && p.applicationVersion === APPLICATION_VERSION && p.algorithmVersion === ALGORITHM_VERSION &&
    p.ruleVersion === RULE_VERSION && p.ruleFingerprint === ruleFingerprint();
}

/** Content identifier for accidental mixing, not an authenticity/security signature. */
export function comparisonBaseline(r: AnalysisResult): string {
  const text = JSON.stringify([r.center, r.persona, r.minutes, r.generatedAt, r.provenance, r.model,
    r.field, r.gap, r.pois, r.poiSearch, r.assessmentUnavailableCategories, r.failedCategories, r.incompleteCategories],
  (_key, v) => v instanceof Float64Array || v instanceof Uint8Array
    ? Array.from(v, x => Number.isNaN(x) ? 'NaN' : x === Infinity ? 'Infinity' : x)
    : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return `baseline-v1-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
}
export function captureScenario(r: AnalysisResult, state: { acceptedSites: PlanSite[]; rejectedSites: PlanSite[] }): PlanScenario {
  return { baselineKey: comparisonBaseline(r), savedAt: new Date().toISOString(),
    acceptedSites: structuredClone(state.acceptedSites), rejectedSites: structuredClone(state.rejectedSites) };
}
export function measurePlan(r: AnalysisResult, sites: PlanSite[], baselineKey = comparisonBaseline(r)): PlanMetrics {
  const unique = [...new Map(sites.map(s => [`${s.category}:${s.latLng.lat}:${s.latLng.lng}`, s])).values()];
  const unavailable = (reason: string): PlanMetrics => ({ siteCount: unique.length, coverage: null, gainPoints: null, remainingCells: null, remainingShare: null, reason });
  if (baselineKey !== comparisonBaseline(r)) return unavailable('社区、数据或规则不同，不能比较；请在同一次体检中重新记录方案。');
  if (!currentPlanningRules(r)) return unavailable('历史规则与当前版本不同，请重新体检后比较。');
  const unknown = new Set([...r.gap.unknownCategories, ...(r.assessmentUnavailableCategories ?? []), ...(r.failedCategories ?? []), ...(r.incompleteCategories ?? [])]);
  if (r.gap.coverageUnavailable || r.gap.coverageShare === null || unknown.has('residential') || CORE_CATEGORIES.some(c => unknown.has(c))) {
    return unavailable('住宅样本不足或核心设施数据不完整，覆盖改善无法评估。');
  }
  if (unique.some(s => !CORE_CATEGORIES.includes(s.category))) return unavailable('方案包含当前模型不支持的补点类别。');
  const before = r.gap.coveredMasks;
  const after = Object.fromEntries(CORE_CATEGORIES.map(c => [c, Uint8Array.from(before[c])]));
  for (const s of unique) applySiteCoverage(after, s.category, s.latLng, r.field);
  let total = 0, original = 0, covered = 0, remainingCells = 0;
  for (let i = 0; i < r.gap.weightGrid.length; i++) {
    const w = r.gap.weightGrid[i];
    if (w <= 0) continue;
    total += w;
    if (CORE_CATEGORIES.every(c => before[c][i] === 1)) original += w;
    if (CORE_CATEGORIES.every(c => after[c][i] === 1)) covered += w;
    else remainingCells++;
  }
  if (total <= 0) return unavailable('无有效住宅权重样本，覆盖改善无法评估。');
  return { siteCount: unique.length, coverage: covered / total, gainPoints: (covered - original) / total * 100,
    remainingCells, remainingShare: (total - covered) / total };
}
