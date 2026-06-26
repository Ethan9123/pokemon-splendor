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
 *   Net.sync() / Net.close()
 * ===================================================================== */
(function () {
  'use strict';
  let ws = null, cfg = null, hb = null, reconnect = null, closedByUs = false, seq = 0;
  const handlers = {};

  function on(ev, fn) { handlers[ev] = fn; }
  function emit(ev, data) { if (handlers[ev]) { try { handlers[ev](data); } catch (e) { console.error('Net handler', ev, e); } } }

  // stable identity per room, stored locally → reconnect reclaims the seat
  function token(code) {
    const k = 'pkmn_net_token_' + code;
    let t = null;
    try { t = localStorage.getItem(k); if (!t) { t = 'tok-' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(k, t); } }
    catch (e) { t = 'tok-' + Math.random().toString(36).slice(2); }
    return t;
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

  function send(msg) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch (e) { } }
  function action(move) { send({ t: 'action', seq: ++seq, action: move }); }
  function start(opts) { send({ t: 'start', opts: opts || {} }); }
  function sync() { send({ t: 'sync' }); }
  function close() { closedByUs = true; clearTimeout(reconnect); stopBeat(); if (ws) { try { ws.onclose = null; ws.close(); } catch (e) { } } ws = null; }

  window.Net = { connect, on, send, action, start, sync, close, isOpen: () => !!(ws && ws.readyState === 1) };
})();
