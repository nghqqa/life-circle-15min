/**
 * №16 分时段生活圈：解析百度商户申报的营业时间字符串，判断某时刻是否营业。
 *
 * 口径纪律：商户申报数据可能缺失、格式不规范或过期——解析不出时返回 unknown，
 * 绝不默认「全天营业」。星期限定（如「周一至周五」）暂不解析，按每日适用处理并在
 * 结果中注明「以商户申报为准」。
 */

export interface OpenHoursResult {
  /** 'open' | 'closed' | 'unknown' */
  status: 'open' | 'closed' | 'unknown';
  /** 原始申报文本（来源） */
  raw: string | null;
  /** 解析出的时段列表（HH:MM 分钟数），仅 status != unknown 时有意义 */
  ranges: [number, number][];
  note: string;
}

const RANGE_RE = /(\d{1,2})[:：](\d{2})\s*[-–—~至]\s*(\d{1,2})[:：](\d{2})/g;

export function parseOpenHours(raw: string | null | undefined, now: Date = new Date()): OpenHoursResult {
  const text = (raw ?? '').trim();
  if (!text) return { status: 'unknown', raw: null, ranges: [], note: '商户未申报营业时间：未知 ≠ 全天营业' };
  if (/全天|24\s*小时|24h/i.test(text)) return { status: 'open', raw: text, ranges: [[0, 1440]], note: '商户申报全天营业' };
  const ranges: [number, number][] = [];
  for (const m of text.matchAll(RANGE_RE)) {
    const [, h1, m1, h2, m2] = m;
    const start = Number(h1) * 60 + Number(m1);
    let end = Number(h2) * 60 + Number(m2);
    if (Number(h1) > 23 || Number(m1) > 59 || Number(h2) > 23 || Number(m2) > 59) continue;
    if (end === 0) end = 1440; // 00:00 视为当日午夜
    if (end > start) ranges.push([start, end]);
  }
  if (!ranges.length) return { status: 'unknown', raw: text, ranges: [], note: '营业时间格式未识别：未知 ≠ 全天营业' };
  const minutes = now.getHours() * 60 + now.getMinutes();
  const open = ranges.some(([s, e]) => minutes >= s && minutes < e);
  return {
    status: open ? 'open' : 'closed',
    raw: text,
    ranges,
    note: `按商户申报时段判断（${text}），以商户实际营业为准`
  };
}
