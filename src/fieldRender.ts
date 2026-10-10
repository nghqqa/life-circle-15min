import { colorRgbForMinutes } from '../shared/timefield.js';
import type { TimeField } from '../shared/types.js';

/** 把步行时间场渲染成平滑热力面 PNG dataURL（浏览器端，配合地图 GroundOverlay 贴地展示） */
export function fieldToDataUrl(f: TimeField, size = 640, alpha = 0.52): string {
  const n = f.n;
  const img = new Uint8ClampedArray(n * n * 4);
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
      img[o + 3] = Math.round(255 * alpha);
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
