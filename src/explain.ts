import type { AnalysisResult } from '../shared/types.js';
import { CATEGORY_MAP } from '../shared/config.js';

/**
 * №20 结果解释助手（模板版）：把评分、盲区、补点建议与数据完整性
 * 翻译成一段段「为什么」的自然语言解释。计算全部来自分析结果本身，
 * 不引入任何模型生成内容；数据不足时如实说「无法解释」，不编造原因。
 */

export function explainResult(r: AnalysisResult): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  const dims = r.score.dims;

  // 1) 总分为什么是这个等级
  const worstDim = (Object.entries(dims) as [string, number | null][])
    .filter(([, v]) => v !== null)
    .sort((a, b) => (a[1] ?? 1) - (b[1] ?? 1))[0];
  const dimNames: Record<string, string> = {
    completeness: '设施完整度', proximity: '临近度', coverage: '人口覆盖率', diversity: '多样性'
  };
  if (worstDim) {
    out.push({
      title: '总分从哪来',
      text: `四维加权后总分 ${r.score.total}（${r.score.grade} 级）。最薄弱维度是「${dimNames[worstDim[0]]}」（${Math.round((worstDim[1] ?? 0) * 100)} 分）——等级主要由它压低；改善它对总分提升最直接。`
    });
  }

  // 2) 完整度低在哪些类别
  const zeroCats = r.score.details.filter((d) => d.completeness === 0 && !d.missingData).map((d) => d.name);
  if (zeroCats.length) {
    out.push({
      title: '缺的是什么',
      text: `「${zeroCats.join('、')}」在检索范围内数量为 0——这是完整度失分的主因。注意口径：检索为零表示本次未查得，现场是否存在仍需核验。`
    });
  }

  // 3) 灰色区域怎么读
  if (r.gap.patches.length) {
    const top = r.gap.patches[0];
    const cats = top.missingCats.map((c) => CATEGORY_MAP[c]?.name ?? c).join('、');
    const cov = r.gap.coverageShare == null
      ? '居住覆盖率无法评估（住宅样本不足）'
      : `覆盖 ${(top.weightShare * 100).toFixed(0)}% 的居住权重`;
    out.push({
      title: '灰色区域怎么读',
      text: `头号灰色斑块「#${top.id}」缺失：${cats}，${cov}。斑块是「步行圈内缺任一核心设施且有权重的连通网格」——它是补点选址的直接依据。`
    });
  } else if (r.incomplete) {
    out.push({ title: '为什么没有灰色区域', text: '检索数据不完整，系统不给结论：不能把「数据缺失」当成「覆盖良好」。' });
  }

  // 4) 补点建议的逻辑
  if (r.planSites.length) {
    const first = r.planSites[0];
    out.push({
      title: '补点建议的逻辑',
      text: `${r.planSites.length} 条建议按贪心最大覆盖排序：每轮选「新增覆盖居住权重最大」的落点。首条建议补建${CATEGORY_MAP[first.category]?.name ?? first.category}（覆盖率 ${first.beforePct}% → ${first.afterPct}%）——采纳后系统会重算剩余建议，收益逐位递减。`
    });
  }

  // 5) 数据完整性如何影响结论
  const unavail = r.assessmentUnavailableCategories ?? [];
  if (r.gap.coverageUnavailable || unavail.length) {
    const names = unavail.map((c) => CATEGORY_MAP[c as keyof typeof CATEGORY_MAP]?.name ?? c).filter(Boolean).slice(0, 4);
    out.push({
      title: '哪些结论被扣住了',
      text: `${names.length ? `「${names.join('、')}」等类别` : '部分类别'}检索不完整${r.gap.coverageUnavailable ? '，且步行范围内未采样到住宅' : ''}——相关类别的缺失判定与完整覆盖率被标记为「无法评估」而不是 0。这是刻意设计：未知 ≠ 缺失。`
    });
  }

  if (!out.length) {
    out.push({ title: '本报告暂无特别解读', text: '各维度均衡、数据完整。建议过街设施扫描与实地核验补充定性判断。' });
  }
  return out;
}
