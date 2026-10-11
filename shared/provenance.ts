import { CATEGORIES, PERSONAS, THRESHOLDS } from './config.js';
import type { ChannelName, PoiSearchCompleteness } from './types.js';

/** Bump these when algorithms or interpretation rules change. */
export const APPLICATION_VERSION = '0.1.0+project-data-v1';
export const ALGORITHM_VERSION = 'timefield-grid-v1';
export const RULE_VERSION = 'life-circle-v2-data-completeness';

export interface AnalysisProvenance {
  schemaVersion: 1;
  reportId: string;
  generatedAt: string;
  applicationVersion: string;
  algorithmVersion: string;
  ruleVersion: string;
  ruleFingerprint: string;
  coordinateSystem: 'BD-09';
  populationBasis: 'residential-poi-proxy';
  channels: ChannelName[];
  mock: boolean;
  /** POI acquisition time; route cache acquisition times are not yet available. */
  poiCollectedAt: string | null;
  poiCacheHits: number;
  poiQueries: number;
}

/** A deterministic configuration identifier, not a security signature. */
export function ruleFingerprint(): string {
  const text = JSON.stringify({ categories: CATEGORIES, personas: PERSONAS, thresholds: THRESHOLDS, rule: RULE_VERSION });
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function createProvenance(input: {
  generatedAt: string;
  poiSearch?: PoiSearchCompleteness[];
  channels: ChannelName[];
  mock: boolean;
}): AnalysisProvenance {
  const searches = input.poiSearch ?? [];
  const dates = searches.filter((s) => s.pagesFetched > 0 && Number.isFinite(Date.parse(s.collectedAt)))
    .map((s) => s.collectedAt).sort();
  return {
    schemaVersion: 1,
    reportId: globalThis.crypto?.randomUUID?.() ?? `report_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
    generatedAt: input.generatedAt,
    applicationVersion: APPLICATION_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    ruleVersion: RULE_VERSION,
    ruleFingerprint: ruleFingerprint(),
    coordinateSystem: 'BD-09',
    populationBasis: 'residential-poi-proxy',
    channels: [...new Set([...input.channels, ...searches.map((s) => s.source)])],
    mock: input.mock,
    poiCollectedAt: dates[0] ?? null,
    poiCacheHits: searches.filter((s) => s.cacheHit).length,
    poiQueries: searches.length
  };
}
