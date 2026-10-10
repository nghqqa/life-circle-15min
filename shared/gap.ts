import { CATEGORIES, CORE_CATEGORIES, THRESHOLDS } from './config.js';
import { localDistM } from './geo.js';
import { latLngOfCell, latOfRow, lngOfCol, marchingSquares, chainSegments } from './timefield.js';
import type { CategoryId, GapAnalysis, GapPatch, LatLng, Poi, TimeField } from './types.js';

/**
 * 服务盲区识别（人口加权 + 连通斑块）：
 *
 * 1. 以住宅小区 POI 作为人口代理，在网格上累积居住权重；
 * 2. 对三个核心类别（菜市场/药店/小学）分别做「设施服务盘」栅格化——
 *    设施 1km（评分细则口径）内的网格记为该类覆盖；
 * 3. missingGrid = 未覆盖核心类别数（0-3）。缺任意 1 项即为评分细则意义上的
 *    「盲区点位」，缺 ≥2 项的连通区域聚合为「灰色斑块」，按居住权重排序；
 * 4. 斑块轮廓由二值场的 marching squares 提取，直接上图为矢量面。
 */

function stampDisks(
  n: number,
  points: LatLng[],
  radiusM: number,
  f: TimeField,
  value: (distM: number) => number
): Float64Array {
  const grid = new Float64Array(n * n);
  if (points.length === 0) return grid;
  const stepM = gridExtentM(f) / (n - 1);
  const rCells = Math.ceil(radiusM / stepM);
  for (const p of points) {
    // 定位设施所在格
    const stepLat = stepM / 111320;
    const stepLng = stepM / (111320 * Math.cos((p.lat * Math.PI) / 180));
    const ci = Math.round((f.latMax - p.lat) / stepLat);
    const cj = Math.round((p.lng - f.lngMin) / stepLng);
    for (let i = Math.max(0, ci - rCells); i <= Math.min(n - 1, ci + rCells); i++) {
      for (let j = Math.max(0, cj - rCells); j <= Math.min(n - 1, cj + rCells); j++) {
        const dy = (ci - i) * stepM;
        const dx = (cj - j) * stepM;
        const d = Math.hypot(dx, dy);
        if (d <= radiusM) grid[i * n + j] += value(d);
      }
    }
  }
  return grid;
}

function gridExtentM(f: TimeField): number {
  return (f.latMax - f.center.lat) * 2 * 111320;
}

export function analyzeGaps(
  field: TimeField,
  pois: Poi[],
  opts: { coreRadiusM?: number; minPatchCells?: number; residentialRadiusM?: number } = {}
): GapAnalysis {
  const n = field.n;
  const coreRadiusM = opts.coreRadiusM ?? THRESHOLDS.coreRadiusM;
  const minPatchCells = opts.minPatchCells ?? THRESHOLDS.minPatchCells;
  const residentialRadiusM = opts.residentialRadiusM ?? THRESHOLDS.residentialRadiusM;
  // 只在 15 分钟步行圈内做体检：圈外（t > minutes）不属于该中心点的服务范围
  const inCircle = (k: number) => field.t[k] <= field.minutes;

  const byCat: Record<string, Poi[]> = {};
  for (const p of pois) (byCat[p.category] ??= []).push(p);

  // 1) 人口代理权重（圈外居住格不计入服务人口）
  const weightGrid = stampDisks(n, byCat.residential ?? [], residentialRadiusM, field, (d) =>
    d <= residentialRadiusM / 2 ? 1 : 0.5
  );
  for (let k = 0; k < n * n; k++) if (!inCircle(k)) weightGrid[k] = 0;
  const totalWeight = weightGrid.reduce((a, b) => a + b, 0);

  // 2) 核心类别覆盖盘
  const covered: Record<string, Uint8Array> = {};
  for (const cat of CORE_CATEGORIES) {
    const mask = new Uint8Array(n * n);
    const disk = stampDisks(n, byCat[cat] ?? [], coreRadiusM, field, () => 1);
    for (let k = 0; k < n * n; k++) mask[k] = disk[k] > 0 && inCircle(k) ? 1 : 0;
    covered[cat] = mask;
  }

  // 3) 缺失计数与盲区点位
  const missingGrid = new Uint8Array(n * n);
  let blindPoints = 0;
  for (let k = 0; k < n * n; k++) {
    if (!inCircle(k)) continue; // 圈外不参与体检
    let miss = 0;
    for (const cat of CORE_CATEGORIES) if (!covered[cat][k]) miss++;
    missingGrid[k] = miss;
    if (miss >= 1) blindPoints++;
  }

  // 4) 连通斑块（4 邻域，missing ≥ 2）
  const patchId = new Int32Array(n * n).fill(-1);
  const patchesRaw: number[][] = [];
  for (let k = 0; k < n * n; k++) {
    if (missingGrid[k] < 2 || patchId[k] >= 0) continue;
    const cells: number[] = [];
    const stack = [k];
    patchId[k] = patchesRaw.length;
    while (stack.length) {
      const cur = stack.pop()!;
      cells.push(cur);
      const i = Math.floor(cur / n);
      const j = cur % n;
      const neighbors = [
        i > 0 ? cur - n : -1,
        i < n - 1 ? cur + n : -1,
        j > 0 ? cur - 1 : -1,
        j < n - 1 ? cur + 1 : -1
      ];
      for (const nb of neighbors) {
        if (nb < 0 || missingGrid[nb] < 2 || patchId[nb] >= 0) continue;
        patchId[nb] = patchId[k];
        stack.push(nb);
      }
    }
    if (cells.length >= minPatchCells) patchesRaw.push(cells);
  }

  const patches: GapPatch[] = patchesRaw.map((cells, idx) => {
    let weight = 0;
    let wLat = 0;
    let wLng = 0;
    let gLat = 0;
    let gLng = 0;
    for (const k of cells) {
      const i = Math.floor(k / n);
      const j = k % n;
      const w = weightGrid[k];
      weight += w;
      const lat = latOfRow(field, i);
      const lng = lngOfCol(field, j);
      gLat += lat;
      gLng += lng;
      wLat += lat * w;
      wLng += lng * w;
    }
    const centroid: LatLng =
      weight > 0 ? { lat: wLat / weight, lng: wLng / weight } : { lat: gLat / cells.length, lng: gLng / cells.length };

    // 各核心类别在斑块内的缺失率，取缺失率最高者为主导缺失类别
    let dominant: CategoryId = CORE_CATEGORIES[0];
    let dominantMissRate = -1;
    const missingCats: CategoryId[] = [];
    for (const cat of CORE_CATEGORIES) {
      const missCnt = cells.filter((k) => !covered[cat][k]).length;
      const rate = missCnt / cells.length;
      if (rate >= 0.5) missingCats.push(cat);
      if (rate > dominantMissRate) {
        dominantMissRate = rate;
        dominant = cat;
      }
    }

    // 主缺失类别下，斑块内居住网格距最近设施的直线距离（按权重取加权 90 分位近似：取最远）
    let maxNearestM = 0;
    for (const k of cells) {
      if (weightGrid[k] <= 0) continue;
      const i = Math.floor(k / n);
      const j = k % n;
      const cell = latLngOfCell(field, i, j);
      const facs = byCat[dominant] ?? [];
      let nearest = Infinity;
      for (const fq of facs) nearest = Math.min(nearest, localDistM(cell.lat, cell.lng, fq.lat, fq.lng));
      if (isFinite(nearest)) maxNearestM = Math.max(maxNearestM, nearest);
    }

    // 轮廓：二值场 → marching squares → 链接为折线
    const binary = new Float64Array(n * n);
    for (const k of cells) binary[k] = 1;
    const chains = chainSegments(marchingSquares(binary, n, 0.5));
    const outline = chains.map((line) =>
      line.map(([x, y]) => ({ lat: latOfRow(field, y), lng: lngOfCol(field, x) }))
    );

    const avgMissing = cells.reduce((a, k) => a + missingGrid[k], 0) / cells.length;
    return {
      id: idx + 1,
      cells,
      weight,
      weightShare: totalWeight > 0 ? weight / totalWeight : 0,
      centroid,
      missingCats: missingCats.length ? missingCats : [dominant],
      dominant,
      maxNearestM,
      outline,
      severity: avgMissing >= 2.7 ? 'severe' : 'moderate'
    };
  });

  patches.sort((a, b) => b.weight - a.weight);

  let covWeight = 0;
  let severeWeight = 0;
  for (let k = 0; k < n * n; k++) {
    const w = weightGrid[k];
    if (w <= 0) continue;
    if (missingGrid[k] === 0) covWeight += w;
    if (missingGrid[k] === 3) severeWeight += w;
  }

  return {
    n,
    cellM: field.cellM,
    weightGrid,
    totalWeight,
    missingGrid,
    coveredMasks: covered as Record<string, Uint8Array>,
    patches: patches.slice(0, 8),
    coverageShare: totalWeight > 0 ? covWeight / totalWeight : 1,
    severeShare: totalWeight > 0 ? severeWeight / totalWeight : 0,
    blindPoints
  };
}

export function categoryByIcon(id: CategoryId) {
  return CATEGORIES.find((c) => c.id === id)!;
}
