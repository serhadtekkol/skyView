import { clamp } from './noise.js';
import { MS2KT, M2FT } from './physics.js';
import { vnavTarget, NM } from './flightplan.js';

// Autopilot + autothrottle (Boeing-style MCP logic, simplified).
// Lateral: HDG SEL | LNAV | LOC.   Vertical: V/S | LVL CHG | VNAV | ALT (ACQ/HOLD) | G/S | FLARE.
// A/T: SPD (holds selected IAS) | THR (fixed climb thrust in LVL CHG / VNAV CLB) | RETARD (autoland).

const D2R = Math.PI / 180;
const TAN3 = Math.tan(3 * D2R);
const wrap180 = (d) => ((d % 360) + 540) % 360 - 180;

export class Autopilot {
  constructor(fm) {
    this.fm = fm;
    this.ap = false; this.at = false;
    this.sel = { spd: 250, hdg: 360, alt: 10000, vs: 1500 };
    this.lat = 'HDG'; this.vert = 'VS'; this.atMode = 'SPD';
    this.appArmed = false; this.gsArmed = false;
    this.armedLnav = false; this.armedVnav = false;
    this.runway = null;        // { x, z, elev, heading } of the active threshold, for APP
    this.route = null;         // ActiveRoute from flightplan.js
    this.navState = null;
    this.vnavPhase = 'CLB';
    this.vnavTargetAlt = null;
    this.spdIntv = false;
    this.listeners = [];
    this.pitchI = 0; this.thrI = 0; this.flchVs = 0; this.lastHdg = null; this.hdgRate = 0;
    this.apGrace = 0;
    this.msg = null;
  }

  setRoute(activeRoute, destRunwayLocal = null) {
    this.route = activeRoute;
    if (destRunwayLocal) this.runway = destRunwayLocal;
    if (activeRoute) {
      activeRoute.start(this.fm.pos);
      const altFt = this.fm.pos.y * M2FT;
      this.vnavPhase = altFt >= (activeRoute.route.crzFt - 200) ? 'CRZ' : 'CLB';
      this.navState = activeRoute.update(this.fm.pos, Math.hypot(this.fm.vel.x, this.fm.vel.z));
    } else {
      this.navState = null;
      this.vnavTargetAlt = null;
      if (this.lat === 'LNAV') this.lat = 'HDG';
      if (this.vert === 'VNAV') this.vert = 'ALT';
    }
    this.emit();
  }

  onChange(fn) { this.listeners.push(fn); }
  emit(message, color) { if (message) this.msg = { text: message, color }; this.listeners.forEach(f => f(message, color)); }

  /** Called on every respawn: sensible MCP presets. */
  preset({ spd, hdg, alt, vs = 1500 }) {
    this.ap = false; this.at = false; this.appArmed = false; this.gsArmed = false;
    this.armedLnav = false; this.armedVnav = false;
    this.spdIntv = false;
    this.lat = 'HDG'; this.vert = 'VS';
    Object.assign(this.sel, { spd, hdg: Math.round(hdg) || 360, alt, vs });
    this.emit();
  }

  // ---------------------------------------------------------------- MCP actions
  setSel(key, v) {
    const lim = { spd: [100, 340], hdg: [0, 360], alt: [0, 41000], vs: [-6000, 6000] }[key];
    if (key === 'hdg') v = ((Math.round(v) % 360) + 360) % 360 || 360;
    else if (key === 'alt') v = Math.round(v / 100) * 100;
    else if (key === 'vs') v = Math.round(v / 100) * 100;
    else v = Math.round(v);
    this.sel[key] = clamp(v, lim[0], lim[1]);
    if (key === 'spd' && this.ap && this.vert === 'VNAV') this.spdIntv = true;
    // a new altitude while holding -> start climbing/descending toward it
    if (key === 'alt' && this.ap && (this.vert === 'ALT' || this.vert === 'ALT*')) {
      const err = this.sel.alt - this.fm.pos.y * M2FT;
      if (Math.abs(err) > 250) this.engageVertical(Math.abs(err) > 2500 ? 'FLCH' : 'VS');
    }
    if (key === 'vs' && this.ap && this.vert !== 'VS' && this.vert !== 'GS' && this.vert !== 'FLARE') this.engageVertical('VS', true);
    this.emit();
  }

  toggleAP() {
    if (this.ap) return this.disconnect('AUTOPILOT DISCONNECT');
    if (this.fm.onGround) return this.emit('A/P: önce kalkış yap', 'amber');
    this.ap = true; this.pitchI = 0; this.apGrace = 0.5;
    this.lat = this.armedLnav && this.route?.legs?.length ? 'LNAV' : 'HDG';
    if (this.armedVnav && this.route?.legs?.length) {
      this.vert = 'VNAV';
      this.flchVs = clamp(this.fm.vel.y * 60 * M2FT, 300, 6000);
      this.vnavPhase = this.fm.pos.y * M2FT >= (this.route.route.crzFt - 200) ? 'CRZ' : 'CLB';
    } else {
      const err = this.sel.alt - this.fm.pos.y * M2FT;
      this.engageVertical(Math.abs(err) < 250 ? 'ALT' : 'VS');
    }
    this.armedLnav = false; this.armedVnav = false;
    if (!this.at) this.toggleAT(true);
    this.emit('AUTOPILOT ENGAGED', 'green');
  }

  toggleAT(silent = false) {
    if (this.at) { this.at = false; this.emit('A/T DISCONNECT', 'amber'); return; }
    this.at = true; this.atMode = 'SPD'; this.thrI = this.fm.ctl.throttle;
    if (!silent) this.emit('A/T ARMED · SPD', 'green');
    else this.emit();
  }

  engageVertical(mode, keepVs = false) {
    const fm = this.fm, alt = fm.pos.y * M2FT, err = this.sel.alt - alt;
    if (mode === 'VS' && !keepVs) {
      const mag = Math.abs(this.sel.vs) || 1500;
      this.sel.vs = Math.sign(err || 1) * mag;
    }
    if (mode === 'FLCH') { this.flchVs = fm.vel.y * 60 * M2FT; this.atMode = 'THR'; }
    else if (this.atMode === 'THR') this.atMode = 'SPD';
    this.vert = mode;
    if (this.ap && !this.at && mode !== 'ALT') this.toggleAT(true);
    this.emit();
  }

  button(name) {
    if (name === 'AP') return this.toggleAP();
    if (name === 'AT') return this.toggleAT();
    if (name === 'LNAV' || name === 'VNAV') {
      if (!this.route || !this.route.legs.length) return this.emit('NO ROUTE', 'amber');
      if (!this.ap && this.fm.onGround) {
        if (name === 'LNAV') { this.armedLnav = !this.armedLnav; this.emit(this.armedLnav ? 'LNAV ARMED (kalkışta aktif)' : 'LNAV DISARMED'); }
        else { this.armedVnav = !this.armedVnav; this.emit(this.armedVnav ? 'VNAV ARMED (kalkışta aktif)' : 'VNAV DISARMED'); }
        return;
      }
    }
    if (!this.ap) { this.toggleAP(); if (!this.ap) return; }
    if (name === 'HDG') { this.lat = 'HDG'; this.appArmed = false; this.gsArmed = false; }
    else if (name === 'LNAV') {
      if (this.lat === 'LNAV') { this.lat = 'HDG'; this.emit('HDG SEL'); }
      else { this.lat = 'LNAV'; this.appArmed = false; this.gsArmed = false; this.emit('LNAV ENGAGED', 'green'); }
    }
    else if (name === 'VNAV') {
      if (this.vert === 'VNAV') this.engageVertical('ALT');
      else {
        this.vert = 'VNAV'; this.gsArmed = false; this.spdIntv = false;
        this.flchVs = clamp(this.fm.vel.y * 60 * M2FT, 300, 6000);
        this.vnavPhase = this.fm.pos.y * M2FT >= (this.route.route.crzFt - 200) ? 'CRZ' : 'CLB';
        if (this.ap && !this.at) this.toggleAT(true);
        this.emit('VNAV ENGAGED', 'green');
      }
    }
    else if (name === 'ALT') this.engageVertical('ALT');
    else if (name === 'VS') this.engageVertical('VS', true);
    else if (name === 'FLCH') this.engageVertical('FLCH');
    else if (name === 'APP') {
      if (!this.runway) return this.emit('APP: bu konumda ILS yok', 'amber');
      this.appArmed = true; this.gsArmed = true;
      this.emit('APP ARMED · LOC / G/S', 'white');
    }
    this.emit();
  }

  engageRoute() {
    if (!this.route || !this.route.legs.length) return this.emit('Önce varış seçip EXEC yap', 'amber');
    if (this.fm.onGround) {
      this.armedLnav = true; this.armedVnav = true;
      this.emit('LNAV + VNAV HAZIR · Kalkıştan sonra A/P (I) aç', 'cyan');
      return;
    }
    this.ap = true; this.pitchI = 0; this.apGrace = 0.5;
    this.lat = 'LNAV'; this.vert = 'VNAV'; this.spdIntv = false;
    this.appArmed = false; this.gsArmed = false;
    this.armedLnav = false; this.armedVnav = false;
    this.flchVs = clamp(this.fm.vel.y * 60 * M2FT, 300, 6000);
    this.vnavPhase = this.fm.pos.y * M2FT >= (this.route.route.crzFt - 200) ? 'CRZ' : 'CLB';
    if (!this.at) this.toggleAT(true);
    this.emit('ROTA TAKİBİ AKTİF · LNAV + VNAV', 'green');
  }

  disconnect(text = 'AUTOPILOT DISCONNECT') {
    if (!this.ap) return;
    this.ap = false; this.appArmed = false; this.gsArmed = false;
    this.fm.ctl.elevator = 0; this.fm.ctl.aileron = 0;
    this.emit(text, 'red');
  }

  // ---------------------------------------------------------------- control loops
  update(dt, pilotOverride) {
    const fm = this.fm, ctl = fm.ctl;
    if (dt <= 0 || fm.crashed) return;
    const e = fm.euler;
    const hdg = fm.heading;
    if (this.lastHdg !== null) this.hdgRate += (wrap180(hdg - this.lastHdg) / dt - this.hdgRate) * Math.min(1, dt * 4);
    this.lastHdg = hdg;
    if (this.apGrace > 0) this.apGrace = Math.max(0, this.apGrace - dt);
    if (this.ap && this.apGrace <= 0 && pilotOverride.pitchRoll) this.disconnect('OTOPİLOT KAPANDI (W/A/S/D manuel kumanda)');
    if (this.at && this.apGrace <= 0 && pilotOverride.throttle) { this.at = false; this.emit('A/T KAPANDI (manuel gaz)', 'amber'); }

    const ias = fm.ias * MS2KT, alt = fm.pos.y * M2FT, vs = fm.vel.y * 60 * M2FT;
    const agl = fm.agl * M2FT;
    const gsMS = Math.hypot(fm.vel.x, fm.vel.z);
    const track = gsMS > 5 ? (Math.atan2(fm.vel.x, -fm.vel.z) / D2R + 360) % 360 : hdg;

    this.navState = this.route ? this.route.update(fm.pos, gsMS) : null;
    if (this.navState?.sequenced) this.emit(`WPT SEQ: ${this.navState.sequenced}`, 'cyan');

    if (this.ap) {
      // ---------- lateral
      let bankT = 0;
      let rw = null;
      if (this.runway) {
        const r = this.runway, dx = Math.sin(r.heading * D2R), dz = -Math.cos(r.heading * D2R);
        const rx = fm.pos.x - r.x, rz = fm.pos.z - r.z;
        rw = { along: -(rx * dx + rz * dz), cross: rx * -dz + rz * dx, dx, dz };   // along>0 before threshold; cross>0 right of centreline
        rw.vlat = fm.vel.x * -dz + fm.vel.z * dx;
      }
      if (this.lat === 'LNAV' && this.navState?.onFinal && this.runway && !this.appArmed) {
        this.appArmed = true; this.gsArmed = true;
        this.emit('APP ARMED · LOC / G/S', 'white');
      }
      if (this.appArmed && rw && this.lat !== 'LOC') {
        const intercept = Math.abs(wrap180(track - this.runway.heading)) < 60;
        if (intercept && rw.along > -500 && rw.along < 30000 && Math.abs(rw.cross) < 2500) { this.lat = 'LOC'; this.emit('LOC CAPTURED', 'green'); }
      }
      if (this.lat === 'LOC' && rw) {
        const corr = clamp(-rw.cross * 0.035 - rw.vlat * 0.9, -30, 30);
        const err = wrap180(this.runway.heading + corr - track);
        bankT = clamp(err * 1.4 - this.hdgRate * 2.2, -22, 22);
        if (agl < 60) bankT = clamp(bankT, -3, 3);
      } else if (this.lat === 'LNAV' && this.navState) {
        this.sel.hdg = Math.round(this.navState.desiredTrack) || 360;
        const err = wrap180(this.navState.desiredTrack - track);
        bankT = clamp(err * 1.4 - this.hdgRate * 2.2, -25, 25);
      } else {
        const err = wrap180(this.sel.hdg - hdg);
        bankT = clamp(err * 1.25 - this.hdgRate * 2.0, -25, 25);
      }
      const bank = -e.z / D2R, pR = -fm.omega.z;
      ctl.aileron = clamp((bankT - bank) * 0.045 - pR * 0.9, -0.6, 0.6);
      ctl.rudder = 0;

      // ---------- vertical
      let vsT = 0;
      const altErr = this.sel.alt - alt;
      if (this.gsArmed && rw && this.lat === 'LOC' && this.vert !== 'GS' && this.vert !== 'FLARE') {
        const gpAlt = (this.runway.elev + Math.max(0, rw.along + 300) * Math.tan(3 * D2R)) * M2FT;
        if (alt - gpAlt < 250 && rw.along > 0) { this.vert = 'GS'; this.gsArmed = false; this.atMode = 'SPD'; this.emit('G/S CAPTURED', 'green'); }
      }
      if ((this.vert === 'VS' || this.vert === 'FLCH') && Math.abs(altErr) < Math.max(150, Math.abs(vs) * 0.22)) {
        this.vert = 'ALT*'; if (this.atMode === 'THR') this.atMode = 'SPD'; this.emit('ALT ACQ', 'green');
      }
      if (this.vert === 'ALT*' && Math.abs(altErr) < 40) { this.vert = 'ALT'; this.emit(); }

      if (this.vert === 'VNAV' && this.navState) {
        const vn = vnavTarget({
          ...this.route.route,
          constraints: this.navState.constraints,
          phase: this.vnavPhase,
          altFt: alt,
          distToDestNm: this.navState.distToDestM / NM,
          onFinal: this.navState.onFinal,
          speedScale: fm.speedScale || 1,
        });
        if (vn.phase !== this.vnavPhase) {
          if (vn.phase === 'DES') this.emit('T/D · DESCENT STARTED', 'cyan');
          else if (vn.phase === 'APP') this.emit('VNAV APP · SET FLAPS / GEAR', 'amber');
          this.vnavPhase = vn.phase;
        }
        this.vnavTargetAlt = vn.altFt;
        if (!this.spdIntv) this.sel.spd = Math.round(vn.spdKt);
        if (vn.phase === 'CLB') {
          const vErr = vn.altFt - alt;
          if (Math.abs(vErr) < 150) {
            this.atMode = 'SPD';
            vsT = clamp(vErr * 4.5, -1500, 1500);
          } else {
            this.atMode = 'THR';
            const se = clamp(ias - this.sel.spd, -15, 15);
            this.flchVs += se * 14 * dt;
            this.flchVs = clamp(this.flchVs, 300, 6000);
            vsT = clamp(this.flchVs + se * 35, 0, 6000);
          }
        } else if (vn.phase === 'CRZ') {
          this.atMode = 'SPD';
          vsT = clamp((vn.altFt - alt) * 4.5, -2000, 2000);
        } else {
          this.atMode = 'SPD';
          const pathErr = vn.pathAltFt - alt;
          if (alt <= vn.altFt + 80 && pathErr < 80) vsT = clamp((vn.altFt - alt) * 4.5, -1500, 1500);
          else vsT = clamp(-gsMS * TAN3 * 60 * M2FT + pathErr * 3.0, -3500, 500);
        }
      } else {
        this.vnavTargetAlt = null;
        if (this.vert === 'VS') vsT = this.sel.vs;
        else if (this.vert === 'ALT' || this.vert === 'ALT*') vsT = clamp(altErr * 4.5, -2000, 2000);
        else if (this.vert === 'FLCH') {
          // pitch holds speed: too fast -> climb steeper / descend shallower
          const se = clamp(ias - this.sel.spd, -15, 15);
          this.flchVs += se * 14 * dt;
          this.flchVs = altErr > 0 ? clamp(this.flchVs, 300, 6000) : clamp(this.flchVs, -6000, -300);
          vsT = altErr > 0 ? clamp(this.flchVs + se * 35, 0, 6000) : clamp(this.flchVs + se * 35, -6000, 0);
        } else if (this.vert === 'GS' && rw) {
          const gpAlt = (this.runway.elev + Math.max(0, rw.along + 300) * Math.tan(3 * D2R)) * M2FT;
          vsT = clamp(-gsMS * Math.tan(3 * D2R) * 60 * M2FT + (gpAlt - alt) * 3.5, -1800, 600);
          if (agl < 50) { this.vert = 'FLARE'; this.emit('FLARE', 'green'); }
        } else if (this.vert === 'FLARE') {
          vsT = Math.max(-750, -(agl * 9 + 90));
        }
      }
      // envelope protection: never trade below a safe speed for climb
      const vMin = (fm.ctl.flapIndex === 0 ? 210 : 150 - 4 * fm.ctl.flapIndex) * (fm.speedScale || 1);
      if (this.vert !== 'FLARE' && ias < vMin && vsT > 0) vsT *= clamp((ias - (vMin - 25)) / 25, 0, 1);

      const V = Math.max(fm.tas, 40);
      const gammaT = Math.asin(clamp((vsT / (60 * M2FT)) / V, -0.3, 0.3));
      let thetaT = gammaT + fm.alpha + (vsT - vs) * 0.00003;
      thetaT = clamp(thetaT, -10 * D2R, (this.vert === 'FLARE' ? 9 : 18) * D2R);
      const pe = thetaT - e.x;
      this.pitchI = clamp(this.pitchI + pe * 0.6 * dt, -0.25, 0.25);
      ctl.elevator = clamp(pe * 2.6 - fm.omega.x * 1.6 + this.pitchI, -0.7, 0.7);
      // trim offloads the elevator like a real autopilot
      ctl.trim = clamp(ctl.trim + ctl.elevator * 0.12 * dt, -1, 1);

      if (fm.onGround && fm.airborneTime === 0) {
        this.disconnect(this.vert === 'FLARE' ? 'AUTOLAND · fren yap (Space) · T ters itki' : 'AUTOPILOT DISCONNECT');
        ctl.spoilers = 1;
      }
    }

    // ---------- autothrottle
    if (this.at) {
      let thrT;
      if (this.ap && this.vert === 'FLARE' && agl < 30) {
        if (this.atMode !== 'RETARD') { this.atMode = 'RETARD'; this.emit('RETARD', 'green'); }
        thrT = 0;
      } else if (this.atMode === 'THR') {
        const tgt = this.vert === 'VNAV' && this.vnavTargetAlt != null ? this.vnavTargetAlt : this.sel.alt;
        thrT = tgt > alt ? 0.93 : 0;
      } else {
        const err = this.sel.spd - ias;
        this.thrI = clamp(this.thrI + err * 0.006 * dt, 0, 1);
        thrT = clamp(this.thrI + err * 0.035 - (vs > 0 ? 0 : 0) , 0, 1);
      }
      ctl.throttle += clamp(thrT - ctl.throttle, -0.25 * dt, 0.25 * dt);
      if (this.atMode === 'THR') this.thrI = ctl.throttle;
      if (fm.onGround && this.atMode === 'RETARD') { this.at = false; ctl.throttle = 0; this.emit(); }
    }
  }

  /** Flight mode annunciations for the PFD. */
  get fma() {
    const v = { VS: 'V/S', FLCH: 'LVL CHG', VNAV: `VNAV ${this.vnavPhase}`, 'ALT*': 'ALT ACQ', ALT: 'ALT HOLD', GS: 'G/S', FLARE: 'FLARE' };
    return {
      at: this.at ? (this.atMode === 'THR' ? 'THR' : this.atMode) : '',
      lat: this.ap ? (this.lat === 'LOC' ? 'LOC' : this.lat === 'LNAV' ? 'LNAV' : 'HDG SEL') : '',
      latArm: this.appArmed && this.lat !== 'LOC' ? 'LOC' : (!this.ap && this.armedLnav ? 'LNAV' : ''),
      vert: this.ap ? v[this.vert] : '',
      vertArm: this.gsArmed ? 'G/S' : (!this.ap && this.armedVnav ? 'VNAV' : ''),
      ap: this.ap ? 'A/P' : '',
    };
  }
}
