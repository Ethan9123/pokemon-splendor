/* =====================================================================
 * 璀璨宝石：宝可梦  —  Pokémon Splendor  game engine (pure logic, no DOM)
 * ---------------------------------------------------------------------
 * Faithful to the TTS mod "璀璨宝石：宝可梦（自动脚本）" + the rulebook:
 *   - 6 ball types: red(精灵球) blue(超级球) black(高级球) pink(治愈球)
 *     yellow(先机球) + purple(大师球, wild).  [internal color codes]
 *   - 3 normal stages + Rare + Legendary. Rare/Legendary need Master Balls
 *     and grant 2 bonus balls each.
 *   - Actions: take balls / reserve+master / capture.
 *   - Evolution at end of turn (not an action): paid ONLY by the discount
 *     balls on your captured cards (bonuses) — never by held tokens; you must
 *     already own enough discounts of the required color. The old card goes
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
  const SPECIAL_TIERS = ['rare', 'legend'];
  const SPECIAL_DECK_SIZE = 5; // 神兽/幻兽: only 5 of the 10-card pool play per game (1 revealed + 4 in deck)
  // --- Pokémart expansion (opt-in via opts.pokemart + opts.pokemartDB) ---
  // 3 extra decks (one per base level); each shows 2 face-up cards to the right
  // of its level row. Cards capture/reserve like base cards (special effects are
  // resolved separately). Empty/absent when the expansion is off.
  const PM_TIERS = ['pmL1', 'pmL2', 'pmL3'];
  const PM_SLOTS = 2;
  const PM_BASE_TIER = { pmL1: 'stage1', pmL2: 'stage2', pmL3: 'stage3' }; // reserve eligibility mirrors its level
  // Pokémart effects whose engine logic is live. Capturing a Pokémart card whose
  // effect is not yet implemented is rejected (so gameplay never silently misfires).
  // double  : POTION — 2 bonuses (bonusCount already drives bonuses()).
  // copy    : EVOLVE STONE — on capture, associate with an owned card's bonus.
  // colorless_master : POKÉDEX — no bonus; later discardable as 2 virtual master balls.
  // discard_buy : REPEL — no token cost; discard 2 owned cards of a color instead.
  // free    : TM — on capture, immediately take a free face-up Level-2 card.
  // copy_free : RARE CANDY — associate (like copy) + take a free Level-1 card.
  const PM_EFFECTS_LIVE = { double: true, copy: true, colorless_master: true, discard_buy: true, free: true, copy_free: true };
  // Canonical color-balanced sets (one bonus colour each), matching the classic
  // 神兽/稀有 used in the strategy guides. Every game has exactly one rare & one
  // legend per colour (red/black/yellow/blue/pink), each granting 2 same-colour bonuses.
  const CANON_SPECIAL = {
    rare: ['rr_06', 'rr_07', 'rr_08', 'rr_09', 'rr_10'],   // 拉普拉斯红/伊布黑/卡比兽粉/百变怪蓝/化石翼龙黄
    legend: ['lg_06', 'lg_07', 'lg_08', 'lg_09', 'lg_10'], // 火焰鸟粉/超梦黑/梦幻蓝/急冻鸟黄/闪电鸟红
  };
  const HAND_MAX = 3;
  const TOKEN_MAX = 10;
  const WIN_SCORE = 18;
  // --- Megas expansion (opt-in via opts.megas + opts.megaDB) ---
  const MEGA_TOKENS = 4;          // shared pool of "Mega" tokens
  const MEGA_WIN_SCORE = 20;      // with Megas: need 20 VP + 1 of each color + 1 Mega

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

  // Field tiers actually in play for this state (base tiers + Pokémart when on).
  function fieldTiers(s) { return s.pokemartEnabled ? FIELD_TIERS.concat(PM_TIERS) : FIELD_TIERS; }
  function slotCount(tier) { return FIELD_SLOTS[tier] != null ? FIELD_SLOTS[tier] : PM_SLOTS; }
  function isPokemart(card) { return !!card && PM_TIERS.indexOf(card.tier) >= 0; }

  // ---------------------------- setup --------------------------------
  function createGame(cardDB, opts) {
    opts = opts || {};
    const numPlayers = opts.numPlayers || 2;
    const seed = (opts.seed != null) ? opts.seed : Math.floor(Math.random() * 2 ** 31);
    const winScore = (opts.winScore != null) ? opts.winScore : WIN_SCORE; // tutorial may lower this
    const rng = makeRng(seed);
    const byId = buildIndex(cardDB);

    // Optional Megas expansion: index mega cards; they form a face-up "mega offer".
    const megasEnabled = !!(opts.megas && opts.megaDB && opts.megaDB.length);
    if (megasEnabled) for (const c of opts.megaDB) byId[c.id] = c;

    // Optional Pokémart expansion: index its cards; they get their own per-level decks.
    const pokemartEnabled = !!(opts.pokemart && opts.pokemartDB && opts.pokemartDB.length);
    if (pokemartEnabled) for (const c of opts.pokemartDB) byId[c.id] = c;

    // decks per tier (ids), shuffled
    const decks = {};
    for (const tier of FIELD_TIERS) {
      decks[tier] = shuffle(cardDB.filter(c => c.tier === tier).map(c => c.id), rng);
    }
    if (pokemartEnabled) {
      for (const tier of PM_TIERS) {
        decks[tier] = shuffle(opts.pokemartDB.filter(c => c.tier === tier).map(c => c.id), rng);
      }
    }
    // 神兽/幻兽: use the canonical colour-balanced 5 per tier (1 revealed + 4 in deck),
    // keeping the shuffled order so which one is revealed first still varies.
    for (const tier of SPECIAL_TIERS) {
      const set = (opts.specialSets && opts.specialSets[tier]) || CANON_SPECIAL[tier];
      decks[tier] = decks[tier].filter(id => set.indexOf(id) >= 0);
    }
    const allFieldTiers = pokemartEnabled ? FIELD_TIERS.concat(PM_TIERS) : FIELD_TIERS;
    const field = {};
    for (const tier of allFieldTiers) {
      field[tier] = [];
      for (let i = 0; i < slotCount(tier); i++) {
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
        megaToken: 0, // Megas expansion: 0 or 1 held Mega token
        board: [],   // captured card ids currently in play (provide bonus + vp)
        buried: [],  // card ids under the tile (evolved away — no bonus/vp)
        reserve: [], // reserved card ids (in hand)
        assoc: {},   // Pokémart copy cards: cardId -> associated bonus colour
      });
    }

    const supply = supplyFor(numPlayers);
    if (megasEnabled) supply.megaToken = MEGA_TOKENS;

    return {
      seed,
      winScore,
      cardDB,
      byId,
      numPlayers,
      supply,
      decks,
      field,
      players,
      // Megas expansion state (empty/false when the expansion is off)
      megasEnabled,
      megaDB: megasEnabled ? opts.megaDB : [],
      megaOffer: megasEnabled ? opts.megaDB.map(c => c.id) : [], // the 10 unique megas, removed when taken
      // Pokémart expansion state (empty/false when off). Its face-up cards live in
      // field.pmL1/pmL2/pmL3 (2 each) and use the normal capture/reserve/refill path.
      pokemartEnabled,
      pokemartDB: pokemartEnabled ? opts.pokemartDB : [],
      turn: 0,                 // index of active player
      round: 1,
      phase: 'play',           // 'play' | 'discard' | 'evolve' | 'gameover'
      lastRound: false,        // someone hit the win trigger
      finalTurnOf: null,       // when lastRound, the player index that ends the game
      winner: null,
      log: [],
      // per-turn scratch
      acted: false,            // main action used this turn
      taken: [],               // colors taken this turn (for take-action validation)
      evolvedThisTurn: false,  // at most one (mega-)evolution per turn
    };
  }

  // --------------------------- helpers -------------------------------
  function activePlayer(s) { return s.players[s.turn]; }

  // A card's effective bonus colour for this player. Pokémart "copy" cards
  // (EVOLVE STONE / RARE CANDY) take the colour of the card they were associated
  // with at capture time (stored in player.assoc); cards with no real colour
  // (e.g. POKÉDEX, or an unassociated copy card) contribute nothing.
  function effBonusColor(s, player, id) {
    const assoc = player.assoc && player.assoc[id];
    const col = assoc || s.byId[id].bonus;
    return COLORS.indexOf(col) >= 0 ? col : null;
  }
  function bonusOf(s, player, color) {
    let n = 0;
    for (const id of player.board) {
      if (effBonusColor(s, player, id) === color) n += (s.byId[id].bonusCount || 1);
    }
    return n;
  }
  function bonuses(s, player) {
    const b = emptyColors();
    for (const id of player.board) {
      const col = effBonusColor(s, player, id);
      if (col) b[col] += (s.byId[id].bonusCount || 1);
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
    for (const tier of fieldTiers(s)) {
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
  function log(s, msg) {
    s.log.push({ turn: s.turn, round: s.round, msg });
    if (s.log.length > 200) s.log.splice(0, s.log.length - 200); // bound growth (persisted + broadcast online)
  }

  // ----------------------- payment computation -----------------------
  // Compute how to pay for a card given current bonuses & tokens.
  // Returns {ok, pay:{tokens spent}, error}. `pay` includes purple (master).
  function computePayment(s, player, card, extraMaster) {
    extraMaster = extraMaster || 0; // virtual master balls from discarded POKÉDEX cards
    const b = bonuses(s, player);
    const pay = emptyTokens();
    const purpleBudget = player.tokens.purple + extraMaster;
    let masterNeeded = card.cost.purple || 0; // mandatory master (rare/legend)
    if (masterNeeded > purpleBudget) return { ok: false, error: '大师球不足' };
    for (const c of COLORS) {
      const need = Math.max(0, (card.cost[c] || 0) - b[c]);
      const useGem = Math.min(need, player.tokens[c]);
      pay[c] = useGem;
      masterNeeded += (need - useGem);
    }
    if (masterNeeded > purpleBudget) return { ok: false, error: '精灵球不足（含大师球替代）' };
    // Spend the virtual (POKÉDEX) masters first; any leftover virtual is wasted.
    pay.purple = Math.max(0, masterNeeded - extraMaster);
    return { ok: true, pay, virtualMaster: masterNeeded - pay.purple };
  }
  function canAfford(s, player, card) { return computePayment(s, player, card).ok; }

  // Per-colour breakdown of a purchase, purely for display. Mirrors
  // computePayment's gold-minimising logic so the UI can show, for each colour:
  //   required     = balls printed on the card cost
  //   bonusCovered = covered for free by permanent bonuses (no token spent)
  //   paidColor    = matching coloured tokens you hand back to the supply
  //   paidWild     = covered by Master Balls (wildcard) because that colour ran short
  // Plus the card's mandatory Master cost (rare/legend). Returns null if unaffordable.
  function paymentBreakdown(s, player, card, extraMaster) {
    const cp = computePayment(s, player, card, extraMaster);
    if (!cp.ok) return null;
    const b = bonuses(s, player);
    const rows = [];
    for (const c of COLORS) {
      const required = card.cost[c] || 0;
      if (required === 0) continue;
      const bonusCovered = Math.min(required, b[c]);
      const remaining = required - bonusCovered;
      const paidColor = Math.min(remaining, player.tokens[c]);
      rows.push({ color: c, required, bonusCovered, paidColor, paidWild: remaining - paidColor });
    }
    const mandatoryMaster = card.cost.purple || 0; // purple pips printed on rare/legend
    return {
      rows,
      mandatoryMaster,
      master: cp.pay.purple,                // real Master Balls spent from your stash
      virtualMaster: cp.virtualMaster || 0, // Master "balls worth" from discarded POKÉDEX
    };
  }

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
    if (colors.length > 6) return { ok: false, error: '非法的拿取' }; // bound input before allocating a Set
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
      // Official rule: take 3 tokens of different types. Only when fewer than 3
      // colors remain available in the supply may you take fewer (2, or even 1).
      const availDistinct = COLORS.filter(col => s.supply[col] > 0).length;
      if (availDistinct >= 3 && colors.length !== 3) {
        return { ok: false, error: '必须拿取3种不同颜色的精灵球' };
      }
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
    const reservable = (t) => NORMAL_TIERS.includes(t) || (s.pokemartEnabled && PM_TIERS.includes(t));
    if (target.fromDeck) {
      tier = target.fromDeck;
      if (!reservable(tier)) return { ok: false, error: '稀有/传说不可保留' };
      if (!s.decks[tier].length) return { ok: false, error: '牌堆已空' };
      cardId = s.decks[tier].pop(); fromDeck = true;
    } else {
      cardId = target.fromField;
      const loc = locateCard(s, cardId);
      if (loc.where !== 'field') return { ok: false, error: '该卡不在场上' };
      if (!reservable(loc.tier)) return { ok: false, error: '稀有/传说不可保留' };
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

  // remove a just-captured card from wherever it sat (field or own reserve)
  function takeFromSource(s, p, loc, fromReserve, cardId) {
    if (fromReserve) { const i = p.reserve.indexOf(cardId); if (i >= 0) p.reserve.splice(i, 1); }
    else { s.field[loc.tier][loc.slot] = null; refill(s, loc.tier); }
  }
  // remove a board card out of the game (Pokémart "discard … returned to the box")
  function discardFromBoard(s, p, id) {
    const i = p.board.indexOf(id);
    if (i >= 0) p.board.splice(i, 1);
    if (p.assoc) delete p.assoc[id];
  }
  // EVOLVE STONE / RARE CANDY: pick an owned card with a real bonus to copy.
  function resolveCopyTarget(s, p, targetId) {
    const cands = p.board.filter(id => effBonusColor(s, p, id));
    if (!cands.length) return { ok: false, error: '进化石需要你已有一张带奖励的卡' };
    if (targetId == null) targetId = cands[0];
    if (cands.indexOf(targetId) < 0) return { ok: false, error: '关联目标必须是你已有的带奖励的卡' };
    return { ok: true, color: effBonusColor(s, p, targetId) };
  }
  // REPEL: choose `discardCount` owned cards of `discardColor` to discard.
  function resolveDiscardBuy(s, p, card, chosen) {
    const color = card.effectParam.discardColor, need = card.effectParam.discardCount;
    const owned = p.board.filter(id => effBonusColor(s, p, id) === color);
    if (owned.length < need) return { ok: false, error: `需要弃掉${need}张${zhBall(color)}卡，但你只有${owned.length}张` };
    let discarded;
    if (chosen && chosen.length) {
      if (chosen.length !== need) return { ok: false, error: `必须弃掉${need}张` };
      for (const id of chosen) if (owned.indexOf(id) < 0) return { ok: false, error: '所选弃牌颜色不符或不属于你' };
      discarded = chosen.slice();
    } else {
      discarded = owned.slice(0, need);
    }
    return { ok: true, discarded };
  }

  // "Take a free card" effects (TM / RARE CANDY). The free card comes from the
  // level below: RARE CANDY (pmL2) -> Level 1 (stage1/pmL1); TM (pmL3) -> Level 2.
  function freeTiers(parentCard) {
    if (parentCard.tier === 'pmL2') return ['stage1', 'pmL1'];
    if (parentCard.tier === 'pmL3') return ['stage2', 'pmL2'];
    return [];
  }
  // Is `fc` a free card the player could legally take right now (effect live + any
  // required sub-choice is satisfiable)? Used to decide if the take is mandatory.
  function freeTakeable(s, p, fc) {
    if (isPokemart(fc) && fc.effect && !PM_EFFECTS_LIVE[fc.effect]) return false;
    if (isPokemart(fc) && (fc.effect === 'copy' || fc.effect === 'copy_free'))
      return p.board.some(b => effBonusColor(s, p, b)); // needs a bonus card to copy
    return true;
  }
  // Validate (no mutation) the chain of free takes; returns {ok, steps:[{freeId,assoc}]}.
  function planFree(s, p, parentCard, opts, depth, seen) {
    depth = depth || 0; seen = seen || {};
    if (depth > 4) return { ok: false, error: '免费取卡层级过深' };
    const tiers = freeTiers(parentCard);
    const freeId = opts.freeTakeId;
    if (freeId == null) {
      let any = false;
      for (const t of tiers) for (const id of (s.field[t] || [])) if (id && freeTakeable(s, p, s.byId[id])) any = true;
      return any ? { ok: false, error: '请选择要免费获得的卡（freeTakeId）' } : { ok: true, steps: [] };
    }
    if (seen[freeId]) return { ok: false, error: '免费取卡重复' };
    const loc = locateCard(s, freeId);
    if (loc.where !== 'field' || tiers.indexOf(loc.tier) < 0) return { ok: false, error: '免费卡必须是可选等级中的面朝上卡' };
    const fc = s.byId[freeId];
    if (isPokemart(fc) && fc.effect && !PM_EFFECTS_LIVE[fc.effect]) return { ok: false, error: `免费卡「${fc.name}」效果待实现` };
    const sub = opts.freeOpts || {};
    let assoc = null;
    if (isPokemart(fc) && (fc.effect === 'copy' || fc.effect === 'copy_free')) {
      const r = resolveCopyTarget(s, p, sub.copyTargetId); if (!r.ok) return r; assoc = r.color;
    }
    let steps = [{ freeId, assoc }];
    if (isPokemart(fc) && (fc.effect === 'free' || fc.effect === 'copy_free')) {
      const ns = Object.assign({}, seen); ns[freeId] = true;
      const rec = planFree(s, p, fc, sub, depth + 1, ns);
      if (!rec.ok) return rec;
      steps = steps.concat(rec.steps);
    }
    return { ok: true, steps };
  }
  function execFree(s, p, steps) {
    for (const st of steps) {
      const loc = locateCard(s, st.freeId);
      if (loc.where === 'field') { s.field[loc.tier][loc.slot] = null; refill(s, loc.tier); }
      p.board.push(st.freeId);
      if (st.assoc) { p.assoc = p.assoc || {}; p.assoc[st.freeId] = st.assoc; }
      log(s, `${p.name} 免费获得 ${s.byId[st.freeId].name}${st.assoc ? `（关联${zhBall(st.assoc)}）` : ''}`);
    }
  }

  // opts (all optional, used by Pokémart effects):
  //   copyTargetId  — board card id to copy a bonus from (EVOLVE STONE / RARE CANDY)
  //   spendPokedex  — board POKÉDEX ids to discard, each worth 2 virtual master balls
  //   discardCards  — board card ids to discard to pay for a REPEL (discard_buy)
  //   freeTakeId + freeOpts — the free card to take (TM / RARE CANDY), and its own choices
  function actionCapture(s, cardId, opts) {
    opts = opts || {};
    const p = activePlayer(s);
    if (s.acted) return { ok: false, error: '本回合已行动' };
    const card = s.byId[cardId];
    if (!card) return { ok: false, error: '无此卡' };
    if (isPokemart(card) && card.effect && !PM_EFFECTS_LIVE[card.effect]) {
      return { ok: false, error: `Pokémart「${card.name}」效果待实现（后续阶段）` };
    }
    const loc = locateCard(s, cardId);
    const fromReserve = loc.where === 'reserve' && loc.owner === p.id;
    if (loc.where !== 'field' && !fromReserve) return { ok: false, error: '只能捕捉场上或自己保留区的宝可梦' };

    // --- REPEL (discard_buy): no token cost; discard owned cards of a colour ---
    if (isPokemart(card) && card.effect === 'discard_buy') {
      const r = resolveDiscardBuy(s, p, card, opts.discardCards);
      if (!r.ok) return r;
      takeFromSource(s, p, loc, fromReserve, cardId);
      for (const did of r.discarded) discardFromBoard(s, p, did);
      p.board.push(cardId);
      s.acted = true;
      log(s, `${p.name} 用${card.name}获得（弃掉${r.discarded.length}张${zhBall(card.effectParam.discardColor)}卡）`);
      return { ok: true };
    }

    // --- optional: discard POKÉDEX cards as 2 virtual master balls each ---
    const spend = Array.isArray(opts.spendPokedex) ? opts.spendPokedex : []; // never iterate a non-array
    for (const pid of spend) {
      const pc = s.byId[pid];
      if (p.board.indexOf(pid) < 0 || !(isPokemart(pc) && pc.effect === 'colorless_master')) {
        return { ok: false, error: '无效的图鉴消耗' };
      }
    }
    const payment = computePayment(s, p, card, spend.length * 2);
    if (!payment.ok) return { ok: false, error: payment.error };

    // --- EVOLVE STONE / RARE CANDY (copy): associate with an owned bonus card ---
    let assocColor = null;
    if (isPokemart(card) && (card.effect === 'copy' || card.effect === 'copy_free')) {
      const r = resolveCopyTarget(s, p, opts.copyTargetId);
      if (!r.ok) return r;
      assocColor = r.color;
    }
    // --- TM / RARE CANDY (free / copy_free): plan the free take(s) up front ---
    let freeSteps = null;
    if (isPokemart(card) && (card.effect === 'free' || card.effect === 'copy_free')) {
      const fp = planFree(s, p, card, opts, 0);
      if (!fp.ok) return fp;
      freeSteps = fp.steps;
    }

    payTokens(s, p, payment.pay);
    for (const pid of spend) discardFromBoard(s, p, pid); // virtual masters consumed
    takeFromSource(s, p, loc, fromReserve, cardId);
    p.board.push(cardId);
    if (assocColor) { p.assoc = p.assoc || {}; p.assoc[cardId] = assocColor; }
    s.acted = true;
    const extra = spend.length ? `，弃${spend.length}图鉴抵${spend.length * 2}万能` : '';
    const asc = assocColor ? `，关联${zhBall(assocColor)}` : '';
    log(s, `${p.name} 捕捉了 ${card.name}（${payDesc(payment.pay)}${extra}${asc}）`);
    if (freeSteps && freeSteps.length) execFree(s, p, freeSteps);
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
      // Affordability: evolution is paid ONLY by the discount balls on your
      // captured cards (bonuses) — never by the balls you hold (tokens). You
      // must already own enough discounts of the required color to cover the
      // full evolution cost; nothing is spent.
      if (b[c.evoCost.color] < c.evoCost.count) continue;
      for (const a of avail) {
        if (s.byId[a.id].name !== c.evolvesTo) continue;
        opts.push({
          fromId: id, toId: a.id,
          color: c.evoCost.color, count: c.evoCost.count,
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
    // No tokens are spent: evolution is paid entirely by the discounts on your
    // captured cards (affordability already verified in evolutionOptions).
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

  // ----------------------- Megas expansion ---------------------------
  // Main action: spend your whole turn to take one Mega token (max 1 held).
  function actionTakeMega(s) {
    const p = activePlayer(s);
    if (!s.megasEnabled) return { ok: false, error: '未启用 Megas 扩展' };
    if (s.acted) return { ok: false, error: '本回合已行动' };
    if (p.megaToken >= 1) return { ok: false, error: '已持有 Mega 代币（上限1）' };
    if (s.supply.megaToken < 1) return { ok: false, error: '没有可用的 Mega 代币' };
    s.supply.megaToken--; p.megaToken++;
    s.acted = true;
    log(s, `${p.name} 获得了 1 个 Mega 代币`);
    return { ok: true };
  }

  // End-of-turn Mega evolution options. Requires: you hold a Mega token, you
  // have captured the base Pokémon (megaFrom) in play, and you can pay the Mega
  // card's cost (balls reduced by bonuses; master ball substitutes). Counts as
  // this turn's single evolution (shares evolvedThisTurn).
  function megaEvolveOptions(s, player) {
    const opts = [];
    if (!s.megasEnabled || s.evolvedThisTurn || player.megaToken < 1) return opts;
    for (const megaId of s.megaOffer) {
      const mega = s.byId[megaId];
      const fromId = player.board.find(id => s.byId[id].name === mega.megaFrom);
      if (!fromId) continue;
      if (!canAfford(s, player, mega)) continue;
      opts.push({ megaId, fromId, fromName: mega.megaFrom, megaName: mega.name });
    }
    return opts;
  }

  function actionMegaEvolve(s, megaId, fromId) {
    const p = activePlayer(s);
    if (!s.megasEnabled) return { ok: false, error: '未启用 Megas 扩展' };
    if (s.evolvedThisTurn) return { ok: false, error: '本回合已进化过' };
    const cands = megaEvolveOptions(s, p).filter(o => o.megaId === megaId);
    const opt = (fromId != null) ? cands.find(o => o.fromId === fromId) : cands[0];
    if (!opt) return { ok: false, error: '不满足超级进化条件' };
    const mega = s.byId[megaId];
    const payment = computePayment(s, p, mega);
    if (!payment.ok) return { ok: false, error: payment.error };
    payTokens(s, p, payment.pay);
    // consume the Mega token (returns to the shared pool)
    p.megaToken--; s.supply.megaToken++;
    // bury the base Pokémon, take the Mega card out of the offer, place it in play
    const bi = p.board.indexOf(opt.fromId);
    p.board.splice(bi, 1); p.buried.push(opt.fromId);
    s.megaOffer = s.megaOffer.filter(id => id !== megaId);
    p.board.push(megaId);
    s.evolvedThisTurn = true;
    log(s, `${p.name} 将 ${s.byId[opt.fromId].name} 超级进化为 ${mega.name}（${payDesc(payment.pay)}）`);
    return { ok: true, megaId, fromId: opt.fromId };
  }

  // Win trigger. Base game: 18 VP. Megas: 20 VP AND ≥1 captured card of every
  // color AND ≥1 Mega in play.
  function hasMegaWin(s, p) {
    if (scoreOf(s, p) < MEGA_WIN_SCORE) return false;
    const b = bonuses(s, p);
    if (!COLORS.every(c => b[c] > 0)) return false;
    return p.board.some(id => s.byId[id].tier === 'mega');
  }
  function winTriggered(s, p) {
    return s.megasEnabled ? hasMegaWin(s, p) : (scoreOf(s, p) >= (s.winScore || WIN_SCORE));
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
      megaEvolutions: megaEvolveOptions(s, p),
    };
  }

  function endTurn(s) {
    const p = activePlayer(s);
    if (!s.acted) return { ok: false, error: '尚未行动' };
    if (needsDiscard(s, p)) return { ok: false, error: '请先归还多余精灵球（上限10）' };
    // check win trigger (someone reached the target this turn)
    if (winTriggered(s, p) && !s.lastRound) {
      s.lastRound = true;
      const why = s.megasEnabled ? `${MEGA_WIN_SCORE}分+集齐每色+1只Mega` : `${s.winScore || WIN_SCORE} 分`;
      log(s, `${p.name} 达成胜利条件（${why}），进入最后一轮！`);
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
    const rank = (p) => [scoreOf(s, p), p.buried.length, p.board.length];
    // Eligibility: in the Megas variant only a player who actually achieves the
    // win condition (20 VP + every colour + a Mega in play) can win — a rival with
    // more raw points but no Mega/colour set does NOT. (Base game: everyone is
    // eligible; the highest score already implies they crossed the threshold.)
    let pool = [];
    for (let i = 0; i < s.numPlayers; i++) pool.push(i);
    if (s.megasEnabled) {
      const q = pool.filter(i => hasMegaWin(s, s.players[i]));
      if (q.length) pool = q;   // fall back to all only in the pathological "nobody qualifies" case
    }
    let best = pool[0];
    for (const i of pool) {
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
    // captures (field + own reserve). Pokémart cards with not-yet-live effects
    // are excluded so the AI never picks a capture the engine will reject.
    const capIds = [];
    for (const tier of fieldTiers(s)) for (const id of s.field[tier]) if (id) capIds.push(id);
    for (const id of p.reserve) capIds.push(id);
    for (const id of capIds) {
      const card = s.byId[id];
      if (isPokemart(card) && card.effect) {
        if (!PM_EFFECTS_LIVE[card.effect]) continue;
        if (card.effect === 'discard_buy') {
          const col = card.effectParam.discardColor, need = card.effectParam.discardCount;
          const owned = p.board.filter(bid => effBonusColor(s, p, bid) === col).length;
          if (owned >= need) acts.push({ type: 'capture', cardId: id });
          continue;
        }
        if (card.effect === 'copy') { // needs an owned bonus card to copy
          if (p.board.some(bid => effBonusColor(s, p, bid)) && canAfford(s, p, card))
            acts.push({ type: 'capture', cardId: id });
          continue;
        }
        // double / colorless_master capture like a normal card. free / copy_free
        // require a free-card choice and are driven by the UI (added with AI in 4b).
        if ((card.effect === 'double' || card.effect === 'colorless_master') && canAfford(s, p, card))
          acts.push({ type: 'capture', cardId: id });
        continue;
      }
      if (canAfford(s, p, card)) acts.push({ type: 'capture', cardId: id });
    }
    // reserves (base levels + Pokémart levels)
    if (p.reserve.length < HAND_MAX) {
      const reserveTiers = s.pokemartEnabled ? NORMAL_TIERS.concat(PM_TIERS) : NORMAL_TIERS;
      for (const tier of reserveTiers) {
        for (const id of s.field[tier]) if (id) acts.push({ type: 'reserve', target: { fromField: id } });
        if (s.decks[tier].length) acts.push({ type: 'reserve', target: { fromDeck: tier } });
      }
    }
    return acts;
  }

  // Total reducer: a single validate-and-apply chokepoint for EVERY move, so
  // both local clicks and network messages flow through one path. The move's
  // {type,...} object is the wire format. `playerId` is an optional ownership
  // guard for networked play (reject a move submitted for a seat that isn't the
  // active player); local/AI callers omit it. End-of-turn steps (evolve / mega
  // / discard / endTurn) are included so a turn's whole lifecycle is serialisable.
  function applyAction(s, a, playerId) {
    if (playerId != null && playerId !== s.turn) return { ok: false, error: '未轮到你' };
    switch (a.type) {
      case 'take':       return actionTake(s, a.colors);
      case 'capture':    return actionCapture(s, a.cardId, a.opts);
      case 'reserve':    return actionReserve(s, a.target);
      case 'takeMega':   return actionTakeMega(s);
      case 'evolve':     return actionEvolve(s, a.fromId, a.toId);
      case 'megaEvolve': return actionMegaEvolve(s, a.megaId, a.fromId);
      case 'discard':    return actionDiscard(s, a.color);
      case 'pass':       return actionPass(s);
      case 'endTurn':    return endTurn(s);
      default:           return { ok: false, error: '未知行动' };
    }
  }

  // Public projection of the state for ONE viewer, safe to send over a network.
  // Hides what the viewer must not see — the ordered face-down deck (every future
  // draw) and other players' reserved-card identities (possibly drawn blind) —
  // while preserving counts/tiers so the UI still renders pile sizes & card-backs.
  // Static card refs are omitted (every client already has the full card DB).
  function redactFor(s, viewerId) {
    const { cardDB, byId: _b, megaDB, pokemartDB, ...dyn } = s;
    const v = JSON.parse(JSON.stringify(dyn));            // deep copy of dynamic state
    if (v.decks) for (const t in v.decks) v.decks[t] = v.decks[t].map(() => null); // hide deck order, keep length
    v.players = v.players.map((p, i) => {
      if (i === viewerId) return p;                       // you see your OWN reserve ids
      return Object.assign({}, p, {                       // opponents' reserves → {hidden,tier} stubs
        reserve: p.reserve.map(id => ({ hidden: true, tier: (s.byId[id] || {}).tier || null })),
      });
    });
    v.viewerId = viewerId;
    return v;
  }

  // --------------------------- i18n bits -----------------------------
  const BALL_ZH = { red: '精灵球', blue: '超级球', black: '高级球', pink: '治愈球', yellow: '先机球', purple: '大师球' };
  const TIER_ZH = { stage1: '一阶', stage2: '二阶', stage3: '三阶', rare: '稀有', legend: '传说', mega: 'Mega', pmL1: 'Pokémart一级', pmL2: 'Pokémart二级', pmL3: 'Pokémart三级' };
  function zhBall(c) { return BALL_ZH[c] || c; }
  function zhTier(t) { return TIER_ZH[t] || t; }
  function payDesc(pay) {
    const parts = ALL_TOKENS.filter(c => pay[c] > 0).map(c => `${pay[c]}${zhBall(c)}`);
    return parts.length ? parts.join('+') : '免费';
  }

  // ----- deep clone for AI search -----
  function clone(s) {
    const c = JSON.parse(JSON.stringify({
      seed: s.seed, winScore: s.winScore, numPlayers: s.numPlayers, supply: s.supply, decks: s.decks,
      field: s.field, players: s.players, turn: s.turn, round: s.round,
      phase: s.phase, lastRound: s.lastRound,
      winner: s.winner, acted: s.acted, taken: s.taken, evolvedThisTurn: s.evolvedThisTurn,
      megasEnabled: s.megasEnabled, megaOffer: s.megaOffer,
      pokemartEnabled: s.pokemartEnabled,
    }));
    c.cardDB = s.cardDB; c.byId = s.byId; c.megaDB = s.megaDB; c.pokemartDB = s.pokemartDB; c.log = []; // share static refs, drop log
    return c;
  }

  return {
    COLORS, MASTER, ALL_TOKENS, NORMAL_TIERS, FIELD_TIERS, FIELD_SLOTS,
    HAND_MAX, TOKEN_MAX, WIN_SCORE,
    makeRng, shuffle, supplyFor,
    createGame, activePlayer, bonusOf, bonuses, tokenTotal, scoreOf, locateCard, refill,
    computePayment, canAfford, paymentBreakdown,
    actionTake, actionReserve, actionCapture, actionEvolve, actionDiscard, actionPass,
    actionTakeMega, megaEvolveOptions, actionMegaEvolve, MEGA_TOKENS, MEGA_WIN_SCORE,
    PM_TIERS, PM_SLOTS, fieldTiers, isPokemart, effBonusColor, freeTiers, freeTakeable,
    evolutionOptions, needsDiscard, turnState, endTurn, determineWinner,
    legalActions, applyAction, redactFor, clone,
    zhBall, zhTier, payDesc,
  };
});
