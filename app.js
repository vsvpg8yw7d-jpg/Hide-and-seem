(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const vibrate = (p) => { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} };

  let S = null;            // letzter Spielstand vom Server
  let off = 0;             // Serverzeit minus Gerätezeit
  let session = null;      // {code, pid}
  let es = null;           // EventSource
  let myPos = null;        // {lat,lng,acc}
  let watchId = null;
  let geoDenied = false;
  let M = null;            // aktuelle Karte
  let mode = 'circle';     // Host-Werkzeug: circle | free
  let initAreaSent = false;
  let lastPingAt = 0;
  let lastEventId = null;  // zuletzt gezeigte Eilmeldung
  let wakeLock = null;
  let showMapAfterEnd = false;
  let endConfirm = false;
  let foundConfirm = null; // Spieler-ID, die gerade "Gefunden?" bestätigt werden soll
  let outLocalSince = 0;   // wann ich selbst das Spielfeld verlassen habe

  // ---------- Hilfen ----------
  const api = (p, body) =>
    fetch('/api/' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'Etwas ist schiefgelaufen.');
        return j;
      });
  const act = (type, data = {}) =>
    api('act', { code: session.code, pid: session.pid, type, ...data }).catch((e) => { toast(e.message); });

  let toastT;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => (t.hidden = true), 3500);
  }
  const isHost = () => S && session && S.hostId === session.pid;
  const me = () => S && S.players.find((p) => p.id === session.pid);
  const nowS = () => Date.now() + off;
  const fmt = (ms) => {
    ms = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(ms / 3600), m = Math.floor((ms % 3600) / 60), s = ms % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };
  function show(id) {
    for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id;
  }
  const gameActive = () => S && (S.status === 'running' || S.status === 'countdown');

  // ---------- Eilmeldung + rotes Blinken ----------
  let newsT;
  function showNews(text, ms) {
    const n = $('#news');
    n.innerHTML = '<div class="news-label">Eilmeldung</div><div class="news-track"><span class="news-text"></span></div>';
    const t = n.querySelector('.news-text');
    t.textContent = text;
    t.style.animationDuration = ms + 'ms'; // Lauftext: läuft in der Restzeit der 10 Sekunden einmal durch
    n.hidden = false;
    clearTimeout(newsT);
    newsT = setTimeout(() => (n.hidden = true), ms);
  }
  function redTint() {
    const f = $('#flash');
    f.classList.remove('tint');
    void f.offsetWidth; // Animation neu starten
    f.classList.add('tint');
    setTimeout(() => f.classList.remove('tint'), 4100);
  }
  function processEvent() {
    const ev = S.event;
    if (!ev || ev.id === lastEventId) return;
    lastEventId = ev.id;
    const left = 10000 - (nowS() - ev.at);
    if (left <= 0) return; // alte Meldung, z. B. nach dem Neuladen
    showNews(ev.text, left);
    redTint();
    vibrate([400, 150, 400]);
  }

  // ---------- Standort ----------
  function startGeo() {
    if (!navigator.geolocation) { geoDenied = true; updateGeoWarn(); return; }
    if (watchId != null) return;
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        myPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
        geoDenied = false; updateGeoWarn(); onPos();
      },
      (err) => {
        if (err.code === 1) { geoDenied = true; updateGeoWarn(); }
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 }
    );
  }
  function updateGeoWarn() {
    $('#geoWarn').hidden = !geoDenied;
    $('#geoWarn2').hidden = !geoDenied;
  }
  function onPos() {
    updateMe();
    maybeInitArea();
    updateOutWarn();
    sendPos();
  }
  let lastSent = 0;
  function sendPos(force) {
    if (!session || !S || !myPos) return;
    if (!gameActive()) return;
    const t = Date.now();
    if (!force && t - lastSent < 4000) return;
    lastSent = t;
    api('act', { code: session.code, pid: session.pid, type: 'pos', lat: myPos.lat, lng: myPos.lng }).catch(() => {});
  }
  setInterval(() => sendPos(true), 5000); // Lebenszeichen, auch wenn man stillsteht

  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => (wakeLock = null));
      }
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S && S.status !== 'lobby') keepAwake();
  });

  // ---------- Geometrie ----------
  function ring(a) {
    if (!a) return null;
    if (a.type === 'free') return a.points;
    const [lat, lng] = a.center, R = 6371000, pts = [];
    for (let i = 0; i < 72; i++) {
      const t = (i / 72) * 2 * Math.PI;
      const dLat = ((a.radius * Math.cos(t)) / R) * (180 / Math.PI);
      const dLng = ((a.radius * Math.sin(t)) / (R * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
      pts.push([lat + dLat, lng + dLng]);
    }
    return pts;
  }
  function inside(r, lat, lng) {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [yi, xi] = r[i], [yj, xj] = r[j];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  // Warnung außerhalb des Spielfelds: nur für Verstecker und erst nach dem Countdown.
  // Nach 1 Minute draußen werden sie 3 Minuten lang live für die Sucher sichtbar.
  function updateOutWarn() {
    const warn = $('#outWarn'), flash = $('#flash');
    const m = me();
    const r = S && ring(S.settings.area);
    const hiderNow = !!(m && m.role === 'hider' && S.status === 'running');
    const out = !!(hiderNow && r && myPos && !inside(r, myPos.lat, myPos.lng));
    if (out) { if (!outLocalSince) { outLocalSince = Date.now(); vibrate([300, 120, 300]); } } else outLocalSince = 0;
    flash.classList.toggle('alarm', out);

    const exposedLeft = hiderNow && m.exposedUntil ? m.exposedUntil - nowS() : 0;
    let text = '';
    if (out) {
      if (exposedLeft > 0) text = `Außerhalb! Die Sucher sehen deinen Live-Standort noch ${fmt(exposedLeft)}.`;
      else {
        const sec = Math.max(0, 60 - Math.floor((Date.now() - outLocalSince) / 1000));
        text = `Du bist außerhalb des Spielfelds! In ${sec} Sek. sehen die Sucher deinen Live-Standort.`;
      }
    } else if (exposedLeft > 0) {
      text = `Die Sucher sehen deinen Live-Standort noch ${fmt(exposedLeft)}.`;
    }
    warn.hidden = !text;
    warn.textContent = text;
  }

  // ---------- Karte ----------
  function ensureMap(id) {
    const el = document.getElementById(id);
    if (M && M.el === el) return M;
    if (M) { M.map.remove(); M = null; }
    const map = L.map(el, { zoomControl: false, attributionControl: true })
      .setView(myPos ? [myPos.lat, myPos.lng] : [52.52, 13.405], 16);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    M = { el, map, areaLayer: L.layerGroup().addTo(map), areaKey: '', meMarker: null, meCircle: null,
          pingLayer: L.layerGroup().addTo(map), pingKey: '', liveLayer: L.layerGroup().addTo(map), liveKey: '',
          endLayer: L.layerGroup().addTo(map), endKey: '', fitted: false };
    setTimeout(() => map.invalidateSize(), 50);
    map.on('click', (e) => {
      if (!isHost() || !S || S.status !== 'lobby' || mode !== 'circle') return;
      const a = S.settings.area;
      act('settings', { area: { type: 'circle', center: [e.latlng.lat, e.latlng.lng], radius: a && a.type === 'circle' ? a.radius : +$('#radius').value } });
    });
    attachDraw(el);
    updateMe();
    return M;
  }

  function updateMe() {
    if (!M || !myPos) return;
    const ll = [myPos.lat, myPos.lng];
    const role = me() && me().role;
    if (!M.meMarker) {
      M.meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: `<div class="me-dot ${role === 'hider' ? 'hider' : ''}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false, zIndexOffset: 1000 }).addTo(M.map);
      M.meCircle = L.circle(ll, { radius: myPos.acc || 10, color: '#46c2ff', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(M.map);
      if (!S || !S.settings.area) M.map.setView(ll, 16);
    } else {
      M.meMarker.setLatLng(ll);
      M.meCircle.setLatLng(ll).setRadius(myPos.acc || 10);
      const el = M.meMarker.getElement() && M.meMarker.getElement().firstChild;
      if (el) el.classList.toggle('hider', role === 'hider');
    }
  }

  function drawArea() {
    if (!M || !S) return;
    const a = S.settings.area;
    const key = JSON.stringify(a);
    if (key === M.areaKey) return;
    M.areaKey = key;
    M.areaLayer.clearLayers();
    const r = ring(a);
    if (!r) return;
    const world = [[-85, -180], [-85, 180], [85, 180], [85, -180]];
    L.polygon([world, r], { stroke: false, fillColor: '#07120b', fillOpacity: 0.45, interactive: false }).addTo(M.areaLayer);
    const outline = L.polygon(r, { color: '#ffd166', weight: 3, fill: false, dashArray: '8 6', interactive: false }).addTo(M.areaLayer);
    if (!M.fitted || !isHost() || S.status !== 'lobby') {
      M.map.fitBounds(outline.getBounds(), { padding: [30, 30] });
      M.fitted = true;
    }
  }

  // Pings: der neueste Punkt ist voll sichtbar, die zwei davor werden blasser; danach verschwinden sie
  function drawPings() {
    if (!M || !S) return;
    const pings = S.pings || [];
    const key = pings.map((p) => p.at).join(',');
    if (key === M.pingKey) return;
    M.pingKey = key;
    M.pingLayer.clearLayers();
    const n = pings.length;
    const by = {};
    pings.forEach((pg, i) => {
      for (const h of pg.hiders) (by[h.id] = by[h.id] || []).push({ ...h, age: n - 1 - i, at: pg.at });
    });
    for (const id in by) {
      const arr = by[id];
      if (arr.length > 1) L.polyline(arr.map((a) => [a.lat, a.lng]), { color: '#ff8a3d', weight: 2, opacity: 0.5, dashArray: '4 6', interactive: false }).addTo(M.pingLayer);
      for (const a of arr) {
        const t = new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const label = a.age === 0 ? `<b>${esc(a.name)} · ${t}</b>` : '';
        L.marker([a.lat, a.lng], {
          icon: L.divIcon({ className: '', html: `<div class="pingmark age${a.age}"><i></i>${label}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
          interactive: false, zIndexOffset: 100 - a.age * 10,
        }).addTo(M.pingLayer);
      }
    }
  }

  // Live-Standorte von Verstecker:innen, die zu lange außerhalb waren (nur Sucher bekommen sie vom Server)
  function drawLive() {
    if (!M || !S) return;
    const live = S.live || [];
    const key = JSON.stringify(live);
    if (key === M.liveKey) return;
    M.liveKey = key;
    M.liveLayer.clearLayers();
    for (const h of live) {
      L.marker([h.lat, h.lng], {
        icon: L.divIcon({ className: '', html: `<div class="pingmark live"><i></i><b>${esc(h.name)} · LIVE</b></div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
        interactive: false, zIndexOffset: 500,
      }).addTo(M.liveLayer);
    }
  }

  function drawFinal() {
    if (!M || !S) return;
    const key = S.status === 'ended' ? 'e' + (S.final ? S.final.length : 0) : '';
    if (key === M.endKey) return;
    M.endKey = key;
    M.endLayer.clearLayers();
    if (S.status !== 'ended' || !S.final) return;
    const pts = [];
    for (const p of S.final) {
      pts.push([p.lat, p.lng]);
      L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className: '', html: `<div class="pingmark endmark ${p.role}"><i></i><b>${esc(p.name)}${p.found ? ' · gefangen' : ''}</b></div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
        interactive: false,
      }).addTo(M.endLayer);
    }
    if (pts.length) M.map.fitBounds(pts, { padding: [50, 50], maxZoom: 18 });
  }

  // ---------- Freihand zeichnen (nur Host in der Lobby) ----------
  function attachDraw(el) {
    let pts = null, line = null;
    const pt = (e) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const toLL = (p) => M.map.containerPointToLatLng([p.x, p.y]);
    el.addEventListener('pointerdown', (e) => {
      if (mode !== 'free' || !isHost() || !S || S.status !== 'lobby') return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      pts = [pt(e)];
      if (line) line.remove();
      line = L.polyline([], { color: '#ffd166', weight: 4, interactive: false }).addTo(M.map);
    });
    el.addEventListener('pointermove', (e) => {
      if (!pts) return;
      const p = pt(e), l = pts[pts.length - 1];
      if (Math.hypot(p.x - l.x, p.y - l.y) > 6) { pts.push(p); line.setLatLngs(pts.map(toLL)); }
    });
    const done = () => {
      if (!pts) return;
      const raw = pts; pts = null;
      if (line) { line.remove(); line = null; }
      if (raw.length < 8) { toast('Zieh eine größere Linie um das Spielfeld.'); return; }
      const step = Math.max(1, Math.ceil(raw.length / 300));
      const points = raw.filter((_, i) => i % step === 0).map((p) => { const l = toLL(p); return [+l.lat.toFixed(6), +l.lng.toFixed(6)]; });
      act('settings', { area: { type: 'free', points } });
    };
    el.addEventListener('pointerup', done);
    el.addEventListener('pointercancel', done);
  }
  function applyMode() {
    $('#modeCircle').classList.toggle('on', mode === 'circle');
    $('#modeFree').classList.toggle('on', mode === 'free');
    $('#radiusRow').hidden = mode !== 'circle';
    if (M) {
      const on = mode === 'free' && isHost() && S && S.status === 'lobby';
      const fn = on ? 'disable' : 'enable';
      M.map.dragging[fn](); M.map.touchZoom[fn](); M.map.doubleClickZoom[fn]();
      M.el.classList.toggle('drawing', on);
    }
    $('#mapHint').textContent = isHost()
      ? (mode === 'circle'
        ? 'Tippe auf die Karte, um die Mitte zu setzen. Der Regler stellt den Radius ein.'
        : 'Zieh mit dem Finger eine Linie um das Spielfeld. Sie wird automatisch geschlossen.')
      : 'Der Host legt das Spielfeld fest. Du siehst es hier.';
  }

  function maybeInitArea(force) {
    if (!S || !session || !isHost() || S.status !== 'lobby' || S.settings.area || initAreaSent) return;
    const c = myPos ? [myPos.lat, myPos.lng] : force && M ? [M.map.getCenter().lat, M.map.getCenter().lng] : null;
    if (!c) return;
    initAreaSent = true;
    act('settings', { area: { type: 'circle', center: c, radius: +$('#radius').value } });
  }

  // ---------- Rendering ----------
  function render() {
    if (!S) return;
    processEvent();
    if (S.status === 'lobby') renderLobby(); else renderGame();
  }

  function renderLobby() {
    show('v-lobby');
    $('#flash').classList.remove('alarm');
    $('#outWarn').hidden = true;
    $('#codeShow').textContent = S.code;
    const joinUrl = `${location.origin}${location.pathname}?join=${S.code}`;
    if ($('#qr').dataset.url !== joinUrl) {
      $('#qr').dataset.url = joinUrl;
      try {
        const qr = qrcode(0, 'M'); qr.addData(joinUrl); qr.make();
        $('#qr').innerHTML = qr.createImgTag(6, 0);
      } catch (e) { $('#qr').textContent = S.code; }
    }
    const chip = (p) => `<span class="chip ${p.online ? '' : 'off'}">${esc(p.name)}${p.id === S.hostId ? ' <small>Host</small>' : ''}${p.id === session.pid ? ' <small>du</small>' : ''}</span>`;
    $('#listSeeker').innerHTML = S.players.filter((p) => p.role === 'seeker').map(chip).join('');
    $('#listHider').innerHTML = S.players.filter((p) => p.role === 'hider').map(chip).join('');
    const un = S.players.filter((p) => !p.role);
    $('#undecided').hidden = !un.length;
    $('#undecided').textContent = un.length ? 'Noch ohne Seite: ' + un.map((p) => p.name).join(', ') : '';
    const mine = me() && me().role;
    $('#teamSeeker').classList.toggle('mine', mine === 'seeker');
    $('#teamHider').classList.toggle('mine', mine === 'hider');

    const st = S.settings, host = isHost();
    $('.settings').classList.toggle('locked', !host);
    $('#durOut').textContent = st.durationMin + ' min';
    $('#cdSel').value = String(st.countdownSec);
    $('#pingSel').value = String(st.pingMin);
    $('#areaTools').hidden = !host;
    if (document.activeElement !== $('#radius') && st.area && st.area.type === 'circle') $('#radius').value = st.area.radius;
    $('#radiusOut').textContent = $('#radius').value + ' m';

    ensureMap('lobbyMap');
    drawArea(); updateMe(); applyMode();
    maybeInitArea();
    if (host && !st.area && !initAreaSent) setTimeout(() => maybeInitArea(true), 5000);

    $('#btnStart').hidden = !host;
    $('#waitMsg').hidden = host;
    const why = startProblem();
    $('#btnStart').disabled = !!why;
    $('#startMsg').textContent = host ? why || '' : '';
    $('#btnLeaveLobby').textContent = host ? 'Lobby schließen' : 'Lobby verlassen';
  }

  function startProblem() {
    if (!S) return '';
    const list = S.players;
    if (list.some((p) => !p.role)) return 'Alle müssen eine Seite wählen.';
    if (!list.some((p) => p.role === 'seeker') || !list.some((p) => p.role === 'hider')) return 'Es braucht mindestens einen Sucher und einen Verstecker.';
    if (!S.settings.area) return 'Das Spielfeld wird noch angelegt.';
    return '';
  }

  // Spielerliste unter der Karte; Sucher tippen auf einen Verstecker = "gefunden"
  function renderRoster() {
    const meP = me();
    if (!meP) return;
    const running = S.status === 'running';
    const group = (role, label) => {
      const items = S.players.filter((p) => p.role === role).map((p) => {
        const canTap = running && role === 'hider' && (meP.role === 'seeker' || p.id === meP.id);
        const cls = ['pchip', role, foundConfirm === p.id ? 'confirm' : ''].filter(Boolean).join(' ');
        const name = esc(p.name) + (p.id === meP.id ? ' <small>du</small>' : '');
        if (canTap) {
          const txt = foundConfirm === p.id ? (p.id === meP.id ? 'Ich wurde gefunden? Nochmal tippen' : esc(p.name) + ' gefunden? Nochmal tippen') : name;
          return `<button class="${cls}" data-id="${p.id}">${txt}</button>`;
        }
        const tag = p.found ? ' <small>gefangen</small>' : (S.live || []).some((l) => l.id === p.id) ? ' <small>LIVE</small>' : '';
        return `<span class="${cls}">${name}${tag}</span>`;
      }).join('');
      return `<div class="rgroup"><span class="rlabel">${label}</span>${items}</div>`;
    };
    const html = group('seeker', 'Sucher') + group('hider', 'Verstecker');
    const r = $('#roster');
    if (r.dataset.h !== html) { r.innerHTML = html; r.dataset.h = html; }
  }
  $('#roster').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b || !S || S.status !== 'running') return;
    const id = b.dataset.id;
    if (foundConfirm === id) { foundConfirm = null; act('found', { target: id }); renderRoster(); return; }
    foundConfirm = id;
    renderRoster();
    setTimeout(() => { if (foundConfirm === id) { foundConfirm = null; if (S) renderRoster(); } }, 4000);
  });

  function renderGame() {
    show('v-game');
    const m = me();
    const role = m && m.role;
    const tag = $('#roleTag');
    tag.textContent = role === 'hider' ? 'Verstecker' : 'Sucher';
    tag.className = 'roletag ' + (role === 'hider' ? 'hider' : 'seeker');
    ensureMap('gameMap');
    drawArea(); drawPings(); drawLive(); drawFinal(); updateMe(); updateOutWarn(); renderRoster();
    if (M.map.dragging && !M.map.dragging.enabled()) { M.map.dragging.enable(); M.map.touchZoom.enable(); M.map.doubleClickZoom.enable(); M.el.classList.remove('drawing'); }
    $('#btnEnd').hidden = !(isHost() && S.status !== 'ended');
    $('#btnEnd').textContent = endConfirm ? 'Wirklich beenden?' : 'Spiel beenden';

    const lp = S.pings && S.pings.length ? S.pings[S.pings.length - 1].at : 0;
    if (lp && lp !== lastPingAt) {
      if (lastPingAt) { toast('Ping! Die Verstecker sind aktualisiert.'); vibrate([200, 100, 200]); }
      lastPingAt = lp;
    }
    if (!lp) lastPingAt = 0;
    if (S.status !== 'ended') { showMapAfterEnd = false; keepAwake(); }

    const end = S.status === 'ended';
    $('#endCard').hidden = !(end && !showMapAfterEnd);
    if (end) {
      const left = S.players.filter((p) => p.role === 'hider').map((p) => p.name);
      const T = {
        time: ['Zeit abgelaufen', left.length ? `Die Verstecker haben gewonnen. Nicht gefunden: ${left.join(', ')}.` : 'Die Verstecker haben durchgehalten.'],
        allfound: ['Alle gefangen', 'Alle Verstecker wurden gefangen. Die Sucher haben gewonnen.'],
        nohiders: ['Keine Verstecker mehr', 'Alle Verstecker haben das Spiel verlassen.'],
        host: ['Beendet vom Host', 'Der Host hat das Spiel beendet.'],
      }[S.endReason] || ['Spiel vorbei', ''];
      $('#endTitle').textContent = T[0];
      $('#endText').textContent = T[1];
      $('#btnReset').hidden = !isHost();
    }
    tick();
  }

  function tick() {
    if (!S || S.status === 'lobby') return;
    const now = nowS();
    const hint = $('#gameHint'), mapNote = $('#mapNote');
    const m = me();
    const role = m && m.role;
    if (S.status === 'countdown') {
      $('#phase').textContent = 'Start in';
      $('#timer').textContent = fmt(S.startAt - now);
      $('#pingTimer').textContent = '--:--';
      hint.textContent = role === 'hider' ? 'Versteck dich! Die Sucher warten, bis der Countdown abläuft.' : 'Warte, bis der Countdown abläuft. Dann geht die Suche los.';
    } else if (S.status === 'running') {
      $('#phase').textContent = 'Restzeit';
      $('#timer').textContent = fmt(S.endAt - now);
      const np = S.nextPing - now;
      $('#pingTimer').textContent = S.nextPing < S.endAt ? fmt(np) : '--:--';
      hint.textContent = role === 'seeker'
        ? 'Tippe auf einen Verstecker in der Liste, wenn du ihn gefangen hast.'
        : `Alle ${S.settings.pingMin} Min. sehen die Sucher kurz, wo du warst. Wirst du gefangen, tippe auf deinen Namen. Dann wirst du Sucher.`;
    } else {
      $('#phase').textContent = 'Beendet';
      $('#timer').textContent = '00:00';
      $('#pingTimer').textContent = '--:--';
      hint.textContent = '';
    }
    const hiders = S.players.filter((p) => p.role === 'hider');
    const total = hiders.length + S.players.filter((p) => p.found).length;
    let note = S.status === 'running' ? `Noch ${hiders.length} von ${total} Verstecker frei.` : '';
    if (S.status === 'running' && !(S.pings && S.pings.length) && role === 'seeker') note += ' Noch kein Ping.';
    mapNote.textContent = note;
    if (S.status !== 'ended') updateOutWarn();
  }
  setInterval(tick, 250);

  // ---------- Verbindung ----------
  function connect() {
    if (es) es.close();
    es = new EventSource(`/api/events?code=${encodeURIComponent(session.code)}&pid=${encodeURIComponent(session.pid)}`);
    es.onmessage = (e) => {
      S = JSON.parse(e.data);
      off = S.now - Date.now();
      render();
    };
    es.addEventListener('gone', () => leaveLocal('Dieses Spiel gibt es nicht mehr.'));
  }

  function enter(s) {
    session = s;
    store.set('vs-session', JSON.stringify(s));
    initAreaSent = false;
    startGeo();
    connect();
  }

  function leaveLocal(msg) {
    if (es) { es.close(); es = null; }
    if (M) { M.map.remove(); M = null; }
    session = null; S = null; lastPingAt = 0; lastEventId = null; initAreaSent = false; endConfirm = false; foundConfirm = null; outLocalSince = 0;
    $('#flash').classList.remove('alarm', 'tint');
    $('#news').hidden = true; $('#outWarn').hidden = true;
    store.del('vs-session');
    history.replaceState(null, '', location.pathname);
    show('v-home');
    if (msg) toast(msg);
  }

  const getName = () => { const n = $('#name').value.trim(); store.set('vs-name', n); return n; };

  // ---------- Ereignisse ----------
  $('#btnHost').onclick = async () => {
    const name = getName();
    if (!name) { toast('Gib zuerst deinen Namen ein.'); $('#name').focus(); return; }
    startGeo();
    try { enter(await api('create', { name })); } catch (e) { toast(e.message); }
  };
  $('#btnJoin').onclick = async () => {
    const name = getName(), code = $('#codeIn').value.trim().toUpperCase();
    if (!name) { toast('Gib zuerst deinen Namen ein.'); $('#name').focus(); return; }
    if (code.length !== 4) { toast('Der Code hat 4 Zeichen.'); $('#codeIn').focus(); return; }
    startGeo();
    try { enter(await api('join', { name, code })); history.replaceState(null, '', location.pathname); } catch (e) { toast(e.message); }
  };
  $('#codeIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnJoin').click(); });

  for (const b of document.querySelectorAll('.team')) b.onclick = () => act('role', { role: b.dataset.role });

  $('#durMinus').onclick = () => isHost() && act('settings', { durationMin: S.settings.durationMin - 5 });
  $('#durPlus').onclick = () => isHost() && act('settings', { durationMin: S.settings.durationMin + 5 });
  $('#cdSel').onchange = (e) => act('settings', { countdownSec: +e.target.value });
  $('#pingSel').onchange = (e) => act('settings', { pingMin: +e.target.value });

  $('#modeCircle').onclick = () => {
    mode = 'circle'; applyMode();
    const a = S && S.settings.area;
    if (a && a.type !== 'circle') {
      const c = myPos ? [myPos.lat, myPos.lng] : [M.map.getCenter().lat, M.map.getCenter().lng];
      act('settings', { area: { type: 'circle', center: c, radius: +$('#radius').value } });
    }
  };
  $('#modeFree').onclick = () => { mode = 'free'; applyMode(); };
  let radT;
  $('#radius').oninput = () => {
    $('#radiusOut').textContent = $('#radius').value + ' m';
    clearTimeout(radT);
    radT = setTimeout(() => {
      const a = S && S.settings.area;
      const c = a && a.type === 'circle' ? a.center : myPos ? [myPos.lat, myPos.lng] : [M.map.getCenter().lat, M.map.getCenter().lng];
      act('settings', { area: { type: 'circle', center: c, radius: +$('#radius').value } });
    }, 250);
  };

  const locate = () => { if (M && myPos) M.map.setView([myPos.lat, myPos.lng], Math.max(M.map.getZoom(), 16)); else toast('Dein Standort ist noch nicht bekannt.'); };
  $('#btnLocate').onclick = locate;
  $('#btnLocate2').onclick = locate;

  $('#btnCopy').onclick = async () => {
    const url = `${location.origin}${location.pathname}?join=${S.code}`;
    try { await navigator.clipboard.writeText(url); toast('Link kopiert.'); } catch (e) { toast(url); }
  };
  $('#btnStart').onclick = () => { keepAwake(); act('start'); };
  $('#btnLeaveLobby').onclick = async () => { await act('leave'); leaveLocal(); };
  $('#btnLeaveGame').onclick = async () => { await act('leave'); leaveLocal(); };
  $('#btnLeaveEnd').onclick = async () => { await act('leave'); leaveLocal(); };
  $('#btnEnd').onclick = () => {
    if (!endConfirm) { endConfirm = true; $('#btnEnd').textContent = 'Wirklich beenden?'; setTimeout(() => { endConfirm = false; if (S) $('#btnEnd').textContent = 'Spiel beenden'; }, 4000); return; }
    endConfirm = false; act('end');
  };
  $('#btnReset').onclick = () => act('reset');
  $('#btnCloseEnd').onclick = () => { showMapAfterEnd = true; $('#endCard').hidden = true; };

  // Tipp für iPhone: als App auf den Home-Bildschirm legen
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  $('#a2hs').hidden = !(isIOS && !standalone);

  // ---------- Start ----------
  $('#name').value = store.get('vs-name') || '';
  const joinParam = (new URLSearchParams(location.search).get('join') || '').toUpperCase().slice(0, 4);
  let saved = null;
  try { saved = JSON.parse(store.get('vs-session') || 'null'); } catch (e) {}
  if (saved && saved.code && saved.pid && (!joinParam || joinParam === saved.code)) {
    enter(saved);
  } else {
    if (joinParam) {
      $('#codeIn').value = joinParam;
      $('#btnHost').hidden = true;
      document.querySelector('.or').hidden = true;
      $('.lead').textContent = `Du wurdest in die Lobby ${joinParam} eingeladen. Gib deinen Namen ein.`;
    }
    show('v-home');
  }
})();
