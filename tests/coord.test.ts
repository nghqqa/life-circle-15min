import { describe, expect, it } from 'vitest';
import { bd09ToGcj02, bd09ToWgs84, gcj02ToBd09, gcj02ToWgs84, wgs84ToBd09, wgs84ToGcj02 } from '../shared/coord.js';
import { haversineM, bearingDeg, destination } from '../shared/geo.js';

describe('坐标转换', () => {
  it('WGS84 ↔ GCJ02 往返误差 < 1e-5 度（≈1m，算法固有精度）', () => {
    const p = { lat: 39.906217, lng: 116.3912757 }; // 北京
    const back = gcj02ToWgs84(wgs84ToGcj02(p));
    expect(Math.abs(back.lat - p.lat)).toBeLessThan(1e-5);
    expect(Math.abs(back.lng - p.lng)).toBeLessThan(1e-5);
  });

  it('GCJ02 ↔ BD09 往返误差 < 1e-6 度', () => {
    const p = { lat: 31.24, lng: 121.5 };
    const back = bd09ToGcj02(gcj02ToBd09(p));
    expect(Math.abs(back.lat - p.lat)).toBeLessThan(1e-6);
    expect(Math.abs(back.lng - p.lng)).toBeLessThan(1e-6);
  });

  it('WGS84 → BD09 偏移在合理范围（亚公里级）', () => {
    const p = { lat: 39.906217, lng: 116.3912757 };
    const bd = wgs84ToBd09(p);
    const d = haversineM(p, bd);
    expect(d).toBeGreaterThan(50);
    expect(d).toBeLessThan(2000);
  });

  it('海外坐标不偏移', () => {
    const p = { lat: 35.68, lng: 139.76 }; // 东京
    expect(wgs84ToGcj02(p)).toEqual(p);
  });
});

describe('地理计算', () => {
  it('正北 1km 距离与方位角', () => {
    const a = { lat: 30, lng: 120 };
    const b = destination(a, 0, 1000);
    expect(b.lat).toBeGreaterThan(a.lat);
    expect(haversineM(a, b)).toBeCloseTo(1000, 0);
    expect(bearingDeg(a, b)).toBeCloseTo(0, 3);
  });

  it('正东方位角 ≈ 90°', () => {
    const a = { lat: 30, lng: 120 };
    const b = destination(a, 90, 500);
    expect(bearingDeg(a, b)).toBeCloseTo(90, 2);
  });
});
