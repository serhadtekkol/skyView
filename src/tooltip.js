// Hover help for any element with a data-tip attribute ("Title|Longer explanation").
const CSS = `
#tip { position: fixed; z-index: 100; max-width: 280px; padding: 8px 10px; border-radius: 8px; pointer-events: none;
  background: rgba(8,14,24,0.96); border: 1px solid rgba(49,208,255,0.45); box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  color: #e8f1ff; font: 12px/1.4 "Segoe UI", system-ui, sans-serif; opacity: 0; transform: translateY(4px);
  transition: opacity .12s, transform .12s; }
#tip.on { opacity: 1; transform: none; }
#tip b { display: block; color: #31d0ff; font-size: 12.5px; margin-bottom: 2px; }
#tip kbd { font: 11px Consolas, monospace; padding: 0 4px; border-radius: 3px; background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.2); }
`;

export function installTooltips() {
  if (document.getElementById('tip')) return;
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const tip = document.createElement('div'); tip.id = 'tip'; document.body.appendChild(tip);
  let target = null, timer = 0, mx = 0, my = 0;
  const esc = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const place = () => {
    const r = tip.getBoundingClientRect();
    let x = mx + 14, y = my + 18;
    if (x + r.width > innerWidth - 8) x = mx - r.width - 12;
    if (y + r.height > innerHeight - 8) y = my - r.height - 12;
    tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px';
  };
  const show = () => {
    if (!target) return;
    const [title, body] = target.dataset.tip.split('|');
    // [key] in the text renders as a key cap
    const fmt = (t) => esc(t).replace(/\[([^\]]+)\]/g, '<kbd>$1</kbd>');
    tip.innerHTML = body ? `<b>${fmt(title)}</b>${fmt(body)}` : fmt(title);
    tip.classList.add('on'); place();
  };
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el === target) return;
    target = el; clearTimeout(timer); tip.classList.remove('on');
    if (el) timer = setTimeout(show, 250);
  });
  document.addEventListener('pointermove', (e) => { mx = e.clientX; my = e.clientY; if (tip.classList.contains('on')) place(); });
  document.addEventListener('pointerdown', () => { clearTimeout(timer); tip.classList.remove('on'); });
}

/** Sets data-tip on the elements matched inside root: { selector: 'Title|text' } */
export function tips(root, map) {
  for (const [sel, text] of Object.entries(map)) root.querySelectorAll(sel).forEach(el => { el.dataset.tip = text; el.removeAttribute('title'); });
}
