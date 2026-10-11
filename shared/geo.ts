import type { LatLng } from './types.js';

const EARTH_R = 6371008.8; // 平均地球半径（米）
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** 大圆距离（米） */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** 从 a 指向 b 的方位角（度，0 = 正北，顺时针） */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const φ1 = rad(a.lat);
  const φ2 = rad(b.lat);
  const Δλ = rad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** 从 a 出发，沿方位角 bearing 走 distM 米后的坐标 */
export function destination(a: LatLng, bearing: number, distM: number): LatLng {
  const δ = distM / EARTH_R;
  const θ = rad(bearing);
  const φ1 = rad(a.lat);
  const λ1 = rad(a.lng);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: deg(φ2), lng: ((deg(λ2) + 540) % 360) - 180 };
}

/** 本地平面近似距离（米）：小范围（<3km）内与真实路网尺度偏差可忽略 */
export function localDistM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dy = (bLat - aLat) * 111320;
  const dx = (bLng - aLng) * 111320 * Math.cos(rad(aLat));
  return Math.hypot(dx, dy);
}

/** 角度插值（圆形，fars 按 0° 起顺时针均匀分布） */
export function interpAngle(values: number[], dirs: number, thetaDeg: number): number {
  const step = 360 / dirs;
  const x = ((thetaDeg % 360) + 360) % 360 / step;
  const i0 = Math.floor(x) % dirs;
  const i1 = (i0 + 1) % dirs;
  const f = x - Math.floor(x);
  return values[i0] * (1 - f) + values[i1] * f;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
