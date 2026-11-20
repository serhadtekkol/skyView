// Flight Information Region lookup (VATSpy boundaries, simulation use only).
const D2R = Math.PI / 180;

function inRing(r, lon, lat) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export class FirLocator {
  constructor(data) {
    this.source = data.source;
    this.firs = data.firs;
    for (const f of this.firs) {
      f.area = (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]);
      f.mil = /military|militar|\bmil\b/i.test(f.name);
    }
    // civil before military, then smaller regions first so nested FIRs win over their surroundings
    this.firs.sort((a, b) => (a.mil - b.mil) || (a.area - b.area));
  }

  static async load(url = '/assets/firs.json') { return new FirLocator(await fetch(url).then(r => r.json())); }

  locate(lat, lon) {
    // Boundaries can overlap (e.g. Paris / Reims): among the containing FIRs prefer civil ones,
    // then the one whose own label point is nearest.
    let best = null, bestScore = Infinity;
    const cosl = Math.cos(lat * D2R);
    for (const f of this.firs) {
      const [x0, y0, x1, y1] = f.bbox;
      if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
      let inside = false;
      for (const r of f.rings) if (inRing(r, lon, lat)) inside = !inside;   // even-odd over all rings (holes)
      if (!inside) continue;
      const score = (f.mil ? 1e6 : 0) + (/XX$/.test(f.id) ? 1e5 : 0) + Math.hypot((f.label[0] - lon) * cosl, f.label[1] - lat);
      if (score < bestScore) { bestScore = score; best = f; }
    }
    return best;
  }

  /** Walks along a great-circle-ish track to the next FIR boundary (km), up to maxKm. */
  ahead(lat, lon, trackDeg, maxKm = 800) {
    const here = this.locate(lat, lon);
    const step = 4;
    let lo = 0;
    for (let d = step; d <= maxKm; d += step) {
      const p = this.offset(lat, lon, trackDeg, d);
      const f = this.locate(p.lat, p.lon);
      if (f !== here) {
        // refine the crossing to ~0.25 km
        let a = lo, b = d;
        for (let k = 0; k < 4; k++) { const m = (a + b) / 2, q = this.offset(lat, lon, trackDeg, m); if (this.locate(q.lat, q.lon) === here) a = m; else b = m; }
        return { next: f, km: b };
      }
      lo = d;
    }
    return null;
  }

  offset(lat, lon, brgDeg, km) {
    const R = 6371, d = km / R, b = brgDeg * D2R, p1 = lat * D2R, l1 = lon * D2R;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: p2 / D2R, lon: ((l2 / D2R + 540) % 360) - 180 };
  }
}

export const firLabel = (f) => (f ? `${f.id} · ${f.name.toLocaleUpperCase('en')}${f.oceanic ? ' OCEANIC' : ''} FIR` : 'FIR dışı');
