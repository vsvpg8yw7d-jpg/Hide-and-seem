// Mr. X by Niklas – Server ohne externe Abhängigkeiten (nur Node.js >= 18).
// Echtzeit über Server-Sent Events (SSE), Aktionen über POST /api/*.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUB = __dirname;
const STATIC = new Set(['index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']);
const games = new Map();

const OUT_LIMIT_MS = 60 * 1000;        // nach 1 Minute außerhalb: Live-Standort für die Sucher
const EXPOSE_MS = 3 * 60 * 1000;       // so lange bleibt der Live-Standort sichtbar
const AUTO_CATCH_MS = 3 * 60 * 1000;   // nach 3 Minuten außerhalb: automatisch gefangen
const MAX_PINGS = 3;                   // aktueller Ping + 2 ältere
const MIN_SHRINK_FACTOR = 0.1;         // die Zone wird nie kleiner als 10 % der Startgröße
const MIN_RADIUS_M = 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
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

const newPlayer = (id, name) => ({
  id, name: cleanName(name), role: null, startRole: null, pos: null, posAt: 0,
  found: false, outSince: 0, expDone: false, exposedUntil: 0, expPending: false, lastChat: 0,
});
const resetPlayer = (x) =>
  Object.assign(x, { pos: null, posAt: 0, found: false, outSince: 0, expDone: false, exposedUntil: 0, expPending: false });

function createGame(hostName, mode) {
  const code = newCode();
  const hostId = rid();
  const g = {
    code,
    hostId,
    status: 'lobby', // lobby | countdown | running | ended
    touched: Date.now(),
    settings: { mode: mode === 'shrink' ? 'shrink' : 'normal', shrinkPct: 10, durationMin: 30, countdownSec: 60, pingMin: 3, area: null },
    players: new Map(),
    clients: new Map(), // playerId -> Set<res>
    startAt: 0,
    endAt: 0,
    nextPing: 0,
    pingCount: 0,
    pings: [],
    events: [],
    eventSeq: 0,
    chat: { seeker: [], hider: [] },
    chatSeq: 0,
    lastLive: 0,
    final: null,
    endReason: null,
  };
  g.players.set(hostId, newPlayer(hostId, hostName));
  games.set(code, g);
  return g;
}

function addEvent(g, type, text) {
  g.events.push({ id: ++g.eventSeq, type, text, at: Date.now() });
  if (g.events.length > 5) g.events.shift();
}

// ---------- Spielfeld (mit schrumpfender Zone) ----------
function scaledArea(a, f) {
  if (a.type === 'circle') return { ...a, radius: Math.max(MIN_RADIUS_M, Math.round(a.radius * f)) };
  const n = a.points.length;
  const cy = a.points.reduce((s, p) => s + p[0], 0) / n;
  const cx = a.points.reduce((s, p) => s + p[1], 0) / n;
  return { type: 'free', points: a.points.map((p) => [cy + (p[0] - cy) * f, cx + (p[1] - cx) * f]) };
}
const shrinkFactor = (g, steps) => Math.max(MIN_SHRINK_FACTOR, 1 - (g.settings.shrinkPct / 100) * steps);
function effectiveArea(g) {
  const base = g.settings.area;
  if (!base) return null;
  if (g.settings.mode !== 'shrink' || g.status === 'lobby') return base;
  return scaledArea(base, shrinkFactor(g, g.pingCount));
}
function nextArea(g) {
  const base = g.settings.area;
  if (!base || g.settings.mode !== 'shrink' || (g.status !== 'countdown' && g.status !== 'running')) return null;
  if (shrinkFactor(g, g.pingCount + 1) === shrinkFactor(g, g.pingCount)) return null; // schon am Minimum
  return scaledArea(base, shrinkFactor(g, g.pingCount + 1));
}

function inArea(a, lat, lng) {
  if (a.type === 'circle') {
    const [clat, clng] = a.center, R = 6371000, toR = Math.PI / 180;
    const dLat = (lat - clat) * toR;
    const dLng = (lng - clng) * toR * Math.cos(((lat + clat) / 2) * toR);
    return Math.hypot(dLat, dLng) * R <= a.radius;
  }
  let c = false;
  const r = a.points;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [yi, xi] = r[i], [yj, xj] = r[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// ---------- Ausgabe an die Spieler ----------
function view(g, pid) {
  const now = Date.now();
  const viewer = g.players.get(pid);
  const seeker = viewer && viewer.role === 'seeker';
  // Live-Standorte bekommen nur Sucher (auch ehemalige Verstecker), und nur von Verstecker:innen, die zu lange draußen waren
  const live = seeker && g.status === 'running'
    ? [...g.players.values()]
        .filter((p) => p.role === 'hider' && p.exposedUntil > now && p.pos)
        .map((p) => ({ id: p.id, name: p.name, lat: p.pos.lat, lng: p.pos.lng }))
    : [];
  return {
    code: g.code,
    status: g.status,
    now,
    hostId: g.hostId,
    settings: g.settings,
    area: effectiveArea(g),
    nextArea: nextArea(g),
    pingCount: g.pingCount,
    players: [...g.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      online: (g.clients.get(p.id)?.size || 0) > 0,
      found: p.found,
      exposedUntil: p.exposedUntil > now ? p.exposedUntil : 0,
    })),
    startAt: g.startAt,
    endAt: g.endAt,
    nextPing: g.nextPing,
    pings: g.pings,
    live,
    events: g.events,
    final: g.final,
    endReason: g.endReason,
  };
}

function broadcast(g) {
  for (const [pid, set] of g.clients) {
    if (!set.size) continue;
    const msg = `data: ${JSON.stringify(view(g, pid))}\n\n`;
    for (const res of set) res.write(msg);
  }
}

// Chat: Sucher und Verstecker haben getrennte Kanäle. Wer die Seite wechselt, sieht nur noch den neuen Kanal.
function sendChatTo(g, pid) {
  const p = g.players.get(pid), set = g.clients.get(pid);
  if (!p || !set) return;
  const msgs = p.role && g.status !== 'lobby' ? g.chat[p.role] : [];
  const msg = `event: chat\ndata: ${JSON.stringify({ role: p.role, msgs })}\n\n`;
  for (const res of set) res.write(msg);
}
function sendChatAll(g) {
  for (const pid of g.players.keys()) sendChatTo(g, pid);
}
function pushChat(g, role) {
  for (const p of g.players.values()) if (p.role === role) sendChatTo(g, p.id);
}

function finish(g, reason) {
  g.status = 'ended';
  g.endReason = reason;
  g.final = [...g.players.values()]
    .filter((p) => p.pos)
    .map((p) => ({ id: p.id, name: p.name, role: p.role, found: p.found, lat: p.pos.lat, lng: p.pos.lng }));
  broadcast(g);
}

function doPing(g, at) {
  const hiders = [...g.players.values()]
    .filter((p) => p.role === 'hider' && p.pos)
    .map((p) => ({ id: p.id, name: p.name, lat: p.pos.lat, lng: p.pos.lng, age: at - p.posAt }));
  g.pings.push({ at, hiders });
  if (g.pings.length > MAX_PINGS) g.pings.shift();
  g.pingCount++;
}

const unfound = (g) => [...g.players.values()].filter((p) => p.role === 'hider');

// Gefangen: wird Sucher, bekommt alle Rechte der Sucher und wechselt in den Sucher-Chat.
// Gibt true zurück, wenn das Spiel dadurch zu Ende ist.
function capture(g, t, text) {
  t.found = true;
  t.role = 'seeker';
  t.exposedUntil = 0;
  t.outSince = 0;
  t.expDone = false;
  t.expPending = false;
  addEvent(g, 'found', text);
  sendChatTo(g, t.id);
  if (unfound(g).length === 0) {
    finish(g, 'allfound');
    return true;
  }
  return false;
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
        if (g.settings.mode === 'shrink') addEvent(g, 'shrink', 'Die Zone schrumpft!');
        changed = true;
      }
      let ended = false;
      for (const p of g.players.values()) {
        if (p.role !== 'hider') continue;
        if (p.outSince) {
          const d = now - p.outSince;
          if (d >= AUTO_CATCH_MS) {
            if (capture(g, p, `${p.name} war zu lange außerhalb der Zone und wurde automatisch gefangen!`)) {
              ended = true;
              break;
            }
            changed = true;
            continue;
          }
          if (d >= OUT_LIMIT_MS && !p.expDone) {
            p.expDone = true;
            p.exposedUntil = now + EXPOSE_MS;
            p.expPending = true;
            addEvent(g, 'exposed', `${p.name} ist über 1 Minute außerhalb der Zone. Live-Standort für die Sucher!`);
            changed = true;
          }
        }
        if (p.expPending && now >= p.exposedUntil) {
          p.expPending = false;
          changed = true;
        }
      }
      if (ended) continue; // finish() hat schon gesendet
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
      if (b.mode !== undefined) s.mode = b.mode === 'shrink' ? 'shrink' : 'normal';
      if (b.shrinkPct !== undefined) s.shrinkPct = clamp(Math.round(Number(b.shrinkPct)) || 10, 5, 25);
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
      if (!p.role) throw new Error('Wähle zuerst selbst eine Seite.');
      const all = [...g.players.values()];
      const playing = all.filter((x) => x.role);
      if (!playing.some((x) => x.role === 'seeker') || !playing.some((x) => x.role === 'hider'))
        throw new Error('Es braucht mindestens einen Sucher und einen Verstecker.');
      if (!g.settings.area) throw new Error('Das Spielfeld fehlt noch.');
      // Wer keine Seite gewählt hat, ist nicht dabei
      for (const x of all.filter((y) => !y.role)) {
        const set = g.clients.get(x.id);
        if (set) for (const res of set) { res.write('event: kicked\ndata: {}\n\n'); res.end(); }
        g.clients.delete(x.id);
        g.players.delete(x.id);
      }
      const now = Date.now();
      g.status = 'countdown';
      g.startAt = now + g.settings.countdownSec * 1000;
      g.endAt = g.startAt + g.settings.durationMin * 60e3;
      g.nextPing = g.startAt + g.settings.pingMin * 60e3;
      g.pingCount = 0;
      g.pings = [];
      g.events = [];
      g.chat = { seeker: [], hider: [] };
      g.final = null;
      g.endReason = null;
      for (const x of g.players.values()) {
        x.startRole = x.role;
        resetPlayer(x);
      }
      broadcast(g);
      sendChatAll(g);
      return false;
    }
    case 'pos': {
      const lat = Number(b.lat),
        lng = Number(b.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
        throw new Error('Ungültige Position.');
      const now = Date.now();
      p.pos = { lat, lng };
      p.posAt = now;
      const area = effectiveArea(g);
      if (g.status === 'running' && p.role === 'hider' && area) {
        if (!inArea(area, lat, lng)) {
          if (!p.outSince) p.outSince = now;
        } else {
          p.outSince = 0;
          p.expDone = false;
        }
      }
      // Während der Enthüllung bekommen die Sucher Live-Updates (gedrosselt)
      if (p.exposedUntil > now && now - g.lastLive > 1500) {
        g.lastLive = now;
        broadcast(g);
      }
      return false; // sonst kein Broadcast: Positionen bleiben geheim bis zum Ping
    }
    case 'found': {
      if (g.status !== 'running') throw new Error('Gefangen melden geht nur während der Suche.');
      const t = g.players.get(b.target);
      if (!t || t.role !== 'hider') throw new Error('Diese Person ist kein Verstecker.');
      if (p.role !== 'seeker' && p.id !== t.id) throw new Error('Nur Sucher können das melden.');
      if (capture(g, t, `${t.name} wurde gefangen und ist jetzt Sucher!`)) return false;
      break;
    }
    case 'chat': {
      if (g.status === 'lobby') throw new Error('Der Chat läuft erst im Spiel.');
      if (!p.role) throw new Error('Du bist in keinem Team.');
      const text = String(b.text || '').trim().slice(0, 200);
      if (!text) return false;
      const now = Date.now();
      if (now - p.lastChat < 600) throw new Error('Nicht so schnell.');
      p.lastChat = now;
      const list = g.chat[p.role];
      list.push({ id: ++g.chatSeq, pid: p.id, name: p.name, text, at: now });
      if (list.length > 80) list.shift();
      pushChat(g, p.role);
      return false;
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
      g.pingCount = 0;
      g.pings = [];
      g.events = [];
      g.chat = { seeker: [], hider: [] };
      g.final = null;
      g.endReason = null;
      g.startAt = g.endAt = g.nextPing = 0;
      for (const x of g.players.values()) {
        x.role = x.startRole || x.role; // gefangene Verstecker bekommen ihre Rolle zurück
        resetPlayer(x);
      }
      broadcast(g);
      sendChatAll(g);
      return false;
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
      if ((g.status === 'running' || g.status === 'countdown') && unfound(g).length === 0) {
        finish(g, [...g.players.values()].some((x) => x.startRole === 'hider') ? 'allfound' : 'nohiders');
        return false;
      }
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
    sendChatTo(g, pid);
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
      const g = createGame(b.name, b.mode);
      return json(res, 200, { code: g.code, pid: g.hostId });
    }
    const g = games.get(String(b.code || '').toUpperCase());
    if (!g) return json(res, 404, { error: 'Spiel nicht gefunden. Prüfe den Code.' });
    if (url.pathname === '/api/join') {
      if (g.status !== 'lobby') return json(res, 400, { error: 'Das Spiel läuft schon.' });
      if (g.players.size >= 40) return json(res, 400, { error: 'Das Spiel ist voll.' });
      const pid = rid();
      g.players.set(pid, newPlayer(pid, b.name));
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
  const name = path.basename(rel);
  if (!STATIC.has(name)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Nicht gefunden');
  }
  fs.readFile(path.join(PUB, name), (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Nicht gefunden');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    serveStatic(req, res, url);
  })
  .listen(PORT, () => console.log(`Mr. X läuft auf http://localhost:${PORT}`));
