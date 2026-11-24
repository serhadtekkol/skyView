import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AnalyticsStore, extractIp, parseReferrer, parseUA } = require('../analytics.js');

test('extractIp prefers CF-Connecting-IP, then X-Forwarded-For, strips ::ffff:', () => {
  assert.equal(extractIp({ headers: { 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': '10.0.0.1' } }), '203.0.113.5');
  assert.equal(extractIp({ headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' } }), '198.51.100.7');
  assert.equal(extractIp({ headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } }), '127.0.0.1');
});

test('parseReferrer and parseUA classify sources and devices cleanly', () => {
  assert.equal(parseReferrer('', 'flysky.serhad.dev').label, 'Direkt');
  assert.equal(parseReferrer('https://serhad.dev/projects/skyview', 'flysky.serhad.dev').label, 'serhad.dev');
  assert.equal(parseReferrer('https://flysky.serhad.dev/?apt=LTFM', 'flysky.serhad.dev').label, 'Site İçi');
  assert.equal(parseUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0 Safari/537.36'), 'Chrome · macOS');
});

test('AnalyticsStore records visit, flight, route, leave and computes daily summary', () => {
  const store = new AnalyticsStore(null);
  const req = { headers: { 'cf-connecting-ip': '185.10.20.30', 'cf-ipcountry': 'TR', 'user-agent': 'Chrome/130 Windows NT' } };
  const t0 = Date.UTC(2026, 10, 24, 18, 0, 0);

  store.record({ event: 'visit', sid: 's1', referer: 'https://serhad.dev/' }, req, t0);
  store.record({ event: 'flight', sid: 's1', aircraft: 'Boeing 737-900', origin: 'LTFM · RWY 35L', mode: 'to' }, req, t0 + 10_000);
  store.record({ event: 'route', sid: 's1', origin: 'LTFM', destination: 'LTFJ/06L', waypoints: 'BOGAZ1' }, req, t0 + 30_000);
  store.record({ event: 'leave', sid: 's1', flightSec: 420, distanceNm: 28.4 }, req, t0 + 600_000);

  const sum = store.summary({ now: t0 + 610_000 });
  assert.equal(sum.kpi.todayVisits, 1);
  assert.equal(sum.kpi.todayUniqueIps, 1);
  assert.equal(sum.kpi.activeNow, 0);
  assert.equal(sum.kpi.totalFlightSec, 420);
  assert.equal(sum.sessions[0].durationSec, 600);
  assert.equal(sum.sessions[0].origin, 'LTFM');
  assert.equal(sum.sessions[0].destination, 'LTFJ/06L');
  assert.equal(sum.sessions[0].referer, 'serhad.dev');
  assert.equal(sum.referrers[0].name, 'serhad.dev');
  assert.equal(sum.routes[0].name, 'LTFM → LTFJ/06L');
});
