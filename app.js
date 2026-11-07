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
  let selMode = 'normal';  // gewählter Spielmodus auf der Startseite
  let initAreaSent = false;
  let lastPingAt = 0;
  let lastEventId = 0;     // zuletzt gezeigte Eilmeldung
  let wakeLock = null;
  let showMapAfterEnd = false;
  let endConfirm = false;
  let foundConfirm = null; // Spieler-ID, die gerade "Gefangen?" bestätigt werden soll
  let outLocalSince = 0;   // wann ich selbst das Spielfeld verlassen habe
  let chat = { role: null, msgs: [] };
  let unread = 0;
  let chatVisible = false;
  let compassHeading = null, gpsHeading = null, gpsHeadingAt = 0, compassActive = false;

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

  // ---------- Eilmeldung (Lauftext von rechts nach links) + rotes Blinken ----------
  let newsT;
  function showNews(text, ms) {
    const n = $('#news');
    n.innerHTML = '<div class="news-label">Eilmeldung</div><div class="news-track"><span class="news-text"></span></div>';
    const t = n.querySelector('.news-text');
    t.textContent = text;
    t.style.animationDuration = ms + 'ms';
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
  function processEvents() {
    const evs = (S.events || []).filter((e) => e.id > lastEventId);
    if (!evs.length) return;
    lastEventId = Math.max(...evs.map((e) => e.id));
    const fresh = evs.filter((e) => nowS() - e.at < 10000); // alte Meldungen (z. B. nach dem Neuladen) überspringen
    if (!fresh.length) return;
    const left = 10000 - (nowS() - fresh[fresh.length - 1].at);
    showNews(fresh.map((e) => e.text).join('   •   '), Math.max(left, 6000));
    redTint();
    vibrate([400, 150, 400]);
  }

  // ---------- Standort und Blickrichtung ----------
  function startGeo() {
    if (!navigator.geolocation) { geoDenied = true; updateGeoWarn(); return; }
    if (watchId != null) return;
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        myPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
        if (typeof p.coords.heading === 'number' && !isNaN(p.coords.heading) && (p.coords.speed || 0) > 0.7) {
          gpsHeading = p.coords.heading; gpsHeadingAt = Date.now();
        }
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

  // Kompass: auf dem iPhone braucht er eine Erlaubnis per Fingertipp
  function onOrient(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha + ((screen.orientation && screen.orientation.angle) || 0)) % 360;
    if (h == null || isNaN(h)) return;
    compassHeading = h;
    applyHeading();
  }
  function startCompass() {
    if (compassActive || !window.DeviceOrientationEvent) return;
    const go = () => {
      compassActive = true;
      window.addEventListener('deviceorientationabsolute', onOrient, true);
      window.addEventListener('deviceorientation', onOrient, true);
      $('#btnCompass').hidden = true;
    };
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().then((r) => { if (r === 'granted') go(); }).catch(() => {});
    } else go();
  }
  const needsCompassTap = () => window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function' && !compassActive;
  const heading = () => {
    if (compassHeading != null) return compassHeading;
    if (gpsHeading != null && Date.now() - gpsHeadingAt < 8000) return gpsHeading;
    return null;
  };
  let lastHeadApply = 0;
  function applyHeading() {
    const t = Date.now();
    if (t - lastHeadApply < 80) return;
    lastHeadApply = t;
    const el = M && M.meMarker && M.meMarker.getElement();
    const d = el && el.querySelector('.me-dir');
    if (!d) return;
    const h = heading();
    d.style.display = h == null ? 'none' : 'block';
    if (h != null) d.style.transform = `rotate(${h}deg)`;
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
  // Nach 1 Min. draußen sind sie 3 Min. live sichtbar, nach 3 Min. draußen werden sie automatisch gefangen.
  function updateOutWarn() {
    const warn = $('#outWarn'), flash = $('#flash');
    const m = me();
    const r = S && ring(S.area);
    const hiderNow = !!(m && m.role === 'hider' && S.status === 'running');
    const out = !!(hiderNow && r && myPos && !inside(r, myPos.lat, myPos.lng));
    if (out) { if (!outLocalSince) { outLocalSince = Date.now(); vibrate([300, 120, 300]); } } else outLocalSince = 0;
    flash.classList.toggle('alarm', out);

    const exposedLeft = hiderNow && m.exposedUntil ? m.exposedUntil - nowS() : 0;
    let text = '';
    if (out) {
      const el = Math.floor((Date.now() - outLocalSince) / 1000);
      const left = Math.max(0, 180 - el);
      text = el >= 60
        ? `Außerhalb! Die Sucher sehen dich live. Noch ${left} Sek., dann wirst du gefangen.`
        : `Du bist außerhalb des Spielfelds! Geh zurück. In ${60 - el} Sek. sehen dich die Sucher live, nach ${left} Sek. wirst du gefangen.`;
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
      M.meMarker = L.marker(ll, {
        icon: L.divIcon({ className: '', html: `<div class="me-wrap"><div class="me-dir"></div><div class="me-dot ${role === 'hider' ? 'hider' : ''}"></div></div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
        interactive: false, zIndexOffset: 1000,
      }).addTo(M.map);
      M.meCircle = L.circle(ll, { radius: myPos.acc || 10, color: '#46c2ff', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(M.map);
      if (!S || !S.area) M.map.setView(ll, 16);
    } else {
      M.meMarker.setLatLng(ll);
      M.meCircle.setLatLng(ll).setRadius(myPos.acc || 10);
      const el = M.meMarker.getElement() && M.meMarker.getElement().querySelector('.me-dot');
      if (el) el.classList.toggle('hider', role === 'hider');
    }
    lastHeadApply = 0;
    applyHeading();
  }

  // Aktuelle Zone; im Modus "Schrumpfende Zone" zusätzlich die nächste, kleinere Zone als dünne weiße Linie
  function drawArea() {
    if (!M || !S) return;
    const a = S.area;
    const key = JSON.stringify([a, S.nextArea]);
    if (key === M.areaKey) return;
    M.areaKey = key;
    M.areaLayer.clearLayers();
    const r = ring(a);
    if (!r) return;
    const world = [[-85, -180], [-85, 180], [85, 180], [85, -180]];
    L.polygon([world, r], { stroke: false, fillColor: '#07120b', fillOpacity: 0.45, interactive: false }).addTo(M.areaLayer);
    const outline = L.polygon(r, { color: '#ffd166', weight: 3, fill: false, dashArray: '8 6', interactive: false }).addTo(M.areaLayer);
    const nr = ring(S.nextArea);
    if (nr) L.polygon(nr, { color: '#ffffff', weight: 2, opacity: 0.8, fill: false, dashArray: '2 6', interactive: false }).addTo(M.areaLayer);
    if (!M.fitted || !isHost() || S.status !== 'lobby') {
      if (!M.fitted) M.map.fitBounds(outline.getBounds(), { padding: [30, 30] });
      else if (S.status === 'lobby') M.map.fitBounds(outline.getBounds(), { padding: [30, 30] });
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

  // Live-Standorte (nur Sucher bekommen sie vom Server)
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

  // ---------- Chat (getrennt nach Suchern und Verstecker:innen) ----------
  function renderChat() {
    const m = me();
    const role = m && m.role;
    const box = $('#chat');
    box.className = 'chat ' + (role === 'hider' ? 'hider' : 'seeker');
    $('#chatTitle').textContent = role === 'hider' ? 'Chat der Verstecker' : 'Chat der Sucher';
    const log = $('#chatLog');
    const msgs = chat.role === role ? chat.msgs : [];
    const html = msgs.map((x) => `<div class="msg ${x.pid === session.pid ? 'mine' : ''}"><b>${esc(x.name)}</b>${esc(x.text)}</div>`).join('');
    if (log.dataset.h !== html) {
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      log.innerHTML = html; log.dataset.h = html;
      if (atBottom || !log.dataset.init) { log.scrollTop = log.scrollHeight; log.dataset.init = '1'; }
    }
    $('#btnChat').textContent = unread ? `Chat (${unread} neu)` : 'Chat';
  }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((en) => {
      chatVisible = en[0].isIntersecting;
      if (chatVisible && unread) { unread = 0; if (S && S.status !== 'lobby') renderChat(); }
    }, { threshold: 0.4 }).observe($('#chat'));
  }
  function onChat(data) {
    const prevLen = chat.role === data.role ? chat.msgs.length : 0;
    const roleChanged = chat.role !== data.role;
    chat = data;
    if (roleChanged) { unread = 0; $('#chatLog').dataset.h = ''; }
    const added = data.msgs.slice(prevLen).filter((x) => x.pid !== (session && session.pid)).length;
    if (!roleChanged && added && !chatVisible) unread += added;
    if (S && S.status !== 'lobby') renderChat();
  }
  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#chatIn'), text = inp.value.trim();
    if (!text || !session) return;
    inp.value = '';
    act('chat', { text });
  });
  $('#btnChat').onclick = () => { unread = 0; renderChat(); $('#chat').scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  // ---------- Rendering ----------
  function render() {
    if (!S) return;
    processEvents();
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
    $('#undecided').textContent = un.length ? 'Noch ohne Seite (beim Start nicht dabei): ' + un.map((p) => p.name).join(', ') : '';
    const mine = me() && me().role;
    $('#teamSeeker').classList.toggle('mine', mine === 'seeker');
    $('#teamHider').classList.toggle('mine', mine === 'hider');

    const st = S.settings, host = isHost();
    $('.settings').classList.toggle('locked', !host);
    $('#modeSel').value = st.mode;
    $('#shrinkSel').value = String(st.shrinkPct);
    $('#shrinkRow').hidden = st.mode !== 'shrink';
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
    const m = me();
    if (!m || !m.role) return 'Wähle zuerst selbst eine Seite.';
    const list = S.players.filter((p) => p.role);
    if (!list.some((p) => p.role === 'seeker') || !list.some((p) => p.role === 'hider')) return 'Es braucht mindestens einen Sucher und einen Verstecker.';
    if (!S.settings.area) return 'Das Spielfeld wird noch angelegt.';
    return '';
  }

  // Spielerliste unter der Karte; Sucher tippen auf einen Verstecker = "gefangen"
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
          const txt = foundConfirm === p.id ? (p.id === meP.id ? 'Ich wurde gefangen? Nochmal tippen' : esc(p.name) + ' gefangen? Nochmal tippen') : name;
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
    drawArea(); drawPings(); drawLive(); drawFinal(); updateMe(); updateOutWarn(); renderRoster(); renderChat();
    $('#btnCompass').hidden = !needsCompassTap();
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
      const survivors = S.players.filter((p) => p.role === 'hider').map((p) => p.name);
      let title = 'Spiel vorbei', text = '';
      if (S.endReason === 'time') {
        if (survivors.length === 1) { title = `🏆🏆 ${survivors[0]} hat gewonnen 🏆🏆`; text = 'Als Einziger nicht gefangen.'; }
        else if (survivors.length > 1) { title = 'Zeit abgelaufen'; text = 'Überlebt haben: ' + survivors.join(', ') + '.'; }
        else { title = 'Zeit abgelaufen'; }
      } else if (S.endReason === 'allfound') { title = 'Die Sucher haben gewonnen'; text = 'Alle Verstecker wurden gefangen.'; }
      else if (S.endReason === 'nohiders') { title = 'Keine Verstecker mehr'; text = 'Alle Verstecker haben das Spiel verlassen.'; }
      else if (S.endReason === 'host') { title = 'Beendet vom Host'; text = 'Der Host hat das Spiel beendet.'; }
      $('#endTitle').textContent = title;
      $('#endText').textContent = text;
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
    const shrink = S.settings.mode === 'shrink';
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
      const sh = shrink ? ` Die Zone schrumpft bei jedem Ping um ${S.settings.shrinkPct} %.` : '';
      hint.textContent = (role === 'seeker'
        ? 'Tippe auf einen Verstecker in der Liste, wenn du ihn gefangen hast.'
        : `Alle ${S.settings.pingMin} Min. sehen die Sucher kurz, wo du warst. Wirst du gefangen, tippe auf deinen Namen. Dann wirst du Sucher.`) + sh;
    } else {
      $('#phase').textContent = 'Beendet';
      $('#timer').textContent = '00:00';
      $('#pingTimer').textContent = '--:--';
      hint.textContent = '';
    }
    const hiders = S.players.filter((p) => p.role === 'hider');
    const total = hiders.length + S.players.filter((p) => p.found).length;
    let note = S.status === 'running' ? `Noch ${hiders.length} von ${total} Verstecker frei.` : '';
    if (S.area && S.area.type === 'circle' && S.status !== 'ended') note += ` Zone: ${Math.round(S.area.radius)} m.`;
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
    es.addEventListener('chat', (e) => onChat(JSON.parse(e.data)));
    es.addEventListener('gone', () => leaveLocal('Dieses Spiel gibt es nicht mehr.'));
    es.addEventListener('kicked', () => leaveLocal('Du hattest keine Seite gewählt und bist in dieser Runde nicht dabei.'));
  }

  function enter(s) {
    session = s;
    store.set('vs-session', JSON.stringify(s));
    initAreaSent = false;
    startGeo();
    startCompass();
    connect();
  }

  function leaveLocal(msg) {
    if (es) { es.close(); es = null; }
    if (M) { M.map.remove(); M = null; }
    session = null; S = null; lastPingAt = 0; lastEventId = 0; initAreaSent = false; endConfirm = false; foundConfirm = null; outLocalSince = 0;
    chat = { role: null, msgs: [] }; unread = 0; $('#chatLog').dataset.h = '';
    $('#flash').classList.remove('alarm', 'tint');
    $('#news').hidden = true; $('#outWarn').hidden = true;
    store.del('vs-session');
    history.replaceState(null, '', location.pathname);
    show('v-home');
    if (msg) toast(msg);
  }

  const getName = () => { const n = $('#name').value.trim(); store.set('vs-name', n); return n; };

  // ---------- Ereignisse ----------
  for (const b of document.querySelectorAll('#modePick .mode')) {
    b.onclick = () => {
      selMode = b.dataset.mode;
      store.set('vs-mode', selMode);
      for (const x of document.querySelectorAll('#modePick .mode')) {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-checked', x === b ? 'true' : 'false');
      }
    };
  }
  $('#btnHost').onclick = async () => {
    const name = getName();
    if (!name) { toast('Gib zuerst deinen Namen ein.'); $('#name').focus(); return; }
    startGeo(); startCompass();
    try { enter(await api('create', { name, mode: selMode })); } catch (e) { toast(e.message); }
  };
  $('#btnJoin').onclick = async () => {
    const name = getName(), code = $('#codeIn').value.trim().toUpperCase();
    if (!name) { toast('Gib zuerst deinen Namen ein.'); $('#name').focus(); return; }
    if (code.length !== 4) { toast('Der Code hat 4 Zeichen.'); $('#codeIn').focus(); return; }
    startGeo(); startCompass();
    try { enter(await api('join', { name, code })); history.replaceState(null, '', location.pathname); } catch (e) { toast(e.message); }
  };
  $('#codeIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnJoin').click(); });
  $('#btnCompass').onclick = () => startCompass();

  for (const b of document.querySelectorAll('.team')) b.onclick = () => act('role', { role: b.dataset.role });

  $('#modeSel').onchange = (e) => act('settings', { mode: e.target.value });
  $('#shrinkSel').onchange = (e) => act('settings', { shrinkPct: +e.target.value });
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
  if (store.get('vs-mode') === 'shrink') document.querySelector('#modePick .mode[data-mode="shrink"]').click();
  const joinParam = (new URLSearchParams(location.search).get('join') || '').toUpperCase().slice(0, 4);
  let saved = null;
  try { saved = JSON.parse(store.get('vs-session') || 'null'); } catch (e) {}
  if (saved && saved.code && saved.pid && (!joinParam || joinParam === saved.code)) {
    enter(saved);
  } else {
    if (joinParam) {
      $('#codeIn').value = joinParam;
      $('#btnHost').hidden = true;
      $('#modePick').hidden = true;
      document.querySelector('.modehead').hidden = true;
      document.querySelector('.or').hidden = true;
      $('.lead').textContent = `Du wurdest in die Lobby ${joinParam} eingeladen. Gib deinen Namen ein.`;
    }
    show('v-home');
  }
})();
