import { describe, expect, it } from 'vitest';
import { buildIsochroneModel, sampleBearings } from '../shared/isochrone.js';
import { buildTimeField, contourPolylines, marchingSquares, sampleTimeNearest, colorRgbForMinutes } from '../shared/timefield.js';
import { haversineM } from '../shared/geo.js';

const CENTER = { lat: 30.0, lng: 120.0 };

describe('等时圈模型', () => {
  it('全向绕行系数 1.2 时，15 分钟等时圈半径 ≈ 80×15/1.2 = 1000m', () => {
    const dirs = 48;
    const probes = sampleBearings(dirs).map(() => ({ ok: true, distM: 80 * 15 * 1.2 }));
    const model = buildIsochroneModel(CENTER, probes, { dirs, minutes: 15, speed: 80 });
    for (const r of model.radiusM) expect(r).toBeCloseTo(1000, -1);
    expect(model.degradedDirs).toBe(0);
  });

  it('失败方向由谐波模型合成兜底，模型不崩溃', () => {
    const probes = [{ ok: false, distM: 0 }];
    const model = buildIsochroneModel(CENTER, probes, { dirs: 16, minutes: 15, speed: 80 });
    expect(model.degradedDirs).toBe(16);
    expect(model.radiusM.every((r) => r > 500 && r < 1300)).toBe(true);
  });
});

describe('步行时间场', () => {
  it('常系数场中各格时间 = 距离/速度×f', () => {
    const dirs = 48;
    const probes = sampleBearings(dirs).map(() => ({ ok: true, distM: 80 * 15 * 1.25 }));
    const model = buildIsochroneModel(CENTER, probes, { dirs, minutes: 15, speed: 80 });
    const field = buildTimeField(model, { n: 31, cellM: 150 });
    const t = sampleTimeNearest(field, CENTER);
    expect(t).toBeCloseTo(0, 1);
  });

  it('等时环存在且距离中心点距离接近理论半径', () => {
    const dirs = 48;
    const f = 1.25;
    const probes = sampleBearings(dirs).map(() => ({ ok: true, distM: 80 * 15 * f }));
    const model = buildIsochroneModel(CENTER, probes, { dirs, minutes: 15, speed: 80 });
    const field = buildTimeField(model, { n: 61, cellM: 100 });
    const lines = contourPolylines(field, 15);
    expect(lines.length).toBeGreaterThan(0);
    const pts = lines.flat();
    expect(pts.length).toBeGreaterThan(20);
    const dists = pts.map((p) => haversineM(CENTER, p));
    const mean = dists.reduce((a, b) => a + b, 0) / dists.length;
    const theory = (80 * 15) / f;
    expect(Math.abs(mean - theory) / theory).toBeLessThan(0.08);
  });

  it('marching squares 对常量场不产生等值线', () => {
    const vals = new Float64Array(100).fill(5);
    expect(marchingSquares(vals, 10, 3).length).toBe(0);
  });

  it('色带单调（时间越大越暖）', () => {
    const c0 = colorRgbForMinutes(2);
    const c1 = colorRgbForMinutes(14);
    const c2 = colorRgbForMinutes(19);
    expect(c0[1]).toBeGreaterThan(c2[1]); // 绿色 G 分量高
    expect(c2[0]).toBeGreaterThan(c0[0]); // 红色 R 分量高
    expect(c1[0]).toBeGreaterThan(c0[0]);
  });
});
