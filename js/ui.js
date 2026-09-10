/* ===================== Pokémon Splendor — UI ===================== */
(function () {
  'use strict';
  const E = window.Engine, AI = window.AI, DB = window.CARD_DB;
  const MEGA_DB = window.MEGA_DB || [];
  const POKEMART_DB = window.POKEMART_DB || [];

  // WebP fallback. All card art is WebP (#31), but Safari on macOS <= 10.15 / iOS <= 13 cannot
  // decode it — every card and deck back showed as a broken "?" there. Probe by decoding a 1x1
  // WebP (a canvas-encode probe would misclassify Firefox); on failure switch each card image to
  // its JPEG twin and set <html class="no-webp"> so CSS paints the .jpg deck backs. The probe is
  // async but resolves in a few ms, long before the first card renders; if a game is already on
  // screen it re-renders. `?nowebp=1` forces the fallback so the path can be checked anywhere.
  // NB: `G`/`render` are declared further down; only the async probe path (which runs after
  // this module has initialised) may touch them — the synchronous `?nowebp=1` path must not.
  function useJpegFallback(rerender) {
    document.documentElement.classList.add('no-webp');
    for (const c of [].concat(DB, MEGA_DB, POKEMART_DB)) if (c && typeof c.img === 'string') c.img = c.img.replace(/\.webp$/, '.jpg');
    if (rerender && G) render();
  }
  if (/[?&]nowebp=1/.test(location.search)) useJpegFallback(false);
  else {
    const probe = new Image();
    probe.onload = () => { if (!(probe.width > 0 && probe.height > 0)) useJpegFallback(true); };
    probe.onerror = () => useJpegFallback(true);
    probe.src = 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=';
  }
  // 究极 difficulty: single-tree determinized MCTS (vsearch v2), TIME-based budget.
  // The web worker + the AI "thinking" pause hide the latency completely, so we
  // spend real time: ~900ms ≈ 2500-3000 sims on desktop (auto-scales down on
  // slower phones — same latency, fewer sims, still ≥ the old 200-sim budget).
  // Validated: v2 at equal wall-clock beats the old 200/3 config 61.7% (37/60,
  // p<.05); budget scaling adds more (2000-vs-600 sims: 58%). 3-4p still falls
  // back to the heuristic: even with oppK pruning the search measured 29.4% at
  // 3p / 15.6% at 4p (fair 33.3%/25%) — the multiplayer lever is an eval refit,
  // not more search (see test/vsearch_mp.js).
  const ULTRA_CFG = { timeMs: 900 };

  // --- AI web worker: heavy searches run OFF the main thread (no UI freeze). ---
  // ui posts a static-stripped state; the worker (js/ai.worker.js) loads the same
  // engine/AI files, reattaches the card DBs, and returns the plan. Any failure
  // (no Worker support, load error, crash) falls back to the old synchronous path.
  let aiWorker = null, aiJobSeq = 0;
  const aiJobs = {};
  function getAIWorker() {
    if (aiWorker !== null) return aiWorker;               // Worker | false (known-unavailable)
    try {
      aiWorker = new Worker('js/ai.worker.js');
      aiWorker.onmessage = (e) => {
        const m = e.data || {}, j = aiJobs[m.id];
        if (!j) return;
        delete aiJobs[m.id];
        if (m.error || !m.plan) j.fail(); else j.ok(m.plan);
      };
      aiWorker.onerror = () => {                          // worker died → fail all pending, disable
        for (const id in aiJobs) { aiJobs[id].fail(); delete aiJobs[id]; }
        try { aiWorker.terminate(); } catch (e) { }
        aiWorker = false;
      };
    } catch (e) { aiWorker = false; }
    return aiWorker;
  }
  // Promise<plan> for a turn: kind = 'ultra' (VSearch+opts) or a heuristic difficulty.
  // `state` defaults to the live G (also used with determinized states for takeover).
  function aiComputeAsync(kind, opts, state) {
    const s = state || G;
    const sync = () => (kind === 'ultra' && window.VSearch)
      ? VSearch.chooseTurn(s, opts || ULTRA_CFG)
      : AI.chooseTurn(s, { difficulty: kind || 'hard' });
    const w = getAIWorker();
    if (!w) return Promise.resolve(sync());
    const { cardDB, byId: _b, megaDB, pokemartDB, _byName, log, ...dyn } = s;  // strip statics/caches
    const id = ++aiJobSeq;
    return new Promise((resolve) => {
      aiJobs[id] = { ok: resolve, fail: () => resolve(sync()) };
      try { w.postMessage({ id, kind, g: dyn, opts }); }
      catch (e) { delete aiJobs[id]; resolve(sync()); }
    });
  }
  const $ = (s, r) => (r || document).querySelector(s);
  // Player names and logs are untrusted, including old local saves. Encode at
  // every HTML sink; server-side length limits alone do not prevent markup.
  const escapeHTML = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const BALL_NAMES = { red: '精灵球', blue: '超级球', black: '高级球', pink: '治愈球', yellow: '先机球', purple: '大师球' };
  const TIER_NAMES = { legend: '传说', rare: '稀有', stage3: '三阶', stage2: '二阶', stage1: '一阶', mega: 'Mega', pmL1: '商店Ⅰ', pmL2: '商店Ⅱ', pmL3: '商店Ⅲ' };
  const EFFECT_NAMES = { copy: '技能机·复制折扣', colorless_master: '图鉴·可抵2万能', double: '药水·双折扣', copy_free: '神奇糖果·复制+免费取一级', free: '进化石·免费取二级', discard_buy: '驱虫·弃2张同色购买' };
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
        `<div class="pid" style="background-color:${SEAT_COLORS[i]};background-image:url(${seatAvatar(i)})" aria-hidden="true"></div>
         <input type="text" value="训练家 ${i + 1}" maxlength="10" data-name="${i}" aria-label="${i + 1}号位训练家名称">
         <select data-kind="${i}" aria-label="${i + 1}号位控制方式">
           <option value="human">真人</option>
           <option value="ai">电脑</option>
         </select>
          <select data-diff="${i}" aria-label="${i + 1}号位电脑难度">
            <option value="normal">普通（推荐）</option>
            <option value="easy">新手</option>
            <option value="hard">高手</option>
            <option value="ultra">究极（最强·搜索）</option>
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
    $('#setup').inert = false;
    if ($('#rules-modal')) $('#rules-modal').classList.add('hidden');
    $('#game').inert = false; $('#game').classList.remove('hidden');
    $('#win-modal').classList.add('hidden');
    render();
    beginTurn();
  }
  function backToSetup() {
    gameEpoch++; UI.busy = false;
    document.body.classList.remove('has-card-selection', 'tutorial-choice-open');
    $('#game').inert = false; $('#game').classList.add('hidden');
    $('#win-modal').classList.add('hidden');
    const pass = $('#pass-overlay'); if (pass) pass.classList.add('hidden');
    $('#setup').inert = false; $('#setup').classList.remove('hidden');
    syncSetupGoal(); syncTutorialProgress();
  }

  // ============================ online multiplayer ============================
  function makeRoomCode() {
    const ch = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s = '';
    for (let i = 0; i < 5; i++) s += ch[Math.floor(Math.random() * ch.length)];
    return s;
  }
  // 联机昵称：单独记在本地，不再复用单机设置页的「训练家 1」——
  // 以前两个人的名字会一模一样，计分板和日志根本分不清谁是谁。
  const NICK_KEY = 'pkmn_net_nick';
  function savedNick() {
    try { return (localStorage.getItem(NICK_KEY) || '').trim(); } catch (e) { return ''; }
  }
  function saveNick(n) { try { localStorage.setItem(NICK_KEY, n); } catch (e) { } }
  function defaultNick() { return savedNick() || ('训练家' + Math.floor(1000 + Math.random() * 9000)); }

  function openOnline(code, asHost) {
    // 用 Net.parseRoomCode：朋友常常直接把「邀请链接」整条粘过来，
    // 按字符硬清洗会得到乱码房间码并进入一个空房间。
    code = (window.Net && Net.parseRoomCode) ? Net.parseRoomCode(code)
         : String(code || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
    if (!code || !window.Net) return;
    if (window.Tutorial && Tutorial.stop) Tutorial.stop();
    const name = defaultNick();
    saveNick(name);
    const nickInput = $('#lobby-nick'); if (nickInput) nickInput.value = name;
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
    Net.on('status', (s) => {
      if (!UI.net) return;
      UI.net.status = s;
      if (s === 'connected') UI.net.everConnected = true;
      renderLobby();
      renderNetBar();          // 关键：对局中断线也要有提示，不能只更新大厅
      if (G && G.phase === 'play') render();   // 断线时按钮立刻变成不可点
    });
    Net.on('welcome', (m) => { if (UI.net) { UI.net.seat = m.seat; UI.net.host = m.host; renderLobby(); } });
    Net.on('roster', (m) => {
      if (!UI.net) return;
      UI.net.roster = m.players || []; UI.net.started = m.started;
      renderLobby();
      if (G && G.phase !== 'gameover' && UI.net.started) renderPlayers();  // 对局中同步在线状态点
    });
    Net.on('state', onNetState);
    Net.on('reject', (m) => { if (UI.net) { UI.net.takeoverBusy = false; UI.net.pendingAction = false; } flashHint((m && m.reason) || '操作被拒绝'); if (G) render(); });
    Net.on('over', () => { });
    // 房主点了「再来一局」：所有人回到大厅，座位和房间码都不变
    Net.on('lobby', () => {
      if (!UI.net) return;
      stopIdleTimer();
      UI.net.started = false;
      G = null; gameEpoch++;
      UI.phase = 'main'; UI.pick = []; UI.selCard = UI.selDeck = null; UI.busy = false;
      $('#win-modal').classList.add('hidden');
      $('#game').classList.add('hidden');
      $('#lobby').classList.remove('hidden');
      // 观战者（座位 -1）借这次回大厅的机会重新入座；已入座的人按 token 认回原座，无副作用。
      if (window.Net && Net.rejoin) Net.rejoin();
      renderLobby();
      flashHint('房主已重开一局，等待开始');
    });
  }
  function renderLobby() {
    if (!UI.net) return;
    const statusZh = { connecting: '连接中…', connected: '已连接', disconnected: '已断开，重连中…' };
    const seatTxt = UI.net.seat == null ? '' : (UI.net.seat < 0 ? '（观战）' : `（你是 ${UI.net.seat + 1} 号位${UI.net.host ? ' · 房主' : ''}）`);
    const st = $('#lobby-status'); if (st) st.textContent = '状态：' + (statusZh[UI.net.status] || UI.net.status) + ' ' + seatTxt;
    const r = UI.net.roster || [];
    const rr = $('#lobby-roster');
    if (rr) rr.innerHTML = r.length
      ? r.map(p => `<div class="lr-row"><span class="lr-dot ${p.connected ? 'on' : 'off'}" aria-hidden="true"></span>${p.seat + 1}. ${escapeHTML(p.name)}${p.seat === 0 ? ' 👑' : ''}${p.seat === UI.net.seat ? '（你）' : ''}<span class="sr-only">，${p.connected ? '在线' : '已断线'}</span></div>`).join('')
      : '<div class="muted">等待玩家加入…</div>';
    const start = $('#lobby-start');
    if (start) { start.style.display = UI.net.host ? '' : 'none'; start.disabled = !(r.length >= 2); }
    const mb = $('#lobby-megas'), pb = $('#lobby-pokemart');
    if (mb) mb.disabled = !UI.net.host;
    if (pb) pb.disabled = !UI.net.host;
  }
  // 对局中的连接状态条。以前断线只更新大厅，而大厅在对局中是隐藏的，
  // 于是掉线的人什么提示都没有、点什么都没反应（操作被静默丢弃）。
  function renderNetBar() {
    const bar = $('#net-bar'); if (!bar) return;
    if (!isOnline() || !UI.net.started) { bar.innerHTML = ''; return; }
    const s = UI.net.status;
    if (s === 'connected') {
      // 观战者（座位 -1，通常是开局后才进来的人）要知道自己为什么不能操作
      bar.innerHTML = (UI.net.seat != null && UI.net.seat < 0)
        ? '<span class="net-spectate">👀 观战中 —— 本局已开始，你可以旁观；房主开下一局时会自动为你安排座位（房间未满时）</span>'
        : '';
      return;
    }
    const msg = (s === 'connecting' && !UI.net.everConnected)
      ? '正在连接房间…'
      : '⚠ 与房间的连接已断开，正在自动重连…（你的座位和进度都保留，重连后继续）';
    bar.innerHTML = '<span class="net-off">' + msg + '</span>';
  }

  function leaveOnline() {
    stopIdleTimer();
    stopTitleFlash();
    if (window.Net) Net.close();
    UI.net = null; gameEpoch++; document.body.classList.remove('has-card-selection');
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
    UI.net.pendingAction = false;
    $('#setup').classList.add('hidden'); $('#lobby').classList.add('hidden');
    $('#game').classList.remove('hidden');
    recomputeOnlinePhase();
    render();
    startIdleTimer();
    if (G.phase === 'play' && myTurn()) notifyMyTurn(); else if (!myTurn()) notified = false;
    if (G.phase === 'gameover') showWin();
  }

  // ----- 回合提醒 -----
  // 联机时玩家常常切去聊天，回合轮到自己却不知道，一等就是几分钟（甚至被AI代打）。
  // 标签页在后台时：标题闪烁提醒；切回来自动恢复。只在「轮到我」的那一刻触发一次。
  const BASE_TITLE = document.title;
  let titleTimer = null, notified = false;
  function stopTitleFlash() {
    if (titleTimer) { clearInterval(titleTimer); titleTimer = null; }
    document.title = BASE_TITLE;
  }
  function startTitleFlash() {
    if (titleTimer) return;
    let on = false;
    titleTimer = setInterval(() => {
      on = !on;
      document.title = on ? '▶ 轮到你了！' : BASE_TITLE;
    }, 1000);
  }
  function beep() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      const ac = new AC(); const o = ac.createOscillator(), g = ac.createGain();
      o.connect(g); g.connect(ac.destination);
      o.frequency.value = 880; g.gain.value = 0.05;
      o.start(); o.stop(ac.currentTime + 0.12);
      setTimeout(() => { try { ac.close(); } catch (e) { } }, 400);
    } catch (e) { }
  }
  function notifyMyTurn() {
    if (document.visibilityState !== 'hidden') return;   // 人就在看，不用打扰
    if (notified) return;
    notified = true;
    startTitleFlash(); beep();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { notified = false; stopTitleFlash(); }
  });

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
    if (UI.net.takeoverBusy) ib.innerHTML = '<span class="idle-ai">🤖 AI 代打中…</span>';
    else if (!myTurn()) ib.innerHTML = (offline || msLeft < 90000) ? `<span class="idle-wait">${offline ? '⚠ 对手已断线 · ' : ''}${secs} 秒后由 AI 接管</span>` : '';
    else if (!UI.net.host) ib.innerHTML = (msLeft < 60000) ? `<span class="idle-warn">⏱️ 你还有 ${secs} 秒，否则由 AI 代打</span>` : ''; // only non-host gets taken over
    else ib.innerHTML = '';   // host's own turn: the host is never auto-taken-over
    // the HOST drives takeover for an idle OTHER seat (never its own turn) once the
    // timeout truly elapses (the server re-validates the timing).
    // 任何在座玩家都可触发（不只房主）：否则房主自己掉线时全场卡死。
    // 多人同时触发也无妨 —— 服务端处理完第一个就会重置计时，其余会被「尚未超时」拒绝。
    if (msLeft <= 0 && !UI.net.takeoverBusy && onlineSeat() >= 0 && !myTurn()) {
      UI.net.takeoverBusy = true;
      setTimeout(() => { if (UI.net && UI.net.takeoverBusy) UI.net.takeoverBusy = false; }, 6000); // safety: never stick
      setTimeout(() => { computeTakeoverPlan().then((plan) => { try { if (window.Net) Net.send({ t: 'takeover', plan }); } catch (e) { } }); }, 30);
    }
  }
  // Reconstruct a plausible FULL state from our redacted view so the AI can run:
  // sample unseen deck cards and hidden reserve identities together by tier while
  // therefore plays from PUBLIC info only — it never sees a player's hidden hand.
  function determinizeForAI(s) {
    const d = E.clone(s);
    const seen = new Set();
    for (const t in d.field) for (const id of (d.field[t] || [])) if (id) seen.add(id);
    for (const id of (d.megaOffer || [])) seen.add(id);
    const hidden = {};
    d.players.forEach((p, seat) => {
      (p.board || []).forEach(id => seen.add(id));
      (p.buried || []).forEach(id => seen.add(id));
      (p.reserve || []).forEach((rid, slot) => {
        if (typeof rid === 'string') seen.add(rid);
        else if (rid && rid.tier) (hidden[rid.tier] = hidden[rid.tier] || []).push([seat, slot]);
      });
    });
    const pools = {};
    const canonicalSpecial = new Set([].concat(
      (E.CANON_SPECIAL && E.CANON_SPECIAL.rare) || [],
      (E.CANON_SPECIAL && E.CANON_SPECIAL.legend) || []
    ));
    [].concat(DB, MEGA_DB, POKEMART_DB).forEach(c => {
      if (!c || seen.has(c.id)) return;
      if ((c.tier === 'rare' || c.tier === 'legend') && canonicalSpecial.size && !canonicalSpecial.has(c.id)) return;
      (pools[c.tier] = pools[c.tier] || []).push(c.id);
    });
    let hash = 2166136261;
    const mix = (v) => { const z = String(v); for (let i = 0; i < z.length; i++) { hash ^= z.charCodeAt(i); hash = Math.imul(hash, 16777619); } };
    mix(d.round); mix(d.turn);
    for (const t in d.field) { mix(t); for (const id of (d.field[t] || [])) mix(id || '-'); }
    for (const t in d.decks) {
      const pool = (pools[t] || []).slice().sort();
      let tierHash = 2166136261;
      for (let i = 0; i < t.length; i++) tierHash = Math.imul(tierHash ^ t.charCodeAt(i), 16777619);
      E.shuffle(pool, E.makeRng((hash ^ tierHash) >>> 0));
      for (const slot of (hidden[t] || [])) d.players[slot[0]].reserve[slot[1]] = pool.pop();
      const n = (d.decks[t] || []).length;
      d.decks[t] = pool.slice(Math.max(0, pool.length - n));
    }
    return d;
  }
  // async: the heavy search runs in the AI worker (host UI stays responsive)
  function computeTakeoverPlan() {
    const EMPTY = { action: null, discards: [], evolution: null };
    try {
      const det = determinizeForAI(G);
      const kind = (window.VSearch && det.numPlayers === 2) ? 'ultra' : 'hard';
      return aiComputeAsync(kind, ULTRA_CFG, det)
        .then((p) => (p && p.action) ? p : aiComputeAsync('hard', undefined, det))
        .catch(() => EMPTY);
    } catch (e) { return Promise.resolve(EMPTY); }
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
    sendNetAction({ type: 'endTurn' });   // acted with nothing left to resolve → end the turn
  }
  function sendNetAction(action, label) {
    if (!UI.net || UI.net.pendingAction) return false;
    // 断线时 Net.action 会返回 false（消息根本没发出去）。此时若照常置起
    // pendingAction，就再也等不到 state/reject 来解锁，界面会永久卡住。
    if (!Net.action(action)) { flashHint('连接已断开，正在重连…操作未发出'); renderNetBar(); return false; }
    UI.net.pendingAction = true;
    if (label) flashHint(label, 'info');
    return true;
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
  function syncSetupGoal() {
    const goal = $('#setup-goal'), mega = $('#opt-megas');
    if (!goal || !mega) return;
    goal.textContent = mega.checked
      ? 'Mega 挑战：达到 20 分、集齐 5 色永久折扣，并拥有至少 1 只 Mega 宝可梦！'
      : '收集精灵球，捕捉并进化宝可梦，率先达到 18 分成为冠军训练家！';
  }
  function syncTutorialProgress() {
    const ids = { base: '#tutorial-btn', megas: '#tutorial-mega-btn', pokemart: '#tutorial-pokemart-btn' };
    for (const mode in ids) {
      let done = false; try { done = localStorage.getItem('ps-tutorial-complete-' + mode) === '1'; } catch (e) { }
      const btn = $(ids[mode]); if (btn) btn.classList.toggle('completed', done);
    }
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
    div.innerHTML = `<div class="rb-text">发现未完成的对局${seat ? `，轮到 <b>${escapeHTML(seat)}</b>` : ''}` +
      `${vp ? `<br><small>${escapeHTML(vp)}</small>` : ''}${when ? `<br><small class="rb-when">${when}</small>` : ''}</div>` +
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
    `<div class="ball ${color} ${cls || ''}" title="${BALL_NAMES[color]}" aria-hidden="true">${label != null ? '' : ''}</div>`;
  const acquireLabel = (card) => E.isPokemart(card) ? '购买道具' : '捕捉';
  function cardAriaLabel(card, aff) {
    const costs = E.ALL_TOKENS.filter(k => card.cost[k] > 0).map(k => `${card.cost[k]}${BALL_NAMES[k]}`).join('、');
    const effect = E.isPokemart(card) && card.effect ? `，${EFFECT_NAMES[card.effect] || '特殊效果'}` : '';
    const state = aff ? (aff.master ? `，可购买，需${aff.master}个大师球` : '，当前可获得') : '，当前不可购买';
    return `${card.name}，${TIER_NAMES[card.tier]}，${card.vp}分，${costs ? `成本${costs}` : '特殊代价'}${effect}${state}`;
  }

  // opts.aff: null | { master } from affordInfo(). master>0 => needs Master Balls
  // (purple tier + a 大师×N count badge — colour-blind-safe redundant cue).
  function cardHTML(id, opts) {
    opts = opts || {};
    const c = byId[id];
    if (!c) return `<div class="card"><div class="empty-slot">—</div></div>`;
    const aff = opts.aff;
    let cls = E.isPokemart(c) ? ' pm-card' : '', badge = '';
    if (aff) {
      cls += aff.master > 0 ? ' affordable affordable-wild' : ' affordable';
      if (aff.master > 0) badge = `<div class="wild-badge" title="买这张会花费 ${aff.master} 个大师球（万能球）">大师×${aff.master}</div>`;
    } else if (E.isPokemart(c)) cls += ' pm-locked';
    const sel = (UI.selCard === id) ? ' selected' : '';
    return `<div class="card${cls}${sel}" data-card="${id}" data-zoom="${c.img}" data-focus-key="card-${id}" role="button" tabindex="0" aria-pressed="${UI.selCard === id}" aria-label="${cardAriaLabel(c, aff)}">
              <img src="${c.img}" alt="" loading="lazy">${badge}
            </div>`;
  }

  // ---------------------------------------------------------------- render
  function render() {
    const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.focusKey : '';
    const rowScroll = {};
    $$('#field [data-row-key]').forEach(el => { rowScroll[el.dataset.rowKey] = el.scrollLeft; });
    renderBanner(); renderScoreStrip(); renderField(); renderMyResources(); renderSupply(); renderActionBar(); renderPlayers(); renderLog(); renderNetBar();
    document.body.classList.toggle('has-card-selection', !!UI.selCard && UI.phase === 'main');
    for (const key in rowScroll) { const el = $(`#field [data-row-key="${key}"]`); if (el) el.scrollLeft = rowScroll[key]; }
    if (focusKey) requestAnimationFrame(() => { const el = document.querySelector(`[data-focus-key="${focusKey}"]`); if (el) el.focus({ preventScroll: true }); });
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
      chips += `<div class="mychip" aria-label="${BALL_NAMES[c]}：手中 ${p.tokens[c]} 个，永久折扣 ${b[c]}">
        <div class="ball ${c} sm" aria-hidden="true"></div>
        <span class="mc-tok"><small>球</small>${p.tokens[c]}</span><span class="mc-bon"><small>折</small>${b[c]}</span>
      </div>`;
    }
    chips += `<div class="mychip master" aria-label="大师球：手中 ${p.tokens.purple} 个"><div class="ball purple sm" aria-hidden="true"></div><span class="mc-tok"><small>球</small>${p.tokens.purple}</span></div>`;
    if (G.megasEnabled) chips += `<div class="mychip mega" aria-label="Mega 代币：持有 ${p.megaToken} 个"><div class="ball mega-token sm" aria-hidden="true"></div><span class="mc-tok">${p.megaToken}</span></div>`;
    host.innerHTML = `<span class="mc-label">我的资源 · ${escapeHTML(p.name)} · 球 ${E.tokenTotal(p)}/${E.TOKEN_MAX}</span><div class="mychips">${chips}</div>`;
  }

  function renderBanner() {
    const p = isOnline() ? G.players[G.turn] : me();
    let txt;
    if (G.phase === 'gameover') txt = '游戏结束';
    else if (p.isAI) txt = `${escapeHTML(p.name)} · ${E.scoreOf(G, p)}分 · <span class="thinking">思考中<span class="dot"></span><span class="dot"></span><span class="dot"></span></span>`;
    else txt = `${escapeHTML(p.name)} 的回合${isOnline() && myTurn() ? '（你）' : ''} · ${E.scoreOf(G, p)}分${G.lastRound ? ' · ⚠ 最后一轮' : ''}`;
    $('#turn-banner').innerHTML = txt;
  }

  function renderScoreStrip() {
    const host = $('#score-strip'); if (!host || !G) return;
    const target = G.megasEnabled ? E.MEGA_WIN_SCORE : E.WIN_SCORE;
    host.innerHTML = G.players.map((p, i) => {
      const score = E.scoreOf(G, p), balls = E.tokenTotal(p), active = i === G.turn && G.phase === 'play';
      return `<div class="score-pill${active ? ' active' : ''}" data-player="${i}" role="listitem" ${active ? 'aria-current="true"' : ''}
        aria-label="${escapeHTML(p.name)}：${score}/${target}分，持有${balls}个精灵球${active ? '，当前回合' : ''}">
        <span class="score-dot" style="background:${SEAT_COLORS[i]}" aria-hidden="true"></span>
        <span class="score-name">${escapeHTML(p.name)}</span><b>${score}</b><small>/${target}分</small><span class="score-balls">球${balls}</span>
      </div>`;
    }).join('');
  }

  function renderField() {
    const wrap = $('#field');
    wrap.innerHTML = '';
    const human = (isOnline() ? (myTurn() && netReady()) : isHuman(G.turn)) && G.phase === 'play';
    // Megas expansion: a face-up "Mega 卡" row (zoom only; you mega-evolve at end of turn)
    if (G.megasEnabled && G.megaOffer.length) {
      const rowEl = document.createElement('div');
      rowEl.className = 'tier-row tier-special tier-mega';
      rowEl.dataset.rowKey = 'mega';
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
      rowEl.dataset.rowKey = row.tiers.join('-');
      let inner = `<div class="tier-label">${row.tiers.map(t => TIER_NAMES[t]).join('/')}</div>`;
      for (const tier of row.tiers) {
        const deckN = G.decks[tier].length;
        const canReserveDeck = human && UI.phase === 'main' && E.NORMAL_TIERS.includes(tier) && deckN > 0 && me().reserve.length < E.HAND_MAX && !G.acted;
        inner += `<div class="deck-pile ${canReserveDeck ? 'reservable' : ''}" data-tier="${tier}" ${canReserveDeck ? `data-deck="${tier}" role="button" tabindex="0" data-focus-key="deck-${tier}" aria-label="保留${TIER_NAMES[tier]}牌堆顶，剩余${deckN}张"` : ''}>
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
      const shopHead = document.createElement('div');
      shopHead.className = 'pokemart-head';
      shopHead.innerHTML = `<div class="pokemart-brand"><span class="pokemart-bag" aria-hidden="true">🛍️</span><div><strong>PokéMart</strong><span>宝可梦商店扩展</span></div></div>
        <div class="pokemart-legend" aria-label="商店卡牌状态"><span class="pm-dot ready"></span>可购买 <span class="pm-dot wild"></span>需万能球 <span class="pm-dot locked"></span>暂不可购买</div>`;
      wrap.appendChild(shopHead);
      const shopGrid = document.createElement('div');
      shopGrid.className = 'pokemart-grid';
      for (const tier of ['pmL3', 'pmL2', 'pmL1']) {
        const rowEl = document.createElement('div');
        rowEl.className = 'tier-row tier-pokemart';
        rowEl.dataset.rowKey = tier;
        const deckN = G.decks[tier].length;
        const canReserveDeck = human && UI.phase === 'main' && deckN > 0 && me().reserve.length < E.HAND_MAX && !G.acted;
        const level = tier.slice(-1);
        let inner = `<div class="tier-label"><strong>Lv.${level}</strong><span>${level === '3' ? '高级道具' : level === '2' ? '进阶道具' : '基础道具'}</span></div>`;
        inner += `<div class="deck-pile ${canReserveDeck ? 'reservable' : ''}" data-tier="${tier}" ${canReserveDeck ? `data-deck="${tier}" role="button" tabindex="0" data-focus-key="deck-${tier}" aria-label="保留${TIER_NAMES[tier]}牌堆顶，剩余${deckN}张"` : ''}>
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
        shopGrid.appendChild(rowEl);
      }
      wrap.appendChild(shopGrid);
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
  function acquireBlockReason(card) {
    const p = me();
    if (E.isPokemart(card) && card.effect === 'discard_buy') {
      const col = card.effectParam.discardColor, need = card.effectParam.discardCount;
      const have = p.board.filter(id => E.effBonusColor(G, p, id) === col).length;
      return `需弃掉 ${need} 张${BALL_NAMES[col]}奖励卡，你现有 ${have} 张`;
    }
    if (E.isPokemart(card) && (card.effect === 'copy' || card.effect === 'copy_free') && !p.board.some(id => E.effBonusColor(G, p, id))) {
      return '需先拥有至少 1 张带颜色奖励的卡，用于复制折扣';
    }
    return '';
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
    const human = (isOnline() ? (myTurn() && netReady()) : isHuman(G.turn)) && G.phase === 'play' && UI.phase === 'main' && !G.acted;
    let html = '<div class="panel-title">精灵球供应</div>';
    for (const color of E.ALL_TOKENS) {
      const isMaster = color === 'purple';
      const pick = counts[color] || 0;
      const selectable = human && !isMaster && canAddBall(color);
      const dis = (!human || isMaster || (!selectable && !pick)) ? ' disabled' : '';
      const operable = human && !isMaster && (selectable || pick);
      html += `<div class="supply-row${pick ? ' picked' : ''}${dis}" ${(!isMaster) ? `data-color="${color}" role="button" tabindex="${human ? 0 : -1}" data-focus-key="supply-${color}" aria-disabled="${!operable}" aria-pressed="${!!pick}" aria-label="${BALL_NAMES[color]}，供应${G.supply[color]}个${pick ? `，已选${pick}个` : ''}"` : `aria-label="${BALL_NAMES[color]}，供应${G.supply[color]}个，不可直接拿取"`}>
                 ${ball(color, '')}
                 <span class="name">${BALL_NAMES[color]}</span>
                 ${pick ? `<span class="picked-n">+${pick}</span>` : ''}
                 <span class="cnt">${G.supply[color]}</span>
               </div>`;
    }
    if (G.megasEnabled) {
      const canTake = human && me().megaToken < 1 && G.supply.megaToken > 0;
      const held = me().megaToken;
      html += `<div class="supply-row mega-row${canTake ? '' : ' disabled'}" ${canTake ? 'data-take-mega="1" role="button" tabindex="0" data-focus-key="supply-mega"' : ''} title="花费整个回合获得1个 Mega 代币">
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
  function validTakeSelection() {
    if (!UI.pick.length) return false;
    try { return !!E.actionTake(E.clone(G), UI.pick.slice()).ok; } catch (e) { return false; }
  }
  function takeGuidance() {
    const counts = {}; UI.pick.forEach(c => counts[c] = (counts[c] || 0) + 1);
    const distinct = Object.keys(counts).length;
    if (validTakeSelection()) return `已组成合法拿取：${UI.pick.length} 个精灵球`;
    if (UI.pick.length === 1) return '再选 2 个不同颜色，或再选 1 个同色（该色供应至少 4）';
    if (UI.pick.length === 2 && distinct === 2) return '再选 1 个不同颜色';
    return '请调整已选精灵球';
  }

  function renderActionBar() {
    const bar = $('#action-bar');
    if (G.phase === 'gameover') { bar.innerHTML = '<div class="act-hint">游戏已结束。</div>'; return; }
    const p = me();
    if (p.isAI) { bar.innerHTML = '<div class="act-hint">电脑正在行动…</div>'; return; }
    if (isOnline() && !netReady()) {
      bar.innerHTML = '<div class="act-hint">🔌 连接已断开，正在重连…<br><span style="font-size:12px;opacity:.7">重连成功后可以继续操作，进度不会丢</span></div>';
      return;
    }
    if (isOnline() && !myTurn()) { bar.innerHTML = `<div class="act-hint">等待 <b>${escapeHTML(G.players[G.turn].name)}</b> 行动…<br><span style="font-size:12px;opacity:.7">轮到你时这里会出现操作按钮</span></div>`; return; }
    if (isOnline() && UI.net.pendingAction) { bar.innerHTML = '<div class="act-hint"><span class="thinking">正在等待服务器确认 <span class="dot"></span><span class="dot"></span><span class="dot"></span></span></div>'; return; }

    if (UI.phase === 'discard') {
      const over = E.tokenTotal(p) - E.TOKEN_MAX;
      let tray = E.ALL_TOKENS.filter(c => p.tokens[c] > 0)
        .map(c => `<div class="ball ${c}" data-discard="${c}" data-focus-key="discard-${c}" role="button" tabindex="0" aria-label="归还1个${BALL_NAMES[c]}" title="归还${BALL_NAMES[c]}" style="cursor:pointer">${''}</div>`).join('');
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
      const ready = validTakeSelection();
      const trayHtml = UI.pick.map((c, i) => `<button class="ball ${c} sm tray-pick" data-unpick="${i}" aria-label="移除已选的${BALL_NAMES[c]}" title="点击移除"></button>`).join('');
      bar.innerHTML = `<div class="act-hint"><b>${takeGuidance()}</b><br><span style="font-size:11px;opacity:.75">点下方已选球可单独撤销</span></div><div class="tray">${trayHtml}</div>
        <div class="act-buttons"><button class="primary" data-act="confirm-take" ${ready ? '' : 'disabled'}>拿取 ${UI.pick.length} 个</button><button class="ghost" data-act="clear-take">全部取消</button></div>`;
      return;
    }
    if (UI.selCard) {
      const c = byId[UI.selCard];
      const info = affordInfo(c);
      const aff = !!info;
      const loc = E.locateCard(G, UI.selCard);
      const rs = reserveState(loc, p);
      const actionText = acquireLabel(c);
      const eff = E.isPokemart(c) && c.effect ? ` · <span class="eff-tag">${EFFECT_NAMES[c.effect] || ''}</span>` : '';
      let ledger = purchaseLedgerHTML(c, info);
      const block = !aff ? acquireBlockReason(c) : '';
      if (block) ledger = `<div class="pay-ledger unafford"><div class="pl-short">⚠ ${block}</div></div>` + ledger;
      else if (!ledger && !aff) ledger = `<div class="pay-ledger unafford"><div class="pl-short">⚠ 当前资源不足</div></div>`;
      if (rs && !rs.ok) ledger += `<div class="pay-ledger unafford"><div class="pl-short">🚫 ${rs.reason}</div></div>`;
      let html = `<img class="sel-preview${E.isPokemart(c) ? ' pm-card' : ''}" src="${c.img}" alt="${c.name}卡面"><div class="act-hint">已选：<b>${c.name}</b>（${TIER_NAMES[c.tier]}，${c.vp}分）${eff}<br><span style="font-size:12px;opacity:.75">点卡面可放大查看</span></div>${ledger}<div class="act-buttons">`;
      if (aff) html += `<button class="primary" data-act="capture">${actionText}</button>`;
      if (rs) html += rs.ok
        ? `<button class="${aff ? 'ghost' : 'primary'}" data-act="reserve-card">保留</button>`   // can't capture → reserving IS the main move
        : `<button class="ghost" disabled aria-disabled="true">保留</button>`;
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

  // 联机时每位玩家名字前的在线状态点：一眼看出谁掉线了（对局中很关键）
  function netDot(seat) {
    if (!isOnline() || !UI.net.roster || !UI.net.roster.length) return '';
    const r = UI.net.roster.find(x => x.seat === seat);
    if (!r) return '';
    const on = !!r.connected;
    const title = on ? '在线' : '已断线（可随时重连回来）';
    return '<span class="pdot ' + (on ? 'on' : 'off') + '" title="' + title + '"></span>';
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
        chips += `<div class="chip" aria-label="${BALL_NAMES[c]}：手中 ${p.tokens[c]} 个，永久折扣 ${b[c]}">
          ${ball(c, 'sm')}<span class="num"><small>球</small>${p.tokens[c]}</span><span class="bonus-n"><small>折</small>${b[c]}</span>
        </div>`;
      }
      chips += `<div class="chip master" aria-label="大师球：手中 ${p.tokens.purple} 个">${ball('purple', 'sm')}<span class="num">${p.tokens.purple}</span></div>`;
      // captured cards grouped by effective bonus color (Pokémart copy cards take
      // their associated colour; effect cards with no colour go in a final group).
      let stacks = '';
      const groups = E.COLORS.map(c => ({ key: c, ids: p.board.filter(id => E.effBonusColor(G, p, id) === c) }));
      groups.push({ key: null, ids: p.board.filter(id => E.effBonusColor(G, p, id) === null) });
      for (const g of groups) {
        if (!g.ids.length) continue;
        let st = '';
        g.ids.forEach((id, idx) => {
          const mc = byId[id];
          st += `<div class="mini-card${idx ? ' stacked' : ''}${E.isPokemart(mc) ? ' pm-mini' : ''}" data-zoom="${mc.img}" role="button" tabindex="0" data-focus-key="owned-${i}-${id}" aria-label="查看${mc.name}"><img src="${mc.img}" alt=""></div>`;
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
          if (revealReserve && !stub) return `<div class="mini-card${UI.selCard === realId ? ' selected' : ''}${E.isPokemart(byId[realId]) ? ' pm-mini' : ''}" data-zoom="${byId[realId].img}" data-reserve-capture="${realId}" role="button" tabindex="0" data-focus-key="reserve-${realId}" aria-label="选择保留的${byId[realId].name}"><img src="${byId[realId].img}" alt=""></div>`;
          return `<div class="mini-card card-back" data-tier="${tier}"></div>`;
        }).join('');
        const hint = revealReserve ? '（点击可捕捉）' : '';
        rz = `<div class="reserve-zone"><div class="rz-title">保留区 (${p.reserve.length})${hint}</div><div class="pcards">${cards}</div></div>`;
      }
      el.innerHTML =
        `<div class="player-head">
           <div class="pavatar" style="background-color:${SEAT_COLORS[i]};background-image:url(${seatAvatar(i)});box-shadow:0 0 0 2px ${SEAT_COLORS[i]}"></div>
           <div class="pname">${netDot(i)}${escapeHTML(p.name)}</div>
           <div class="ptokens${tot > E.TOKEN_MAX ? ' over' : tot === E.TOKEN_MAX ? ' full' : ''}" title="持有的精灵球总数（回合结束上限 ${E.TOKEN_MAX} 个）" aria-label="持有精灵球 ${tot}/${E.TOKEN_MAX}"><span class="pt-lbl">球</span>${tot}<small>/${E.TOKEN_MAX}</small></div>
           <div class="pscore" aria-label="${E.scoreOf(G, p)}分，目标${G.megasEnabled ? E.MEGA_WIN_SCORE : E.WIN_SCORE}分">${E.scoreOf(G, p)}<small>/${G.megasEnabled ? E.MEGA_WIN_SCORE : E.WIN_SCORE}</small></div>
         </div>
         ${p.buried.length ? `<div class="buried-badge">已进化 ${p.buried.length}</div>` : ''}
         <div class="pstats">${chips}</div>
         <div class="pcards">${stacks || '<span style="color:var(--muted);font-size:12px">尚无宝可梦</span>'}</div>
         ${rz}`;
      wrap.appendChild(el);
    }
  }

  function renderLog() {
    const lines = G.log.slice(-40).map(l => `<div class="ln">${escapeHTML(l.msg)}</div>`).join('');
    const box = $('#log-lines');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    const prevTop = box.scrollTop;
    if (box.dataset.logHtml === lines) return; // selecting a card must not reset log reading position
    box.innerHTML = lines;
    box.dataset.logHtml = lines;
    if (atBottom || !box.dataset.hadLog) box.scrollTop = box.scrollHeight;
    else box.scrollTop = prevTop;
    box.dataset.hadLog = '1';
  }

  // ---------------------------------------------------------------- interactions
  function onSupplyClick(color) {
    if (!interactable()) return;
    if (canAddBall(color)) {
      UI.pick.push(color); UI.selCard = UI.selDeck = null; render();
      if (validTakeSelection()) focusActionPanel();
    }
  }
  function onCardClick(id) {
    if (!interactable() || UI.pick.length) return;
    if (byId[id] && byId[id].tier === 'mega') return; // Mega cards: zoom only; evolve at end of turn
    UI.selCard = id; UI.selDeck = null; render(); focusActionPanel();
  }
  function onDeckClick(tier) {
    if (!interactable()) return;
    UI.selDeck = tier; UI.selCard = null; render(); focusActionPanel();
  }
  function interactable() { return G && G.phase === 'play' && UI.phase === 'main' && !G.acted && !me().isAI && !UI.busy && (!isOnline() || (myTurn() && netReady() && !UI.net.pendingAction)); }
  function focusActionPanel() {
    requestAnimationFrame(() => {
      const bar = $('#action-bar');
      const primary = bar && bar.querySelector('button.primary:not(:disabled),button[data-act="reserve-card"]:not(:disabled),button:not(:disabled)');
      if (!bar || !primary) return;
      try { bar.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); } catch (e) { }
      primary.focus({ preventScroll: true });
    });
  }
  // 联机时还要求：连接正常（断线时点击会被静默丢弃，不如直接禁用）
  function netReady() { return !isOnline() || (UI.net.status === 'connected'); }

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
    } else if (dec.type === 'takeMega') {
      const el = $('[data-take-mega] .ball'); src.push({ color: 'mega-token', rect: el ? el.getBoundingClientRect() : null });
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
    let panel = $$('#players .player')[pid];
    if (panel) {
      const r = panel.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) {
        const score = $(`#score-strip [data-player="${pid}"]`);
        const dock = (pid === G.turn) ? $('#my-resources') : null;
        panel = (score && score.offsetParent) ? score : (dock && dock.offsetParent ? dock : $('#turn-banner'));
      }
    }
    if (!panel) return;
    panel.classList.add('receiving'); setTimeout(() => panel.classList.remove('receiving'), 520);
    const dc = centerOf(panel);
    if (dec.type === 'take' || dec.type === 'takeMega') { for (const it of (src || [])) flyBall(it.color, it.rect, dc); }
    else if (dec.type === 'capture' || dec.type === 'reserve') { const it = (src || [])[0]; if (it) flyCard(it.img, it.rect, dc, it.tier); }
  }
  function actionReceipt(dec, pid, before) {
    const p = G.players[pid];
    if (!dec || !p || !before) return '';
    if (dec.type === 'take') {
      const counts = {};
      (dec.colors || []).forEach(c => counts[c] = (counts[c] || 0) + 1);
      const got = Object.keys(counts).map(c => `${BALL_NAMES[c]}×${counts[c]}`).join('、');
      return got ? `拿取成功：${got} · 当前 ${E.tokenTotal(p)}/${E.TOKEN_MAX} 个球` : '';
    }
    if (dec.type === 'capture') {
      const card = byId[dec.cardId], gained = E.scoreOf(G, p) - before.score;
      const paid = E.ALL_TOKENS.map(c => ({ c, n: before.tokens[c] - p.tokens[c] })).filter(x => x.n > 0)
        .map(x => `${BALL_NAMES[x.c]}×${x.n}`).join('、');
      return `${card && E.isPokemart(card) ? '购买' : '捕捉'}成功：${card ? card.name : '卡牌'}${gained ? ` · +${gained}分` : ''}${paid ? ` · 交出 ${paid}` : ' · 无需交球'}`;
    }
    if (dec.type === 'reserve') {
      const name = dec.cardId && byId[dec.cardId] ? byId[dec.cardId].name : `${TIER_NAMES[dec.deck] || ''}牌堆顶`;
      const masters = Math.max(0, p.tokens.purple - before.tokens.purple);
      return `已保留 ${name}${masters ? ` · 获得${masters}个大师球` : ''}`;
    }
    return '';
  }
  // capture source rects, apply mutation, render, animate ghosts to the player, then continue
  function applyAnimated(dec, pid, mutate, after) {
    const src = captureSrc(dec);
    const bp = G.players[pid];
    const before = { tokens: Object.assign({}, bp.tokens), score: E.scoreOf(G, bp) };
    const r = mutate();
    if (r && r.ok === false) { flashHint(r.error); return; }
    const epoch = gameEpoch;
    render(); playGhosts(src, dec, pid);
    const receipt = actionReceipt(dec, pid, before);
    if (receipt) flashHint(receipt, 'success');
    setTimeout(() => { if (epoch === gameEpoch) after(); }, ANIM_MS);   // skip if game changed (undo/new game)
  }

  function doTake() {
    const colors = UI.pick.slice(); const pid = G.turn;
    if (isOnline()) { if (sendNetAction({ type: 'take', colors }, '正在提交拿取…')) UI.pick = []; render(); return; }
    applyAnimated({ type: 'take', colors }, pid, () => { const r = E.actionTake(G, colors); if (r.ok) UI.pick = []; return r; }, afterMainAction);
  }
  function commitCapture(cid, opts) {
    const pid = G.turn;
    if (isOnline()) { if (sendNetAction({ type: 'capture', cardId: cid, opts }, '正在提交获得…')) UI.selCard = null; render(); return; }
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
      const returnFocus = document.activeElement;
      $('#choice-title').textContent = o.title;
      $('#choice-hint').textContent = o.hint || '';
      confirm.textContent = o.confirmLabel || '确认选择';
      const progress = $('#choice-progress');
      const wrap = $('#choice-cards'); wrap.innerHTML = '';
      const count = o.count, sel = [];
      const update = () => {
        confirm.disabled = sel.length !== count;
        progress.textContent = `已选 ${sel.length} / ${count}`;
        progress.classList.toggle('complete', sel.length === count);
      };
      (o.candidates || []).forEach((id) => {
        const c = byId[id];
        const owned = me().board.includes(id);
        const color = owned ? E.effBonusColor(G, me(), id) : (c.bonus && c.bonus !== 'none' ? c.bonus : null);
        const el = document.createElement('div');
        el.className = 'choice-card' + (E.isPokemart(c) ? ' pm-choice' : ''); el.dataset.id = id; el.dataset.zoom = c.img;
        el.tabIndex = 0; el.setAttribute('role', 'checkbox'); el.setAttribute('aria-checked', 'false');
        el.setAttribute('aria-label', `${c.name}，${TIER_NAMES[c.tier]}，${c.vp}分${color ? `，${BALL_NAMES[color]}奖励` : ''}`);
        el.innerHTML = `<img src="${c.img}" alt=""><span>${c.name}</span><small>${TIER_NAMES[c.tier]} · ${c.vp}分${color ? ` · ${BALL_NAMES[color]}奖励` : ''}</small>`;
        const toggle = () => {
          const i = sel.indexOf(id);
          if (i >= 0) { sel.splice(i, 1); el.classList.remove('sel'); }
          else {
            if (count === 1) { sel.length = 0; wrap.querySelectorAll('.choice-card').forEach(x => { x.classList.remove('sel'); x.setAttribute('aria-checked', 'false'); }); }
            else if (sel.length >= count) return;
            sel.push(id); el.classList.add('sel');
          }
          el.setAttribute('aria-checked', String(sel.includes(id)));
          update();
        };
        el.addEventListener('click', toggle);
        el.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); toggle(); } });
        wrap.appendChild(el);
      });
      update();
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); no(); } };
      const close = (val) => {
        modal.classList.add('hidden'); document.body.classList.remove('tutorial-choice-open');
        const game = $('#game'); if (game) game.inert = false;
        confirm.removeEventListener('click', ok); cancel.removeEventListener('click', no); document.removeEventListener('keydown', onKey);
        if (returnFocus && returnFocus.focus) returnFocus.focus({ preventScroll: true });
        resolve(val);
      };
      const ok = () => { if (sel.length === count) close(sel.slice()); };
      const no = () => close(null);
      confirm.addEventListener('click', ok); cancel.addEventListener('click', no);
      document.body.classList.toggle('tutorial-choice-open', !!(window.Tutorial && Tutorial.active && Tutorial.active()));
      const game = $('#game'); if (game) game.inert = true;
      modal.classList.remove('hidden');
      document.addEventListener('keydown', onKey);
      const firstChoice = wrap.querySelector('.choice-card');
      (firstChoice || cancel).focus();
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
        const sel = await pickCards({ title: '弃用图鉴抵款', hint: `弃 ${need} 张图鉴，各抵 2 个万能球以获得这张卡`, candidates: dex, count: need, confirmLabel: `弃用 ${need} 张并继续` });
        if (!sel) return null;
        opts.spendPokedex = sel;
      }
    }
    // 2) copy association (TM / RARE CANDY)
    if (card.effect === 'copy' || card.effect === 'copy_free') {
      const cands = p.board.filter(id => E.effBonusColor(G, p, id));
      const sel = await pickCards({ title: '复制折扣（技能机 / 神奇糖果）', hint: '选择一张卡，本卡永久视同其奖励颜色', candidates: cands, count: 1, confirmLabel: '复制该奖励' });
      if (!sel) return null;
      opts.copyTargetId = sel[0];
    }
    // 3) REPEL: discard N owned cards of its colour
    if (card.effect === 'discard_buy') {
      const col = card.effectParam.discardColor, n = card.effectParam.discardCount;
      const cands = p.board.filter(id => E.effBonusColor(G, p, id) === col);
      const sel = await pickCards({ title: '驱虫喷雾', hint: `弃掉 ${n} 张${BALL_NAMES[col]}卡以获得本卡（不付精灵球）`, candidates: cands, count: n, confirmLabel: `弃掉 ${n} 张并购买` });
      if (!sel) return null;
      opts.discardCards = sel;
    }
    // 4) take a free card (EVOLVE STONE / RARE CANDY), possibly recursive
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
    if (!cands.length) { flashHint('场上没有符合条件的免费卡，本次免费取卡效果略过', 'info'); return { freeTakeId: undefined }; }
    const sel = await pickCards({ title: '免费获得一张卡', hint: '立即免费获得（不付其成本），结算其效果', candidates: cands, count: 1, confirmLabel: '免费获得这张卡' });
    if (!sel) return null;
    const freeId = sel[0], fc = byId[freeId], freeOpts = {};
    if (E.isPokemart(fc) && (fc.effect === 'copy' || fc.effect === 'copy_free')) {
      const cc = p.board.filter(id => E.effBonusColor(G, p, id));
      const cp = await pickCards({ title: `关联「${fc.name}」`, hint: '为免费获得的卡选择复制奖励的卡', candidates: cc, count: 1, confirmLabel: '复制该奖励' });
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
    if (isOnline()) { if (sendNetAction({ type: 'reserve', target: { fromField: cid } }, '正在提交保留…')) UI.selCard = null; render(); return; }
    applyAnimated({ type: 'reserve', cardId: cid }, pid, () => { const r = E.actionReserve(G, { fromField: cid }); if (r.ok) UI.selCard = null; return r; }, afterMainAction);
  }
  function doReserveDeck() {
    const tier = UI.selDeck, pid = G.turn;
    if (isOnline()) { if (sendNetAction({ type: 'reserve', target: { fromDeck: tier } }, '正在提交保留…')) UI.selDeck = null; render(); return; }
    applyAnimated({ type: 'reserve', deck: tier }, pid, () => { const r = E.actionReserve(G, { fromDeck: tier }); if (r.ok) UI.selDeck = null; return r; }, afterMainAction);
  }
  function decodePlan(plan) {
    const a = plan && plan.action; if (!a) return { type: 'pass' };
    if (a.type === 'take') return { type: 'take', colors: a.colors };
    if (a.type === 'capture') return { type: 'capture', cardId: a.cardId };
    if (a.type === 'reserve') return { type: 'reserve', cardId: (a.target && a.target.fromField) || null, deck: (a.target && a.target.fromDeck) || null };
    if (a.type === 'takeMega') return { type: 'takeMega' };
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
  let undoHome = null, undoBtnEl = null;   // desktop home (fixed corner) + a retained node reference
  function updateUndoBtn() {
    // Keep our own reference: on phones the button lives inside #action-bar, whose innerHTML is
    // rebuilt every render — that detaches the node, and a fresh querySelector would find nothing.
    const btn = undoBtnEl || (undoBtnEl = $('#undo-btn')); if (!btn) return;
    if (!undoHome) undoHome = btn.parentNode;
    const show = UI.hasAI && UI.humans === 1 && G && G.phase === 'play' && UI.phase === 'main' && !me().isAI && !UI.busy && undoStack.length >= 2;
    btn.classList.toggle('hidden', !show);
    // On phones the button sits inside the action bar (thumb zone, part of the dock) instead of
    // floating over the board — floating bottom-left it landed on the lowest row's deck pile on
    // small screens. The bar is rebuilt every render, so re-home the button each time.
    const bar = $('#action-bar'), onMobile = matchMedia('(max-width:999px)').matches;
    if (onMobile) { if (bar && btn.parentNode !== bar) bar.appendChild(btn); }
    else if (btn.parentNode !== undoHome) undoHome.appendChild(btn);
  }
  function doDiscard(color) {
    if (UI.phase !== 'discard') return;
    if (isOnline()) { sendNetAction({ type: 'discard', color }, '正在归还精灵球…'); render(); return; }
    E.actionDiscard(G, color);
    if (!E.needsDiscard(G, me())) toEvolveOrEnd();
    render();
  }
  function doEvolve(fromId, toId) {
    if (isOnline()) { sendNetAction({ type: 'evolve', fromId, toId }, '正在提交进化…'); render(); return; }
    const r = E.actionEvolve(G, fromId, toId);
    if (!r.ok) { flashHint(r.error); return; }
    flashHint(`进化成功：${byId[fromId].name} → ${byId[toId].name}`, 'success');
    endTurn();
  }
  function doMegaEvolve(megaId, fromId) {
    if (isOnline()) { sendNetAction({ type: 'megaEvolve', megaId, fromId }, '正在提交超级进化…'); render(); return; }
    const r = E.actionMegaEvolve(G, megaId, fromId);
    if (!r.ok) { flashHint(r.error); return; }
    flashHint(`超级进化成功：${byId[fromId].name} → ${byId[megaId].name}`, 'success');
    endTurn();
  }
  function doTakeMega() {
    if (!interactable()) return;
    if (isOnline()) { sendNetAction({ type: 'takeMega' }, '正在提交 Mega 代币…'); render(); return; }
    const r = E.actionTakeMega(G);
    if (!r.ok) { flashHint(r.error); return; }
    flashHint('获得 1 枚 Mega 代币', 'success');
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
    if (isOnline()) { sendNetAction({ type: 'endTurn' }, '正在结束回合…'); render(); return; }
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
    if (!ov) {
      ov = document.createElement('div'); ov.id = 'pass-overlay';
      ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'pass-title');
      document.body.appendChild(ov);
    }
    ov.innerHTML = `<div class="po-inner"><div class="pavatar" style="margin:0 auto 14px;width:56px;height:56px;background-color:${SEAT_COLORS[G.turn]};background-image:url(${seatAvatar(G.turn)});box-shadow:0 0 0 3px ${SEAT_COLORS[G.turn]}"></div>
      <h2 id="pass-title">请将设备交给<br>${escapeHTML(p.name)}</h2><p>其他玩家的保留区会保持隐藏</p>
      <button class="primary" id="ready-btn" style="margin-top:16px;padding:12px 30px">我准备好了</button></div>`;
    const game = $('#game'); if (game) game.inert = true;
    ov.classList.remove('hidden');
    $('#ready-btn').onclick = () => {
      ov.classList.add('hidden'); if (game) game.inert = false; render();
      requestAnimationFrame(() => { const first = $('#supply [role="button"]'); if (first) first.focus({ preventScroll: true }); });
    };
    $('#ready-btn').focus();
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
    // Start the heavy search NOW, in the worker, so it runs DURING the "thinking"
    // pause instead of freezing the UI after it. AZ seats keep their own sync path.
    const fallbackDiff = (p.diff === 'alphazero' || p.diff === 'ultra') ? 'hard' : (p.diff || 'hard');
    const planPromise = (p.diff === 'alphazero' && window.AZAI && AZAI.hasWeights())
      ? null
      : aiComputeAsync(isUltra ? 'ultra' : fallbackDiff, isUltra ? ULTRA_CFG : undefined);
    setTimeout(async () => {
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
        const plan = planPromise ? await planPromise
          : AI.chooseTurn(G, { difficulty: fallbackDiff });   // AZ seat whose net move failed
        if (epoch !== gameEpoch) return;               // undo/new-game while the worker searched
        if (!G || G.phase === 'gameover') { UI.busy = false; return; }
        // Megas moves (takeMega action, mega evolution) now come from the plan
        // itself: legalActions enumerates takeMega and AI.manage weighs mega vs
        // normal evolution — no UI bolt-ons, so search and reality stay in sync.
        dec = decodePlan(plan);
        applyFn = () => {
          if (plan.action) E.applyAction(G, plan.action); else E.actionPass(G);
          for (const c of plan.discards) E.actionDiscard(G, c);
          if (plan.megaEvolution && !G.evolvedThisTurn) E.actionMegaEvolve(G, plan.megaEvolution.megaId, plan.megaEvolution.fromId);
          else if (plan.evolution && !G.evolvedThisTurn) E.actionEvolve(G, plan.evolution.fromId, plan.evolution.toId);
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

  // ---------------------------------------------------------------- win
  function showWin() {
    const scores = G.players.map((p, i) => ({ i, s: E.scoreOf(G, p), bur: p.buried.length, brd: p.board.length, name: p.name }));
    const w = G.winner;
    let rows = scores.slice().sort((a, b) => b.s - a.s || b.bur - a.bur || b.brd - a.brd)
      .map(r => `<div class="wrow${r.i === w ? ' winner' : ''}"><span>${r.i === w ? '👑 ' : ''}${escapeHTML(r.name)}</span><span>${r.s} 分 · ${r.brd} 只 · 进化 ${r.bur}</span></div>`).join('');
    // 和棋（牌与球耗尽、无人达成胜利条件）要说清楚，否则玩家看到「某某获胜」会以为是正常结束
    const stale = !!G.stalemate;
    const head = stale
      ? `<div class="win-trophy">🤝</div><h2 id="win-title">牌局结束 · ${escapeHTML(G.players[w].name)} 分数最高</h2>` +
        '<div class="win-note">卡牌与精灵球都已耗尽，无人达成胜利条件 —— 按当前分数结算</div>'
      : `<div class="win-trophy">🏆</div><h2 id="win-title">${escapeHTML(G.players[w].name)} 获胜！</h2>`;
    $('#win-content').innerHTML = head + `<div class="win-scores">${rows}</div>`;
    // 联机：房主可以原地重开，座位/房间码/邀请链接都不变；非房主等房主开
    const wa = $('#win-actions');
    if (wa) {
      if (isOnline()) {
        wa.innerHTML = UI.net.host
          ? '<button class="primary" id="win-rematch">再来一局（同房间）</button>' +
            '<button class="ghost" id="win-leave">离开房间</button>'
          : '<div class="win-wait">等待房主开下一局…</div>' +
            '<button class="ghost" id="win-leave">离开房间</button>';
        const rm = $('#win-rematch');
        if (rm) rm.addEventListener('click', () => {
          if (!window.Net || !Net.rematch()) { flashHint('连接已断开，重连后再试'); return; }
          rm.disabled = true; rm.textContent = '正在重开…';
        });
        const lv = $('#win-leave');
        if (lv) lv.addEventListener('click', () => { $('#win-modal').classList.add('hidden'); leaveOnline(); });
      } else {
        wa.innerHTML = '<button class="primary" id="play-again">再来一局</button>';
        const pa = $('#play-again');
        if (pa) pa.addEventListener('click', () => { if (window.Tutorial && Tutorial.stop) Tutorial.stop(); backToSetup(); });
      }
    }
    $('#win-modal').classList.remove('hidden');
    // 联机时按钮被换成了「再来一局（同房间）」/「离开房间」，#play-again 可能不存在，
    // 这里聚焦「弹窗里第一个按钮」而不是写死 id（否则联机结算时会抛 TypeError）。
    const firstBtn = document.querySelector('#win-actions button');
    if (firstBtn) firstBtn.focus();
  }

  let toastTimer = null;
  function flashHint(msg, tone) {
    const toast = $('#toast'); if (!toast) return;
    tone = tone || 'error';
    clearTimeout(toastTimer);
    toast.textContent = String(msg || '操作未完成');
    toast.className = `toast ${tone}`;
    toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    toastTimer = setTimeout(() => toast.classList.add('hidden'), tone === 'error' ? 3800 : 2600);
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
  let inspectReturnFocus = null;
  function openInspect(src, actionsHtml, altText) {
    const ov = $('#inspect'); if (!ov || !src) return;
    inspectReturnFocus = document.activeElement;
    $('#inspect-img').src = src;
    $('#inspect-img').alt = altText || '卡牌详情';
    $('#inspect-actions').innerHTML = (actionsHtml || '') + `<button class="ghost" data-inspect-close>关闭</button>`;
    const game = $('#game'); if (game) game.inert = true;
    ov.classList.remove('hidden');
    $('[data-inspect-close]', ov).focus();
  }
  function closeInspect() {
    const ov = $('#inspect'); if (ov) ov.classList.add('hidden');
    const game = $('#game'); if (game) game.inert = false;
    if (inspectReturnFocus && inspectReturnFocus.focus) inspectReturnFocus.focus({ preventScroll: true });
    inspectReturnFocus = null;
  }
  // Can this field card be reserved right now? null = reserving doesn't apply (not a field card);
  // otherwise {ok, reason}. The UI shows a disabled 保留 with the rule rather than omitting the
  // button — players read a missing button as a bug ("联机时保留按钮没了").
  function reserveState(loc, p) {
    if (!loc || loc.where !== 'field') return null;
    if (!(E.NORMAL_TIERS.includes(loc.tier) || E.PM_TIERS.includes(loc.tier))) return { ok: false, reason: '稀有 / 传说不可保留，只能用大师球捕捉' };
    if (p.reserve.length >= E.HAND_MAX) return { ok: false, reason: `手牌已满（最多保留 ${E.HAND_MAX} 张）` };
    return { ok: true };
  }
  // build capture/reserve buttons for the inspect overlay, if the card is actionable now
  function inspectActionsFor(id) {
    if (!interactable()) return '';
    const p = me(), c = byId[id]; if (!c) return '';
    const loc = E.locateCard(G, id);
    const rs = loc ? reserveState(loc, p) : null, aff = !!affordInfo(c);
    let h = '';
    if (aff) h += `<button class="primary" data-inspect-act="capture">${acquireLabel(c)}</button>`;
    if (rs) h += rs.ok
      ? `<button class="${aff ? 'ghost' : 'primary'}" data-inspect-act="reserve-card">保留</button>`
      : `<button class="ghost" disabled aria-disabled="true">保留</button><span class="inspect-note">🚫 ${rs.reason}</span>`;
    return h;
  }

  // keep --dock-h in sync with the fixed mobile control dock so scroll content clears it
  function syncDockH() {
    const dock = $('#controls'); if (!dock) return;
    const onMobile = matchMedia('(max-width:999px)').matches;
    document.documentElement.style.setProperty('--dock-h', onMobile ? dock.offsetHeight + 'px' : '0px');
  }
  function trackDock() {
    const dock = $('#controls'); if (!dock) return;
    if (window.ResizeObserver) new ResizeObserver(syncDockH).observe(dock);
    const mq = matchMedia('(max-width:999px)');
    (mq.addEventListener ? mq.addEventListener('change', syncDockH) : mq.addListener && mq.addListener(syncDockH));
    window.addEventListener('resize', syncDockH, { passive: true });
    // Board rows start snapping only after the player scrolls them (css .tier-row.snap).
    // Snapping from load pre-scrolled every row, sliding the deck pile under the sticky
    // tier label, which then swallowed the tap. Rows are rebuilt each render, so this is cheap.
    document.addEventListener('scroll', (e) => {
      const row = e.target && e.target.closest && e.target.closest('.tier-row');
      if (row) row.classList.add('snap');
    }, { capture: true, passive: true });
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
      $$('#player-count button').forEach(x => { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
      b.classList.add('active'); buildSeats(+b.dataset.n);
      b.setAttribute('aria-pressed', 'true');
    });
    $('#start-btn').addEventListener('click', startGame);
    if ($('#opt-megas')) $('#opt-megas').addEventListener('change', syncSetupGoal);
    syncSetupGoal(); syncTutorialProgress();
    // online lobby
    if ($('#online-create')) $('#online-create').addEventListener('click', () => openOnline(makeRoomCode(), true));
    if ($('#online-join')) $('#online-join').addEventListener('click', () => {
      const c = prompt('输入房间码，或直接粘贴朋友发来的邀请链接：');
      if (c == null) return;                       // 用户取消
      const parsed = (window.Net && Net.parseRoomCode) ? Net.parseRoomCode(c) : '';
      if (!parsed) { flashHint('没认出房间码，请粘贴邀请链接或输入 5 位房间码'); return; }
      openOnline(parsed, false);
    });
    // 大厅昵称：边打边同步给房间（去抖），所有人立刻看到新名字
    const nick = $('#lobby-nick');
    if (nick) {
      let nickTimer = null;
      nick.addEventListener('input', () => {
        const v = nick.value.trim().slice(0, 12);
        if (!v) return;
        saveNick(v);
        clearTimeout(nickTimer);
        nickTimer = setTimeout(() => { if (window.Net && UI.net) Net.setName(v); }, 350);
      });
    }
    if ($('#lobby-start')) $('#lobby-start').addEventListener('click', () => { if (window.Net) Net.start({ megas: !!($('#lobby-megas') && $('#lobby-megas').checked), pokemart: !!($('#lobby-pokemart') && $('#lobby-pokemart').checked) }); });
    if ($('#lobby-leave')) $('#lobby-leave').addEventListener('click', leaveOnline);
    if ($('#lobby-copy')) $('#lobby-copy').addEventListener('click', () => {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(location.href).then(() => flashHint('邀请链接已复制', 'success')).catch(() => flashHint(`请手动复制：${location.href}`, 'info'));
      else flashHint(`请手动复制：${location.href}`, 'info');
    });
    if ($('#tutorial-btn')) $('#tutorial-btn').addEventListener('click', () => { if (window.Tutorial) Tutorial.start('base'); });
    if ($('#tutorial-mega-btn')) $('#tutorial-mega-btn').addEventListener('click', () => { if (window.Tutorial) Tutorial.start('megas'); });
    if ($('#tutorial-pokemart-btn')) $('#tutorial-pokemart-btn').addEventListener('click', () => { if (window.Tutorial) Tutorial.start('pokemart'); });
    $('#undo-btn').addEventListener('click', doUndo);
    let rulesReturnFocus = null;
    const closeRules = () => {
      $('#rules-modal').classList.add('hidden'); $('#setup').inert = false;
      if (rulesReturnFocus) rulesReturnFocus.focus({ preventScroll: true }); rulesReturnFocus = null;
    };
    $('#rules-btn').addEventListener('click', () => {
      rulesReturnFocus = document.activeElement; $('#setup').inert = true; $('#rules-modal').classList.remove('hidden'); $('#rules-title').focus();
    });
    $('#rules-modal').addEventListener('click', (e) => { if (e.target.id === 'rules-modal' || e.target.classList.contains('close-rules')) closeRules(); });
    $('#menu-btn').addEventListener('click', () => {
      const inTut = window.Tutorial && Tutorial.active && Tutorial.active();
      if (confirm(inTut ? '退出教程，返回主菜单？' : '返回主菜单？当前对局将丢失。')) {
        if (!inTut) clearSave();              // explicit quit of a real game = abandon its autosave
        if (window.Tutorial && Tutorial.stop) Tutorial.stop();
        backToSetup();
      }
    });
    // 注意：#play-again 现在由 showWin() 动态重建（联机时换成「再来一局（同房间）」），
    // 这里只做初始绑定的空安全兜底。
    if ($('#play-again')) $('#play-again').addEventListener('click', () => { if (window.Tutorial && Tutorial.stop) Tutorial.stop(); backToSetup(); });

    // delegated game clicks
    $('#supply').addEventListener('click', (e) => {
      if (e.target.closest('[data-take-mega]')) { doTakeMega(); return; }
      const r = e.target.closest('[data-color]'); if (r && r.getAttribute('aria-disabled') !== 'true') onSupplyClick(r.dataset.color);
    });
    $('#field').addEventListener('click', (e) => {
      const dk = e.target.closest('[data-deck]'); if (dk) { onDeckClick(dk.dataset.deck); return; }
      const cd = e.target.closest('[data-card]');
      if (cd) {
        const id = cd.dataset.card;
        const isMega = byId[id] && byId[id].tier === 'mega';
        // Mega cards (zoom-only) and any tap when it's not your turn → just enlarge for reading.
        if (isMega || !interactable() || UI.pick.length) { openInspect(cd.dataset.zoom || (byId[id] && byId[id].img), '', byId[id] && byId[id].name); return; }
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
      if (e.target.closest('.sel-preview')) { if (UI.selCard) openInspect(byId[UI.selCard].img, inspectActionsFor(UI.selCard), byId[UI.selCard].name); return; }
      const b = e.target.closest('[data-act],[data-discard],[data-evo-from],[data-mega],[data-unpick]'); if (!b) return;
      if (b.dataset.act === 'confirm-take') doTake();
      else if (b.dataset.act === 'clear-take') { UI.pick = []; render(); }
      else if (b.dataset.unpick != null) { UI.pick.splice(+b.dataset.unpick, 1); render(); }
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
      if (mc && interactable()) { UI.selCard = mc.dataset.reserveCapture; UI.selDeck = null; UI.pick = []; render(); focusActionPanel(); return; }
      // any other captured/opponent card: tap to enlarge & read
      const z = e.target.closest('[data-zoom]');
      if (z && z.dataset.zoom) openInspect(z.dataset.zoom, '', z.getAttribute('aria-label') || '卡牌详情');
    });
    // Div-based board controls retain the card layout while remaining fully keyboard operable.
    document.addEventListener('keydown', (e) => {
      const dialog = $$('.modal:not(.hidden),#inspect:not(.hidden)').find(x => !x.classList.contains('hidden'));
      if (dialog && e.key === 'Tab') {
        const focusable = $$('button:not(:disabled),[href],input:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])', dialog).filter(x => x.offsetParent !== null);
        if (focusable.length) {
          const first = focusable[0], last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      const ctl = e.target.closest && e.target.closest('[role="button"]');
      if (ctl && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ctl.click(); return; }
      if (e.key === 'Escape') {
        if (!$('#inspect').classList.contains('hidden')) closeInspect();
        else if (!$('#rules-modal').classList.contains('hidden')) closeRules();
      }
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
    E, AI, byId, MEGA_DB, POKEMART_DB,
    get DB() { return DB; },
    get G() { return G; },
    get UI() { return UI; },
    render, enterGame, backToSetup, endTurn,
    setPhase(ph) { UI.phase = ph; },
  };
})();
