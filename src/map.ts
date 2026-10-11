import { CATEGORY_MAP } from '../shared/config.js';
import { simplifyLine } from '../shared/timefield.js';
import type { GapPatch, LatLng, PlanSite, Poi } from '../shared/types.js';

/**
 * 地图视图封装：所有图层 no-op 安全（演示模式下底图不可用时静默跳过）。
 * 热力面用 GroundOverlay 贴 canvas 渲染的时间场图片（平滑、GPU 友好），
 * 等时环/盲区轮廓为矢量折线，POI/规划点为标注。
 */

export type LayerKey = 'heat' | 'rings' | 'poi' | 'gap' | 'plan' | 'batch';

export class MapView {
  map: any = null;
  ready = false;

  private overlays: Record<string, any[]> = { heat: [], rings: [], poi: [], gap: [], plan: [], batch: [] };
  private visible: Record<LayerKey, boolean> = { heat: true, rings: true, poi: true, gap: true, plan: true, batch: true };
  private data: Record<string, any> = {};
  private centerMarker: any = null;

  async init(browserAk: string, center: LatLng, onPick?: (p: LatLng) => void): Promise<boolean> {
    try {
      await this.loadSdk(browserAk);
      // 百度 GL JS API 的经纬度即为 BD-09 坐标，引擎统一以 BD-09 运算
      const pt = new BMapGL.Point(center.lng, center.lat);
      this.map = new BMapGL.Map('map', { enableMapClick: false });
      this.map.centerAndZoom(pt, 15);
      this.map.enableScrollWheelZoom(true);
      this.map.addControl(new BMapGL.ScaleControl());
      this.map.addControl(new BMapGL.NavigationControl3D());
      this.ready = true;
      if (onPick) {
        this.map.addEventListener('click', (e: any) => {
          if (e.latlng) onPick({ lat: e.latlng.lat, lng: e.latlng.lng });
        });
      }
      return true;
    } catch (err) {
      console.warn('[map] init failed:', err);
      this.ready = false;
      return false;
    }
  }

  private loadSdk(ak: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (window.BMapGL) {
        resolve();
        return;
      }
      window.__initBMap = () => resolve();
      const s = document.createElement('script');
      s.src = `https://api.map.baidu.com/api?v=1.0&type=webgl&ak=${encodeURIComponent(ak)}&callback=__initBMap`;
      s.onerror = () => reject(new Error('百度地图 SDK 加载失败'));
      document.head.appendChild(s);
      setTimeout(() => reject(new Error('百度地图 SDK 加载超时')), 10000);
    });
  }

  setCenter(p: LatLng, label?: string) {
    if (!this.ready) return;
    const pt = new BMapGL.Point(p.lng, p.lat);
    this.map.centerAndZoom(pt, 15);
    if (this.centerMarker) this.map.removeOverlay(this.centerMarker);
    if ((this as any)._centerLabel) {
      this.map.removeOverlay((this as any)._centerLabel);
      (this as any)._centerLabel = null;
    }
    this.centerMarker = new BMapGL.Marker(pt, { icon: iconCenter() });
    this.map.addOverlay(this.centerMarker);
    if (label) {
      const lbl = new BMapGL.Label(escapeHtml(label), {
        position: pt,
        offset: new BMapGL.Size(14, -14)
      });
      lbl.setStyle({
        background: '#2f6fed', color: '#fff', border: 'none', borderRadius: '6px',
        padding: '2px 8px', fontSize: '12px'
      });
      this.map.addOverlay(lbl);
      (this as any)._centerLabel = lbl;
    }
  }

  flyTo(p: LatLng, zoom = 16) {
    if (!this.ready) return;
    this.map.centerAndZoom(new BMapGL.Point(p.lng, p.lat), zoom);
  }

  // ---- 图层数据 ----

  setHeat(dataUrl: string, sw: LatLng, ne: LatLng) {
    this.data.heat = { dataUrl, sw, ne };
    this.renderLayer('heat');
  }

  setRings(rings: { level: number; lines: LatLng[][] }[]) {
    this.data.rings = rings;
    this.renderLayer('rings');
  }

  setPois(pois: Poi[]) {
    this.data.pois = pois;
    this.renderLayer('poi');
  }

  setGaps(patches: GapPatch[]) {
    this.data.gaps = patches;
    this.renderLayer('gap');
  }

  setPlanSites(sites: PlanSite[]) {
    this.data.plan = sites;
    this.renderLayer('plan');
  }

  /** 街道级批量结果：按等级着色的小区标注（点击弹出摘要） */
  setBatchResults(communities: { name: string; center: LatLng; score: number; grade: string; coverageShare: number; dominantMissing: string | null }[]) {
    this.data.batch = communities;
    this.renderLayer('batch');
  }

  toggleLayer(key: LayerKey, on: boolean) {
    this.visible[key] = on;
    this.renderLayer(key);
  }

  clearAnalysis() {
    for (const k of Object.keys(this.overlays)) {
      for (const o of this.overlays[k]) this.map?.removeOverlay(o);
      this.overlays[k as LayerKey] = [];
    }
  }

  private renderLayer(key: LayerKey) {
    if (!this.ready) return;
    for (const o of this.overlays[key]) this.map.removeOverlay(o);
    this.overlays[key] = [];
    if (!this.visible[key]) return;

    const map = this.map;
    if (key === 'heat' && this.data.heat) {
      const { dataUrl, sw, ne } = this.data.heat;
      const b = new BMapGL.Bounds(new BMapGL.Point(sw.lng, sw.lat), new BMapGL.Point(ne.lng, ne.lat));
      const overlay = new BMapGL.GroundOverlay(b, { url: dataUrl, opacity: 1 });
      map.addOverlay(overlay);
      this.overlays.heat = [overlay];
    }

    if (key === 'rings' && this.data.rings) {
      const styles: Record<number, { color: string; width: number; dash: boolean }> = {
        5: { color: '#7cb342', width: 2, dash: true },
        10: { color: '#fb8c00', width: 2, dash: true },
        15: { color: '#e53935', width: 3, dash: false }
      };
      for (const ring of this.data.rings) {
        const st = styles[ring.level] ?? { color: '#666', width: 2, dash: true };
        for (const line of ring.lines) {
          const simp = simplifyLine(line, 15);
          const pts = simp.map((p) => new BMapGL.Point(p.lng, p.lat));
          if (pts.length < 2) continue;
          const pl = new BMapGL.Polyline(pts, {
            strokeColor: st.color,
            strokeWeight: st.width,
            strokeOpacity: 0.9,
            strokeStyle: st.dash ? 'dashed' : 'solid'
          });
          map.addOverlay(pl);
          this.overlays.rings.push(pl);
        }
      }
    }

    if (key === 'poi' && this.data.pois) {
      const poiList = this.data.pois as Poi[];
      for (const p of poiList) {
        if (p.category === 'residential') continue;
        const def = CATEGORY_MAP[p.category];
        const marker = new BMapGL.Marker(new BMapGL.Point(p.lng, p.lat), {
          icon: iconFor(def.color, def.name.slice(0, 1))
        });
        marker.addEventListener('click', () => {
          const info = new BMapGL.InfoWindow(
            `<div style="font-size:13px;min-width:180px"><b>${escapeHtml(p.name)}</b><br/><span style="color:#5a6478">${def.name} · ${escapeHtml(p.address ?? '')}</span></div>`,
            { width: 220 }
          );
          map.openInfoWindow(info, new BMapGL.Point(p.lng, p.lat));
        });
        map.addOverlay(marker);
        this.overlays.poi.push(marker);
      }
      // 住宅小区用小圆点展示（人口代理）
      for (const p of poiList.filter((x: Poi) => x.category === 'residential')) {
        const marker = new BMapGL.Marker(new BMapGL.Point(p.lng, p.lat), {
          icon: iconFor('#5c6bc0', '家', 18)
        });
        map.addOverlay(marker);
        this.overlays.poi.push(marker);
      }
    }

    if (key === 'gap' && this.data.gaps) {
      for (const patch of this.data.gaps as GapPatch[]) {
        const color = patch.severity === 'severe' ? '#c62828' : '#ef6c00';
        for (const line of patch.outline) {
          if (line.length < 3) continue;
          const pts = line.map((p) => new BMapGL.Point(p.lng, p.lat));
          const poly = new BMapGL.Polygon(pts, {
            strokeColor: color,
            strokeWeight: 1.5,
            strokeOpacity: 0.8,
            fillColor: color,
            fillOpacity: 0.22
          });
          map.addOverlay(poly);
          this.overlays.gap.push(poly);
        }
        const label = new BMapGL.Label(
          `#${patch.id} ${patch.severity === 'severe' ? '重度' : '中度'}缺${catName(patch.dominant)} · ${(patch.weightShare * 100).toFixed(0)}%居住`,
          { position: new BMapGL.Point(patch.centroid.lng, patch.centroid.lat), offset: new BMapGL.Size(-60, -10) }
        );
        label.setStyle({
          background: color, color: '#fff', border: 'none', borderRadius: '6px',
          padding: '2px 8px', fontSize: '11px', whiteSpace: 'nowrap'
        });
        map.addOverlay(label);
        this.overlays.gap.push(label);
      }
    }

    if (key === 'plan' && this.data.plan) {
      for (const site of this.data.plan) {
        const pt = new BMapGL.Point(site.latLng.lng, site.latLng.lat);
        const marker = new BMapGL.Marker(pt, { icon: iconFor('#00bcd4', `补${site.rank}`) });
        marker.addEventListener('click', () => {
          const info = new BMapGL.InfoWindow(
            `<div style="font-size:13px;min-width:220px"><b>规划建议 #${site.rank}：补建${catName(site.category)}</b><br/>${escapeHtml(site.rationale)}</div>`,
            { width: 250 }
          );
          map.openInfoWindow(info, pt);
        });
        map.addOverlay(marker);
        this.overlays.plan.push(marker);
        const circle = new BMapGL.Circle(pt, 1000, {
          strokeColor: '#00bcd4',
          strokeWeight: 1.5,
          strokeStyle: 'dashed',
          fillColor: '#00bcd4',
          fillOpacity: 0.06
        });
        map.addOverlay(circle);
        this.overlays.plan.push(circle);
      }
    }

    if (key === 'batch' && this.data.batch) {
      const gradeColor: Record<string, string> = {
        A: '#2f9e44', B: '#74b816', C: '#f08c00', D: '#e8590c', E: '#e03131', '-': '#8a93a6'
      };
      for (const c of this.data.batch as any[]) {
        const pt = new BMapGL.Point(c.center.lng, c.center.lat);
        const color = gradeColor[c.grade] ?? '#8a93a6';
        const marker = new BMapGL.Marker(pt, { icon: iconFor(color, c.grade === '-' ? '?' : String(c.grade)) });
        const summary = c.score >= 0
          ? `<b>${c.name}</b><br/>评分 ${c.score}（${c.grade} 级）· 人口覆盖率 ${Math.round(c.coverageShare * 100)}%${c.dominantMissing ? `<br/>主要缺失：${catName(c.dominantMissing)}` : ''}`
          : `<b>${c.name}</b><br/>分析失败`;
        marker.addEventListener('click', () => {
          const info = new BMapGL.InfoWindow(`<div style="font-size:13px;min-width:200px">${summary}</div>`, { width: 240 });
          map.openInfoWindow(info, pt);
        });
        map.addOverlay(marker);
        this.overlays.batch.push(marker);
      }
    }
  }
}

function catName(id: string): string {
  return CATEGORY_MAP[id as keyof typeof CATEGORY_MAP]?.name ?? id;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** 中心点图标：同心圆（生活圈母题），虚线外环 + 实心核 */
function iconCenter(): any {
  const size = 30;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="13" fill="rgba(47,111,237,0.18)" stroke="#2f6fed" stroke-width="1.6" stroke-dasharray="3.5 2.6"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="4.6" fill="#2f6fed" stroke="#ffffff" stroke-width="2"/>
  </svg>`;
  return new BMapGL.Icon(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, new BMapGL.Size(size, size), {
    anchor: new BMapGL.Size(size / 2, size / 2)
  });
}

function iconFor(color: string, glyph: string, size = 26): any {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 2}" fill="${color}" stroke="#fff" stroke-width="2"/>
    <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-size="${Math.round(size * 0.42)}" fill="#fff" font-family="PingFang SC, Microsoft YaHei, sans-serif">${glyph}</text>
  </svg>`;
  const icon = new BMapGL.Icon(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, new BMapGL.Size(size, size), {
    anchor: new BMapGL.Size(size / 2, size / 2)
  });
  return icon;
}
