import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWarnings } from '../src/warnings.js';

const KT2MS = 1 / 1.943844;
const FT2M = 1 / 3.28084;
const FPM2MS = 1 / (60 * 3.28084);

function makeFm(over = {}) {
  return {
    onGround: false,
    stall: 0,
    ias: 220 * KT2MS,
    mach: 0.4,
    agl: 5000 * FT2M,
    vel: { x: 0, y: 0, z: -120 },
    euler: { x: 0, y: 0, z: 0 },
    tailStrike: false,
    ctl: { flapIndex: 0, gearDown: true, throttle: 0.5, parkingBrake: false, ...(over.ctl || {}) },
    ...over,
    ctl: { flapIndex: 0, gearDown: true, throttle: 0.5, parkingBrake: false, ...(over.ctl || {}) },
  };
}

test('no warnings in normal cruise', () => {
  assert.deepEqual(computeWarnings(makeFm()), []);
});

test('STALL triggers only when airborne and stall > 0.05', () => {
  assert.equal(computeWarnings(makeFm({ stall: 0.1, onGround: true })).some(w => w.id === 'STALL'), false);
  const w = computeWarnings(makeFm({ stall: 0.1 }));
  assert.equal(w.find(x => x.id === 'STALL')?.level, 'red');
});

test('OVERSPEED triggers above Vfe+4 or Mach > 0.82', () => {
  assert.equal(computeWarnings(makeFm({ ias: 254 * KT2MS, ctl: { flapIndex: 1 } })).some(w => w.id === 'OVERSPEED'), false);
  assert.equal(computeWarnings(makeFm({ ias: 255 * KT2MS, ctl: { flapIndex: 1 } })).some(w => w.id === 'OVERSPEED'), true);
  assert.equal(computeWarnings(makeFm({ mach: 0.83 })).some(w => w.id === 'OVERSPEED'), true);
});

test('PULL UP takes precedence over SINK RATE when time-to-impact < 0.33 min', () => {
  // ra = 600 ft, vs = -3000 fpm -> 600/3000 = 0.20 < 0.33 -> PULL UP (not SINK RATE)
  const w = computeWarnings(makeFm({ agl: 600 * FT2M, vel: { x: 0, y: -3000 * FPM2MS, z: -100 } }));
  assert.equal(w.some(x => x.id === 'PULL_UP'), true);
  assert.equal(w.some(x => x.id === 'SINK_RATE'), false);
});

test('SINK RATE triggers below 2500 ft when vs < -2000 fpm and not PULL UP', () => {
  // ra = 2000 ft, vs = -2200 fpm -> ra >= 2000 so not PULL UP, but < 2500 and vs < -2000 -> SINK RATE
  const w = computeWarnings(makeFm({ agl: 2000 * FT2M, vel: { x: 0, y: -2200 * FPM2MS, z: -100 } }));
  assert.equal(w.find(x => x.id === 'SINK_RATE')?.level, 'amber');
  assert.equal(w.some(x => x.id === 'PULL_UP'), false);
});

test('TOO LOW — GEAR triggers below 800 ft with gear up and low throttle', () => {
  const w = computeWarnings(makeFm({ agl: 600 * FT2M, ctl: { gearDown: false, throttle: 0.2 } }));
  assert.equal(w.some(x => x.id === 'TOO_LOW_GEAR'), true);
  assert.equal(computeWarnings(makeFm({ agl: 600 * FT2M, ctl: { gearDown: false, throttle: 0.6 } })).some(x => x.id === 'TOO_LOW_GEAR'), false);
});

test('BANK ANGLE, TAIL STRIKE and CONFIG PARKING BRAKE thresholds', () => {
  assert.equal(computeWarnings(makeFm({ euler: { x: 0, y: 0, z: 45 * Math.PI / 180 } })).some(x => x.id === 'BANK_ANGLE'), true);
  assert.equal(computeWarnings(makeFm({ tailStrike: true })).some(x => x.id === 'TAIL_STRIKE'), true);
  assert.equal(computeWarnings(makeFm({ onGround: true, ctl: { parkingBrake: true, throttle: 0.5 } })).some(x => x.id === 'PARKING_BRAKE'), true);
});
