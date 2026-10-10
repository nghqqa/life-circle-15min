import { clamp } from './geo.js';
import type { IsochroneModel, LatLng, RouteProbe } from './types.js';

/**
 * 等时圈解析模型（扇形采样 + 空间插值）：
 *
 * 1. 以中心点为原点，沿 dirs 个均匀方向发射探针到直线距离 probeM 处，
 *    通过百度「批量算路」获取各探针的真实路网步行距离；
 * 2. 各方向绕行系数 f(θ) = 实际路网距离 / 直线距离（≥1，道路网格越稀疏值越大）；
 * 3. 假设同一方向上绕行系数近似恒定，则该方向 t 分钟可达直线半径
 *    R(θ) = t · v / f(θ)；
 * 4. 探针失败的方向使用道路网格谐波模型合成 f(θ)，保证结果永不中断。
 *
 * 该模型把"真实路网测距的少量锚点"插值成"全方向连续可达面"，
 * 后续步行时间场、等时环、盲区判定全部由它派生。
 */

export interface IsochroneOptions {
  dirs?: number;
  minutes: number;
  /** 步行速度 m/min */
  speed: number;
  /** 探针直线距离（米），默认 minutes·speed */
  probeM?: number;
}

export function syntheticFactor(thetaDeg: number): number {
  const t = (thetaDeg * Math.PI) / 180;
  const f = 1.12 + 0.2 * Math.abs(Math.sin(2 * t + 0.6)) + 0.08 * Math.sin(5 * t);
  return clamp(f, 1.0, 1.6);
}

function smoothCircular(arr: number[], window = 3): number[] {
  const n = arr.length;
  const half = Math.floor(window / 2);
  return arr.map((_, i) => {
    let sum = 0;
    for (let k = -half; k <= half; k++) sum += arr[(i + k + n) % n];
    return sum / window;
  });
}

export function buildIsochroneModel(
  center: LatLng,
  probes: (RouteProbe | null)[],
  opts: IsochroneOptions
): IsochroneModel {
  const dirs = opts.dirs ?? probes.length;
  const probeM = opts.probeM ?? opts.minutes * opts.speed;
  const factors: number[] = new Array(dirs);
  let degraded = 0;

  for (let i = 0; i < dirs; i++) {
    const theta = (i * 360) / dirs;
    // 探针按方向序号一一对应；缺失/失败的方向用道路网格谐波模型合成
    const p = i < probes.length ? probes[i] : null;
    if (p && p.ok && p.distM > 30) {
      factors[i] = clamp(p.distM / probeM, 0.95, 2.5);
    } else {
      factors[i] = syntheticFactor(theta);
      degraded++;
    }
  }

  const smoothed = smoothCircular(factors, 3);
  const radiusM = smoothed.map((f) => (opts.minutes * opts.speed) / f);

  return {
    center,
    dirs,
    factors: smoothed,
    probeM,
    minutes: opts.minutes,
    speed: opts.speed,
    radiusM,
    degradedDirs: degraded
  };
}

/** 采样方向列表（度，0 = 正北，顺时针） */
export function sampleBearings(dirs: number): number[] {
  return Array.from({ length: dirs }, (_, i) => (i * 360) / dirs);
}
