import { computeWarnings } from './warnings.js';

// Situational cabin & cockpit audio triggers with hysteresis, cooldowns, and alert priority.
const M2FT = 3.28084;
const MS2KT = 1.943844;
const VOICE_ALERTS = [
  ['PULL_UP', 'Pull up'],
  ['SINK_RATE', 'Sink rate'],
  ['TOO_LOW_GEAR', 'Too low, gear'],
  ['BANK_ANGLE', 'Bank angle'],
];

export class CabinAudio {
  constructor(sound) {
    this.sound = sound;
    this.reset();
  }

  reset() {
    this.t = 0;
    this.beltArmed = true;
    this.lastBelt = -1e9;
    this.altZone = null;          // 1 above 10200 ft, -1 below 9800 ft
    this.toPrepped = false;
    this.ldgPrepped = false;
    this.altAlertTarget = null;
    this.lastTargetAlt = null;
    this.prevAp = null;
    this.prevAt = null;
    this.lastVoice = -1e9;
    this.shakerOn = false;
    this.clackerOn = false;
  }

  update(dt, fm, ap) {
    if (!fm || fm.crashed) {
      if (this.shakerOn) { this.shakerOn = false; this.sound.setShaker(false); }
      if (this.clackerOn) { this.clackerOn = false; this.sound.setClacker(false); }
      return { shaker: false };
    }
    this.t += dt;
    const altFt = fm.pos.y * M2FT;
    const vsFpm = fm.vel.y * 60 * M2FT;
    const kt = fm.ias * MS2KT;
    const warns = computeWarnings(fm);
    const has = (id) => warns.some(w => w.id === id);

    // ---- priority: PULL_UP > STALL > OVERSPEED > GPWS voice > chimes
    const stall = has('STALL');
    const overspeed = has('OVERSPEED');
    if (stall !== this.shakerOn) { this.shakerOn = stall; this.sound.setShaker(stall); }
    if (overspeed !== this.clackerOn) { this.clackerOn = overspeed; this.sound.setClacker(overspeed); }

    let activeVoice = null;
    for (const [id, phrase] of VOICE_ALERTS) {
      if (has(id)) {
        if (id !== 'PULL_UP' && (stall || overspeed)) break;
        activeVoice = phrase;
        break;
      }
    }
    if (activeVoice && this.t - this.lastVoice >= 3.0) {
      this.lastVoice = this.t;
      this.sound.say(activeVoice, { priority: true });
    }

    // ---- A/P & A/T disconnect / re-engage
    const apOn = !!ap?.ap, atOn = !!ap?.at;
    if (this.prevAp === true && !apOn) this.sound.wailer(2);
    if (this.prevAp === false && apOn) this.sound.stopWailer?.();
    if (this.prevAt === true && !atOn) this.sound.atDisconnect();
    this.prevAp = apOn;
    this.prevAt = atOn;

    // ---- altitude alert C-chord (within 900 ft of active target altitude)
    const targetAlt = ap?.vnavTargetAlt ?? ap?.sel?.alt;
    if (ap && !fm.onGround && Number.isFinite(targetAlt)) {
      if (this.lastTargetAlt !== null && Math.abs(targetAlt - this.lastTargetAlt) >= 500) this.altAlertTarget = null;
      this.lastTargetAlt = targetAlt;
      const err = Math.abs(altFt - targetAlt);
      if (err > 1500 && this.altAlertTarget === targetAlt) this.altAlertTarget = null;
      if (err <= 900 && err > 250 && this.altAlertTarget !== targetAlt) {
        this.altAlertTarget = targetAlt;
        if (!activeVoice && !stall && !overspeed) this.sound.cChord();
      }
    }

    // ---- cloud entry / turbulence seatbelt chime ("dın-dın")
    if (fm.inCloud < 0.12) this.beltArmed = true;
    if (!fm.onGround && fm.inCloud > 0.3 && this.beltArmed && this.t - this.lastBelt >= 90) {
      this.beltArmed = false;
      this.lastBelt = this.t;
      if (!activeVoice) this.sound.seatbeltChime();
    }

    // ---- 10,000 ft transition chime (±200 ft hysteresis)
    const zone = altFt >= 10200 ? 1 : altFt <= 9800 ? -1 : this.altZone;
    if (this.altZone === null) {
      this.altZone = zone;
    } else if (zone !== null && zone !== this.altZone) {
      this.altZone = zone;
      if (!fm.onGround && !activeVoice) this.sound.chime(1);
    }

    // ---- takeoff & landing cabin preparation
    if (fm.onGround && !fm.ctl.parkingBrake && fm.ctl.throttle > 0.6 && !this.toPrepped) {
      this.toPrepped = true;
      if (!activeVoice) {
        this.sound.chime(2);
        this.sound.say('Cabin crew, prepare for take-off');
      }
    }
    if (fm.onGround && kt < 30 && fm.ctl.parkingBrake) {
      this.toPrepped = false;
      this.ldgPrepped = false;
    }
    if (!fm.onGround && altFt > 12000) this.ldgPrepped = false;
    if (!fm.onGround && vsFpm < -100 && altFt < 10000 && fm.ctl.gearDown && !this.ldgPrepped) {
      this.ldgPrepped = true;
      if (!activeVoice) {
        this.sound.chime(2);
        this.sound.say('Cabin crew, prepare for landing');
      }
    }

    return { shaker: this.shakerOn, warns };
  }
}
