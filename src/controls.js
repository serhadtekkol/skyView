import { FLAP_DETENTS } from './physics.js';
import { clamp } from './noise.js';

// Keyboard + gamepad input -> flight model controls (rate limited, self-centring).
export class Input {
  constructor() {
    this.keys = new Set();
    this.handlers = {};
    this.gamepadActive = false;
    window.addEventListener('keydown', (e) => {
      if (e.target?.closest?.('input, select, textarea, #fms, #mcp, #vol, #stats')) return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'PageUp', 'PageDown', 'Tab'].includes(e.code)) e.preventDefault();
      if (!e.repeat) this.handlers[e.code]?.(e);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this.prevButtons = [];
  }

  on(code, fn) { (Array.isArray(code) ? code : [code]).forEach(c => { this.handlers[c] = fn; }); }
  down(...codes) { return codes.some(c => this.keys.has(c)); }

  update(dt, fm) {
    const ctl = fm.ctl;
    const axis = (neg, pos) => (this.down(...pos) ? 1 : 0) - (this.down(...neg) ? 1 : 0);
    const approach = (cur, tgt, up, back) => {
      const r = (tgt === 0 || Math.sign(tgt) !== Math.sign(cur)) ? back : up;
      return cur + clamp(tgt - cur, -r * dt, r * dt);
    };

    // keyboard targets
    let pitchT = axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']);         // S / down = pull (nose up)
    let rollT = axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']);
    let yawT = axis(['KeyQ'], ['KeyE']);
    let thrRate = axis(['KeyF', 'PageDown', 'Minus', 'NumpadSubtract'], ['KeyR', 'PageUp', 'Equal', 'NumpadAdd']);
    let brake = this.down('Space', 'KeyB') ? 1 : 0;
    let trimRate = axis(['BracketLeft'], ['BracketRight']);

    // gamepad
    const gp = navigator.getGamepads ? [...navigator.getGamepads()].find(Boolean) : null;
    let padElev = null, padAil = null, padRud = null;
    if (gp) {
      const dz = (v) => (Math.abs(v) < 0.08 ? 0 : (v - Math.sign(v) * 0.08) / 0.92);
      const ax = gp.axes.map(dz);
      if (ax.some(v => v !== 0) || gp.buttons.some(b => b.pressed)) this.gamepadActive = true;
      if (this.gamepadActive) {
        padAil = Math.sign(ax[0]) * ax[0] * ax[0];
        padElev = Math.sign(ax[1]) * ax[1] * ax[1];
        padRud = ax[2] || 0;
        const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0;
        thrRate += rt - lt;
        if (gp.buttons[0]?.pressed) brake = 1;
        const edge = (i) => gp.buttons[i]?.pressed && !this.prevButtons[i];
        if (edge(5)) this.handlers['KeyX']?.();
        if (edge(4)) this.handlers['KeyZ']?.();
        if (edge(3)) this.handlers['KeyG']?.();
        if (edge(2)) this.handlers['KeyT']?.();
        if (edge(1)) this.handlers['KeyL']?.();
        if (edge(8)) this.handlers['KeyC']?.();
        this.prevButtons = gp.buttons.map(b => b.pressed);
      }
    }

    // keyboard: gradual deflection while held, faster return to neutral
    ctl.elevator = padElev !== null && pitchT === 0 ? padElev : approach(ctl.elevator, pitchT * 0.85, 1.1, 2.4);
    ctl.aileron = padAil !== null && rollT === 0 ? padAil : approach(ctl.aileron, rollT, 1.6, 3.0);
    ctl.rudder = padRud !== null && yawT === 0 && padRud !== 0 ? padRud : approach(ctl.rudder, yawT, 1.2, 2.0);
    ctl.throttle = clamp(ctl.throttle + thrRate * 0.35 * dt, 0, 1);
    // pilot inputs that override the autopilot / autothrottle
    this.override = {
      pitchRoll: pitchT !== 0 || rollT !== 0 || Math.abs(padElev || 0) > 0.3 || Math.abs(padAil || 0) > 0.3,
      throttle: thrRate !== 0,
    };
    ctl.brake = brake;
    if (trimRate) ctl.trim = clamp(ctl.trim + trimRate * 0.12 * dt, -1, 1);
  }
}

export function bindCommands(input, fm, ui, sound = null) {
  const ctl = fm.ctl;
  input.on('KeyG', () => {
    if (fm.onGround && ctl.gearDown) { ui.message('Yerdeyken takım toplanamaz', 'amber'); return; }
    ctl.gearDown = !ctl.gearDown;
    sound?.gearSound(ctl.gearDown);
    ui.message(ctl.gearDown ? 'GEAR DOWN' : 'GEAR UP');
  });
  input.on(['KeyX', 'F7'], () => {
    const next = Math.min(ctl.flapIndex + 1, FLAP_DETENTS.length - 1);
    if (next !== ctl.flapIndex) { ctl.flapIndex = next; sound?.flapSound(); }
    ui.message(`FLAPS ${FLAP_DETENTS[ctl.flapIndex]}`);
  });
  input.on(['KeyZ', 'F6'], () => {
    const next = Math.max(ctl.flapIndex - 1, 0);
    if (next !== ctl.flapIndex) { ctl.flapIndex = next; sound?.flapSound(); }
    ui.message(`FLAPS ${FLAP_DETENTS[ctl.flapIndex]}`);
  });
  input.on('KeyP', () => { ctl.parkingBrake = !ctl.parkingBrake; ui.message(ctl.parkingBrake ? 'PARKING BRAKE SET' : 'PARKING BRAKE RELEASED'); });
  input.on(['KeyL', 'Slash'], () => { ctl.spoilers = ctl.spoilers > 0 ? 0 : 1; ui.message(ctl.spoilers ? 'SPEEDBRAKE EXTENDED' : 'SPEEDBRAKE RETRACTED'); });
  input.on('KeyT', () => {
    if (!fm.onGround) { ui.message('Ters itki sadece yerde', 'amber'); return; }
    ctl.reverse = !ctl.reverse; if (ctl.reverse) ctl.throttle = 0;
    ui.message(ctl.reverse ? 'REVERSE THRUST' : 'REVERSE STOWED');
  });
  input.on('KeyY', () => { ctl.autoTrim = !ctl.autoTrim; ui.message(ctl.autoTrim ? 'AUTO TRIM ON' : 'AUTO TRIM OFF'); });
}
