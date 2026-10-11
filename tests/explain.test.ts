import { describe, expect, it } from 'vitest';
import { explainResult } from '../src/explain.js';
import { comparisonFixture } from './fixtures/comparison.js';

describe('结果解释助手（№20 模板版）', () => {
  it('从真实分析结果生成「总分从哪来」等解释，且引用真实数字', () => {
    const r = comparisonFixture();
    const sections = explainResult(r);
    expect(sections.length).toBeGreaterThan(0);
    const total = sections.find((s) => s.title === '总分从哪来');
    expect(total?.text).toContain(`总分 ${r.score.total}`);
    for (const s of sections) {
      expect(s.text).not.toMatch(/\bTODO\b/);
      expect(s.text.length).toBeGreaterThan(10);
    }
  });

  it('数据不完整时明确解释「被扣住的结论」，不编造原因', () => {
    const r = comparisonFixture();
    r.gap.coverageUnavailable = true;
    r.gap.coverageShare = null;
    r.assessmentUnavailableCategories = ['pharmacy', 'residential'];
    r.incomplete = true;
    const sections = explainResult(r);
    const held = sections.find((s) => s.title === '哪些结论被扣住了');
    expect(held?.text).toContain('无法评估');
    expect(held?.text).toContain('未知 ≠ 缺失');
  });
});
