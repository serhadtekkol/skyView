// Lightweight, fail-silent flight session telemetry client -> POST /api/t

const sid = (typeof crypto !== 'undefined' && crypto.randomUUID)
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function send(payload, useBeacon = false) {
  const body = JSON.stringify({ sid, ...payload });
  try {
    if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon('/api/t', blob)) return;
    }
    fetch('/api/t', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: useBeacon }).catch(() => {});
  } catch { /* ignore */ }
}

class TelemetryClient {
  constructor() {
    this.sid = sid;
    this.getMetrics = null;
    this._left = false;
    this._timer = null;

    if (typeof window !== 'undefined') {
      send({ event: 'visit', referer: document.referrer || '' });
      const onLeave = () => {
        if (this._left) return;
        this._left = true;
        const m = this.getMetrics?.() || {};
        send({ event: 'leave', ...m }, true);
      };
      window.addEventListener('pagehide', onLeave);
      window.addEventListener('beforeunload', onLeave);
      this._timer = setInterval(() => {
        const m = this.getMetrics?.() || {};
        send({ event: 'ping', ...m });
      }, 20_000);
    }
  }

  flightStart({ aircraft, origin, mode }) {
    send({ event: 'flight', aircraft, origin, mode });
  }

  routeExec({ origin, destination, waypoints }) {
    send({ event: 'route', origin, destination, waypoints });
  }
}

export const telemetry = new TelemetryClient();
