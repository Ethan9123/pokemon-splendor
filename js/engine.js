/* =====================================================================
 * 璀璨宝石：宝可梦  —  Pokémon Splendor  game engine (pure logic, no DOM)
 * ---------------------------------------------------------------------
 * Faithful to the TTS mod "璀璨宝石：宝可梦（自动脚本）" + the rulebook:
 *   - 6 ball types: red(精灵球) blue(超级球) black(高级球) pink(治愈球)
 *     yellow(先机球) + purple(大师球, wild).  [internal color codes]
 *   - 3 normal stages + Rare + Legendary. Rare/Legendary need Master Balls
 *     and grant 2 bonus balls each.
 *   - Actions: take balls / reserve+master / capture.
 *   - Evolution at end of turn (not an action): bonuses count toward the
 *     evolution cost, you pay the remainder in balls, the old card goes
 *     "under the tile" (no longer scores or grants a bonus).
 *   - 18 VP triggers the final round; tiebreak = most cards under tile,
 *     then most Pokémon in play.
 *
 * Designed to run identically in the browser (window.Engine) and in Node
 * (module.exports) so it can be unit-tested headless.
 * ===================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Engine = api;
})(this, function () {
  'use strict';

  const COLORS = ['red', 'blue', 'black', 'pink', 'yellow']; // the 5 normal ball types
  const MASTER = 'purple';                                    // wild ball
  const ALL_TOKENS = COLORS.concat([MASTER]);
  const NORMAL_TIERS = ['stage1', 'stage2', 'stage3'];
  const FIELD_TIERS = ['stage1', 'stage2', 'stage3', 'rare', 'legend'];
  const FIELD_SLOTS = { stage1: 4, stage2: 4, stage3: 4, rare: 1, legend: 1 };
  const HAND_MAX = 3;
  const TOKEN_MAX = 10;
  const WIN_SCORE = 18;

  // ----- seedable RNG (mulberry32) so shuffles are reproducible -----
  function makeRng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  const emptyTokens = () => ({ red: 0, blue: 0, black: 0, pink: 0, yellow: 0, purple: 0 });
  const emptyColors = () => ({ red: 0, blue: 0, black: 0, pink: 0, yellow: 0 });

  function supplyFor(numPlayers) {
    const each = numPlayers <= 2 ? 4 : numPlayers === 3 ? 5 : 7;
    const s = emptyTokens();
    for (const c of COLORS) s[c] = each;
    s.purple = 5; // Master Balls always 5
    return s;
  }

  // -------------------------------------------------------------------
  // Card DB: array of card objects. Engine indexes them by id.
  //   { id, tier, name, vp, bonus, bonusCount, cost{6}, evolvesTo, evoCost }
  // -------------------------------------------------------------------
  function buildIndex(cardDB) {
    const byId = {};
    for (const c of cardDB) byId[c.id] = c;
    return byId;
  }

  // ---------------------------- setup --------------------------------
  function createGame(cardDB, opts) {
    opts = opts || {};
    const numPlayers = opts.numPlayers || 2;
    const seed = (opts.seed != null) ? opts.seed : Math.floor(Math.random() * 2 ** 31);
    const rng = makeRng(seed);
    const byId = buildIndex(cardDB);

    // decks per tier (ids), shuffled
    const decks = {};
    for (const tier of FIELD_TIERS) {
      decks[tier] = shuffle(cardDB.filter(c => c.tier === tier).map(c => c.id), rng);
    }
    const field = {};
    for (const tier of FIELD_TIERS) {
      field[tier] = [];
      for (let i = 0; i < FIELD_SLOTS[tier]; i++) {
        field[tier].push(decks[tier].length ? decks[tier].pop() : null);
      }
    }

    const players = [];
    for (let i = 0; i < numPlayers; i++) {
      players.push({
        id: i,
        name: (opts.names && opts.names[i]) || ('训练家 ' + (i + 1)),
        isAI: !!(opts.ai && opts.ai[i]),
        tokens: emptyTokens(),
        board: [],   // captured card ids currently in play (provide bonus + vp)
        buried: [],  // card ids under the tile (evolved away — no bonus/vp)
        reserve: [], // reserved card ids (in hand)
      });
    }

    return {
      seed,
      cardDB,
      byId,
      numPlayers,
      supply: supplyFor(numPlayers),
      decks,
      field,
      players,
      turn: 0,                 // index of active player
      round: 1,
      phase: 'play',           // 'play' | 'discard' | 'evolve' | 'gameover'
      lastRound: false,        // someone hit WIN_SCORE
      finalTurnOf: null,       // when lastRound, the player index that ends the game
      winner: null,
      log: [],
      // per-turn scratch
      acted: false,            // main action used this turn
      taken: [],               // colors taken this turn (for take-action validation)
      evolvedThisTurn: false,  // at most one evolution per turn
    };
  }

  // --------------------------- helpers -------------------------------
  function activePlayer(s) { return s.players[s.turn]; }

  function bonusOf(s, player, color) {
    let n = 0;
    for (const id of player.board) {
      const c = s.byId[id];
      if (c.bonus === color) n += (c.bonusCount || 1);
    }
    return n;
  }
  function bonuses(s, player) {
    const b = emptyColors();
    for (const id of player.board) {
      const c = s.byId[id];
      if (c.bonus) b[c.bonus] += (c.bonusCount || 1);
    }
    return b;
  }
  function tokenTotal(player) {
    return ALL_TOKENS.reduce((a, c) => a + player.tokens[c], 0);
  }
  function scoreOf(s, player) {
    let v = 0;
    for (const id of player.board) v += (s.byId[id].vp || 0);
    return v;
  }
  function locateCard(s, id) {
    // returns {where:'field'|'deck'|'reserve'|null, tier, slot, owner}
    for (const tier of FIELD_TIERS) {
      const slot = s.field[tier].indexOf(id);
      if (slot >= 0) return { where: 'field', tier, slot };
    }
    for (const p of s.players) {
      const ri = p.reserve.indexOf(id);
      if (ri >= 0) return { where: 'reserve', owner: p.id, slot: ri };
    }
    return { where: null };
  }
  function refill(s, tier) {
    const slots = s.field[tier];
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] == null && s.decks[tier].length) slots[i] = s.decks[tier].pop();
    }
  }
  function log(s, msg) { s.log.push({ turn: s.turn, round: s.round, msg }); }

  // ----------------------- payment computation -----------------------
  // Compute how to pay for a card given current bonuses & tokens.
  // Returns {ok, pay:{tokens spent}, error}. `pay` includes purple (master).
  function computePayment(s, player, card) {
    const b = bonuses(s, player);
    const pay = emptyTokens();
    let masterNeeded = card.cost.purple || 0; // mandatory master (rare/legend)
    if (masterNeeded > player.tokens.purple) return { ok: false, error: '大师球不足' };
    for (const c of COLORS) {
      const need = Math.max(0, (card.cost[c] || 0) - b[c]);
      const useGem = Math.min(need, player.tokens[c]);
      pay[c] = useGem;
      masterNeeded += (need - useGem);
    }
    if (masterNeeded > player.tokens.purple) return { ok: false, error: '精灵球不足（含大师球替代）' };
    pay.purple = masterNeeded;
    return { ok: true, pay };
  }
  function canAfford(s, player, card) { return computePayment(s, player, card).ok; }

  function payTokens(s, player, pay) {
    for (const c of ALL_TOKENS) {
      player.tokens[c] -= pay[c];
      s.supply[c] += pay[c];
    }
  }

  // --------------------------- actions -------------------------------
  // Each action returns {ok:true} or {ok:false, error}. On success the
  // main action is consumed (acted=true) and the turn auto-advances to the
  // evolve/discard check unless more sub-steps are required.

  function actionTake(s, colors) {
    const p = activePlayer(s);
    if (s.acted) return { ok: false, error: '本回合已行动' };
    if (!Array.isArray(colors) || colors.length === 0) return { ok: false, error: '未选择精灵球' };
    for (const c of colors) {
      if (!COLORS.includes(c)) return { ok: false, error: '不能拿取大师球' };
    }
    const uniq = new Set(colors);
    let mode;
    if (colors.length === 2 && uniq.size === 1) {
      mode = 'double';
      const c = colors[0];
      if (s.supply[c] < 4) return { ok: false, error: '该颜色少于4个，不能拿两个' };
    } else if (uniq.size === colors.length && colors.length <= 3) {
      mode = 'distinct';
    } else {
      return { ok: false, error: '只能拿3种不同 或 2个同色' };
    }
    for (const c of uniq) if (s.supply[c] < (mode === 'double' ? 2 : 1)) return { ok: false, error: '供应不足' };
    // apply
    for (const c of colors) { s.supply[c]--; p.tokens[c]++; }
    s.acted = true;
    s.taken = colors.slice();
    log(s, `${p.name} 拿取 ${colors.map(zhBall).join('、')}`);
    return { ok: true };
  }

  function actionReserve(s, target) {
    // target: {fromField:id} or {fromDeck:tier}
    const p = activePlayer(s);
    if (s.acted) return { ok: false, error: '本回合已行动' };
    if (p.reserve.length >= HAND_MAX) return { ok: false, error: '保留区已满（最多3张）' };
    let cardId = null, tier = null, slot = -1, fromDeck = false;
    if (target.fromDeck) {
      tier = target.fromDeck;
      if (!NORMAL_TIERS.includes(tier)) return { ok: false, error: '稀有/传说不可保留' };
      if (!s.decks[tier].length) return { ok: false, error: '牌堆已空' };
      cardId = s.decks[tier].pop(); fromDeck = true;
    } else {
      cardId = target.fromField;
      const loc = locateCard(s, cardId);
      if (loc.where !== 'field') return { ok: false, error: '该卡不在场上' };
      if (!NORMAL_TIERS.includes(loc.tier)) return { ok: false, error: '稀有/传说不可保留' };
      tier = loc.tier; slot = loc.slot;
    }
    p.reserve.push(cardId);
    if (!fromDeck) { s.field[tier][slot] = null; refill(s, tier); }
    // gain a master ball if available
    let got = '';
    if (s.supply.purple > 0) { s.supply.purple--; p.tokens.purple++; got = ' 并获得1个大师球'; }
    s.acted = true;
    log(s, `${p.name} 保留了一张${zhTier(tier)}宝可梦${fromDeck ? '（牌堆顶）' : ''}${got}`);
    return { ok: true, cardId };
  }

  function actionCapture(s, cardId) {
    const p = activePlayer(s);
    if (s.acted) return { ok: false, error: '本回合已行动' };
    const card = s.byId[cardId];
    if (!card) return { ok: false, error: '无此卡' };
    const loc = locateCard(s, cardId);
    const fromReserve = loc.where === 'reserve' && loc.owner === p.id;
    if (loc.where !== 'field' && !fromReserve) return { ok: false, error: '只能捕捉场上或自己保留区的宝可梦' };
    const payment = computePayment(s, p, card);
    if (!payment.ok) return { ok: false, error: payment.error };
    payTokens(s, p, payment.pay);
    if (fromReserve) p.reserve.splice(loc.slot, 1);
    else { s.field[loc.tier][loc.slot] = null; refill(s, loc.tier); }
    p.board.push(cardId);
    s.acted = true;
    log(s, `${p.name} 捕捉了 ${card.name}（${payDesc(payment.pay)}）`);
    return { ok: true };
  }

  // ----------------------- evolution (end of turn) -------------------
  // List the legal evolutions available right now for the active player.
  // Evolution is by SPECIES: a caught Pokémon evolves into ANY available
  // card of its next-form species (on the field or in the player's hand).
  function evolutionOptions(s, player) {
    const opts = [];
    if (s.evolvedThisTurn) return opts; // only one evolution per turn
    const b = bonuses(s, player);
    // available evolution targets: field cards + this player's reserve
    const avail = [];
    for (const tier of FIELD_TIERS) s.field[tier].forEach((id, slot) => { if (id) avail.push({ id, where: 'field', tier, slot }); });
    player.reserve.forEach((id, slot) => avail.push({ id, where: 'reserve', slot }));
    for (const id of player.board) {
      const c = s.byId[id];
      if (!c.evolvesTo || !c.evoCost) continue;
      // affordability: bonuses reduce; pay remainder in balls (master substitutes)
      const need = Math.max(0, c.evoCost.count - b[c.evoCost.color]);
      const haveColor = player.tokens[c.evoCost.color];
      const masterShort = Math.max(0, need - haveColor);
      if (masterShort > player.tokens.purple) continue;
      for (const a of avail) {
        if (s.byId[a.id].name !== c.evolvesTo) continue;
        opts.push({
          fromId: id, toId: a.id,
          color: c.evoCost.color, count: c.evoCost.count,
          payColor: Math.min(need, haveColor), payMaster: masterShort,
          targetWhere: a.where,
        });
      }
    }
    return opts;
  }

  function actionEvolve(s, fromId, toId) {
    const p = activePlayer(s);
    if (s.evolvedThisTurn) return { ok: false, error: '本回合已进化过' };
    const cands = evolutionOptions(s, p).filter(o => o.fromId === fromId);
    const opt = (toId != null) ? cands.find(o => o.toId === toId) : cands[0];
    if (!opt) return { ok: false, error: '不满足进化条件' };
    // pay
    p.tokens[opt.color] -= opt.payColor; s.supply[opt.color] += opt.payColor;
    p.tokens.purple -= opt.payMaster; s.supply.purple += opt.payMaster;
    // move target out of field/reserve
    const loc = locateCard(s, opt.toId);
    if (loc.where === 'field') { s.field[loc.tier][loc.slot] = null; refill(s, loc.tier); }
    else if (loc.where === 'reserve') { s.players[loc.owner].reserve.splice(loc.slot, 1); }
    // replace on board: remove fromId -> buried; add toId
    const bi = p.board.indexOf(fromId);
    p.board.splice(bi, 1);
    p.buried.push(fromId);
    p.board.push(opt.toId);
    s.evolvedThisTurn = true;
    log(s, `${p.name} 将 ${s.byId[fromId].name} 进化为 ${s.byId[opt.toId].name}`);
    return { ok: true, fromId, toId: opt.toId };
  }

  // --------------------------- discard -------------------------------
  function needsDiscard(s, player) { return tokenTotal(player) > TOKEN_MAX; }
  function actionDiscard(s, color) {
    const p = activePlayer(s);
    if (!p.tokens[color]) return { ok: false, error: '没有该精灵球' };
    p.tokens[color]--; s.supply[color]++;
    log(s, `${p.name} 归还了1个${zhBall(color)}`);
    return { ok: true };
  }

  // A legitimate pass: only allowed when the player genuinely has no legal
  // main action (e.g. supply drained, nothing affordable, hand full).
  function actionPass(s) {
    if (s.acted) return { ok: false, error: '本回合已行动' };
    if (legalActions(s).length) return { ok: false, error: '尚有可执行的行动' };
    s.acted = true;
    log(s, `${activePlayer(s).name} 无法行动，跳过回合`);
    return { ok: true };
  }

  // --------------------------- turn flow -----------------------------
  // Call after the main action. Resolves discard requirement and lets the
  // caller present evolution options; then endTurn() advances.
  function turnState(s) {
    const p = activePlayer(s);
    return {
      acted: s.acted,
      mustDiscard: needsDiscard(s, p) ? (tokenTotal(p) - TOKEN_MAX) : 0,
      evolutions: evolutionOptions(s, p),
    };
  }

  function endTurn(s) {
    const p = activePlayer(s);
    if (!s.acted) return { ok: false, error: '尚未行动' };
    if (needsDiscard(s, p)) return { ok: false, error: '请先归还多余精灵球（上限10）' };
    // check win trigger (someone reached the target this turn)
    if (scoreOf(s, p) >= WIN_SCORE && !s.lastRound) {
      s.lastRound = true;
      log(s, `${p.name} 达到 ${WIN_SCORE} 分，进入最后一轮！`);
    }
    // The game ends once the LAST player of the round finishes during the
    // final round, so every Trainer has taken an equal number of turns.
    const wasLastPlayer = s.turn === s.numPlayers - 1;
    if (s.lastRound && wasLastPlayer) {
      s.phase = 'gameover';
      s.winner = determineWinner(s);
      log(s, `游戏结束，胜者：${s.players[s.winner].name}`);
      return { ok: true, gameover: true };
    }
    s.turn = (s.turn + 1) % s.numPlayers;
    if (wasLastPlayer) s.round++;
    s.acted = false; s.taken = []; s.evolvedThisTurn = false;
    return { ok: true };
  }

  function determineWinner(s) {
    // most VP, then most buried (evolutions), then most board cards
    let best = 0;
    const rank = (p) => [scoreOf(s, p), p.buried.length, p.board.length];
    for (let i = 1; i < s.numPlayers; i++) {
      const a = rank(s.players[i]), b = rank(s.players[best]);
      if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) best = i;
    }
    return best;
  }

  // ------------------- legal move enumeration (for AI) ---------------
  function legalActions(s) {
    const p = activePlayer(s);
    if (s.acted || s.phase !== 'play') return [];
    const acts = [];
    // takes
    const avail = COLORS.filter(c => s.supply[c] > 0);
    // 3 distinct
    for (let i = 0; i < avail.length; i++)
      for (let j = i + 1; j < avail.length; j++)
        for (let k = j + 1; k < avail.length; k++)
          acts.push({ type: 'take', colors: [avail[i], avail[j], avail[k]] });
    // fewer-than-3 distinct only if <3 colors available
    if (avail.length === 2) acts.push({ type: 'take', colors: [avail[0], avail[1]] });
    if (avail.length === 1) acts.push({ type: 'take', colors: [avail[0]] });
    // 2 same
    for (const c of COLORS) if (s.supply[c] >= 4) acts.push({ type: 'take', colors: [c, c] });
    // captures (field + own reserve)
    const capIds = [];
    for (const tier of FIELD_TIERS) for (const id of s.field[tier]) if (id) capIds.push(id);
    for (const id of p.reserve) capIds.push(id);
    for (const id of capIds) if (canAfford(s, p, s.byId[id])) acts.push({ type: 'capture', cardId: id });
    // reserves
    if (p.reserve.length < HAND_MAX) {
      for (const tier of NORMAL_TIERS) {
        for (const id of s.field[tier]) if (id) acts.push({ type: 'reserve', target: { fromField: id } });
        if (s.decks[tier].length) acts.push({ type: 'reserve', target: { fromDeck: tier } });
      }
    }
    return acts;
  }

  function applyAction(s, a) {
    if (a.type === 'take') return actionTake(s, a.colors);
    if (a.type === 'capture') return actionCapture(s, a.cardId);
    if (a.type === 'reserve') return actionReserve(s, a.target);
    return { ok: false, error: '未知行动' };
  }

  // --------------------------- i18n bits -----------------------------
  const BALL_ZH = { red: '精灵球', blue: '超级球', black: '高级球', pink: '治愈球', yellow: '先机球', purple: '大师球' };
  const TIER_ZH = { stage1: '一阶', stage2: '二阶', stage3: '三阶', rare: '稀有', legend: '传说' };
  function zhBall(c) { return BALL_ZH[c] || c; }
  function zhTier(t) { return TIER_ZH[t] || t; }
  function payDesc(pay) {
    const parts = ALL_TOKENS.filter(c => pay[c] > 0).map(c => `${pay[c]}${zhBall(c)}`);
    return parts.length ? parts.join('+') : '免费';
  }

  // ----- deep clone for AI search -----
  function clone(s) {
    const c = JSON.parse(JSON.stringify({
      seed: s.seed, numPlayers: s.numPlayers, supply: s.supply, decks: s.decks,
      field: s.field, players: s.players, turn: s.turn, round: s.round,
      phase: s.phase, lastRound: s.lastRound,
      winner: s.winner, acted: s.acted, taken: s.taken, evolvedThisTurn: s.evolvedThisTurn,
    }));
    c.cardDB = s.cardDB; c.byId = s.byId; c.log = []; // share static refs, drop log
    return c;
  }

  return {
    COLORS, MASTER, ALL_TOKENS, NORMAL_TIERS, FIELD_TIERS, FIELD_SLOTS,
    HAND_MAX, TOKEN_MAX, WIN_SCORE,
    makeRng, shuffle, supplyFor,
    createGame, activePlayer, bonusOf, bonuses, tokenTotal, scoreOf, locateCard, refill,
    computePayment, canAfford,
    actionTake, actionReserve, actionCapture, actionEvolve, actionDiscard, actionPass,
    evolutionOptions, needsDiscard, turnState, endTurn, determineWinner,
    legalActions, applyAction, clone,
    zhBall, zhTier, payDesc,
  };
});
