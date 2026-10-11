import { describe, expect, it } from 'vitest';
import { addCorrection, effectiveStatus, getCorrection, listCorrections, undoCorrection } from '../src/corrections.js';

function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; }
  };
}
const latLng = { lat: 28.46, lng: 117.97 };

describe('设施纠错标注（№10）', () => {
  it('登记→查询→最新生效，历史保留', () => {
    const s = storage();
    addCorrection('u1', '惠民药店', latLng, 'server', '停业', '现场确认关门', s);
    addCorrection('u1', '惠民药店', latLng, 'server', '已核验', '', s);
    const rec = getCorrection('u1', s)!;
    expect(rec.entries.length).toBe(2);
    expect(rec.entries[0].status).toBe('停业');
    expect(rec.entries[0].note).toBe('现场确认关门');
    expect(effectiveStatus('u1', s)?.status).toBe('已核验');
    expect(listCorrections(s).length).toBe(1);
  });

  it('非法状态拒绝登记', () => {
    const s = storage();
    expect(addCorrection('u2', 'x', latLng, 'server', '随意状态' as never, '', s)).toBeNull();
  });

  it('撤销逐条回退，清空后记录移除', () => {
    const s = storage();
    addCorrection('u3', 'a', latLng, 'server', '迁移', '', s);
    addCorrection('u3', 'a', latLng, 'server', '分类错误', '', s);
    expect(undoCorrection('u3', s)?.entries.at(-1)?.status).toBe('迁移');
    expect(undoCorrection('u3', s)).toBeNull();
    expect(getCorrection('u3', s)).toBeNull();
  });
});
