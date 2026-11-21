// Pure network & tile download statistics tracker (rolling speed window + category breakdown).

export class NetStats {
  constructor(windowMs = 3000) {
    this.windowMs = windowMs;
    this.totalBytes = 0;
    this.tileCount = 0;
    this.inFlight = 0;
    this.byCategory = { imagery: 0, elev: 0, night: 0, assets: 0 };
    this.samples = [];          // { t, bytes }
    this.peakBps = 0;
  }

  begin() { this.inFlight++; }
  end() { if (this.inFlight > 0) this.inFlight--; }

  record(category, bytes, now = Date.now()) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return;
    this.totalBytes += n;
    if (category in this.byCategory) this.byCategory[category] += n;
    else this.byCategory.assets += n;
    if (category === 'imagery' || category === 'elev' || category === 'night') this.tileCount++;
    this.samples.push({ t: now, bytes: n });
    const r = this.rateBps(now);
    if (r > this.peakBps) this.peakBps = r;
  }

  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
  }

  rateBps(now = Date.now()) {
    this.prune(now);
    if (!this.samples.length) return 0;
    let sum = 0;
    for (const s of this.samples) sum += s.bytes;
    return sum / (this.windowMs / 1000);
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatRate(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '0 KB/s';
  if (bps < 1024 * 1024) return `${Math.round(bps / 1024)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return [h, m, r].map(v => String(v).padStart(2, '0')).join(':');
}

export const netStats = new NetStats(3000);
