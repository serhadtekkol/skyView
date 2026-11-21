import { tips } from './tooltip.js';

const CSS = `
#vol { position: fixed; top: 8px; left: 16px; z-index: 7; font-family: "Segoe UI", system-ui, sans-serif; user-select: none; }
#vol .vol-head { display: flex; align-items: center; gap: 4px; background: rgba(6,10,16,0.82); border: 1px solid rgba(140,170,210,0.35);
  border-radius: 8px; padding: 4px 8px; color: #e8f1ff; box-shadow: 0 6px 18px rgba(0,0,0,0.4); }
#vol .vol-grip { width: 14px; font-size: 12px; }
#vol button { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18); color: #e8f1ff;
  border-radius: 6px; padding: 3px 7px; font-size: 12px; cursor: pointer; }
#vol button:hover { border-color: #31d0ff; color: #31d0ff; }
#vol button.muted { color: #ff6b6b; border-color: rgba(255,107,107,0.5); }
#vol .vol-pct { font: bold 11px Consolas, monospace; min-width: 34px; text-align: right; color: #31d0ff; }
#vol .vol-pop { display: none; margin-top: 6px; width: 220px; padding: 10px 12px; border-radius: 10px;
  background: rgba(6,10,16,0.92); border: 1px solid rgba(140,170,210,0.35); box-shadow: 0 12px 28px rgba(0,0,0,0.55); }
#vol.open .vol-pop { display: block; }
#vol .vol-row { display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; align-items: center; margin-bottom: 8px; font-size: 11px; color: #c9d6e5; }
#vol .vol-row:last-child { margin-bottom: 0; }
#vol .vol-row input[type=range] { grid-column: 1 / -1; width: 100%; accent-color: #31d0ff; margin: 0; }
#vol .vol-val { font: 11px Consolas, monospace; color: #8fa3bf; }
`;

const CHANNELS = [
  ['master', 'Ana Ses'],
  ['engine', 'Motor'],
  ['ambient', 'Dış Hava (Rüzgâr/Yağmur)'],
  ['alerts', 'Kokpit Uyarıları'],
  ['voice', 'Sesli Bildirim'],
];

export class VolumePanel {
  constructor(sound) {
    this.sound = sound;
    if (!document.getElementById('vol-style')) {
      const st = document.createElement('style'); st.id = 'vol-style'; st.textContent = CSS; document.head.appendChild(st);
    }
    const el = this.el = document.createElement('div');
    el.id = 'vol';
    el.innerHTML = `
      <div class="vol-head">
        <span class="vol-grip">⋮⋮</span>
        <button data-a="mute" title="Sessiz [M]">🔊</button>
        <span class="vol-pct">70%</span>
        <button data-a="toggle" title="Ses kanalları">▾</button>
      </div>
      <div class="vol-pop">
        ${CHANNELS.map(([k, lbl]) => `
          <div class="vol-row">
            <span>${lbl}</span><span class="vol-val" data-v="${k}" data-chmute="${k}" style="cursor:pointer" title="Tıkla: kapat / aç"></span>
            <input type="range" min="0" max="100" step="5" data-ch="${k}">
          </div>`).join('')}
      </div>`;
    document.body.appendChild(el);
    ['pointerdown', 'dblclick', 'wheel'].forEach(ev => el.addEventListener(ev, e => e.stopPropagation()));
    el.querySelector('[data-a="mute"]').onclick = () => { sound.init(); sound.toggleMute(); };
    el.querySelector('[data-a="toggle"]').onclick = () => el.classList.toggle('open');
    el.querySelectorAll('input[data-ch]').forEach(inp => {
      inp.addEventListener('input', () => {
        sound.init();
        sound.setVolume(inp.dataset.ch, Number(inp.value) / 100);
      });
      inp.addEventListener('keydown', e => e.stopPropagation());
    });
    this._prevVol = {};
    el.querySelectorAll('[data-chmute]').forEach(badge => {
      badge.addEventListener('click', () => {
        sound.init();
        const ch = badge.dataset.chmute;
        const cur = sound.getVolume(ch);
        if (cur > 0) { this._prevVol[ch] = cur; sound.setVolume(ch, 0); }
        else sound.setVolume(ch, this._prevVol[ch] || 1);
      });
    });
    tips(el, {
      '[data-a="mute"]': 'Ses aç/kapa|Kısayol: [M] sessiz, [,] / [.] ses -/+ %10',
      '[data-a="toggle"]': 'Ses kanalları|Ana ses, motor/çevre, kokpit uyarıları ve sesli bildirim seviyelerini ayrı ayarlar.',
    });
    sound.onChange(() => this.render());
    this.render();
  }

  render() {
    const s = this.sound.getState();
    const muteBtn = this.el.querySelector('[data-a="mute"]');
    muteBtn.textContent = s.muted || s.master === 0 ? '🔇' : s.master < 0.4 ? '🔉' : '🔊';
    muteBtn.classList.toggle('muted', s.muted);
    this.el.querySelector('.vol-pct').textContent = s.muted ? 'MUTE' : `${Math.round(s.master * 100)}%`;
    for (const [k] of CHANNELS) {
      const pct = Math.round(s[k] * 100);
      this.el.querySelector(`input[data-ch="${k}"]`).value = pct;
      this.el.querySelector(`[data-v="${k}"]`).textContent = `${pct}%`;
    }
  }
}
