// Shared flight warning rules (single source of truth for HUD and cockpit audio).

const MS2KT = 1.943844;
const M2FT = 3.28084;
export const VFE = [340, 250, 250, 250, 210, 200, 190, 175, 162];

export function computeWarnings(fm) {
  const warn = [];
  const ra = fm.agl * M2FT;
  const vs = fm.vel.y * 60 * M2FT;
  const ias = fm.ias * MS2KT;
  const vfe = VFE[fm.ctl.flapIndex] ?? 340;
  const pullUp = !fm.onGround && ra < 2000 && vs < -2500 && ra / Math.max(1, -vs) < 0.33;

  if (fm.stall > 0.05 && !fm.onGround) warn.push({ id: 'STALL', text: 'STALL', level: 'red' });
  if (ias > vfe + 4 || fm.mach > 0.82) warn.push({ id: 'OVERSPEED', text: 'OVERSPEED', level: 'red' });
  if (pullUp) warn.push({ id: 'PULL_UP', text: 'PULL UP', level: 'red' });
  else if (!fm.onGround && ra < 2500 && vs < -2000) warn.push({ id: 'SINK_RATE', text: 'SINK RATE', level: 'amber' });
  if (!fm.onGround && ra < 800 && !fm.ctl.gearDown && fm.ctl.throttle < 0.3) warn.push({ id: 'TOO_LOW_GEAR', text: 'TOO LOW — GEAR', level: 'red' });
  if (Math.abs(fm.euler.z) > 40 * Math.PI / 180 && !fm.onGround) warn.push({ id: 'BANK_ANGLE', text: 'BANK ANGLE', level: 'amber' });
  if (fm.tailStrike) warn.push({ id: 'TAIL_STRIKE', text: 'TAIL STRIKE', level: 'amber' });
  if (fm.onGround && fm.ctl.parkingBrake && fm.ctl.throttle > 0.3) warn.push({ id: 'PARKING_BRAKE', text: 'CONFIG: PARKING BRAKE', level: 'amber' });
  return warn;
}
