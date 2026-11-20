// Builds assets/airports.json from OurAirports open data (public domain).
// Usage: node tools/build-airports.mjs <downloadDir>
import fs from 'fs';
import path from 'path';

const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/build-airports.mjs <downloadDir>'); process.exit(1); }
const BASE = 'https://davidmegginson.github.io/ourairports-data/';

async function get(name) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) {
    const r = await fetch(BASE + name);
    if (!r.ok) throw new Error(name + ' ' + r.status);
    fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
  }
  return fs.readFileSync(p, 'utf8');
}

function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift();
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const FT = 0.3048;
const num = (v) => (v === '' || v === undefined ? null : Number(v));
const PAVED = /asp|con|bit|pem|tar|paved|asph|concrete/i;

const airports = parseCSV(await get('airports.csv'));
const runways = parseCSV(await get('runways.csv'));

const byRef = new Map();
for (const r of runways) {
  if (r.closed === '1') continue;
  const len = num(r.length_ft) * FT;
  if (!len || len < 1500) continue;
  if (!PAVED.test(r.surface || '')) continue;
  const le = [num(r.le_latitude_deg), num(r.le_longitude_deg)], he = [num(r.he_latitude_deg), num(r.he_longitude_deg)];
  if (le.includes(null) || he.includes(null)) continue;
  const rw = {
    len: Math.round(len), wid: Math.round((num(r.width_ft) || 148) * FT),
    le: { id: r.le_ident, lat: +le[0].toFixed(6), lon: +le[1].toFixed(6), elev: num(r.le_elevation_ft), dth: Math.round((num(r.le_displaced_threshold_ft) || 0) * FT) },
    he: { id: r.he_ident, lat: +he[0].toFixed(6), lon: +he[1].toFixed(6), elev: num(r.he_elevation_ft), dth: Math.round((num(r.he_displaced_threshold_ft) || 0) * FT) },
  };
  if (!byRef.has(r.airport_ref)) byRef.set(r.airport_ref, []);
  byRef.get(r.airport_ref).push(rw);
}

const out = [];
for (const a of airports) {
  if (!['large_airport', 'medium_airport'].includes(a.type)) continue;
  if (a.scheduled_service !== 'yes') continue;
  const rws = byRef.get(a.id);
  if (!rws) continue;
  out.push({
    icao: a.icao_code || a.gps_code || a.ident, iata: a.iata_code || '', name: a.name, city: a.municipality || '',
    cc: a.iso_country, lat: +Number(a.latitude_deg).toFixed(5), lon: +Number(a.longitude_deg).toFixed(5),
    elev: num(a.elevation_ft), big: a.type === 'large_airport' ? 1 : 0, rw: rws,
  });
}
out.sort((a, b) => b.big - a.big || a.icao.localeCompare(b.icao));
const target = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'assets', 'airports.json');
fs.writeFileSync(target, JSON.stringify(out));
console.log(`${out.length} airports, ${out.reduce((s, a) => s + a.rw.length, 0)} runways -> ${target} (${(fs.statSync(target).size / 1024).toFixed(0)} KB)`);
const tr = out.filter(a => a.cc === 'TR');
console.log('TR:', tr.length, tr.slice(0, 12).map(a => `${a.icao}(${a.rw.map(r => r.le.id + '/' + r.he.id).join(',')})`).join(' '));
