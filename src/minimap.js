import * as L from '/node_modules/leaflet/dist/leaflet-src.esm.js';
import { tips } from './tooltip.js';
import { todDistanceNm, NM } from './flightplan.js';

// In-flight moving map (top-right): satellite + labels, aircraft symbol rotated to heading,
// flown track, runways.  V toggles, buttons: follow / enlarge / zoom.

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

const CSS = `
#minimap { position: fixed; top: 48px; right: 16px; width: 300px; height: 300px; z-index: 5; border-radius: 12px; overflow: hidden;
  border: 1px solid rgba(140,170,210,0.35); box-shadow: 0 10px 30px rgba(0,0,0,0.45); background: #0b1220; transition: width .2s, height .2s; }
#minimap.big { width: min(46vw, 720px); height: min(62vh, 620px); }
#minimap .mm-map { position: absolute; inset: 0; }
#minimap .mm-bar { position: absolute; top: 6px; left: 6px; right: 6px; z-index: 1000; display: flex; gap: 4px; justify-content: flex-end; pointer-events: none; }
#minimap .mm-grip { pointer-events: auto; margin-right: auto; width: 28px; height: 28px; border-radius: 6px; background: rgba(6,10,16,0.75); border: 1px solid rgba(255,255,255,0.25); }
#minimap .mm-bar button { pointer-events: auto; width: 28px; height: 28px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.25);
  background: rgba(6,10,16,0.75); color: #e8f1ff; font: bold 14px "Segoe UI", sans-serif; cursor: pointer; padding: 0; }
#minimap .mm-bar button.on { border-color: #31d0ff; color: #31d0ff; }
#minimap .mm-info { position: absolute; left: 6px; bottom: 6px; z-index: 1000; padding: 3px 7px; border-radius: 5px; background: rgba(6,10,16,0.75);
  font: 11px Consolas, monospace; color: #e8f1ff; pointer-events: none; }
#minimap .mm-elev { position: absolute; left: 6px; bottom: 28px; z-index: 1000; padding: 3px 7px; border-radius: 5px; background: rgba(6,10,16,0.85);
  border: 1px solid rgba(49,208,255,0.35); font: bold 11px Consolas, monospace; color: #9fe6ff; pointer-events: none; display: none; }
#minimap .leaflet-control-attribution { font-size: 9px; background: rgba(0,0,0,0.45); color: #ccc; }
#minimap .leaflet-control-attribution a { color: #9fe6ff; }
.mm-firlbl { color: #31d0ff; font: bold 12px Consolas, monospace; text-align: center; text-shadow: 0 0 3px #000, 0 0 2px #000; white-space: nowrap; }
.mm-firlbl small { font: 10px "Segoe UI", sans-serif; color: #cfefff; }
.leaflet-tooltip.mm-tick { background: rgba(6,10,16,0.7); border: 0; box-shadow: none; color: #ffd23f; font: 10px Consolas, monospace; padding: 0 3px; }
.leaflet-tooltip.mm-tick::before { display: none; }
.mm-plane { width: 34px; height: 34px; }
.mm-plane svg { width: 34px; height: 34px; transform-origin: 50% 50%; filter: drop-shadow(0 0 2px #000) drop-shadow(0 0 1px #000); }
`;

const PLANE_SVG = `<svg viewBox="0 0 64 64"><path fill="#ffd23f" stroke="#1a1a1a" stroke-width="2.5" stroke-linejoin="round"
  d="M32 3c2.4 0 3.6 3 3.6 6v14l20 11v5l-20-5.5v12.5l6.5 5v4L32 52l-10.1 3v-4l6.5-5V33.5L8.4 39v-5l20-11V9c0-3 1.2-6 3.6-6z"/></svg>`;

export class MiniMap {
  constructor(world) {
    this.world = world;
    if (!document.getElementById('mm-style')) {
      const st = document.createElement('style'); st.id = 'mm-style'; st.textContent = CSS; document.head.appendChild(st);
    }
    const box = this.box = document.createElement('div');
    box.id = 'minimap';
    box.innerHTML = `<div class="mm-map"></div>
      <div class="mm-bar"><span class="mm-grip">⋮⋮</span><button data-a="follow" class="on" title="Uçağı takip et">◎</button><button data-a="in" title="Yakınlaş">+</button>
      <button data-a="out" title="Uzaklaş">−</button><button data-a="big" title="Büyüt / küçült">⤢</button></div>
      <div class="mm-elev"></div>
      <div class="mm-info"></div>`;
    document.body.appendChild(box);
    // keep camera-drag / wheel events from reaching the 3D view
    ['pointerdown', 'wheel', 'dblclick'].forEach(ev => box.addEventListener(ev, e => e.stopPropagation()));

    const f = world.frame;
    const c = f.toLatLon(world.spawn.x, world.spawn.z);
    const map = this.map = L.map(box.querySelector('.mm-map'), {
      zoomControl: false, attributionControl: true, keyboard: false, preferCanvas: true, zoomSnap: 0.5,
    }).setView([c.lat, c.lon], 12);
    map.attributionControl.setPrefix(false);
    L.tileLayer(ESRI, { maxZoom: 18, attribution: 'Esri, Maxar' }).addTo(map);
    L.tileLayer(LABELS, { maxZoom: 18 }).addTo(map);

    // runways of the selected airport
    const site = world.site;
    if (site.kind === 'airport') {
      site.airport.rw.forEach((r, i) => {
        L.polyline([[r.le.lat, r.le.lon], [r.he.lat, r.he.lon]], { color: i === site.rwIndex ? '#ffd23f' : '#ffffff', weight: 4, opacity: 0.9 }).addTo(map);
      });
    }
    this.trail = L.polyline([], { color: '#ff4fd8', weight: 2.5, opacity: 0.85 }).addTo(map);
    this.plane = L.marker([c.lat, c.lon], { icon: L.divIcon({ className: 'mm-plane', html: PLANE_SVG, iconSize: [34, 34], iconAnchor: [17, 17] }), interactive: false, keyboard: false }).addTo(map);
    this.svg = this.plane.getElement()?.querySelector('svg');

    this.follow = true;
    this.lastPt = null; this.acc = 0;
    this.onMapClick = null;
    this.routeLayer = L.layerGroup().addTo(map);
    this.draftLayer = L.layerGroup().addTo(map);
    map.on('dragstart', () => this.setFollow(false));
    map.on('click', (e) => { this.onMapClick?.(e.latlng.lat, e.latlng.lng); });
    box.querySelector('.mm-bar').addEventListener('click', (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'follow') this.setFollow(!this.follow);
      else if (a === 'in') map.zoomIn();
      else if (a === 'out') map.zoomOut();
      else if (a === 'big') { box.classList.toggle('big'); setTimeout(() => map.invalidateSize(), 220); }
    });
    this.info = box.querySelector('.mm-info');
    this.elevEl = box.querySelector('.mm-elev');
    this._elevTimer = null;
    this._elevSeq = 0;
    const fmtElev = (m) => {
      if (m == null) return 'YER: …';
      if (m <= 1) return 'DENİZ · 0 ft (0 m)';
      const ft = Math.round(m * 3.28084);
      return `YER: ${ft} ft (${Math.round(m)} m)`;
    };
    map.on('mousemove', (e) => {
      const t = this.world?.terrain;
      if (!t || !this.elevEl) return;
      const { lat, lng } = e.latlng;
      this.elevEl.style.display = 'block';
      const cached = t.demAtLatLon(lat, lng);
      if (cached != null) {
        this.elevEl.textContent = fmtElev(Math.max(0, cached));
        return;
      }
      this.elevEl.textContent = 'YER: yükleniyor…';
      clearTimeout(this._elevTimer);
      const seq = ++this._elevSeq;
      this._elevTimer = setTimeout(async () => {
        const m = await t.elevationAtLatLon(lat, lng);
        if (seq === this._elevSeq && this.elevEl) this.elevEl.textContent = fmtElev(m);
      }, 90);
    });
    map.on('mouseout', () => {
      clearTimeout(this._elevTimer);
      this._elevSeq++;
      if (this.elevEl) this.elevEl.style.display = 'none';
    });
    tips(box, {
      '[data-a="follow"]': 'Takip|Haritayı uçağa kilitler. Haritayı sürüklersen takip kapanır; bu düğmeyle geri aç.',
      '[data-a="in"]': 'Yakınlaş|Haritayı yakınlaştırır (fare tekerleği de çalışır).',
      '[data-a="out"]': 'Uzaklaş|Haritayı uzaklaştırır.',
      '[data-a="big"]': 'Büyüt / küçült|Haritayı ekranın yaklaşık yarısına büyütür. Sarı çizgi burun yönü (heading), kesikli beyaz çizgi yer izi (track); noktalar 10/50 km aralıklı.',
    });
  }

  setFollow(v) { this.follow = v; this.box.querySelector('[data-a="follow"]').classList.toggle('on', v); }
  toggle() { this.box.style.display = this.box.style.display === 'none' ? '' : 'none'; if (this.box.style.display === '') this.map.invalidateSize(); return this.box.style.display !== 'none'; }
  setVisible(v) { this.box.style.display = v ? '' : 'none'; if (v) this.map.invalidateSize(); }

  reset() { this.trail.setLatLngs([]); this.lastPt = null; }

  setDraftRoute(points) {
    this.draftLayer.clearLayers();
    if (!points || points.length < 2) return;
    const fmtC = (a) => !a ? '' : a.type === 'AOA' ? ` A${a.ft}` : a.type === 'AOB' ? ` B${a.ft}` : ` ${a.ft}ft`;
    L.polyline(points.map(p => [p.lat, p.lon]), { color: '#ffb020', weight: 2, opacity: 0.9, dashArray: '6 6', interactive: false }).addTo(this.draftLayer);
    for (const p of points) {
      if (p.kind === 'wpt') {
        L.circleMarker([p.lat, p.lon], { radius: 4, color: '#ffb020', weight: 1.5, fillColor: '#0b1220', fillOpacity: 1, interactive: false })
          .bindTooltip(`${p.id}${fmtC(p.alt)}`, { permanent: true, direction: 'top', className: 'mm-tick' }).addTo(this.draftLayer);
      }
    }
  }

  setActiveRoute(activeRoute) {
    this.routeLayer.clearLayers();
    if (!activeRoute || !activeRoute.points.length) return;
    const fmtC = (a) => !a ? '' : a.type === 'AOA' ? ` A${a.ft}` : a.type === 'AOB' ? ` B${a.ft}` : ` ${a.ft}ft`;
    const pts = activeRoute.points;
    L.polyline(pts.map(p => [p.lat, p.lon]), { color: '#ff4fd8', weight: 2.5, opacity: 0.95, interactive: false }).addTo(this.routeLayer);
    for (const p of pts) {
      const lbl = p.kind === 'wpt' ? `${p.id}${fmtC(p.alt)}` : p.id;
      L.circleMarker([p.lat, p.lon], { radius: p.kind === 'faf' ? 4.5 : 4, color: '#ff4fd8', weight: 1.5, fillColor: '#ff4fd8', fillOpacity: 0.9, interactive: false })
        .bindTooltip(lbl, { permanent: p.kind !== 'orig', direction: 'top', className: 'mm-tick' }).addTo(this.routeLayer);
    }
    const todM = (10 + todDistanceNm(activeRoute.route.crzFt, activeRoute.route.fafFt)) * NM;
    const todLocal = activeRoute.pointAtDistFromDest(todM);
    if (todLocal) {
      const ll = this.world.frame.toLatLon(todLocal.x, todLocal.z);
      L.circleMarker([ll.lat, ll.lon], { radius: 5, color: '#3cf07a', weight: 2, fillColor: '#0b1220', fillOpacity: 1, interactive: false })
        .bindTooltip('T/D', { permanent: true, direction: 'right', className: 'mm-tick' }).addTo(this.routeLayer);
    }
  }

  /** Draws FIR boundaries around the start point; the current one is highlighted. */
  setFirs(locator) {
    this.firLayer?.remove();
    this.firLayer = L.layerGroup().addTo(this.map);
    this.firPolys = new Map();
    const c = this.map.getCenter();
    for (const f of locator.firs) {
      const [x0, y0, x1, y1] = f.bbox;
      if (x1 < c.lng - 25 || x0 > c.lng + 25 || y1 < c.lat - 18 || y0 > c.lat + 18 || /XX$/.test(f.id) || f.mil) continue;
      const rings = f.rings.map(r => { const a = []; for (let i = 0; i < r.length; i += 2) a.push([r[i + 1], r[i]]); return a; });
      const poly = L.polygon(rings, { color: '#9fe6ff', weight: 1, opacity: 0.55, dashArray: '4 4', fill: false, interactive: false });
      poly.addTo(this.firLayer);
      this.firPolys.set(f, poly);
    }
    this.firLabel?.remove();
  }

  highlightFir(f) {
    if (!this.firPolys) return;
    for (const [fir, poly] of this.firPolys) {
      const on = fir === f;
      poly.setStyle(on ? { color: '#31d0ff', weight: 2.5, opacity: 0.95, dashArray: null, fill: true, fillColor: '#31d0ff', fillOpacity: 0.06 }
        : { color: '#9fe6ff', weight: 1, opacity: 0.55, dashArray: '4 4', fill: false });
    }
    this.firLabel?.remove();
    if (f) this.firLabel = L.marker([f.label[1], f.label[0]], { interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'mm-firlbl', html: `${f.id}<br><small>${f.name}</small>`, iconSize: [120, 30], iconAnchor: [60, 15] }) }).addTo(this.map);
  }

  /** Point at `km` along a great circle from (lat, lon) on bearing `brg`. */
  static dest(lat, lon, brg, km) {
    const R = 6371, d = km / R, b = brg * Math.PI / 180, p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return L.latLng(p2 * 180 / Math.PI, l2 * 180 / Math.PI);
  }

  update(dt, fm) {
    this.acc += dt;
    if (this.acc < 0.1 || this.box.style.display === 'none') return;
    this.acc = 0;
    const ll = this.world.frame.toLatLon(fm.pos.x, fm.pos.z);
    const p = L.latLng(ll.lat, ll.lon);
    this.plane.setLatLng(p);
    if (!this.svg) this.svg = this.plane.getElement()?.querySelector('svg');
    if (this.svg) this.svg.style.transform = `rotate(${fm.heading.toFixed(1)}deg)`;
    if (!this.lastPt || this.lastPt.distanceTo(p) > 60) { this.trail.addLatLng(p); this.lastPt = p; }
    if (this.follow) this.map.panTo(p, { animate: false });

    // heading line (solid, ahead of the nose) + ground-track line (dashed) to the map edge,
    // with distance ticks every 10 / 50 km so headings and distances can be read off the map
    const hdg = fm.heading;
    const b = this.map.getBounds();
    const reachKm = Math.max(5, p.distanceTo(b.getNorthEast()) / 1000 * 1.15);
    if (!this.hdgLine) {
      this.hdgLine = L.polyline([], { color: '#ffd23f', weight: 2.5, opacity: 0.95, interactive: false }).addTo(this.map);
      this.trkLine = L.polyline([], { color: '#ffffff', weight: 1.5, opacity: 0.8, dashArray: '6 6', interactive: false }).addTo(this.map);
      this.ticks = L.layerGroup().addTo(this.map);
    }
    this.hdgLine.setLatLngs([p, MiniMap.dest(p.lat, p.lng, hdg, reachKm)]);
    const gs = Math.hypot(fm.vel.x, fm.vel.z);
    if (gs > 15) {
      const trk = (Math.atan2(fm.vel.x, -fm.vel.z) * 180 / Math.PI + 360) % 360;
      this.trkLine.setLatLngs([p, MiniMap.dest(p.lat, p.lng, trk, reachKm)]);
    } else this.trkLine.setLatLngs([]);
    this.ticks.clearLayers();
    const step = reachKm > 120 ? 50 : 10;
    const labelEvery = step === 10 ? 20 : 100;
    for (let k = step; k < reachKm; k += step) {
      const m = L.circleMarker(MiniMap.dest(p.lat, p.lng, hdg, k), { radius: k % labelEvery === 0 ? 3.5 : 2, color: '#ffd23f', weight: 1, fillColor: '#ffd23f', fillOpacity: 1, interactive: false });
      if (k % labelEvery === 0) m.bindTooltip(`${k} km`, { permanent: true, direction: 'right', className: 'mm-tick', offset: [4, 0] });
      m.addTo(this.ticks);
    }
    const gsKt = gs * 1.943844;
    this.info.textContent = `${ll.lat.toFixed(4)}°, ${ll.lon.toFixed(4)}°  ·  HDG ${hdg.toFixed(0).padStart(3, '0')}°` + (gsKt > 30 ? `  ·  GS ${gsKt.toFixed(0)} kt` : '');
  }
}
