import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * №18 只读分享：固定版本报告快照（含 provenance），只读页面不含任何交互与 AK。
 * 存储上限 100 份（FIFO 淘汰），单份 ≤ 300KB。
 */

const SHARE_PATH = path.resolve(process.env.SHARE_STORE_FILE ?? '.share-store.json');
const MAX_SHARES = 100;
const MAX_BYTES = 1024 * 1024; // 审查修复：默认规模报告约 300-600KB，300KB 上限会直接分享失败

interface ShareEntry { id: string; at: number; report: unknown }

function load(): Record<string, ShareEntry> {
  try {
    if (!existsSync(SHARE_PATH)) return {};
    return JSON.parse(readFileSync(SHARE_PATH, 'utf8'));
  } catch { return {} }
}

function save(all: Record<string, ShareEntry>) {
  try { writeFileSync(SHARE_PATH, JSON.stringify(all)); } catch { /* 存储失败由路由报错 */ }
}

function newId(): string {
  return `sh_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function saveShare(reportText: string): { id: string } | { error: string } {
  if (Buffer.byteLength(reportText) > MAX_BYTES) return { error: `报告超过 ${Math.round(MAX_BYTES / 1024)}KB 分享上限` };
  let report: unknown;
  try { report = JSON.parse(reportText); } catch { return { error: '报告内容不是合法 JSON' }; }
  const all = load();
  const entries = Object.entries(all).sort((a, b) => a[1].at - b[1].at);
  while (entries.length >= MAX_SHARES) {
    const [oldest] = entries.shift()!;
    delete all[oldest];
  }
  const id = newId();
  all[id] = { id, at: Date.now(), report };
  save(all);
  return { id };
}

export function getShare(id: string): ShareEntry | null {
  const all = load();
  return all[id] ?? null;
}

/** 只读页面的最小转义（服务端渲染用，不依赖浏览器端代码） */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** 只读页面服务端渲染（404 亦返回完整 HTML） */
export function renderShareHtml(id: string): string {
  const entry = getShare(id);
  if (!entry) {
    return '<html><body style="font-family:sans-serif"><h3>分享不存在或已被清理</h3></body></html>';
  }
  const r = (entry.report ?? {}) as any;
  const dims = r.score?.dims ?? {};
  const warnings: string[] = r.warnings ?? [];
  const pct = (v: unknown) => typeof v === 'number' ? `${Math.round(v * 100)} 分` : '—';
  return `<html><head><meta charset="utf-8"><title>圈点 · 只读报告</title>
    <style>body{font-family:system-ui,'Microsoft YaHei',sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#1c2333}
    .card{background:#f4f6f9;border-radius:10px;padding:14px 18px;margin:12px 0}
    .kpi{display:inline-block;margin-right:18px;text-align:center}.kpi b{display:block;font-size:22px}
    .muted{color:#65758d;font-size:12px}.grade{font-size:34px;font-weight:700;color:${r.score?.grade === 'C' || r.score?.grade === 'D' ? '#f08c00' : '#e03131'}}</style></head><body>
    <h2>圈点 · 15 分钟生活圈 只读报告</h2>
    <p><b>${escapeHtml(String(r.centerName ?? '未命名中心'))}</b> · ${escapeHtml(String(r.persona ?? ''))} · ${escapeHtml(String(r.minutes ?? ''))} 分钟 · 生成于 ${escapeHtml(String(r.generatedAt ?? ''))}</p>
    <div class="card"><span class="grade">${escapeHtml(String(r.score?.grade ?? ''))} ${escapeHtml(String(r.score?.total ?? ''))}</span> 分
      <div class="kpi"><b>${pct(dims.completeness)}</b>完整度</div>
      <div class="kpi"><b>${pct(dims.proximity)}</b>临近度</div>
      <div class="kpi"><b>${dims.coverage == null ? '—' : pct(dims.coverage)}</b>人口覆盖率</div>
      <div class="kpi"><b>${pct(dims.diversity)}</b>多样性</div>
    </div>
    <div class="card"><b>诊断</b><br/>${escapeHtml(String(r.score?.summary ?? '—'))}</div>
    ${warnings.length ? `<div class="card"><b>口径与警告</b><ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>` : ''}
    <div class="card"><b>数据与规则</b><br/><span class="muted">应用 ${escapeHtml(String(r.provenance?.applicationVersion ?? '—'))} · 规则 ${escapeHtml(String(r.provenance?.ruleVersion ?? '—'))} · 指纹 ${escapeHtml(String(r.provenance?.ruleFingerprint ?? '—'))} · 坐标系 ${escapeHtml(String(r.provenance?.coordinateSystem ?? 'BD-09'))}<br/>
    本页为固定版本只读快照：不含交互与实时数据；人工纠错标注未计入评分；覆盖率基于住宅 POI 代理而非真实人口。</span></div>
    </body></html>`;
}
