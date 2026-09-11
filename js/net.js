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
 *   Net.sync() / Net.close()
 * ===================================================================== */
(function () {
  'use strict';
  let ws = null, cfg = null, hb = null, reconnect = null, closedByUs = false, seq = 0;
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

  function connect(code, name) { cfg = { code, name }; closedByUs = false; open(); }
  function open() {
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) { } }
    emit('status', 'connecting');
    ws = new WebSocket(url(cfg.code));
    ws.onopen = () => { emit('status', 'connected'); send({ t: 'join', name: cfg.name, token: token(cfg.code) }); beat(); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (!m || m.t === 'pong') return;
      emit(m.t, m);
    };
    ws.onclose = () => { stopBeat(); emit('status', 'disconnected'); if (!closedByUs) { clearTimeout(reconnect); reconnect = setTimeout(() => { if (!closedByUs) open(); }, 1500); } };
    ws.onerror = () => { /* onclose handles retry */ };
  }
  function beat() { stopBeat(); hb = setInterval(() => { try { if (ws && ws.readyState === 1) ws.send('{"t":"ping"}'); } catch (e) { } }, 25000); }
  function stopBeat() { if (hb) { clearInterval(hb); hb = null; } }

  // 返回 true 表示确实发出去了；断线时返回 false，UI 据此提示玩家而不是静默吞掉操作
  function send(msg) { try { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; } } catch (e) { } return false; }
  function action(move) { return send({ t: 'action', seq: ++seq, action: move }); }
  function start(opts) { send({ t: 'start', opts: opts || {} }); }
  function sync() { send({ t: 'sync' }); }
  function setName(name) { cfg && (cfg.name = name); return send({ t: 'name', name }); }
  function rematch() { return send({ t: 'rematch' }); }
  // 重新发一次 join：用于「房主重开下一局」后，让观战者（座位 -1）有机会入座。
  // 已入座的人重发 join 会按 token 认回原座位，无副作用。
  function rejoin() { return cfg ? send({ t: 'join', name: cfg.name, token: token(cfg.code) }) : false; }
  // 房主在大厅调整座位（服务器校验房主身份与大厅阶段）
  function addAI(level) { return send({ t: 'addAI', level }); }
  function removeAI(seat) { return send({ t: 'removeAI', seat }); }
  function setAILevel(seat, level) { return send({ t: 'aiLevel', seat, level }); }
  function shuffle() { return send({ t: 'shuffle' }); }
  function close() { closedByUs = true; clearTimeout(reconnect); stopBeat(); if (ws) { try { ws.onclose = null; ws.close(); } catch (e) { } } ws = null; }

  const api = { connect, on, send, action, start, sync, setName, rematch, rejoin, addAI, removeAI, setAILevel, shuffle, close, parseRoomCode,
                isOpen: () => !!(ws && ws.readyState === 1) };
  if (typeof window !== 'undefined') window.Net = api;
  // 纯函数部分（parseRoomCode）可被 Node 测试直接 require；其余函数依赖浏览器 API。
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
