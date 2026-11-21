// Pure holding-pattern geometry + ATC Tower clearance state machine + side-edge radio panel.

const D2R = Math.PI / 180;
const M2FT = 3.28084;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * Generates a standard aviation racetrack holding pattern in local metres (x east, -z north).
 * Right-hand turns by default: outbound turn at fix, parallel outbound leg, inbound turn, inbound leg back to fix.
 */
export function buildHoldingPattern({ fixX, fixZ, inboundHdg, altFt, legLenM = 5200, turnRadiusM = 1700, rightTurns = true, lapsRequired = 2 }) {
  const dir = rightTurns ? 1 : -1;
  const h = inboundHdg * D2R;
  // unit vector along inbound course (toward fix)
  const ux = Math.sin(h), uz = -Math.cos(h);
  // unit vector perpendicular (right of inbound course)
  const rx = Math.cos(h) * dir, rz = Math.sin(h) * dir;

  // Racetrack center of Turn 1 (at fix) and Turn 2 (outbound end)
  const c1x = fixX + rx * turnRadiusM, c1z = fixZ + rz * turnRadiusM;
  const c2x = c1x - ux * legLenM, c2z = c1z - uz * legLenM;

  const points = [];
  // Semicircle 1: from fix around to outbound leg (9 points)
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * Math.PI;
    // at a=0: -r (fix); at a=pi/2: +u (ahead of fix); at a=pi: +r (outbound side)
    const px = c1x + (-Math.cos(a) * rx + Math.sin(a) * ux) * turnRadiusM;
    const pz = c1z + (-Math.cos(a) * rz + Math.sin(a) * uz) * turnRadiusM;
    points.push({ x: px, z: pz });
  }
  // Semicircle 2: outbound end turning back onto inbound leg (9 points)
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * Math.PI;
    // at a=0: +r (outbound end); at a=pi/2: -u (far end); at a=pi: -r (inbound entry)
    const px = c2x + (Math.cos(a) * rx - Math.sin(a) * ux) * turnRadiusM;
    const pz = c2z + (Math.cos(a) * rz - Math.sin(a) * uz) * turnRadiusM;
    points.push({ x: px, z: pz });
  }

  return {
    fixX, fixZ,
    inboundHdg: ((inboundHdg % 360) + 360) % 360,
    outboundHdg: ((inboundHdg + 180) % 360 + 360) % 360,
    altFt: Math.round(altFt / 100) * 100,
    legLenM, turnRadiusM, rightTurns,
    lapsRequired,
    lapsDone: 0,
    wpIndex: 0,
    entered: false,
    points,
  };
}

/**
 * Advances holding-pattern tracking and returns { desiredTrack, distToFixM, lapCompleted, finished }.
 */
export function updateHolding(hold, pos) {
  const pts = hold.points;
  const n = pts.length;
  const tgt = pts[hold.wpIndex];
  const dx = tgt.x - pos.x, dz = tgt.z - pos.z;
  const dist = Math.hypot(dx, dz);
  let lapCompleted = false;

  if (dist < 1100) {
    const prev = hold.wpIndex;
    hold.wpIndex = (hold.wpIndex + 1) % n;
    if (prev === 0 && !hold.entered) {
      hold.entered = true;
    } else if (hold.wpIndex === 0 && hold.entered) {
      hold.lapsDone++;
      lapCompleted = true;
    }
  }
  const cur = pts[hold.wpIndex];
  const desiredTrack = (Math.atan2(cur.x - pos.x, -(cur.z - pos.z)) / D2R + 360) % 360;
  const distToFixM = Math.hypot(hold.fixX - pos.x, hold.fixZ - pos.z);
  return {
    desiredTrack,
    distToFixM,
    lapCompleted,
    finished: hold.lapsDone >= hold.lapsRequired,
  };
}

const CSS = `
#atc { position: fixed; top: 362px; right: 16px; z-index: 6; width: 276px; font-family: "Segoe UI", system-ui, sans-serif;
  background: rgba(6,10,16,0.88); border: 1px solid rgba(140,170,210,0.35); border-radius: 10px;
  color: #e8f1ff; box-shadow: 0 10px 28px rgba(0,0,0,0.5); user-select: none; overflow: hidden; }
#atc.collapsed .atc-body { display: none; }
#atc .atc-head { display: flex; align-items: center; gap: 6px; padding: 6px 10px; background: rgba(255,255,255,0.04);
  border-bottom: 1px solid rgba(255,255,255,0.08); }
#atc .atc-grip { width: 14px; font-size: 12px; }
#atc .atc-title { font: 700 11px Consolas, monospace; letter-spacing: 0.9px; color: #31d0ff; }
#atc .atc-freq { margin-left: auto; font: 10.5px Consolas, monospace; color: #8fa3bf; }
#atc .atc-min { background: none; border: 1px solid rgba(255,255,255,0.18); color: #c9d6e5; border-radius: 5px; width: 22px; height: 20px; cursor: pointer; font: bold 11px Consolas, monospace; padding: 0; }
#atc .atc-body { padding: 9px 10px; display: flex; flex-direction: column; gap: 7px; }
#atc .atc-badge { padding: 5px 8px; border-radius: 6px; font: 700 11px Consolas, monospace; text-align: center;
  background: rgba(255,190,59,0.14); border: 1px solid rgba(255,190,59,0.45); color: #ffbe3b; }
#atc .atc-badge.green { background: rgba(60,240,122,0.14); border-color: rgba(60,240,122,0.5); color: #3cf07a; }
#atc .atc-badge.cyan { background: rgba(49,208,255,0.14); border-color: rgba(49,208,255,0.45); color: #31d0ff; }
#atc .atc-badge.red { background: rgba(255,59,48,0.16); border-color: rgba(255,59,48,0.55); color: #ff6b6b; }
#atc .atc-btns { display: grid; grid-template-columns: 1fr; gap: 5px; }
#atc button.atc-btn { padding: 6px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.07);
  color: #ecf3ff; font: 600 11.5px "Segoe UI", sans-serif; cursor: pointer; text-align: center; }
#atc button.atc-btn:hover { border-color: #31d0ff; color: #31d0ff; }
#atc button.atc-btn.pri { background: rgba(49,208,255,0.18); border-color: rgba(49,208,255,0.55); color: #9fe6ff; }
#atc button.atc-btn.hold { background: rgba(255,190,59,0.18); border-color: rgba(255,190,59,0.55); color: #ffd27d; }
#atc button.atc-btn.on { border-color: #3cf07a; color: #3cf07a; background: rgba(60,240,122,0.12); }
#atc .atc-log { font: 10.5px/1.35 Consolas, monospace; color: #b8c9de; background: rgba(0,0,0,0.32); border-radius: 6px;
  padding: 6px 7px; max-height: 76px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.07); }
#atc .atc-log div { margin-bottom: 3px; }
#atc .atc-log div:last-child { margin-bottom: 0; }
#atc .atc-row { display: flex; gap: 5px; }
#atc .atc-row button { flex: 1; }
`;

export class ATCPanel {
  constructor({ world, fm, ap, sound, hud, minimap, traffic }) {
    this.world = world; this.fm = fm; this.ap = ap; this.sound = sound;
    this.hud = hud; this.minimap = minimap; this.traffic = traffic;

    if (!document.getElementById('atc-style')) {
      const st = document.createElement('style'); st.id = 'atc-style'; st.textContent = CSS; document.head.appendChild(st);
    }

    this.state = 'IDLE'; // IDLE | HOLD_SHORT | CLEARED_TO | AIRBORNE | HOLDING | CLEARED_LAND
    this.hold = null;
    this.waitTimer = 0;
    this.warnedRoll = false;
    this.logs = [];
    this.lastGround = null;

    const el = this.el = document.createElement('div');
    el.id = 'atc';
    el.innerHTML = `
      <div class="atc-head">
        <span class="atc-grip">⋮⋮</span>
        <span class="atc-title">ATC · KULE</span>
        <span class="atc-freq">118.10 MHz</span>
        <button class="atc-min" data-a="min" title="Küçült / aç [F5]">−</button>
      </div>
      <div class="atc-body">
        <div class="atc-badge" data-s="badge">KULE HAZIR</div>
        <div class="atc-btns" data-s="btns"></div>
        <div class="atc-log" data-s="log"></div>
        <div class="atc-row">
          <button class="atc-btn" data-a="traffic" title="Yapay zeka hava trafiğini aç/kapa [F6]">Trafik: AÇIK</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    ['pointerdown', 'wheel', 'dblclick', 'keydown', 'keyup'].forEach(ev => el.addEventListener(ev, e => e.stopPropagation()));
    el.querySelector('[data-a="min"]').onclick = () => this.toggleCollapse();
    el.querySelector('[data-a="traffic"]').onclick = () => this.toggleTraffic();

    this.reset();
  }

  toggleCollapse() {
    this.el.classList.toggle('collapsed');
    this.el.querySelector('[data-a="min"]').textContent = this.el.classList.contains('collapsed') ? '+' : '−';
  }

  toggleTraffic() {
    if (!this.traffic) return;
    const on = this.traffic.toggle();
    this.hud?.message(on ? 'HAVA TRAFİĞİ AÇIK' : 'HAVA TRAFİĞİ KAPALI (performans)', on ? 'cyan' : 'white', 2.5);
    this.render();
  }

  log(msg, speak = null) {
    this.logs.unshift(msg);
    if (this.logs.length > 5) this.logs.pop();
    if (speak) this.sound?.say(speak);
    this.render();
  }

  rwyName() {
    if (this.ap?.route?.route?.destRunway) return `RWY ${this.ap.route.route.destRunway.id}`;
    const m = this.world?.spawn?.name?.match(/RWY\s+(\S+)/);
    return m ? `RWY ${m[1]}` : 'RWY';
  }

  reset() {
    this.hold = null;
    this.ap?.clearHold?.();
    this.minimap?.setHoldingPattern?.(null);
    this.warnedRoll = false;
    this.waitTimer = 0;
    this.state = this.fm?.onGround ? 'IDLE' : 'AIRBORNE';
    this.logs = [this.fm?.onGround ? 'KULE: Kalkış için izin iste.' : 'KULE: Yaklaşmada iniş izni iste.'];
    this.render();
  }

  requestTakeoff() {
    const rw = this.rwyName();
    const occ = this.traffic?.runwayOccupant?.();
    if (occ) {
      this.state = 'HOLD_SHORT';
      this.waitTimer = 8;
      this.log(`KULE: ${rw} HOLD SHORT · ${occ} PİSTTE`, `Hold short runway ${rw.replace('RWY ', '')}, traffic on runway`);
      this.hud?.message(`KULE: HOLD SHORT · ${occ} PİSTTE`, 'amber', 4);
      return;
    }
    this.grantTakeoff();
  }

  grantTakeoff() {
    const rw = this.rwyName();
    const w = this.fm ? `${String(this.fm.windFrom).padStart(3, '0')}°/${this.fm.windKts}kt` : '';
    this.state = 'CLEARED_TO';
    this.log(`KULE: ${rw} KALKIŞ İZNİ VERİLDİ · Rüzgâr ${w}`, `Cleared for takeoff runway ${rw.replace('RWY ', '')}`);
    this.hud?.message(`KULE: ${rw} CLEARED FOR TAKEOFF`, 'green', 4.5);
  }

  requestLanding(forceHold = false) {
    const rw = this.rwyName();
    const occ = this.traffic?.runwayOccupant?.();
    // Send to holding pattern if traffic occupies runway, or ~50% realistic busy flow, or explicit hold request
    const busy = forceHold || !!occ || Math.random() < 0.5;
    if (busy) {
      const laps = Math.random() < 0.5 ? 1 : 2;
      const r = this.ap?.runway;
      const hdg = r ? r.heading : (this.fm?.heading || 0);
      const dx = Math.sin(hdg * D2R), dz = -Math.cos(hdg * D2R);
      // Place holding fix 11 km ahead of runway threshold (or 5 km ahead of aircraft in free flight)
      const fixX = r ? r.x - dx * 11000 : this.fm.pos.x + dx * 5000;
      const fixZ = r ? r.z - dz * 11000 : this.fm.pos.z + dz * 5000;
      const baseAlt = r ? (r.elev * M2FT + 2500) : Math.max(3000, this.fm.pos.y * M2FT);
      const holdAlt = Math.max(Math.round(baseAlt / 500) * 500, Math.round((this.fm.pos.y * M2FT) / 500) * 500);
      this.hold = buildHoldingPattern({ fixX, fixZ, inboundHdg: hdg, altFt: clamp(holdAlt, 2500, 12000), lapsRequired: laps });
      this.state = 'HOLDING';
      this.minimap?.setHoldingPattern?.(this.hold);
      const why = occ ? `${occ} PİSTTE` : 'TRAFİK YOĞUN';
      this.log(`KULE: ${why} · BEKLEME PATERNİ (${laps} TUR · ${this.hold.altFt} ft)`,
        `Runway busy, enter holding pattern, maintain ${this.hold.altFt} feet, ${laps} ${laps > 1 ? 'turns' : 'turn'}`);
      this.hud?.message(`KULE: BEKLEME PATERNİNE GİR · ${laps} TUR · ${this.hold.altFt} ft`, 'amber', 5);
      return;
    }
    this.grantLanding();
  }

  grantLanding() {
    const rw = this.rwyName();
    this.hold = null;
    this.ap?.clearHold?.();
    this.minimap?.setHoldingPattern?.(null);
    this.state = 'CLEARED_LAND';
    const w = this.fm ? `${String(this.fm.windFrom).padStart(3, '0')}°/${this.fm.windKts}kt` : '';
    this.log(`KULE: ${rw} İNİŞ İZNİ VERİLDİ · Rüzgâr ${w}`, `Cleared to land runway ${rw.replace('RWY ', '')}`);
    this.hud?.message(`KULE: ${rw} CLEARED TO LAND`, 'green', 5);
  }

  engageHoldAP() {
    if (!this.hold || !this.ap) return;
    this.ap.setHold(this.hold);
    this.hud?.message(`OTOPİLOT: BEKLEME PATERNİ (${this.hold.altFt} ft)`, 'cyan', 3);
    this.render();
  }

  update(dt) {
    if (!this.fm) return;
    const onGnd = this.fm.onGround;
    if (this.lastGround !== null && this.lastGround !== onGnd) {
      if (!onGnd && this.state === 'CLEARED_TO') {
        this.state = 'AIRBORNE';
        this.log('KULE: İyi uçuşlar, yaklaşmada tekrar ulaş.');
      } else if (!onGnd && (this.state === 'IDLE' || this.state === 'HOLD_SHORT') && !this.warnedRoll) {
        this.warnedRoll = true;
        this.state = 'AIRBORNE';
        this.log('KULE: İZİNSİZ KALKIŞ RAPOR EDİLDİ!', 'Warning, unauthorized takeoff');
        this.hud?.message('KULE: İZİNSİZ KALKIŞ!', 'red', 4);
      } else if (onGnd && this.state === 'CLEARED_LAND') {
        this.state = 'IDLE';
        this.log('KULE: İniş tamamlandı, hoş geldiniz.');
      }
      this.render();
    }
    this.lastGround = onGnd;

    // Auto-clear HOLD_SHORT once runway traffic vacates
    if (this.state === 'HOLD_SHORT') {
      this.waitTimer -= dt;
      if (this.waitTimer <= 0 && !this.traffic?.runwayOccupant?.()) this.grantTakeoff();
    }

    // Track holding pattern laps (both manual and autopilot!)
    if (this.state === 'HOLDING' && this.hold) {
      const res = updateHolding(this.hold, this.fm.pos);
      if (res.lapCompleted) {
        if (res.finished) {
          this.grantLanding();
        } else {
          this.log(`KULE: TUR ${this.hold.lapsDone}/${this.hold.lapsRequired} TAMAMLANDI · DEVAM ET`);
          this.hud?.message(`BEKLEME PATERNİ: TUR ${this.hold.lapsDone}/${this.hold.lapsRequired}`, 'cyan', 3);
        }
      }
    }
  }

  render() {
    const badge = this.el.querySelector('[data-s="badge"]');
    const btns = this.el.querySelector('[data-s="btns"]');
    const log = this.el.querySelector('[data-s="log"]');
    const trBtn = this.el.querySelector('[data-a="traffic"]');

    const map = {
      IDLE: ['KALKIŞ İZNİ BEKLENİYOR', ''],
      HOLD_SHORT: ['HOLD SHORT · PİST MEŞGUL', 'red'],
      CLEARED_TO: ['✓ KALKIŞ İZNİ VERİLDİ', 'green'],
      AIRBORNE: ['SEYRÜSEFER · İNİŞ İZNİ İSTE', 'cyan'],
      HOLDING: [`BEKLEME PATERNİ · TUR ${this.hold?.lapsDone || 0}/${this.hold?.lapsRequired || 2} · ${this.hold?.altFt || ''} ft`, ''],
      CLEARED_LAND: ['✓ İNİŞ İZNİ VERİLDİ', 'green'],
    };
    const [txt, cls] = map[this.state] || ['KULE HAZIR', ''];
    badge.textContent = txt;
    badge.className = 'atc-badge' + (cls ? ' ' + cls : '');

    let html = '';
    if (this.fm?.onGround) {
      if (this.state === 'IDLE') html = `<button class="atc-btn pri" data-act="to">Kalkış İzni İste</button>`;
    } else if (this.state === 'HOLDING') {
      html = `
        <button class="atc-btn hold" data-act="aphold">${this.ap?.lat === 'HOLD' ? '✓ Otopilot Paternde' : 'Paternde Otopilotla Uç (HOLD)'}</button>
        <button class="atc-btn" data-act="landnow">Acil / Direkt İniş İzni İste</button>`;
    } else if (this.state !== 'CLEARED_LAND') {
      html = `<button class="atc-btn pri" data-act="land">İniş İzni İste</button>`;
    }
    btns.innerHTML = html;
    btns.querySelector('[data-act="to"]')?.addEventListener('click', () => this.requestTakeoff());
    btns.querySelector('[data-act="land"]')?.addEventListener('click', () => this.requestLanding(false));
    btns.querySelector('[data-act="aphold"]')?.addEventListener('click', () => this.engageHoldAP());
    btns.querySelector('[data-act="landnow"]')?.addEventListener('click', () => this.grantLanding());

    log.innerHTML = this.logs.map(l => `<div>${l}</div>`).join('');
    if (this.traffic && trBtn) {
      trBtn.textContent = `Hava Trafiği: ${this.traffic.enabled ? 'AÇIK' : 'KAPALI'}`;
      trBtn.classList.toggle('on', this.traffic.enabled);
    }
  }
}
