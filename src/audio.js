// Procedural WebAudio sound: turbofan (rumble + fan tone + buzz), wind, runway rumble, thumps, callouts.
export class Sound {
  constructor() { this.ctx = null; this.muted = false; this.calls = new Set(); this.lastRa = 1e9; }

  init() {
    if (this.ctx) return;
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = ctx.createGain(); this.master.gain.value = 0.7; this.master.connect(ctx.destination);
    const noise = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const d = noise.getChannelData(0);
    let b = 0;
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; b = 0.97 * b + 0.03 * w; d[i] = w * 0.5 + b * 3; }
    const src = (rate = 1) => { const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true; s.playbackRate.value = rate; s.start(); return s; };

    // engine rumble
    this.rumbleF = ctx.createBiquadFilter(); this.rumbleF.type = 'lowpass'; this.rumbleF.frequency.value = 300;
    this.rumbleG = ctx.createGain(); this.rumbleG.gain.value = 0;
    src(1).connect(this.rumbleF).connect(this.rumbleG).connect(this.master);
    // fan whine (two detuned tones through bandpass)
    this.fanG = ctx.createGain(); this.fanG.gain.value = 0;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3; bp.frequency.value = 1500; this.fanBP = bp;
    this.fanOsc = [0, 1].map(i => { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 400 + i * 7; o.connect(bp); o.start(); return o; });
    bp.connect(this.fanG).connect(this.master);
    // jet hiss
    this.hissF = ctx.createBiquadFilter(); this.hissF.type = 'bandpass'; this.hissF.frequency.value = 2500; this.hissF.Q.value = 0.7;
    this.hissG = ctx.createGain(); this.hissG.gain.value = 0;
    src(1.3).connect(this.hissF).connect(this.hissG).connect(this.master);
    // wind
    this.windF = ctx.createBiquadFilter(); this.windF.type = 'bandpass'; this.windF.Q.value = 0.5; this.windF.frequency.value = 600;
    this.windG = ctx.createGain(); this.windG.gain.value = 0;
    src(0.8).connect(this.windF).connect(this.windG).connect(this.master);
    // runway rumble
    this.rollF = ctx.createBiquadFilter(); this.rollF.type = 'lowpass'; this.rollF.frequency.value = 120;
    this.rollG = ctx.createGain(); this.rollG.gain.value = 0;
    src(0.6).connect(this.rollF).connect(this.rollG).connect(this.master);
    this.noiseSrc = src;
  }

  /** Rain hiss on the airframe (0..~1.6). */
  setRain(k) {
    if (!this.ctx) return;
    if (!this.rainG) {
      const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1800;
      this.rainG = this.ctx.createGain(); this.rainG.gain.value = 0;
      this.noiseSrc(1.7).connect(f).connect(this.rainG).connect(this.master);
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
    src.connect(f).connect(g).connect(this.master); src.start(t); src.stop(t + 4);
  }

  toggleMute() { this.muted = !this.muted; if (this.master) this.master.gain.value = this.muted ? 0 : 0.7; return this.muted; }

  thump(strength = 1) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.25);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.6 * strength, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.4);
  }

  say(text) {
    if (this.muted || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US'; u.rate = 1.1; u.pitch = 0.8; u.volume = 0.9;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }

  update(fm, camMode, camDist) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, k = 0.08;
    const n1 = fm.n1.reduce((a, b) => a + b, 0) / (100 * fm.n1.length);
    const inside = camMode === 1 || camMode === 2;
    const distAtt = inside ? 0.35 : Math.min(1, 60 / Math.max(camDist, 20));
    const set = (p, v) => p.setTargetAtTime(v, t, k);
    if (fm.crashed) { [this.rumbleG, this.fanG, this.hissG, this.windG, this.rollG].forEach(g => set(g.gain, 0)); return; }
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
