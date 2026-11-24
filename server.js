// Static file server + hardened flight telemetry & protected admin dashboard.
// Usage: node server.js  -> http://localhost:5173  |  Admin: http://localhost:5173/admin
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AnalyticsStore, extractIp } = require('./analytics.js');

const ROOT = __dirname;
const PORT = process.env.PORT || 5173;
const ADMIN_PASS = (process.env.ADMIN_PASS || '').trim();

const store = new AnalyticsStore(path.join(ROOT, 'data', 'telemetry.json'));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { store.saveNow(); process.exit(0); });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
};

const ADMIN_SEC_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

// Brute-force protection for /api/admin/stats: 5 failures -> 15 min lockout per IP
const MAX_AUTH_FAILS = 5;
const LOCKOUT_MS = 15 * 60_000;
const authFails = new Map();

// Telemetry ingest rate limit: 30 req / min per IP
const TELEM_LIMIT = 30;
const TELEM_WINDOW_MS = 60_000;
const telemHits = new Map();

function checkTelemRate(ip, now = Date.now()) {
  let rec = telemHits.get(ip);
  if (!rec || now - rec.start >= TELEM_WINDOW_MS) {
    rec = { start: now, count: 0 };
    telemHits.set(ip, rec);
  }
  rec.count++;
  if (telemHits.size > 5000) {
    for (const [k, v] of telemHits) if (now - v.start >= TELEM_WINDOW_MS) telemHits.delete(k);
  }
  return rec.count <= TELEM_LIMIT;
}

function checkAuth(req) {
  if (!ADMIN_PASS) return false;
  const hdr = req.headers.authorization || '';
  if (!hdr.startsWith('Bearer ')) return false;
  const token = hdr.slice(7).trim();
  const a = Buffer.from(token);
  const b = Buffer.from(ADMIN_PASS);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let p = decodeURIComponent(urlObj.pathname);
  const ip = extractIp(req);

  // ---- Telemetry ingest endpoint (rate-limited per IP)
  if (p === '/api/t' && req.method === 'POST') {
    if (!checkTelemRate(ip)) {
      res.writeHead(429);
      return res.end();
    }
    try {
      const raw = await readBody(req, 4096);
      const data = JSON.parse(raw || '{}');
      store.record(data, req);
      res.writeHead(204);
      return res.end();
    } catch {
      res.writeHead(400);
      return res.end();
    }
  }

  // ---- Protected Admin API (Bearer header only + brute-force lockout)
  if (p === '/api/admin/stats' && req.method === 'GET') {
    if (!ADMIN_PASS) {
      res.writeHead(503, { ...ADMIN_SEC_HEADERS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'ADMIN_PASS not configured' }));
    }
    const now = Date.now();
    const fail = authFails.get(ip);
    if (fail && fail.blockedUntil > now) {
      const retrySec = Math.ceil((fail.blockedUntil - now) / 1000);
      res.writeHead(429, { ...ADMIN_SEC_HEADERS, 'Content-Type': 'application/json', 'Retry-After': String(retrySec) });
      return res.end(JSON.stringify({ error: 'locked', retrySec }));
    }
    if (!checkAuth(req)) {
      const next = (fail?.count || 0) + 1;
      authFails.set(ip, { count: next, blockedUntil: next >= MAX_AUTH_FAILS ? now + LOCKOUT_MS : 0 });
      res.writeHead(401, { ...ADMIN_SEC_HEADERS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', remaining: Math.max(0, MAX_AUTH_FAILS - next) }));
    }
    authFails.delete(ip);
    const data = store.summary({
      day: urlObj.searchParams.get('day') || '',
      q: urlObj.searchParams.get('q') || '',
    });
    res.writeHead(200, { ...ADMIN_SEC_HEADERS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data));
  }

  // ---- Admin Dashboard HTML
  const isAdminPage = p === '/admin' || p === '/admin/' || p === '/admin.html';
  if (p === '/admin' || p === '/admin/') p = '/admin.html';
  if (p === '/') p = '/index.html';

  // Block private server files, dotfiles (.env!), and telemetry data directory from static serving
  if (p.startsWith('/data/') || p === '/data' || p === '/server.js' || p === '/analytics.js' || p.startsWith('/.')) {
    res.writeHead(403);
    return res.end('forbidden');
  }

  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      ...(isAdminPage ? ADMIN_SEC_HEADERS : {}),
    };
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, () => console.log(`Flight sim running at http://localhost:${PORT} (admin: ${ADMIN_PASS ? 'enabled' : 'disabled'})`));
