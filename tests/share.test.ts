import { describe, expect, it, vi } from 'vitest';

describe('№18 分享存储', () => {
  it('保存/读取/容量 FIFO 淘汰/体积限制', async () => {
    vi.resetModules();
    vi.useRealTimers();
    process.env.SHARE_STORE_FILE = '.test-share-store.json';
    const { saveShare, getShare } = await import('../server/src/share.js');
    expect(saveShare('not json')).toEqual({ error: '报告内容不是合法 JSON' });
    expect(saveShare(JSON.stringify({ data: 'x'.repeat(1025 * 1024) })).error).toContain('分享上限');
    const first = saveShare('{"a":1}') as { id: string };
    expect(getShare(first.id)?.report).toEqual({ a: 1 });
    for (let i = 0; i < 105; i++) saveShare(`{"i":${i}}`);
    expect(getShare(first.id)).toBeNull(); // FIFO 淘汰
    const fs = await import('node:fs');
    const stored = JSON.parse(fs.readFileSync('.test-share-store.json', 'utf8'));
    expect(Object.keys(stored).length).toBeLessThanOrEqual(100);
  });
});
