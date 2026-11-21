// Procedural WebAudio sound: turbofan, wind, runway roll, rain, thunder, cabin chimes,
// Boeing-style A/P wailer, C-chord, stick shaker, overspeed clacker, gear/flap actuators, callouts.
const STORAGE_KEY = 'skyview.audio';
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function loadAudioPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      return {
        master: clamp(Number(raw.master ?? 0.7), 0, 1),
        engine: clamp(Number(raw.engine ?? 1), 0, 1),
        ambient: clamp(Number(raw.ambient ?? 1), 0, 1),
        alerts: clamp(Number(raw.alerts ?? 1), 0, 1),
        voice: clamp(Number(raw.voice ?? 1), 0, 1),
        muted: !!raw.muted,
      };
    }
  } catch { /* ignore */ }
  return { master: 0.7, engine: 1, ambient: 1, alerts: 1, voice: 1, muted: false };
}

export class Sound {
  constructor() {
    this.ctx = null;
    const prefs = loadAudioPrefs();
    this.volumes = { master: prefs.master, engine: prefs.engine, ambient: prefs.ambient, alerts: prefs.alerts, voice: prefs.voice };
    this.muted = prefs.muted;
    this.calls = new Set();
    this.lastRa = 1e9;
    this.listeners = [];
    this.wailerTimer = null;
    this.wailerNodes = null;
    this.shakerNodes = null;
    this.clackerTimer = null;
  }

  onChange(fn) { this.listeners.push(fn); }
  emit() { const s = this.getState(); this.listeners.forEach(f => f(s)); }
  save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.getState())); } catch { /* ignore */ } }
  getState() { return { ...this.volumes, muted: this.muted }; }
  getVolume(ch = 'master') { return this.volumes[ch] ?? 1; }

  setVolume(ch, val) {
    if (!(ch in this.volumes)) return 1;
    const v = clamp(Number(val) || 0, 0, 1);
    this.volumes[ch] = v;
    if (ch === 'master' && v > 0 && this.muted) this.muted = false;
    this.applyGains();
    this.save();
    this.emit();
    return v;
  }

  adjustMaster(delta) {
    const next = clamp(Math.round((this.volumes.master + delta) * 10) / 10, 0, 1);
    this.volumes.master = next;
    if (delta > 0 && this.muted) this.muted = false;
    this.applyGains();
    this.save();
    this.emit();
    return this.getState();
  }

  applyGains() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volumes.master, t, 0.02);
    this.engineBus.gain.setTargetAtTime(this.volumes.engine, t, 0.02);
    this.ambientBus.gain.setTargetAtTime(this.volumes.ambient, t, 0.02);
    this.alertsBus.gain.setTargetAtTime(this.volumes.alerts, t, 0.02);
  }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return; }
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volumes.master;
    this.master.connect(ctx.destination);

    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = this.volumes.engine;
    this.engineBus.connect(this.master);

    this.ambientBus = ctx.createGain();
    this.ambientBus.gain.value = this.volumes.ambient;
    this.ambientBus.connect(this.master);

    this.alertsBus = ctx.createGain();
    this.alertsBus.gain.value = this.volumes.alerts;
    this.alertsBus.connect(this.master);

    const noise = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const d = noise.getChannelData(0);
    let b = 0;
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; b = 0.97 * b + 0.03 * w; d[i] = w * 0.5 + b * 3; }
    const src = (rate = 1) => { const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true; s.playbackRate.value = rate; s.start(); return s; };

    // engine rumble
    this.rumbleF = ctx.createBiquadFilter(); this.rumbleF.type = 'lowpass'; this.rumbleF.frequency.value = 300;
    this.rumbleG = ctx.createGain(); this.rumbleG.gain.value = 0;
    src(1).connect(this.rumbleF).connect(this.rumbleG).connect(this.engineBus);
    // fan whine (two detuned tones through bandpass)
    this.fanG = ctx.createGain(); this.fanG.gain.value = 0;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3; bp.frequency.value = 1500; this.fanBP = bp;
    this.fanOsc = [0, 1].map(i => { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 400 + i * 7; o.connect(bp); o.start(); return o; });
    bp.connect(this.fanG).connect(this.engineBus);
    // jet hiss
    this.hissF = ctx.createBiquadFilter(); this.hissF.type = 'bandpass'; this.hissF.frequency.value = 2500; this.hissF.Q.value = 0.7;
    this.hissG = ctx.createGain(); this.hissG.gain.value = 0;
    src(1.3).connect(this.hissF).connect(this.hissG).connect(this.engineBus);
    // wind (routed to exterior ambient bus)
    this.windF = ctx.createBiquadFilter(); this.windF.type = 'bandpass'; this.windF.Q.value = 0.5; this.windF.frequency.value = 600;
    this.windG = ctx.createGain(); this.windG.gain.value = 0;
    src(0.8).connect(this.windF).connect(this.windG).connect(this.ambientBus);
    // runway rumble
    this.rollF = ctx.createBiquadFilter(); this.rollF.type = 'lowpass'; this.rollF.frequency.value = 120;
    this.rollG = ctx.createGain(); this.rollG.gain.value = 0;
    src(0.6).connect(this.rollF).connect(this.rollG).connect(this.engineBus);
    this.noiseSrc = src;
  }

  /** Rain hiss on the airframe (0..~1.6). */
  setRain(k) {
    if (!this.ctx) return;
    if (!this.rainG) {
      const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1800;
      this.rainG = this.ctx.createGain(); this.rainG.gain.value = 0;
      this.noiseSrc(1.7).connect(f).connect(this.rainG).connect(this.ambientBus);
    }
    this.rainG.gain.setTargetAtTime(Math.min(0.35, k * 0.22), this.ctx.currentTime, 0.4);
  }

  /** Thunder: delayed by the speed of sound, deeper and quieter with distance. */
  thunder(distM) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime + Math.min(distM / 340, 25);
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf || (this.noiseBuf = (() => {
      const b = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate), d = b.getChannelData(0);
      let v = 0; for (let i = 0; i < d.length; i++) { v = 0.985 * v + 0.015 * (Math.random() * 2 - 1); d[i] = v * 6; }
      return b;
    })());
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = Math.max(90, 600 - distM / 60);
    const g = ctx.createGain(); const peak = Math.max(0.08, 1.2 - distM / 25000);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.08 + distM / 40000);
    g.gain.exponentialRampToValueAtTime(peak * 0.5, t + 0.9); g.gain.exponentialRampToValueAtTime(0.0001, t + 3.8);
    src.connect(f).connect(g).connect(this.ambientBus); src.start(t); src.stop(t + 4);
  }

  toggleMute() {
    this.muted = !this.muted;
    this.applyGains();
    if (this.muted && window.speechSynthesis) speechSynthesis.cancel();
    this.save();
    this.emit();
    return this.muted;
  }

  thump(strength = 1) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.25);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.6 * strength, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g).connect(this.engineBus); o.start(t); o.stop(t + 0.4);
  }

  tone(freq, startOffset, dur, peak = 0.18, type = 'sine') {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime + startOffset;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.alertsBus);
    o.start(t); o.stop(t + dur + 0.03);
  }

  /** Cabin seatbelt two-tone "dın-dın" (high-low chime). */
  seatbeltChime() {
    if (!this.ctx || this.muted) return;
    this.tone(784, 0, 0.42, 0.2, 'sine');
    this.tone(1568, 0, 0.22, 0.04, 'sine');
    this.tone(587.33, 0.28, 0.55, 0.2, 'sine');
    this.tone(1174.66, 0.28, 0.28, 0.04, 'sine');
  }

  /** Single or double cabin chime. */
  chime(count = 1) {
    if (!this.ctx || this.muted) return;
    for (let i = 0; i < count; i++) {
      this.tone(784, i * 0.3, 0.45, 0.18, 'sine');
      this.tone(1568, i * 0.3, 0.22, 0.035, 'sine');
    }
  }

  /** Boeing altitude-alert C-chord. */
  cChord() {
    if (!this.ctx || this.muted) return;
    [523.25, 659.25, 783.99].forEach(f => this.tone(f, 0, 0.6, 0.11, 'triangle'));
  }

  /** Boeing autopilot disconnect warble siren. */
  wailer(sec = 2) {
    this.stopWailer();
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1800;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    g.gain.setValueAtTime(0.16, t + sec - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + sec);
    const steps = Math.max(1, Math.floor(sec * 6));
    for (let i = 0; i < steps; i++) o.frequency.setValueAtTime(i % 2 === 0 ? 740 : 540, t + i / 6);
    o.connect(f).connect(g).connect(this.alertsBus);
    o.start(t); o.stop(t + sec + 0.03);
    this.wailerNodes = { o, g };
    this.wailerTimer = setTimeout(() => { this.wailerNodes = null; this.wailerTimer = null; }, sec * 1000);
  }

  stopWailer() {
    if (this.wailerTimer) { clearTimeout(this.wailerTimer); this.wailerTimer = null; }
    if (this.wailerNodes && this.ctx) {
      try {
        this.wailerNodes.g.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.01);
        this.wailerNodes.o.stop(this.ctx.currentTime + 0.05);
      } catch { /* already stopped */ }
      this.wailerNodes = null;
    }
  }

  atDisconnect() {
    if (!this.ctx || this.muted) return;
    this.tone(880, 0, 0.11, 0.14, 'square');
    this.tone(880, 0.15, 0.11, 0.14, 'square');
  }

  setShaker(on) {
    if (!this.ctx) return;
    if (on && !this.shakerNodes) {
      const ctx = this.ctx;
      const src = this.noiseSrc(0.45);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 140; bp.Q.value = 2.5;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 24;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.25;
      const g = ctx.createGain(); g.gain.value = 0.28;
      lfo.connect(lfoG).connect(g.gain);
      src.connect(bp).connect(g).connect(this.alertsBus);
      lfo.start();
      this.shakerNodes = { src, lfo, g };
    } else if (!on && this.shakerNodes) {
      try { this.shakerNodes.src.stop(); this.shakerNodes.lfo.stop(); } catch { /* ignore */ }
      this.shakerNodes = null;
    }
  }

  setClacker(on) {
    if (on && !this.clackerTimer) {
      const click = () => {
        if (!this.ctx || this.muted) return;
        this.tone(1850, 0, 0.035, 0.22, 'square');
      };
      click();
      this.clackerTimer = setInterval(click, 165);
    } else if (!on && this.clackerTimer) {
      clearInterval(this.clackerTimer);
      this.clackerTimer = null;
    }
  }

  gearSound(down) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(down ? 175 : 130, t);
    o.frequency.linearRampToValueAtTime(down ? 120 : 195, t + 0.85);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.11, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(f).connect(g).connect(this.alertsBus);
    o.start(t); o.stop(t + 0.95);
    this.tone(down ? 72 : 95, 0.82, 0.16, 0.22, 'triangle');
  }

  flapSound() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(290, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    o.connect(g).connect(this.alertsBus);
    o.start(t); o.stop(t + 0.45);
  }

  say(text) {
    if (this.muted || !window.speechSynthesis) return;
    const vol = clamp(this.volumes.master * this.volumes.voice, 0, 1);
    if (vol <= 0.01) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US'; u.rate = 1.1; u.pitch = 0.8; u.volume = vol;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }

  update(fm, camMode, camDist) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, k = 0.08;
    const n1 = fm.n1.reduce((a, b) => a + b, 0) / (100 * fm.n1.length);
    const inside = camMode === 1 || camMode === 2;
    const distAtt = inside ? 0.35 : Math.min(1, 60 / Math.max(camDist, 20));
    const set = (p, v) => p.setTargetAtTime(v, t, k);
    if (fm.crashed) {
      [this.rumbleG, this.fanG, this.hissG, this.windG, this.rollG].forEach(g => set(g.gain, 0));
      this.setShaker(false); this.setClacker(false);
      return;
    }
    set(this.rumbleG.gain, (0.12 + n1 * 0.55) * distAtt * (inside ? 1.4 : 1));
    set(this.rumbleF.frequency, 180 + n1 * 900);
    set(this.fanG.gain, (0.012 + n1 * n1 * 0.05) * distAtt);
    this.fanOsc.forEach((o, i) => set(o.frequency, 260 + n1 * 2300 + i * 9));
    set(this.fanBP.frequency, 600 + n1 * 3000);
    set(this.hissG.gain, Math.pow(n1, 3) * 0.35 * distAtt);
    const v = fm.tas / 130;
    set(this.windG.gain, Math.min(0.5, v * v * 0.18) * (inside ? 0.6 : 1));
    set(this.windF.frequency, 300 + v * 900);
    const gs = Math.hypot(fm.vel.x, fm.vel.z);
    set(this.rollG.gain, fm.onGround ? Math.min(0.5, gs / 60) * 0.6 : 0);
    set(this.rollF.frequency, 60 + gs * 3);

    // callouts
    const kt = fm.ias * 1.943844;
    const ra = fm.agl * 3.28084;
    const once = (key, txt) => { if (!this.calls.has(key)) { this.calls.add(key); this.say(txt); } };
    if (fm.onGround && fm.vel.dot(new (fm.vel.constructor)(0, 0, -1).applyQuaternion(fm.quat)) > 0) {
      if (kt > 80 && fm.ctl.throttle > 0.6) once('80', 'eighty knots');
      if (kt > 140 * (fm.speedScale || 1) && fm.ctl.throttle > 0.6) once('v1', 'V one');
      if (kt > 148 * (fm.speedScale || 1) && fm.ctl.throttle > 0.6) once('vr', 'rotate');
    }
    if (!fm.onGround && fm.vel.y < -0.5) {
      for (const h of [1000, 500, 100, 50, 40, 30, 20, 10]) {
        if (this.lastRa > h && ra <= h) { this.calls.delete('ra' + h); once('ra' + h, h === 1000 ? 'one thousand' : h === 500 ? 'five hundred' : String(h)); }
      }
    }
    if (fm.onGround && kt < 40) { this.calls.delete('80'); this.calls.delete('v1'); this.calls.delete('vr'); }
    this.lastRa = ra;
  }
}
