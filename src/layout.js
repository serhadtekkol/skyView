// Movable screen panels. Canvas-drawn panels (PFD, EICAS, ND, info strip) get invisible
// drag handles along their top edge; DOM panels (MCP, minimap) get a grip.  Positions are
// remembered per panel; double-click a handle to put the panel back.

const KEY = 'skyview.layout';
const CSS = `
.drag-handle { position: fixed; z-index: 4; cursor: grab; border-radius: 10px; touch-action: none; box-sizing: border-box;
  background: transparent; border: 1px solid transparent; transition: background .15s, border-color .15s; }
.drag-handle:hover, .drag-handle.dragging { background: rgba(49,208,255,0.06); border-color: rgba(49,208,255,0.55); }
.drag-handle::after { content: '⋮⋮'; position: absolute; left: 50%; top: 0; transform: translateX(-50%) rotate(90deg);
  font: bold 12px sans-serif; color: rgba(220,240,255,0); transition: color .15s; letter-spacing: -2px; }
.drag-handle:hover::after, .drag-handle.dragging::after { color: rgba(220,240,255,0.9); }
.drag-handle.dragging { cursor: grabbing; }
.dom-grip { cursor: grab; touch-action: none; user-select: none; display: flex; align-items: center; justify-content: center;
  color: rgba(220,232,245,0.55); font: bold 13px sans-serif; letter-spacing: -2px; }
.dom-grip:hover { color: #31d0ff; }
.dom-grip:active { cursor: grabbing; }
`;

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage unavailable */ } }

export class Layout {
  constructor() {
    if (!document.getElementById('layout-style')) { const s = document.createElement('style'); s.id = 'layout-style'; s.textContent = CSS; document.head.appendChild(s); }
    this.pos = load();          // id -> { x, y } (top-left, CSS px)
    this.handles = new Map();
    this.rects = {};            // filled by place() during the current frame
    this.last = {};             // rects of the previous frame (read by pointer events between frames)
    this.tips = {};
  }

  /** Position for a canvas panel: the saved one (kept on screen) or the default. */
  place(id, defX, defY, w, h, tip) {
    const p = this.pos[id];
    let x = p ? p.x : defX, y = p ? p.y : defY;
    x = Math.min(Math.max(x, -w + 60), innerWidth - 60);
    y = Math.min(Math.max(y, 0), innerHeight - 30);
    this.rects[id] = { x, y, w, h, defX, defY };
    if (tip) this.tips[id] = tip;
    return [x, y];
  }

  /** Keeps the handle elements over the canvas panels drawn this frame. */
  syncHandles(visible = true) {
    for (const [id, el] of this.handles) if (!this.rects[id]) el.style.display = 'none';
    for (const [id, r] of Object.entries(this.rects)) {
      let el = this.handles.get(id);
      if (!el) {
        el = document.createElement('div'); el.className = 'drag-handle';
        el.dataset.tip = this.tips[id] || 'Paneli taşı|Sürükle: taşı · çift tık: varsayılan yerine döndür';
        this.bindDrag(el, id, () => { const q = this.last[id] || this.rects[id]; return { x: q.x, y: q.y }; }, (x, y) => { this.pos[id] = { x, y }; });
        el.addEventListener('dblclick', (e) => { e.stopPropagation(); delete this.pos[id]; save(this.pos); });
        document.body.appendChild(el);
        this.handles.set(id, el);
      }
      el.style.display = visible ? '' : 'none';
      el.style.left = r.x + 'px'; el.style.top = r.y + 'px'; el.style.width = r.w + 'px'; el.style.height = r.h + 'px';
    }
    this.last = this.rects;
    this.rects = {};
  }

  bindDrag(el, id, getXY, setXY, accept = () => true) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !accept(e)) return;
      e.preventDefault(); e.stopPropagation();
      const start = getXY(), sx = e.clientX, sy = e.clientY;
      el.setPointerCapture(e.pointerId); el.classList.add('dragging');
      const move = (ev) => setXY(start.x + ev.clientX - sx, start.y + ev.clientY - sy);
      const up = () => {
        try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        el.classList.remove('dragging');
        for (const [t, h] of [['pointermove', move], ['pointerup', up], ['pointercancel', up], ['lostpointercapture', up]]) el.removeEventListener(t, h);
        save(this.pos);
      };
      el.addEventListener('pointermove', move);
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, up);
    });
  }

  /** Makes a DOM panel movable by `grip`; restores its saved position. */
  dom(id, panel, grip) {
    const apply = () => {
      const p = this.pos[id]; if (!p) return;
      const r = panel.getBoundingClientRect();
      const x = Math.min(Math.max(p.x, -r.width + 60), innerWidth - 60), y = Math.min(Math.max(p.y, 0), innerHeight - 30);
      Object.assign(panel.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto', transform: 'none' });
    };
    grip.classList.add('dom-grip');
    grip.dataset.tip = grip.dataset.tip || 'Paneli taşı|Sürükle: taşı · çift tık: varsayılan yerine döndür';
    const getXY = () => { const r = panel.getBoundingClientRect(); return { x: r.left, y: r.top }; };
    const setXY = (x, y) => { this.pos[id] = { x, y }; apply(); };
    this.bindDrag(grip, id, getXY, setXY);
    // the MCP can also be dragged by its background (anything that is not a control)
    if (id === 'mcp') this.bindDrag(panel, id, getXY, setXY, (e) => !e.target.closest('button, input, .dom-grip'));
    grip.addEventListener('dblclick', (e) => {
      e.stopPropagation(); delete this.pos[id]; save(this.pos);
      Object.assign(panel.style, { left: '', top: '', right: '', bottom: '', transform: '' });
    });
    addEventListener('resize', apply);
    apply();
  }

  resetAll() {
    this.pos = {}; save(this.pos);
    document.querySelectorAll('#mcp, #minimap, #fms, #vol, #stats').forEach(p => Object.assign(p.style, { left: '', top: '', right: '', bottom: '', transform: '' }));
  }
}
