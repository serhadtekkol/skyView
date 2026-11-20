import {
  buildRoute, validate, parseWaypoint, parseAltConstraint, gcDistanceNm, gcBearing, todDistanceNm, ActiveRoute,
} from './flightplan.js';

const STORAGE_KEY = 'skyview.fpl';
const norm = (s) => String(s ?? '').toLocaleLowerCase('tr').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clone = (v) => JSON.parse(JSON.stringify(v));

const CSS = `
#fms { position: fixed; top: 58px; left: 16px; width: 390px; max-width: calc(100vw - 32px); max-height: calc(100vh - 110px); z-index: 8;
  display: none; flex-direction: column; border-radius: 10px; background: rgba(10, 16, 26, 0.94);
  border: 1px solid rgba(140, 175, 220, 0.35); box-shadow: 0 16px 40px rgba(0,0,0,0.6);
  color: #e8f1ff; font: 12px "Segoe UI", system-ui, sans-serif; user-select: none; }
#fms.open { display: flex; }
#fms .fms-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.04); border-radius: 10px 10px 0 0; }
#fms .fms-grip { width: 16px; }
#fms .fms-title { font: bold 13px Consolas, monospace; letter-spacing: 0.8px; color: #31d0ff; }
#fms .fms-mod { font: bold 10px Consolas, monospace; padding: 2px 6px; border-radius: 4px; background: rgba(255,176,32,0.18); color: #ffb020; display: none; }
#fms .fms-mod.on { display: inline-block; }
#fms .fms-close { margin-left: auto; background: transparent; border: 0; color: #8fa3bf; font-size: 16px; cursor: pointer; padding: 0 4px; }
#fms .fms-close:hover { color: #fff; }
#fms .fms-tabs { display: flex; border-bottom: 1px solid rgba(255,255,255,0.1); }
#fms .fms-tabs button { flex: 1; padding: 7px 6px; border: 0; background: transparent; color: #8fa3bf; font: bold 11px Consolas, monospace; cursor: pointer; }
#fms .fms-tabs button.on { color: #31d0ff; border-bottom: 2px solid #31d0ff; background: rgba(49,208,255,0.08); }
#fms .fms-body { padding: 10px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 8px; }
#fms .fms-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; color: #8fa3bf; margin-top: 2px; }
#fms input, #fms select { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.18); background: rgba(0,0,0,0.45); color: #e8f1ff; font: 12px Consolas, monospace; outline: none; }
#fms input:focus, #fms select:focus { border-color: #31d0ff; }
#fms .fms-search { position: relative; }
#fms .fms-hits { position: absolute; left: 0; right: 0; top: 100%; margin: 2px 0 0; padding: 0; list-style: none; z-index: 20;
  background: #0d1626; border: 1px solid rgba(255,255,255,0.18); border-radius: 6px; max-height: 160px; overflow-y: auto; }
#fms .fms-hits li { padding: 6px 8px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.06); }
#fms .fms-hits li:hover { background: rgba(49,208,255,0.18); }
#fms .fms-row { display: flex; gap: 6px; align-items: center; }
#fms .fms-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
#fms .fms-btn { padding: 6px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.08);
  color: #e8f1ff; font: bold 11px "Segoe UI", sans-serif; cursor: pointer; white-space: nowrap; }
#fms .fms-btn:hover:not(:disabled) { border-color: #31d0ff; color: #31d0ff; }
#fms .fms-btn:disabled { opacity: 0.4; cursor: default; }
#fms .fms-btn.exec { background: linear-gradient(180deg, #3cf07a, #17a84a); color: #04180c; border-color: #3cf07a; }
#fms .fms-leg { display: grid; grid-template-columns: 1fr 78px auto; gap: 5px; align-items: center;
  padding: 5px 6px; border-radius: 6px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); }
#fms .fms-leg.auto { opacity: 0.72; background: rgba(49,208,255,0.05); }
#fms .fms-leg-id { font: bold 12px Consolas, monospace; color: #ff4fd8; }
#fms .fms-leg-sub { font: 10px Consolas, monospace; color: #8fa3bf; }
#fms .fms-leg input.alt { padding: 4px 5px; font-size: 11px; text-align: center; }
#fms .fms-leg input.alt.bad { border-color: #ff3b30; color: #ff8078; }
#fms .fms-errs { font-size: 11px; color: #ff6b6b; padding: 0 10px 6px; }
#fms .fms-foot { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid rgba(255,255,255,0.1); flex-wrap: wrap; }
#fms .fms-stat { font: 11px Consolas, monospace; color: #9fe6ff; padding: 6px 8px; border-radius: 6px; background: rgba(49,208,255,0.08); line-height: 1.45; }
#fms .fms-steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding: 6px 10px; border-bottom: 1px solid rgba(255,255,255,0.08); background: rgba(0,0,0,0.22); }
#fms .fms-step { font: 10px "Segoe UI", sans-serif; color: #8fa3bf; padding: 4px 5px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.08); text-align: center; }
#fms .fms-step.done { color: #3cf07a; border-color: rgba(60,240,122,0.4); background: rgba(60,240,122,0.08); }
#fms .fms-step.next { color: #ffbe3b; border-color: rgba(255,190,59,0.55); background: rgba(255,190,59,0.1); font-weight: 700; }
#fms .fms-tipbox { font-size: 11px; line-height: 1.45; color: #c7d6ea; padding: 7px 9px; border-radius: 6px; background: rgba(255,190,59,0.09); border: 1px solid rgba(255,190,59,0.28); }
#fms .fms-tipbox b { color: #ffbe3b; }
#fms .fms-btn.fly { background: linear-gradient(180deg, #38d6ff, #138dc7); color: #02121c; border-color: #38d6ff; }
#fms .fms-guide h4 { margin: 6px 0 3px; font-size: 12px; color: #31d0ff; }
#fms .fms-guide p, #fms .fms-guide li { margin: 2px 0; font-size: 11.5px; color: #c7d6ea; line-height: 1.45; }
#fms .fms-guide ul { margin: 2px 0 6px; padding-left: 16px; }
#fms .fms-guide code { background: rgba(255,255,255,0.1); padding: 1px 4px; border-radius: 3px; font-family: Consolas, monospace; color: #ffbe3b; }
`;

function defaultPlan(site) {
  return {
    origin: site?.kind === 'airport' ? { icao: site.airport.icao, rwIndex: site.rwIndex, end: site.end } : null,
    dest: null,
    wpts: [],
    crzFt: 35000,
    clbKt: 280,
    crzMach: 0.78,
    desKt: 280,
  };
}

function loadSavedPlan(site, airports) {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (raw && typeof raw === 'object' && Array.isArray(raw.wpts)) {
      const p = { ...defaultPlan(site), ...raw };
      if (p.dest?.icao && !airports.some(a => a.icao === p.dest.icao)) p.dest = null;
      if (p.origin?.icao && !airports.some(a => a.icao === p.origin.icao)) p.origin = defaultPlan(site).origin;
      return p;
    }
  } catch { /* corrupt storage -> ignore */ }
  return defaultPlan(site);
}

function fmtAlt(alt) {
  if (!alt) return '';
  return (alt.type === 'AOA' ? 'A' : alt.type === 'AOB' ? 'B' : '') + alt.ft;
}

export class FMS {
  constructor({ airports, world, fm, ap, minimap, hud, onToggle }) {
    this.airports = airports;
    this.world = world;
    this.fm = fm;
    this.ap = ap;
    this.minimap = minimap;
    this.hud = hud;
    this.onToggle = onToggle;
    airports.forEach(a => { if (!a._s) a._s = norm(`${a.icao} ${a.iata} ${a.name} ${a.city}`); });

    if (!document.getElementById('fms-style')) {
      const st = document.createElement('style'); st.id = 'fms-style'; st.textContent = CSS; document.head.appendChild(st);
    }
    this.tab = 'rte';
    this.draft = loadSavedPlan(world.site, airports);
    this.active = null;
    this.mod = !!(this.draft.dest || this.draft.wpts.length);
    this.visible = false;

    const el = this.el = document.createElement('div');
    el.id = 'fms';
    el.innerHTML = `
      <div class="fms-head">
        <span class="dom-grip fms-grip">⋮⋮</span>
        <span class="fms-title">FMS / MCDU</span>
        <span class="fms-mod">MOD</span>
        <button class="fms-close" title="Kapat [Tab]">×</button>
      </div>
      <div class="fms-tabs">
        <button data-t="rte" class="on">RTE</button>
        <button data-t="legs">LEGS</button>
        <button data-t="perf">PERF</button>
        <button data-t="guide">REHBER ?</button>
      </div>
      <div class="fms-steps"></div>
      <div class="fms-body"></div>
      <div class="fms-errs"></div>
      <div class="fms-foot">
        <button class="fms-btn" data-f="clear">Temizle</button>
        <button class="fms-btn" data-f="revert">İptal MOD</button>
        <button class="fms-btn exec" data-f="exec">EXEC</button>
        <button class="fms-btn fly" data-f="engage" style="margin-left:auto">Rotayı Takip Et</button>
      </div>`;
    document.body.appendChild(el);
    ['pointerdown', 'wheel', 'dblclick', 'keydown', 'keyup'].forEach(ev => el.addEventListener(ev, e => e.stopPropagation()));
    el.querySelector('.fms-close').onclick = () => this.setVisible(false);
    el.querySelectorAll('.fms-tabs button').forEach(b => b.onclick = () => { this.tab = b.dataset.t; this.render(); });
    el.querySelector('[data-f="clear"]').onclick = () => { this.draft = defaultPlan(this.world.site); this.markMod(); };
    el.querySelector('[data-f="revert"]').onclick = () => { this.draft = clone(this.active || defaultPlan(this.world.site)); this.mod = false; this.render(); this.syncPreview(); };
    el.querySelector('[data-f="exec"]').onclick = () => this.exec();
    el.querySelector('[data-f="engage"]').onclick = () => { this.ap.engageRoute(); this.renderSteps(); };
    this.ap.onChange(() => { if (this.visible) this.renderSteps(); });

    this.render();
    this.syncPreview();
  }

  ppos() {
    if (!this.world?.frame || !this.fm) return null;
    return this.world.frame.toLatLon(this.fm.pos.x, this.fm.pos.z);
  }

  markMod() {
    this.mod = true;
    this.render();
    this.syncPreview();
  }

  toggle() { this.setVisible(!this.visible); return this.visible; }
  setVisible(v) {
    this.visible = !!v;
    this.el.classList.toggle('open', this.visible);
    if (this.visible) this.render();
    this.onToggle?.(this.visible);
  }

  addPointFromMap(lat, lon) {
    if (!this.visible) return false;
    this.draft.wpts.push({ id: `WP${this.draft.wpts.length + 1}`, lat, lon, alt: null });
    this.tab = 'legs';
    this.markMod();
    return true;
  }

  syncPreview() {
    if (!this.minimap) return;
    if (this.mod && this.draft.dest) {
      const r = buildRoute(this.draft, this.airports, this.ppos());
      this.minimap.setDraftRoute(r.points);
    } else {
      this.minimap.setDraftRoute(null);
    }
  }

  async exec() {
    const ppos = this.ppos();
    const errs = validate(this.draft, this.airports, ppos);
    if (errs.length) return;
    const execBtn = this.el.querySelector('[data-f="exec"]');
    execBtn.disabled = true; execBtn.textContent = 'YÜKLENİYOR…';
    try {
      const route = buildRoute(this.draft, this.airports, ppos);
      // Sample points every ~50 km along legs for terrain coverage
      const covPts = [...route.points];
      for (let i = 1; i < route.points.length; i++) {
        const a = route.points[i - 1], b = route.points[i];
        const segs = Math.max(1, Math.ceil(gcDistanceNm(a, b) / 30));
        for (let k = 1; k < segs; k++) covPts.push({ lat: a.lat + (b.lat - a.lat) * (k / segs), lon: a.lon + (b.lon - a.lon) * (k / segs) });
      }
      await this.world.ensureRouteCoverage(covPts);
      const destList = await this.world.addAirport(route.destAirport).catch(() => null);
      const destLocal = destList?.[this.draft.dest.rwIndex]?.[this.draft.dest.end === 'he' ? 'he' : 'le'] || null;

      route.points = route.points.map(p => ({ ...p, ...this.world.frame.toLocal(p.lat, p.lon) }));
      const activeRoute = new ActiveRoute(route);
      this.active = clone(this.draft);
      this.mod = false;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.active)); } catch { /* ignore */ }
      this.ap.setRoute(activeRoute, destLocal);
      this.minimap?.setActiveRoute(activeRoute);
      this.minimap?.setDraftRoute(null);
      this.hud?.message(`FMS EXEC: ${route.destAirport.icao} · ${route.totalNm.toFixed(0)} NM · Şimdi "Rotayı Takip Et"e bas`, 'green', 5);
    } finally {
      execBtn.textContent = 'EXEC';
      this.render();
    }
  }

  renderAirportPicker(label, cur, onSelect, allowPpos = false) {
    const apt = cur ? this.airports.find(a => a.icao === cur.icao) : null;
    const rwOpts = apt ? apt.rw.flatMap((r, i) => ['le', 'he'].map(e => {
      const sel = cur.rwIndex === i && cur.end === e ? 'selected' : '';
      return `<option value="${i}:${e}" ${sel}>RWY ${esc(r[e].id)} (${r.len} m)</option>`;
    })).join('') : '';
    return `
      <div class="fms-lbl">${label}</div>
      <div class="fms-row">
        <div class="fms-search" style="flex:1">
          <input data-role="apt-q" data-kind="${label}" placeholder="${apt ? `${apt.icao} · ${esc(apt.name)}` : (allowPpos ? 'PPOS (mevcut konum) — ara…' : 'ICAO, IATA veya şehir ara…')}" autocomplete="off" />
          <ul class="fms-hits" style="display:none"></ul>
        </div>
        ${allowPpos ? `<button class="fms-btn" data-ppos="1" title="Mevcut konumdan başla">PPOS</button>` : ''}
      </div>
      ${apt ? `<select data-role="rw" data-kind="${label}">${rwOpts}</select>` : ''}`;
  }

  renderSteps() {
    const s1 = !!this.draft.dest;
    const s2 = !!this.ap.route && !this.mod;
    const s3 = !this.fm?.onGround;
    const s4 = !!(this.ap.ap && this.ap.lat === 'LNAV') || !!(this.ap.armedLnav && this.ap.route);
    const items = [
      ['1. Varış Seç', s1],
      ['2. EXEC', s2],
      ['3. Havalan', s3],
      ['4. Takip Et', s4],
    ];
    let nextMarked = false;
    this.el.querySelector('.fms-steps').innerHTML = items.map(([lbl, done]) => {
      const cls = done ? 'done' : (!nextMarked ? (nextMarked = true, 'next') : '');
      return `<div class="fms-step ${cls}">${done ? '✓ ' : ''}${lbl}</div>`;
    }).join('');
    const engBtn = this.el.querySelector('[data-f="engage"]');
    engBtn.disabled = !this.ap.route;
    engBtn.textContent = (this.ap.ap && this.ap.lat === 'LNAV') ? '✓ Rota Takibinde' : (this.fm?.onGround ? 'Kalkışa Hazırla' : 'Rotayı Takip Et');
  }

  suggestCruise(route) {
    if (!route) return;
    const nm = route.totalNm;
    this.draft.crzFt = nm < 50 ? 6000 : nm < 100 ? 12000 : nm < 200 ? 22000 : 32000;
  }

  render() {
    const el = this.el;
    el.querySelectorAll('.fms-tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === this.tab));
    el.querySelector('.fms-mod').classList.toggle('on', this.mod);
    el.querySelector('[data-f="revert"]').disabled = !this.mod || !this.active;
    this.renderSteps();

    const ppos = this.ppos();
    const errs = validate(this.draft, this.airports, ppos);
    el.querySelector('.fms-errs').innerHTML = errs.map(e => `• ${esc(e)}`).join('<br>');
    el.querySelector('[data-f="exec"]').disabled = errs.length > 0;

    const body = el.querySelector('.fms-body');
    const route = this.draft.dest ? buildRoute(this.draft, this.airports, ppos) : null;
    const todDist = route ? todDistanceNm(this.draft.crzFt, route.fafFt) + 10 : 0;

    if (this.tab === 'rte') {
      body.innerHTML = `
        <div data-box="orig">${this.renderAirportPicker('Kalkış (ORIG)', this.draft.origin, null, true)}</div>
        <div data-box="dest">${this.renderAirportPicker('Varış (DEST)', this.draft.dest, null, false)}</div>
        ${route ? `<div class="fms-stat">Mesafe: <b>${route.totalNm.toFixed(1)} NM</b> (${Math.round(route.totalNm * 1.852)} km) · Tahmini ETE: <b>${Math.round(route.totalNm / (this.draft.crzMach * 460) * 60)} dk</b><br>CRZ: ${this.draft.crzFt} ft · FAF: ${route.fafFt} ft · T/D: varışa ${todDist.toFixed(0)} NM kala</div>` : '<div class="fms-stat"><b>Adım 1:</b> Varış havalimanı seç (ör. LTFJ veya LTAC) ve alttan yeşil <b>EXEC</b> butonuna bas.</div>'}
      `;
      this.wirePicker(body.querySelector('[data-box="orig"]'), (val) => { this.draft.origin = val; this.markMod(); });
      this.wirePicker(body.querySelector('[data-box="dest"]'), (val) => {
        const changedApt = val?.icao !== this.draft.dest?.icao;
        this.draft.dest = val;
        if (changedApt && val) this.suggestCruise(buildRoute(this.draft, this.airports, ppos));
        this.markMod();
      });
    } else if (this.tab === 'legs') {
      const pts = route ? route.points : [
        ...(this.draft.origin ? [{ id: this.draft.origin.icao, kind: 'orig' }] : [{ id: 'PPOS', kind: 'ppos' }]),
        ...this.draft.wpts.map((w, i) => ({ id: w.id || `WP${i + 1}`, lat: w.lat, lon: w.lon, kind: 'wpt', alt: w.alt })),
      ];
      let wptIdx = -1;
      const rows = pts.map((p, i) => {
        const sub = i > 0 && p.lat != null && pts[i - 1].lat != null
          ? `${String(Math.round(gcBearing(pts[i - 1], p))).padStart(3, '0')}° · ${gcDistanceNm(pts[i - 1], p).toFixed(1)} NM`
          : (p.kind === 'orig' || p.kind === 'ppos' ? 'BAŞLANGIÇ' : '');
        if (p.kind === 'wpt') {
          wptIdx++;
          const wi = wptIdx;
          return `
            <div class="fms-leg" data-wi="${wi}">
              <div><div class="fms-leg-id">${esc(p.id)}</div><div class="fms-leg-sub">${sub} · ${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}</div></div>
              <input class="alt" data-alt="${wi}" placeholder="İrtifa (ops.)" title="Boş bırakılabilir. 9000 = tam 9000 ft, A9000 = en az 9000 ft, B12000 = en fazla 12000 ft" value="${esc(fmtAlt(this.draft.wpts[wi].alt))}">
              <div class="fms-row">
                <button class="fms-btn" data-mv="-1" ${wi === 0 ? 'disabled' : ''}>↑</button>
                <button class="fms-btn" data-mv="1" ${wi === this.draft.wpts.length - 1 ? 'disabled' : ''}>↓</button>
                <button class="fms-btn" data-del="1">×</button>
              </div>
            </div>`;
        }
        return `<div class="fms-leg auto"><div><div class="fms-leg-id">${esc(p.id)}</div><div class="fms-leg-sub">${sub}</div></div><div class="fms-leg-sub">${p.alt ? fmtAlt(p.alt) : ''}</div><div></div></div>`;
      }).join('');
      body.innerHTML = `
        <div class="fms-row">
          <input id="fmsWptIn" placeholder="ICAO (LTBY) veya enlem,boylam (40.8, 29.2)" style="flex:1">
          <button class="fms-btn" id="fmsWptAdd">Ekle</button>
        </div>
        <div class="fms-tipbox">
          <b>İrtifa kutusu (isteğe bağlı, boş bırakabilirsin):</b><br>
          <code>9000</code> = tam 9000 ft · <code>A9000</code> = en az 9000 ft · <code>B12000</code> = en fazla 12000 ft<br>
          Haritada (Mini Harita) tıklayarak da ara nokta ekleyebilirsin.
        </div>
        ${rows}
      `;
      const addIn = body.querySelector('#fmsWptIn');
      const doAdd = () => {
        const w = parseWaypoint(addIn.value, this.airports);
        if (!w) { addIn.style.borderColor = '#ff3b30'; return; }
        this.draft.wpts.push({ id: w.id || `WP${this.draft.wpts.length + 1}`, lat: w.lat, lon: w.lon, alt: null });
        this.markMod();
      };
      body.querySelector('#fmsWptAdd').onclick = doAdd;
      addIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') doAdd(); });
      addIn.addEventListener('keyup', (e) => e.stopPropagation());
      body.querySelectorAll('.fms-leg[data-wi]').forEach(row => {
        const wi = +row.dataset.wi;
        const altIn = row.querySelector('input.alt');
        altIn.addEventListener('keydown', e => e.stopPropagation());
        altIn.addEventListener('keyup', e => e.stopPropagation());
        altIn.addEventListener('change', () => {
          const parsed = parseAltConstraint(altIn.value);
          if (parsed === undefined) { altIn.classList.add('bad'); return; }
          altIn.classList.remove('bad');
          this.draft.wpts[wi].alt = parsed;
          this.markMod();
        });
        row.querySelector('[data-del]')?.addEventListener('click', () => { this.draft.wpts.splice(wi, 1); this.markMod(); });
        row.querySelectorAll('[data-mv]').forEach(b => b.addEventListener('click', () => {
          const j = wi + Number(b.dataset.mv);
          if (j < 0 || j >= this.draft.wpts.length) return;
          [this.draft.wpts[wi], this.draft.wpts[j]] = [this.draft.wpts[j], this.draft.wpts[wi]];
          this.markMod();
        }));
      });
    } else if (this.tab === 'guide') {
      body.innerHTML = `
        <div class="fms-guide">
          <h4>1. Uçuş Planı Nasıl Hazırlanır?</h4>
          <ul>
            <li><b>RTE</b> sekmesinde varış havalimanı (ör. <code>LTFJ</code>, <code>LTAC</code>) ve pist seç.</li>
            <li>İstersen <b>LEGS</b> sekmesinde Mini Harita'ya tıklayarak ara noktalar (waypoint) ekle.</li>
            <li>Alttaki yeşil <b>EXEC</b> butonuna bas — rota haritada ve radarda (ND) mor çizgi olarak çıkar.</li>
          </ul>
          <h4>2. Rotayı Otopilotla Takip Etme</h4>
          <ul>
            <li>Önce pistten kalk (yerdeyken <b>Kalkışa Hazırla</b>'ya basabilirsin; havada <code>I</code> ile A/P açınca otomatik başlar).</li>
            <li>Havadayken mavi <b>Rotayı Takip Et</b> butonuna tek tıkla — <code>A/P + LNAV + VNAV</code> birlikte açılır ve uçak noktaları sırayla döner.</li>
            <li><b>Önemli:</b> Otopilot açıkken <code>W/A/S/D</code> veya yön tuşlarına basarsan otopilot manuel moda düşer. Kamerayı çevirmek için <b>fareyi sürükle</b>.</li>
          </ul>
          <h4>3. İrtifa Kısıtı (9000 / A / B) Nedir?</h4>
          <ul>
            <li><b>Boş bırakabilirsin:</b> Otopilot tırmanma ve alçalmayı kendi hesaplar.</li>
            <li><code>9000</code> veya <code>AT 9000</code>: Noktadan <b>tam 9.000 ft</b>'te geç.</li>
            <li><code>A9000</code> (Above): <b>En az 9.000 ft</b> (üstünde geç).</li>
            <li><code>B12000</code> (Below): <b>En fazla 12.000 ft</b> (altında geç).</li>
          </ul>
          <h4>4. İniş (FAF ve Autoland)</h4>
          <p>Son yaklaşma bacağına girilince <code>APP</code> otomatik kurulur. Ekranda <code>SET FLAPS / GEAR</code> çıkınca <code>X</code> ile flapları ve <code>G</code> ile takımı aç.</p>
        </div>
      `;
    } else {
      body.innerHTML = `
        <div class="fms-grid2">
          <div><div class="fms-lbl">CRZ ALT (ft)</div><input data-p="crzFt" type="number" step="500" min="1000" max="41000" value="${this.draft.crzFt}"></div>
          <div><div class="fms-lbl">CRZ MACH</div><input data-p="crzMach" type="number" step="0.01" min="0.35" max="0.84" value="${this.draft.crzMach}"></div>
          <div><div class="fms-lbl">CLB IAS (kt)</div><input data-p="clbKt" type="number" step="5" min="120" max="340" value="${this.draft.clbKt}"></div>
          <div><div class="fms-lbl">DES IAS (kt)</div><input data-p="desKt" type="number" step="5" min="120" max="340" value="${this.draft.desKt}"></div>
        </div>
        ${route ? `<div class="fms-stat">T/D: varış eşiğine <b>${todDist.toFixed(1)} NM</b> kala<br>FAF İrtifası: <b>${route.fafFt} ft</b> · 3° süzülüş</div>` : ''}
      `;
      body.querySelectorAll('input[data-p]').forEach(inp => {
        inp.addEventListener('keydown', e => e.stopPropagation());
        inp.addEventListener('keyup', e => e.stopPropagation());
        inp.addEventListener('change', () => {
          this.draft[inp.dataset.p] = Number(inp.value);
          this.markMod();
        });
      });
    }
  }

  wirePicker(box, onUpdate) {
    const inp = box.querySelector('[data-role="apt-q"]');
    const hits = box.querySelector('.fms-hits');
    const pposBtn = box.querySelector('[data-ppos]');
    const rwSel = box.querySelector('[data-role="rw"]');
    if (pposBtn) pposBtn.onclick = () => onUpdate(null);
    if (rwSel) rwSel.onchange = () => {
      const [rwIndex, end] = rwSel.value.split(':');
      const cur = box.dataset.box === 'orig' ? this.draft.origin : this.draft.dest;
      if (cur) onUpdate({ ...cur, rwIndex: +rwIndex, end });
    };
    let lastHits = [];
    inp.addEventListener('input', () => {
      const q = norm(inp.value.trim());
      if (!q) { hits.style.display = 'none'; hits.innerHTML = ''; return; }
      lastHits = this.airports.filter(a => a._s.includes(q))
        .sort((a, b) => (norm(b.icao) === q || norm(b.iata) === q) - (norm(a.icao) === q || norm(a.iata) === q) || b.big - a.big)
        .slice(0, 8);
      hits.innerHTML = lastHits.map((a, i) => `<li data-i="${i}"><b>${a.icao}</b>${a.iata ? ' ' + a.iata : ''} · ${esc(a.name)}</li>`).join('');
      hits.style.display = lastHits.length ? 'block' : 'none';
    });
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && lastHits[0]) {
        const a = lastHits[0];
        onUpdate({ icao: a.icao, rwIndex: 0, end: 'le' });
      }
    });
    inp.addEventListener('keyup', e => e.stopPropagation());
    hits.addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (!li) return;
      const a = lastHits[+li.dataset.i];
      if (a) onUpdate({ icao: a.icao, rwIndex: 0, end: 'le' });
    });
  }
}
