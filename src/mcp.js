// Mode Control Panel (glareshield) UI for the autopilot.
import { tips } from './tooltip.js';
const CSS = `
#mcp { position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 6; display: flex; align-items: stretch; gap: 6px;
  padding: 7px 9px; border-radius: 10px; background: linear-gradient(180deg, #2b3138, #1d2227); border: 1px solid #4a525b;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5); font-family: "Segoe UI", system-ui, sans-serif; user-select: none; max-width: calc(100vw - 660px); flex-wrap: wrap; justify-content: center; }
@media (max-width: 1300px) { #mcp { max-width: calc(100vw - 24px); top: auto; bottom: 330px; } }
#mcp .grp { display: flex; align-items: stretch; gap: 4px; padding-right: 6px; border-right: 1px solid #3c444c; }
#mcp .grp:last-child { border-right: 0; padding-right: 0; }
#mcp .win { display: flex; flex-direction: column; align-items: center; justify-content: center; }
#mcp .win label { font-size: 9px; letter-spacing: 1px; color: #c9d1da; margin-bottom: 2px; }
#mcp input { width: 64px; padding: 3px 4px; border-radius: 4px; border: 1px solid #000; background: #070a0c; color: #ffb347;
  font: bold 17px Consolas, "Courier New", monospace; text-align: center; outline: none; }
#mcp input:focus { border-color: #31d0ff; color: #ffd27a; }
#mcp input.vs { width: 72px; }
#mcp button { position: relative; min-width: 52px; padding: 13px 7px 6px; border-radius: 5px; border: 1px solid #0d0f11; cursor: pointer;
  background: linear-gradient(180deg, #4a525b, #353b42); color: #e7edf3; font: 700 10.5px "Segoe UI", sans-serif; letter-spacing: 0.5px; }
#mcp button::before { content: ''; position: absolute; top: 4px; left: 9px; right: 9px; height: 4px; border-radius: 2px; background: #1a1f24; }
#mcp button.on::before { background: #4dff7a; box-shadow: 0 0 8px #4dff7a; }
#mcp button.arm::before { background: #f2f2f2; box-shadow: 0 0 6px #fff; }
#mcp button.ap { min-width: 60px; background: linear-gradient(180deg, #5a4a2b, #3e3421); }
#mcp button:hover { filter: brightness(1.15); }
#mcp .hint { font-size: 9px; color: #8792a0; align-self: center; max-width: 70px; line-height: 1.2; }
`;

export class MCP {
  constructor(ap) {
    this.ap = ap;
    if (!document.getElementById('mcp-style')) { const s = document.createElement('style'); s.id = 'mcp-style'; s.textContent = CSS; document.head.appendChild(s); }
    const el = this.el = document.createElement('div');
    el.id = 'mcp';
    el.innerHTML = `
      <div class="grp mcp-grip" style="width:14px;padding-right:2px">⋮⋮</div>
      <div class="grp"><button data-b="AT">A/T</button>
        <div class="win"><label>IAS kt</label><input data-k="spd" inputmode="numeric"></div>
        <button data-b="FLCH">LVL CHG</button></div>
      <div class="grp"><div class="win"><label>HDG</label><input data-k="hdg" inputmode="numeric"></div>
        <button data-b="HDG">HDG SEL</button><button data-b="APP">APP</button></div>
      <div class="grp"><div class="win"><label>ALT ft</label><input data-k="alt" inputmode="numeric"></div>
        <button data-b="ALT">ALT HLD</button></div>
      <div class="grp"><div class="win"><label>V/S fpm</label><input data-k="vs" class="vs" inputmode="numeric"></div>
        <button data-b="VS">V/S</button></div>
      <div class="grp"><button data-b="AP" class="ap">A/P</button><span class="hint">tekerle ayarla · Enter</span></div>`;
    document.body.appendChild(el);
    ['pointerdown', 'dblclick'].forEach(ev => el.addEventListener(ev, e => e.stopPropagation()));
    el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { ap.button(b.dataset.b); b.blur(); this.render(); } });

    this.inputs = [...el.querySelectorAll('input')];
    const steps = { spd: [1, 10], hdg: [1, 10], alt: [100, 1000], vs: [100, 500] };
    for (const inp of this.inputs) {
      const k = inp.dataset.k;
      const apply = () => { const v = parseFloat(inp.value.replace(/[^\d.-]/g, '')); if (!Number.isNaN(v)) ap.setSel(k, v); this.render(true); };
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { apply(); inp.blur(); }
        else if (e.key === 'Escape') { inp.blur(); this.render(true); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault(); ap.setSel(k, ap.sel[k] + (e.key === 'ArrowUp' ? 1 : -1) * steps[k][e.shiftKey ? 1 : 0]); this.render(true);
        }
      });
      inp.addEventListener('keyup', (e) => e.stopPropagation());
      inp.addEventListener('blur', apply);
      inp.addEventListener('focus', () => inp.select());
      inp.addEventListener('wheel', (e) => {
        e.preventDefault(); e.stopPropagation();
        ap.setSel(k, ap.sel[k] + (e.deltaY < 0 ? 1 : -1) * steps[k][e.shiftKey ? 1 : 0]);
        this.render(true);
      }, { passive: false });
    }
    tips(el, {
      '[data-b="AT"]': 'A/T · Otomatik gaz|Gazı otomatik yöneterek IAS alanındaki hızı tutar. Gaz tuşlarına basınca devreden çıkar. Kısayol: [Shift]+[I]',
      '[data-b="FLCH"]': 'LVL CHG · Seviye değişimi|Gaz sabit (tırmanışta güç, alçalışta rölanti); hızı burunla tutarak ALT değerine çıkar ya da iner. Büyük irtifa değişiklikleri için.',
      '[data-b="HDG"]': 'HDG SEL · Yön seçimi|Uçak HDG alanındaki yöne döner (en fazla 25° yatış). APP modunu iptal eder.',
      '[data-b="APP"]': 'APP · ILS yaklaşma ve otomatik iniş|Seçili piste önce merkez hattını (LOC), sonra 3° süzülüş yolunu (G/S) yakalar. 50 ft’te flare, 30 ft’te gaz kesme, teker koyunca spoiler. Flap ve takımı sen aç.',
      '[data-b="ALT"]': 'ALT HLD · İrtifa tut|Şu anki irtifayı tutar. ALT alanına yeni değer yazarsan otopilot oraya kendisi tırmanır/iner.',
      '[data-b="VS"]': 'V/S · Dikey hız|V/S alanındaki dikey hızla (fpm) tırmanır veya alçalır; ALT değerine gelince irtifayı yakalar.',
      '[data-b="AP"]': 'A/P · Otopilot|Otopilotu açar/kapatır. Yön tuşlarına basınca devreden çıkar. Yerdeyken devreye girmez. Kısayol: [I]',
      'input[data-k="spd"]': 'IAS · Hedef hız (knot)|Otomatik gazın tutacağı gösterge hızı. Tekerle ±1, [Shift]+teker ±10.',
      'input[data-k="hdg"]': 'HDG · Hedef yön (derece)|HDG SEL modunda dönülecek manyetik yön. Tekerle ±1°, [Shift] ile ±10°.',
      'input[data-k="alt"]': 'ALT · Hedef irtifa (feet)|Otopilotun çıkacağı/ineceği irtifa. Tekerle ±100 ft, [Shift] ile ±1000 ft.',
      'input[data-k="vs"]': 'V/S · Dikey hız (feet/dakika)|V/S modunda kullanılan tırmanma (+) veya alçalma (−) hızı. Tekerle ±100.',
    });
    ap.onChange(() => this.render());
    this.render(true);
  }

  fmt(k, v) {
    if (k === 'hdg') return String(v).padStart(3, '0');
    if (k === 'vs') return (v > 0 ? '+' : '') + v;
    return String(v);
  }

  render(force = false) {
    const ap = this.ap;
    for (const inp of this.inputs) if (force || document.activeElement !== inp) inp.value = this.fmt(inp.dataset.k, ap.sel[inp.dataset.k]);
    const on = {
      AT: ap.at, AP: ap.ap,
      FLCH: ap.ap && ap.vert === 'FLCH', HDG: ap.ap && ap.lat === 'HDG',
      ALT: ap.ap && (ap.vert === 'ALT' || ap.vert === 'ALT*'), VS: ap.ap && ap.vert === 'VS',
      APP: ap.ap && (ap.lat === 'LOC' || ap.vert === 'GS' || ap.vert === 'FLARE'),
    };
    this.el.querySelectorAll('button').forEach(b => {
      const k = b.dataset.b;
      b.classList.toggle('on', !!on[k]);
      b.classList.toggle('arm', k === 'APP' && !on.APP && (ap.appArmed || ap.gsArmed));
    });
  }

  setVisible(v) { this.el.style.display = v ? '' : 'none'; }
}
