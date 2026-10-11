import { buildIsochroneModel, buildTimeField, generateMockPois, analyzeGaps, computeScore, buildChecklist,
  planFacilitiesFromCoverage, contourPolylines, type AnalysisResult } from '../../shared/index.js';
import { createProvenance } from '../../shared/provenance.js';

export function comparisonFixture(): AnalysisResult {
  const center = { lat: 28.46, lng: 117.97 };
  const model = buildIsochroneModel(center, Array.from({ length: 16 }, () => ({ ok: true, distM: 1320 })), { dirs: 16, minutes: 15, speed: 80 });
  const field = buildTimeField(model, { n: 21, cellM: 120 });
  const pois = generateMockPois(center).filter(p => p.category !== 'pharmacy' && p.category !== 'primarySchool');
  const gap = analyzeGaps(field, pois), generatedAt = '2026-10-11T00:00:00.000Z';
  return { center, centerName: '离线方案验收社区', persona: 'adult', minutes: 15, generatedAt, model, field,
    rings: [5, 10, 15].map(level => ({ level, lines: contourPolylines(field, level) })), pois, gap,
    score: computeScore(center, pois, gap), checklist: buildChecklist(center, pois),
    planSites: planFacilitiesFromCoverage(gap, gap.coveredMasks, field, 80), crossings: null, steps: [], mock: true,
    provenance: createProvenance({ generatedAt, channels: ['mock'], mock: true }) };
}
