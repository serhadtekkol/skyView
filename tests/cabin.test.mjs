import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CabinAudio } from '../src/cabin.js';

const FT2M = 1 / 3.28084;
const KT2MS = 1 / 1.943844;
const FPM2MS = 1 / (60 * 3.28084);

function mockSound() {
  const calls = [];
  return {
    calls,
    seatbeltChime() { calls.push(['seatbelt']); },
    chime(n) { calls.push(['chime', n]); },
    cChord() { calls.push(['cChord']); },
    wailer(sec) { calls.push(['wailer', sec]); },
    stopWailer() { calls.push(['stopWailer']); },
    atDisconnect() { calls.push(['atDisconnect']); },
    setShaker(on) { calls.push(['shaker', on]); },
    setClacker(on) { calls.push(['clacker', on]); },
    say(text, opts) { calls.push(['say', text, opts]); },
  };
}

function fm(over = {}) {
  return {
    onGround: false,
    inCloud: 0,
    stall: 0,
    ias: 220 * KT2MS,
    mach: 0.4,
    pos: { y: 5000 * FT2M },
    agl: 5000 * FT2M,
    vel: { x: 0, y: 0, z: -120 },
    euler: { x: 0, y: 0, z: 0 },
    ctl: { flapIndex: 0, gearDown: false, throttle: 0.5, parkingBrake: false, ...(over.ctl || {}) },
    ...over,
    ctl: { flapIndex: 0, gearDown: false, throttle: 0.5, parkingBrake: false, ...(over.ctl || {}) },
  };
}

test('cloud seatbelt chime triggers with hysteresis and 90s cooldown', () => {
  const s = mockSound();
  const c = new CabinAudio(s);
  c.update(0.1, fm({ inCloud: 0.1 }), null);
  c.update(0.1, fm({ inCloud: 0.45 }), null);
  assert.equal(s.calls.filter(x => x[0] === 'seatbelt').length, 1);

  // flickering around threshold does not re-trigger
  c.update(1, fm({ inCloud: 0.25 }), null);
  c.update(1, fm({ inCloud: 0.5 }), null);
  assert.equal(s.calls.filter(x => x[0] === 'seatbelt').length, 1);

  // exiting cloud and re-entering within 90s is suppressed by cooldown
  c.update(1, fm({ inCloud: 0 }), null);
  c.update(1, fm({ inCloud: 0.5 }), null);
  assert.equal(s.calls.filter(x => x[0] === 'seatbelt').length, 1);

  // after 90s cooldown, exiting and entering triggers again
  c.update(90, fm({ inCloud: 0 }), null);
  c.update(0.1, fm({ inCloud: 0.5 }), null);
  assert.equal(s.calls.filter(x => x[0] === 'seatbelt').length, 2);
});

test('10000 ft chime uses ±200 ft hysteresis', () => {
  const s = mockSound();
  const c = new CabinAudio(s);
  c.update(0.1, fm({ pos: { y: 9500 * FT2M } }), null);
  c.update(0.1, fm({ pos: { y: 10050 * FT2M } }), null);  // inside hysteresis band
  assert.equal(s.calls.filter(x => x[0] === 'chime').length, 0);
  c.update(0.1, fm({ pos: { y: 10250 * FT2M } }), null);  // crossed above 10200
  assert.deepEqual(s.calls.filter(x => x[0] === 'chime'), [['chime', 1]]);

  // dip to 9900 and back up does not re-trigger
  c.update(0.1, fm({ pos: { y: 9900 * FT2M } }), null);
  c.update(0.1, fm({ pos: { y: 10300 * FT2M } }), null);
  assert.equal(s.calls.filter(x => x[0] === 'chime').length, 1);

  // descend below 9800 -> triggers once
  c.update(0.1, fm({ pos: { y: 9700 * FT2M } }), null);
  assert.equal(s.calls.filter(x => x[0] === 'chime').length, 2);
});

test('altitude alert C-chord fires once per target altitude within 900 ft', () => {
  const s = mockSound();
  const c = new CabinAudio(s);
  const ap = { ap: true, at: true, sel: { alt: 10000 } };
  c.update(0.1, fm({ pos: { y: 8000 * FT2M } }), ap);
  assert.equal(s.calls.filter(x => x[0] === 'cChord').length, 0);
  c.update(0.1, fm({ pos: { y: 9200 * FT2M } }), ap);
  assert.equal(s.calls.filter(x => x[0] === 'cChord').length, 1);
  c.update(0.1, fm({ pos: { y: 9500 * FT2M } }), ap);
  assert.equal(s.calls.filter(x => x[0] === 'cChord').length, 1);

  ap.sel.alt = 15000;
  c.update(0.1, fm({ pos: { y: 14200 * FT2M } }), ap);
  assert.equal(s.calls.filter(x => x[0] === 'cChord').length, 2);
});

test('A/P and A/T disconnect sounds and stopWailer on re-engage', () => {
  const s = mockSound();
  const c = new CabinAudio(s);
  const ap = { ap: true, at: true, sel: { alt: 10000 } };
  c.update(0.1, fm(), ap);
  ap.ap = false; ap.at = false;
  c.update(0.1, fm(), ap);
  assert.ok(s.calls.some(x => x[0] === 'wailer' && x[1] === 2));
  assert.ok(s.calls.some(x => x[0] === 'atDisconnect'));
  ap.ap = true;
  c.update(0.1, fm(), ap);
  assert.ok(s.calls.some(x => x[0] === 'stopWailer'));
});

test('priority: PULL UP overrides lower-priority voice warnings; STALL suppresses BANK ANGLE voice', () => {
  const s = mockSound();
  const c = new CabinAudio(s);
  c.update(0.1, fm({
    agl: 600 * FT2M,
    vel: { x: 0, y: -3000 * FPM2MS, z: -100 },
    euler: { x: 0, y: 0, z: 45 * Math.PI / 180 },
    ctl: { gearDown: false, throttle: 0.1 },
  }), null);
  const says = s.calls.filter(x => x[0] === 'say').map(x => x[1]);
  assert.deepEqual(says, ['Pull up']);

  const s2 = mockSound();
  const c2 = new CabinAudio(s2);
  c2.update(0.1, fm({ stall: 0.2, euler: { x: 0, y: 0, z: 45 * Math.PI / 180 } }), null);
  assert.ok(s2.calls.some(x => x[0] === 'shaker' && x[1] === true));
  assert.equal(s2.calls.filter(x => x[0] === 'say').length, 0);
});

test('takeoff and landing cabin prep trigger once per flight phase', () => {
  const s = mockSound();
  const c = new CabinAudio(s);
  c.update(0.1, fm({ onGround: true, pos: { y: 100 * FT2M }, ctl: { parkingBrake: false, throttle: 0.7 } }), null);
  c.update(0.1, fm({ onGround: true, pos: { y: 100 * FT2M }, ctl: { parkingBrake: false, throttle: 0.8 } }), null);
  assert.equal(s.calls.filter(x => x[0] === 'say' && /take-off/i.test(x[1])).length, 1);

  c.update(0.1, fm({ pos: { y: 8000 * FT2M }, vel: { x: 0, y: -5, z: -100 }, ctl: { gearDown: true } }), null);
  c.update(0.1, fm({ pos: { y: 7000 * FT2M }, vel: { x: 0, y: -5, z: -100 }, ctl: { gearDown: true } }), null);
  assert.equal(s.calls.filter(x => x[0] === 'say' && /landing/i.test(x[1])).length, 1);
});
