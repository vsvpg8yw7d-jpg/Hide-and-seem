(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  let wakeLock = null;
  let showMapAfterEnd = false;
  let endConfirm = false;

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
    if (S.status !== 'countdown' && S.status !== 'running') return;
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
  function updateOutWarn() {
    const r = S && ring(S.settings.area);
    const active = S && (S.status === 'running' || S.status === 'countdown');
    $('#outWarn').hidden = !(active && r && myPos && !inside(r, myPos.lat, myPos.lng));
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
          pingLayer: L.layerGroup().addTo(map), pingKey: '', endLayer: L.layerGroup().addTo(map), endKey: '', fitted: false };
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

  function drawPings() {
    if (!M || !S) return;
    const lp = S.lastPing;
    const key = lp ? String(lp.at) : '';
    if (key === M.pingKey) return;
    M.pingKey = key;
    M.pingLayer.clearLayers();
    if (!lp) return;
    const t = new Date(lp.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    for (const h of lp.hiders) {
      L.marker([h.lat, h.lng], {
        icon: L.divIcon({ className: '', html: `<div class="pingmark"><i></i><b>${esc(h.name)} · ${t}</b></div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
        interactive: false,
      }).addTo(M.pingLayer);
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
        icon: L.divIcon({ className: '', html: `<div class="pingmark endmark ${p.role}"><i></i><b>${esc(p.name)}</b></div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
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
    if (S.status === 'lobby') renderLobby(); else renderGame();
  }

  function renderLobby() {
    show('v-lobby');
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

  function renderGame() {
    show('v-game');
    const role = me() && me().role;
    const tag = $('#roleTag');
    tag.textContent = role === 'hider' ? 'Verstecker' : 'Sucher';
    tag.className = 'roletag ' + (role === 'hider' ? 'hider' : 'seeker');
    ensureMap('gameMap');
    drawArea(); drawPings(); drawFinal(); updateMe(); updateOutWarn();
    if (M.map.dragging && !M.map.dragging.enabled()) { M.map.dragging.enable(); M.map.touchZoom.enable(); M.map.doubleClickZoom.enable(); M.el.classList.remove('drawing'); }
    $('#btnEnd').hidden = !(isHost() && S.status !== 'ended');
    $('#btnEnd').textContent = endConfirm ? 'Wirklich beenden?' : 'Spiel beenden';

    if (S.lastPing && S.lastPing.at !== lastPingAt) {
      if (lastPingAt) { toast('Ping! Die Verstecker sind aktualisiert.'); if (navigator.vibrate) navigator.vibrate([200, 100, 200]); }
      lastPingAt = S.lastPing.at;
    }
    if (S.status === 'lobby') lastPingAt = 0;
    if (S.status !== 'ended') { showMapAfterEnd = false; keepAwake(); }

    const end = S.status === 'ended';
    $('#endCard').hidden = !(end && !showMapAfterEnd);
    if (end) {
      $('#endTitle').textContent = S.endReason === 'time' ? 'Zeit abgelaufen' : 'Beendet vom Host';
      $('#endText').textContent = S.endReason === 'time' ? 'Die Verstecker haben durchgehalten.' : 'Der Host hat das Spiel beendet.';
      $('#btnReset').hidden = !isHost();
    }
    tick();
  }

  function tick() {
    if (!S || S.status === 'lobby') return;
    const now = nowS();
    const hint = $('#gameHint'), mapNote = $('#mapNote');
    const role = me() && me().role;
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
      hint.textContent = role === 'hider'
        ? `Alle ${S.settings.pingMin} Min. sehen die Sucher kurz, wo du warst. Danach bleibt der Punkt stehen.`
        : `Alle ${S.settings.pingMin} Min. erscheinen die Verstecker als Punkt auf der Karte.`;
    } else {
      $('#phase').textContent = 'Beendet';
      $('#timer').textContent = '00:00';
      $('#pingTimer').textContent = '--:--';
      hint.textContent = '';
    }
    mapNote.textContent = S.status === 'running' && !S.lastPing && role === 'seeker' ? 'Noch kein Ping.' : '';
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
    session = null; S = null; lastPingAt = 0; initAreaSent = false; endConfirm = false;
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
