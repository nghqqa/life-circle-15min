import type { LatLng } from '../shared/types.js';

/**
 * №10 设施现场核验与纠错标注（浏览器本地登记，append-only 可追溯）：
 * - 人工纠错仅作现场标注，【不参与评分与统计】——避免单人主观修改统计口径；
 * - 每条记录保留原始来源与时间，撤销 = 移除最新一条，历史可追溯。
 */

const PREFIX = 'lc-poi-corrections-v1:';
const STATUSES = ['已核验', '停业', '迁移', '分类错误'] as const;
export type CorrectionStatus = typeof STATUSES[number];

export interface CorrectionEntry {
  status: CorrectionStatus;
  note: string;
  at: string;
}

export interface CorrectionRecord {
  uid: string;
  name: string;
  latLng: LatLng;
  /** 原始来源通道（登记时快照，保留原始来源） */
  source: string;
  entries: CorrectionEntry[];
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

export function correctionStatuses(): readonly CorrectionStatus[] {
  return STATUSES;
}

function key(uid: string): string {
  return `${PREFIX}${uid}`;
}

export function getCorrection(uid: string, storage: StorageLike = localStorage): CorrectionRecord | null {
  try {
    const raw = JSON.parse(storage.getItem(key(uid)) ?? 'null');
    if (!raw || raw.uid !== uid || !Array.isArray(raw.entries)) return null;
    return raw as CorrectionRecord;
  } catch { return null; }
}

export function addCorrection(
  uid: string, name: string, latLng: LatLng, source: string,
  status: CorrectionStatus, note: string, storage: StorageLike = localStorage
): CorrectionRecord | null {
  if (!STATUSES.includes(status)) return null;
  const record = getCorrection(uid, storage) ?? { uid, name, latLng, source, entries: [] };
  record.entries.push({ status, note: String(note ?? '').slice(0, 200), at: new Date().toISOString() });
  try { storage.setItem(key(uid), JSON.stringify(record)); } catch { /* 存储满：标注失败不影响分析 */ }
  return record;
}

/** 撤销最新一条标注（历史即时回退；全部撤销后记录移除） */
export function undoCorrection(uid: string, storage: StorageLike = localStorage): CorrectionRecord | null {
  const record = getCorrection(uid, storage);
  if (!record) return null;
  record.entries.pop();
  if (!record.entries.length) {
    storage.removeItem(key(uid));
    return null;
  }
  try { storage.setItem(key(uid), JSON.stringify(record)); } catch { /* best-effort */ }
  return record;
}

export function listCorrections(storage: StorageLike = localStorage): CorrectionRecord[] {
  const out: CorrectionRecord[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      const rec = getCorrection(k.slice(PREFIX.length), storage);
      if (rec) out.push(rec);
    }
  } catch { /* best-effort */ }
  return out;
}

/** 最新生效标注（用于弹窗徽标与报告统计） */
export function effectiveStatus(uid: string, storage: StorageLike = localStorage): CorrectionEntry | null {
  const rec = getCorrection(uid, storage);
  return rec?.entries.length ? rec.entries[rec.entries.length - 1] : null;
}
