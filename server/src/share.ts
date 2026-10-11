import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * №18 只读分享：固定版本报告快照（含 provenance），只读页面不含任何交互与 AK。
 * 存储上限 100 份（FIFO 淘汰），单份 ≤ 300KB。
 */

const SHARE_PATH = path.resolve(process.env.SHARE_STORE_FILE ?? '.share-store.json');
const MAX_SHARES = 100;
const MAX_BYTES = 300 * 1024;

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
