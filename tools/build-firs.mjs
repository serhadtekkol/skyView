// Builds assets/firs.json (FIR boundaries + names) from the VATSpy data project.
// Source: https://github.com/vatsimnetwork/vatspy-data-project  (CC BY-SA 4.0, simulation use only)
// Usage: node tools/build-firs.mjs <downloadDir>
import fs from 'fs';
import path from 'path';

const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/build-firs.mjs <downloadDir>'); process.exit(1); }
const BASE = 'https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master/';
async function get(name) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) {
    const r = await fetch(BASE + name); if (!r.ok) throw new Error(name + ' ' + r.status);
    fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
  }
  return fs.readFileSync(p, 'utf8');
}

const dat = (await get('VATSpy.dat')).split(/\r?\n/);
const geo = JSON.parse(await get('Boundaries.geojson'));

// ---- parse VATSpy.dat sections
const sections = {}; let cur = null;
for (const line of dat) {
  if (/^\[.+\]$/.test(line)) { cur = line.slice(1, -1); sections[cur] = []; continue; }
  if (!cur || !line.trim() || line.startsWith(';')) continue;
  sections[cur].push(line.split('|'));
}
const countries = new Map(sections.Countries.map(([name, prefix]) => [prefix, name]));
// FIR names: prefer the record without a callsign prefix, else any record for that boundary
const firs = new Map();
for (const [icao, name, prefix, boundary] of sections.FIRs) {
  if (icao.includes('-') || (boundary || icao) !== icao) continue;
  const cur = firs.get(icao);
  if (!cur || (cur.prefix && !prefix)) firs.set(icao, { name, prefix });
}
// US ARTCCs have boundaries but no FIR records
const ARTCC = { KZAB: 'Albuquerque Center', KZAU: 'Chicago Center', KZBW: 'Boston Center', KZDC: 'Washington Center', KZDV: 'Denver Center',
  KZFW: 'Fort Worth Center', KZHU: 'Houston Center', KZID: 'Indianapolis Center', KZJX: 'Jacksonville Center', KZKC: 'Kansas City Center',
  KZLA: 'Los Angeles Center', KZLC: 'Salt Lake Center', KZMA: 'Miami Center', KZME: 'Memphis Center', KZMP: 'Minneapolis Center',
  KZNY: 'New York Center', KZOA: 'Oakland Center', KZOB: 'Cleveland Center', KZSE: 'Seattle Center', KZTL: 'Atlanta Center', KZAK: 'Oakland Oceanic', PAZA: 'Anchorage Center', PHZH: 'Honolulu Control' };
for (const f of geo.features) { const id = f.properties.id; if (!id.includes('-') && !firs.has(id)) firs.set(id, { name: ARTCC[id] || id, prefix: '' }); }
const uirOf = new Map();
for (const [id, name, list] of sections.UIRs || []) for (const f of (list || '').split(',')) if (f) uirOf.set(f.trim(), `${id} ${name}`);

// ---- Douglas-Peucker simplification (degrees)
function simplify(pts, tol) {
  if (pts.length < 5) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / L;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** Closed rings: split at the vertex farthest from the start so neither half is degenerate. */
function simplifyRing(ring, tol) {
  if (ring.length < 8) return ring;
  let far = 1, fd = 0;
  for (let i = 1; i < ring.length - 1; i++) { const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]); if (d > fd) { fd = d; far = i; } }
  const a = simplify(ring.slice(0, far + 1), tol), b = simplify(ring.slice(far), tol);
  return a.concat(b.slice(1));
}

const out = [];
for (const f of geo.features) {
  const id = f.properties.id;
  if (!firs.has(id) || id.includes('-')) continue;
  if (/\bTMA\b|\(up to|\(above|approach|\bAPP\b|terminal|delivery|ground|tower/i.test(firs.get(id).name)) continue;   // sectors / terminal areas, not FIRs
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const rings = [];
  let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
  for (const poly of polys) for (const ring of poly) {
    const s = simplifyRing(ring, 0.01);
    const flat = [];
    for (const [lon, lat] of s) {
      flat.push(+lon.toFixed(3), +lat.toFixed(3));
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon); minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    }
    if (flat.length >= 6) rings.push(flat);
  }
  if (!rings.length) continue;
  out.push({
    id, name: firs.get(id).name, country: countries.get(id.slice(0, 2)) || countries.get(id.slice(0, 1)) || '',
    oceanic: f.properties.oceanic === '1', region: f.properties.region || '', division: f.properties.division || '',
    uir: uirOf.get(id) || '', label: [+(+f.properties.label_lon).toFixed(2), +(+f.properties.label_lat).toFixed(2)],
    bbox: [+minLon.toFixed(3), +minLat.toFixed(3), +maxLon.toFixed(3), +maxLat.toFixed(3)], rings,
  });
}
const target = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'assets', 'firs.json');
fs.writeFileSync(target, JSON.stringify({ source: 'VATSpy data project (vatsimnetwork) · CC BY-SA 4.0 · simulation use only', firs: out }));
console.log(`${out.length} FIRs -> ${target} (${(fs.statSync(target).size / 1024).toFixed(0)} KB)`);
console.log(out.filter(f => /^L[TGC]/.test(f.id)).map(f => `${f.id} ${f.name} (${f.country}) rings=${f.rings.length} pts=${f.rings.reduce((s, r) => s + r.length / 2, 0)}`).join('\n'));
