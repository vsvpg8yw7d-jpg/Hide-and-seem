// Versteckspiel – Server ohne externe Abhängigkeiten (nur Node.js >= 18).
// Echtzeit über Server-Sent Events (SSE), Aktionen über POST /api/*.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUB = __dirname;
const STATIC = new Set(['index.html', 'style.css', 'app.js']); // nur diese Dateien werden ausgeliefert
const games = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const rid = () => crypto.randomBytes(8).toString('hex');
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const cleanName = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 20) || 'Spieler';

function newCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c;
  do {
    c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
  } while (games.has(c));
  return c;
}

function createGame(hostName) {
  const code = newCode();
  const hostId = rid();
  const g = {
    code,
    hostId,
    status: 'lobby', // lobby | countdown | running | ended
    touched: Date.now(),
    settings: { durationMin: 30, countdownSec: 60, pingMin: 3, area: null },
    players: new Map(),
    clients: new Map(), // playerId -> Set<res>
    startAt: 0,
    endAt: 0,
    nextPing: 0,
    lastPing: null,
    final: null,
    endReason: null,
  };
  g.players.set(hostId, { id: hostId, name: cleanName(hostName), role: null, pos: null, posAt: 0 });
  games.set(code, g);
  return g;
}

function view(g) {
  return {
    code: g.code,
    status: g.status,
    now: Date.now(),
    hostId: g.hostId,
    settings: g.settings,
    players: [...g.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      online: (g.clients.get(p.id)?.size || 0) > 0,
    })),
    startAt: g.startAt,
    endAt: g.endAt,
    nextPing: g.nextPing,
    lastPing: g.lastPing,
    final: g.final,
    endReason: g.endReason,
  };
}

function broadcast(g) {
  const msg = `data: ${JSON.stringify(view(g))}\n\n`;
  for (const set of g.clients.values()) for (const res of set) res.write(msg);
}

function finish(g, reason) {
  g.status = 'ended';
  g.endReason = reason;
  g.final = [...g.players.values()]
    .filter((p) => p.pos)
    .map((p) => ({ id: p.id, name: p.name, role: p.role, lat: p.pos.lat, lng: p.pos.lng }));
  broadcast(g);
}

function doPing(g, at) {
  const hiders = [...g.players.values()]
    .filter((p) => p.role === 'hider' && p.pos)
    .map((p) => ({ id: p.id, name: p.name, lat: p.pos.lat, lng: p.pos.lng, age: at - p.posAt }));
  g.lastPing = { at, hiders };
}

// Zeitsteuerung: einmal pro Sekunde
setInterval(() => {
  const now = Date.now();
  for (const [code, g] of games) {
    if (now - g.touched > 8 * 3600e3) {
      games.delete(code);
      continue;
    }
    let changed = false;
    if (g.status === 'countdown' && now >= g.startAt) {
      g.status = 'running';
      changed = true;
    }
    if (g.status === 'running') {
      if (now >= g.endAt) {
        finish(g, 'time');
        continue;
      }
      if (now >= g.nextPing) {
        doPing(g, now);
        g.nextPing += g.settings.pingMin * 60e3;
        changed = true;
      }
    }
    if (changed) broadcast(g);
  }
}, 1000);

// Keep-alive, damit Proxys die Verbindung nicht schließen
setInterval(() => {
  for (const g of games.values())
    for (const set of g.clients.values()) for (const res of set) res.write(': ka\n\n');
}, 15000);

function validArea(a) {
  if (!a || typeof a !== 'object') return null;
  const ok = (lat, lng) =>
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if (a.type === 'circle') {
    const [lat, lng] = Array.isArray(a.center) ? a.center.map(Number) : [NaN, NaN];
    const radius = Number(a.radius);
    if (!ok(lat, lng) || !Number.isFinite(radius)) return null;
    return { type: 'circle', center: [lat, lng], radius: clamp(Math.round(radius), 50, 10000) };
  }
  if (a.type === 'free' && Array.isArray(a.points)) {
    const pts = a.points.slice(0, 400).map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [NaN, NaN]));
    if (pts.length < 3 || !pts.every((p) => ok(p[0], p[1]))) return null;
    return { type: 'free', points: pts };
  }
  return null;
}

function act(g, p, b) {
  g.touched = Date.now();
  const isHost = p.id === g.hostId;
  switch (b.type) {
    case 'role':
      if (g.status !== 'lobby') throw new Error('Das Spiel läuft schon.');
      if (!['seeker', 'hider'].includes(b.role)) throw new Error('Ungültige Rolle.');
      p.role = b.role;
      break;
    case 'settings': {
      if (!isHost) throw new Error('Nur der Host kann das ändern.');
      if (g.status !== 'lobby') throw new Error('Das Spiel läuft schon.');
      const s = g.settings;
      if (b.durationMin !== undefined) s.durationMin = clamp(Math.round(Number(b.durationMin)) || 30, 5, 240);
      if (b.countdownSec !== undefined) s.countdownSec = clamp(Math.round(Number(b.countdownSec)) || 0, 0, 600);
      if (b.pingMin !== undefined) s.pingMin = clamp(Math.round(Number(b.pingMin)) || 3, 1, 10);
      if (b.area !== undefined) {
        const a = validArea(b.area);
        if (!a) throw new Error('Ungültiges Spielfeld.');
        s.area = a;
      }
      break;
    }
    case 'start': {
      if (!isHost) throw new Error('Nur der Host kann starten.');
      if (g.status !== 'lobby') throw new Error('Das Spiel läuft schon.');
      const list = [...g.players.values()];
      if (list.some((x) => !x.role)) throw new Error('Nicht alle haben eine Seite gewählt.');
      if (!list.some((x) => x.role === 'seeker') || !list.some((x) => x.role === 'hider'))
        throw new Error('Es braucht mindestens einen Sucher und einen Verstecker.');
      if (!g.settings.area) throw new Error('Das Spielfeld fehlt noch.');
      const now = Date.now();
      g.status = 'countdown';
      g.startAt = now + g.settings.countdownSec * 1000;
      g.endAt = g.startAt + g.settings.durationMin * 60e3;
      g.nextPing = g.startAt + g.settings.pingMin * 60e3;
      g.lastPing = null;
      g.final = null;
      g.endReason = null;
      for (const x of list) {
        x.pos = null;
        x.posAt = 0;
      }
      break;
    }
    case 'pos': {
      const lat = Number(b.lat),
        lng = Number(b.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
        throw new Error('Ungültige Position.');
      p.pos = { lat, lng };
      p.posAt = Date.now();
      return false; // kein Broadcast: Positionen bleiben geheim bis zum Ping
    }
    case 'end':
      if (!isHost) throw new Error('Nur der Host kann beenden.');
      if (g.status !== 'countdown' && g.status !== 'running') throw new Error('Kein laufendes Spiel.');
      finish(g, 'host');
      return false;
    case 'reset':
      if (!isHost) throw new Error('Nur der Host kann eine neue Runde starten.');
      if (g.status !== 'ended') throw new Error('Das Spiel ist noch nicht vorbei.');
      g.status = 'lobby';
      g.lastPing = null;
      g.final = null;
      g.endReason = null;
      g.startAt = g.endAt = g.nextPing = 0;
      break;
    case 'leave': {
      g.players.delete(p.id);
      const set = g.clients.get(p.id);
      if (set) for (const res of set) res.end();
      g.clients.delete(p.id);
      if (g.players.size === 0) {
        games.delete(g.code);
        return false;
      }
      if (g.hostId === p.id) g.hostId = g.players.keys().next().value;
      break;
    }
    default:
      throw new Error('Unbekannte Aktion.');
  }
  return true;
}

function readBody(req) {
  return new Promise((ok, no) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 2e5) {
        no(new Error('Anfrage zu groß.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        ok(JSON.parse(b || '{}'));
      } catch (e) {
        no(new Error('Ungültige Anfrage.'));
      }
    });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const g = games.get((url.searchParams.get('code') || '').toUpperCase());
    const pid = url.searchParams.get('pid');
    const p = g && g.players.get(pid);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (!p) {
      res.write('event: gone\ndata: {}\n\n');
      return res.end();
    }
    if (!g.clients.has(pid)) g.clients.set(pid, new Set());
    g.clients.get(pid).add(res);
    g.touched = Date.now();
    res.write('retry: 2000\n\n');
    broadcast(g);
    req.on('close', () => {
      const set = g.clients.get(pid);
      if (set) {
        set.delete(res);
        if (games.has(g.code)) broadcast(g);
      }
    });
    return;
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'Methode nicht erlaubt.' });
  try {
    const b = await readBody(req);
    if (url.pathname === '/api/create') {
      const g = createGame(b.name);
      return json(res, 200, { code: g.code, pid: g.hostId });
    }
    const g = games.get(String(b.code || '').toUpperCase());
    if (!g) return json(res, 404, { error: 'Spiel nicht gefunden. Prüfe den Code.' });
    if (url.pathname === '/api/join') {
      if (g.status !== 'lobby') return json(res, 400, { error: 'Das Spiel läuft schon.' });
      if (g.players.size >= 30) return json(res, 400, { error: 'Das Spiel ist voll.' });
      const pid = rid();
      g.players.set(pid, { id: pid, name: cleanName(b.name), role: null, pos: null, posAt: 0 });
      g.touched = Date.now();
      broadcast(g);
      return json(res, 200, { code: g.code, pid });
    }
    if (url.pathname === '/api/act') {
      const p = g.players.get(b.pid);
      if (!p) return json(res, 404, { error: 'Du bist nicht mehr im Spiel.' });
      if (act(g, p, b)) broadcast(g);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Nicht gefunden.' });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUB, path.basename(rel));
  if (!STATIC.has(path.basename(rel))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Nicht gefunden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Nicht gefunden');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    serveStatic(req, res, url);
  })
  .listen(PORT, () => console.log(`Versteckspiel läuft auf http://localhost:${PORT}`));
