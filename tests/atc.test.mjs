import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHoldingPattern, updateHolding } from '../src/atc.js';

test('buildHoldingPattern generates closed racetrack oval around fix', () => {
  const h = buildHoldingPattern({ fixX: 0, fixZ: 0, inboundHdg: 0, altFt: 4050, lapsRequired: 2 });
  assert.equal(h.points.length, 18);
  assert.equal(h.altFt, 4100);
  assert.equal(h.outboundHdg, 180);
  assert.ok(Math.hypot(h.points[0].x, h.points[0].z) < 1e-6);
});

test('updateHolding advances around racetrack and counts completed laps', () => {
  const h = buildHoldingPattern({ fixX: 0, fixZ: 0, inboundHdg: 90, altFt: 5000, lapsRequired: 1 });
  let completed = false;
  let finished = false;
  // Walk aircraft through every point of the racetrack
  for (let pass = 0; pass < 2; pass++) {
    for (const pt of h.points) {
      const r = updateHolding(h, pt);
      if (r.lapCompleted) completed = true;
      if (r.finished) finished = true;
    }
  }
  assert.equal(completed, true);
  assert.equal(finished, true);
  assert.ok(h.lapsDone >= 1);
});
