/* =====================================================================
 * 璀璨宝石：宝可梦  —  online client transport (window.Net)
 * ---------------------------------------------------------------------
 * One WebSocket to a room's Durable Object (worker/index.js). Handles the
 * wire protocol, a stable per-room identity token (so a refresh reclaims the
 * same seat + hidden hand), a heartbeat the server auto-answers without waking
 * the DO, and auto-reconnect. It is transport only — it knows no game rules;
 * ui.js subscribes to events and drives the UI.
 *
 *   Net.connect(code, name)       open/join a room
 *   Net.on(event, fn)             welcome | roster | state | reject | over | status
 *   Net.start(opts)               host starts the game
 *   Net.action(move)              send a move ({type,...} engine action)
 *   Net.setName(name)             rename my seat (live, in lobby or mid-game)
 *   Net.rematch()                 host: end-of-game -> back to lobby, same seats
 *   Net.addAI(level) / removeAI(seat, name) / setAILevel(seat, level, name) / shuffle()
 *                                 host, lobby: bot seats + random seat order
 *   Net.sync() / Net.close()
 * ===================================================================== */
(function () {
  'use strict';
  let ws = null, cfg = null, hb = null, reconnect = null, closedByUs = false, seq = 0;
  let generation = 0, joined = false, ready = false, retries = 0;
  let handshake = null, replyTimer = null, pongTimer = null;
  const handlers = {};
  const sessionTokens = new Map();

  function on(ev, fn) { handlers[ev] = fn; }
  function emit(ev, data) { if (handlers[ev]) { try { handlers[ev](data); } catch (e) { console.error('Net handler', ev, e); } } }

  // stable identity per room, stored locally → reconnect reclaims the seat
  function token(code) {
    const k = 'pkmn_net_token_' + code;
    if (sessionTokens.has(k)) return sessionTokens.get(k);
    let t = null;
    try { t = localStorage.getItem(k); } catch (e) { }
    if (!t) {
      t = 'tok-' + Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
      try { localStorage.setItem(k, t); } catch (e) { }
    }
    // Storage may be blocked; reconnection within this page must retain its seat.
    sessionTokens.set(k, t);
    return t;
  }
  // 把用户粘进来的东西解析成房间码。朋友收到的往往是「复制邀请链接」给出的整条 URL，
  // 直接按字符清洗会得到 HTTPSPOKEMON-SPLENDORTRY-BOARD-G 这种乱码并进入空房间。
  // 依次尝试：?room= 参数 → URL 末段路径 → 原文清洗。
  function parseRoomCode(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    const q = s.match(/[?&]room=([^&#\s]+)/i);
    if (q) s = q[1];
    else if (/^https?:/i.test(s) || s.indexOf('/') >= 0) {
      const seg = s.split(/[?#]/)[0].split('/').filter(Boolean);
      if (seg.length) s = seg[seg.length - 1];
    }
    try { s = decodeURIComponent(s); } catch (e) { }
    return s.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
  }

  function url(code) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/room/' + encodeURIComponent(code) + '/ws';
  }

  function clearTimers() {
    clearTimeout(reconnect); clearTimeout(handshake); clearTimeout(replyTimer); clearTimeout(pongTimer);
    stopBeat();
  }
  function dispose() {
    generation++; clearTimers(); joined = false; ready = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch (e) { }
    }
    ws = null;
  }
  function offline() { return typeof navigator !== 'undefined' && navigator.onLine === false; }
  function failed() {
    dispose();
    if (closedByUs || !cfg) return;
    emit('status', offline() ? 'offline' : 'disconnected');
    if (!offline()) {
      const delay = Math.min(12000, 1000 * Math.pow(2, Math.min(retries++, 4)));
      reconnect = setTimeout(open, delay);
    }
  }
  function connect(code, name) {
    cfg = { code: parseRoomCode(code), name }; closedByUs = false; retries = 0; open();
  }
  function open() {
    dispose();
    if (closedByUs || !cfg) return;
    if (offline()) { emit('status', 'offline'); return; }
    const current = generation;
    const live = () => current === generation && !closedByUs;
    emit('status', 'connecting');
    try { ws = new WebSocket(url(cfg.code)); } catch (e) { failed(); return; }
    handshake = setTimeout(() => { if (live()) failed(); }, 12000);
    ws.onopen = () => {
      if (!live()) return;
      emit('status', 'syncing');
      try { raw({ t: 'join', name: cfg.name, token: token(cfg.code) }); }
      catch (e) { failed(); }
    };
    ws.onmessage = (e) => {
      if (!live()) return;
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (!m || typeof m.t !== 'string') return;
      clearTimeout(pongTimer); pongTimer = null;
      if (m.t === 'pong') return;
      if (m.t === 'welcome') joined = true;
      // A socket being open does not mean the player's state is synchronized.
      if (joined && (m.t === 'state' || (m.t === 'roster' && !m.started))) {
        clearTimeout(handshake); clearTimeout(replyTimer); retries = 0;
        if (!ready) { ready = true; emit('status', 'connected'); beat(); }
      } else if (m.t === 'reject' && ready) clearTimeout(replyTimer);
      emit(m.t, m);
    };
    ws.onclose = () => { if (live()) failed(); };
    ws.onerror = () => { if (live()) failed(); };
  }
  function raw(msg) {
    try { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; } }
    catch (e) { failed(); }
    return false;
  }
  function beat() {
    stopBeat();
    hb = setInterval(() => {
      if (!raw({ t: 'ping' })) { failed(); return; }
      clearTimeout(pongTimer);
      pongTimer = setTimeout(failed, 10000);
    }, 25000);
  }
  function stopBeat() { if (hb) { clearInterval(hb); hb = null; } }
  function awaitReply() {
    clearTimeout(replyTimer);
    replyTimer = setTimeout(sync, 8000);
  }
  // Never replay a move after reconnect: it may already have reached the server.
  // A missing acknowledgment requests the authoritative snapshot before unlocking.
  function send(msg) {
    if (!ready) return false;
    const ok = raw(msg);
    if (ok && msg.t !== 'ping' && msg.t !== 'sync') awaitReply();
    return ok;
  }
  function action(move) { return send({ t: 'action', seq: ++seq, action: move }); }
  function start(opts) { return send({ t: 'start', opts: opts || {} }); }
  function sync() {
    if (!joined || !ws || ws.readyState !== 1) return false;
    // Coalesce foreground/online events while a sync is already in flight.
    if (!ready) return true;
    ready = false; emit('status', 'syncing');
    clearTimeout(replyTimer);
    replyTimer = setTimeout(failed, 8000);
    return raw({ t: 'sync' });
  }
  function retry() { if (!closedByUs && cfg) { retries = 0; open(); } }
  function setName(name) { cfg && (cfg.name = name); return send({ t: 'name', name }); }
  function rematch() { return send({ t: 'rematch' }); }
  function rejoin() { return cfg ? send({ t: 'join', name: cfg.name, token: token(cfg.code) }) : false; }
  // 房主在大厅调整座位（服务器校验房主身份与大厅阶段）
  function addAI(level) { return send({ t: 'addAI', level }); }
  // name = 该行电脑的名字：座位号会因移除/随机而变化，服务器据此拒绝过期的操作
  function removeAI(seat, name) { return send({ t: 'removeAI', seat, name }); }
  function setAILevel(seat, level, name) { return send({ t: 'aiLevel', seat, level, name }); }
  function shuffle() { return send({ t: 'shuffle' }); }
  function close() { closedByUs = true; dispose(); cfg = null; }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('offline', () => { if (!closedByUs && cfg) failed(); });
    window.addEventListener('online', () => { if (!closedByUs && cfg) retry(); });
    window.addEventListener('pageshow', () => { if (!closedByUs && cfg) { if (ready) sync(); else retry(); } });
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !closedByUs && cfg) {
      if (ready) sync(); else retry();
    }
  });

  const api = { connect, on, send, action, start, sync, setName, rematch, rejoin, retry, addAI, removeAI, setAILevel, shuffle, close, parseRoomCode,
                isOpen: () => ready && !!(ws && ws.readyState === 1) };
  if (typeof window !== 'undefined') window.Net = api;
  // 纯函数部分（parseRoomCode）可被 Node 测试直接 require；其余函数依赖浏览器 API。
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
