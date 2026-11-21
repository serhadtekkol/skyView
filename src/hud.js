import { MS2KT, M2FT, FLAP_DETENTS } from './physics.js';
import { CAMERA_MODES } from './camera.js';
import { groundHeight } from './world.js';
import { computeWarnings } from './warnings.js';

// Glass-cockpit style overlay drawn on a 2D canvas: PFD (attitude, speed/alt tapes, VSI, heading),
// engine/systems panel, warnings and messages.

const C = {
  sky: '#1f6fbf', sky2: '#2d8ae0', gnd: '#7a4a22', gnd2: '#5e3818', white: '#f2f5f8', dim: '#9aa8b8',
  green: '#3cf07a', magenta: '#ff4fd8', amber: '#ffb020', red: '#ff3b30', cyan: '#3fd6ff', panel: 'rgba(6,10,16,0.78)',
};
const FONT = '"Consolas","Menlo",monospace';

export class HUD {
  constructor(canvas) {
    this.cv = canvas; this.g = canvas.getContext('2d');
    this.msgs = []; this.showHelp = false; this.fps = 60; this.visible = true;
    this.resize();
  }
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr; this.w = window.innerWidth; this.h = window.innerHeight;
    this.cv.width = this.w * dpr; this.cv.height = this.h * dpr;
    this.cv.style.width = this.w + 'px'; this.cv.style.height = this.h + 'px';
  }
  message(text, color = 'white', dur = 2.5) {
    this.msgs = this.msgs.filter(m => m.text !== text);
    this.msgs.push({ text, color: C[color] || color, t: dur });
    if (this.msgs.length > 4) this.msgs.shift();
  }

  draw(dt, fm, rig) {
    const g = this.g;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    // Volumetric in-cloud mist overlay (drawn behind HUD instruments so sky/sun genuinely white-out inside clouds)
    const rawCloud = this.cloudDensity || 0;
    this._cloudVeil = (this._cloudVeil || 0) + (rawCloud - (this._cloudVeil || 0)) * Math.min(1, dt * 4.5);
    if (this._cloudVeil > 0.01) {
      const v = Math.min(1, this._cloudVeil);
      const day = this.envDay ?? 1;
      const r = Math.round(28 + 204 * day), gr = Math.round(36 + 202 * day), b = Math.round(52 + 190 * day);
      const grad = g.createRadialGradient(this.w / 2, this.h / 2, this.h * 0.08, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.72);
      grad.addColorStop(0, `rgba(${r},${gr},${b},${(v * 0.62).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${r},${gr},${b},${(v * 0.88).toFixed(3)})`);
      g.fillStyle = grad;
      g.fillRect(0, 0, this.w, this.h);
    }
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;
    if (!this.visible) { this.layout?.syncHandles(false); return; }
    const compact = this.w < 1180;
    const baseS = compact ? Math.min(0.86, Math.max(0.58, this.w / 1380)) : Math.min(1.12, Math.max(0.82, this.h / 950));
    const L = this.layout;
    const sc = (id) => (L ? L.scaleOf(id, baseS) : baseS);
    const at = (id, dx, dy, w, h, tip, res = true) => (L ? L.place(id, dx, dy, w, h, tip, res) : [dx, dy]);
    const sPfd = sc('pfd'), sEicas = sc('eicas'), sNd = sc('nd');
    let [px, py] = at('pfd', 16, this.h - 16 - 300 * sPfd, 470 * sPfd, 300 * sPfd, 'PFD · Ana uçuş göstergesi|Sürükle: taşı · sağ alt köşe: boyutlandır · çift tık: sıfırla');
    g.save();
    g.translate(px, py); g.scale(sPfd, sPfd);
    this.pfd(g, fm);
    g.restore();
    [px, py] = at('eicas', this.w - 16 - 330 * sEicas, this.h - 16 - 300 * sEicas, 330 * sEicas, 300 * sEicas, 'EICAS · Motor ve sistemler|Sürükle: taşı · sağ alt köşe: boyutlandır · çift tık: sıfırla');
    g.save();
    g.translate(px, py); g.scale(sEicas, sEicas);
    this.eicas(g, fm);
    g.restore();
    // navigation / weather-radar display: between PFD and EICAS if there is room, else above the EICAS
    if (this.nd && this.nd.visible) {
      const left = 16 + 470 * sPfd, right = this.w - 16 - 330 * sEicas, ndW = 340 * sNd;
      let nx, ny;
      if (right - left >= ndW + 20) { nx = (left + right - ndW) / 2; ny = this.h - 16 - 320 * sNd; }
      else { nx = this.w - 16 - ndW; ny = this.h - 16 - 300 * sEicas - 12 - 320 * sNd; }
      [nx, ny] = at('nd', nx, ny, ndW, 320 * sNd, 'ND · Navigasyon ve hava radarı|Sürükle: taşı · sağ alt köşe: boyutlandır · çift tık: sıfırla · [0] aç/kapa');
      this.nd.draw(g, nx, ny, sNd, fm, this.clouds, this.ap, dt);
      this.ndRect = { x: nx, y: ny, w: ndW, h: 320 * sNd };
    }
    // info strip (camera/FPS + FIR + FIR card) as one movable block
    const [ix, iy] = at('info', 12, 12, 380, 18, 'Bilgi şeridi · Kamera, FIR|Sürükle: taşı · çift tık: varsayılan yer', false);
    g.save(); g.translate(ix - 12, iy - 12);
    this.topBar(g, fm, rig);
    g.restore();
    // top-right environment + outside air temperature (OAT) pill
    this.envStrip(g, fm);
    if (this.attribution) {
      g.font = '11px "Segoe UI", sans-serif'; g.textAlign = 'center'; g.fillStyle = 'rgba(255,255,255,0.6)';
      g.fillText(this.attribution, this.w / 2, this.h - 6);
    }
    this.warnings(g, fm, dt);
    if (this.showHelp) this.help(g);
    if (fm.crashed) this.crash(g, fm);
    this.layout?.syncHandles(true);
  }

  panel(g, x, y, w, h) {
    g.fillStyle = C.panel; g.strokeStyle = 'rgba(140,170,210,0.25)'; g.lineWidth = 1;
    g.beginPath(); g.roundRect(x, y, w, h, 10); g.fill(); g.stroke();
  }

  pfd(g, fm) {
    const W = 470, H = 300;
    this.panel(g, 0, 0, W, H);
    const e = fm.euler;
    const pitch = e.x * 180 / Math.PI, roll = e.z * 180 / Math.PI;   // roll + = left wing down
    const cx = 235, cy = 140, R = 112;
    // ---- attitude
    g.save();
    g.beginPath(); g.roundRect(cx - R, cy - R, 2 * R, 2 * R, 14); g.clip();
    g.translate(cx, cy); g.rotate(roll * Math.PI / 180);
    const ppd = 4.2; // px per degree
    const off = pitch * ppd;
    let grd = g.createLinearGradient(0, -300 + off, 0, off);
    grd.addColorStop(0, C.sky); grd.addColorStop(1, C.sky2);
    g.fillStyle = grd; g.fillRect(-400, -600 + off, 800, 600);
    grd = g.createLinearGradient(0, off, 0, off + 300);
    grd.addColorStop(0, C.gnd); grd.addColorStop(1, C.gnd2);
    g.fillStyle = grd; g.fillRect(-400, off, 800, 600);
    g.strokeStyle = C.white; g.lineWidth = 2; g.beginPath(); g.moveTo(-400, off); g.lineTo(400, off); g.stroke();
    g.font = `12px ${FONT}`; g.fillStyle = C.white; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let p = -30; p <= 30; p += 2.5) {
      if (p === 0) continue;
      const y = off - p * ppd;
      if (Math.abs(y) > R + 20) continue;
      const major = p % 10 === 0, mid = p % 5 === 0;
      const hw = major ? 42 : mid ? 26 : 12;
      g.lineWidth = 1.6; g.beginPath(); g.moveTo(-hw, y); g.lineTo(hw, y); g.stroke();
      if (mid) { g.textAlign = 'right'; g.fillText(Math.abs(p), -hw - 4, y); g.textAlign = 'left'; g.fillText(Math.abs(p), hw + 4, y); }
    }
    // flight path vector
    if (fm.tas > 20) {
      const v = fm.vel; const gamma = Math.atan2(v.y, Math.hypot(v.x, v.z)) * 180 / Math.PI;
      const hd = fm.heading, trk = (Math.atan2(v.x, -v.z) * 180 / Math.PI + 360) % 360;
      let dtrk = ((trk - hd + 540) % 360) - 180;
      const fy = off - gamma * ppd, fx = dtrk * ppd;
      g.strokeStyle = C.green; g.lineWidth = 2;
      g.beginPath(); g.arc(fx, fy, 7, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(fx - 18, fy); g.lineTo(fx - 7, fy); g.moveTo(fx + 7, fy); g.lineTo(fx + 18, fy); g.moveTo(fx, fy - 7); g.lineTo(fx, fy - 14); g.stroke();
    }
    g.restore();
    // roll scale
    g.save(); g.translate(cx, cy);
    g.strokeStyle = C.white; g.fillStyle = C.white; g.lineWidth = 2;
    g.beginPath(); g.arc(0, 0, R - 8, (-90 - 60) * Math.PI / 180, (-90 + 60) * Math.PI / 180); g.stroke();
    for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
      const r1 = R - 8, r2 = R - (Math.abs(a) % 30 === 0 ? 20 : 15), ang = (a - 90) * Math.PI / 180;
      g.beginPath(); g.moveTo(Math.cos(ang) * r1, Math.sin(ang) * r1); g.lineTo(Math.cos(ang) * r2, Math.sin(ang) * r2); g.stroke();
    }
    g.beginPath(); g.moveTo(0, -R + 8); g.lineTo(-7, -R - 2); g.lineTo(7, -R - 2); g.closePath(); g.fill();
    g.rotate(roll * Math.PI / 180);
    g.fillStyle = Math.abs(roll) > 35 ? C.amber : C.white;
    g.beginPath(); g.moveTo(0, -R + 10); g.lineTo(-8, -R + 22); g.lineTo(8, -R + 22); g.closePath(); g.fill();
    g.restore();
    // aircraft symbol
    g.save(); g.translate(cx, cy);
    g.fillStyle = '#000'; g.strokeStyle = C.amber; g.lineWidth = 3;
    const wing = (sx) => { g.beginPath(); g.moveTo(sx * 18, 0); g.lineTo(sx * 62, 0); g.lineTo(sx * 62, 7); g.lineTo(sx * 24, 7); g.lineTo(sx * 24, 18); g.lineTo(sx * 18, 18); g.closePath(); g.fill(); g.stroke(); };
    wing(-1); wing(1);
    g.fillRect(-4, -4, 8, 8); g.strokeRect(-4, -4, 8, 8);
    g.restore();

    // ---- speed tape
    const ias = fm.ias * MS2KT;
    this.tape(g, 12, 28, 66, 224, ias, 10, 4.2, (v) => v.toFixed(0), true, fm);
    // ---- altitude tape
    const altFt = fm.pos.y * M2FT;
    this.tape(g, 362, 28, 74, 224, altFt, 100, 0.35, (v) => v.toFixed(0), false, fm);
    // ---- VSI
    const vs = fm.vel.y * 60 * M2FT;
    g.save(); g.translate(444, 28);
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, 0, 20, 224);
    g.strokeStyle = C.white; g.lineWidth = 1;
    const vsY = (v) => 112 - Math.sign(v) * Math.min(1, Math.sqrt(Math.abs(v) / 6000)) * 104;
    for (const v of [-6000, -2000, -1000, -500, 0, 500, 1000, 2000, 6000]) { const y = vsY(v); g.beginPath(); g.moveTo(0, y); g.lineTo(v === 0 ? 14 : 7, y); g.stroke(); }
    g.strokeStyle = Math.abs(vs) > 4000 ? C.amber : C.green; g.lineWidth = 3;
    g.beginPath(); g.moveTo(2, 112); g.lineTo(18, vsY(vs)); g.stroke();
    g.restore();
    g.font = `bold 13px ${FONT}`; g.textAlign = 'right'; g.fillStyle = C.green;
    if (Math.abs(vs) > 50) g.fillText((vs > 0 ? '+' : '') + (Math.round(vs / 50) * 50).toFixed(0), 466, vs > 0 ? 20 : 266);

    // ---- heading
    const hdg = fm.heading;
    g.save(); g.beginPath(); g.rect(120, 262, 230, 30); g.clip();
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(120, 262, 230, 30);
    g.strokeStyle = C.white; g.fillStyle = C.white; g.font = `12px ${FONT}`; g.textAlign = 'center'; g.lineWidth = 1.5;
    for (let d = Math.floor(hdg / 5) * 5 - 30; d <= hdg + 30; d += 5) {
      const x = 235 + (d - hdg) * 4;
      const dd = (d + 360) % 360;
      g.beginPath(); g.moveTo(x, 262); g.lineTo(x, dd % 10 === 0 ? 272 : 268); g.stroke();
      if (dd % 10 === 0) g.fillText(dd === 0 ? 'N' : dd === 90 ? 'E' : dd === 180 ? 'S' : dd === 270 ? 'W' : String(dd / 10).padStart(2, '0'), x, 284);
    }
    g.restore();
    g.fillStyle = C.white; g.beginPath(); g.moveTo(235, 262); g.lineTo(229, 254); g.lineTo(241, 254); g.closePath(); g.fill();
    if (this.ap) {
      const d = ((this.ap.sel.hdg - hdg) % 360 + 540) % 360 - 180;
      const bx = Math.min(Math.max(235 + d * 4, 124), 346);
      g.fillStyle = C.magenta; g.fillRect(bx - 7, 262, 4, 8); g.fillRect(bx + 3, 262, 4, 8); g.fillRect(bx - 7, 262, 14, 3);
    }
    // ---- flight mode annunciator (above the PFD)
    if (this.ap) {
      const f = this.ap.fma;
      const cells = [[f.at, ''], [f.lat, f.latArm], [f.vert, f.vertArm]];
      g.fillStyle = 'rgba(6,10,16,0.82)'; g.beginPath(); g.roundRect(0, -40, 470, 34, 8); g.fill();
      g.textAlign = 'center';
      cells.forEach(([act, arm], i) => {
        const cx = 70 + i * 140;
        g.font = `bold 14px ${FONT}`; g.fillStyle = C.green; g.fillText(act || '', cx, -22);
        g.font = `11px ${FONT}`; g.fillStyle = C.white; g.fillText(arm || '', cx, -10);
        if (i < 2) { g.strokeStyle = 'rgba(255,255,255,0.25)'; g.beginPath(); g.moveTo(cx + 70, -36); g.lineTo(cx + 70, -10); g.stroke(); }
      });
      g.font = `bold 14px ${FONT}`; g.fillStyle = f.ap ? C.green : C.dim; g.fillText(f.ap || 'MAN', 445, -22);
    }
    g.font = `bold 14px ${FONT}`; g.textAlign = 'center'; g.fillStyle = C.green;
    g.fillText(hdg.toFixed(0).padStart(3, '0') + '°', 235, 248 - 2);

    // ---- radio altitude
    const ra = fm.agl * M2FT;
    if (ra < 2500) {
      g.font = `bold 16px ${FONT}`; g.textAlign = 'center';
      g.fillStyle = ra < 500 ? C.amber : C.white;
      g.fillText(Math.max(0, Math.round(ra / (ra > 100 ? 10 : 1)) * (ra > 100 ? 10 : 1)).toFixed(0), cx, cy + R - 14);
    }
    // ---- FMA strip
    g.font = `11px ${FONT}`; g.textAlign = 'left'; g.fillStyle = C.green;
    g.fillText(`M ${fm.mach.toFixed(3)}`, 14, 18);
    g.fillStyle = fm.ctl.autoTrim ? C.green : C.dim; g.fillText(fm.ctl.autoTrim ? 'AUTO-TRIM' : 'MAN TRIM', 150, 18);
    g.fillStyle = C.white; g.fillText(`GS ${(Math.hypot(fm.vel.x, fm.vel.z) * MS2KT).toFixed(0)}`, 250, 18);
    g.fillStyle = C.cyan; g.fillText(`TAS ${(fm.tas * MS2KT).toFixed(0)}`, 315, 18);
    g.fillStyle = C.white; g.fillText(`${(fm.nz || 0).toFixed(2)}G`, 410, 18);
  }

  tape(g, x, y, w, h, value, step, pxPer, fmt, left, fm) {
    const mid = y + h / 2;
    g.save();
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    g.fillStyle = 'rgba(0,0,0,0.38)'; g.fillRect(x, y, w, h);
    const pxStep = step * pxPer;
    const first = Math.floor((value - h / 2 / pxPer) / step) * step;
    g.strokeStyle = C.white; g.fillStyle = C.white; g.font = `13px ${FONT}`; g.lineWidth = 1.5;
    g.textBaseline = 'middle';
    // speed bands
    if (left) {
      const flapN = fm.flapPos / 40;
      const vs = (fm.ctl.flapIndex === 0 ? 150 : 150 - 32 * Math.pow(flapN, 0.45) - 10) * (fm.speedScale || 1);
      const vmo = 340, vfe = [340, 250, 250, 250, 210, 200, 190, 175, 162][fm.ctl.flapIndex];
      const yv = (v) => mid - (v - value) * pxPer;
      g.fillStyle = C.red;
      for (let yy = yv(vs); yy < y + h; yy += 8) g.fillRect(x + w - 7, yy, 7, 4);
      g.fillStyle = C.amber; g.fillRect(x + w - 4, yv(vs * 1.3), 4, yv(vs) - yv(vs * 1.3));
      g.fillStyle = C.red;
      for (let yy = yv(Math.min(vmo, vfe)); yy > y; yy -= 8) g.fillRect(x + w - 7, yy - 4, 7, 4);
    }
    g.fillStyle = C.white;
    for (let v = first; v <= value + h / 2 / pxPer + step; v += step) {
      const yy = mid - (v - value) * pxPer;
      if (left && v < 0) continue;
      const major = left ? v % 20 === 0 : v % 500 === 0;
      if (left) { g.beginPath(); g.moveTo(x + w - 14, yy); g.lineTo(x + w - 2, yy); g.stroke(); if (major) { g.textAlign = 'right'; g.fillText(fmt(v), x + w - 18, yy); } }
      else { g.beginPath(); g.moveTo(x, yy); g.lineTo(x + (major ? 14 : 8), yy); g.stroke(); if (major) { g.textAlign = 'left'; g.fillText(fmt(v), x + 18, yy); } }
    }
    // ground on alt tape
    if (!left) {
      const gy = mid - (groundHeight(fm.pos.x, fm.pos.z) * M2FT - value) * pxPer;
      if (gy < y + h) { g.fillStyle = 'rgba(255,176,32,0.35)'; g.fillRect(x, gy, w, y + h - gy); }
    }
    // trend vector (speed)
    if (left && this.lastIas !== undefined) {
      this.trend = (this.trend || 0) * 0.9 + ((value - this.lastIas) / Math.max(this.lastDt || 0.016, 0.001)) * 0.1;
      const ty = mid - this.trend * 10 * pxPer;
      g.strokeStyle = C.green; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x + w - 2, mid); g.lineTo(x + w - 2, ty); g.stroke();
    }
    if (left) { this.lastIas = value; }
    // MCP bug (selected speed / altitude)
    if (this.ap) {
      const bug = left ? this.ap.sel.spd : this.ap.sel.alt;
      const by = Math.min(Math.max(mid - (bug - value) * pxPer, y + 6), y + h - 6);
      g.fillStyle = C.magenta; g.strokeStyle = '#000'; g.lineWidth = 1;
      g.beginPath();
      if (left) { g.moveTo(x + w, by - 7); g.lineTo(x + w - 9, by - 7); g.lineTo(x + w - 9, by - 3); g.lineTo(x + w - 4, by); g.lineTo(x + w - 9, by + 3); g.lineTo(x + w - 9, by + 7); g.lineTo(x + w, by + 7); }
      else { g.moveTo(x, by - 8); g.lineTo(x + 10, by - 8); g.lineTo(x + 10, by - 3); g.lineTo(x + 5, by); g.lineTo(x + 10, by + 3); g.lineTo(x + 10, by + 8); g.lineTo(x, by + 8); }
      g.closePath(); g.fill(); g.stroke();
    }
    g.restore();
    // readout box
    g.fillStyle = '#000'; g.strokeStyle = C.white; g.lineWidth = 1.5;
    const bw = left ? w - 4 : w + 4, bx = left ? x : x - 2;
    g.beginPath();
    if (left) { g.moveTo(bx, mid - 15); g.lineTo(bx + bw, mid - 15); g.lineTo(bx + bw, mid - 6); g.lineTo(bx + bw + 7, mid); g.lineTo(bx + bw, mid + 6); g.lineTo(bx + bw, mid + 15); g.lineTo(bx, mid + 15); }
    else { g.moveTo(bx, mid - 15); g.lineTo(bx + bw, mid - 15); g.lineTo(bx + bw, mid + 15); g.lineTo(bx, mid + 15); g.lineTo(bx, mid + 6); g.lineTo(bx - 7, mid); g.lineTo(bx, mid - 6); }
    g.closePath(); g.fill(); g.stroke();
    g.fillStyle = C.white; g.font = `bold 17px ${FONT}`; g.textBaseline = 'middle';
    g.textAlign = 'center';
    g.fillText(left ? Math.max(0, value).toFixed(0) : (Math.round(value / 10) * 10).toFixed(0), bx + bw / 2, mid + 1);
    g.textBaseline = 'alphabetic';
  }

  eicas(g, fm) {
    const W = 330, H = 300;
    this.panel(g, 0, 0, W, H);
    const ctl = fm.ctl;
    // N1 dials
    const nE = fm.n1.length, sc = nE > 2 ? 0.6 : 1;
    g.save(); g.scale(sc, sc);
    for (let i = 0; i < nE; i++) {
      const cx = (nE > 2 ? 40 + i * 64 : 72 + i * 110) / sc, cy = (nE > 2 ? 62 : 72) / sc, r = 44;
      const n1 = fm.n1[i];
      const a0 = Math.PI * 0.75, span = Math.PI * 1.25;
      g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 6;
      g.beginPath(); g.arc(cx, cy, r, a0, a0 + span); g.stroke();
      g.strokeStyle = n1 > 101 ? C.red : C.white; g.lineWidth = 6;
      g.beginPath(); g.arc(cx, cy, r, a0, a0 + span * Math.min(n1, 110) / 110); g.stroke();
      // commanded (throttle) bug
      const tgt = 20.5 + 77.5 * ctl.throttle * (fm.reverserPos > 0.9 ? 0.75 : 1);
      const ta = a0 + span * tgt / 110;
      g.strokeStyle = C.magenta; g.lineWidth = 3;
      g.beginPath(); g.moveTo(cx + Math.cos(ta) * (r - 9), cy + Math.sin(ta) * (r - 9)); g.lineTo(cx + Math.cos(ta) * (r + 6), cy + Math.sin(ta) * (r + 6)); g.stroke();
      g.strokeStyle = C.red; g.lineWidth = 2; const ra = a0 + span * 102 / 110;
      g.beginPath(); g.moveTo(cx + Math.cos(ra) * (r - 6), cy + Math.sin(ra) * (r - 6)); g.lineTo(cx + Math.cos(ra) * (r + 6), cy + Math.sin(ra) * (r + 6)); g.stroke();
      g.fillStyle = '#000'; g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 1;
      g.fillRect(cx - 4, cy - 2, 52, 22); g.strokeRect(cx - 4, cy - 2, 52, 22);
      g.fillStyle = C.white; g.font = `bold 15px ${FONT}`; g.textAlign = 'right';
      g.fillText(n1.toFixed(1), cx + 44, cy + 15);
      if (fm.reverserPos > 0.05) { g.fillStyle = fm.reverserPos > 0.9 ? C.green : C.amber; g.font = `bold 12px ${FONT}`; g.textAlign = 'center'; g.fillText('REV', cx, cy - 14); }
    }
    g.restore();
    g.fillStyle = C.dim; g.font = `12px ${FONT}`; g.textAlign = 'center'; g.fillText('N1 %', 127, 130);

    // throttle column
    g.fillStyle = 'rgba(255,255,255,0.1)'; g.fillRect(290, 20, 18, 110);
    g.fillStyle = C.cyan; g.fillRect(290, 130 - 110 * ctl.throttle, 18, 110 * ctl.throttle);
    g.fillStyle = C.dim; g.font = `10px ${FONT}`; g.fillText('THR', 299, 144);

    // gear
    const gy = 168;
    g.font = `bold 12px ${FONT}`;
    const gearBox = (x, y, lbl) => {
      const down = fm.gearPos > 0.99, up = fm.gearPos < 0.01;
      g.strokeStyle = down ? C.green : up ? 'rgba(255,255,255,0.25)' : C.amber; g.lineWidth = 2;
      g.fillStyle = down ? 'rgba(60,240,122,0.18)' : up ? 'transparent' : 'rgba(255,176,32,0.2)';
      g.beginPath(); g.roundRect(x, y, 46, 24, 4); g.fill(); g.stroke();
      g.fillStyle = down ? C.green : up ? C.dim : C.amber; g.textAlign = 'center';
      g.fillText(down ? 'DOWN' : up ? 'UP' : 'TRAN', x + 23, y + 16);
      g.fillStyle = C.dim; g.font = `9px ${FONT}`; g.fillText(lbl, x + 23, y - 3); g.font = `bold 12px ${FONT}`;
    };
    gearBox(70, gy - 10, 'NOSE'); gearBox(20, gy + 28, 'LEFT'); gearBox(120, gy + 28, 'RIGHT');
    // flaps
    const fx = 190, fy = 160;
    g.fillStyle = C.dim; g.font = `11px ${FONT}`; g.textAlign = 'left'; g.fillText('FLAPS', fx, fy);
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(fx, fy + 6, 12, 80);
    g.fillStyle = Math.abs(fm.flapPos - FLAP_DETENTS[ctl.flapIndex]) > 0.3 ? C.amber : C.green;
    g.fillRect(fx, fy + 6, 12, 80 * fm.flapPos / 40);
    g.fillStyle = C.magenta; g.fillRect(fx - 4, fy + 6 + 80 * FLAP_DETENTS[ctl.flapIndex] / 40 - 1, 20, 3);
    g.fillStyle = C.white; g.font = `bold 20px ${FONT}`; g.fillText(String(FLAP_DETENTS[ctl.flapIndex]), fx + 22, fy + 30);
    g.font = `11px ${FONT}`; g.fillStyle = fm.slatPos > 0.95 ? C.green : fm.slatPos > 0.05 ? C.amber : C.dim;
    g.fillText(fm.slatPos > 0.95 ? 'LE EXT' : fm.slatPos > 0.05 ? 'LE TRAN' : 'LE UP', fx + 22, fy + 50);
    // trim
    g.fillStyle = C.dim; g.fillText('STAB TRIM', 254, fy);
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(278, fy + 6, 10, 80);
    g.fillStyle = C.green; g.fillRect(274, fy + 46 - ctl.trim * 40 - 2, 18, 4);
    g.fillStyle = C.dim; g.font = `9px ${FONT}`; g.fillText('UP', 296, fy + 12); g.fillText('DN', 296, fy + 86);

    // status annunciators
    const ann = [];
    if (ctl.parkingBrake) ann.push(['PARK BRK', C.amber]);
    else if (ctl.brake) ann.push(['BRAKES', C.white]);
    if (fm.spoilerPos > 0.05) ann.push([fm.onGround ? 'SPOILERS' : 'SPEED BRAKE', fm.onGround ? C.green : C.amber]);
    if (ctl.reverse) ann.push(['REVERSER', C.green]);
    if (fm.onGround) ann.push(['WOW', C.dim]);
    g.font = `bold 12px ${FONT}`; g.textAlign = 'left';
    ann.forEach(([t, col], i) => { g.fillStyle = col; g.fillText(t, 20 + (i % 3) * 102, 262 + Math.floor(i / 3) * 18); });
    g.fillStyle = C.dim; g.font = `11px ${FONT}`;
    const sat = fm.oat !== undefined ? Math.round(15 - 0.0065 * Math.min(fm.pos.y, 11000) + (fm.isaDev || 0)) : null;   // ISA lapse + deviation
    g.fillText(`GW ${(fm.mass / 1000).toFixed(0)}t  WIND ${String(fm.windFrom).padStart(3, '0')}°/${fm.windKts}kt${sat !== null ? `  SAT ${sat}°C` : ''}${fm.surface && fm.surface !== 'dry' ? `  RWY ${fm.surface === 'wet' ? 'WET' : 'SNOW'}` : ''}`, 20, 290);
  }

  topBar(g, fm, rig) {
    g.font = `12px ${FONT}`; g.textAlign = 'left'; g.fillStyle = 'rgba(255,255,255,0.75)';
    const txt = `KAMERA: ${CAMERA_MODES[rig.mode]}  ·  ${this.fps.toFixed(0)} FPS  ·  H: yardım`;
    g.fillStyle = 'rgba(6,10,16,0.55)'; const tw = g.measureText(txt).width;
    g.beginPath(); g.roundRect(12, 12, tw + 20, 24, 6); g.fill();
    g.fillStyle = 'rgba(230,240,255,0.85)'; g.fillText(txt, 22, 28);
    this.firStrip(g);
  }

  envStrip(g, fm) {
    const oat = Math.round(15 - 0.0065 * Math.min(Math.max(0, fm.pos.y), 11000) + (fm.isaDev || 0));
    const tat = Math.round(oat + (fm.tas * fm.tas) / 2010);
    const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
    const base = this.envLabel ? `${this.envLabel}  ·  ` : '';
    const temp = `OAT ${sign(oat)}°C / TAT ${sign(tat)}°C`;
    const icing = oat <= 0 && (fm.inCloud || 0) > 0.25 ? '  ·  BUZLANMA' : '';
    const full = base + temp + icing;
    g.save();
    g.font = `12px ${FONT}`;
    const w = g.measureText(full).width + 20;
    const x = this.w - 16 - w, y = 12;
    g.fillStyle = 'rgba(6,10,16,0.68)';
    g.strokeStyle = icing ? 'rgba(49,208,255,0.75)' : 'rgba(140,170,210,0.28)';
    g.lineWidth = 1;
    g.beginPath(); g.roundRect(x, y, w, 24, 6); g.fill(); g.stroke();
    g.textAlign = 'left';
    g.fillStyle = 'rgba(230,240,255,0.88)';
    g.fillText(base, x + 10, y + 16);
    const bw = g.measureText(base).width;
    g.fillStyle = oat <= 0 ? C.cyan : '#ffd27d';
    g.fillText(temp, x + 10 + bw, y + 16);
    if (icing) {
      g.fillStyle = C.cyan;
      g.fillText(icing, x + 10 + bw + g.measureText(temp).width, y + 16);
    }
    g.restore();
  }

  // ---------------------------------------------------------------- FIR
  /** fir: current region; info: { next, km, etaMin } ahead on the track */
  setFir(fir, ahead) { this.fir = fir; this.firAhead = ahead; }
  showFirCard(fir, entry, title = 'FIR GİRİŞİ') { this.firCard = { fir, entry, title, t: 10 }; }

  firStrip(g) {
    if (this.fir === undefined) return;
    const f = this.fir, a = this.firAhead;
    g.font = `bold 12px ${FONT}`;
    const main = f ? `FIR  ${f.id} · ${f.name.toLocaleUpperCase('en')}${f.oceanic ? ' OCEANIC' : ''}${f.country ? '  ·  ' + f.country : ''}` : 'FIR  — (bölge dışı)';
    const nxt = a && a.next ? `→ ${a.next.id} ${a.next.name.toLocaleUpperCase('en')} · ${a.km.toFixed(0)} km${a.etaMin != null ? ' · ' + (a.etaMin < 1 ? '<1' : a.etaMin.toFixed(0)) + ' dk' : ''}` : '';
    const w = Math.max(g.measureText(main).width, nxt ? g.measureText(nxt).width : 0) + 22;
    g.fillStyle = 'rgba(6,10,16,0.62)'; g.beginPath(); g.roundRect(12, 42, w, nxt ? 40 : 24, 6); g.fill();
    g.fillStyle = C.cyan; g.textAlign = 'left'; g.fillText(main, 22, 58);
    if (nxt) { g.font = `12px ${FONT}`; g.fillStyle = C.white; g.fillText(nxt, 22, 75); }

    const c = this.firCard;
    if (!c) return;
    c.t -= this.lastDt || 0.016;
    if (c.t <= 0) { this.firCard = null; return; }
    const alpha = Math.min(1, c.t / 1.2, (10 - c.t) / 0.3);
    g.save(); g.globalAlpha = Math.max(0, alpha);
    const x = 12, y = nxt ? 90 : 74, W = 360;
    const fr = c.fir, e = c.entry;
    const rows = fr ? [
      ['ICAO', fr.id], ['Ad', fr.name + (fr.oceanic ? ' (Oceanic)' : '')], ['Ülke', fr.country || '—'],
      ['Bölge', [fr.region, fr.division].filter(Boolean).join(' · ') || '—'], ['UIR', fr.uir || '—'],
      ['Giriş (UTC)', e.utc], ['Giriş', `FL${String(Math.round(e.altFt / 100)).padStart(3, '0')} · ${e.kt.toFixed(0)} kt · HDG ${String(Math.round(e.hdg)).padStart(3, '0')}°`],
      ['Önceki', e.from ? `${e.from.id} ${e.from.name}` : '—'],
    ] : [['Durum', 'Tanımlı bir FIR sınırının dışındasın']];
    const H = 34 + rows.length * 19;
    g.fillStyle = 'rgba(6,10,16,0.88)'; g.strokeStyle = C.cyan; g.lineWidth = 1.5;
    g.beginPath(); g.roundRect(x, y, W, H, 8); g.fill(); g.stroke();
    g.fillStyle = C.cyan; g.font = `bold 13px ${FONT}`; g.fillText(`${c.title}${fr ? ' · ' + fr.id : ''}`, x + 12, y + 20);
    g.font = `12px ${FONT}`;
    rows.forEach(([k, v], i) => { g.fillStyle = C.dim; g.fillText(k, x + 12, y + 40 + i * 19); g.fillStyle = C.white; g.fillText(String(v).slice(0, 38), x + 110, y + 40 + i * 19); });
    g.restore();
  }

  /** Top of the free area below anything docked at the top centre (the autopilot MCP). */
  topInset() {
    let y = 46;
    const mcp = document.getElementById('mcp');
    if (mcp && mcp.style.display !== 'none') {
      const r = mcp.getBoundingClientRect();
      if (r.height > 0 && r.top < this.h / 2) y = Math.max(y, r.bottom + 12);
    }
    return y;
  }

  warnings(g, fm, dt) {
    const top = this.topInset() + 24;
    const warn = computeWarnings(fm).map(w => [w.text, w.level === 'red' ? C.red : C.amber]);
    g.textAlign = 'center'; g.font = `bold 22px ${FONT}`;
    const blink = (performance.now() % 700) < 450;
    warn.forEach(([t, col], i) => {
      const y = top + i * 34; const w = g.measureText(t).width + 30;
      g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(this.w / 2 - w / 2, y - 22, w, 30);
      g.strokeStyle = col; g.lineWidth = 2; g.strokeRect(this.w / 2 - w / 2, y - 22, w, 30);
      g.fillStyle = (col === C.red && !blink) ? 'rgba(255,59,48,0.5)' : col; g.fillText(t, this.w / 2, y);
    });
    // transient messages
    this.msgs.forEach(m => (m.t -= dt));
    this.msgs = this.msgs.filter(m => m.t > 0);
    g.font = `bold 16px ${FONT}`;
    const by = top + warn.length * 34 + 16;
    this.msgs.forEach((m, i) => {
      g.globalAlpha = Math.min(1, m.t * 2);
      const w = g.measureText(m.text).width + 26, y = by + i * 28;
      g.fillStyle = 'rgba(6,10,16,0.65)'; g.beginPath(); g.roundRect(this.w / 2 - w / 2, y - 18, w, 26, 6); g.fill();
      g.fillStyle = m.color; g.fillText(m.text, this.w / 2, y);
      g.globalAlpha = 1;
    });
  }

  help(g) {
    const lines = [
      ['W/S  ↑/↓', 'Burun aşağı / yukarı (S: çek)'], ['A/D  ←/→', 'Yatış'], ['Q/E', 'Rudder · yerde burun tekeri'],
      ['R/F  PgUp/PgDn', 'Gaz'], ['X / Z', 'Flap aç / topla (0-1-2-5-10-15-25-30-40)'], ['G', 'İniş takımı'],
      ['Space / B', 'Fren (basılı tut)'], ['P', 'Park freni'], ['L', 'Spoiler / hava freni'], ['T', 'Ters itki (yerde)'],
      ['[ / ]', 'Stab trim · Y: oto-trim'], ['C / 1-5', 'Kamera · fare sürükle: bakış · teker: zoom'],
      ['K / J', 'Piste dön / iniş yaklaşmasına başla'], ['N', 'Haritayı aç (başka havalimanı / nokta)'], ['V', 'Mini harita aç / kapa (sağ üst)'], ['0 / 9', 'Radar (ND) aç/kapa · menzil 10-160 NM'], ['8', 'Bulunduğun FIR bilgi kartı'], ['6 / Shift+6', 'Saati ±1 saat değiştir'], ['7', 'Hava durumunu değiştir (açık → parçalı → yağmur → fırtına → kar)'], ['O', 'Canlı yansıma aç / kapa (performans)'], ['I / Shift+I', 'Otopilot / otomatik gaz (üstteki MCP paneli)'], ['Tab / ` / F8', 'FMS / Uçuş planı penceresini aç/kapa'], ['F2', 'İstatistikler panelini aç/kapa (süre & veri)'], ['Esc', 'Duraklat'], ['U', 'HUD gizle'], ['Shift+U', 'Panel yerleşimini sıfırla (paneller üst kenarından sürüklenir)'], ['M · , / .', 'Ses aç/kapa · sesi %10 kıs / aç'],
      ['', ''], ['Kalkış', 'P (fren bırak) → R ile tam gaz → ~145 kt\'da S ile çek → G takım → Z flapları topla'],
      ['İniş', 'J ile başla: ~140 kt, PAPI 2 beyaz 2 kırmızı, 50 ft\'te gazı kes, yere değince T + Space'],
    ];
    const w = 560, h = lines.length * 22 + 30, x = this.w / 2 - w / 2, y = this.h / 2 - h / 2;
    this.panel(g, x, y, w, h);
    g.textAlign = 'left'; g.font = `13px ${FONT}`;
    lines.forEach(([k, v], i) => { g.fillStyle = C.cyan; g.fillText(k, x + 18, y + 28 + i * 22); g.fillStyle = C.white; g.fillText(v, x + 170, y + 28 + i * 22); });
  }

  crash(g, fm) {
    g.fillStyle = 'rgba(40,0,0,0.45)'; g.fillRect(0, 0, this.w, this.h);
    g.textAlign = 'center'; g.fillStyle = C.red; g.font = `bold 40px ${FONT}`;
    g.fillText('KAZA', this.w / 2, this.h / 2 - 20);
    g.fillStyle = C.white; g.font = `18px ${FONT}`;
    g.fillText(fm.crashReason, this.w / 2, this.h / 2 + 16);
    g.fillStyle = C.dim; g.font = `14px ${FONT}`;
    g.fillText('K: piste dön   ·   J: yaklaşmadan başla', this.w / 2, this.h / 2 + 48);
  }
}
