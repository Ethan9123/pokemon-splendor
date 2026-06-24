/* ===================== Pokémon Splendor — UI ===================== */
(function () {
  'use strict';
  const E = window.Engine, AI = window.AI, DB = window.CARD_DB;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const BALL_NAMES = { red: '精灵球', blue: '超级球', black: '高级球', pink: '治愈球', yellow: '先机球', purple: '大师球' };
  const TIER_NAMES = { legend: '传说', rare: '稀有', stage3: '三阶', stage2: '二阶', stage1: '一阶' };
  const SEAT_COLORS = ['#e3350d', '#2f6fd6', '#46d17a', '#f4c025'];
  const byId = {}; DB.forEach(c => byId[c.id] = c);

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
        `<div class="pid" style="background:${SEAT_COLORS[i]}">${i + 1}</div>
         <input type="text" value="训练家 ${i + 1}" maxlength="10" data-name="${i}">
         <select data-kind="${i}">
           <option value="human">真人</option>
           <option value="ai">电脑</option>
         </select>
         <select data-diff="${i}">
           <option value="hard">高手</option>
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

  function startGame() {
    const cfg = readConfig();
    G = E.createGame(DB, { numPlayers: cfg.numPlayers, names: cfg.names, ai: cfg.ai });
    gameEpoch++;                                        // invalidate any timers from a prior game
    G.players.forEach((p, i) => { p.diff = cfg.diff[i]; });
    if (cfg.diff.indexOf('alphazero') >= 0) loadPolicy();
    UI = { pick: [], selCard: null, selDeck: null, phase: 'main', busy: false, humans: cfg.ai.filter(x => !x).length, hasAI: cfg.ai.some(x => x) };
    undoStack = [];
    $('#setup').classList.add('hidden');
    $('#game').classList.remove('hidden');
    $('#win-modal').classList.add('hidden');
    render();
    beginTurn();
  }

  // ---------------------------------------------------------------- helpers
  const me = () => G.players[G.turn];
  const isHuman = (pid) => !G.players[pid].isAI;
  const ball = (color, cls, label) =>
    `<div class="ball ${color} ${cls || ''}" title="${BALL_NAMES[color]}">${label != null ? '' : ''}</div>`;

  function cardHTML(id, opts) {
    opts = opts || {};
    const c = byId[id];
    if (!c) return `<div class="card"><div class="empty-slot">—</div></div>`;
    const aff = opts.affordable ? ' affordable' : '';
    const sel = (UI.selCard === id) ? ' selected' : '';
    const reserveMini = opts.canReserve ? `<div class="reserve-mini" data-reserve-card="${id}">＋保留</div>` : '';
    return `<div class="card${aff}${sel}" data-card="${id}" data-zoom="${c.img}">
              <img src="${c.img}" alt="${c.name}" loading="lazy">${reserveMini}
            </div>`;
  }

  // ---------------------------------------------------------------- render
  function render() {
    renderBanner(); renderField(); renderSupply(); renderActionBar(); renderPlayers(); renderLog();
    updateUndoBtn();   // keep 悔棋 button consistent with phase/turn on every state change
  }

  function renderBanner() {
    const p = me();
    let txt;
    if (G.phase === 'gameover') txt = '游戏结束';
    else if (p.isAI) txt = `${p.name} 的回合 · <span class="thinking">思考中<span class="dot"></span><span class="dot"></span><span class="dot"></span></span>`;
    else txt = `${p.name} 的回合${G.lastRound ? ' · ⚠ 最后一轮' : ''}`;
    $('#turn-banner').innerHTML = txt;
  }

  function renderField() {
    const wrap = $('#field');
    wrap.innerHTML = '';
    const rows = [
      { tiers: ['legend', 'rare'], special: true },
      { tiers: ['stage3'] }, { tiers: ['stage2'] }, { tiers: ['stage1'] },
    ];
    const human = isHuman(G.turn) && G.phase === 'play';
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
          const affordable = human && UI.phase === 'main' && !G.acted && E.canAfford(G, me(), c);
          const canReserve = human && UI.phase === 'main' && !G.acted && E.NORMAL_TIERS.includes(tier) && me().reserve.length < E.HAND_MAX;
          inner += cardHTML(id, { affordable, canReserve });
        }
        inner += '</div>';
      }
      rowEl.innerHTML = inner;
      wrap.appendChild(rowEl);
    }
  }

  function renderSupply() {
    const counts = {}; UI.pick.forEach(c => counts[c] = (counts[c] || 0) + 1);
    const human = isHuman(G.turn) && G.phase === 'play' && UI.phase === 'main' && !G.acted;
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

    if (UI.phase === 'discard') {
      const over = E.tokenTotal(p) - E.TOKEN_MAX;
      let tray = E.ALL_TOKENS.filter(c => p.tokens[c] > 0)
        .map(c => `<div class="ball ${c}" data-discard="${c}" title="归还${BALL_NAMES[c]}" style="cursor:pointer">${''}</div>`).join('');
      bar.innerHTML = `<div class="act-hint">精灵球超过 10 个，请点击归还 <b>${over}</b> 个。</div><div class="tray">${tray}</div>`;
      return;
    }
    if (UI.phase === 'evolve') {
      const opts = dedupeEvo(E.evolutionOptions(G, p));
      let html = '<div class="act-hint">回合结束 · 可进化一只宝可梦（可选）：</div>';
      for (const o of opts) {
        const from = byId[o.fromId], to = byId[o.toId];
        html += `<button class="evo-option" data-evo-from="${o.fromId}" data-evo-to="${o.toId}">
                   <b>${from.name}</b> → <b>${to.name}</b>（+${to.vp - from.vp}分，花费 ${o.count} ${BALL_NAMES[o.color]}${o.payMaster ? '，含'+o.payMaster+'大师球' : ''}）
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
      const aff = E.canAfford(G, p, c);
      const loc = E.locateCard(G, UI.selCard);
      const canReserve = (loc.where === 'field') && E.NORMAL_TIERS.includes(loc.tier) && p.reserve.length < E.HAND_MAX;
      let html = `<div class="act-hint">已选：<b>${c.name}</b>（${TIER_NAMES[c.tier]}，${c.vp}分）${aff ? '' : ' · 精灵球不足'}</div><div class="act-buttons">`;
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
      const active = (i === G.turn && G.phase === 'play');
      const el = document.createElement('div');
      el.className = 'player' + (active ? ' active' : '') + (p.isAI ? ' ai' : '');
      // bonus + token chips
      let chips = '';
      for (const c of E.COLORS) {
        chips += `<div class="chip">${ball(c, 'sm')}<span class="num">${p.tokens[c]}</span><span class="bonus-n">+${b[c]}</span></div>`;
      }
      chips += `<div class="chip">${ball('purple', 'sm')}<span class="num">${p.tokens.purple}</span></div>`;
      // captured cards grouped by bonus color
      let stacks = '';
      for (const c of E.COLORS) {
        const cards = p.board.filter(id => byId[id].bonus === c);
        if (!cards.length) continue;
        let st = '';
        cards.forEach((id, idx) => {
          st += `<div class="mini-card${idx ? ' stacked' : ''}" data-zoom="${byId[id].img}"><img src="${byId[id].img}" alt=""></div>`;
        });
        stacks += `<div class="color-stack"><div class="ministack">${st}</div></div>`;
      }
      // reserve (revealed only for the active human; otherwise backs)
      const revealReserve = active && !p.isAI;
      let rz = '';
      if (p.reserve.length) {
        const cards = p.reserve.map(id => revealReserve
          ? `<div class="mini-card${UI.selCard === id ? ' selected' : ''}" data-zoom="${byId[id].img}" data-reserve-capture="${id}"><img src="${byId[id].img}"></div>`
          : `<div class="mini-card card-back"></div>`).join('');
        const hint = revealReserve ? '（点击可捕捉）' : '';
        rz = `<div class="reserve-zone"><div class="rz-title">保留区 (${p.reserve.length})${hint}</div><div class="pcards">${cards}</div></div>`;
      }
      el.innerHTML =
        `<div class="player-head">
           <div class="pavatar" style="background:${SEAT_COLORS[i]}"></div>
           <div class="pname">${p.name}</div>
           <div class="pscore">${E.scoreOf(G, p)}<small>/18</small></div>
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
    UI.selCard = id; UI.selDeck = null; renderField(); renderActionBar();
  }
  function onDeckClick(tier) {
    if (!interactable()) return;
    UI.selDeck = tier; UI.selCard = null; render();
  }
  function interactable() { return G && G.phase === 'play' && UI.phase === 'main' && !G.acted && !me().isAI && !UI.busy; }

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
  function flyCard(img, rect, dc) {
    const n = document.createElement('div'); n.className = 'fly fly-card';
    if (img) n.innerHTML = `<img src="${img}">`; else n.style.background = 'linear-gradient(135deg,#3a2a6e,#221a4a)';
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
      src.push({ rect: el ? el.getBoundingClientRect() : null, img: null });
    }
    return src;
  }
  function playGhosts(src, dec, pid) {
    const panel = $$('#players .player')[pid];
    if (!panel) return;
    panel.classList.add('receiving'); setTimeout(() => panel.classList.remove('receiving'), 520);
    const dc = centerOf(panel);
    if (dec.type === 'take') { for (const it of (src || [])) flyBall(it.color, it.rect, dc); }
    else if (dec.type === 'capture' || dec.type === 'reserve') { const it = (src || [])[0]; if (it) flyCard(it.img, it.rect, dc); }
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
    applyAnimated({ type: 'take', colors }, pid, () => { const r = E.actionTake(G, colors); if (r.ok) UI.pick = []; return r; }, afterMainAction);
  }
  function doCapture() {
    const cid = UI.selCard, pid = G.turn;
    applyAnimated({ type: 'capture', cardId: cid }, pid, () => { const r = E.actionCapture(G, cid); if (r.ok) UI.selCard = null; return r; }, afterMainAction);
  }
  function doReserveCard() {
    const cid = UI.selCard, pid = G.turn;
    applyAnimated({ type: 'reserve', cardId: cid }, pid, () => { const r = E.actionReserve(G, { fromField: cid }); if (r.ok) UI.selCard = null; return r; }, afterMainAction);
  }
  function doReserveDeck() {
    const tier = UI.selDeck, pid = G.turn;
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
    const show = UI.hasAI && G && G.phase === 'play' && UI.phase === 'main' && !me().isAI && !UI.busy && undoStack.length >= 2;
    btn.classList.toggle('hidden', !show);
  }
  function doDiscard(color) {
    if (UI.phase !== 'discard') return;
    E.actionDiscard(G, color);
    if (!E.needsDiscard(G, me())) toEvolveOrEnd();
    render();
  }
  function doEvolve(fromId, toId) {
    const r = E.actionEvolve(G, fromId, toId);
    if (!r.ok) { flashHint(r.error); return; }
    endTurn();
  }

  function afterMainAction() {
    UI.selCard = UI.selDeck = null; UI.pick = [];
    if (E.needsDiscard(G, me())) { UI.phase = 'discard'; render(); return; }
    toEvolveOrEnd();
  }
  function toEvolveOrEnd() {
    const opts = E.evolutionOptions(G, me());
    if (opts.length && !me().isAI) { UI.phase = 'evolve'; render(); return; }
    endTurn();
  }
  function endTurn() {
    const r = E.endTurn(G);
    UI.phase = 'main'; UI.pick = []; UI.selCard = UI.selDeck = null;
    if (G.phase === 'gameover') { render(); showWin(); return; }
    render();
    beginTurn();
  }

  // ---------------------------------------------------------------- turn control
  function beginTurn() {
    if (G.phase === 'gameover') { updateUndoBtn(); return; }
    const p = me();
    if (p.isAI) { render(); updateUndoBtn(); const e = gameEpoch; setTimeout(() => { if (e === gameEpoch) aiPlay(); }, 120); return; }
    if (UI.hasAI) pushUndo();                 // snapshot at each human turn start (undo target)
    // hotseat: hide previous player's hidden info before a human's turn
    if (UI.humans >= 2) { showPassOverlay(p); }
    else render();
    updateUndoBtn();
  }

  function showPassOverlay(p) {
    let ov = $('#pass-overlay');
    if (!ov) { ov = document.createElement('div'); ov.id = 'pass-overlay'; document.body.appendChild(ov); }
    ov.innerHTML = `<div class="po-inner"><div class="pavatar" style="margin:0 auto 14px;width:40px;height:40px"></div>
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
    const think = 1700 + Math.random() * 1500;        // ~1.7–3.2s, human-like pacing
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
      if (!applyFn) {                                  // heuristic (default seat, or AZ fallback)
        const plan = AI.chooseTurn(G, { difficulty: p.diff === 'alphazero' ? 'hard' : (p.diff || 'hard') });
        dec = decodePlan(plan);
        applyFn = () => {
          if (plan.action) E.applyAction(G, plan.action); else E.actionPass(G);
          for (const c of plan.discards) E.actionDiscard(G, c);
          if (plan.evolution) E.actionEvolve(G, plan.evolution.fromId, plan.evolution.toId);
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

  // ---------------------------------------------------------------- events
  function bind() {
    // setup
    $('#player-count').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      $$('#player-count button').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); buildSeats(+b.dataset.n);
    });
    $('#start-btn').addEventListener('click', startGame);
    $('#undo-btn').addEventListener('click', doUndo);
    $('#rules-btn').addEventListener('click', () => $('#rules-modal').classList.remove('hidden'));
    $('#rules-modal').addEventListener('click', (e) => { if (e.target.id === 'rules-modal' || e.target.classList.contains('close-rules')) $('#rules-modal').classList.add('hidden'); });
    $('#menu-btn').addEventListener('click', () => { if (confirm('返回主菜单？当前对局将丢失。')) { gameEpoch++; UI.busy = false; $('#game').classList.add('hidden'); $('#setup').classList.remove('hidden'); } });
    $('#play-again').addEventListener('click', () => { gameEpoch++; $('#win-modal').classList.add('hidden'); $('#game').classList.add('hidden'); $('#setup').classList.remove('hidden'); });

    // delegated game clicks
    $('#supply').addEventListener('click', (e) => { const r = e.target.closest('[data-color]'); if (r) onSupplyClick(r.dataset.color); });
    $('#field').addEventListener('click', (e) => {
      const rb = e.target.closest('[data-reserve-card]'); if (rb) { onCardClick(rb.dataset.reserveCard); doReserveCard(); return; }
      const dk = e.target.closest('[data-deck]'); if (dk) { onDeckClick(dk.dataset.deck); return; }
      const cd = e.target.closest('[data-card]'); if (cd) { onCardClick(cd.dataset.card); return; }
    });
    $('#action-bar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act],[data-discard],[data-evo-from]'); if (!b) return;
      if (b.dataset.act === 'confirm-take') doTake();
      else if (b.dataset.act === 'clear-take') { UI.pick = []; render(); }
      else if (b.dataset.act === 'clear-sel') { UI.selCard = UI.selDeck = null; render(); }
      else if (b.dataset.act === 'capture') doCapture();
      else if (b.dataset.act === 'reserve-card') doReserveCard();
      else if (b.dataset.act === 'reserve-deck') doReserveDeck();
      else if (b.dataset.act === 'end-turn') endTurn();
      else if (b.dataset.discard) doDiscard(b.dataset.discard);
      else if (b.dataset.evoFrom) doEvolve(b.dataset.evoFrom, b.dataset.evoTo);
    });
    // own-reserve capture: clicking a revealed reserve mini-card selects it
    $('#players').addEventListener('click', (e) => {
      const mc = e.target.closest('[data-reserve-capture]');
      if (mc && interactable()) { UI.selCard = mc.dataset.reserveCapture; UI.selDeck = null; UI.pick = []; render(); }
    });
  }

  buildSeats(2);
  bind();
  setupZoom();

  // lightweight debug hook (harmless in production): inspect/drive from console
  window.PSDebug = {
    get G() { return G; }, get UI() { return UI; }, E, AI, byId, render,
    afterMainAction, beginTurn, endTurn, showWin,
  };
})();
