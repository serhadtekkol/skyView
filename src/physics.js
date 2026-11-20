import * as THREE from 'three';
import { groundHeight, terrainHeight } from './world.js';
import { clamp, lerp, smoothstep, createNoise2D } from './noise.js';

// Rigid-body 6-DOF flight model, Boeing 737-900 class.
// Frames: world Y-up, north = -Z, east = +X.  Body (three.js local): +X right wing, +Y up, -Z nose.
// omega (local): x = pitch rate (nose up +), y = yaw rate (nose LEFT +), z = roll rate (LEFT wing down +)

const G = 9.80665;
const D2R = Math.PI / 180;
export const FLAP_DETENTS = [0, 1, 2, 5, 10, 15, 25, 30, 40];
export const MS2KT = 1.943844;
export const M2FT = 3.28084;

export function isaDensity(h) { return 1.225 * Math.pow(Math.max(0.2, 1 - 2.25577e-5 * h), 4.2559); }
export function speedOfSound(h) { return Math.sqrt(1.4 * 287.05 * Math.max(216.65, 288.15 - 0.0065 * h)); }

const turb = createNoise2D(555);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

export class FlightModel {
  constructor({ gearPoints, hardPoints, spec = {}, enginePos = null }) {
    // airframe
    // airframe (defaults: 737-900); inertia scaled from the 737 by mass x span^2
    this.mass = spec.mass || 66000;
    this.S = spec.S || 124.6; this.b = spec.b || 34.32; this.cbar = this.S / this.b;
    const k = (this.mass / 66000) * (this.b / 34.32) ** 2;
    this.I = new THREE.Vector3(3.9e6 * k, 5.6e6 * k, 1.9e6 * k);    // pitch, yaw, roll
    this.maxThrust = spec.thrust || 121400;                          // N per engine
    this.enginePos = (enginePos && enginePos.length ? enginePos : [new THREE.Vector3(-0.14 * this.b, -1.3, -4.3), new THREE.Vector3(0.14 * this.b, -1.3, -4.3)]).map(v => v.clone());
    this.nEng = this.enginePos.length;
    this.speedScale = Math.sqrt((this.mass / this.S) / (66000 / 124.6));

    // aero coefficients
    this.c = {
      CL0: 0.30, CLa: 5.5, CLflap: 1.0, CD0: 0.019, K: 0.043,
      Cm0: 0.05, Cma: -1.6, Cmq: -25, Cmde: 0.55, Cmtrim: 0.30, Cmflap: -0.12,
      Clb: -0.10, Clp: -0.45, Clda: 0.042, Cldr: 0.005, Clr: 0.10,
      Cnb: 0.12, Cnr: -0.32, Cndr: 0.032, Cnda: -0.004,
      CYb: -0.8, CYdr: 0.06,
    };

    this.gearPoints = gearPoints;   // [{name, p:Vector3 (local, rel CG), k, c, steer, brake}]
    this.hardPoints = hardPoints;   // [{name, p, fatal}]

    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion(); this.omega = new THREE.Vector3();
    this.wind = new THREE.Vector3();
    this.setWind(340, 6);
    this.turbulence = 0.6;     // 0..1 scale
    this.isaDev = 0;           // °C deviation from ISA (cold air is denser)
    this.surfaceMu = 1;        // runway friction factor: 1 dry, ~0.6 wet, ~0.35 snow
    this.inCloud = 0;

    this.ctl = { elevator: 0, aileron: 0, rudder: 0, throttle: 0, brake: 0, parkingBrake: true,
      flapIndex: 3, gearDown: true, spoilers: 0, reverse: false, trim: 0, autoTrim: true, tiller: 0 };
    this.acc = 0;
    this.t = 0;
    this.events = [];
    this.resetCommon();
  }

  setWind(fromDeg, kts) {
    const toRad = (fromDeg + 180) * D2R, v = kts / MS2KT;
    this.windBase = new THREE.Vector3(Math.sin(toRad) * v, 0, -Math.cos(toRad) * v);
    this.windFrom = fromDeg; this.windKts = kts;
  }

  resetCommon() {
    this.n1 = Array(this.nEng).fill(20.5);
    this.flapPos = FLAP_DETENTS[this.ctl.flapIndex];
    this.slatPos = this.flapPos > 0 ? 1 : 0;
    this.gearPos = this.ctl.gearDown ? 1 : 0;
    this.spoilerPos = 0; this.reverserPos = 0;
    this.surf = { elevator: 0, aileron: 0, rudder: 0 };
    this.compression = this.gearPoints.map(() => 0);
    this.wheelSpin = this.gearPoints.map(() => 0);
    this.wheelOmega = this.gearPoints.map(() => 0);
    this.contact = this.gearPoints.map(() => false);
    this.onGround = false; this.crashed = false; this.crashReason = '';
    this.alpha = 0; this.beta = 0; this.tas = 0; this.ias = 0; this.mach = 0; this.nz = 1;
    this.stall = 0; this.lastTouchdownFpm = null; this.airborneTime = 0; this.tailStrike = false;
    this.steerDeg = 0; this.lift = 0;
  }

  /** Places the aircraft on the runway, stationary. */
  resetOnGround(x, z, headingDeg) {
    this.ctl.flapIndex = 3; this.ctl.gearDown = true; this.ctl.throttle = 0; this.ctl.parkingBrake = true;
    this.ctl.reverse = false; this.ctl.spoilers = 0; this.ctl.trim = 0.25;
    this.resetCommon();
    this.quat.setFromAxisAngle(UP, -headingDeg * D2R);
    const lowest = Math.min(...this.gearPoints.map(g => g.p.y));
    this.pos.set(x, groundHeight(x, z) - lowest - 0.12, z);
    this.vel.set(0, 0, 0); this.omega.set(0, 0, 0);
    this.onGround = true;
  }

  /** Places the aircraft on a stabilised 3° approach. */
  resetApproach(x, y, z, headingDeg, speedKt = 145, { flapIndex = 7, gearDown = true, gammaDeg = -3 } = {}) {
    this.ctl.flapIndex = flapIndex; this.ctl.gearDown = gearDown; this.ctl.parkingBrake = false;
    this.ctl.reverse = false; this.ctl.spoilers = 0;
    this.resetCommon();
    const V = speedKt / MS2KT, gamma = gammaDeg * D2R;
    const rho = this.density(y);
    const qS = 0.5 * rho * V * V * this.S;
    const flapN = this.flapPos / 40;
    const CLreq = this.mass * G * Math.cos(gamma) / qS;
    const alpha = (CLreq - this.c.CL0 - this.c.CLflap * Math.pow(flapN, 0.7)) / this.c.CLa;
    this.ctl.trim = clamp(-(this.c.Cm0 + this.c.Cma * alpha + this.c.Cmflap * flapN) / this.c.Cmtrim, -1, 1);
    const pitch = alpha + gamma;
    // ground track along the runway; nose crabbed into the wind
    const fwd = new THREE.Vector3(Math.sin(headingDeg * D2R), 0, -Math.cos(headingDeg * D2R));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const cross = this.windBase.dot(right);
    this.vel.copy(fwd).multiplyScalar(Math.sqrt(Math.max(1, (V * Math.cos(gamma)) ** 2 - cross * cross)) + this.windBase.dot(fwd));
    const air = this.vel.clone().sub(this.windBase);
    const hdgAir = Math.atan2(air.x, -air.z);
    this.vel.y = V * Math.sin(gamma);
    this.quat.setFromEuler(new THREE.Euler(pitch, -hdgAir, 0, 'YXZ'));
    this.pos.set(x, y, z); this.omega.set(0, 0, 0);
    // thrust for steady flight on the path -> N1 -> throttle
    const CL = CLreq;
    const CD = this.c.CD0 + this.c.K * CL * CL + 0.09 * Math.pow(flapN, 1.2) + 0.022 * (gearDown ? 1 : 0);
    const Treq = Math.max(0, qS * CD + this.mass * G * Math.sin(gamma));
    const mach = V / speedOfSound(y);
    const per = Treq / (this.nEng * this.maxThrust * Math.pow(rho / 1.225, 0.8) * (1 - 0.38 * mach + 0.12 * mach * mach));
    const xx = Math.pow(clamp((per - 0.035) / 0.965, 0, 1), 1 / 1.8);
    const n1 = 19 + 81 * xx;
    this.n1 = Array(this.nEng).fill(n1);
    this.ctl.throttle = clamp((n1 - 20.5) / 77.5, 0, 1);
    this.airborneTime = 10;
  }

  // ---------------------------------------------------------------- helpers
  /** Air density with the temperature deviation from ISA (same pressure, different temperature). */
  density(h) { const T = Math.max(216.65, 288.15 - 0.0065 * h); return isaDensity(h) * T / Math.max(150, T + this.isaDev); }
  get heading() { const f = _v.set(0, 0, -1).applyQuaternion(this.quat); return (Math.atan2(f.x, -f.z) / D2R + 360) % 360; }
  get euler() { return new THREE.Euler().setFromQuaternion(this.quat, 'YXZ'); }  // x pitch(+up), y yaw, z roll(+left)
  get agl() { return this.pos.y + Math.min(...this.gearPoints.map(g => g.p.y)) - groundHeight(this.pos.x, this.pos.z); }

  step(dt) {
    if (this.crashed) return;
    this.acc += Math.min(dt, 0.1);
    const h = 1 / 240;
    while (this.acc >= h) { this.substep(h); this.acc -= h; this.t += h; }
  }

  substep(dt) {
    const ctl = this.ctl, c = this.c;

    // ---------- actuators
    const rate = (cur, tgt, r) => cur + clamp(tgt - cur, -r * dt, r * dt);
    this.surf.elevator = rate(this.surf.elevator, ctl.elevator, 3.0);
    this.surf.aileron = rate(this.surf.aileron, ctl.aileron, 3.0);
    this.surf.rudder = rate(this.surf.rudder, ctl.rudder, 2.0);
    this.flapPos = rate(this.flapPos, FLAP_DETENTS[ctl.flapIndex], 2.4);
    this.slatPos = rate(this.slatPos, ctl.flapIndex === 0 ? 0 : (FLAP_DETENTS[ctl.flapIndex] >= 10 ? 1 : 0.6), 0.35);
    const prevGear = this.gearPos;
    this.gearPos = rate(this.gearPos, ctl.gearDown ? 1 : 0, ctl.gearDown ? 1 / 7 : 1 / 8);
    if (prevGear < 1 && this.gearPos === 1) this.events.push('gear-locked');
    const groundSpoilers = this.onGround && ctl.spoilers > 0 ? 1 : 0;
    this.spoilerPos = rate(this.spoilerPos, Math.max(ctl.spoilers, groundSpoilers), 1.2);
    const wantRev = ctl.reverse && this.onGround;
    this.reverserPos = rate(this.reverserPos, wantRev ? 1 : 0, 0.7);

    // ---------- engines
    const revActive = this.reverserPos > 0.9;
    const thr = (ctl.reverse && !revActive) ? 0 : ctl.throttle;
    const n1Target = 20.5 + (revActive ? 0.75 : 1.0) * 77.5 * thr;
    for (let i = 0; i < this.nEng; i++) {
      const d = n1Target - this.n1[i];
      const r = d > 0 ? (this.n1[i] < 50 ? 4.5 : 9) : 12;     // slow spool from idle
      this.n1[i] += clamp(d * 0.9, -r, r) * dt;
    }

    // ---------- atmosphere / air data
    const alt = this.pos.y;
    const rho = this.density(alt);
    const a = speedOfSound(alt) * Math.sqrt(Math.max(0.8, 1 + this.isaDev / 288.15));
    const agl = Math.max(0, alt - groundHeight(this.pos.x, this.pos.z));
    // wind with boundary layer and turbulence
    const bl = Math.pow(clamp((agl + 5) / 400, 0.15, 1), 0.25);
    const ts = this.t * 0.9;
    const tmag = (0.6 + 1.5 * this.inCloud + 0.8 * smoothstep(0, 200, agl) * (1 - smoothstep(2500, 5000, agl))) * this.turbulence;
    this.wind.copy(this.windBase).multiplyScalar(bl);
    if (agl > 3) {
      this.wind.x += turb(ts, 3.1) * tmag;
      this.wind.y += turb(ts * 1.3, 9.7) * tmag * 0.7;
      this.wind.z += turb(ts * 1.1, 17.3) * tmag;
    }

    _qi.copy(this.quat).invert();
    const vAir = _v.copy(this.vel).sub(this.wind);
    const vL = vAir.applyQuaternion(_qi);        // body-frame air velocity
    const V = vL.length();
    this.tas = V; this.ias = V * Math.sqrt(rho / 1.225); this.mach = V / a;

    const force = new THREE.Vector3();   // body frame
    const moment = new THREE.Vector3();  // body frame (x pitch-up, y yaw-left, z roll-left)

    let lift = 0;
    if (V > 0.5) {
      const u = -vL.z;
      const alpha = Math.atan2(-vL.y, Math.max(u, 0.1));
      const beta = Math.asin(clamp(vL.x / V, -1, 1));
      this.alpha = alpha; this.beta = beta;
      const qbar = 0.5 * rho * V * V;
      const flapN = this.flapPos / 40;
      const dCLf = c.CLflap * Math.pow(flapN, 0.7);
      const stallA = (13 + 4 * this.slatPos - 2 * flapN) * D2R;
      const negStallA = -11 * D2R;

      // lift curve with stall
      const CLlin = c.CL0 + dCLf + c.CLa * alpha;
      const CLpost = 1.15 * Math.sin(2 * alpha) + dCLf * 0.4;
      const s = alpha > 0 ? smoothstep(stallA, stallA + 5 * D2R, alpha) : smoothstep(-negStallA, -negStallA + 5 * D2R, -alpha);
      this.stall = s;
      // ground effect
      const hb = agl / this.b;
      const geL = 1 + 0.10 * Math.exp(-4 * hb);
      const geD = (16 * hb) ** 2 / (1 + (16 * hb) ** 2);
      let CL = lerp(CLlin, CLpost, s) * geL - 0.45 * this.spoilerPos * (1 - s);
      const machDrag = this.mach > 0.77 ? 22 * (this.mach - 0.77) ** 3 + 0.3 * (this.mach - 0.77) ** 2 : 0;
      const CD = c.CD0 + c.K * CL * CL * Math.max(geD, 0.25) + 0.09 * Math.pow(flapN, 1.2) + 0.022 * this.gearPos
        + 0.07 * this.spoilerPos + 1.3 * s * Math.sin(Math.abs(alpha)) ** 2 + machDrag + 0.015 * Math.abs(Math.sin(beta));
      const CY = c.CYb * beta + c.CYdr * this.surf.rudder;

      const vhat = _v2.copy(vL).divideScalar(V);
      const liftDir = _v3.set(1, 0, 0).cross(vhat);
      if (liftDir.lengthSq() > 1e-6) liftDir.normalize();
      lift = qbar * this.S * CL;
      force.addScaledVector(liftDir, lift);
      force.addScaledVector(vhat, -qbar * this.S * CD);
      force.x += qbar * this.S * CY;

      // rates
      const qr = this.omega.x, pR = -this.omega.z, rR = -this.omega.y;
      const Vd = Math.max(V, 15);
      const qhat = qr * this.cbar / (2 * Vd), phat = pR * this.b / (2 * Vd), rhat = rR * this.b / (2 * Vd);
      const ail = this.surf.aileron * (1 - 0.4 * s);
      const wingDrop = s * turb(this.t * 0.7, 4.4) * 0.04;
      const Cm = c.Cm0 + c.Cma * alpha + c.Cmq * qhat + c.Cmde * this.surf.elevator + c.Cmtrim * ctl.trim + c.Cmflap * flapN
        - 0.25 * s - 0.02 * this.spoilerPos;
      const Cl = c.Clb * beta + c.Clp * phat + c.Clr * rhat * CL * 0.3 + c.Clda * ail + c.Cldr * this.surf.rudder + wingDrop;
      const Cn = c.Cnb * beta + c.Cnr * rhat + c.Cndr * this.surf.rudder + c.Cnda * ail;
      moment.x += qbar * this.S * this.cbar * Cm;
      moment.y += -qbar * this.S * this.b * Cn;
      moment.z += -qbar * this.S * this.b * Cl;

      // auto-trim (stick released -> trim nulls pitch rate)
      const bank = Math.abs(this.euler.z);
      if (ctl.autoTrim && !this.onGround && this.airborneTime > 3 && Math.abs(ctl.elevator) < 0.05 && bank < 40 * D2R && s < 0.2) {
        ctl.trim = clamp(ctl.trim - clamp(qr * 0.9, -0.12, 0.12) * dt, -1, 1);
      }
    }
    this.lift = lift;

    // ---------- thrust
    const dens = Math.pow(rho / 1.225, 0.8);
    const lapse = 1 - 0.38 * this.mach + 0.12 * this.mach * this.mach;
    for (let i = 0; i < this.nEng; i++) {
      const x = clamp((this.n1[i] - 19) / 81, 0, 1);
      let T = this.maxThrust * dens * lapse * (0.035 + 0.965 * Math.pow(x, 1.8));
      if (this.reverserPos > 0.05) T *= lerp(1, -0.42, this.reverserPos);
      const Fe = _v2.set(0, 0, -T);
      force.add(Fe);
      moment.add(_v3.copy(this.enginePos[i]).cross(Fe));
    }

    // body -> world
    const Fw = force.applyQuaternion(this.quat);
    Fw.y -= this.mass * G;
    const Mw = new THREE.Vector3();   // world-frame moments from gear, converted later

    // ---------- ground contact
    const omegaW = _v.copy(this.omega).applyQuaternion(this.quat);
    const fwdW = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quat);
    const fwdFlat = new THREE.Vector3(fwdW.x, 0, fwdW.z).normalize();
    const gs = Math.hypot(this.vel.x, this.vel.z);
    // nose-wheel steering: tiller at low speed, pedals at high speed
    const maxSteer = lerp(70, 7, smoothstep(4, 30, gs));
    this.steerDeg = clamp(ctl.rudder * maxSteer, -70, 70);
    let anyContact = false;
    const gearDownLocked = this.gearPos > 0.98;
    const vyBefore = this.vel.y;

    const contactAt = (pLocal, k, cDamp, opts) => {
      const r = _v2.copy(pLocal).applyQuaternion(this.quat);
      const px = this.pos.x + r.x, py = this.pos.y + r.y, pz = this.pos.z + r.z;
      const gh = groundHeight(px, pz);
      const depth = gh - py;
      if (depth <= 0) return null;
      const vp = new THREE.Vector3().copy(omegaW).cross(r).add(this.vel);
      let Fn = k * Math.min(depth, 1.2) - cDamp * vp.y;
      if (Fn < 0) Fn = 0;
      let dir = fwdFlat;
      if (opts.steer) dir = _v3.copy(fwdFlat).applyAxisAngle(UP, -this.steerDeg * D2R);
      const right = new THREE.Vector3(-dir.z, 0, dir.x);   // dir x up
      const vLong = vp.x * dir.x + vp.z * dir.z;
      const vLat = vp.x * right.x + vp.z * right.z;
      const surf = opts.hard ? 1 : this.surfaceMu;
      const muLat = (opts.muLat ?? 0.75) * (0.55 + 0.45 * surf);
      const Flat = -clamp(vLat * 5, -1, 1) * muLat * Fn;
      const brake = opts.brake ?? 0;
      const roll = opts.roll ?? 0.012;
      const Flong = -Math.tanh(vLong * 2.5) * (roll + brake * 0.55 * surf) * Fn;
      const F = new THREE.Vector3(0, Fn, 0).addScaledVector(dir, Flong).addScaledVector(right, Flat);
      Fw.add(F);
      Mw.add(new THREE.Vector3().copy(r).cross(F));
      return { depth, vLong, Fn, water: terrainHeight(px, pz) < 0 };
    };

    const brakeInput = ctl.parkingBrake ? 1 : ctl.brake;
    this.gearPoints.forEach((g, i) => {
      let res = null;
      if (gearDownLocked) res = contactAt(g.p, g.k, g.c, { steer: g.steer, brake: g.brake ? brakeInput : 0 });
      this.contact[i] = !!res;
      this.compression[i] = res ? Math.min(res.depth, 0.29) : 0;
      if (res) {
        anyContact = true;
        this.wheelOmega[i] = res.vLong / g.radius;
        if (res.water) this.crash('Suya indi (ditching)');
      } else {
        this.wheelOmega[i] *= (1 - 0.3 * dt);
        if (g.brake && this.gearPos < 1) this.wheelOmega[i] *= (1 - 3 * dt);
      }
      this.wheelSpin[i] += this.wheelOmega[i] * dt;
    });

    for (const hp of this.hardPoints) {
      const res = contactAt(hp.p, 3e6, 3e5, { muLat: 0.6, roll: 0.5, hard: true });
      if (res) {
        anyContact = true;
        if (hp.fatal) this.crash(hp.name === 'belly' ? 'Gövde üstü iniş — takımlar kapalıydı' : 'Çarpışma: ' + hp.label);
        else if (!this.tailStrike) { this.tailStrike = true; this.events.push('tailstrike'); }
      }
    }

    // touchdown detection
    if (anyContact && !this.onGround && this.airborneTime > 1.0) {
      const fpm = vyBefore * 60 * M2FT;
      this.lastTouchdownFpm = fpm;
      this.events.push('touchdown');
      if (fpm < -1000) this.crash(`Çok sert iniş (${fpm.toFixed(0)} fpm)`);
    }
    if (!anyContact) this.airborneTime += dt; else if (this.onGround) this.airborneTime = 0;
    this.onGround = anyContact;
    if (!anyContact) this.tailStrike = false;

    // terrain impact (fuselage CG below ground)
    if (this.pos.y < groundHeight(this.pos.x, this.pos.z) - 1) this.crash('Araziye çarptı');

    // ---------- integrate linear
    const acc = Fw.divideScalar(this.mass);
    this.nz = (lift / (this.mass * G));
    this.vel.addScaledVector(acc, dt);
    this.pos.addScaledVector(this.vel, dt);

    // ---------- integrate angular
    const Mb = Mw.applyQuaternion(_qi);
    moment.add(Mb);
    const I = this.I, w = this.omega;
    const Iw = _v2.set(I.x * w.x, I.y * w.y, I.z * w.z);
    const gyro = _v3.copy(w).cross(Iw);
    w.x += (moment.x - gyro.x) / I.x * dt;
    w.y += (moment.y - gyro.y) / I.y * dt;
    w.z += (moment.z - gyro.z) / I.z * dt;
    // tiny structural damping so a parked aircraft settles
    if (this.onGround) w.multiplyScalar(1 - 0.5 * dt);
    _q.set(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 1);
    this.quat.multiply(_q).normalize();
  }

  crash(reason) {
    if (this.crashed) return;
    this.crashed = true; this.crashReason = reason;
    this.events.push('crash');
  }

  consumeEvents() { const e = this.events; this.events = []; return e; }
}
