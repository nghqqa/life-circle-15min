import { describe, expect, it } from 'vitest';
import { parseOpenHours } from '../src/openHours.js';

const at = (h: number, m = 0) => new Date(2026, 9, 12, h, m);

describe('营业时段解析（№16）', () => {
  it('标准区间：按时段判定营业中/未营业', () => {
    expect(parseOpenHours('10:00-22:00', at(12)).status).toBe('open');
    expect(parseOpenHours('10:00-22:00', at(8)).status).toBe('closed');
  });

  it('多时段与中文分隔符', () => {
    expect(parseOpenHours('11:30～14:00，17:00–21:30', at(18)).status).toBe('open');
    expect(parseOpenHours('11:30～14:00，17:00–21:30', at(15)).status).toBe('closed');
  });

  it('全天/24小时视为营业', () => {
    expect(parseOpenHours('全天', at(3)).status).toBe('open');
    expect(parseOpenHours('24小时', at(23)).status).toBe('open');
  });

  it('缺失与不可解析一律 unknown，不默认全天营业', () => {
    expect(parseOpenHours(null, at(12)).status).toBe('unknown');
    expect(parseOpenHours('', at(12)).status).toBe('unknown');
    expect(parseOpenHours('电话咨询', at(12)).status).toBe('unknown');
    expect(parseOpenHours('电话咨询', at(12)).note).toContain('未知 ≠ 全天营业');
  });

  it('跨午夜 00:00 结束视为 1440', () => {
    expect(parseOpenHours('18:00-00:00', at(23)).status).toBe('open');
  });
});
