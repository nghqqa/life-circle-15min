import { describe, expect, it } from 'vitest';
import { facilityCsv, makeCsv, weakCommunityCsv, printableReport, reportMapSvg } from '../src/exports.js';
import { captureScenario } from '../shared/comparison.js';
import { comparisonFixture } from './fixtures/comparison.js';

describe('成果导出', () => {
  it('CSV兼容中文、引号、逗号、换行，并防止名称成为表格公式', () => {
    expect(makeCsv([['药店,"甲"\n乙', '=1+1', '  @SUM(1)', '\tcommand', '-text', -3, null]]))
      .toBe('\ufeff"药店,""甲""\n乙","\'=1+1","\'  @SUM(1)","\'\tcommand","\'-text","-3",""\r\n');
  });
  it('设施清单保留样本口径、来源、坐标系、中文名称和规则', () => {
    const r = comparisonFixture(), csv = facilityCsv(r);
    expect(csv).toContain(r.pois[0].name); expect(csv).toContain('BD-09');
    expect(csv).toContain('非圈内全量'); expect(csv).toContain('含演示数据');
    expect(csv).toContain(r.provenance!.ruleFingerprint); expect(csv).toContain('未记录完整性');
  });
  it('薄弱社区按评分或有效覆盖率筛选，未知覆盖不等于零，失败样本不参与排名', () => {
    const base = { center: { lat: 28, lng: 118 }, grade: 'B', dominantMissing: null };
    const csv = weakCommunityCsv([
      { ...base, name: '分数不足', score: 70, coverageShare: null },
      { ...base, name: '覆盖不足', score: 90, coverageShare: .6 },
      { ...base, name: '未知不是低覆盖', score: 90, coverageShare: null },
      { ...base, name: '不可用不能作数', score: 90, coverageShare: 0, coverageUnavailable: true },
      { ...base, name: '失败', score: -1, coverageShare: 0, error: '失败' },
      { ...base, name: '正常', score: 90, coverageShare: .95 }
    ], 'job', '2026-10-11T00:00:00Z');
    expect(csv).toContain('分数不足'); expect(csv).toContain('覆盖不足'); expect(csv).toContain('无法评估');
    expect(csv).not.toContain('未知不是低覆盖'); expect(csv).not.toContain('不可用不能作数'); expect(csv).not.toContain('"失败"'); expect(csv).not.toContain('正常');
    expect(csv).toContain('"5","1"');
  });
  it('报告包含地图、指标、选择和来源，正确区分当前选择与记录方案', () => {
    const r = comparisonFixture(), a = captureScenario(r, { acceptedSites: [r.planSites[0]], rejectedSites: [r.planSites[1]] });
    const report = printableReport(r, { acceptedSites: [], rejectedSites: [], scenarios: { A: a } });
    for (const required of ['<svg', '方案 A 已采纳（1 处）', '当前已采纳（0 处）', '方案 B 尚未记录', '数据来源', '演示数据', r.provenance!.reportId, 'BD-09', '非实际人口数']) expect(report).toContain(required);
    expect(report.replaceAll('http://www.w3.org/2000/svg', '')).not.toMatch(/<img|https?:\/\//);
  });
  it('名称、说明与POI中的HTML不能执行，矢量图不请求底图', () => {
    const r = comparisonFixture(), attack = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    r.centerName = attack; r.warnings = [attack]; r.pois[0].name = attack;
    const report = printableReport(r, { acceptedSites: [], rejectedSites: [] });
    expect(report).not.toContain(attack); expect(report).toContain('&lt;script&gt;');
    expect((report.match(/<script>/g) ?? []).length).toBe(1);
    expect(reportMapSvg(r, [])).not.toContain('<image');
  });
});
