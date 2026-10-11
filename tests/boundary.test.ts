import { describe, expect, it } from 'vitest';
import { parseBoundaryGeoJson, pointInBoundary, pointInRing, wgs84ToBd09 } from '../src/boundary.js';

const square = {
  type: 'Polygon',
  coordinates: [[[117.90, 28.40], [118.00, 28.40], [118.00, 28.50], [117.90, 28.50], [117.90, 28.40]]] as [number, number][][]
};

describe('行政边界（№11）', () => {
  it('解析 Feature / FeatureCollection / MultiPolygon', () => {
    expect(parseBoundaryGeoJson(JSON.stringify(square))?.vertexCount).toBe(5);
    expect(parseBoundaryGeoJson(JSON.stringify({ type: 'Feature', geometry: square }))?.vertexCount).toBe(5);
    const fc = parseBoundaryGeoJson(JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [[square.coordinates[0]]] } }]
    }));
    expect(fc?.polygons.length).toBe(1);
    expect(parseBoundaryGeoJson('{"type":"Point","coordinates":[1,2]}')).toBeNull();
  });

  it('射线法内外判定', () => {
    const b = parseBoundaryGeoJson(JSON.stringify(square))!;
    expect(pointInBoundary({ lat: 28.45, lng: 117.95 }, b)).toBe(true);
    expect(pointInBoundary({ lat: 28.60, lng: 118.20 }, b)).toBe(false);
    expect(pointInBoundary({ lat: 28.45, lng: 117.95 }, null)).toBe(true);
  });

  it('点在环上的边界容差：环外点不误判', () => {
    expect(pointInRing(117.85, 28.40, square.coordinates[0] as [number, number][])).toBe(false);
  });
});

describe('№11-F 审查修复', () => {
  it('MultiPolygon 多片区全部保留，内洞排除', () => {
    // 两个片区：西区 [117.90-117.95] 与东区 [118.05-118.10]；东区内挖一个洞
    const fc = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [[[117.90, 28.40], [117.95, 28.40], [117.95, 28.50], [117.90, 28.50], [117.90, 28.40]]],
            [
              [[118.05, 28.40], [118.10, 28.40], [118.10, 28.50], [118.05, 28.50], [118.05, 28.40]],
              [[118.07, 28.43], [118.09, 28.43], [118.09, 28.47], [118.07, 28.47], [118.07, 28.43]]
            ]
          ]
        }
      }]
    };
    const b = parseBoundaryGeoJson(JSON.stringify(fc))!;
    expect(b.polygons.length).toBe(2);
    expect(b.holes.length).toBe(1);
    // 查询点与 POI 一样都是 BD-09（百度体系）——用同一转换函数换算后再判定
    const q = (lat: number, lng: number) => pointInBoundary(wgs84ToBd09(lat, lng), b);
    expect(q(28.45, 117.92)).toBe(true);  // 西区内部
    expect(q(28.45, 118.06)).toBe(true);  // 东区内部（洞外）
    expect(q(28.45, 118.08)).toBe(false); // 东区内洞 → 边界外
  });

  it('导入坐标按 WGS-84 → BD-09 转换（不再与百度坐标混用）', () => {
    const b = parseBoundaryGeoJson(JSON.stringify(square))!;
    expect(b.sourceCoordinateSystem).toBe('WGS-84');
    // 天安门附近 WGS-84 (39.90733, 116.39120) 的 BD-09 约为 (39.9087, 116.3976)
    const bd = wgs84ToBd09(39.90733, 116.3912);
    expect(Math.abs(bd.lat - 39.9151)).toBeLessThan(0.002);
    expect(Math.abs(bd.lng - 116.4038)).toBeLessThan(0.002);
    // 边界顶点已整体东/北偏移（转换发生）
    expect(b.polygons[0][0][0]).toBeGreaterThan(117.90);
    expect(b.polygons[0][0][1]).toBeGreaterThan(28.40);
  });
});
