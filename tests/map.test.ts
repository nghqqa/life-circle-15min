import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapView, type BatchMapCommunity } from '../src/map.js';

function popup(community: BatchMapCommunity) {
  class Point { constructor(public lng: number, public lat: number) {} }
  class Marker {
    click?: () => void;
    addEventListener(_event: string, callback: () => void) { this.click = callback; }
  }
  class InfoWindow { constructor(public html: string) {} }
  vi.stubGlobal('BMapGL', { Point, Marker, InfoWindow, Icon: class {}, Size: class {} });
  let marker: Marker | undefined, html = '';
  const view = new MapView(); view.ready = true;
  view.map = { addOverlay: (value: Marker) => marker = value, removeOverlay() {}, openInfoWindow: (info: InfoWindow) => html = info.html };
  view.setBatchResults([community]); marker?.click?.();
  return html;
}
const base: BatchMapCommunity = { name: '社区甲', center: { lat: 28.46, lng: 117.97 }, score: 60, grade: 'D', coverageShare: null, dominantMissing: null };
afterEach(() => vi.unstubAllGlobals());

describe('街道地图摘要', () => {
  it.each([
    [null, false, '无法评估'], [0, true, '无法评估'], [0, false, '0%'], [.71, false, '71%']
  ] as const)('覆盖 %s、不可用 %s 与列表口径一致', (coverageShare, coverageUnavailable, expected) => {
    expect(popup({ ...base, coverageShare, coverageUnavailable })).toContain(`人口覆盖率 ${expected}`);
  });
  it('名称、等级和缺失类别以纯文本展示，失败摘要同样转义名称', () => {
    const attack = '<img src=x onerror="alert(1)">';
    const html = popup({ ...base, name: attack, grade: attack, dominantMissing: attack });
    expect(html).not.toContain('<img'); expect(html).toContain('&lt;img');
    expect(popup({ ...base, score: -1, name: attack })).toContain('分析失败');
    expect(popup({ ...base, score: -1, name: attack })).not.toContain('<img');
  });
});
