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
.resize-grip { position: absolute; right: 2px; bottom: 2px; width: 16px; height: 16px; cursor: nwse-resize; touch-action: none; z-index: 1005;
  border-radius: 3px; opacity: 0.35; transition: opacity .15s, background .15s;
  background: linear-gradient(135deg, transparent 48%, rgba(49,208,255,0.85) 50%, transparent 56%, transparent 72%, rgba(49,208,255,0.85) 74%, transparent 80%); }
.drag-handle:hover .resize-grip, .resize-grip:hover, .resize-grip.resizing { opacity: 1; }
`;

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage unavailable */ } }

export class Layout {
  constructor() {
    if (!document.getElementById('layout-style')) { const s = document.createElement('style'); s.id = 'layout-style'; s.textContent = CSS; document.head.appendChild(s); }
    this.pos = load();          // id -> { x?, y?, w?, h?, scale? }
    this.handles = new Map();
    this.domPanels = new Map();
    this.rects = {};            // filled by place() during the current frame
    this.last = {};             // rects of the previous frame (read by pointer events between frames)
    this.tips = {};
  }

  /** Saved scale multiplier for a canvas panel (default 1). */
  scaleOf(id, baseScale = 1) {
    const sc = this.pos[id]?.scale;
    return baseScale * (Number.isFinite(sc) ? sc : 1);
  }

  /** Position for a canvas panel: the saved one (kept on screen) or the default. */
  place(id, defX, defY, w, h, tip, resizable = true) {
    const p = this.pos[id];
    let x = p?.x != null ? p.x : defX, y = p?.y != null ? p.y : defY;
    x = Math.min(Math.max(x, -w + 60), innerWidth - 60);
    y = Math.min(Math.max(y, 0), innerHeight - 30);
    this.rects[id] = { x, y, w, h, defX, defY, resizable };
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
        el.dataset.tip = this.tips[id] || 'Paneli taşı / boyutlandır|Sürükle: taşı · sağ alt köşe: büyüt/küçült · çift tık: sıfırla';
        this.bindDrag(el, id,
          () => { const q = this.last[id] || this.rects[id]; return { x: q.x, y: q.y }; },
          (x, y) => { this.pos[id] = { ...(this.pos[id] || {}), x, y }; },
          (e) => !e.target.closest('.resize-grip'));
        if (r.resizable) {
          const rg = document.createElement('div');
          rg.className = 'resize-grip';
          rg.title = 'Boyutlandır (sürükle) · Çift tık: sıfırla';
          this.bindCanvasResize(rg, id);
          el.appendChild(rg);
        }
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

  bindCanvasResize(grip, id) {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const q = this.last[id] || this.rects[id];
      if (!q) return;
      const sx = e.clientX, sy = e.clientY;
      const startScale = this.pos[id]?.scale || 1;
      const startW = Math.max(80, q.w), startH = Math.max(80, q.h);
      grip.setPointerCapture(e.pointerId); grip.classList.add('resizing');
      const move = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        const factor = Math.max((startW + dx) / startW, (startH + dy) / startH);
        const next = Math.min(1.5, Math.max(0.45, startScale * factor));
        this.pos[id] = { ...(this.pos[id] || {}), scale: Math.round(next * 100) / 100 };
      };
      const up = () => {
        try { grip.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        grip.classList.remove('resizing');
        for (const [t, h] of [['pointermove', move], ['pointerup', up], ['pointercancel', up], ['lostpointercapture', up]]) grip.removeEventListener(t, h);
        save(this.pos);
      };
      grip.addEventListener('pointermove', move);
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) grip.addEventListener(t, up);
    });
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

  /** Makes a DOM panel movable by `grip` and resizable via bottom-right corner; restores saved state. */
  dom(id, panel, grip, opts = {}) {
    const mode = opts.resize || (id === 'minimap' || id === 'fms' ? 'box' : 'scale');
    const minW = opts.minW || (id === 'fms' ? 290 : 180);
    const minH = opts.minH || (id === 'fms' ? 260 : 160);
    const apply = () => {
      const p = this.pos[id]; if (!p) return;
      if (mode === 'box') {
        if (p.w) panel.style.width = Math.min(Math.max(p.w, minW), innerWidth - 24) + 'px';
        if (p.h) panel.style.height = Math.min(Math.max(p.h, minH), innerHeight - 24) + 'px';
        if (p.h && id === 'fms') panel.style.maxHeight = panel.style.height;
      } else if (p.scale) {
        panel.style.transformOrigin = p.x != null ? 'top left' : 'top center';
        panel.style.transform = p.x != null ? `scale(${p.scale})` : `translateX(-50%) scale(${p.scale})`;
      }
      if (p.x != null && p.y != null) {
        const r = panel.getBoundingClientRect();
        const x = Math.min(Math.max(p.x, -r.width + 60), innerWidth - 60), y = Math.min(Math.max(p.y, 0), innerHeight - 30);
        Object.assign(panel.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
        if (mode !== 'scale' || !p.scale) panel.style.transform = 'none';
      }
      opts.onResize?.();
    };
    this.domPanels.set(id, { panel, opts });
    grip.classList.add('dom-grip');
    grip.dataset.tip = grip.dataset.tip || 'Paneli taşı / boyutlandır|Sürükle: taşı · sağ alt köşe: boyutlandır · çift tık: sıfırla';
    const getXY = () => { const r = panel.getBoundingClientRect(); return { x: r.left, y: r.top }; };
    const setXY = (x, y) => { this.pos[id] = { ...(this.pos[id] || {}), x, y }; apply(); };
    this.bindDrag(grip, id, getXY, setXY);
    // the MCP can also be dragged by its background (anything that is not a control)
    if (id === 'mcp') this.bindDrag(panel, id, getXY, setXY, (e) => !e.target.closest('button, input, .dom-grip, .resize-grip'));

    // add bottom-right corner resize grip
    if (!panel.querySelector(':scope > .resize-grip')) {
      const rg = document.createElement('div');
      rg.className = 'resize-grip';
      rg.title = 'Boyutlandır (sürükle) · Çift tık: sıfırla';
      rg.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const r = panel.getBoundingClientRect();
        const sx = e.clientX, sy = e.clientY;
        const startW = r.width, startH = r.height;
        const startScale = this.pos[id]?.scale || 1;
        rg.setPointerCapture(e.pointerId); rg.classList.add('resizing');
        const move = (ev) => {
          const dx = ev.clientX - sx, dy = ev.clientY - sy;
          if (mode === 'box') {
            panel.classList.remove('big');
            const w = Math.round(Math.min(Math.max(startW + dx, minW), innerWidth - 24));
            const h = Math.round(Math.min(Math.max(startH + dy, minH), innerHeight - 24));
            this.pos[id] = { ...(this.pos[id] || {}), w, h };
          } else {
            const factor = (startW + dx) / Math.max(80, startW);
            const scale = Math.round(Math.min(1.35, Math.max(0.6, startScale * factor)) * 100) / 100;
            this.pos[id] = { ...(this.pos[id] || {}), scale };
          }
          apply();
        };
        const up = () => {
          try { rg.releasePointerCapture(e.pointerId); } catch { /* already released */ }
          rg.classList.remove('resizing');
          for (const [t, h] of [['pointermove', move], ['pointerup', up], ['pointercancel', up], ['lostpointercapture', up]]) rg.removeEventListener(t, h);
          save(this.pos);
        };
        rg.addEventListener('pointermove', move);
        for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) rg.addEventListener(t, up);
      });
      rg.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        delete this.pos[id]; save(this.pos);
        Object.assign(panel.style, { left: '', top: '', right: '', bottom: '', width: '', height: '', maxHeight: '', transform: '', transformOrigin: '' });
        opts.onResize?.();
      });
      panel.appendChild(rg);
    }

    grip.addEventListener('dblclick', (e) => {
      e.stopPropagation(); delete this.pos[id]; save(this.pos);
      Object.assign(panel.style, { left: '', top: '', right: '', bottom: '', width: '', height: '', maxHeight: '', transform: '', transformOrigin: '' });
      opts.onResize?.();
    });
    addEventListener('resize', apply);
    apply();
  }

  resetAll() {
    this.pos = {}; save(this.pos);
    document.querySelectorAll('#mcp, #minimap, #fms, #vol, #stats').forEach(p => {
      Object.assign(p.style, { left: '', top: '', right: '', bottom: '', width: '', height: '', maxHeight: '', transform: '', transformOrigin: '' });
    });
    for (const { opts } of this.domPanels.values()) opts.onResize?.();
  }
}
