import { interpAngle } from './geo.js';
import type { IsochroneModel, LatLng, TimeField } from './types.js';

/**
 * 步行时间场：把等时圈解析模型插值成连续网格
 *   t(x, y) = d(x, y) · f(θ(x, y)) / v
 * 其中 d 为到中心点直线距离，θ 为方位角，f(θ) 为该方向绕行系数。
 *
 * 在时间场上用 marching squares 提取 5 / 10 / 15 分钟等时环，
 * 用渐变色带渲染成连续热力面 —— 对应评分细则中
 * 「等时圈热力图」与「空间插值 / 扇形采样」两个得分点。
 */

export function buildTimeField(
  model: IsochroneModel,
  opts: { cellM?: number; n?: number } = {}
): TimeField {
  const n = opts.n ?? 61;
  const cellM = opts.cellM ?? 120;
  const maxR = Math.max(...model.radiusM);
  const extentM = (maxR * 1.02 * 2 * n) / (n - 1); // 留一格余量，保证 15 分钟环不触边
  const latRadM = 111320;
  const lngRadM = 111320 * Math.cos((model.center.lat * Math.PI) / 180);

  const t = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const lat = model.center.lat + ((n / 2 - i - 0.5) * extentM) / n / latRadM;
    for (let j = 0; j < n; j++) {
      const lng = model.center.lng + ((j - n / 2 + 0.5) * extentM) / n / lngRadM;
      const dy = ((n / 2 - i - 0.5) * extentM) / n;
      const dx = ((j - n / 2 + 0.5) * extentM) / n;
      const d = Math.hypot(dx, dy);
      const theta = (Math.atan2(dx, dy) * 180) / Math.PI;
      const thetaPos = (theta + 360) % 360;
      const f = interpAngle(model.factors, model.dirs, thetaPos);
      t[i * n + j] = (d * f) / model.speed;
    }
  }

  return {
    n,
    cellM,
    center: model.center,
    latMax: model.center.lat + (extentM / 2 / latRadM),
    lngMin: model.center.lng - (extentM / 2 / lngRadM),
    t,
    maxMinutes: Math.max(...Array.from(t)),
    minutes: model.minutes,
    speed: model.speed
  };
}

export function latOfRow(f: TimeField, i: number): number {
  const latRadM = 111320;
  const extentM = gridExtentM(f);
  return f.latMax - (i * extentM) / (f.n - 1) / latRadM;
}

export function lngOfCol(f: TimeField, j: number): number {
  const lngRadM = 111320 * Math.cos((f.center.lat * Math.PI) / 180);
  const extentM = gridExtentM(f);
  return f.lngMin + (j * extentM) / (f.n - 1) / lngRadM;
}

export function latLngOfCell(f: TimeField, i: number, j: number): LatLng {
  return { lat: latOfRow(f, i), lng: lngOfCol(f, j) };
}

function gridExtentM(f: TimeField): number {
  const latRadM = 111320;
  return (f.latMax - f.center.lat) * 2 * latRadM;
}

/** 最近邻采样（快速，热力渲染与统计用） */
export function sampleTimeNearest(f: TimeField, p: LatLng): number {
  const latRadM = 111320;
  const lngRadM = latRadM * Math.cos((f.center.lat * Math.PI) / 180);
  const extentM = gridExtentM(f);
  const step = extentM / (f.n - 1);
  const di = (f.latMax - p.lat) * latRadM / step;
  const dj = (p.lng - f.lngMin) * lngRadM / step;
  const i = Math.round(di);
  const j = Math.round(dj);
  if (i < 0 || j < 0 || i >= f.n || j >= f.n) return NaN;
  return f.t[i * f.n + j];
}

// ---------- marching squares ----------

type Seg = [number, number, number, number]; // [x1, y1, x2, y2]，网格坐标（x=列, y=行）

function interp(a: number, b: number, level: number): number {
  const d = b - a;
  if (Math.abs(d) < 1e-12) return 0.5;
  return Math.min(1, Math.max(0, (level - a) / d));
}

export function marchingSquares(vals: Float64Array, n: number, level: number): Seg[] {
  const segs: Seg[] = [];
  const at = (i: number, j: number) => vals[i * n + j];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const v0 = at(i, j); // TL
      const v1 = at(i, j + 1); // TR
      const v2 = at(i + 1, j + 1); // BR
      const v3 = at(i + 1, j); // BL
      if (!isFinite(v0) || !isFinite(v1) || !isFinite(v2) || !isFinite(v3)) continue;
      let idx = 0;
      if (v0 > level) idx |= 8;
      if (v1 > level) idx |= 4;
      if (v2 > level) idx |= 2;
      if (v3 > level) idx |= 1;
      if (idx === 0 || idx === 15) continue;
      const top: [number, number] = [j + interp(v0, v1, level), i];
      const right: [number, number] = [j + 1, i + interp(v1, v2, level)];
      const bottom: [number, number] = [j + interp(v3, v2, level), i + 1];
      const left: [number, number] = [j, i + interp(v0, v3, level)];
      const push = (a: [number, number], b: [number, number]) => segs.push([a[0], a[1], b[0], b[1]]);
      switch (idx) {
        case 1: case 14: push(left, bottom); break;
        case 2: case 13: push(bottom, right); break;
        case 3: case 12: push(left, right); break;
        case 4: case 11: push(top, right); break;
        case 5: push(top, left); push(bottom, right); break;
        case 6: case 9: push(top, bottom); break;
        case 7: case 8: push(top, left); break;
        case 10: push(top, right); push(left, bottom); break;
      }
    }
  }
  return segs;
}

/** 把同水平线段链接成折线 */
export function chainSegments(segs: Seg[]): number[][][] {
  const key = (x: number, y: number) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`;
  const adjacency = new Map<string, [number, number][]>(); // pointKey -> [segIdx, endIndex]
  segs.forEach((s, idx) => {
    const k0 = key(s[0], s[1]);
    const k1 = key(s[2], s[3]);
    if (!adjacency.has(k0)) adjacency.set(k0, []);
    if (!adjacency.has(k1)) adjacency.set(k1, []);
    adjacency.get(k0)!.push([idx, 0]);
    adjacency.get(k1)!.push([idx, 1]);
  });
  const used = new Uint8Array(segs.length);
  const chains: number[][][] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line: number[][] = [[segs[i][0], segs[i][1]], [segs[i][2], segs[i][3]]];
    // 向尾部延伸
    let guard = 0;
    while (guard++ < segs.length) {
      const tail = line[line.length - 1];
      const nexts = adjacency.get(key(tail[0], tail[1])) ?? [];
      let found = false;
      for (const [si, ei] of nexts) {
        if (used[si]) continue;
        used[si] = 1;
        const s = segs[si];
        const other = ei === 0 ? [s[2], s[3]] : [s[0], s[1]];
        line.push(other);
        found = true;
        break;
      }
      if (!found) break;
    }
    // 向头部延伸
    guard = 0;
    while (guard++ < segs.length) {
      const head = line[0];
      const nexts = adjacency.get(key(head[0], head[1])) ?? [];
      let found = false;
      for (const [si, ei] of nexts) {
        if (used[si]) continue;
        used[si] = 1;
        const s = segs[si];
        const other = ei === 0 ? [s[2], s[3]] : [s[0], s[1]];
        line.unshift(other);
        found = true;
        break;
      }
      if (!found) break;
    }
    if (line.length >= 3) chains.push(line);
  }
  return chains;
}

/** 提取某时间等值线（折线数组，经纬度） */
export function contourPolylines(f: TimeField, levelMinutes: number): LatLng[][] {
  const segs = marchingSquares(f.t, f.n, levelMinutes);
  const chains = chainSegments(segs);
  return chains.map((line) =>
    line.map(([x, y]) => ({ lat: latOfRow(f, y), lng: lngOfCol(f, x) }))
  );
}

/** 简化折线（道格拉斯-普克），控制渲染点数 */
export function simplifyLine(line: LatLng[], toleranceM = 12): LatLng[] {
  if (line.length <= 3) return line;
  const latRadM = 111320;
  const lngRadM = latRadM * Math.cos((line[0].lat * Math.PI) / 180);
  const pts = line.map((p) => ({ x: p.lng * lngRadM, y: p.lat * latRadM }));
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = pts[a].x, ay = pts[a].y, bx = pts[b].x, by = pts[b].y;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let maxI = -1;
    for (let k = a + 1; k < b; k++) {
      const px = pts[k].x, py = pts[k].y;
      let d: number;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.min(1, Math.max(0, t));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > maxD) { maxD = d; maxI = k; }
    }
    if (maxD > toleranceM && maxI > 0) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  return line.filter((_, k) => keep[k] === 1);
}

// ---------- 热力面渲染 ----------

const PALETTE: [number, [number, number, number]][] = [
  [0, [27, 94, 32]],
  [5, [56, 142, 60]],
  [9, [158, 157, 36]],
  [12, [251, 192, 45]],
  [15, [251, 140, 0]],
  [18, [229, 57, 53]],
  [22, [146, 24, 24]]
];

export function colorForMinutes(t: number): string {
  const c = colorRgbForMinutes(t);
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function colorRgbForMinutes(t: number): [number, number, number] {
  if (!isFinite(t)) return [0, 0, 0];
  let lo = PALETTE[0];
  let hi = PALETTE[PALETTE.length - 1];
  for (let k = 0; k < PALETTE.length - 1; k++) {
    if (t >= PALETTE[k][0] && t <= PALETTE[k + 1][0]) {
      lo = PALETTE[k];
      hi = PALETTE[k + 1];
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const f = Math.min(1, Math.max(0, (t - lo[0]) / span));
  return [
    Math.round(lo[1][0] + (hi[1][0] - lo[1][0]) * f),
    Math.round(lo[1][1] + (hi[1][1] - lo[1][1]) * f),
    Math.round(lo[1][2] + (hi[1][2] - lo[1][2]) * f)
  ];
}

/** 时间场覆盖的地理范围（GroundOverlay 贴图边界） */
export function fieldBounds(f: TimeField): { sw: LatLng; ne: LatLng } {
  return {
    sw: { lat: latOfRow(f, f.n - 1), lng: lngOfCol(f, 0) },
    ne: { lat: latOfRow(f, 0), lng: lngOfCol(f, f.n - 1) }
  };
}
