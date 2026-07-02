/* =====================================================================
 * 璀璨宝石：宝可梦  —  online Room authority (pure, transport-agnostic)
 * ---------------------------------------------------------------------
 * Holds the canonical game state for ONE online room and turns inbound
 * player messages into outbound (per-player) messages. The SAME class runs
 * inside a Cloudflare Durable Object (worker/index.js) and in an in-page
 * loopback (js/net.js) — only the transport differs. No WebSocket / DOM / DO
 * code lives here, so it is unit-testable headless (test/room.test.js).
 *
 * It injects a `send(connId, msg)` callback (the transport) and never reaches
 * out itself. Server-authoritative: every move is validated with the engine's
 * applyAction (ownership-guarded by seat) and each client only ever receives
 * `redactFor(G, seat)` — so hidden info (deck order, opponents' reserves) never
 * leaves the authority.
 *
 * Identity model (so reconnection works): a live transport connection is a
 * `connId` (ephemeral — a new WebSocket gets a new one). A PLAYER is a stable
 * `token` the client stores locally; a seat is bound to a token, so a new
 * connection presenting the same token reclaims its seat (and hidden hand).
 * Host = seat 0 (the first to join) — reconnect-safe, no connId tracking.
 *
 * Wire protocol (JSON):
 *   client → room:  {t:'join', name, token}      join / reclaim a seat by token
 *                   {t:'start', opts}            host (seat 0) starts the game
 *                   {t:'action', seq, action}    a move (action = engine {type,...})
 *                   {t:'sync'}                   resend my current redacted state
 *   room → client:  {t:'welcome', connId, seat, host}
 *                   {t:'roster', players:[{seat,name,connected}], hostSeat, started}
 *                   {t:'state', seq, state}      redacted snapshot for this viewer
 *                   {t:'reject', reason, seq}
 *                   {t:'over', winner}
 * ===================================================================== */
(function (root, factory) {
  const api = factory(
    (typeof require !== 'undefined') ? require('./engine.js') : (root.Engine)
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Room = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
  'use strict';

  // Idle/disconnect turn timeout: after this long with no move, the host's AI
  // may take over the active seat (enforced server-side; the host computes the move).
  const TURN_TIMEOUT_MS = 180000; // 3 minutes

  // strip the shared static card refs so a room state is pure data we can persist
  function serializeG(s) {
    const { cardDB, byId, megaDB, pokemartDB, ...dyn } = s;
    return JSON.parse(JSON.stringify(dyn));
  }
  function reattachG(dyn, DB, megaDB, pokemartDB) {
    const s = JSON.parse(JSON.stringify(dyn));
    s.cardDB = DB; s.megaDB = megaDB || []; s.pokemartDB = pokemartDB || [];
    s.byId = {};
    [].concat(DB, s.megaDB, s.pokemartDB).forEach(c => { if (c) s.byId[c.id] = c; });
    if (!Array.isArray(s.log)) s.log = [];
    return s;
  }

  class Room {
    constructor(opts) {
      opts = opts || {};
      this.DB = opts.cardDB || [];
      this.megaDB = opts.megaDB || [];
      this.pokemartDB = opts.pokemartDB || [];
      this.maxSeats = opts.maxSeats || 4;
      this.send = opts.send || function () { };  // (connId, msgObj) => void
      this.G = null;
      this.seq = 0;
      this.started = false;
      this.seats = [];      // seats[i] = { token, name, connId|null, connected }
      this.conns = {};      // live connId -> seat index (>=0 seated, -1 spectator)
      this.turnStartedAt = 0; // server ms when the current turn began (idle-timeout base)
      this.now = 0;         // current server ms, injected by the DO before each handler
    }

    // ----------------------------- connections -----------------------------
    join(connId, name, token) {
      // reconnect: a seat already bound to this stable token
      let seat = token != null ? this.seats.findIndex(s => s.token === token) : -1;
      if (seat < 0) {                                           // a new player
        if (this.started) seat = -1;                            // can't take a seat mid-game → spectator
        else {
          seat = this.seats.findIndex(s => s.token == null);    // a freed seat
          if (seat < 0 && this.seats.length < this.maxSeats) {  // else open a new one
            seat = this.seats.length;
            this.seats.push({ token: null, name: '', connId: null, connected: false });
          }
        }
      }
      if (seat >= 0) {
        const st = this.seats[seat];
        st.token = token || st.token || ('seat' + seat);
        st.connId = connId;
        st.name = name || st.name || ('训练家 ' + (seat + 1));
        st.connected = true;
        this.conns[connId] = seat;
      } else {
        this.conns[connId] = -1;                                // spectator
      }
      this.send(connId, { t: 'welcome', connId, seat: this.conns[connId], host: seat === 0 });
      this._roster();
      if (this.started) this._stateTo(connId);                  // reconnect → resend snapshot
      return this.conns[connId];
    }

    leave(connId) {
      const seat = this.conns[connId];
      if (seat != null && seat >= 0 && this.seats[seat]) {
        this.seats[seat].connected = false;
        this.seats[seat].connId = null;                         // keep token → seat reclaimable
      }
      delete this.conns[connId];
      this._roster();
    }

    // Quiet transport re-attach after the DO hibernates: restore a connId→seat
    // mapping by token ONLY — no welcome/roster/state side-effects (those happen
    // when the client itself re-sends join/sync on a real reconnect). Works even
    // before the game has started, so a lobby that hibernated isn't bricked.
    rebind(connId, token) {
      const seat = token != null ? this.seats.findIndex(s => s.token === token) : -1;
      if (seat >= 0) { this.seats[seat].connId = connId; this.seats[seat].connected = true; this.conns[connId] = seat; }
      else this.conns[connId] = -1;
      return this.conns[connId];
    }

    // ------------------------------- messages ------------------------------
    onMessage(connId, msg) {
      if (!msg || typeof msg.t !== 'string') return;
      switch (msg.t) {
        case 'join':   return this.join(connId, msg.name, msg.token);
        case 'start':  return this._start(connId, msg.opts);
        case 'action': return this._action(connId, msg);
        case 'takeover': return this._takeover(connId, msg);
        case 'sync':   return this._stateTo(connId);
      }
    }

    _start(connId, opts) {
      if (this.conns[connId] !== 0) return this.send(connId, { t: 'reject', reason: '只有房主可以开始游戏' });
      if (this.started) return this._stateTo(connId);
      if (!this.seats.length) return this.send(connId, { t: 'reject', reason: '房间里还没有玩家' });
      opts = opts || {};
      const names = this.seats.map((s, i) => s.name || ('训练家 ' + (i + 1)));
      // server-authoritative RNG: NEVER trust a client-supplied seed — it would let
      // the host precompute the entire deck order. Mint it here; fall back to the
      // engine's own random seed if Web Crypto is somehow unavailable.
      let seed;
      try { seed = globalThis.crypto.getRandomValues(new Uint32Array(1))[0] >>> 0; } catch (e) { seed = undefined; }
      this.G = E.createGame(this.DB, {
        numPlayers: this.seats.length, names,
        ai: this.seats.map(() => false),                        // all-human online
        megas: !!opts.megas, megaDB: this.megaDB,
        pokemart: !!opts.pokemart, pokemartDB: this.pokemartDB,
        seed,
      });
      this.started = true;
      this.turnStartedAt = this.now;
      this.seq++;
      this._roster();
      this._broadcastState();
    }

    _action(connId, msg) {
      const seat = this.conns[connId];
      if (!this.started || seat == null || seat < 0) {
        return this.send(connId, { t: 'reject', reason: '未入座或对局未开始', seq: msg && msg.seq });
      }
      const prevTurn = this.G.turn;
      const r = E.applyAction(this.G, msg.action, seat);        // seat = ownership guard
      if (!r.ok) return this.send(connId, { t: 'reject', reason: r.error, seq: msg.seq });
      if (this.G.turn !== prevTurn) this.turnStartedAt = this.now; // turn advanced → reset idle clock
      this.seq++;
      this._broadcastState();
      if (this.G.phase === 'gameover') this._broadcast({ t: 'over', winner: this.G.winner });
    }

    // The host's AI takes over a timed-out active seat. The host computes the move
    // from PUBLIC info only (it never sees the timed-out player's hidden hand) and
    // sends the plan here; the server validates host + that the 3-min timeout has
    // truly elapsed (anti-cheat), then runs the whole turn for the active seat.
    _takeover(connId, msg) {
      if (this.conns[connId] !== 0) return this.send(connId, { t: 'reject', reason: '只有房主可以代打' });
      if (!this.started || !this.G || this.G.phase !== 'play') return;
      if (this.now - this.turnStartedAt < TURN_TIMEOUT_MS) return this.send(connId, { t: 'reject', reason: '尚未超时' });
      const seat = this.G.turn;
      const plan = (msg && msg.plan) || {};
      this.G.log.push({ turn: this.G.turn, round: this.G.round, msg: `⏱️ ${this.G.players[seat].name} 超时，房主AI代打` });
      // main action (AI's pick, else any legal action, else a legitimate pass) — always acts
      let acted = false;
      try { if (plan.action) acted = E.applyAction(this.G, plan.action, seat).ok; } catch (e) { }
      if (!acted) {
        let la = []; try { la = E.legalActions(this.G); } catch (e) { }
        if (la.length) { try { E.applyAction(this.G, la[0], seat); acted = true; } catch (e) { } }
        if (!acted) { try { E.actionPass(this.G); } catch (e) { } }
      }
      // discards (AI plan, then a forced fallback if still over the cap)
      if (Array.isArray(plan.discards)) for (const col of plan.discards) { try { E.actionDiscard(this.G, col); } catch (e) { } }
      let guard = 0;
      while (E.needsDiscard(this.G, this.G.players[seat]) && guard++ < 20) {
        const tok = E.ALL_TOKENS.find(c => this.G.players[seat].tokens[c] > 0);
        if (!tok) break;
        try { E.actionDiscard(this.G, tok); } catch (e) { break; }
      }
      if (plan.megaEvolution) { try { E.actionMegaEvolve(this.G, plan.megaEvolution.megaId, plan.megaEvolution.fromId); } catch (e) { } }
      else if (plan.evolution) { try { E.actionEvolve(this.G, plan.evolution.fromId, plan.evolution.toId); } catch (e) { } }
      try { E.endTurn(this.G); } catch (e) { }
      this.turnStartedAt = this.now;
      this.seq++;
      this._broadcastState();
      if (this.G.phase === 'gameover') this._broadcast({ t: 'over', winner: this.G.winner });
    }

    // ------------------------------- outbound ------------------------------
    _broadcastState() { for (const cid in this.conns) this._stateTo(cid); }
    _stateTo(connId) {
      if (!this.started || !this.G) return;
      const seat = this.conns[connId];
      const view = (seat != null && seat >= 0) ? seat : -1;     // spectators: -1 matches no seat → everything stays redacted
      this.send(connId, {
        t: 'state', seq: this.seq, state: E.redactFor(this.G, view),
        turnStartedAt: this.turnStartedAt, serverNow: this.now, turnTimeoutMs: TURN_TIMEOUT_MS,
      });
    }
    _roster() {
      const players = this.seats.map((s, i) => ({ seat: i, name: s.name, connected: s.connected }));
      this._broadcast({ t: 'roster', players, hostSeat: 0, started: this.started });
    }
    _broadcast(msg) { for (const cid in this.conns) this.send(cid, msg); }

    // ----------------------- persistence (for the DO) ----------------------
    // The DO snapshots this to durable storage and restores it on wake, so a
    // room survives eviction/restart. Live connections (conns) are NOT persisted
    // — clients reconnect with their token and re-sync. Seats keep their token,
    // so reconnecting players reclaim their seat and hidden hand.
    snapshot() {
      const seats = this.seats.map(s => ({ token: s.token, name: s.name, connId: null, connected: false }));
      return { seq: this.seq, started: this.started, seats, turnStartedAt: this.turnStartedAt, g: this.G ? serializeG(this.G) : null };
    }
    restore(snap) {
      if (!snap) return;
      this.seq = snap.seq || 0;
      this.started = !!snap.started;
      this.turnStartedAt = snap.turnStartedAt || 0;
      this.seats = (snap.seats || []).map(s => ({ token: s.token, name: s.name, connId: null, connected: false }));
      this.conns = {};
      this.G = snap.g ? reattachG(snap.g, this.DB, this.megaDB, this.pokemartDB) : null;
    }
  }

  return { Room, serializeG, reattachG };
});
