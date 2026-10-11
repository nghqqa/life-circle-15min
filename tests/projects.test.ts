import { describe, expect, it } from 'vitest';
import { buildIsochroneModel } from '../shared/isochrone.js';
import { buildTimeField } from '../shared/timefield.js';
import { generateMockPois } from '../shared/mock.js';
import { analyzeGaps } from '../shared/gap.js';
import { computeScore } from '../shared/scoring.js';
import { buildChecklist } from '../shared/checklist.js';
import { applySiteCoverage, planFacilitiesFromCoverage } from '../shared/planner.js';
import { createProvenance } from '../shared/provenance.js';
import type { AnalysisResult, PersonaId } from '../shared/types.js';
import { PERSONA_MAP } from '../shared/config.js';
import { createProject, parseProject, serializeProject, ProjectStore, ProjectError, PROJECT_STORAGE_KEY, MAX_PROJECT_BYTES } from '../src/projects.js';

function analysis(noHomes = false, persona: PersonaId = 'adult'): AnalysisResult {
  const center = { lat: 28.46, lng: 117.97 };
  const speed = PERSONA_MAP[persona].speed;
  const model = buildIsochroneModel(center, Array.from({ length: 16 }, () => ({ ok: true, distM: 1320 })), { dirs: 16, minutes: 15, speed });
  const field = buildTimeField(model, { n: 21, cellM: 120 });
  const pois = generateMockPois(center).filter(p => p.category !== 'pharmacy' && p.category !== 'primarySchool' && (!noHomes || p.category !== 'residential'));
  const gap = analyzeGaps(field, pois);
  const generatedAt = '2026-10-11T00:00:00.000Z';
  return { center, centerName: '测试社区', persona, minutes: 15, generatedAt, model, field, rings: [], pois, gap,
    score: computeScore(center, pois, gap), checklist: buildChecklist(center, pois), planSites: planFacilitiesFromCoverage(gap, gap.coveredMasks, field, speed),
    crossings: null, steps: [{ name: '离线测试', usage: { channel: 'mock', ms: 1 } }], mock: true,
    provenance: createProvenance({ generatedAt, channels: ['mock'], mock: true }),
    poiSearch: [{ keyword: '药店', category: 'pharmacy', status: 'truncated', reportedTotal: 30, rawCount: 20, fetchedCount: 20, pagesFetched: 1, pageSize: 20, pageLimit: 1, quotaExhausted: false, collectedAt: generatedAt, cacheHit: false, source: 'mock', reason: '受控测试' }],
    incompleteCategories: ['pharmacy'], assessmentUnavailableCategories: ['pharmacy'] };
}
function project() {
  const r = analysis();
  return createProject(r, { acceptedSites: [r.planSites[0]], rejectedSites: [r.planSites[1]] }, '社区改造方案');
}
class MemoryStorage {
  values = new Map<string, string>(); fail = false;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (this.fail) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; }
    this.values.set(key, value);
  }
  removeItem(key: string) { this.values.delete(key); }
}
function suggestions(p: ReturnType<typeof project>) {
  const r = p.result, masks = Object.fromEntries(Object.entries(r.gap.coveredMasks).map(([k, v]) => [k, Uint8Array.from(v)]));
  for (const s of p.workbench.acceptedSites) applySiteCoverage(masks, s.category, s.latLng, r.field);
  const skipped = new Set(p.workbench.rejectedSites.map(s => `${s.category}:${s.latLng.lat}:${s.latLng.lng}`));
  return planFacilitiesFromCoverage(r.gap, masks, r.field, r.model.speed).filter(s => !skipped.has(`${s.category}:${s.latLng.lat}:${s.latLng.lng}`));
}

describe('完整项目快照', () => {
  it('恢复 typed arrays、圈外 NaN/Infinity、采纳与跳过，并可重新计算和撤销', () => {
    const original = project();
    expect(original.workbench.acceptedSites[0]).toBeDefined();
    expect(original.workbench.rejectedSites[0]).toBeDefined();
    original.result.field.t[0] = NaN; original.result.field.t[1] = Infinity;
    const restored = parseProject(serializeProject(original));
    expect(restored.result.field.t).toBeInstanceOf(Float64Array);
    expect(restored.result.gap.weightGrid).toBeInstanceOf(Float64Array);
    expect(restored.result.gap.missingGrid).toBeInstanceOf(Uint8Array);
    expect(restored.result.gap.coveredMasks.pharmacy).toBeInstanceOf(Uint8Array);
    expect(Number.isNaN(restored.result.field.t[0])).toBe(true);
    expect(restored.result.field.t[1]).toBe(Infinity);
    expect(restored.workbench).toEqual(original.workbench);
    expect(suggestions(restored)).toEqual(suggestions(original));
    restored.workbench.acceptedSites = []; restored.workbench.rejectedSites = [];
    expect(suggestions(restored)).toEqual(original.result.planSites);
  });
  it('无住宅样本覆盖率仍是 null，不被转换成 0 或 100%', () => {
    const r = analysis(true), saved = createProject(r, { acceptedSites: [], rejectedSites: [] }, '无样本');
    const restored = parseProject(serializeProject(saved));
    expect(restored.result.gap.coverageShare).toBeNull();
    expect(restored.result.gap.severeShare).toBeNull();
    expect(restored.result.score.dims.coverage).toBeNull();
    expect(restored.result.gap.coverageUnavailable).toBe(true);
  });
  it('保存数据来源、分页完整性和版本；显式白名单丢弃配置/敏感扩展字段', () => {
    const p = project();
    Object.assign(p.result, { serverAk: 'must-not-export', gateway: { token: 'must-not-export' } });
    Object.assign(p.result.provenance!, { privateConfig: 'must-not-export' });
    Object.assign(p.result.pois[0], { secret: 'must-not-export' });
    const serialized = serializeProject(p), restored = parseProject(serialized);
    expect(serialized).not.toContain('must-not-export');
    expect(restored.result.provenance?.ruleFingerprint).toBe(p.result.provenance?.ruleFingerprint);
    expect(restored.result.poiSearch).toEqual(p.result.poiSearch);
    expect(restored.result.incompleteCategories).toEqual(['pharmacy']);
    expect(restored.result.assessmentUnavailableCategories).toEqual(['pharmacy']);
  });
  it.each(['{broken', '{"centerName":"旧报告摘要","score":{"total":70}}', '{"format":"life-circle-project","schemaVersion":2}'])('拒绝坏文件/摘要/未来格式：%s', (text) => {
    expect(() => parseProject(text)).toThrow(ProjectError);
  });
  it('拒绝在累积机会的设施类别中注入 HTML', () => {
    const p = JSON.parse(serializeProject(project()));
    p.result.cumulative = { total: 0, byCategory: {}, categoriesCovered: 0, missingCategories: ['<img src=x onerror=alert(1)>'] };
    expect(() => parseProject(JSON.stringify(p))).toThrow(/cumulative.missingCategories/);
    p.result.cumulative.missingCategories = ['pharmacy'];
    expect(parseProject(JSON.stringify(p)).result.cumulative?.missingCategories).toEqual(['pharmacy']);
  });
  it.each([
    ['模型中心', (p: any) => { p.result.model.center.lat += 0.1; }],
    ['网格中心', (p: any) => { p.result.field.center.lng += 0.1; }],
    ['报告中心', (p: any) => { p.result.center.lat += 0.1; }],
    ['模型时长', (p: any) => { p.result.model.minutes = 10; }],
    ['网格时长', (p: any) => { p.result.field.minutes = 10; }],
    ['报告时长', (p: any) => { p.result.minutes = 10; }],
    ['模型步速', (p: any) => { p.result.model.speed = 52; }],
    ['网格步速', (p: any) => { p.result.field.speed = 52; }],
    ['人群', (p: any) => { p.result.persona = 'elderly'; }],
    ['两个步速与人群不符', (p: any) => { p.result.model.speed = p.result.field.speed = 52; }],
    ['网格间距', (p: any) => { p.result.gap.cellM += 1; }]
  ])('拒绝跨字段参数不一致：%s', (_label, change) => {
    const p = JSON.parse(serializeProject(project()));
    change(p);
    expect(() => parseProject(JSON.stringify(p))).toThrow(/不一致/);
  });
  it.each(['adult', 'elderly', 'child'] as const)('合法 %s 人群项目恢复仍使用原有步速', persona => {
    const r = analysis(false, persona), p = createProject(r, { acceptedSites: [], rejectedSites: [] }, '参数一致');
    const restored = parseProject(serializeProject(p));
    expect(restored.result.persona).toBe(persona);
    expect(restored.result.model.speed).toBe(PERSONA_MAP[persona].speed);
    expect(restored.result.field.speed).toBe(PERSONA_MAP[persona].speed);
  });
  it.each(['historical', 'no-provenance'] as const)('允许 %s 项目按其原始 75 m/min 步速只读恢复', mode => {
    const p = project();
    p.result.model.speed = 75; p.result.field.speed = 75;
    if (mode === 'historical') {
      p.result.provenance!.applicationVersion = '0.0.9';
      p.result.provenance!.ruleFingerprint = 'previous-rules';
    } else delete p.result.provenance;
    const restored = parseProject(serializeProject(p));
    expect(restored.result.model.speed).toBe(75);
    expect(restored.result.field.speed).toBe(75);
    expect(restored.result.persona).toBe('adult');
  });
  it('拒绝尺寸错配、非法掩码、错误类别和危险属性', () => {
    const valid = JSON.parse(serializeProject(project()));
    for (const change of [
      (p: any) => { p.result.field.n = 50000; },
      (p: any) => { p.result.field.t.pop(); },
      (p: any) => { p.result.gap.coveredMasks.pharmacy[0] = 9; },
      (p: any) => { p.result.gap.patches[0].cells[0] = 999999; },
      (p: any) => { p.result.pois[0].category = 'constructor'; }
    ]) {
      const p = structuredClone(valid); change(p);
      expect(() => parseProject(JSON.stringify(p))).toThrow(ProjectError);
    }
    expect(() => parseProject('{"__proto__":{"polluted":true}}')).toThrow(ProjectError);
    expect(({} as any).polluted).toBeUndefined();
    expect(() => parseProject(' '.repeat(MAX_PROJECT_BYTES + 1))).toThrow(/过大/);
  });
});

describe('本地项目库', () => {
  it('多中文项目按相同 UTF-16 容量规则写入和读回，不因 UTF-8 长度较大误判损坏', () => {
    const storage = new MemoryStorage(), store = new ProjectStore(storage), p = project();
    p.result.pois = Array.from({ length: 2500 }, (_, i) => ({ ...p.result.pois[0], uid: `chinese-${i}`, name: '中'.repeat(550) }));
    store.save(p);
    const raw = storage.getItem(PROJECT_STORAGE_KEY)!;
    expect(raw.length * 2).toBeLessThan(4 * 1024 * 1024);
    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(4 * 1024 * 1024);
    expect(new ProjectStore(storage).list()[0].id).toBe(p.id);
    expect(new ProjectStore(storage).load(p.id).result.pois[2499].name).toBe('中'.repeat(550));
  });
  it('新增、重命名、重新打开、最近项目恢复与删除', () => {
    const storage = new MemoryStorage(), store = new ProjectStore(storage), p = project();
    expect(store.recent()).toBeNull(); store.save(p);
    const reloaded = new ProjectStore(storage);
    expect(reloaded.recent()?.id).toBe(p.id);
    expect(reloaded.load(p.id).workbench).toEqual(p.workbench);
    expect(reloaded.rename(p.id, '第二版').name).toBe('第二版');
    expect(reloaded.list()[0].name).toBe('第二版');
    const second = createProject(analysis(), { acceptedSites: [], rejectedSites: [] }, '另一社区');
    reloaded.save(second); reloaded.setRecent(p.id);
    expect(reloaded.recent()?.id).toBe(p.id);
    reloaded.remove(p.id); expect(reloaded.recent()).toBeNull();
    expect(reloaded.list().map(x => x.id)).toEqual([second.id]);
    expect(() => reloaded.load(p.id)).toThrow(/找不到/);
  });
  it('容量失败保留旧项目与最近 ID，待保存快照仍可下载', () => {
    const storage = new MemoryStorage(), store = new ProjectStore(storage), p = project(); store.save(p);
    const oldBytes = storage.getItem(PROJECT_STORAGE_KEY);
    const updated = createProject(p.result, p.workbench, '尚未保存', p);
    storage.fail = true;
    expect(() => store.save(updated)).toThrow(/未保存/);
    expect(storage.getItem(PROJECT_STORAGE_KEY)).toBe(oldBytes);
    expect(store.load(p.id).name).toBe('社区改造方案');
    expect(parseProject(serializeProject(updated)).name).toBe('尚未保存');
  });
  it('存储损坏时不自动清空或覆盖已有数据', () => {
    const storage = new MemoryStorage(); storage.setItem(PROJECT_STORAGE_KEY, '{corrupt');
    const store = new ProjectStore(storage);
    expect(() => store.list()).toThrow(/损坏/);
    expect(() => store.save(project())).toThrow(/损坏/);
    expect(storage.getItem(PROJECT_STORAGE_KEY)).toBe('{corrupt');
  });
  it('浏览器禁止本地存储时给出明确失败，不显示保存成功', () => {
    const store = new ProjectStore({ getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() {} });
    expect(() => store.save(project())).toThrow(/读取/);
  });
});
