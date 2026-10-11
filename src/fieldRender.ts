import { colorRgbForMinutes } from '../shared/timefield.js';
import type { TimeField } from '../shared/types.js';

/**
 * 把步行时间场渲染成平滑热力面 PNG dataURL（浏览器端，配合地图 GroundOverlay 贴地展示）。
 * 透明度随步行时间衰减：圈内（t ≤ minutes）全强度；
 * 圈外为线性外推趋势区，7 分钟内渐隐至完全透明——避免外接方形网格的实色边界。
 */
export function fieldToDataUrl(f: TimeField, size = 640, alpha = 0.52): string {
  const n = f.n;
  const img = new Uint8ClampedArray(n * n * 4);
  const fadeSpan = 7;
  // 几何边缘羽化带宽（网格格数）：靠近外接矩形边界处线性淡出到透明，
  // 消除「网格边缘时间值仍较高」方向上的硬直边（审查/体验反馈）
  const edgeCells = Math.max(2, Math.round(n * 0.06));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const t = f.t[i * n + j];
      const o = ((n - 1 - i) * n + j) * 4; // canvas 行序自下而上翻转，保证北在上
      if (!isFinite(t)) {
        img[o + 3] = 0;
        continue;
      }
      const [r, g, b] = colorRgbForMinutes(t);
      img[o] = r;
      img[o + 1] = g;
      img[o + 2] = b;
      // 圈内全强度；圈外 7 分钟内线性渐隐
      let a = alpha;
      if (t > f.minutes) a = alpha * Math.max(0, 1 - (t - f.minutes) / fadeSpan);
      // 边缘羽化：到边界的最小距离（格）在带宽内平滑衰减（smoothstep）
      const edgeDist = Math.min(i, j, n - 1 - i, n - 1 - j);
      if (edgeDist < edgeCells) {
        const x = edgeDist / edgeCells;
        a *= x * x * (3 - 2 * x);
      }
      img[o + 3] = Math.round(255 * a);
    }
  }
  const small = document.createElement('canvas');
  small.width = n;
  small.height = n;
  const sctx = small.getContext('2d')!;
  sctx.putImageData(new ImageData(img, n, n), 0, 0);
  const big = document.createElement('canvas');
  big.width = size;
  big.height = size;
  const bctx = big.getContext('2d')!;
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, size, size);
  return big.toDataURL('image/png');
}
