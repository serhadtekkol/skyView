import { tips } from './tooltip.js';
import { netStats, formatBytes, formatRate, formatDuration } from './netstats.js';

const STORAGE_KEY = 'skyview.statsOpen';
const CSS = `
#stats { position: fixed; top: 8px; left: 158px; z-index: 7; font-family: "Segoe UI", system-ui, sans-serif; user-select: none; }
#stats .st-head { display: flex; align-items: center; gap: 6px; background: rgba(6,10,16,0.82); border: 1px solid rgba(140,170,210,0.35);
  border-radius: 8px; padding: 4px 8px; color: #e8f1ff; box-shadow: 0 6px 18px rgba(0,0,0,0.4); }
#stats .st-grip { width: 14px; font-size: 12px; }
#stats button { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18); color: #e8f1ff;
  border-radius: 6px; padding: 3px 7px; font-size: 11.5px; font-weight: 600; cursor: pointer; }
#stats button:hover, #stats.open button[data-a="toggle"] { border-color: #31d0ff; color: #31d0ff; }
#stats .st-pill { font: bold 11px Consolas, monospace; color: #9fe6ff; white-space: nowrap; }
#stats .st-dot { width: 7px; height: 7px; border-radius: 50%; background: #4a596d; display: inline-block; flex-shrink: 0; }
#stats .st-dot.dl { background: #3cf07a; box-shadow: 0 0 8px #3cf07a; }
#stats .st-pop { display: none; margin-top: 6px; width: 268px; padding: 10px 12px; border-radius: 10px;
  background: rgba(6,10,16,0.92); border: 1px solid rgba(140,170,210,0.35); box-shadow: 0 12px 28px rgba(0,0,0,0.55); }
#stats.open .st-pop { display: block; }
#stats .st-sec { font: 700 10px Consolas, monospace; letter-spacing: 0.9px; text-transform: uppercase; color: #31d0ff;
  margin: 8px 0 4px; padding-bottom: 3px; border-bottom: 1px solid rgba(255,255,255,0.08); }
#stats .st-sec:first-child { margin-top: 0; }
#stats .st-row { display: flex; justify-content: space-between; align-items: baseline; font-size: 11.5px; color: #c9d6e5; margin: 3px 0; }
#stats .st-val { font: bold 11.5px Consolas, monospace; color: #ecf3ff; }
#stats .st-val.cyan { color: #31d0ff; }
#stats .st-val.green { color: #3cf07a; }
#stats .st-sub { font: 10.5px Consolas, monospace; color: #8fa3bf; }
#stats canvas.st-spark { width: 100%; height: 34px; display: block; margin-top: 6px; border-radius: 5px;
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); }
`;

export class StatsPanel {
  constructor() {
    if (!document.getElementById('stats-style')) {
      const st = document.createElement('style'); st.id = 'stats-style'; st.textContent = CSS; document.head.appendChild(st);
    }
    this.flightSec = 0;
    this.sessionSec = 0;
    this.distM = 0;
    this.lastPos = null;
    this.acc = 0;
    this.history = new Array(30).fill(0);

    const el = this.el = document.createElement('div');
    el.id = 'stats';
    el.innerHTML = `
      <div class="st-head">
        <span class="st-grip">⋮⋮</span>
        <span class="st-dot" data-s="dot"></span>
        <button data-a="toggle" title="İstatistikler [F2]">İstatistik</button>
        <span class="st-pill" data-s="pill">00:00:00 · 0 B</span>
      </div>
      <div class="st-pop">
        <div class="st-sec">Uçuş</div>
        <div class="st-row"><span>Uçuş Süresi (Havada)</span><span class="st-val green" data-s="flight">00:00:00</span></div>
        <div class="st-row"><span>Oturum Süresi</span><span class="st-val" data-s="session">00:00:00</span></div>
        <div class="st-row"><span>Kat Edilen Mesafe</span><span class="st-val" data-s="dist">0.0 NM</span></div>

        <div class="st-sec">Anlık Karo İndirme</div>
        <div class="st-row"><span>İndirme Hızı</span><span class="st-val cyan" data-s="rate">0 KB/s</span></div>
        <div class="st-row"><span>Durum</span><span class="st-sub" data-s="dlstate">Hazır</span></div>
        <canvas class="st-spark" width="244" height="34"></canvas>

        <div class="st-sec">Toplam İndirilen Veri</div>
        <div class="st-row"><span>Toplam</span><span class="st-val" data-s="total">0 B</span></div>
        <div class="st-row"><span class="st-sub">Uydu Karoları</span><span class="st-sub" data-s="img">0 B</span></div>
        <div class="st-row"><span class="st-sub">Yükseklik (DEM)</span><span class="st-sub" data-s="elev">0 B</span></div>
        <div class="st-row"><span class="st-sub">Gece Işıkları</span><span class="st-sub" data-s="night">0 B</span></div>
        <div class="st-row"><span class="st-sub">Model &amp; Harita Verisi</span><span class="st-sub" data-s="assets">0 B</span></div>
        <div class="st-row" style="margin-top:5px"><span class="st-sub">Karolar / FPS</span><span class="st-sub" data-s="perf">0 karo · 60 FPS</span></div>
      </div>`;
    document.body.appendChild(el);
    ['pointerdown', 'dblclick', 'wheel', 'keydown', 'keyup'].forEach(ev => el.addEventListener(ev, e => e.stopPropagation()));
    el.querySelector('[data-a="toggle"]').onclick = () => this.toggle();
    this.spark = el.querySelector('canvas.st-spark');
    this.fields = Object.fromEntries([...el.querySelectorAll('[data-s]')].map(n => [n.dataset.s, n]));

    tips(el, {
      '[data-a="toggle"]': 'İstatistikler Paneli|Uçuş süresi, toplam indirilen harita verisi ve anlık karo indirme hızını gösterir. Kısayol: [F2]',
    });

    try { if (localStorage.getItem(STORAGE_KEY) === '1') this.setOpen(true); } catch { /* ignore */ }
  }

  get open() { return this.el.classList.contains('open'); }
  setOpen(v) {
    this.el.classList.toggle('open', !!v);
    try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch { /* ignore */ }
    if (v) this.render(0, 0);
  }
  toggle() { this.setOpen(!this.open); return this.open; }

  resetFlight() {
    this.flightSec = 0;
    this.distM = 0;
    this.lastPos = null;
  }

  update(dt, fm, world, fps, paused) {
    if (!paused) {
      this.sessionSec += dt;
      if (fm && !fm.onGround && !fm.crashed) {
        this.flightSec += dt;
        if (this.lastPos) {
          const step = Math.hypot(fm.pos.x - this.lastPos.x, fm.pos.z - this.lastPos.z);
          if (step < 5000) this.distM += step;
        }
        this.lastPos = { x: fm.pos.x, z: fm.pos.z };
      } else {
        this.lastPos = null;
      }
    }
    this.acc += dt;
    if (this.acc < 0.4) return;
    this.acc = 0;
    const rate = netStats.rateBps();
    this.history.push(rate);
    if (this.history.length > 30) this.history.shift();
    this.render(world?.terrain?.readyCount ?? 0, fps ?? 0);
  }

  render(cacheCount, fps) {
    const f = this.fields;
    const rate = netStats.rateBps();
    const active = netStats.inFlight;
    f.dot.classList.toggle('dl', active > 0 || rate > 0);
    f.pill.textContent = active > 0 || rate > 0
      ? `${formatDuration(this.flightSec)} · ${formatRate(rate)}`
      : `${formatDuration(this.flightSec)} · ${formatBytes(netStats.totalBytes)}`;

    if (!this.open) return;
    const nm = this.distM / 1852;
    f.flight.textContent = formatDuration(this.flightSec);
    f.session.textContent = formatDuration(this.sessionSec);
    f.dist.textContent = `${nm.toFixed(1)} NM (${(this.distM / 1000).toFixed(1)} km)`;
    f.rate.textContent = formatRate(rate);
    f.dlstate.textContent = active > 0
      ? `${active} karo iniyor · tepe ${formatRate(netStats.peakBps)}`
      : (netStats.peakBps > 0 ? `Hazır · tepe ${formatRate(netStats.peakBps)}` : 'Hazır');
    f.total.textContent = formatBytes(netStats.totalBytes);
    f.img.textContent = formatBytes(netStats.byCategory.imagery);
    f.elev.textContent = formatBytes(netStats.byCategory.elev);
    f.night.textContent = formatBytes(netStats.byCategory.night);
    f.assets.textContent = formatBytes(netStats.byCategory.assets);
    f.perf.textContent = `${netStats.tileCount} inen · ${cacheCount} bellek · ${Math.round(fps)} FPS`;

    // sparkline
    const ctx = this.spark.getContext('2d');
    const W = this.spark.width, H = this.spark.height;
    ctx.clearRect(0, 0, W, H);
    const peak = Math.max(50 * 1024, ...this.history);
    ctx.beginPath();
    this.history.forEach((v, i) => {
      const x = (i / (this.history.length - 1)) * W;
      const y = H - 3 - (v / peak) * (H - 6);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#31d0ff';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    ctx.fillStyle = 'rgba(49, 208, 255, 0.16)';
    ctx.fill();
  }
}
