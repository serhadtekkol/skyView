import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gcDistanceNm, gcBearing, destPoint, crossTrackNm, turnAnticipationNm, todDistanceNm, machToIas,
  parseAltConstraint, parseWaypoint, runwayEnd, buildRoute, validate, ActiveRoute, vnavTarget, NM,
} from '../src/flightplan.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ±${tol}, got ${a}`);

const AIRPORTS = [
  { icao: 'LTFM', iata: 'IST', name: 'Istanbul', lat: 41.26, lon: 28.74, elev: 325,
    rw: [{ len: 4100, wid: 60, le: { id: '16L', lat: 41.30, lon: 28.72, elev: 300 }, he: { id: '34R', lat: 41.26, lon: 28.74, elev: 320 } }] },
  { icao: 'LTBA', iata: 'ISL', name: 'Ataturk', lat: 40.976, lon: 28.814, elev: 163,
    rw: [{ len: 3000, wid: 60, le: { id: '05', lat: 40.97, lon: 28.80, elev: 150 }, he: { id: '23', lat: 40.99, lon: 28.83, elev: 160 } }] },
  { icao: 'LTAC', iata: 'ESB', name: 'Esenboga', lat: 40.128, lon: 32.995, elev: 3125,
    rw: [{ len: 3750, wid: 60, le: { id: '03R', lat: 40.11, lon: 32.99, elev: 3100 }, he: { id: '21L', lat: 40.14, lon: 33.01, elev: 3120 } }] },
];

// ---------------------------------------------------------------- geodesy
test('great-circle distance: 1° of longitude on the equator ≈ 60.04 NM', () => {
  near(gcDistanceNm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 60.04, 0.05);
});

test('great-circle bearing east along the equator is 090°', () => {
  near(gcBearing({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 90, 0.01);
  near(gcBearing({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 0, 0.01);
});

test('destPoint inverts distance/bearing', () => {
  const p = destPoint({ lat: 41, lon: 29 }, 45, 100);
  near(gcDistanceNm({ lat: 41, lon: 29 }, p), 100, 0.01);
  near(gcBearing({ lat: 41, lon: 29 }, p), 45, 0.01);
});

test('cross-track: left of an eastbound course is negative', () => {
  near(crossTrackNm({ lat: 0.1, lon: 0.5 }, { lat: 0, lon: 0 }, { lat: 0, lon: 1 }), -6.0, 0.05);
  near(crossTrackNm({ lat: -0.1, lon: 0.5 }, { lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 6.0, 0.05);
});

test('turn anticipation at 250 kt, 90° change, 25° bank ≈ 1.95 NM', () => {
  near(turnAnticipationNm(250, 90), 1.95, 0.03);
  assert.equal(turnAnticipationNm(250, 0), 0);
});

test('TOD distance from 35000 ft to 0 ft on 3° ≈ 109.9 NM', () => {
  near(todDistanceNm(35000, 0), 109.9, 0.3);
  assert.equal(todDistanceNm(3000, 5000), 0);
});

test('M0.78 at FL350 ≈ 250 kt IAS (sim uses EAS)', () => {
  near(machToIas(0.78, 35000), 250, 3);
});

// ---------------------------------------------------------------- parsing
test('altitude constraint parsing', () => {
  assert.equal(parseAltConstraint(''), null);
  assert.deepEqual(parseAltConstraint('9000'), { type: 'AT', ft: 9000 });
  assert.deepEqual(parseAltConstraint('AT 9000'), { type: 'AT', ft: 9000 });
  assert.deepEqual(parseAltConstraint('a9000'), { type: 'AOA', ft: 9000 });
  assert.deepEqual(parseAltConstraint('B12000'), { type: 'AOB', ft: 12000 });
  assert.deepEqual(parseAltConstraint('FL120'), { type: 'AT', ft: 12000 });
  assert.equal(parseAltConstraint('xyz'), undefined);
  assert.equal(parseAltConstraint('50000'), undefined);
});

test('waypoint parsing: lat,lon and ICAO', () => {
  assert.deepEqual(parseWaypoint('41.1, 29.5', AIRPORTS), { id: null, lat: 41.1, lon: 29.5 });
  assert.deepEqual(parseWaypoint('41.1 29.5', AIRPORTS), { id: null, lat: 41.1, lon: 29.5 });
  const p = parseWaypoint('ltba', AIRPORTS);
  assert.equal(p.id, 'LTBA'); near(p.lat, 40.976, 1e-9);
  assert.equal(parseWaypoint('95,10', AIRPORTS), null);
  assert.equal(parseWaypoint('ZZZZ', AIRPORTS), null);
  assert.equal(parseWaypoint('', AIRPORTS), null);
});

test('runwayEnd gives the threshold and the landing heading toward the far end', () => {
  const r = runwayEnd(AIRPORTS[1], 0, 'le');
  assert.equal(r.id, '05'); near(r.lat, 40.97, 1e-9); assert.equal(r.elevFt, 150);
  near(r.heading, gcBearing({ lat: 40.97, lon: 28.80 }, { lat: 40.99, lon: 28.83 }), 1e-9);
});

// ---------------------------------------------------------------- route building
const plan = (over = {}) => ({
  origin: { icao: 'LTFM', rwIndex: 0, end: 'he' }, dest: { icao: 'LTBA', rwIndex: 0, end: 'le' },
  wpts: [{ id: 'WP1', lat: 41.2, lon: 28.4, alt: null }], crzFt: 9000, clbKt: 250, crzMach: 0.6, desKt: 250, ...over,
});

test('buildRoute: origin runway → wpts → FAF (10 NM, 3°) → threshold', () => {
  const r = buildRoute(plan(), AIRPORTS);
  assert.deepEqual(r.points.map(p => p.kind), ['orig', 'wpt', 'faf', 'thr']);
  const thr = r.points[3], faf = r.points[2];
  near(gcDistanceNm(faf, thr), 10, 0.01);
  near(gcBearing(faf, thr), r.destRunway.heading, 0.2);
  assert.equal(r.fafFt, 150 + 3200);       // elev + 10 NM·tan3° (3185) rounded up to 100
  assert.deepEqual(faf.alt, { type: 'AT', ft: r.fafFt });
  near(r.totalNm, r.points.slice(1).reduce((s, p, i) => s + gcDistanceNm(r.points[i], p), 0), 1e-9);
});

test('buildRoute without origin starts at PPOS', () => {
  const r = buildRoute(plan({ origin: null }), AIRPORTS, { lat: 41.5, lon: 28.0 });
  assert.equal(r.points[0].kind, 'ppos'); assert.equal(r.points[0].id, 'PPOS');
});

test('validate: missing / unknown destination, limits and the 800 km route cap', () => {
  assert.deepEqual(validate(plan(), AIRPORTS), []);
  assert.match(validate(plan({ dest: null }), AIRPORTS)[0], /Varış/);
  assert.match(validate(plan({ dest: { icao: 'XXXX', rwIndex: 0, end: 'le' } }), AIRPORTS)[0], /XXXX/);
  assert.match(validate(plan({ crzFt: 45000 }), AIRPORTS).join(), /CRZ ALT/);
  assert.match(validate(plan({ crzMach: 0.95 }), AIRPORTS).join(), /Mach/);
  assert.match(validate(plan({ clbKt: 90 }), AIRPORTS).join(), /CLB/);
  assert.match(validate(plan({ wpts: [{ id: 'X', lat: 10, lon: 10, alt: null }] }), AIRPORTS).join(), /800 km/);
  assert.match(validate(plan({ origin: null }), AIRPORTS).join(), /konum/);   // no origin and no PPOS
});

// ---------------------------------------------------------------- guidance (local x/z metres, -z = north)
const local = (pts) => pts.map(([id, x, z, kind = 'wpt', alt = null]) => ({ id, x, z, kind, alt }));

test('ActiveRoute: track, cross-track sign and distance to destination', () => {
  // north 20 km, then east 20 km
  const r = new ActiveRoute({ points: local([['A', 0, 0, 'orig'], ['B', 0, -20000], ['C', 20000, -20000, 'thr']]), crzFt: 9000, clbKt: 250, desKt: 250, crzMach: 0.6, fafFt: 3000 });
  r.start({ x: 0, z: 0 });
  const s = r.update({ x: 500, z: -5000 }, 120, 0, 5000);   // 500 m right of a northbound leg
  assert.equal(s.legIndex, 0);
  near(s.xtkM, 500, 1e-6);
  assert.ok(s.desiredTrack > 270 && s.desiredTrack < 360, `steers left, got ${s.desiredTrack}`);
  near(s.distToDestM, 15000 + 20000, 1);
});

test('ActiveRoute: fly-by sequencing happens before the waypoint', () => {
  const r = new ActiveRoute({ points: local([['A', 0, 0, 'orig'], ['B', 0, -20000], ['C', 20000, -20000, 'thr']]), crzFt: 9000, clbKt: 250, desKt: 250, crzMach: 0.6, fafFt: 3000 });
  r.start({ x: 0, z: 0 });
  const lead = turnAnticipationNm(250, 90) * NM;
  let s = r.update({ x: 0, z: -20000 + lead + 200 }, 250 / 1.943844, 0, 5000);
  assert.equal(s.legIndex, 0); assert.equal(s.sequenced, null);
  s = r.update({ x: 0, z: -20000 + lead - 50 }, 250 / 1.943844, 0, 5000);
  assert.equal(s.legIndex, 1); assert.equal(s.sequenced, 'B');
  assert.equal(s.onFinal, true);   // last leg ends at the threshold
});

test('ActiveRoute.start picks the nearest leg; OFF ROUTE beyond 5 NM still steers toward active waypoint', () => {
  const r = new ActiveRoute({ points: local([['A', 0, 0, 'orig'], ['B', 0, -20000], ['C', 20000, -20000, 'thr']]), crzFt: 9000, clbKt: 250, desKt: 250, crzMach: 0.6, fafFt: 3000 });
  r.start({ x: 15000, z: -19000 });
  assert.equal(r.legIndex, 1);
  // 10 km south of leg B->C (course 090°): offRoute is true, desiredTrack must steer north (< 060° or > 300°) toward C!
  const s = r.update({ x: 10000, z: -20000 + 10000 }, 120);
  assert.equal(s.offRoute, true);
  assert.ok(s.desiredTrack < 60 || s.desiredTrack > 330, `expected intercept/direct-to north toward C, got ${s.desiredTrack}`);
});

test('pointAtDistFromDest walks back along the legs', () => {
  const r = new ActiveRoute({ points: local([['A', 0, 0, 'orig'], ['B', 0, -20000], ['C', 20000, -20000, 'thr']]), crzFt: 9000, clbKt: 250, desKt: 250, crzMach: 0.6, fafFt: 3000 });
  const p = r.pointAtDistFromDest(25000);
  near(p.x, 0, 1e-6); near(p.z, -15000, 1e-6);
});

// ---------------------------------------------------------------- VNAV
const cfg = { crzFt: 35000, clbKt: 290, desKt: 280, crzMach: 0.78, fafFt: 3200, constraints: [] };

test('VNAV climb: 250 kt below 10000 ft, then CLB speed; CRZ near cruise altitude', () => {
  let v = vnavTarget({ ...cfg, phase: 'CLB', altFt: 5000, distToDestNm: 300, onFinal: false });
  assert.equal(v.phase, 'CLB'); assert.equal(v.altFt, 35000); assert.equal(v.spdKt, 250);
  v = vnavTarget({ ...cfg, phase: 'CLB', altFt: 20000, distToDestNm: 300, onFinal: false });
  assert.equal(v.spdKt, 290);
  v = vnavTarget({ ...cfg, phase: 'CLB', altFt: 34850, distToDestNm: 300, onFinal: false });
  assert.equal(v.phase, 'CRZ'); near(v.spdKt, 250, 3);
});

test('VNAV climb respects an AT/AOB constraint ahead', () => {
  const v = vnavTarget({ ...cfg, constraints: [{ type: 'AOB', ft: 12000 }], phase: 'CLB', altFt: 8000, distToDestNm: 300, onFinal: false });
  assert.equal(v.altFt, 12000);
});

test('VNAV starts the descent at T/D and follows a 3° path to the FAF', () => {
  const tod = todDistanceNm(35000, 3200) + 10;
  let v = vnavTarget({ ...cfg, phase: 'CRZ', altFt: 35000, distToDestNm: tod + 2, onFinal: false });
  assert.equal(v.phase, 'CRZ');
  v = vnavTarget({ ...cfg, phase: 'CRZ', altFt: 35000, distToDestNm: tod - 0.1, onFinal: false });
  assert.equal(v.phase, 'DES');
  near(v.pathAltFt, 35000, 60);
  v = vnavTarget({ ...cfg, phase: 'DES', altFt: 9000, distToDestNm: 40, onFinal: false });
  assert.equal(v.spdKt, 250);
  near(v.pathAltFt, 3200 + 30 * NM * Math.tan(3 * Math.PI / 180) * 3.28084, 5);
  assert.equal(v.altFt, 3200);
});

test('VNAV never returns to CLB after the descent started; APP on the final leg', () => {
  let v = vnavTarget({ ...cfg, phase: 'DES', altFt: 20000, distToDestNm: 300, onFinal: false });
  assert.equal(v.phase, 'DES');
  v = vnavTarget({ ...cfg, phase: 'DES', altFt: 3300, distToDestNm: 9, onFinal: true, speedScale: 1 });
  assert.equal(v.phase, 'APP'); assert.equal(v.altFt, 3200); assert.equal(v.spdKt, 180);
});

test('VNAV descent honours an AOA constraint as a floor', () => {
  const v = vnavTarget({ ...cfg, constraints: [{ type: 'AOA', ft: 11000 }], phase: 'DES', altFt: 14000, distToDestNm: 40, onFinal: false });
  assert.equal(v.altFt, 11000);
  assert.ok(v.pathAltFt >= 11000);
});
