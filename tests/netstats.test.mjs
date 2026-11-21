import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetStats, formatBytes, formatRate, formatDuration } from '../src/netstats.js';

test('NetStats accumulates category totals, tile counts, and inFlight counter', () => {
  const s = new NetStats();
  s.begin();
  assert.equal(s.inFlight, 1);
  s.record('imagery', 50000, 1000);
  s.record('elev', 30000, 1100);
  s.record('night', 20000, 1200);
  s.record('assets', 100000, 1300);
  s.end();
  assert.equal(s.inFlight, 0);
  assert.equal(s.totalBytes, 200000);
  assert.equal(s.byCategory.imagery, 50000);
  assert.equal(s.byCategory.elev, 30000);
  assert.equal(s.byCategory.night, 20000);
  assert.equal(s.byCategory.assets, 100000);
  assert.equal(s.tileCount, 3); // imagery + elev + night
});

test('NetStats computes rolling 3s download rate and decays to 0 after window passes', () => {
  const s = new NetStats(3000);
  s.record('imagery', 150000, 1000);
  s.record('imagery', 150000, 2000);
  // 300,000 bytes over 3s window = 100,000 B/s
  assert.equal(s.rateBps(2500), 100000);
  // after 1000ms sample expires at t=4500, only 150,000 remains -> 50,000 B/s
  assert.equal(s.rateBps(4500), 50000);
  // after all samples expire -> 0
  assert.equal(s.rateBps(6000), 0);
});

test('NetStats clamps inFlight at 0 and ignores non-positive byte sizes', () => {
  const s = new NetStats();
  s.end();
  assert.equal(s.inFlight, 0);
  s.record('imagery', 0, 1000);
  s.record('imagery', -50, 1000);
  assert.equal(s.totalBytes, 0);
  assert.equal(s.tileCount, 0);
});

test('formatting helpers for bytes, rate, and duration', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024 * 250), '250 KB');
  assert.equal(formatBytes(1024 * 1024 * 12.5), '12.50 MB');
  assert.equal(formatRate(0), '0 KB/s');
  assert.equal(formatRate(1024 * 420), '420 KB/s');
  assert.equal(formatRate(1024 * 1024 * 2.35), '2.35 MB/s');
  assert.equal(formatDuration(0), '00:00:00');
  assert.equal(formatDuration(3665), '01:01:05');
});
