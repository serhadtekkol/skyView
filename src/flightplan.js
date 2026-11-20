// Pure flight-plan data model, geodesy, local-frame LNAV leg sequencing and VNAV profile.
// No DOM or three.js dependencies so it runs directly under node:test.

export const NM = 1852;
const EARTH_R_M = 6371000;
const EARTH_R_NM = EARTH_R_M / NM;
const D2R = Math.PI / 180;
const M2FT = 3.28084;
const MS2KT = 1.943844;
const G = 9.80665;
const TAN3 = Math.tan(3 * D2R);
const MAX_ROUTE_KM = 800;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const wrap180 = (d) => ((d % 360) + 540) % 360 - 180;

// ---------------------------------------------------------------- geodesy
export function gcDistanceNm(a, b) {
  const p1 = a.lat * D2R, p2 = b.lat * D2R;
  const dp = (b.lat - a.lat) * D2R, dl = (b.lon - a.lon) * D2R;
  const s = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(s), Math.sqrt(Math.max(0, 1 - s))) * EARTH_R_NM;
}

export function gcBearing(a, b) {
  const p1 = a.lat * D2R, p2 = b.lat * D2R, dl = (b.lon - a.lon) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / D2R + 360) % 360;
}

export function destPoint(p, brgDeg, distNm) {
  const d = distNm / EARTH_R_NM, b = brgDeg * D2R, p1 = p.lat * D2R, l1 = p.lon * D2R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / D2R, lon: ((l2 / D2R + 540) % 360) - 180 };
}

export function crossTrackNm(pos, a, b) {
  const d13 = gcDistanceNm(a, pos) / EARTH_R_NM;
  const t13 = gcBearing(a, pos) * D2R;
  const t12 = gcBearing(a, b) * D2R;
  return Math.asin(clamp(Math.sin(d13) * Math.sin(t13 - t12), -1, 1)) * EARTH_R_NM;
}

export function turnAnticipationNm(gsKt, courseChangeDeg) {
  const dc = Math.min(Math.abs(wrap180(courseChangeDeg)), 130);
  if (dc < 1 || gsKt < 10) return 0;
  const v = gsKt / MS2KT;
  const rNm = (v * v) / (G * Math.tan(25 * D2R)) / NM;
  return rNm * Math.tan((dc * D2R) / 2);
}

export function todDistanceNm(crzFt, fafFt) {
  if (crzFt <= fafFt) return 0;
  return ((crzFt - fafFt) / M2FT) / TAN3 / NM;
}

export function machToIas(mach, altFt) {
  const h = Math.max(0, altFt / M2FT);
  const rho = 1.225 * Math.pow(Math.max(0.2, 1 - 2.25577e-5 * h), 4.2559);
  const a = Math.sqrt(1.4 * 287.05 * Math.max(216.65, 288.15 - 0.0065 * h));
  return mach * a * Math.sqrt(rho / 1.225) * MS2KT;
}

// ---------------------------------------------------------------- parsing
export function parseAltConstraint(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) return null;
  const m = s.match(/^(AT|AOA|AOB|A|B)?\s*(FL)?\s*(\d{2,5})$/);
  if (!m) return undefined;
  let ft = Number(m[3]);
  if (m[2]) ft *= 100;
  if (!Number.isFinite(ft) || ft < 0 || ft > 41000) return undefined;
  const p = m[1] || 'AT';
  const type = p === 'A' ? 'AOA' : p === 'B' ? 'AOB' : p;
  return { type, ft };
}

export function parseWaypoint(raw, airports = []) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const ll = s.match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (ll) {
    const lat = Number(ll[1]), lon = Number(ll[2]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      return { id: null, lat, lon };
    }
    return null;
  }
  const code = s.toUpperCase();
  const a = airports.find(x => x.icao === code);
  return a ? { id: a.icao, lat: a.lat, lon: a.lon } : null;
}

export function runwayEnd(airport, rwIndex = 0, end = 'le') {
  const rw = airport?.rw?.[rwIndex];
  if (!rw) return null;
  const s = rw[end === 'he' ? 'he' : 'le'];
  const o = rw[end === 'he' ? 'le' : 'he'];
  if (!s || !o) return null;
  return {
    id: s.id,
    lat: s.lat,
    lon: s.lon,
    elevFt: s.elev ?? airport.elev ?? 0,
    heading: gcBearing(s, o),
  };
}

// ---------------------------------------------------------------- route building & validation
export function buildRoute(plan, airports, ppos = null) {
  const points = [];
  const origApt = plan.origin ? airports.find(a => a.icao === plan.origin.icao) : null;
  if (origApt) {
    const r = runwayEnd(origApt, plan.origin.rwIndex, plan.origin.end);
    if (r) points.push({ id: `${origApt.icao}/${r.id}`, lat: r.lat, lon: r.lon, kind: 'orig', alt: null });
  } else if (ppos) {
    points.push({ id: 'PPOS', lat: ppos.lat, lon: ppos.lon, kind: 'ppos', alt: null });
  }

  (plan.wpts || []).forEach((w, i) => {
    points.push({ id: w.id || `WP${i + 1}`, lat: w.lat, lon: w.lon, kind: 'wpt', alt: w.alt || null });
  });

  const destApt = plan.dest ? airports.find(a => a.icao === plan.dest.icao) : null;
  const destRunway = destApt ? runwayEnd(destApt, plan.dest.rwIndex, plan.dest.end) : null;
  let fafFt = 3000;
  if (destRunway) {
    const fafPt = destPoint(destRunway, (destRunway.heading + 180) % 360, 10);
    fafFt = destRunway.elevFt + Math.ceil(((10 * NM * TAN3) * M2FT) / 100) * 100;
    points.push({ id: `FAF${destRunway.id}`, lat: fafPt.lat, lon: fafPt.lon, kind: 'faf', alt: { type: 'AT', ft: fafFt } });
    points.push({ id: `${destApt.icao}/${destRunway.id}`, lat: destRunway.lat, lon: destRunway.lon, kind: 'thr', alt: { type: 'AT', ft: destRunway.elevFt } });
  }

  let totalNm = 0;
  for (let i = 1; i < points.length; i++) totalNm += gcDistanceNm(points[i - 1], points[i]);
  return {
    points,
    originAirport: origApt,
    destAirport: destApt,
    destRunway,
    fafFt,
    totalNm,
    crzFt: plan.crzFt ?? 35000,
    clbKt: plan.clbKt ?? 280,
    crzMach: plan.crzMach ?? 0.78,
    desKt: plan.desKt ?? 280,
  };
}

export function validate(plan, airports, ppos = null) {
  const errs = [];
  if (!plan?.dest?.icao) errs.push('Varış havalimanı seçilmeli.');
  else {
    const a = airports.find(x => x.icao === plan.dest.icao);
    if (!a) errs.push(`Varış havalimanı bulunamadı: ${plan.dest.icao}`);
    else if (!runwayEnd(a, plan.dest.rwIndex, plan.dest.end)) errs.push('Varış pisti geçersiz.');
  }
  if (plan?.origin?.icao) {
    const a = airports.find(x => x.icao === plan.origin.icao);
    if (!a || !runwayEnd(a, plan.origin.rwIndex, plan.origin.end)) errs.push('Kalkış havalimanı/pisti geçersiz.');
  } else if (!ppos) {
    errs.push('Kalkış noktası veya mevcut konum (PPOS) gerekli.');
  }
  if (!Number.isFinite(plan.crzFt) || plan.crzFt < 1000 || plan.crzFt > 41000) errs.push('CRZ ALT 1000–41000 ft arasında olmalı.');
  if (!Number.isFinite(plan.clbKt) || plan.clbKt < 120 || plan.clbKt > 340) errs.push('CLB hızı 120–340 kt arasında olmalı.');
  if (!Number.isFinite(plan.desKt) || plan.desKt < 120 || plan.desKt > 340) errs.push('DES hızı 120–340 kt arasında olmalı.');
  if (!Number.isFinite(plan.crzMach) || plan.crzMach < 0.35 || plan.crzMach > 0.84) errs.push('CRZ Mach 0.35–0.84 arasında olmalı.');
  for (const w of plan.wpts || []) {
    if (!Number.isFinite(w.lat) || !Number.isFinite(w.lon) || Math.abs(w.lat) > 90 || Math.abs(w.lon) > 180) {
      errs.push(`Geçersiz waypoint koordinatı: ${w.id || ''}`);
    }
  }
  if (errs.length === 0) {
    const r = buildRoute(plan, airports, ppos);
    if (r.totalNm * 1.852 > MAX_ROUTE_KM) errs.push(`Toplam rota ${MAX_ROUTE_KM} km sınırını aşıyor (${Math.round(r.totalNm * 1.852)} km).`);
  }
  return errs;
}

// ---------------------------------------------------------------- local-frame LNAV guidance
function legInfo(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.max(1, Math.hypot(dx, dz));
  return { ux: dx / len, uz: dz / len, len, crs: (Math.atan2(dx, -dz) / D2R + 360) % 360 };
}

export class ActiveRoute {
  constructor(route) {
    this.route = route;
    this.points = route.points;
    this.legIndex = 0;
    this.legs = [];
    for (let i = 0; i < this.points.length - 1; i++) this.legs.push(legInfo(this.points[i], this.points[i + 1]));
  }

  start(pos) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.legs.length; i++) {
      const a = this.points[i], l = this.legs[i];
      const rx = pos.x - a.x, rz = pos.z - a.z;
      const proj = clamp(rx * l.ux + rz * l.uz, 0, l.len);
      const d = Math.hypot(rx - l.ux * proj, rz - l.uz * proj);
      if (d < bestD) { bestD = d; best = i; }
    }
    this.legIndex = best;
    return best;
  }

  pointAtDistFromDest(distM) {
    if (!this.points.length) return null;
    let rem = Math.max(0, distM);
    for (let i = this.legs.length - 1; i >= 0; i--) {
      const l = this.legs[i], a = this.points[i], b = this.points[i + 1];
      if (rem <= l.len || i === 0) {
        const f = clamp(rem / l.len, 0, 1);
        return { x: b.x - (b.x - a.x) * f, z: b.z - (b.z - a.z) * f };
      }
      rem -= l.len;
    }
    return { x: this.points[0].x, z: this.points[0].z };
  }

  update(pos, gsMs = 120) {
    if (this.legs.length === 0) return null;
    let sequenced = null;
    const gsKt = gsMs * MS2KT;

    // check fly-by sequencing (only before the final FAF -> THR leg)
    if (this.legIndex < this.legs.length - 1) {
      const a = this.points[this.legIndex], b = this.points[this.legIndex + 1], l = this.legs[this.legIndex], nl = this.legs[this.legIndex + 1];
      const along = (pos.x - a.x) * l.ux + (pos.z - a.z) * l.uz;
      const remM = l.len - along;
      const directM = Math.hypot(b.x - pos.x, b.z - pos.z);
      const leadM = Math.min(l.len * 0.45, turnAnticipationNm(gsKt, wrap180(nl.crs - l.crs)) * NM);
      if ((along >= 0 && remM <= leadM) || directM <= Math.max(leadM, 600)) {
        this.legIndex++;
        sequenced = this.points[this.legIndex].id;
      }
    }

    const i = this.legIndex, a = this.points[i], b = this.points[i + 1], l = this.legs[i];
    const rx = pos.x - a.x, rz = pos.z - a.z;
    const along = rx * l.ux + rz * l.uz;
    const xtkM = rx * -l.uz + rz * l.ux;                 // right of track +
    const remM = Math.max(0, l.len - along);
    let tailM = 0;
    for (let k = i + 1; k < this.legs.length; k++) tailM += this.legs[k].len;

    const directM = Math.hypot(b.x - pos.x, b.z - pos.z);
    const brgToWpt = (Math.atan2(b.x - pos.x, -(b.z - pos.z)) / D2R + 360) % 360;
    const offRoute = Math.abs(xtkM) > 5 * NM;
    let desiredTrack;
    if (offRoute || along < -500 || remM < 1000) {
      desiredTrack = brgToWpt;
    } else {
      const corr = clamp(-xtkM * 0.02, -45, 45);
      desiredTrack = (l.crs + corr + 360) % 360;
    }
    const constraints = this.points.slice(i + 1).map(p => p.alt).filter(Boolean);

    return {
      legIndex: i,
      activeWpt: b,
      legCrs: l.crs,
      desiredTrack,
      xtkM,
      distToWptM: offRoute || along < 0 ? directM : remM,
      distToDestM: (offRoute || along < 0 ? directM : remM) + tailM,
      onFinal: i === this.legs.length - 1 || b.kind === 'thr',
      offRoute,
      sequenced,
      constraints,
    };
  }
}

// ---------------------------------------------------------------- VNAV profile
export function vnavTarget({ crzFt, clbKt, desKt, crzMach, fafFt, constraints = [], phase = 'CLB', altFt, distToDestNm, onFinal, speedScale = 1 }) {
  if (onFinal) {
    return { phase: 'APP', altFt: fafFt, pathAltFt: fafFt, spdKt: Math.round(180 * speedScale) };
  }
  const distToFafNm = Math.max(0, distToDestNm - 10);
  const todDistFromDest = 10 + todDistanceNm(crzFt, fafFt);

  if (phase === 'CLB') {
    if (altFt >= crzFt - 200) phase = 'CRZ';
  }
  if (phase === 'CRZ' && distToDestNm <= todDistFromDest) {
    phase = 'DES';
  }

  if (phase === 'CLB') {
    let cap = crzFt;
    for (const c of constraints) if ((c.type === 'AT' || c.type === 'AOB') && c.ft < cap) cap = c.ft;
    const spd = altFt < 10000 ? Math.min(clbKt, 250) : clbKt;
    return { phase: 'CLB', altFt: cap, pathAltFt: cap, spdKt: spd };
  }

  if (phase === 'CRZ') {
    return { phase: 'CRZ', altFt: crzFt, pathAltFt: crzFt, spdKt: Math.round(machToIas(crzMach, altFt)) };
  }

  // DES (never reverts to CLB)
  let pathAltFt = Math.min(crzFt, fafFt + distToFafNm * NM * TAN3 * M2FT);
  let floor = fafFt;
  for (const c of constraints) if ((c.type === 'AT' || c.type === 'AOA') && c.ft > floor) floor = c.ft;
  pathAltFt = Math.max(pathAltFt, floor);
  const spd = altFt < 10000 ? Math.min(desKt, 250) : desKt;
  return { phase: 'DES', altFt: floor, pathAltFt, spdKt: spd };
}
