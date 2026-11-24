const fs = require('fs');
const path = require('path');

const MAX_SESSIONS = 2000;
const ACTIVE_WINDOW_MS = 45_000;

function extractIp(req) {
  const h = req?.headers || {};
  const cf = h['cf-connecting-ip'];
  const xff = h['x-forwarded-for'];
  const xr = h['x-real-ip'];
  let ip = cf || (typeof xff === 'string' ? xff.split(',')[0].trim() : '') || xr || req?.socket?.remoteAddress || 'unknown';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

function parseReferrer(raw, host = '') {
  const s = String(raw || '').trim();
  if (!s) return { label: 'Direkt', url: '' };
  try {
    const u = new URL(s);
    if (host && u.host.toLowerCase() === host.toLowerCase()) return { label: 'Site İçi', url: s };
    return { label: u.hostname.replace(/^www\./, ''), url: s.slice(0, 300) };
  } catch {
    return { label: s.slice(0, 60), url: s.slice(0, 300) };
  }
}

function parseUA(ua = '') {
  const s = String(ua);
  const browser = /Edg\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
    : /Chrome\//.test(s) ? 'Chrome'
    : /Firefox\//.test(s) ? 'Firefox'
    : /Safari\//.test(s) ? 'Safari' : 'Diğer';
  const os = /iPhone|iPad/.test(s) ? 'iOS'
    : /Android/.test(s) ? 'Android'
    : /Mac OS X/.test(s) ? 'macOS'
    : /Windows/.test(s) ? 'Windows'
    : /Linux/.test(s) ? 'Linux' : '—';
  return `${browser} · ${os}`;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class AnalyticsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.sessions = new Map();
    this._saveTimer = null;
    this.load();
  }

  load() {
    if (!this.filePath) return;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(raw?.sessions)) {
        for (const s of raw.sessions) if (s?.sid) this.sessions.set(s.sid, s);
      }
    } catch (e) {
      console.warn('telemetry load failed:', e.message);
    }
  }

  scheduleSave() {
    if (!this.filePath || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, 1500);
  }

  saveNow() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ sessions: [...this.sessions.values()] }));
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      console.warn('telemetry save failed:', e.message);
    }
  }

  prune() {
    if (this.sessions.size <= MAX_SESSIONS) return;
    const sorted = [...this.sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
    const drop = sorted.length - MAX_SESSIONS;
    for (let i = 0; i < drop; i++) this.sessions.delete(sorted[i].sid);
  }

  record(payload, req, now = Date.now()) {
    const sid = String(payload?.sid || '').slice(0, 48);
    if (!sid) return null;
    let s = this.sessions.get(sid);
    const ip = extractIp(req);
    const country = req?.headers?.['cf-ipcountry'] || '';
    const ref = parseReferrer(payload.referer || req?.headers?.referer, req?.headers?.host);
    const device = parseUA(req?.headers?.['user-agent']);

    if (!s) {
      s = {
        sid,
        ip,
        country,
        referer: ref.label,
        refererUrl: ref.url,
        device,
        startedAt: now,
        lastSeenAt: now,
        endedAt: null,
        durationSec: 0,
        flightSec: 0,
        distanceNm: 0,
        aircraft: '',
        origin: '',
        destination: '',
        waypoints: '',
        mode: '',
      };
      this.sessions.set(sid, s);
      this.prune();
    } else {
      s.lastSeenAt = now;
      if (s.referer === 'Direkt' && ref.label !== 'Direkt' && ref.label !== 'Site İçi') {
        s.referer = ref.label;
        s.refererUrl = ref.url;
      }
    }

    if (payload.aircraft) s.aircraft = String(payload.aircraft).slice(0, 48);
    if (payload.origin) s.origin = String(payload.origin).slice(0, 64);
    if (payload.destination) s.destination = String(payload.destination).slice(0, 64);
    if (payload.waypoints != null) s.waypoints = String(payload.waypoints).slice(0, 120);
    if (payload.mode) s.mode = String(payload.mode).slice(0, 16);
    if (Number.isFinite(payload.flightSec)) s.flightSec = Math.max(s.flightSec, Math.round(payload.flightSec));
    if (Number.isFinite(payload.distanceNm)) s.distanceNm = Math.max(s.distanceNm, Math.round(payload.distanceNm * 10) / 10);

    if (payload.event === 'leave') {
      s.endedAt = now;
    } else {
      s.endedAt = null;
    }
    s.durationSec = Math.max(0, Math.round(((s.endedAt || s.lastSeenAt) - s.startedAt) / 1000));
    this.scheduleSave();
    return s;
  }

  summary({ day = '', q = '', now = Date.now() } = {}) {
    const all = [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
    const today = dayKey(now);

    // 14-day daily chart
    const dailyMap = new Map();
    for (let i = 13; i >= 0; i--) {
      const k = dayKey(now - i * 86400_000);
      dailyMap.set(k, { day: k, visits: 0, ips: new Set(), flightSec: 0 });
    }
    let todayVisits = 0, activeNow = 0, totalFlightSec = 0, totalDurSec = 0;
    const todayIps = new Set();
    const refCounts = new Map();
    const routeCounts = new Map();

    for (const s of all) {
      const dk = dayKey(s.startedAt);
      const isActive = !s.endedAt && (now - s.lastSeenAt) <= ACTIVE_WINDOW_MS;
      if (isActive) activeNow++;
      totalFlightSec += s.flightSec || 0;
      totalDurSec += s.durationSec || 0;

      if (dk === today) { todayVisits++; todayIps.add(s.ip); }
      const dm = dailyMap.get(dk);
      if (dm) { dm.visits++; dm.ips.add(s.ip); dm.flightSec += s.flightSec || 0; }

      const rk = s.referer || 'Direkt';
      refCounts.set(rk, (refCounts.get(rk) || 0) + 1);

      if (s.origin) {
        const routeKey = s.destination ? `${s.origin} → ${s.destination}` : s.origin;
        routeCounts.set(routeKey, (routeCounts.get(routeKey) || 0) + 1);
      }
    }

    const ql = String(q || '').trim().toLowerCase();
    const filtered = all.filter(s => {
      if (day && dayKey(s.startedAt) !== day) return false;
      if (ql) {
        const hay = `${s.ip} ${s.country} ${s.referer} ${s.origin} ${s.destination} ${s.aircraft} ${s.device}`.toLowerCase();
        if (!hay.includes(ql)) return false;
      }
      return true;
    }).slice(0, 300).map(s => ({
      ...s,
      active: !s.endedAt && (now - s.lastSeenAt) <= ACTIVE_WINDOW_MS,
      day: dayKey(s.startedAt),
    }));

    return {
      kpi: {
        todayVisits,
        todayUniqueIps: todayIps.size,
        activeNow,
        totalSessions: all.length,
        totalFlightSec,
        avgDurationSec: all.length ? Math.round(totalDurSec / all.length) : 0,
      },
      daily: [...dailyMap.values()].map(d => ({ day: d.day, visits: d.visits, uniqueIps: d.ips.size, flightMin: Math.round(d.flightSec / 60) })),
      referrers: [...refCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count })),
      routes: [...routeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count })),
      sessions: filtered,
    };
  }
}

module.exports = { AnalyticsStore, extractIp, parseReferrer, parseUA, dayKey };
