import { describe, expect, it } from 'vitest';
import { parseBoundaryGeoJson, pointInBoundary, pointInRing } from '../src/boundary.js';

const square = {
  type: 'Polygon',
  coordinates: [[[117.90, 28.40], [118.00, 28.40], [118.00, 28.50], [117.90, 28.50], [117.90, 28.40]]]
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
