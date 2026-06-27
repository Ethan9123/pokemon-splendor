/* ===================== Pokémon Splendor — UI ===================== */
(function () {
  'use strict';
  const E = window.Engine, AI = window.AI, DB = window.CARD_DB;
  const MEGA_DB = window.MEGA_DB || [];
  const POKEMART_DB = window.POKEMART_DB || [];
  // 究极 difficulty: determinized MCTS budget (validated ~57.5% vs 高手 at sims=200/dets=3 over 200 games).
  const ULTRA_CFG = { sims: 200, dets: 3 };
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const BALL_NAMES = { red: '精灵球', blue: '超级球', black: '高级球', pink: '治愈球', yellow: '先机球', purple: '大师球' };
  const TIER_NAMES = { legend: '传说', rare: '稀有', stage3: '三阶', stage2: '二阶', stage1: '一阶', mega: 'Mega', pmL1: '商店Ⅰ', pmL2: '商店Ⅱ', pmL3: '商店Ⅲ' };
  const EFFECT_NAMES = { copy: '进化石·关联', colorless_master: '图鉴·可抵2万能', double: '药水·双奖励', copy_free: '神奇糖果·关联+免费取卡', free: '技能机·免费取卡', discard_buy: '驱虫·弃2张同色购买' };
  const SEAT_COLORS = ['#e3350d', '#2f6fd6', '#46d17a', '#f4c025'];
  // per-seat trainer avatars (head/bust crops of the TTS trainer figurines)
  const SEAT_AVATARS = ['ash', 'misty', 'brock', 'rocket'];
  const seatAvatar = (i) => `assets/avatars/${SEAT_AVATARS[i % 4]}.png`;
  const byId = {}; DB.forEach(c => byId[c.id] = c); MEGA_DB.forEach(c => byId[c.id] = c); POKEMART_DB.forEach(c => byId[c.id] = c);

  let G = null;
  let UI = { pick: [], selCard: null, selDeck: null, phase: 'main', busy: false, humans: 0 };

  // ---------------------------------------------------------------- setup
  function buildSeats(n) {
    const seats = $('#seats');
    seats.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const def = i === 0 ? 'human' : (n === 2 ? 'ai' : (i === 1 ? 'ai' : 'human'));
      const div = document.createElement('div');
      div.className = 'seat';
      div.innerHTML =
        `<div class="pid" style="background-color:${SEAT_COLORS[i]};background-image:url(${seatAvatar(i)})" title="${SEAT_AVATARS[i]}"></div>
         <input type="text" value="训练家 ${i + 1}" maxlength="10" data-name="${i}">
         <select data-kind="${i}">
           <option value="human">真人</option>
           <option value="ai">电脑</option>
         </select>
         <select data-diff="${i}">
           <option value="hard">高手</option>
           <option value="ultra">究极(最强·搜索)</option>
           <option value="normal">普通</option>
           <option value="easy">新手</option>
           <option value="alphazero">AlphaZero(实验)</option>
         </select>`;
      seats.appendChild(div);
      $(`[data-kind="${i}"]`, div).value = def;
      const syncDiff = () => { $(`[data-diff="${i}"]`, div).style.display = $(`[data-kind="${i}"]`, div).value === 'ai' ? '' : 'none'; };
      $(`[data-kind="${i}"]`, div).addEventListener('change', syncDiff); syncDiff();
    }
  }

  function readConfig() {
    const n = +$('#player-count .active').dataset.n;
    const names = [], ai = [], diff = [];
    for (let i = 0; i < n; i++) {
      names.push($(`[data-name="${i}"]`).value.trim() || ('训练家 ' + (i + 1)));
      const isAI = $(`[data-kind="${i}"]`).value === 'ai';
      ai.push(isAI);
      diff.push($(`[data-diff="${i}"]`).value);
    }
    return { numPlayers: n, names, ai, diff };
  }

  // shared entry: drop into the game screen for a prebuilt game state `g`.
  function enterGame(g, opts) {
    opts = opts || {};
    G = g; gameEpoch++;                                 // invalidate any timers from a prior game
    UI = { pick: [], selCard: null, selDeck: null, phase: 'main', busy: false, humans: (opts.humans != null ? opts.humans : 1), hasAI: !!opts.hasAI };
    undoStack = [];
    $('#setup').classList.add('hidden');
    if ($('#rules-modal')) $('#rules-modal').classList.add('hidden');
    $('#game').classList.remove('hidden');
    $('#win-modal').classList.add('hidden');
    render();
    beginTurn();
  }
  function backToSetup() {
    gameEpoch++; UI.busy = false;
    $('#game').classList.add('hidden');
    $('#win-modal').classList.add('hidden');
    $('#setup').classList.remove('hidden');
  }

  // ============================ online multiplayer ============================
  function makeRoomCode() {
    const ch = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s = '';
    for (let i = 0; i < 5; i++) s += ch[Math.floor(Math.random() * ch.length)];
    return s;
  }
  function openOnline(code, asHost) {
    code = (code || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
    if (!code || !window.Net) return;
    if (window.Tutorial && Tutorial.stop) Tutorial.stop();
    const name = (($('[data-name="0"]') && $('[data-name="0"]').value.trim()) || '训练家');
    gameEpoch++;
    UI = { pick: [], selCard: null, selDeck: null, phase: 'main', busy: false, humans: 0, hasAI: false,
           net: { code, name, seat: null, host: !!asHost, status: 'connecting', started: false, roster: [] } };
    try { history.replaceState(null, '', location.pathname + '?room=' + code); } catch (e) { }
    $('#setup').classList.add('hidden'); $('#game').classList.add('hidden');
    $('#lobby').classList.remove('hidden');
    $('#lobby-code').textContent = code;
    bindNet();
    Net.connect(code, name);
    renderLobby();
  }
  function bindNet() {
    Net.on('status', (s) => { if (UI.net) { UI.net.status = s; renderLobby(); } });
    Net.on('welcome', (m) => { if (UI.net) { UI.net.seat = m.seat; UI.net.host = m.host; renderLobby(); } });
    Net.on('roster', (m) => { if (UI.net) { UI.net.roster = m.players || []; UI.net.started = m.started; renderLobby(); } });
    Net.on('state', onNetState);
    Net.on('reject', (m) => { if (UI.net) UI.net.takeoverBusy = false; flashHint((m && m.reason) || '操作被拒绝'); });
    Net.on('over', () => { });
  }
  function renderLobby() {
    if (!UI.net) return;
    const statusZh = { connecting: '连接中…', connected: '已连接', disconnected: '已断开，重连中…' };
    const seatTxt = UI.net.seat == null ? '' : (UI.net.seat < 0 ? '（观战）' : `（你是 ${UI.net.seat + 1} 号位${UI.net.host ? ' · 房主' : ''}）`);
    const st = $('#lobby-status'); if (st) st.textContent = '状态：' + (statusZh[UI.net.status] || UI.net.status) + ' ' + seatTxt;
    const r = UI.net.roster || [];
    const rr = $('#lobby-roster');
    if (rr) rr.innerHTML = r.length
      ? r.map(p => `<div class="lr-row"><span class="lr-dot ${p.connected ? 'on' : 'off'}"></span>${p.seat + 1}. ${p.name}${p.seat === 0 ? ' 👑' : ''}${p.seat === UI.net.seat ? '（你）' : ''}</div>`).join('')
      : '<div class="muted">等待玩家加入…</div>';
    const start = $('#lobby-start');
    if (start) { start.style.display = UI.net.host ? '' : 'none'; start.disabled = !(r.length >= 2); }
    const mb = $('#lobby-megas'), pb = $('#lobby-pokemart');
    if (mb) mb.disabled = !UI.net.host;
    if (pb) pb.disabled = !UI.net.host;
  }
  function leaveOnline() {
    stopIdleTimer();
    if (window.Net) Net.close();
    UI.net = null; gameEpoch++;
    try { history.replaceState(null, '', location.pathname); } catch (e) { }
    $('#lobby').classList.add('hidden'); $('#game').classList.add('hidden');
    $('#setup').classList.remove('hidden');
  }
  // Apply an authoritative redacted snapshot from the server (server drives turns).
  function onNetState(m) {
    if (!m || !m.state || !UI.net) return;
    const st = m.state;
    st.cardDB = DB; st.byId = byId; st.megaDB = MEGA_DB; st.pokemartDB = POKEMART_DB; // reattach static refs
    if (!Array.isArray(st.log)) st.log = [];
    G = st; gameEpoch++;
    UI.net.started = true; UI.humans = G.numPlayers; UI.hasAI = false;
    // idle-timeout clock (for AI takeover): store the server's turn-start + clock
    UI.net.turnStartedAt = m.turnStartedAt || 0;
    UI.net.serverNow = m.serverNow || 0;
    UI.net.turnTimeoutMs = m.turnTimeoutMs || 180000;
    UI.net.stateAt = Date.now();
    UI.net.takeoverBusy = false;            // new authoritative state → allow a fresh takeover
    $('#setup').classList.add('hidden'); $('#lobby').classList.add('hidden');
    $('#game').classList.remove('hidden');
    recomputeOnlinePhase();
    render();
    startIdleTimer();
    if (G.phase === 'gameover') showWin();
  }

  // ----- idle / disconnect → host's AI takeover -----
  let idleTimer = null;
  function startIdleTimer() { if (!idleTimer) idleTimer = setInterval(idleTick, 1000); }
  function stopIdleTimer() { if (idleTimer) { clearInterval(idleTimer); idleTimer = null; } const ib = $('#idle-bar'); if (ib) ib.innerHTML = ''; }
  function idleMsLeft() {
    if (!UI.net || !UI.net.turnTimeoutMs) return Infinity;
    const idle = (UI.net.serverNow - UI.net.turnStartedAt) + (Date.now() - UI.net.stateAt);
    return UI.net.turnTimeoutMs - idle;
  }
  function activeConnected() {
    const r = (UI.net && UI.net.roster || []).find(p => p.seat === G.turn);
    return r ? r.connected : true;
  }
  function idleTick() {
    if (!isOnline() || !G || G.phase !== 'play') { stopIdleTimer(); return; }
    const ib = $('#idle-bar'); if (!ib) return;
    const msLeft = idleMsLeft();
    const secs = Math.max(0, Math.ceil(msLeft / 1000));
    const offline = !activeConnected();
    if (UI.net.takeoverBusy) ib.innerHTML = '<span class="idle-ai">🤖 房主AI代打中…</span>';
    else if (!myTurn()) ib.innerHTML = (offline || msLeft < 90000) ? `<span class="idle-wait">${offline ? '⚠ 对手已断线 · ' : ''}${secs} 秒后房主AI接管</span>` : '';
    else if (!UI.net.host) ib.innerHTML = (msLeft < 60000) ? `<span class="idle-warn">⏱️ 你还有 ${secs} 秒，否则由房主AI代打</span>` : ''; // only non-host gets taken over
    else ib.innerHTML = '';   // host's own turn: the host is never auto-taken-over
    // the HOST drives takeover for an idle OTHER seat (never its own turn) once the
    // timeout truly elapses (the server re-validates the timing).
    if (msLeft <= 0 && !UI.net.takeoverBusy && UI.net.host && !myTurn()) {
      UI.net.takeoverBusy = true;
      setTimeout(() => { if (UI.net && UI.net.takeoverBusy) UI.net.takeoverBusy = false; }, 6000); // safety: never stick
      setTimeout(() => { try { if (window.Net) Net.send({ t: 'takeover', plan: computeTakeoverPlan() }); } catch (e) { } }, 30);
    }
  }
  // Reconstruct a plausible FULL state from our redacted view so the AI can run:
  // fill the hidden deck with unseen cards, drop the hidden (stub) reserves. The AI
  // therefore plays from PUBLIC info only — it never sees a player's hidden hand.
  function determinizeForAI(s) {
    const d = E.clone(s);
    const seen = new Set();
    for (const t in d.field) for (const id of (d.field[t] || [])) if (id) seen.add(id);
    for (const id of (d.megaOffer || [])) seen.add(id);
    d.players.forEach(p => {
      (p.board || []).forEach(id => seen.add(id));
      (p.buried || []).forEach(id => seen.add(id));
      p.reserve = (p.reserve || []).filter(rid => typeof rid === 'string'); // drop {hidden,tier} stubs
      p.reserve.forEach(id => seen.add(id));
    });
    const pools = {};
    [].concat(DB, MEGA_DB, POKEMART_DB).forEach(c => { if (c && !seen.has(c.id)) (pools[c.tier] = pools[c.tier] || []).push(c.id); });
    for (const t in d.decks) {
      const pool = pools[t] || []; let k = 0;
      d.decks[t] = (d.decks[t] || []).map(() => pool.length ? pool[k++ % pool.length] : null).filter(x => x != null);
    }
    return d;
  }
  function computeTakeoverPlan() {
    let plan = null;
    try {
      const det = determinizeForAI(G);
      if (window.VSearch && det.numPlayers === 2) { try { plan = VSearch.chooseTurn(det, ULTRA_CFG); } catch (e) { plan = null; } }
      if (!plan || !plan.action) plan = AI.chooseTurn(det, { difficulty: 'hard' });
    } catch (e) { plan = null; }
    return plan || { action: null, discards: [], evolution: null };
  }
  // Derive the local UI phase from a snapshot. The board renders for everyone, but
  // you can only act on your own turn (interactable() also gates on myTurn()).
  function recomputeOnlinePhase() {
    UI.busy = false; UI.pick = []; UI.selCard = UI.selDeck = null;
    if (G.phase !== 'play' || !myTurn()) { UI.phase = 'main'; return; }
    if (E.needsDiscard(G, me())) { UI.phase = 'discard'; return; }
    if (!G.acted) { UI.phase = 'main'; return; }
    const ev = E.evolutionOptions(G, me());
    const mev = G.megasEnabled ? E.megaEvolveOptions(G, me()) : [];
    if (ev.length || mev.length) { UI.phase = 'evolve'; return; }
    UI.phase = 'main';
    Net.action({ type: 'endTurn' });   // acted with nothing left to resolve → end the turn
  }
  function startGame() {
    const cfg = readConfig();
    const megas = !!($('#opt-megas') && $('#opt-megas').checked) && MEGA_DB.length > 0;
    const pokemart = !!($('#opt-pokemart') && $('#opt-pokemart').checked) && POKEMART_DB.length > 0;
    const g = E.createGame(DB, { numPlayers: cfg.numPlayers, names: cfg.names, ai: cfg.ai, megas, megaDB: MEGA_DB, pokemart, pokemartDB: POKEMART_DB });
    g.players.forEach((p, i) => { p.diff = cfg.diff[i]; });
    if (cfg.diff.indexOf('alphazero') >= 0) loadPolicy();
    enterGame(g, { humans: cfg.ai.filter(x => !x).length, hasAI: cfg.ai.some(x => x) });
  }

  // ---------- local autosave: survive a refresh / re-open (single device) ----------
  // The whole game lives in the JSON-serializable G (players carry name/isAI/diff),
  // so we snapshot G to localStorage at each turn boundary and offer to resume it on
  // the next load. Static card refs are dropped here and re-attached on restore.
  // Saved at beginTurn() only (acted===false) so a resume always lands on a clean
  // turn start, never a half-finished action. Cleared on game-over / quit-to-menu.
  const SAVE_KEY = 'pkmn_splendor_save_v1';
  const inTutorial = () => !!(window.Tutorial && Tutorial.active && Tutorial.active());
  function clearSave() {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { }
    const b = document.getElementById('resume-banner'); if (b) b.remove(); // drop a now-stale banner
  }
  function autosave() {
    try {
      if (!G || inTutorial() || G.phase !== 'play') return;
      const { cardDB, byId: _b, megaDB, pokemartDB, ...dyn } = G; // drop shared static refs
      localStorage.setItem(SAVE_KEY, JSON.stringify({ v: 1, ts: Date.now(), g: dyn }));
    } catch (e) { /* storage full/disabled → game still works, just no resume */ }
  }
  function loadSave() {
    try { const o = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); return (o && o.v === 1 && o.g) ? o : null; }
    catch (e) { return null; }
  }
  function resumeSaved() {
    const o = loadSave(); if (!o) return false;
    const g = Object.assign({}, o.g);
    g.cardDB = DB; g.byId = byId; g.megaDB = MEGA_DB; g.pokemartDB = POKEMART_DB; // re-attach statics
    if (!Array.isArray(g.log)) g.log = [];
    enterGame(g, { humans: g.players.filter(p => !p.isAI).length, hasAI: g.players.some(p => p.isAI) });
    return true;
  }
  // On the setup screen, surface a "continue last game" banner when a save exists.
  function offerResume() {
    const o = loadSave(); if (!o) return;
    if ($('#resume-banner')) return;
    const g = o.g, seat = (g.players && g.players[g.turn]) ? g.players[g.turn].name : '';
    const vp = (g.players || []).map(p => p.name + ' ' + (p.board || []).reduce((a, id) => a + ((byId[id] && byId[id].vp) || 0), 0) + '分').join(' · ');
    const when = o.ts ? new Date(o.ts).toLocaleString('zh-CN', { hour12: false }) : '';
    const div = document.createElement('div');
    div.id = 'resume-banner'; div.className = 'resume-banner';
    div.innerHTML = `<div class="rb-text">发现未完成的对局${seat ? `，轮到 <b>${seat}</b>` : ''}` +
      `${vp ? `<br><small>${vp}</small>` : ''}${when ? `<br><small class="rb-when">${when}</small>` : ''}</div>` +
      `<div class="rb-btns"><button id="resume-btn" class="primary">▶ 继续上一局</button>` +
      `<button id="resume-discard" class="ghost">放弃</button></div>`;
    const card = $('.setup-card'), tagline = card && card.querySelector('.tagline');
    if (tagline) card.insertBefore(div, tagline.nextSibling);
    else if (card) card.insertBefore(div, card.firstChild);
    else $('#setup').appendChild(div);
    $('#resume-btn').addEventListener('click', resumeSaved);
    $('#resume-discard').addEventListener('click', () => { clearSave(); div.remove(); });
  }

  // ---------------------------------------------------------------- helpers
  // online play: when in a network game, "me" is the local SEAT (which may not be
  // the active player), and you can only act on your own turn. Local play unchanged.
  function isOnline() { return !!(UI && UI.net); }
  function onlineSeat() { return (UI && UI.net && UI.net.seat != null) ? UI.net.seat : -1; }
  function myTurn() { return !!(G && G.turn === onlineSeat()); }
  const me = () => G.players[(isOnline() && UI.net.seat >= 0) ? UI.net.seat : G.turn];
  const isHuman = (pid) => !G.players[pid].isAI;
  const ball = (color, cls, label) =>
    `<div class="ball ${color} ${cls || ''}" title="${BALL_NAMES[color]}">${label != null ? '' : ''}</div>`;

  // opts.aff: null | { master } from affordInfo(). master>0 => needs Master Balls
  // (purple tier + a 大师×N count badge — colour-blind-safe redundant cue).
  function cardHTML(id, opts) {
    opts = opts || {};
    const c = byId[id];
    if (!c) return `<div class="card"><div class="empty-slot">—</div></div>`;
    const aff = opts.aff;
    let cls = '', badge = '';
    if (aff) {
      cls = aff.master > 0 ? ' affordable affordable-wild' : ' affordable';
      if (aff.master > 0) badge = `<div class="wild-badge" title="买这张会花费 ${aff.master} 个大师球（万能球）">大师×${aff.master}</div>`;
    }
    const sel = (UI.selCard === id) ? ' selected' : '';
    const reserveMini = opts.canReserve ? `<div class="reserve-mini" data-reserve-card="${id}">＋保留</div>` : '';
    return `<div class="card${cls}${sel}" data-card="${id}" data-zoom="${c.img}">
              <img src="${c.img}" alt="${c.name}" loading="lazy">${reserveMini}${badge}
            </div>`;
  }

  // ---------------------------------------------------------------- render
  function render() {
    renderBanner(); renderField(); renderMyResources(); renderSupply(); renderActionBar(); renderPlayers(); renderLog();
    updateUndoBtn();   // keep 悔棋 button consistent with phase/turn on every state change
    evalRotateHint();  // show/hide the portrait "rotate" hint
    syncDockH();       // keep mobile bottom-dock clearance in sync with its current height
    if (G && G.phase === 'gameover') clearSave();   // finished game → nothing to resume
    if (window.Tutorial && Tutorial.onRender) { try { Tutorial.onRender(G, UI); } catch (e) { } } // drive the tutorial coach
  }

  // active player's held tokens + permanent bonus discounts, pinned in the dock so you
  // never have to scroll to your own panel to plan a purchase.
  function renderMyResources() {
    const host = $('#my-resources'); if (!host) return;
    const p = me();
    if (!p || p.isAI || G.phase === 'gameover') { host.innerHTML = ''; host.style.display = 'none'; return; }
    host.style.display = '';
    const b = E.bonuses(G, p);
    let chips = '';
    for (const c of E.COLORS) {
      chips += `<div class="mychip"><div class="ball ${c} sm"></div><span class="mc-tok">${p.tokens[c]}</span><span class="mc-bon">+${b[c]}</span></div>`;
    }
    chips += `<div class="mychip"><div class="ball purple sm"></div><span class="mc-tok">${p.tokens.purple}</span></div>`;
    if (G.megasEnabled) chips += `<div class="mychip"><div class="ball mega-token sm"></div><span class="mc-tok">${p.megaToken}</span></div>`;
    host.innerHTML = `<span class="mc-label">我的资源 · ${p.name}</span><div class="mychips">${chips}</div>`;
  }

  function renderBanner() {
    const p = isOnline() ? G.players[G.turn] : me();
    let txt;
    if (G.phase === 'gameover') txt = '游戏结束';
    else if (p.isAI) txt = `${p.name} 的回合 · <span class="thinking">思考中<span class="dot"></span><span class="dot"></span><span class="dot"></span></span>`;
    else txt = `${p.name} 的回合${isOnline() && myTurn() ? '（你）' : ''}${G.lastRound ? ' · ⚠ 最后一轮' : ''}`;
    $('#turn-banner').innerHTML = txt;
  }

  function renderField() {
    const wrap = $('#field');
    wrap.innerHTML = '';
    const human = (isOnline() ? myTurn() : isHuman(G.turn)) && G.phase === 'play';
    // Megas expansion: a face-up "Mega 卡" row (zoom only; you mega-evolve at end of turn)
    if (G.megasEnabled && G.megaOffer.length) {
      const rowEl = document.createElement('div');
      rowEl.className = 'tier-row tier-special tier-mega';
      let inner = `<div class="tier-label">Mega</div><div class="card-strip">`;
      const canMega = human && UI.phase === 'main' && me().megaToken >= 1;
      for (const id of G.megaOffer) {
        const c = byId[id];
        const canBuy = canMega && me().board.some(b => byId[b].name === c.megaFrom);
        inner += cardHTML(id, { aff: canBuy ? affordInfo(c) : null });
      }
      inner += '</div>';
      rowEl.innerHTML = inner;
      wrap.appendChild(rowEl);
    }
    const rows = [
      { tiers: ['legend', 'rare'], special: true },
      { tiers: ['stage3'] }, { tiers: ['stage2'] }, { tiers: ['stage1'] },
    ];
    for (const row of rows) {
      const rowEl = document.createElement('div');
      rowEl.className = 'tier-row' + (row.special ? ' tier-special' : '');
      let inner = `<div class="tier-label">${row.tiers.map(t => TIER_NAMES[t]).join('/')}</div>`;
      for (const tier of row.tiers) {
        const deckN = G.decks[tier].length;
        const canReserveDeck = human && UI.phase === 'main' && E.NORMAL_TIERS.includes(tier) && deckN > 0 && me().reserve.length < E.HAND_MAX && !G.acted;
        inner += `<div class="deck-pile ${canReserveDeck ? 'reservable' : ''}" data-tier="${tier}" ${canReserveDeck ? `data-deck="${tier}"` : ''}>
                    <div class="count">${deckN}</div><div class="deck-tag">${TIER_NAMES[tier]}牌堆</div></div>`;
        inner += '<div class="card-strip">';
        for (const id of G.field[tier]) {
          if (!id) { inner += `<div class="card"><div class="empty-slot">—</div></div>`; continue; }
          const c = byId[id];
          const aff = (human && UI.phase === 'main' && !G.acted) ? affordInfo(c) : null;
          const canReserve = human && UI.phase === 'main' && !G.acted && E.NORMAL_TIERS.includes(tier) && me().reserve.length < E.HAND_MAX;
          inner += cardHTML(id, { aff, canReserve });
        }
        inner += '</div>';
      }
      rowEl.innerHTML = inner;
      wrap.appendChild(rowEl);
    }
    // Pokémart expansion: 2 shop cards per level, shown high→low like the base rows.
    if (G.pokemartEnabled) {
      for (const tier of ['pmL3', 'pmL2', 'pmL1']) {
        const rowEl = document.createElement('div');
        rowEl.className = 'tier-row tier-pokemart';
        const deckN = G.decks[tier].length;
        const canReserveDeck = human && UI.phase === 'main' && deckN > 0 && me().reserve.length < E.HAND_MAX && !G.acted;
        let inner = `<div class="tier-label">${TIER_NAMES[tier]}</div>`;
        inner += `<div class="deck-pile ${canReserveDeck ? 'reservable' : ''}" data-tier="${tier}" ${canReserveDeck ? `data-deck="${tier}"` : ''}>
                    <div class="count">${deckN}</div><div class="deck-tag">商店牌堆</div></div>`;
        inner += '<div class="card-strip">';
        for (const id of G.field[tier]) {
          if (!id) { inner += `<div class="card"><div class="empty-slot">—</div></div>`; continue; }
          const c = byId[id];
          const aff = (human && UI.phase === 'main' && !G.acted) ? affordInfo(c) : null;
          const canReserve = human && UI.phase === 'main' && !G.acted && me().reserve.length < E.HAND_MAX;
          inner += cardHTML(id, { aff, canReserve });
        }
        inner += '</div>';
        rowEl.innerHTML = inner;
        wrap.appendChild(rowEl);
      }
    }
  }

  // Can the active human acquire this card right now (effect-aware)? Returns null if
  // not acquirable, else { master } where master = how many Master Balls (百搭) the
  // purchase would actually spend (0 = buyable with coloured balls alone). Drives both
  // the 捕捉 button and the green (free) vs purple (needs-wildcard) highlight.
  function affordInfo(card) {
    const p = me();
    if (E.isPokemart(card) && card.effect === 'discard_buy') {
      const col = card.effectParam.discardColor, n = card.effectParam.discardCount;
      return p.board.filter(id => E.effBonusColor(G, p, id) === col).length >= n ? { master: 0 } : null;
    }
    if (E.isPokemart(card) && (card.effect === 'copy' || card.effect === 'copy_free')) {
      if (!p.board.some(id => E.effBonusColor(G, p, id))) return null; // needs a bonus card to copy
    }
    const pay = E.computePayment(G, p, card);
    if (pay.ok) return { master: pay.pay.purple };
    // otherwise see if discarding owned POKÉDEX (2 virtual master each) would cover it
    const dex = p.board.filter(id => E.isPokemart(byId[id]) && byId[id].effect === 'colorless_master').length;
    for (let k = 1; k <= dex; k++) { const pp = E.computePayment(G, p, card, k * 2); if (pp.ok) return { master: pp.pay.purple, pokedex: k }; }
    return null;
  }
  const captureAffordable = (card) => !!affordInfo(card);

  // --- purchase ledger: an at-a-glance payment breakdown shown when a card is
  // selected. Per colour it shows 需(required) · 抵(covered free by bonuses, no
  // ball spent) · 交(balls handed back to the supply), how many 大师球 (Master /
  // wildcard) fill the shortfall, then an aggregate "你交出" strip of the exact
  // balls leaving your stash. Colour-blind safe: every state carries a symbol
  // (斜线=抵扣 / 实心=交出 / ★=大师) + numerals, never colour alone (WCAG 1.4.1).
  // Derives the same split as E.paymentBreakdown but also renders a preview when
  // the card isn't affordable yet. `info` = affordInfo(card) result (or null).
  function purchaseLedgerHTML(card, info) {
    // Repel (discard_buy) is bought by discarding cards, not balls → no ball ledger.
    if (E.isPokemart(card) && card.effect === 'discard_buy') return '';
    const p = me();
    const b = E.bonuses(G, p);
    const rows = [];
    let wildNeed = 0;
    for (const c of E.COLORS) {
      const required = card.cost[c] || 0;
      if (!required) continue;
      const bonusCovered = Math.min(required, b[c]);
      const remaining = required - bonusCovered;
      const paidColor = Math.min(remaining, p.tokens[c]);
      rows.push({ color: c, required, bonusCovered, paidColor, paidWild: remaining - paidColor });
      wildNeed += remaining - paidColor;
    }
    const mandatory = card.cost.purple || 0;                 // rare/legend printed Master
    const virtual = info && info.pokedex ? info.pokedex * 2 : 0; // wildcard from discarding 图鉴
    const masterNeed = wildNeed + mandatory;
    const masterFromStash = Math.max(0, masterNeed - virtual);
    const affordable = !!info;
    const masterShort = Math.max(0, masterNeed - p.tokens.purple - virtual);
    if (!rows.length && !mandatory) return ''; // no ball cost at all

    const pip = (extra) => `<span class="pip ball ${extra}"></span>`;
    let rowsHtml = '';
    for (const r of rows) {
      let pips = '';
      for (let i = 0; i < r.bonusCovered; i++) pips += pip(r.color + ' pip-bonus');
      for (let i = 0; i < r.paidColor; i++) pips += pip(r.color + ' pip-paid');
      for (let i = 0; i < r.paidWild; i++) pips += pip('purple pip-wild');
      const disc = r.bonusCovered ? ` <span class="pl-disc">−抵${r.bonusCovered}</span>` : '';
      const wild = r.paidWild ? ` <span class="pl-wild">(${r.paidWild}★)</span>` : '';
      rowsHtml += `<div class="pl-row">
          <span class="pl-name"><span class="ball ${r.color} xs"></span>${BALL_NAMES[r.color]}</span>
          <span class="pl-pips">${pips}</span>
          <span class="pl-calc">需${r.required}${disc} = 交<b class="pl-pay">${r.paidColor + r.paidWild}</b>${wild}</span>
        </div>`;
    }
    if (mandatory) {
      let pips = '';
      for (let i = 0; i < mandatory; i++) pips += pip('purple pip-wild');
      rowsHtml += `<div class="pl-row">
          <span class="pl-name"><span class="ball purple xs"></span>大师球·必需</span>
          <span class="pl-pips">${pips}</span>
          <span class="pl-calc">需${mandatory} = 交<b class="pl-pay">${mandatory}</b></span>
        </div>`;
    }

    let hoChips = '';
    for (const r of rows) if (r.paidColor) hoChips += `<span class="ho-chip"><span class="ball ${r.color} sm"></span>×${r.paidColor}</span>`;
    if (masterFromStash) hoChips += `<span class="ho-chip ho-master"><span class="ball purple sm"></span>★×${masterFromStash}</span>`;

    let body;
    if (!affordable) {
      body = `<div class="pl-short">⚠ 还差 <b>${masterShort}</b> 个球才能购买（大师球可抵任意颜色）</div>`;
    } else if (!hoChips) {
      body = `<div class="pl-free">✓ 免费！奖励已全额抵扣，无需交出任何球</div>`;
    } else {
      const vNote = virtual ? `<span class="pl-vnote">（含弃置图鉴抵充 ${virtual}）</span>` : '';
      body = `<div class="handover"><span class="ho-label">你交出</span>${hoChips}<span class="ho-arrow">→ 供应区</span>${vNote}</div>`;
    }

    const legend = rows.some(r => r.bonusCovered || r.paidWild)
      ? `<div class="pl-legend"><span class="lg lg-bonus"></span>奖励抵扣·免交 <span class="lg lg-paid"></span>交出该色球 <span class="lg lg-wild"></span>大师球抵充</div>`
      : '';

    return `<div class="pay-ledger${affordable ? '' : ' unafford'}">${rowsHtml}${legend}${body}</div>`;
  }

  function renderSupply() {
    const counts = {}; UI.pick.forEach(c => counts[c] = (counts[c] || 0) + 1);
    const human = (isOnline() ? myTurn() : isHuman(G.turn)) && G.phase === 'play' && UI.phase === 'main' && !G.acted;
    let html = '<div class="panel-title">精灵球供应</div>';
    for (const color of E.ALL_TOKENS) {
      const isMaster = color === 'purple';
      const pick = counts[color] || 0;
      const selectable = human && !isMaster && canAddBall(color);
      const dis = (!human || isMaster || (!selectable && !pick)) ? ' disabled' : '';
      html += `<div class="supply-row${pick ? ' picked' : ''}${dis}" ${(!isMaster) ? `data-color="${color}"` : ''}>
                 ${ball(color, '')}
                 <span class="name">${BALL_NAMES[color]}</span>
                 ${pick ? `<span class="picked-n">+${pick}</span>` : ''}
                 <span class="cnt">${G.supply[color]}</span>
               </div>`;
    }
    if (G.megasEnabled) {
      const canTake = human && me().megaToken < 1 && G.supply.megaToken > 0;
      const held = me().megaToken;
      html += `<div class="supply-row mega-row${canTake ? '' : ' disabled'}" ${canTake ? 'data-take-mega="1"' : ''} title="花费整个回合获得1个 Mega 代币">
                 <div class="ball mega-token"></div>
                 <span class="name">Mega 代币${held ? '（已持有）' : ''}</span>
                 <span class="cnt">${G.supply.megaToken}</span>
               </div>`;
    }
    $('#supply').innerHTML = html;
  }

  function canAddBall(color) {
    if (G.supply[color] <= 0) return false;
    const counts = {}; UI.pick.forEach(c => counts[c] = (counts[c] || 0) + 1);
    const distinct = Object.keys(counts);
    if (UI.pick.length === 0) return true;
    if (distinct.length === 1 && counts[distinct[0]] === 2) return false;     // already a pair
    if (distinct.length === 1 && counts[distinct[0]] === 1) {
      if (color === distinct[0]) return G.supply[color] >= 4;                 // make a pair
      return UI.pick.length < 3 && G.supply[color] > 0;                       // add distinct
    }
    return UI.pick.length < 3 && !counts[color] && G.supply[color] > 0;       // add 3rd distinct
  }

  function renderActionBar() {
    const bar = $('#action-bar');
    if (G.phase === 'gameover') { bar.innerHTML = '<div class="act-hint">游戏已结束。</div>'; return; }
    const p = me();
    if (p.isAI) { bar.innerHTML = '<div class="act-hint">电脑正在行动…</div>'; return; }
    if (isOnline() && !myTurn()) { bar.innerHTML = `<div class="act-hint">等待 <b>${G.players[G.turn].name}</b> 行动…<br><span style="font-size:12px;opacity:.7">轮到你时这里会出现操作按钮</span></div>`; return; }

    if (UI.phase === 'discard') {
      const over = E.tokenTotal(p) - E.TOKEN_MAX;
      let tray = E.ALL_TOKENS.filter(c => p.tokens[c] > 0)
        .map(c => `<div class="ball ${c}" data-discard="${c}" title="归还${BALL_NAMES[c]}" style="cursor:pointer">${''}</div>`).join('');
      bar.innerHTML = `<div class="act-hint">精灵球超过 10 个，请点击归还 <b>${over}</b> 个。</div><div class="tray">${tray}</div>`;
      return;
    }
    if (UI.phase === 'evolve') {
      const opts = dedupeEvo(E.evolutionOptions(G, p));
      let html = '<div class="act-hint">回合结束 · 可进化一只宝可梦（可选，每回合至多1次）：</div>';
      for (const o of opts) {
        const from = byId[o.fromId], to = byId[o.toId];
        html += `<button class="evo-option" data-evo-from="${o.fromId}" data-evo-to="${o.toId}">
                   <b>${from.name}</b> → <b>${to.name}</b>（+${to.vp - from.vp}分，需 ${o.count} 个${BALL_NAMES[o.color]}折扣）
                 </button>`;
      }
      const mopts = G.megasEnabled ? E.megaEvolveOptions(G, p) : [];
      for (const o of mopts) {
        const from = byId[o.fromId], mega = byId[o.megaId];
        const costStr = E.ALL_TOKENS.filter(k => mega.cost[k] > 0).map(k => `${mega.cost[k]}${BALL_NAMES[k]}`).join('+');
        html += `<button class="evo-option mega-evo" data-mega="${o.megaId}" data-mega-from="${o.fromId}">
                   ⚡<b>${from.name}</b> → <b>${mega.name}</b>（+${mega.vp - from.vp}分，付 ${costStr}，耗1 Mega代币）
                 </button>`;
      }
      html += `<div class="act-buttons"><button class="primary" data-act="end-turn">不进化，结束回合</button></div>`;
      bar.innerHTML = html;
      return;
    }
    // main phase
    if (UI.pick.length) {
      const trayHtml = UI.pick.map(c => `<div class="ball ${c} sm"></div>`).join('');
      bar.innerHTML = `<div class="act-hint">已选精灵球（${UI.pick.length}）：</div><div class="tray">${trayHtml}</div>
        <div class="act-buttons"><button class="primary" data-act="confirm-take">确定拿取</button><button class="ghost" data-act="clear-take">取消</button></div>`;
      return;
    }
    if (UI.selCard) {
      const c = byId[UI.selCard];
      const info = affordInfo(c);
      const aff = !!info;
      const loc = E.locateCard(G, UI.selCard);
      const reserveTier = (loc.where === 'field') && (E.NORMAL_TIERS.includes(loc.tier) || E.PM_TIERS.includes(loc.tier));
      const canReserve = reserveTier && p.reserve.length < E.HAND_MAX;
      const eff = E.isPokemart(c) && c.effect ? ` · <span class="eff-tag">${EFFECT_NAMES[c.effect] || ''}</span>` : '';
      let ledger = purchaseLedgerHTML(c, info);
      if (!ledger && !aff) ledger = `<div class="pay-ledger unafford"><div class="pl-short">⚠ 暂时无法购买</div></div>`;
      let html = `<img class="sel-preview" src="${c.img}" alt="${c.name}"><div class="act-hint">已选：<b>${c.name}</b>（${TIER_NAMES[c.tier]}，${c.vp}分）${eff}<br><span style="font-size:12px;opacity:.75">点卡面可放大查看</span></div>${ledger}<div class="act-buttons">`;
      if (aff) html += `<button class="primary" data-act="capture">捕捉</button>`;
      if (canReserve) html += `<button class="ghost" data-act="reserve-card">保留</button>`;
      html += `<button class="ghost" data-act="clear-sel">取消</button></div>`;
      bar.innerHTML = html;
      return;
    }
    if (UI.selDeck) {
      bar.innerHTML = `<div class="act-hint">保留 <b>${TIER_NAMES[UI.selDeck]}</b> 牌堆顶（获得1个大师球）？</div>
        <div class="act-buttons"><button class="primary" data-act="reserve-deck">保留牌堆顶</button><button class="ghost" data-act="clear-sel">取消</button></div>`;
      return;
    }
    bar.innerHTML = `<div class="act-hint">轮到你了。请选择一种行动：<br>· 点击精灵球拿取（3 异色 / 2 同色）<br>· 点击卡牌进行<b>捕捉</b>或<b>保留</b></div>`;
  }

  function dedupeEvo(opts) {
    // collapse to best target per fromId (highest VP target) for a tidy list
    const best = {};
    for (const o of opts) {
      const v = byId[o.toId].vp;
      if (!best[o.fromId] || v > byId[best[o.fromId].toId].vp) best[o.fromId] = o;
    }
    return Object.values(best);
  }

  function renderPlayers() {
    const wrap = $('#players');
    wrap.innerHTML = '';
    for (let i = 0; i < G.numPlayers; i++) {
      const p = G.players[i];
      const b = E.bonuses(G, p);
      const tot = E.tokenTotal(p);                // total Poké Balls held (10 max at turn end)
      const active = (i === G.turn && G.phase === 'play');
      const el = document.createElement('div');
      el.className = 'player' + (active ? ' active' : '') + (p.isAI ? ' ai' : '');
      // bonus + token chips
      let chips = '';
      for (const c of E.COLORS) {
        chips += `<div class="chip">${ball(c, 'sm')}<span class="num">${p.tokens[c]}</span><span class="bonus-n">+${b[c]}</span></div>`;
      }
      chips += `<div class="chip">${ball('purple', 'sm')}<span class="num">${p.tokens.purple}</span></div>`;
      // captured cards grouped by effective bonus color (Pokémart copy cards take
      // their associated colour; effect cards with no colour go in a final group).
      let stacks = '';
      const groups = E.COLORS.map(c => ({ key: c, ids: p.board.filter(id => E.effBonusColor(G, p, id) === c) }));
      groups.push({ key: null, ids: p.board.filter(id => E.effBonusColor(G, p, id) === null) });
      for (const g of groups) {
        if (!g.ids.length) continue;
        let st = '';
        g.ids.forEach((id, idx) => {
          st += `<div class="mini-card${idx ? ' stacked' : ''}" data-zoom="${byId[id].img}"><img src="${byId[id].img}" alt=""></div>`;
        });
        stacks += `<div class="color-stack"><div class="ministack">${st}</div></div>`;
      }
      // reserve: revealed only for YOUR OWN hand; others show card-backs.
      // (online, opponents' reserves arrive as {hidden,tier} stubs, never real ids.)
      const revealReserve = !p.isAI && (isOnline() ? (i === onlineSeat()) : active);
      let rz = '';
      if (p.reserve.length) {
        const cards = p.reserve.map(rid => {
          const stub = (rid && typeof rid === 'object');
          const realId = stub ? null : rid;
          const tier = stub ? rid.tier : byId[realId].tier;
          if (revealReserve && !stub) return `<div class="mini-card${UI.selCard === realId ? ' selected' : ''}" data-zoom="${byId[realId].img}" data-reserve-capture="${realId}"><img src="${byId[realId].img}"></div>`;
          return `<div class="mini-card card-back" data-tier="${tier}"></div>`;
        }).join('');
        const hint = revealReserve ? '（点击可捕捉）' : '';
        rz = `<div class="reserve-zone"><div class="rz-title">保留区 (${p.reserve.length})${hint}</div><div class="pcards">${cards}</div></div>`;
      }
      el.innerHTML =
        `<div class="player-head">
           <div class="pavatar" style="background-color:${SEAT_COLORS[i]};background-image:url(${seatAvatar(i)});box-shadow:0 0 0 2px ${SEAT_COLORS[i]}"></div>
           <div class="pname">${p.name}</div>
           <div class="ptokens${tot > E.TOKEN_MAX ? ' over' : tot === E.TOKEN_MAX ? ' full' : ''}" title="持有的精灵球总数（回合结束上限 ${E.TOKEN_MAX} 个）"><span class="pt-lbl">球</span>${tot}<small>/${E.TOKEN_MAX}</small></div>
           <div class="pscore">${E.scoreOf(G, p)}<small>/${G.megasEnabled ? E.MEGA_WIN_SCORE : E.WIN_SCORE}</small></div>
         </div>
         ${p.buried.length ? `<div class="buried-badge">已进化 ${p.buried.length}</div>` : ''}
         <div class="pstats">${chips}</div>
         <div class="pcards">${stacks || '<span style="color:var(--muted);font-size:12px">尚无宝可梦</span>'}</div>
         ${rz}`;
      wrap.appendChild(el);
    }
  }

  function renderLog() {
    const lines = G.log.slice(-40).map(l => `<div class="ln">${l.msg}</div>`).join('');
    const box = $('#log-lines'); box.innerHTML = lines; box.scrollTop = box.scrollHeight;
  }

  // ---------------------------------------------------------------- interactions
  function onSupplyClick(color) {
    if (!interactable()) return;
    if (canAddBall(color)) { UI.pick.push(color); UI.selCard = UI.selDeck = null; render(); }
  }
  function onCardClick(id) {
    if (!interactable() || UI.pick.length) return;
    if (byId[id] && byId[id].tier === 'mega') return; // Mega cards: zoom only; evolve at end of turn
    UI.selCard = id; UI.selDeck = null; renderField(); renderActionBar();
  }
  function onDeckClick(tier) {
    if (!interactable()) return;
    UI.selDeck = tier; UI.selCard = null; render();
  }
  function interactable() { return G && G.phase === 'play' && UI.phase === 'main' && !G.acted && !me().isAI && !UI.busy && (!isOnline() || myTurn()); }

  // ---------------------------------------------------------------- animations
  const ANIM_MS = 620;
  function centerOf(el) { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
  function flyNode(n, fx, fy, tx, ty) {
    n.style.transform = `translate(${fx}px,${fy}px)`;
    document.body.appendChild(n);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      n.style.transform = `translate(${tx}px,${ty}px) scale(.62)`;
      n.style.opacity = '0.12';
    }));
    setTimeout(() => n.remove(), ANIM_MS + 90);
  }
  function flyBall(color, rect, dc) {
    if (!rect) return;
    const n = document.createElement('div'); n.className = 'fly'; n.innerHTML = `<div class="ball ${color}"></div>`;
    flyNode(n, rect.left + rect.width / 2 - 17, rect.top + rect.height / 2 - 17, dc[0] - 17, dc[1] - 17);
  }
  function flyCard(img, rect, dc, tier) {
    const n = document.createElement('div'); n.className = 'fly fly-card';
    if (img) n.innerHTML = `<img src="${img}">`;
    else if (tier) n.setAttribute('data-tier', tier);          // blind deck reserve → tier-correct back
    else n.style.background = 'linear-gradient(135deg,#3a2a6e,#221a4a)';
    const fx = rect ? rect.left + rect.width / 2 : dc[0], fy = rect ? rect.top + rect.height / 2 : dc[1];
    flyNode(n, fx - 30, fy - 40, dc[0] - 30, dc[1] - 40);
  }
  function captureSrc(dec) {
    const src = [];
    if (!dec) return src;
    if (dec.type === 'take') {
      for (const c of (dec.colors || [])) { const el = $(`.supply-row[data-color="${c}"] .ball`); src.push({ color: c, rect: el ? el.getBoundingClientRect() : null }); }
    } else if (dec.cardId) {
      let el = $(`.card[data-card="${dec.cardId}"]`) || $(`[data-reserve-capture="${dec.cardId}"]`);
      const card = G.byId[dec.cardId];
      src.push({ rect: el ? el.getBoundingClientRect() : null, img: card ? card.img : null });
    } else if (dec.type === 'reserve' && dec.deck) {
      const el = $(`.deck-pile[data-tier="${dec.deck}"]`);   // blind deck reserve: fly a face-down card from the pile
      src.push({ rect: el ? el.getBoundingClientRect() : null, img: null, tier: dec.deck });
    }
    return src;
  }
  function playGhosts(src, dec, pid) {
    const panel = $$('#players .player')[pid];
    if (!panel) return;
    panel.classList.add('receiving'); setTimeout(() => panel.classList.remove('receiving'), 520);
    const dc = centerOf(panel);
    if (dec.type === 'take') { for (const it of (src || [])) flyBall(it.color, it.rect, dc); }
    else if (dec.type === 'capture' || dec.type === 'reserve') { const it = (src || [])[0]; if (it) flyCard(it.img, it.rect, dc, it.tier); }
  }
  // capture source rects, apply mutation, render, animate ghosts to the player, then continue
  function applyAnimated(dec, pid, mutate, after) {
    const src = captureSrc(dec);
    const r = mutate();
    if (r && r.ok === false) { flashHint(r.error); return; }
    const epoch = gameEpoch;
    render(); playGhosts(src, dec, pid);
    setTimeout(() => { if (epoch === gameEpoch) after(); }, ANIM_MS);   // skip if game changed (undo/new game)
  }

  function doTake() {
    const colors = UI.pick.slice(); const pid = G.turn;
    if (isOnline()) { Net.action({ type: 'take', colors }); UI.pick = []; render(); return; }
    applyAnimated({ type: 'take', colors }, pid, () => { const r = E.actionTake(G, colors); if (r.ok) UI.pick = []; return r; }, afterMainAction);
  }
  function commitCapture(cid, opts) {
    const pid = G.turn;
    if (isOnline()) { Net.action({ type: 'capture', cardId: cid, opts }); UI.selCard = null; render(); return; }
    applyAnimated({ type: 'capture', cardId: cid }, pid, () => { const r = E.actionCapture(G, cid, opts); if (r.ok) UI.selCard = null; return r; }, afterMainAction);
  }
  function doCapture() {
    const cid = UI.selCard, card = byId[cid];
    // Cards needing player choices (Pokémart effects, or spending POKÉDEX) collect
    // them via a modal first; everything else captures immediately.
    UI.busy = true; updateUndoBtn();
    gatherCaptureOpts(card).then((opts) => {
      UI.busy = false;
      if (opts === null) { render(); return; } // cancelled
      commitCapture(cid, opts);
    });
  }

  // ---- Pokémart effect choice collection (returns a Promise<opts|null>) ----
  function pickCards(o) {
    return new Promise((resolve) => {
      const modal = $('#choice-modal'), confirm = $('#choice-confirm'), cancel = $('#choice-cancel');
      $('#choice-title').textContent = o.title;
      $('#choice-hint').textContent = o.hint || '';
      const wrap = $('#choice-cards'); wrap.innerHTML = '';
      const count = o.count, sel = [];
      (o.candidates || []).forEach((id) => {
        const c = byId[id];
        const el = document.createElement('div');
        el.className = 'choice-card'; el.dataset.id = id; el.dataset.zoom = c.img;
        el.innerHTML = `<img src="${c.img}" alt="${c.name}"><span>${c.name}</span>`;
        el.addEventListener('click', () => {
          const i = sel.indexOf(id);
          if (i >= 0) { sel.splice(i, 1); el.classList.remove('sel'); }
          else {
            if (count === 1) { sel.length = 0; wrap.querySelectorAll('.choice-card').forEach(x => x.classList.remove('sel')); }
            else if (sel.length >= count) return;
            sel.push(id); el.classList.add('sel');
          }
          confirm.disabled = sel.length !== count;
        });
        wrap.appendChild(el);
      });
      confirm.disabled = sel.length !== count;
      const close = (val) => { modal.classList.add('hidden'); confirm.removeEventListener('click', ok); cancel.removeEventListener('click', no); resolve(val); };
      const ok = () => { if (sel.length === count) close(sel.slice()); };
      const no = () => close(null);
      confirm.addEventListener('click', ok); cancel.addEventListener('click', no);
      modal.classList.remove('hidden');
    });
  }
  async function gatherCaptureOpts(card) {
    const p = me(); const opts = {};
    // 1) spend POKÉDEX as virtual master balls if needed to afford it (not for REPEL)
    if (card.effect !== 'discard_buy' && !E.canAfford(G, p, card)) {
      const dex = p.board.filter(id => E.isPokemart(byId[id]) && byId[id].effect === 'colorless_master');
      let need = -1;
      for (let k = 0; k <= dex.length; k++) if (E.computePayment(G, p, card, k * 2).ok) { need = k; break; }
      if (need > 0) {
        const sel = await pickCards({ title: '弃用图鉴抵款', hint: `弃 ${need} 张图鉴，各抵 2 个万能球以捕捉`, candidates: dex, count: need });
        if (!sel) return null;
        opts.spendPokedex = sel;
      }
    }
    // 2) copy association (EVOLVE STONE / RARE CANDY)
    if (card.effect === 'copy' || card.effect === 'copy_free') {
      const cands = p.board.filter(id => E.effBonusColor(G, p, id));
      const sel = await pickCards({ title: '关联（进化石/神奇糖果）', hint: '选择一张卡，本卡永久视同其奖励颜色', candidates: cands, count: 1 });
      if (!sel) return null;
      opts.copyTargetId = sel[0];
    }
    // 3) REPEL: discard N owned cards of its colour
    if (card.effect === 'discard_buy') {
      const col = card.effectParam.discardColor, n = card.effectParam.discardCount;
      const cands = p.board.filter(id => E.effBonusColor(G, p, id) === col);
      const sel = await pickCards({ title: '驱虫喷雾', hint: `弃掉 ${n} 张${BALL_NAMES[col]}卡以获得本卡（不付精灵球）`, candidates: cands, count: n });
      if (!sel) return null;
      opts.discardCards = sel;
    }
    // 4) take a free card (TM / RARE CANDY), possibly recursive
    if (card.effect === 'free' || card.effect === 'copy_free') {
      const fo = await gatherFreeTake(card);
      if (fo === null) return null;
      Object.assign(opts, fo);
    }
    return opts;
  }
  async function gatherFreeTake(parentCard) {
    const p = me();
    const cands = [];
    for (const t of E.freeTiers(parentCard)) for (const id of (G.field[t] || [])) if (id && E.freeTakeable(G, p, byId[id])) cands.push(id);
    if (!cands.length) return { freeTakeId: undefined }; // nothing eligible — effect fizzles
    const sel = await pickCards({ title: '免费获得一张卡', hint: '立即免费获得（不付其成本），结算其效果', candidates: cands, count: 1 });
    if (!sel) return null;
    const freeId = sel[0], fc = byId[freeId], freeOpts = {};
    if (E.isPokemart(fc) && (fc.effect === 'copy' || fc.effect === 'copy_free')) {
      const cc = p.board.filter(id => E.effBonusColor(G, p, id));
      const cp = await pickCards({ title: `关联「${fc.name}」`, hint: '为免费获得的卡选择复制奖励的卡', candidates: cc, count: 1 });
      if (!cp) return null;
      freeOpts.copyTargetId = cp[0];
    }
    if (E.isPokemart(fc) && (fc.effect === 'free' || fc.effect === 'copy_free')) {
      const sub = await gatherFreeTake(fc);
      if (sub === null) return null;
      Object.assign(freeOpts, sub);
    }
    return { freeTakeId: freeId, freeOpts };
  }
  function doReserveCard() {
    const cid = UI.selCard, pid = G.turn;
    if (isOnline()) { Net.action({ type: 'reserve', target: { fromField: cid } }); UI.selCard = null; render(); return; }
    applyAnimated({ type: 'reserve', cardId: cid }, pid, () => { const r = E.actionReserve(G, { fromField: cid }); if (r.ok) UI.selCard = null; return r; }, afterMainAction);
  }
  function doReserveDeck() {
    const tier = UI.selDeck, pid = G.turn;
    if (isOnline()) { Net.action({ type: 'reserve', target: { fromDeck: tier } }); UI.selDeck = null; render(); return; }
    applyAnimated({ type: 'reserve', deck: tier }, pid, () => { const r = E.actionReserve(G, { fromDeck: tier }); if (r.ok) UI.selDeck = null; return r; }, afterMainAction);
  }
  function decodePlan(plan) {
    const a = plan && plan.action; if (!a) return { type: 'pass' };
    if (a.type === 'take') return { type: 'take', colors: a.colors };
    if (a.type === 'capture') return { type: 'capture', cardId: a.cardId };
    if (a.type === 'reserve') return { type: 'reserve', cardId: (a.target && a.target.fromField) || null, deck: (a.target && a.target.fromDeck) || null };
    return { type: 'pass' };
  }

  // ---------------------------------------------------------------- undo (悔棋, vs AI)
  let undoStack = [];
  // bumped whenever G is reassigned (new game / undo / leave game); pending timers
  // capture the epoch and bail if it changed, so a stale timer can't mutate a fresh game.
  let gameEpoch = 0;
  function pushUndo() { undoStack.push({ s: E.clone(G), log: G.log.slice() }); if (undoStack.length > 60) undoStack.shift(); }
  function doUndo() {
    if (UI.busy || undoStack.length < 2) return;
    undoStack.pop();                                   // drop current turn's snapshot
    const snap = undoStack[undoStack.length - 1];      // back to previous human-turn start
    G = E.clone(snap.s); G.log = snap.log.slice(); gameEpoch++;   // cancel any in-flight timers
    UI.phase = 'main'; UI.pick = []; UI.selCard = UI.selDeck = null; UI.busy = false;
    render(); updateUndoBtn();
  }
  function updateUndoBtn() {
    const btn = $('#undo-btn'); if (!btn) return;
    const show = UI.hasAI && UI.humans === 1 && G && G.phase === 'play' && UI.phase === 'main' && !me().isAI && !UI.busy && undoStack.length >= 2;
    btn.classList.toggle('hidden', !show);
  }
  function doDiscard(color) {
    if (UI.phase !== 'discard') return;
    if (isOnline()) { Net.action({ type: 'discard', color }); return; }
    E.actionDiscard(G, color);
    if (!E.needsDiscard(G, me())) toEvolveOrEnd();
    render();
  }
  function doEvolve(fromId, toId) {
    if (isOnline()) { Net.action({ type: 'evolve', fromId, toId }); return; }
    const r = E.actionEvolve(G, fromId, toId);
    if (!r.ok) { flashHint(r.error); return; }
    endTurn();
  }
  function doMegaEvolve(megaId, fromId) {
    if (isOnline()) { Net.action({ type: 'megaEvolve', megaId, fromId }); return; }
    const r = E.actionMegaEvolve(G, megaId, fromId);
    if (!r.ok) { flashHint(r.error); return; }
    endTurn();
  }
  function doTakeMega() {
    if (!interactable()) return;
    if (isOnline()) { Net.action({ type: 'takeMega' }); return; }
    const r = E.actionTakeMega(G);
    if (!r.ok) { flashHint(r.error); return; }
    afterMainAction();
  }

  function afterMainAction() {
    UI.selCard = UI.selDeck = null; UI.pick = [];
    if (E.needsDiscard(G, me())) { UI.phase = 'discard'; render(); return; }
    toEvolveOrEnd();
  }
  function toEvolveOrEnd() {
    const opts = E.evolutionOptions(G, me());
    const mopts = G.megasEnabled ? E.megaEvolveOptions(G, me()) : [];
    if ((opts.length || mopts.length) && !me().isAI) { UI.phase = 'evolve'; render(); return; }
    endTurn();
  }
  function endTurn() {
    if (isOnline()) { Net.action({ type: 'endTurn' }); return; }
    const r = E.endTurn(G);
    UI.phase = 'main'; UI.pick = []; UI.selCard = UI.selDeck = null;
    if (G.phase === 'gameover') { render(); showWin(); return; }
    render();
    beginTurn();
  }

  // ---------------------------------------------------------------- turn control
  function beginTurn() {
    if (G.phase === 'gameover') { updateUndoBtn(); return; }
    autosave();                               // snapshot the clean turn start (resume point)
    const p = me();
    if (p.isAI) { render(); updateUndoBtn(); const e = gameEpoch; setTimeout(() => { if (e === gameEpoch) aiPlay(); }, 120); return; }
    if (UI.hasAI && UI.humans === 1) pushUndo(); // snapshot each human turn start (undo target; 1-human-vs-AI only)
    // hotseat: hide previous player's hidden info before a human's turn
    if (UI.humans >= 2) { showPassOverlay(p); }
    else render();
    updateUndoBtn();
  }

  function showPassOverlay(p) {
    let ov = $('#pass-overlay');
    if (!ov) { ov = document.createElement('div'); ov.id = 'pass-overlay'; document.body.appendChild(ov); }
    ov.innerHTML = `<div class="po-inner"><div class="pavatar" style="margin:0 auto 14px;width:56px;height:56px;background-color:${SEAT_COLORS[G.turn]};background-image:url(${seatAvatar(G.turn)});box-shadow:0 0 0 3px ${SEAT_COLORS[G.turn]}"></div>
      <h2>请将设备交给<br>${p.name}</h2><p>（其他玩家的保留区将被隐藏）</p>
      <button class="primary" id="ready-btn" style="margin-top:16px;padding:12px 30px">我准备好了</button></div>`;
    ov.classList.remove('hidden');
    $('#ready-btn').onclick = () => { ov.classList.add('hidden'); render(); };
    renderBanner();
  }

  let policyLoaded = false;
  function loadPolicy() {
    if (policyLoaded || !window.AZAI) return;
    fetch('assets/policy.json').then(r => (r.ok ? r.json() : null)).then(j => {
      if (j && j.weights) { AZAI.setWeights(j); policyLoaded = true; }
    }).catch(() => {});
  }

  function aiPlay() {
    if (G.phase === 'gameover') return;
    const p = me(), pid = G.turn, epoch = gameEpoch;
    UI.busy = true; updateUndoBtn();
    // 究极 runs a real determinized MCTS (validated ~58% vs 高手 in 2p). It only helps HEAD-TO-HEAD:
    // measured worse than 高手 at 3-4p (multiplayer search is misled by opponent/kingmaking noise),
    // so above 2 players 究极 falls back to the heuristic. The search itself IS the "thinking" time,
    // so use a short artificial pacing for it instead of the full 1.7–3.2s.
    const isUltra = p.diff === 'ultra' && window.VSearch && G.numPlayers === 2;
    const think = isUltra ? (250 + Math.random() * 250) : (1700 + Math.random() * 1500);
    setTimeout(() => {
      if (epoch !== gameEpoch) return;                // game was replaced/undone mid-think — drop this timer
      if (!G || G.phase === 'gameover') { UI.busy = false; return; }
      let dec = null, applyFn = null;
      // AlphaZero seat: net-guided MCTS; fall back to heuristic if the net move fails
      if (p.diff === 'alphazero' && window.AZAI && AZAI.hasWeights()) {
        let a = null; try { a = AZAI.mctsMove(G, 100); } catch (e) { a = null; }
        if (a != null) {
          dec = AZAI.decodeAction ? AZAI.decodeAction(G, a) : { type: 'pass' };
          applyFn = () => { try { AZAI.stepAuto(G, a); } catch (e) { } };
        }
      }
      if (!applyFn) {                                  // heuristic / 究极-search (default seat, or AZ fallback)
        const fallbackDiff = (p.diff === 'alphazero' || p.diff === 'ultra') ? 'hard' : (p.diff || 'hard');
        const plan = isUltra
          ? VSearch.chooseTurn(G, ULTRA_CFG)            // determinized MCTS, heuristic prior+leaf (2p only)
          : AI.chooseTurn(G, { difficulty: fallbackDiff });
        const takeMega = G.megasEnabled && aiShouldTakeMega(G, pid);
        dec = takeMega ? { type: 'pass' } : decodePlan(plan);
        applyFn = () => {
          if (takeMega) E.actionTakeMega(G);
          else if (plan.action) E.applyAction(G, plan.action); else E.actionPass(G);
          for (const c of plan.discards) E.actionDiscard(G, c);
          // Megas: a mega-evolution (if possible) takes priority over a normal one.
          if (G.megasEnabled && !G.evolvedThisTurn) aiTryMegaEvolve(G, pid);
          if (!G.evolvedThisTurn && plan.evolution) E.actionEvolve(G, plan.evolution.fromId, plan.evolution.toId);
          E.endTurn(G);
        };
      }
      const src = captureSrc(dec);     // capture pre-move source positions
      applyFn();                       // mutate G (incl. endTurn)
      UI.busy = false; UI.phase = 'main';
      render(); playGhosts(src, dec, pid);
      if (G.phase === 'gameover') { setTimeout(showWin, ANIM_MS); return; }
      setTimeout(() => { if (epoch === gameEpoch) beginTurn(); }, ANIM_MS);
    }, think);
  }

  // ---- simple AI behaviour for the Megas expansion (heuristic seat) ----
  function aiShouldTakeMega(G, pid) {
    const p = G.players[pid];
    if (p.megaToken >= 1 || G.supply.megaToken < 1) return false;
    // pursue a mega if we own a base species whose available mega we can already afford
    for (const id of G.megaOffer) {
      const m = byId[id];
      if (p.board.some(b => byId[b].name === m.megaFrom) && E.canAfford(G, p, m)) return true;
    }
    return false;
  }
  function aiTryMegaEvolve(G, pid) {
    const p = G.players[pid];
    const opts = E.megaEvolveOptions(G, p);
    if (!opts.length) return;
    let best = null, bestGain = -1e9;
    for (const o of opts) {
      const gain = (byId[o.megaId].vp - byId[o.fromId].vp) + (byId[o.megaId].bonusCount - 1); // VP + extra bonuses
      if (gain > bestGain) { bestGain = gain; best = o; }
    }
    if (best) E.actionMegaEvolve(G, best.megaId, best.fromId);
  }

  // ---------------------------------------------------------------- win
  function showWin() {
    const scores = G.players.map((p, i) => ({ i, s: E.scoreOf(G, p), bur: p.buried.length, brd: p.board.length, name: p.name }));
    const w = G.winner;
    let rows = scores.slice().sort((a, b) => b.s - a.s || b.bur - a.bur || b.brd - a.brd)
      .map(r => `<div class="wrow${r.i === w ? ' winner' : ''}"><span>${r.i === w ? '👑 ' : ''}${r.name}</span><span>${r.s} 分 · ${r.brd} 只 · 进化 ${r.bur}</span></div>`).join('');
    $('#win-content').innerHTML = `<div class="win-trophy">🏆</div><h2>${G.players[w].name} 获胜！</h2><div class="win-scores">${rows}</div>`;
    $('#win-modal').classList.remove('hidden');
  }

  function flashHint(msg) {
    const bar = $('#action-bar');
    const old = bar.innerHTML;
    bar.insertAdjacentHTML('afterbegin', `<div class="act-hint" style="color:var(--bad)">${msg}</div>`);
    setTimeout(() => { if (bar.firstChild) bar.firstChild.remove(); }, 1600);
  }

  // ---------------------------------------------------------------- zoom preview
  function setupZoom() {
    const z = $('#zoom'), img = $('#zoom-img');
    document.addEventListener('mousemove', (e) => {
      const t = e.target.closest('[data-zoom]');
      if (!t) { z.classList.add('hidden'); return; }
      img.src = t.dataset.zoom;
      z.classList.remove('hidden');
      const pad = 16, w = 260, h = 347;
      let x = e.clientX + pad, y = e.clientY + pad;
      if (x + w > innerWidth) x = e.clientX - w - pad;
      if (y + h > innerHeight) y = innerHeight - h - 6;
      z.style.left = x + 'px'; z.style.top = Math.max(6, y) + 'px';
    });
  }

  // ------------------------------------------------------- tap-to-inspect (touch)
  // On touch there is no hover; tapping a card opens a large, readable overlay.
  function openInspect(src, actionsHtml) {
    const ov = $('#inspect'); if (!ov || !src) return;
    $('#inspect-img').src = src;
    $('#inspect-actions').innerHTML = (actionsHtml || '') + `<button class="ghost" data-inspect-close>关闭</button>`;
    ov.classList.remove('hidden');
  }
  function closeInspect() { const ov = $('#inspect'); if (ov) ov.classList.add('hidden'); }
  // build capture/reserve buttons for the inspect overlay, if the card is actionable now
  function inspectActionsFor(id) {
    if (!interactable()) return '';
    const p = me(), c = byId[id]; if (!c) return '';
    const loc = E.locateCard(G, id);
    const canReserve = loc && loc.where === 'field' && E.NORMAL_TIERS.includes(loc.tier) && p.reserve.length < E.HAND_MAX;
    let h = '';
    if (E.canAfford(G, p, c)) h += `<button class="primary" data-inspect-act="capture">捕捉</button>`;
    if (canReserve) h += `<button class="ghost" data-inspect-act="reserve-card">保留</button>`;
    return h;
  }

  // keep --dock-h in sync with the fixed mobile control dock so scroll content clears it
  function syncDockH() {
    const dock = $('#controls'); if (!dock) return;
    const onMobile = matchMedia('(max-width:860px)').matches;
    document.documentElement.style.setProperty('--dock-h', onMobile ? dock.offsetHeight + 'px' : '0px');
  }
  function trackDock() {
    const dock = $('#controls'); if (!dock) return;
    if (window.ResizeObserver) new ResizeObserver(syncDockH).observe(dock);
    const mq = matchMedia('(max-width:860px)');
    (mq.addEventListener ? mq.addEventListener('change', syncDockH) : mq.addListener && mq.addListener(syncDockH));
    window.addEventListener('resize', syncDockH, { passive: true });
    window.addEventListener('orientationchange', syncDockH);
    syncDockH();
  }

  // gentle, dismissible "rotate to landscape" hint for phones in portrait (never forced)
  let rotateDismissed = false;
  function evalRotateHint() {
    const hint = $('#rotate-hint'); if (!hint) return;
    const gameOn = !$('#game').classList.contains('hidden');
    const narrowPortrait = matchMedia('(max-width:640px) and (orientation:portrait)').matches;
    hint.classList.toggle('hidden', !(gameOn && narrowPortrait && !rotateDismissed));
  }
  function setupRotateHint() {
    try { rotateDismissed = sessionStorage.getItem('ps-rotate-dismissed') === '1'; } catch (e) { }
    const dz = $('#rotate-dismiss');
    if (dz) dz.addEventListener('click', () => { rotateDismissed = true; try { sessionStorage.setItem('ps-rotate-dismissed', '1'); } catch (e) { } evalRotateHint(); });
    window.addEventListener('resize', evalRotateHint, { passive: true });
    window.addEventListener('orientationchange', evalRotateHint);
    evalRotateHint();
  }

  // ---------------------------------------------------------------- events
  function bind() {
    // setup
    $('#player-count').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      $$('#player-count button').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); buildSeats(+b.dataset.n);
    });
    $('#start-btn').addEventListener('click', startGame);
    // online lobby
    if ($('#online-create')) $('#online-create').addEventListener('click', () => openOnline(makeRoomCode(), true));
    if ($('#online-join')) $('#online-join').addEventListener('click', () => { const c = prompt('输入房间码：'); if (c) openOnline(c, false); });
    if ($('#lobby-start')) $('#lobby-start').addEventListener('click', () => { if (window.Net) Net.start({ megas: !!($('#lobby-megas') && $('#lobby-megas').checked), pokemart: !!($('#lobby-pokemart') && $('#lobby-pokemart').checked) }); });
    if ($('#lobby-leave')) $('#lobby-leave').addEventListener('click', leaveOnline);
    if ($('#lobby-copy')) $('#lobby-copy').addEventListener('click', () => { try { navigator.clipboard.writeText(location.href); flashHint('邀请链接已复制'); } catch (e) { flashHint(location.href); } });
    if ($('#tutorial-btn')) $('#tutorial-btn').addEventListener('click', () => { if (window.Tutorial) Tutorial.start('base'); });
    if ($('#tutorial-mega-btn')) $('#tutorial-mega-btn').addEventListener('click', () => { if (window.Tutorial) Tutorial.start('megas'); });
    $('#undo-btn').addEventListener('click', doUndo);
    $('#rules-btn').addEventListener('click', () => $('#rules-modal').classList.remove('hidden'));
    $('#rules-modal').addEventListener('click', (e) => { if (e.target.id === 'rules-modal' || e.target.classList.contains('close-rules')) $('#rules-modal').classList.add('hidden'); });
    $('#menu-btn').addEventListener('click', () => {
      const inTut = window.Tutorial && Tutorial.active && Tutorial.active();
      if (confirm(inTut ? '退出教程，返回主菜单？' : '返回主菜单？当前对局将丢失。')) {
        if (!inTut) clearSave();              // explicit quit of a real game = abandon its autosave
        if (window.Tutorial && Tutorial.stop) Tutorial.stop();
        backToSetup();
      }
    });
    $('#play-again').addEventListener('click', () => { if (window.Tutorial && Tutorial.stop) Tutorial.stop(); backToSetup(); });

    // delegated game clicks
    $('#supply').addEventListener('click', (e) => {
      if (e.target.closest('[data-take-mega]')) { doTakeMega(); return; }
      const r = e.target.closest('[data-color]'); if (r) onSupplyClick(r.dataset.color);
    });
    $('#field').addEventListener('click', (e) => {
      const rb = e.target.closest('[data-reserve-card]'); if (rb) { onCardClick(rb.dataset.reserveCard); doReserveCard(); return; }
      const dk = e.target.closest('[data-deck]'); if (dk) { onDeckClick(dk.dataset.deck); return; }
      const cd = e.target.closest('[data-card]');
      if (cd) {
        const id = cd.dataset.card;
        const isMega = byId[id] && byId[id].tier === 'mega';
        // Mega cards (zoom-only) and any tap when it's not your turn → just enlarge for reading.
        if (isMega || !interactable() || UI.pick.length) { openInspect(cd.dataset.zoom || (byId[id] && byId[id].img)); return; }
        onCardClick(id);
      }
    });
    // tap the enlarged card thumbnail in the dock to open the full-screen reader (+ act)
    $('#inspect').addEventListener('click', (e) => {
      const ia = e.target.closest('[data-inspect-act]');
      if (ia) { const a = ia.dataset.inspectAct; closeInspect(); if (a === 'capture') doCapture(); else if (a === 'reserve-card') doReserveCard(); return; }
      if (e.target.id === 'inspect' || e.target.closest('[data-inspect-close]')) closeInspect();
    });
    $('#log-toggle') && $('#log-toggle').addEventListener('click', (e) => {
      const collapsed = $('#log').classList.toggle('collapsed');
      e.target.textContent = collapsed ? '展开' : '收起';
      e.target.setAttribute('aria-expanded', String(!collapsed));
    });
    $('#action-bar').addEventListener('click', (e) => {
      if (e.target.closest('.sel-preview')) { if (UI.selCard) openInspect(byId[UI.selCard].img, inspectActionsFor(UI.selCard)); return; }
      const b = e.target.closest('[data-act],[data-discard],[data-evo-from],[data-mega]'); if (!b) return;
      if (b.dataset.act === 'confirm-take') doTake();
      else if (b.dataset.act === 'clear-take') { UI.pick = []; render(); }
      else if (b.dataset.act === 'clear-sel') { UI.selCard = UI.selDeck = null; render(); }
      else if (b.dataset.act === 'capture') doCapture();
      else if (b.dataset.act === 'reserve-card') doReserveCard();
      else if (b.dataset.act === 'reserve-deck') doReserveDeck();
      else if (b.dataset.act === 'end-turn') endTurn();
      else if (b.dataset.discard) doDiscard(b.dataset.discard);
      else if (b.dataset.mega) doMegaEvolve(b.dataset.mega, b.dataset.megaFrom);
      else if (b.dataset.evoFrom) doEvolve(b.dataset.evoFrom, b.dataset.evoTo);
    });
    // own-reserve capture: clicking a revealed reserve mini-card selects it
    $('#players').addEventListener('click', (e) => {
      const mc = e.target.closest('[data-reserve-capture]');
      if (mc && interactable()) { UI.selCard = mc.dataset.reserveCapture; UI.selDeck = null; UI.pick = []; render(); return; }
      // any other captured/opponent card: tap to enlarge & read
      const z = e.target.closest('[data-zoom]');
      if (z && z.dataset.zoom) openInspect(z.dataset.zoom);
    });
  }

  buildSeats(2);
  bind();
  setupZoom();
  trackDock();
  setupRotateHint();
  offerResume();   // if a previous game was left unfinished, offer to continue it
  // deep-link: ?room=CODE → jump straight into that online lobby
  try { const rc = new URLSearchParams(location.search).get('room'); if (rc && window.Net) openOnline(rc, false); } catch (e) { }

  // lightweight debug hook (harmless in production): inspect/drive from console
  window.PSDebug = {
    get G() { return G; }, get UI() { return UI; }, E, AI, byId, render,
    afterMainAction, beginTurn, endTurn, showWin,
  };

  // public surface used by the tutorial (js/tutorial.js)
  window.PSGame = {
    E, AI, byId, MEGA_DB,
    get DB() { return DB; },
    get G() { return G; },
    get UI() { return UI; },
    render, enterGame, backToSetup, endTurn,
    setPhase(ph) { UI.phase = ph; },
  };
})();
