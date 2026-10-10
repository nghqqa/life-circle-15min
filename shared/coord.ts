import type { LatLng } from './types.js';

/**
 * BD-09 / GCJ-02 / WGS-84 六向互转。
 * GCJ-02 偏移基于 Krasovsky 1940 椭球近似，精度约 1m 级，满足生活圈分析需求。
 * 百度地图 API 输入输出均为 BD-09；POI 落图与算路前统一转换为 BD-09。
 */

const PI = Math.PI;
const X_PI = (PI * 3000) / 180;

function outOfChina(lat: number, lng: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret =
    -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret =
    300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
  return ret;
}

export function wgs84ToGcj02(p: LatLng): LatLng {
  if (outOfChina(p.lat, p.lng)) return { ...p };
  const dLat = transformLat(p.lng - 105, p.lat - 35);
  const dLng = transformLng(p.lng - 105, p.lat - 35);
  const radLat = (p.lat / 180) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - 0.00669342162296594326 * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  return {
    lat: p.lat + (dLat * 180) / (((6378245 * (1 - 0.00669342162296594326)) / (magic * sqrtMagic)) * PI),
    lng: p.lng + (dLng * 180) / ((6378245 / sqrtMagic) * Math.cos(radLat) * PI)
  };
}

export function gcj02ToWgs84(p: LatLng): LatLng {
  const gcj = wgs84ToGcj02(p);
  return { lat: p.lat * 2 - gcj.lat, lng: p.lng * 2 - gcj.lng };
}

export function gcj02ToBd09(p: LatLng): LatLng {
  const z = Math.sqrt(p.lng * p.lng + p.lat * p.lat) + 0.00002 * Math.sin(p.lat * X_PI);
  const θ = Math.atan2(p.lat, p.lng) + 0.000003 * Math.cos(p.lng * X_PI);
  return { lat: z * Math.sin(θ) + 0.006, lng: z * Math.cos(θ) + 0.0065 };
}

export function bd09ToGcj02(p: LatLng): LatLng {
  const x = p.lng - 0.0065;
  const y = p.lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const θ = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return { lat: z * Math.sin(θ), lng: z * Math.cos(θ) };
}

export function wgs84ToBd09(p: LatLng): LatLng {
  return gcj02ToBd09(wgs84ToGcj02(p));
}

export function bd09ToWgs84(p: LatLng): LatLng {
  return gcj02ToWgs84(bd09ToGcj02(p));
}
