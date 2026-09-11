/* =====================================================================
 * 璀璨宝石：宝可梦  —  online Room authority (pure, transport-agnostic)
 * ---------------------------------------------------------------------
 * Holds the canonical game state for ONE online room and turns inbound
 * player messages into outbound (per-player) messages. The SAME class runs
 * inside a Cloudflare Durable Object (worker/index.js); only the transport
 * differs. No WebSocket / DOM / DO code lives here, so it is unit-testable
 * headless (test/room.test.js, test/room_lobby.test.js).
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
 * The HOST is identified by `hostToken` (the first human to join), NOT by seat
 * index — seats can be reordered in the lobby (shuffle / remove a bot), and the
 * host must stay the host wherever they end up sitting.
 *
 * Seats are either human (bound to a token) or AI (`ai: 'easy'|'normal'|'hard'`,
 * no token, never "disconnected"). AI turns are executed by the authority itself
 * via stepAI() (the transport decides the pacing), so no client can steer a bot.
 *
 * Wire protocol (JSON):
 *   client → room:  {t:'join', name, token}      join / reclaim a seat by token
 *                   {t:'start', opts}            host starts the game
 *                   {t:'action', seq, action}    a move (action = engine {type,...})
 *                   {t:'sync'}                   resend my current redacted state
 *                   {t:'name', name}             rename my seat
 *                   {t:'rematch'}                host: finished game → back to lobby
 *                   {t:'takeover', plan}         AI-play a timed-out HUMAN seat
 *                   {t:'addAI', level}           host, lobby: add a bot seat
 *                   {t:'removeAI', seat}         host, lobby: remove a bot seat
 *                   {t:'aiLevel', seat, level}   host, lobby: change a bot's difficulty
 *                   {t:'shuffle'}                host, lobby: randomize seat/turn order
 *   room → client:  {t:'welcome', connId, seat, host}   (re-sent whenever my seat index changes)
 *                   {t:'roster', players:[{seat,name,connected,ai}], hostSeat, started, maxSeats}
 *                   {t:'shuffled', count, first}  the host randomized the order (count = rerolls this lobby)
 *                   {t:'notice', msg}            short room-wide announcement (a joining friend replaced a bot)
 *                   {t:'state', seq, state}      redacted snapshot for this viewer
 *                   {t:'reject', reason, seq}
 *                   {t:'lobby'}                  back to the lobby (rematch)
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

  // Idle/disconnect turn timeout: after this long with no move, any other seated
  // player may have the AI take over the active HUMAN seat (validated server-side).
  const TURN_TIMEOUT_MS = 180000; // 3 minutes
  const AI_LEVELS = ['easy', 'normal', 'hard'];
  const DEFAULT_AI_LEVEL = 'normal';
  const validToken = token => typeof token === 'string' && token.trim().length > 0 && token.length <= 256;
  const cleanName = name => typeof name === 'string'
    ? Array.from(name.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, 12).join('') : '';

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

  // Unbiased random integer in [0, n) from Web Crypto (rejection sampling avoids
  // modulo bias). Seat order decides who moves first, so it must not be guessable.
  function randInt(n) {
    try {
      const buf = new Uint32Array(1);
      const limit = Math.floor(4294967296 / n) * n;
      let x;
      do { globalThis.crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
      return x % n;
    } catch (e) { return Math.floor(Math.random() * n); }
  }

  const humanSeat = () => ({ token: null, name: '', connId: null, connected: false, ai: null });

  // Think options for a bot turn on its n-th attempt (see Room#stepAI):
  //   0 → the chosen level · 1 → same level, one belief view · 2 → 'easy' · 3+ → no search (first legal move)
  function aiThinkOpts(level, attempt) {
    const n = Math.max(0, attempt | 0);
    if (n === 0) return { difficulty: level };
    if (n === 1) return { difficulty: level, beliefs: 1 };
    if (n === 2) return { difficulty: 'easy' };
    return null;
  }

  class Room {
    constructor(opts) {
      opts = opts || {};
      this.DB = opts.cardDB || [];
      this.megaDB = opts.megaDB || [];
      this.pokemartDB = opts.pokemartDB || [];
      this.maxSeats = opts.maxSeats || 4;
      this.send = opts.send || function () { };  // (connId, msgObj) => void
      this.AI = opts.ai || null;                  // injected AI module ({chooseTurn}); optional
      this.G = null;
      this.seq = 0;
      this.started = false;
      this.seats = [];      // seats[i] = { token, name, connId|null, connected, ai:null|level }
      this.conns = {};      // live connId -> seat index (>=0 seated, -1 spectator)
      this.hostToken = null; // token of the host (first human to join); survives seat reordering
      this.shuffleCount = 0; // how many times the host randomized the order in this lobby (shown to all)
      this.turnStartedAt = 0; // server ms when the current turn began (idle-timeout base)
      this.now = 0;         // current server ms, injected by the DO before each handler
    }

    // ------------------------------ identity -------------------------------
    _isHostSeat(seat) {
      const st = seat != null && seat >= 0 ? this.seats[seat] : null;
      return !!(st && !st.ai && this.hostToken != null && st.token === this.hostToken);
    }
    _isHost(connId) { return this._isHostSeat(this.conns[connId]); }
    _hostSeat() {
      for (let i = 0; i < this.seats.length; i++) if (this._isHostSeat(i)) return i;
      return -1;
    }
    humansConnected() { return this.seats.some(s => !s.ai && s.connected); }

    // ----------------------------- connections -----------------------------
    join(connId, name, token) {
      if (!validToken(token)) return this.send(connId, { t: 'reject', reason: '无效的玩家身份，请重新连接' });
      const current = this.conns[connId];
      if (current != null && current >= 0 && this.seats[current].token !== token) {
        return this.send(connId, { t: 'reject', reason: '同一连接不能重复占座' });
      }
      // reconnect: a HUMAN seat already bound to this stable token
      let seat = this.seats.findIndex(s => !s.ai && s.token === token), replacedBot = null;
      if (seat < 0) {                                           // a new player
        if (this.started) seat = -1;                            // can't take a seat mid-game → spectator
        else {
          seat = this.seats.findIndex(s => !s.ai && s.token == null);   // a freed human seat
          if (seat < 0 && this.seats.length < this.maxSeats) {  // else open a new one
            seat = this.seats.length;
            this.seats.push(humanSeat());
          }
          if (seat < 0) {
            // Room is full but some seats are bots: a real person beats a bot. Take over
            // the LAST bot seat (pre-start only), so an invited friend is never locked out.
            // The whole room is told which bot made way, so a bot never silently vanishes.
            for (let i = this.seats.length - 1; i >= 0; i--) if (this.seats[i].ai) { seat = i; break; }
            if (seat >= 0) { replacedBot = this.seats[seat].name; this.seats[seat] = humanSeat(); }
          }
        }
      }
      if (seat >= 0) {
        const st = this.seats[seat];
        st.token = token;
        this._bind(connId, seat, true);
        st.name = cleanName(name) || st.name || ('训练家 ' + (seat + 1));
        if (this.hostToken == null) this.hostToken = token;     // first human to join hosts the room
        if (this.G && this.G.players[seat]) this.G.players[seat].name = st.name;
      } else {
        this.conns[connId] = -1;                                // spectator
      }
      this.send(connId, { t: 'welcome', connId, seat: this.conns[connId], host: this._isHost(connId) });
      this._roster();
      if (replacedBot) this._broadcast({ t: 'notice', msg: this.seats[seat].name + ' 加入了房间，替换了' + replacedBot });
      if (this.started) this._stateTo(connId);                  // reconnect → resend snapshot
      return this.conns[connId];
    }

    leave(connId) {
      const seat = this.conns[connId];
      if (seat != null && seat >= 0 && this.seats[seat] && this.seats[seat].connId === connId) {
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
      const seat = validToken(token) ? this.seats.findIndex(s => !s.ai && s.token === token) : -1;
      if (seat >= 0) this._bind(connId, seat);
      else this.conns[connId] = -1;
      return this.conns[connId];
    }

    _bind(connId, seat, notify = false) {
      const st = this.seats[seat], previous = st.connId;
      if (previous && previous !== connId) {
        this.conns[previous] = -1;
        if (notify) {
          this.send(previous, { t: 'welcome', connId: previous, seat: -1, host: false });
          this._stateTo(previous);
        }
      }
      st.connId = connId; st.connected = true; this.conns[connId] = seat;
    }

    // ------------------------------- messages ------------------------------
    onMessage(connId, msg) {
      if (!msg || typeof msg.t !== 'string') return;
      switch (msg.t) {
        case 'join':     return this.join(connId, msg.name, msg.token);
        case 'start':    return this._start(connId, msg.opts);
        case 'action':   return this._action(connId, msg);
        case 'takeover': return this._takeover(connId, msg);
        case 'name':     return this._rename(connId, msg.name);
        case 'rematch':  return this._rematch(connId);
        case 'addAI':    return this._addAI(connId, msg.level);
        case 'removeAI': return this._removeAI(connId, msg.seat);
        case 'aiLevel':  return this._setAILevel(connId, msg.seat, msg.level);
        case 'shuffle':  return this._shuffle(connId);
        case 'sync':     return this._stateTo(connId);
      }
    }

    // 改名：大厅里随时可改，立即广播给所有人（不重发 welcome，避免打断状态）。
    // 名字只影响显示；座位归属仍由 token 决定。
    _rename(connId, name) {
      const seat = this.conns[connId];
      if (seat == null || seat < 0) return;                     // 观战者没有名字
      const clean = cleanName(name);
      if (!clean) return;
      if (this.seats[seat].name === clean) return;              // 无变化不广播
      this.seats[seat].name = clean;
      // 已开局时同步改游戏内的显示名，这样计分板/日志也跟着更新
      if (this.G && this.G.players[seat]) this.G.players[seat].name = clean;
      this._roster();
      if (this.started) this._broadcastState();
    }

    // 再来一局：房主在对局结束后把房间打回大厅，座位（含电脑）与 token 全部保留，
    // 这样朋友之间连着打好几局不用重新建房、重新发链接。
    _rematch(connId) {
      if (!this._isHost(connId)) return this.send(connId, { t: 'reject', reason: '只有房主可以开始下一局' });
      if (!this.started) return;                                // 已经在大厅了
      if (!this.G || this.G.phase !== 'gameover') {
        return this.send(connId, { t: 'reject', reason: '本局还没结束' });
      }
      this.G = null;
      this.started = false;
      this.turnStartedAt = 0;
      this.shuffleCount = 0;
      this.seq++;
      this._broadcast({ t: 'lobby' });                          // 客户端据此回到大厅界面
      this._roster();
    }

    // ------------------------- lobby: bots & seat order ------------------------
    _lobbyHostGuard(connId) {
      if (!this._isHost(connId)) { this.send(connId, { t: 'reject', reason: '只有房主可以调整座位' }); return false; }
      if (this.started) { this.send(connId, { t: 'reject', reason: '对局进行中，回到大厅后再调整座位' }); return false; }
      return true;
    }
    _aiName() {
      const used = new Set(this.seats.map(s => s.name));
      for (let n = 1; n <= 9; n++) { const nm = '电脑' + n; if (!used.has(nm)) return nm; }
      return '电脑';
    }
    _addAI(connId, level) {
      if (!this._lobbyHostGuard(connId)) return;
      if (this.seats.length >= this.maxSeats) {
        return this.send(connId, { t: 'reject', reason: '座位已满（最多 ' + this.maxSeats + ' 人）' });
      }
      const lv = AI_LEVELS.indexOf(level) >= 0 ? level : DEFAULT_AI_LEVEL;
      this.seats.push({ token: null, name: this._aiName(), connId: null, connected: true, ai: lv });
      this._roster();
    }
    _removeAI(connId, seat) {
      if (!this._lobbyHostGuard(connId)) return;
      seat = Number(seat);
      if (!Number.isInteger(seat) || !this.seats[seat] || !this.seats[seat].ai) {
        return this.send(connId, { t: 'reject', reason: '该座位不是电脑' });
      }
      const order = [];
      for (let i = 0; i < this.seats.length; i++) if (i !== seat) order.push(i);
      this._reorderSeats(order, false);
    }
    _setAILevel(connId, seat, level) {
      if (!this._lobbyHostGuard(connId)) return;
      seat = Number(seat);
      if (!Number.isInteger(seat) || !this.seats[seat] || !this.seats[seat].ai) {
        return this.send(connId, { t: 'reject', reason: '该座位不是电脑' });
      }
      if (AI_LEVELS.indexOf(level) < 0) return this.send(connId, { t: 'reject', reason: '未知的电脑难度' });
      if (this.seats[seat].ai === level) return;
      this.seats[seat].ai = level;
      this._roster();
    }
    // Randomize seat (= turn) order with a uniform Fisher–Yates shuffle over crypto
    // randomness. It is deliberately NOT forced to differ from the current order:
    // "always change" is not uniform (with 2 players it would just deterministically
    // swap). Instead every shuffle is announced to everyone with a running count, so
    // a host re-rolling until they move first is visible to the whole table.
    _shuffle(connId) {
      if (!this._lobbyHostGuard(connId)) return;
      if (this.seats.length < 2) return this.send(connId, { t: 'reject', reason: '至少 2 个座位才能随机顺序' });
      const order = this.seats.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = randInt(i + 1);
        const t = order[i]; order[i] = order[j]; order[j] = t;
      }
      this._reorderSeats(order, true);
    }
    // Reorder seats: order[newIndex] = oldIndex (old seats absent from `order` are
    // dropped — only ever bots). Remaps every live connection to its new index and
    // re-sends `welcome` to each seated connection whose index changed, because the
    // client keys "which player am I" off that seat number.
    _reorderSeats(order, shuffled) {
      const oldToNew = {};
      order.forEach((oldIdx, newIdx) => { oldToNew[oldIdx] = newIdx; });
      this.seats = order.map(i => this.seats[i]);
      const moved = [];
      for (const cid in this.conns) {
        const s = this.conns[cid];
        if (s == null || s < 0) continue;
        const ns = oldToNew[s];
        if (ns == null) { this.conns[cid] = -1; moved.push(cid); continue; }
        if (ns !== s) { this.conns[cid] = ns; moved.push(cid); }
      }
      for (const cid of moved) this.send(cid, { t: 'welcome', connId: cid, seat: this.conns[cid], host: this._isHost(cid) });
      if (shuffled) {
        this.shuffleCount++;
        this._broadcast({ t: 'shuffled', count: this.shuffleCount, first: this.seats[0] ? this.seats[0].name : '' });
      }
      this._roster();
    }

    // ------------------------------- game flow ------------------------------
    _start(connId, opts) {
      if (!this._isHost(connId)) return this.send(connId, { t: 'reject', reason: '只有房主可以开始游戏' });
      if (this.started) return this._stateTo(connId);
      if (this.seats.length < 2 || this.seats.length > 4) return this.send(connId, { t: 'reject', reason: '联机对局需要 2–4 名玩家（可以添加电脑补位）' });
      opts = opts || {};
      const names = this.seats.map((s, i) => s.name || ('训练家 ' + (i + 1)));
      // server-authoritative RNG: NEVER trust a client-supplied seed — it would let
      // the host precompute the entire deck order. Mint it here; fall back to the
      // engine's own random seed if Web Crypto is somehow unavailable.
      let seed;
      try { seed = globalThis.crypto.getRandomValues(new Uint32Array(1))[0] >>> 0; } catch (e) { seed = undefined; }
      this.G = E.createGame(this.DB, {
        numPlayers: this.seats.length, names,
        ai: this.seats.map(s => !!s.ai),
        megas: !!opts.megas, megaDB: this.megaDB,
        pokemart: !!opts.pokemart, pokemartDB: this.pokemartDB,
        seed,
      });
      // same field the local game uses (ui.js startGame): lets clients label bots
      this.G.players.forEach((p, i) => { p.diff = this.seats[i].ai || null; });
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

    // Is it a bot's turn right now? The transport polls this after every message and
    // schedules stepAI() with a human-readable delay.
    aiPending() {
      const p = this.started && this.G && this.G.phase === 'play' ? this.G.players[this.G.turn] : null;
      return !!(p && p.isAI);
    }

    // Execute ONE complete bot turn (main action → discards → evolution → end turn)
    // and broadcast the result. The bot decides from belief views (ai.js chooseTurn
    // re-samples hidden cards), so running it on the authoritative state does not
    // let it peek at opponents' reserves or the deck order. Never stalls: a missing
    // AI module or a thrown/invalid plan falls back to a legal move.
    //
    // `attempt` = how many times this very bot turn already failed to finish (the DO
    // passes its alarm retry count, e.g. after the platform killed an over-CPU-budget
    // think). Each retry thinks more cheaply, so one expensive bot can never wedge a room.
    stepAI(attempt) {
      if (!this.aiPending()) return false;
      const seat = this.G.turn;
      const lv = AI_LEVELS.indexOf(this.G.players[seat].diff) >= 0 ? this.G.players[seat].diff : DEFAULT_AI_LEVEL;
      const opts = aiThinkOpts(lv, attempt);
      let plan = null;
      if (opts && this.AI && typeof this.AI.chooseTurn === 'function') {
        try { plan = this.AI.chooseTurn(this.G, opts); } catch (e) { plan = null; }
      }
      this._applyPlan(seat, plan || {});
      this.turnStartedAt = this.now;
      this.seq++;
      this._broadcastState();
      if (this.G.phase === 'gameover') this._broadcast({ t: 'over', winner: this.G.winner });
      return true;
    }

    // A timed-out HUMAN seat is played by the AI on request of any other seated
    // player. The requester computes the plan from PUBLIC info only (it never sees the
    // timed-out player's hidden hand); the server re-validates that the 3-min timeout
    // truly elapsed (anti-cheat) and then runs the whole turn for the active seat.
    _takeover(connId, msg) {
      // 任何「在座」玩家都可以替超时的人触发 AI 代打 —— 早期只允许房主，
      // 导致「掉线/挂机的正是房主」时全场永远卡死（房主还不代打自己）。
      // 只要还有一个人在线，牌局就能推进；服务端仍二次校验超时，防提前接管。
      const by = this.conns[connId];
      if (by == null || by < 0) return this.send(connId, { t: 'reject', reason: '观战者不能代打' });
      if (!this.started || !this.G || this.G.phase !== 'play') return;
      // 电脑座位由服务器自己执行 —— 绝不能让任何客户端替电脑提交走法（否则谁提交谁操控电脑）
      if (this.G.players[this.G.turn] && this.G.players[this.G.turn].isAI) {
        return this.send(connId, { t: 'reject', reason: '电脑的回合由服务器执行，无需代打' });
      }
      if (by === this.G.turn) return this.send(connId, { t: 'reject', reason: '不能替自己代打' });
      if (this.now - this.turnStartedAt < TURN_TIMEOUT_MS) return this.send(connId, { t: 'reject', reason: '尚未超时' });
      const seat = this.G.turn;
      this.G.log.push({ turn: this.G.turn, round: this.G.round, msg: `⏱️ ${this.G.players[seat].name} 超时，由 AI 代打` });
      this._applyPlan(seat, (msg && msg.plan) || {});
      this.turnStartedAt = this.now;
      this.seq++;
      this._broadcastState();
      if (this.G.phase === 'gameover') this._broadcast({ t: 'over', winner: this.G.winner });
    }

    // Apply a whole-turn plan {action, discards, megaEvolution|evolution} for `seat`
    // defensively: every step goes through the engine, bad/missing parts fall back to
    // something legal, and the turn always ends (a room must never stall).
    _applyPlan(seat, plan) {
      plan = plan || {};
      // main action (the plan's pick, else any legal action, else a legitimate pass)
      let acted = false;
      try { if (plan.action) acted = E.applyAction(this.G, plan.action, seat).ok; } catch (e) { }
      if (!acted) {
        let la = []; try { la = E.legalActions(this.G); } catch (e) { }
        if (la.length) { try { acted = E.applyAction(this.G, la[0], seat).ok; } catch (e) { } }
        if (!acted) { try { E.actionPass(this.G); } catch (e) { } }
      }
      // discards (plan first, but never beyond what the cap actually requires)
      if (Array.isArray(plan.discards)) for (const col of plan.discards) {
        if (!E.needsDiscard(this.G, this.G.players[seat])) break;
        if (E.ALL_TOKENS.indexOf(col) < 0) continue;
        try { E.actionDiscard(this.G, col); } catch (e) { }
      }
      let guard = 0;
      while (E.needsDiscard(this.G, this.G.players[seat]) && guard++ < 20) {
        const tok = E.ALL_TOKENS.find(c => this.G.players[seat].tokens[c] > 0);
        if (!tok) break;
        try { E.actionDiscard(this.G, tok); } catch (e) { break; }
      }
      if (plan.megaEvolution) { try { E.actionMegaEvolve(this.G, plan.megaEvolution.megaId, plan.megaEvolution.fromId); } catch (e) { } }
      else if (plan.evolution) { try { E.actionEvolve(this.G, plan.evolution.fromId, plan.evolution.toId); } catch (e) { } }
      try { E.endTurn(this.G); } catch (e) { }
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
      const players = this.seats.map((s, i) => ({
        seat: i, name: s.name, connected: s.ai ? true : s.connected, ai: s.ai || null,
      }));
      this._broadcast({ t: 'roster', players, hostSeat: this._hostSeat(), started: this.started, maxSeats: this.maxSeats });
    }
    _broadcast(msg) { for (const cid in this.conns) this.send(cid, msg); }

    // ----------------------- persistence (for the DO) ----------------------
    // The DO snapshots this to durable storage and restores it on wake, so a
    // room survives eviction/restart. Live connections (conns) are NOT persisted
    // — clients reconnect with their token and re-sync. Seats keep their token,
    // so reconnecting players reclaim their seat and hidden hand.
    snapshot() {
      const seats = this.seats.map(s => ({ token: s.token, name: s.name, connId: null, connected: false, ai: s.ai || null }));
      return {
        seq: this.seq, started: this.started, seats, hostToken: this.hostToken, shuffleCount: this.shuffleCount,
        turnStartedAt: this.turnStartedAt, g: this.G ? serializeG(this.G) : null,
      };
    }
    restore(snap) {
      if (!snap) return;
      this.seq = snap.seq || 0;
      this.started = !!snap.started;
      this.turnStartedAt = snap.turnStartedAt || 0;
      this.shuffleCount = snap.shuffleCount || 0;
      this.seats = (snap.seats || []).map(s => {
        const ai = AI_LEVELS.indexOf(s.ai) >= 0 ? s.ai : null;
        return { token: ai ? null : s.token, name: s.name, connId: null, connected: !!ai, ai };
      });
      // Snapshots written before hostToken existed had host = seat 0.
      const legacyHost = this.seats.find(s => !s.ai && s.token);
      this.hostToken = snap.hostToken != null ? snap.hostToken : (legacyHost ? legacyHost.token : null);
      this.conns = {};
      this.G = snap.g ? reattachG(snap.g, this.DB, this.megaDB, this.pokemartDB) : null;
    }
  }

  return { Room, serializeG, reattachG, TURN_TIMEOUT_MS, AI_LEVELS, DEFAULT_AI_LEVEL };
});
