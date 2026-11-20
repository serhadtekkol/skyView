import * as L from '/node_modules/leaflet/dist/leaflet-src.esm.js';

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
#minimap .mm-bar button { pointer-events: auto; width: 28px; height: 28px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.25);
  background: rgba(6,10,16,0.75); color: #e8f1ff; font: bold 14px "Segoe UI", sans-serif; cursor: pointer; padding: 0; }
#minimap .mm-bar button.on { border-color: #31d0ff; color: #31d0ff; }
#minimap .mm-info { position: absolute; left: 6px; bottom: 6px; z-index: 1000; padding: 3px 7px; border-radius: 5px; background: rgba(6,10,16,0.75);
  font: 11px Consolas, monospace; color: #e8f1ff; pointer-events: none; }
#minimap .leaflet-control-attribution { font-size: 9px; background: rgba(0,0,0,0.45); color: #ccc; }
#minimap .leaflet-control-attribution a { color: #9fe6ff; }
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
      <div class="mm-bar"><button data-a="follow" class="on" title="Uçağı takip et">◎</button><button data-a="in" title="Yakınlaş">+</button>
      <button data-a="out" title="Uzaklaş">−</button><button data-a="big" title="Büyüt / küçült">⤢</button></div>
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
    map.on('dragstart', () => this.setFollow(false));
    box.querySelector('.mm-bar').addEventListener('click', (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'follow') this.setFollow(!this.follow);
      else if (a === 'in') map.zoomIn();
      else if (a === 'out') map.zoomOut();
      else if (a === 'big') { box.classList.toggle('big'); setTimeout(() => map.invalidateSize(), 220); }
    });
    this.info = box.querySelector('.mm-info');
  }

  setFollow(v) { this.follow = v; this.box.querySelector('[data-a="follow"]').classList.toggle('on', v); }
  toggle() { this.box.style.display = this.box.style.display === 'none' ? '' : 'none'; if (this.box.style.display === '') this.map.invalidateSize(); return this.box.style.display !== 'none'; }
  setVisible(v) { this.box.style.display = v ? '' : 'none'; if (v) this.map.invalidateSize(); }

  reset() { this.trail.setLatLngs([]); this.lastPt = null; }

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
    this.info.textContent = `${ll.lat.toFixed(4)}°, ${ll.lon.toFixed(4)}°  ·  HDG ${fm.heading.toFixed(0).padStart(3, '0')}°`;
  }
}
