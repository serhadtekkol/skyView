import * as THREE from 'three';
import { lonToTX, latToTY, txToLon, tyToLat } from './geo.js';
import { smoothstep, clamp, lerp } from './noise.js';

// Streaming real-world terrain: Web-Mercator quadtree, Esri World Imagery draped on
// AWS Terrain Tiles (Terrarium) elevation, with runway flattening.  Physics samples the
// same elevation data through heightAt().

const ELEV_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const IMG_URL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
// NASA VIIRS Black Marble night lights (500 m, max zoom 8)
const NIGHT_URL = (z, x, y) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/default/GoogleMapsCompatible_Level8/${z}/${y}/${x}.png`;
const NIGHT_Z = 8;
export const IMAGERY_ATTRIBUTION = 'Uydu: Esri, Maxar, Earthstar Geographics · Yükseklik: Mapzen/AWS Terrain Tiles · Havalimanları: OurAirports';

const EZ_MAX = 12;      // elevation zoom (≈30 m/px at mid latitudes)
const ZMAX = 17;        // imagery zoom near the camera (≈1 m/px)
const ROOT_Z = 8;
const GRID = 32;
const SPLIT = 1.25;
const MAX_ACTIVE = 10;
const MAX_TILES = 700;

const ekey = (z, x, y) => z * 1e8 + x * 1e4 + y;

let _canvas = null, _ctx = null;
function pixelsOf(bitmap) {
  if (!_canvas) {
    _canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
    _ctx = _canvas.getContext('2d', { willReadFrequently: true });
  }
  _ctx.clearRect(0, 0, 256, 256);
  _ctx.drawImage(bitmap, 0, 0, 256, 256);
  return _ctx.getImageData(0, 0, 256, 256).data;
}

class Tile {
  constructor(z, x, y, terrain) {
    this.z = z; this.x = x; this.y = y; this.t = terrain;
    this.state = 'none'; this.children = null; this.mesh = null; this.lastUsed = 0;
    const f = terrain.frame;
    const nw = f.toLocal(tyToLat(y, z), txToLon(x, z)), se = f.toLocal(tyToLat(y + 1, z), txToLon(x + 1, z));
    this.minX = nw.x; this.maxX = se.x; this.minZ = nw.z; this.maxZ = se.z;
    this.cx = (nw.x + se.x) / 2; this.cz = (nw.z + se.z) / 2;
    this.size = Math.max(se.x - nw.x, se.z - nw.z);
    this.hAvg = terrain.originElev;
  }
  kids() {
    if (!this.children) {
      const { z, x, y, t } = this;
      this.children = [new Tile(z + 1, 2 * x, 2 * y, t), new Tile(z + 1, 2 * x + 1, 2 * y, t), new Tile(z + 1, 2 * x, 2 * y + 1, t), new Tile(z + 1, 2 * x + 1, 2 * y + 1, t)];
    }
    return this.children;
  }
}

export class RealTerrain {
  constructor(scene, frame, { originElev = 0, radius = 160000 } = {}) {
    this.scene = scene; this.frame = frame; this.originElev = originElev;
    this.group = new THREE.Group(); scene.add(this.group);
    this.elev = new Map();            // key -> { data: Float32Array | null, promise }
    this.flat = [];                   // runway flattening zones
    this.active = 0; this.pending = new Map(); this.frameNo = 0; this.readyCount = 0;
    this.texLoader = new THREE.TextureLoader(); this.texLoader.setCrossOrigin('anonymous');
    this.fallbackMat = new THREE.MeshStandardMaterial({ color: 0x5d6b4a, roughness: 1 });
    this.night = new Map();           // key -> { tex, px } Black Marble tiles
    this.nightK = 0;                  // 0 day .. 1 night (emissive city glow)
    this.mats = new Set();
    this.onMaterial = null;           // hook(mat) for weather (snow) decoration
    this.lightMat = null;             // glow material for street lights (set by World)
    // root tiles covering the region
    const ll0 = frame.toLatLon(-radius, -radius), ll1 = frame.toLatLon(radius, radius);
    const x0 = Math.floor(lonToTX(ll0.lon, ROOT_Z)), x1 = Math.floor(lonToTX(ll1.lon, ROOT_Z));
    const y0 = Math.floor(latToTY(ll0.lat, ROOT_Z)), y1 = Math.floor(latToTY(ll1.lat, ROOT_Z));
    this.roots = [];
    this.rootKeys = new Set();
    this.ensureCoverage(frame.lat0, frame.lon0, radius);
  }

  ensureCoverage(lat, lon, padM = 80000) {
    const p = this.frame.toLocal(lat, lon);
    const ll0 = this.frame.toLatLon(p.x - padM, p.z - padM), ll1 = this.frame.toLatLon(p.x + padM, p.z + padM);
    const x0 = Math.floor(lonToTX(ll0.lon, ROOT_Z)), x1 = Math.floor(lonToTX(ll1.lon, ROOT_Z));
    const y0 = Math.floor(latToTY(ll0.lat, ROOT_Z)), y1 = Math.floor(latToTY(ll1.lat, ROOT_Z));
    const maxN = 2 ** ROOT_Z;
    for (let y = Math.max(0, y0); y <= Math.min(maxN - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(maxN - 1, x1); x++) {
        const key = `${x},${y}`;
        if (this.rootKeys.has(key)) continue;
        this.rootKeys.add(key);
        this.roots.push(new Tile(ROOT_Z, x, y, this));
      }
    }
  }

  refreshArea(cx, cz, r = 7000) {
    const visit = (t) => {
      if (t.maxX < cx - r || t.minX > cx + r || t.maxZ < cz - r || t.minZ > cz + r) return;
      if (t.state === 'ready' || t.state === 'loading') this.dispose(t);
      t.children?.forEach(visit);
    };
    this.roots.forEach(visit);
  }

  // ------------------------------------------------------------------ elevation
  loadElev(z, x, y) {
    const k = ekey(z, x, y);
    let e = this.elev.get(k);
    if (e) return e.promise;
    e = { data: null, promise: null };
    this.elev.set(k, e);
    e.promise = (async () => {
      try {
        const r = await fetch(ELEV_URL(z, x, y), { mode: 'cors' });
        if (!r.ok) throw new Error(r.status);
        const bmp = await createImageBitmap(await r.blob());
        const px = pixelsOf(bmp);
        const d = new Float32Array(256 * 256);
        for (let i = 0; i < d.length; i++) d[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
        e.data = d;
      } catch (err) { e.data = new Float32Array(256 * 256); e.failed = true; }
      return e.data;
    })();
    return e.promise;
  }

  /** Bilinear sample of a loaded elevation tile at fractional tile coords (fx,fy in tile units). */
  static sample(d, fx, fy) {
    const px = clamp(fx * 256 - 0.5, 0, 255), py = clamp(fy * 256 - 0.5, 0, 255);
    const ix = Math.min(Math.floor(px), 254), iy = Math.min(Math.floor(py), 254);
    const u = px - ix, v = py - iy, i = iy * 256 + ix;
    return (d[i] * (1 - u) + d[i + 1] * u) * (1 - v) + (d[i + 256] * (1 - u) + d[i + 257] * u) * v;
  }

  /** Raw DEM height (may be negative over the sea), best loaded resolution. */
  demAtLatLon(lat, lon) {
    for (let z = EZ_MAX; z >= 0; z--) {
      const tx = lonToTX(lon, z), ty = latToTY(lat, z);
      const ix = Math.floor(tx), iy = Math.floor(ty);
      const e = this.elev.get(ekey(z, ix, iy));
      if (e && e.data) return RealTerrain.sample(e.data, tx - ix, ty - iy);
    }
    return null;
  }

  flatten(x, z, h) {
    for (const f of this.flat) {
      const rx = x - f.cx, rz = z - f.cz;
      const s = rx * f.dx + rz * f.dz, t = rx * f.dz - rz * f.dx;
      const ds = Math.max(0, Math.abs(s) - f.halfLen - 150), dt = Math.max(0, Math.abs(t) - f.halfWid - 90);
      if (ds > 300 || dt > 300) continue;
      const w = 1 - smoothstep(0, 300, Math.hypot(ds, dt));
      const e = f.e0 + f.slope * clamp(s, -f.halfLen - 150, f.halfLen + 150);
      h = lerp(h, e, w);
    }
    return h;
  }

  rawHeight(x, z) {
    const ll = this.frame.toLatLon(x, z);
    const d = this.demAtLatLon(ll.lat, ll.lon);
    return this.flatten(x, z, d === null ? this.originElev : d);
  }
  groundHeight(x, z) { return Math.max(this.rawHeight(x, z), 0); }

  /** Loads elevation tiles (EZ_MAX) around a point; awaits them. */
  async preloadElevation(x, z, radius = 6000) {
    const a = this.frame.toLatLon(x - radius, z - radius), b = this.frame.toLatLon(x + radius, z + radius);
    const jobs = [];
    for (let ty = Math.floor(latToTY(a.lat, EZ_MAX)); ty <= Math.floor(latToTY(b.lat, EZ_MAX)); ty++)
      for (let tx = Math.floor(lonToTX(a.lon, EZ_MAX)); tx <= Math.floor(lonToTX(b.lon, EZ_MAX)); tx++) jobs.push(this.loadElev(EZ_MAX, tx, ty));
    await Promise.all(jobs);
  }

  /** Adds a flattened, linearly sloped strip (runway). Elevations sampled from the DEM. */
  addRunwayZone(c, dirX, dirZ, halfLen, halfWid) {
    // least-squares line through DEM samples along the centreline
    const n = 24; let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const s = -halfLen + (2 * halfLen) * i / (n - 1);
      const ll = this.frame.toLatLon(c.x + dirX * s, c.z + dirZ * s);
      const h = this.demAtLatLon(ll.lat, ll.lon) ?? this.originElev;
      sx += s; sy += h; sxx += s * s; sxy += s * h;
    }
    const slope = clamp((n * sxy - sx * sy) / (n * sxx - sx * sx), -0.015, 0.015);
    const e0 = sy / n - slope * sx / n;
    const zone = { cx: c.x, cz: c.z, dx: dirX, dz: dirZ, halfLen, halfWid, e0, slope };
    this.flat.push(zone);
    return zone;
  }

  // ------------------------------------------------------------------ tiles
  async buildTile(tile) {
    const { z, x, y } = tile;
    const ez = Math.min(z, EZ_MAX), sh = z - ez;
    const ex = x >> sh, ey = y >> sh;
    const nz = Math.min(z, NIGHT_Z), ns = z - nz;
    const [ed, tex, night] = await Promise.all([
      this.loadElev(ez, ex, ey),
      this.texLoader.loadAsync(IMG_URL(z, x, y)).catch(() => null),
      this.loadNight(nz, x >> ns, y >> ns),
    ]);
    if (tile.state !== 'loading') { tex?.dispose(); return; }   // evicted meanwhile
    const N = GRID + 1, scale = 1 / 2 ** sh;
    const ox = (x - (ex << sh)) * scale, oy = (y - (ey << sh)) * scale;
    const f = this.frame;
    const vcount = N * N + 4 * N;
    const pos = new Float32Array(vcount * 3), nrm = new Float32Array(vcount * 3), uv = new Float32Array(vcount * 2);
    const H = new Float32Array(N * N);
    let hsum = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const fx = i / GRID, fy = j / GRID;
      const lat = tyToLat(y + fy, z), lon = txToLon(x + fx, z);
      const p = f.toLocal(lat, lon);
      let h = RealTerrain.sample(ed, ox + fx * scale, oy + fy * scale);
      h = Math.max(this.flatten(p.x, p.z, h), 0);
      const k = j * N + i;
      H[k] = h; hsum += h;
      pos[k * 3] = p.x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = p.z;
      uv[k * 2] = fx; uv[k * 2 + 1] = 1 - fy;
    }
    tile.hAvg = hsum / (N * N);
    // normals by central differences on the grid
    const dxm = (tile.maxX - tile.minX) / GRID, dzm = (tile.maxZ - tile.minZ) / GRID;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const hl = H[j * N + Math.max(i - 1, 0)], hr = H[j * N + Math.min(i + 1, GRID)];
      const hu = H[Math.max(j - 1, 0) * N + i], hd = H[Math.min(j + 1, GRID) * N + i];
      const sx = (hr - hl) / ((Math.min(i + 1, GRID) - Math.max(i - 1, 0)) * dxm);
      const sz = (hd - hu) / ((Math.min(j + 1, GRID) - Math.max(j - 1, 0)) * dzm);
      const l = Math.hypot(sx, 1, sz);
      nrm[k * 3] = -sx / l; nrm[k * 3 + 1] = 1 / l; nrm[k * 3 + 2] = -sz / l;
    }
    // skirts hide cracks between LOD levels
    const skirt = tile.size * 0.03 + 8;
    const edges = [[...Array(N).keys()].map(i => i), [...Array(N).keys()].map(i => GRID * N + i), [...Array(N).keys()].map(j => j * N), [...Array(N).keys()].map(j => j * N + GRID)];
    let v = N * N;
    const idx = [];
    for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    edges.forEach((edge, e) => {
      const start = v;
      for (const k of edge) {
        pos[v * 3] = pos[k * 3]; pos[v * 3 + 1] = pos[k * 3 + 1] - skirt; pos[v * 3 + 2] = pos[k * 3 + 2];
        nrm.set(nrm.subarray(k * 3, k * 3 + 3), v * 3); uv[v * 2] = uv[k * 2]; uv[v * 2 + 1] = uv[k * 2 + 1];
        v++;
      }
      for (let m = 0; m < GRID; m++) {
        const a = edge[m], b = edge[m + 1], c = start + m, d = start + m + 1;
        idx.push(a, b, c, b, d, c, a, c, b, b, c, d);   // both windings
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    let mat = this.fallbackMat;
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0, color: 0xf2f2f2 });
    }
    // city glow: the Black Marble tile (or the part of it under this tile) as emissive map
    if (night && mat !== this.fallbackMat) {
      const n = 2 ** ns, ix = x - ((x >> ns) << ns), iy = y - ((y >> ns) << ns);
      const et = night.tex.clone();
      et.repeat.set(1 / n, 1 / n); et.offset.set(ix / n, 1 - (iy + 1) / n); et.needsUpdate = true;
      mat.emissiveMap = et; mat.emissive.setRGB(1.0, 0.78, 0.5); mat.emissiveIntensity = this.nightK * 2.4;
      this.mats.add(mat);
    }
    if (mat !== this.fallbackMat) this.onMaterial?.(mat);
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true; mesh.visible = false; mesh.matrixAutoUpdate = false;
    // individual street lights where the night-lights data is bright (detailed tiles only)
    if (night && this.lightMat && z >= 12 && z <= 15) {
      const pts = this.streetLights(tile, night, ns, H, N);
      if (pts) mesh.add(pts);
    }
    tile.mesh = mesh; tile.state = 'ready'; this.readyCount++;
    this.group.add(mesh);
  }

  loadNight(z, x, y) {
    const k = ekey(z, x, y);
    let e = this.night.get(k);
    if (e) return e.promise;
    e = { promise: null };
    this.night.set(k, e);
    e.promise = (async () => {
      try {
        const r = await fetch(NIGHT_URL(z, x, y), { mode: 'cors' });
        if (!r.ok) throw new Error(r.status);
        const bmp = await createImageBitmap(await r.blob());
        const c = document.createElement('canvas'); c.width = c.height = 256;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0, 256, 256);
        const px = ctx.getImageData(0, 0, 256, 256).data;
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        return { tex, px };
      } catch { return null; }
    })();
    return e.promise;
  }

  /** Scatters glowing points proportional to the night-light radiance inside the tile. */
  streetLights(tile, night, ns, H, N) {
    const n = 2 ** ns, ix = tile.x - ((tile.x >> ns) << ns), iy = tile.y - ((tile.y >> ns) << ns);
    const px0 = ix * 256 / n, py0 = iy * 256 / n, span = 256 / n;           // sub-rect in Black Marble pixels
    const areaKm2 = ((tile.maxX - tile.minX) * (tile.maxZ - tile.minZ)) / 1e6;
    const S = 20, cellKm2 = areaKm2 / (S * S);
    let seed = (tile.x * 73856093) ^ (tile.y * 19349663) ^ (tile.z * 83492791);
    const rnd = () => { seed = (seed * 1664525 + 1013904223) | 0; return ((seed >>> 0) / 4294967296); };
    const pos = [], col = [];
    for (let j = 0; j < S && pos.length < 6000; j++) for (let i = 0; i < S; i++) {
      const bx = Math.min(255, Math.floor(px0 + (i + 0.5) / S * span)), by = Math.min(255, Math.floor(py0 + (j + 0.5) / S * span));
      const p = night.px, o = (by * 256 + bx) * 4;
      const b = Math.max(0, (0.3 * p[o] + 0.55 * p[o + 1] + 0.15 * p[o + 2]) / 255 - 0.12) / 0.88;
      if (b <= 0.02) continue;
      let count = Math.pow(b, 1.6) * 1100 * cellKm2;
      count = Math.floor(count) + (rnd() < count % 1 ? 1 : 0);
      for (let k = 0; k < count; k++) {
        const fx = (i + rnd()) / S, fy = (j + rnd()) / S;
        // height from the tile grid (bilinear)
        const gx = fx * (N - 1), gy = fy * (N - 1), x0 = Math.floor(gx), y0 = Math.floor(gy), x1 = Math.min(x0 + 1, N - 1), y1 = Math.min(y0 + 1, N - 1);
        const u = gx - x0, v = gy - y0;
        const h = (H[y0 * N + x0] * (1 - u) + H[y0 * N + x1] * u) * (1 - v) + (H[y1 * N + x0] * (1 - u) + H[y1 * N + x1] * u) * v;
        const wx = tile.minX + fx * (tile.maxX - tile.minX), wz = tile.minZ + fy * (tile.maxZ - tile.minZ);
        if (h <= 0.5) continue;                                                  // no lights on water
        pos.push(wx, h + 4, wz);
        const w = rnd();
        if (w < 0.62) col.push(1.0, 0.6, 0.22); else if (w < 0.92) col.push(1.0, 0.92, 0.78); else col.push(0.75, 0.85, 1.0);
      }
    }
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const pts = new THREE.Points(g, this.lightMat);
    pts.frustumCulled = false;
    return pts;
  }

  /** 0 (day) .. 1 (night): city glow on the imagery. */
  setNight(k) {
    if (Math.abs(k - this.nightK) < 0.01) return;
    this.nightK = k;
    for (const m of this.mats) m.emissiveIntensity = k * 2.4;
  }

  request(tile, prio) {
    if (tile.state !== 'none') return;
    const p = this.pending.get(tile);
    if (p === undefined || prio < p) this.pending.set(tile, prio);
  }

  dispose(tile) {
    if (tile.mesh) {
      this.group.remove(tile.mesh);
      tile.mesh.geometry.dispose();
      if (tile.mesh.material !== this.fallbackMat) {
        tile.mesh.material.map?.dispose(); tile.mesh.material.emissiveMap?.dispose();
        this.mats.delete(tile.mesh.material); tile.mesh.material.dispose();
      }
      tile.mesh.children.forEach(c => c.geometry?.dispose());
      tile.mesh = null; this.readyCount--;
    }
    tile.state = 'none';
  }

  update(camPos) {
    this.frameNo++;
    this.pending.clear();
    const fn = this.frameNo;
    const visit = (t) => {
      t.lastUsed = fn;
      const dx = Math.max(t.minX - camPos.x, 0, camPos.x - t.maxX), dz = Math.max(t.minZ - camPos.z, 0, camPos.z - t.maxZ);
      const dy = camPos.y - t.hAvg;
      const d = Math.hypot(dx, dz, dy);
      if (t.z < ZMAX && d < t.size * SPLIT) {
        const kids = t.kids();
        let all = true;
        for (const k of kids) { if (k.state !== 'ready') { all = false; this.request(k, k.z * 1e6 + d); } }
        if (all && t.state === 'ready') { if (t.mesh) t.mesh.visible = false; kids.forEach(visit); return; }
        if (all && t.state !== 'ready') { kids.forEach(visit); return; }
      }
      if (t.state === 'ready') t.mesh.visible = true; else this.request(t, t.z * 1e6 + d);
      if (t.children) hideBelow(t);
    };
    const hideBelow = (t) => { for (const k of t.children) { if (k.mesh) k.mesh.visible = false; if (k.children) hideBelow(k); } };
    this.roots.forEach(visit);

    // start loads, best priority first
    if (this.active < MAX_ACTIVE && this.pending.size) {
      const list = [...this.pending.entries()].sort((a, b) => a[1] - b[1]);
      for (const [tile] of list) {
        if (this.active >= MAX_ACTIVE) break;
        tile.state = 'loading'; this.active++;
        this.buildTile(tile).catch(e => { console.warn('tile', e); tile.state = 'none'; }).finally(() => { this.active--; });
      }
    }
    // evict least recently used
    if (this.readyCount > MAX_TILES) {
      const all = [];
      const collect = (t) => { if (t.state === 'ready' && t.z > ROOT_Z) all.push(t); t.children?.forEach(collect); };
      this.roots.forEach(collect);
      all.sort((a, b) => a.lastUsed - b.lastUsed);
      for (const t of all.slice(0, this.readyCount - MAX_TILES * 0.85)) if (t.lastUsed < fn) this.dispose(t);
    }
  }

  get busy() { return this.active > 0 || this.pending.size > 0; }

  /** Runs the selection loop for a camera position until nearby tiles are loaded. */
  async preload(pos, onProgress, timeoutMs = 25000) {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      this.update(pos);
      onProgress?.(this.readyCount);
      if (!this.busy) break;
      await new Promise(r => setTimeout(r, 120));
    }
  }
}
