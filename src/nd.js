import { MS2KT } from './physics.js';

// Boeing-style Navigation Display (heading-up arc) with weather-radar returns.
// Returns are sampled from the cloud field along a ±50° fan, cached and refreshed by a sweep.

const W = 340, H = 320, CX = 170, CY = 290, R = 222;
const RANGES = [10, 20, 40, 80, 160];
const D2R = Math.PI / 180;
const FONT = '"Consolas","Menlo",monospace';
const COL = { green: '#14c214', yellow: '#f0d400', red: '#f01818', magenta: '#ff2ee6', white: '#f2f5f8', cyan: '#3fd6ff', dim: '#8fa3bf' };

function wxColor(v) {
  if (v < 0.1) return null;
  if (v < 0.45) return COL.green;
  if (v < 0.9) return COL.yellow;
  if (v < 1.5) return COL.red;
  return COL.magenta;
}

export class NavDisplay {
  constructor() {
    this.rangeIdx = 1; this.visible = true; this.tilt = 0;
    this.sweep = -50; this.dir = 1;
    this.cells = null;                      // [angleIdx][rangeIdx] -> reflectivity
    this.na = 51; this.nr = 44;             // 2° x (range/44)
  }
  get range() { return RANGES[this.rangeIdx]; }
  cycleRange() { this.rangeIdx = (this.rangeIdx + 1) % RANGES.length; this.cells = null; return this.range; }

  /** Re-samples the radar returns for the angles the sweep crossed this frame. */
  scan(dt, fm, clouds) {
    if (!clouds) return;
    const na = this.na, nr = this.nr;
    if (!this.cells) { this.cells = Array.from({ length: na }, () => new Float32Array(nr)); this.full = true; }
    const prev = this.sweep;
    this.sweep += this.dir * 70 * dt;                     // 70°/s sweep, back and forth
    if (this.sweep > 50) { this.sweep = 50; this.dir = -1; }
    if (this.sweep < -50) { this.sweep = -50; this.dir = 1; }
    const lo = Math.min(prev, this.sweep), hi = Math.max(prev, this.sweep);
    const hdg = fm.heading, rangeM = this.range * 1852, y = fm.pos.y;
    const t0 = Math.tan((this.tilt - 6) * D2R), t1 = Math.tan((this.tilt + 6) * D2R);
    for (let ai = 0; ai < na; ai++) {
      const a = -50 + ai * 2;
      if (!this.full && (a < lo - 1 || a > hi + 1)) continue;
      const brg = (hdg + a) * D2R, sx = Math.sin(brg), sz = -Math.cos(brg);
      const col = this.cells[ai];
      for (let ri = 0; ri < nr; ri++) {
        const d = (ri + 0.5) / nr * rangeM;
        col[ri] = clouds.wxAt(fm.pos.x + sx * d, fm.pos.z + sz * d, y + d * t0, y + d * t1);
      }
    }
    this.full = false;
    this.scanHdg = hdg;
  }

  draw(g, x, y, s, fm, clouds, ap, dt) {
    if (!this.visible) return;
    this.scan(dt, fm, clouds);
    g.save();
    g.translate(x, y); g.scale(s, s);
    // panel
    g.fillStyle = 'rgba(4,7,12,0.86)'; g.strokeStyle = 'rgba(140,170,210,0.25)'; g.lineWidth = 1;
    g.beginPath(); g.roundRect(0, 0, W, H, 10); g.fill(); g.stroke();

    const hdg = fm.heading;
    const scale = R / (this.range * 1852);
    const toScreen = (wx, wz) => {      // world point -> display (heading up)
      const e = wx - fm.pos.x, n = -(wz - fm.pos.z), h = hdg * D2R;
      const sx = e * Math.cos(h) - n * Math.sin(h), fw = e * Math.sin(h) + n * Math.cos(h);
      return [CX + sx * scale, CY - fw * scale];
    };

    // clip to the arc
    g.save();
    g.beginPath(); g.moveTo(CX, CY); g.arc(CX, CY, R, (-90 - 52) * D2R, (-90 + 52) * D2R); g.closePath(); g.clip();

    // ---- weather returns (cells drawn as annular sectors)
    if (this.cells) {
      const dh = ((hdg - (this.scanHdg ?? hdg) + 540) % 360) - 180;   // keep returns earth-fixed between scans
      for (let ai = 0; ai < this.na; ai++) {
        const a0 = (-50 + ai * 2 - 1 - dh - 90) * D2R, a1 = a0 + 2.1 * D2R;
        const col = this.cells[ai];
        for (let ri = 0; ri < this.nr; ri++) {
          const c = wxColor(col[ri]); if (!c) continue;
          const r0 = ri / this.nr * R, r1 = (ri + 1.05) / this.nr * R;
          g.fillStyle = c; g.globalAlpha = 0.82;
          g.beginPath(); g.arc(CX, CY, r1, a0, a1); g.arc(CX, CY, r0, a1, a0, true); g.closePath(); g.fill();
        }
      }
      g.globalAlpha = 1;
      // sweep line
      const sa = (this.sweep - 90) * D2R;
      const grd = g.createLinearGradient(CX, CY, CX + Math.cos(sa) * R, CY + Math.sin(sa) * R);
      grd.addColorStop(0, 'rgba(120,255,140,0)'); grd.addColorStop(1, 'rgba(120,255,140,0.35)');
      g.strokeStyle = grd; g.lineWidth = 2;
      g.beginPath(); g.moveTo(CX, CY); g.lineTo(CX + Math.cos(sa) * R, CY + Math.sin(sa) * R); g.stroke();
    }

    // ---- runway + extended centreline
    if (ap?.runway) {
      const r = ap.runway, dx = Math.sin(r.heading * D2R), dz = -Math.cos(r.heading * D2R);
      const [tx, ty] = toScreen(r.x, r.z);
      const [ex, ey] = toScreen(r.x + dx * 3000, r.z + dz * 3000);
      const [fx, fy] = toScreen(r.x - dx * 10 * 1852, r.z - dz * 10 * 1852);
      g.strokeStyle = COL.white; g.lineWidth = 4; g.beginPath(); g.moveTo(tx, ty); g.lineTo(ex, ey); g.stroke();
      g.strokeStyle = COL.cyan; g.lineWidth = 1.2; g.setLineDash([6, 6]); g.beginPath(); g.moveTo(tx, ty); g.lineTo(fx, fy); g.stroke(); g.setLineDash([]);
      g.fillStyle = COL.cyan; g.font = `11px ${FONT}`; g.textAlign = 'left'; g.fillText('RWY', tx + 6, ty - 6);
    }

    // range ring (half range)
    g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1; g.setLineDash([3, 5]);
    g.beginPath(); g.arc(CX, CY, R / 2, (-90 - 52) * D2R, (-90 + 52) * D2R); g.stroke(); g.setLineDash([]);
    // track line
    const gs = Math.hypot(fm.vel.x, fm.vel.z);
    if (gs > 10) {
      const trk = (Math.atan2(fm.vel.x, -fm.vel.z) / D2R + 360) % 360;
      const ta = (((trk - hdg + 540) % 360) - 180 - 90) * D2R;
      g.strokeStyle = COL.white; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(CX, CY); g.lineTo(CX + Math.cos(ta) * R, CY + Math.sin(ta) * R); g.stroke();
    }
    g.restore();

    // ---- compass arc
    g.strokeStyle = COL.white; g.fillStyle = COL.white; g.lineWidth = 1.5;
    g.beginPath(); g.arc(CX, CY, R, (-90 - 52) * D2R, (-90 + 52) * D2R); g.stroke();
    g.font = `12px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let d = Math.ceil((hdg - 52) / 5) * 5; d <= hdg + 52; d += 5) {
      const a = (d - hdg - 90) * D2R, major = d % 10 === 0;
      const r1 = R, r2 = R - (major ? 10 : 6);
      g.beginPath(); g.moveTo(CX + Math.cos(a) * r1, CY + Math.sin(a) * r1); g.lineTo(CX + Math.cos(a) * r2, CY + Math.sin(a) * r2); g.stroke();
      const dd = ((d % 360) + 360) % 360;
      if (dd % 30 === 0) g.fillText(String(dd / 10), CX + Math.cos(a) * (R - 22), CY + Math.sin(a) * (R - 22));
    }
    // heading bug (MCP)
    if (ap) {
      const rel = ((ap.sel.hdg - hdg + 540) % 360) - 180;
      if (Math.abs(rel) < 52) {
        const a = (rel - 90) * D2R;
        g.save(); g.translate(CX + Math.cos(a) * R, CY + Math.sin(a) * R); g.rotate(a + Math.PI / 2);
        g.strokeStyle = COL.magenta; g.lineWidth = 2.5;
        g.beginPath(); g.moveTo(-8, 0); g.lineTo(-8, -9); g.lineTo(-3, -9); g.lineTo(0, -4); g.lineTo(3, -9); g.lineTo(8, -9); g.lineTo(8, 0); g.stroke();
        g.restore();
      }
    }
    // heading box
    g.fillStyle = '#000'; g.strokeStyle = COL.white; g.lineWidth = 1.5;
    g.beginPath(); g.rect(CX - 26, CY - R - 34, 52, 22); g.fill(); g.stroke();
    g.fillStyle = COL.white; g.font = `bold 15px ${FONT}`;
    g.fillText(Math.round(hdg).toString().padStart(3, '0'), CX, CY - R - 23);
    g.beginPath(); g.moveTo(CX, CY - R); g.lineTo(CX - 5, CY - R - 10); g.lineTo(CX + 5, CY - R - 10); g.closePath(); g.fill();

    // aircraft symbol
    g.strokeStyle = COL.white; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(CX, CY - 14); g.lineTo(CX, CY + 10); g.moveTo(CX - 10, CY - 2); g.lineTo(CX + 10, CY - 2); g.moveTo(CX - 5, CY + 8); g.lineTo(CX + 5, CY + 8); g.stroke();

    // texts
    g.textBaseline = 'alphabetic'; g.textAlign = 'left'; g.font = `12px ${FONT}`;
    g.fillStyle = COL.white;
    g.fillText(`GS ${(gs * MS2KT).toFixed(0)}  TAS ${(fm.tas * MS2KT).toFixed(0)}`, 10, 20);
    if (fm.windKts) {
      g.fillText(`${String(fm.windFrom).padStart(3, '0')}°/${fm.windKts}`, 10, 36);
      const wa = (fm.windFrom + 180 - hdg - 90) * D2R;   // arrow points where the wind blows
      g.save(); g.translate(22, 56); g.rotate(wa + Math.PI / 2);
      g.strokeStyle = COL.white; g.lineWidth = 2; g.beginPath(); g.moveTo(0, 9); g.lineTo(0, -9); g.lineTo(-4, -4); g.moveTo(0, -9); g.lineTo(4, -4); g.stroke();
      g.restore();
    }
    g.textAlign = 'right';
    g.fillStyle = COL.cyan; g.fillText(`WXR  ${this.tilt >= 0 ? '+' : ''}${this.tilt.toFixed(1)}°`, W - 10, 20);
    g.fillStyle = COL.white; g.fillText(`${this.range} NM`, W - 10, 36);
    g.fillStyle = COL.dim; g.font = `10px ${FONT}`;
    g.fillText(`${this.range / 2}`, CX + R / 2 * Math.cos(-38 * D2R) + 22, CY - R / 2 * Math.sin(52 * D2R) + 4);
    // legend
    const lg = [['HAFİF', COL.green], ['ORTA', COL.yellow], ['ŞİDDETLİ', COL.red], ['TÜRB', COL.magenta]];
    g.textAlign = 'left'; g.font = `9px ${FONT}`;
    lg.forEach(([t, c], i) => { g.fillStyle = c; g.fillRect(10 + i * 80, H - 14, 9, 9); g.fillStyle = COL.dim; g.fillText(t, 22 + i * 80, H - 6); });
    g.restore();
  }
}
