/* =====================================================================
 * Pokémon Splendor — AI opponent
 * ---------------------------------------------------------------------
 * Evaluation-based, evolution-aware 1-ply search.
 *
 * Splendor strategy baked in:
 *   - Victory Points dominate, with extra urgency near the 18 finish line.
 *   - "Bonus" cards are an engine: each permanent discount compounds, so
 *     they're valued for both their VP and the discounts they grant.
 *   - Evolution is a FREE action (end of turn) → after every candidate main
 *     action we also apply the best evolution, so the search naturally
 *     rewards building evolvable chains and cashing them in for cheap VP.
 *   - Reaching toward affordable high-VP cards ("proximity") is rewarded so
 *     the AI takes the right balls instead of hoarding.
 *
 * Public:
 *   AI.chooseTurn(state, opts)  -> { action, discards:[color], evolution:{fromId,toId}|null }
 *   AI.playTurn(state, opts)    -> applies the plan to `state` (incl. endTurn)
 * ===================================================================== */
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('./engine_frozen.js') : root.Engine);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AI = api;
})(this, function (E) {
  'use strict';
  const { COLORS, ALL_TOKENS, FIELD_TIERS } = E;

  const DIFF = {
    easy:   { evoBias: 0.4, noise: 6,   proximity: 0.5, deny: 0 },
    normal: { evoBias: 0.8, noise: 1.5, proximity: 1.0, deny: 0 },
    hard:   { evoBias: 1.0, noise: 0,   proximity: 1.0, deny: 10 },
  };

  // Eval weights — SPSA-tuned via self-play (test/tune.js). The tuned set beats the original hand-set
  // weights at EVERY player count (2p 62%, 3p 40.7% vs 33.3 fair, 4p 31.7% vs 25 fair) and still
  // crushes greedy (88%). VP scale fixed at 100 (anchor); the rest relative. test/tune.js re-tunes vs
  // whatever is here. (Original hand values: vpEnd45 lastRound70 cards16 rl14 bonus4 coh5/3 distinct3
  // overstack3 tok1.0/.35/1.6 purple2 reserve.5 prox11/.4 proxBonus1.5 proxEvo.7 rlProx6/3 gapDiv1.4 evo6 deny1.)
  const DEFAULT_W = {
    vpEnd: 41.475, lastRound: 66.966, cards: 17.529, rl: 13.512, bonus: 4.436,
    coh1: 5.053, coh2: 3.138, distinct: 3.225, overstack: 3.276,
    tok1: 0.92, tok2: 0.357, tokPen: 1.514, purple: 1.969, reserve: 0.572,
    prox: 8.617, prox2: 0.435, proxBonus: 1.418, proxEvo: 0.586, rlProxE: 5.655, rlProxL: 3.161, gapDiv: 1.417,
    evo: 6.211, denyMul: 1.023,
  };
  let W = Object.assign({}, DEFAULT_W);

  // ---- static position evaluation from player `pid`'s perspective ----
  function evalState(s, pid, cfg) {
    const p = s.players[pid];
    const b = E.bonuses(s, p);
    const vp = E.scoreOf(s, p);
    let score = 0;

    score += vp * 100;                                   // VP is king (fixed anchor scale)
    if (vp >= 11) score += (vp - 11) * W.vpEnd;          // endgame push
    if (s.lastRound) score += vp * W.lastRound;          // race hard once final round is on

    // engine: owned bonus cards + total discount power are highly valued so
    // the AI keeps capturing rather than hoarding tokens.
    const cards = p.board.length;
    score += cards * W.cards;
    // 神兽/稀有 (rare/legend) anchor a colour high-score flow: 2 same-colour discounts
    // (+2VP for legend). Owning them is worth extra beyond a normal card.
    let rlOwned = 0;
    for (const id of p.board) { const t = s.byId[id].tier; if (t === 'rare' || t === 'legend') rlOwned++; }
    score += rlOwned * W.rl;                             // specials anchor a colour flow (2 same-colour discounts, can't be blocked)
    let totalBonus = 0;
    const bvals = [];
    for (const c of COLORS) { totalBonus += b[c]; bvals.push(b[c]); }
    score += totalBonus * W.bonus;
    // colour COHERENCE (高分流): a deep primary + a moderate secondary colour are what
    // unlock the expensive same-colour high-VP cards. Reward concentration over a flat
    // 1-of-each spread, but keep ≥2 colours (2-colour high cards) and lightly punish hoarding.
    bvals.sort((x, y) => y - x);
    score += Math.min(bvals[0], 4) * W.coh1 + Math.min(bvals[1], 3) * W.coh2;
    const distinct = bvals.filter(v => v > 0).length;
    score += Math.min(distinct, 2) * W.distinct;
    if (bvals[0] > 5) score -= (bvals[0] - 5) * W.overstack;   // mild anti-overstack

    // tokens: concave value with a real anti-hoard penalty past 8 so the AI
    // converts tokens into cards instead of sitting at the 10 limit.
    const toks = E.tokenTotal(p);
    score += Math.min(toks, 5) * W.tok1 + Math.max(0, Math.min(toks, 8) - 5) * W.tok2;
    score -= Math.max(0, toks - 8) * W.tokPen;
    score += p.tokens.purple * W.purple;                 // master balls are flexible
    // Reserving is a tempo cost: keep its value low so the AI only reserves when
    // the search proves it sets up a strong capture (or grabs a master when stuck).
    score += p.reserve.length * W.reserve;

    // proximity: reward being close to capturing the single most attractive
    // scoring card (field or hand). Weighted highly so the AI takes the RIGHT
    // balls toward a high-VP target instead of grabbing 0-VP junk.
    const early = s.round <= 6;
    const targets = [];
    for (const tier of FIELD_TIERS) for (const id of s.field[tier]) if (id) targets.push(id);
    for (const id of p.reserve) targets.push(id);
    let bestProx = 0, prox2 = 0;
    for (const id of targets) {
      const card = s.byId[id];
      // evolved potential: a cheap card (御五家 3-2) that evolves into VP is worth reaching for
      let evoVP = 0;
      if (card.evolvesTo) { const t = DBfind(s, card.evolvesTo); if (t) evoVP = Math.max(0, t.vp - (card.vp || 0)); }
      if (!card.vp && card.tier !== 'rare' && evoVP <= 0) continue;
      let gap = card.cost.purple || 0;
      for (const c of COLORS) gap += Math.max(0, (card.cost[c] || 0) - b[c] - p.tokens[c]);
      let worth = (card.vp || 0) + (card.bonusCount || 1) * W.proxBonus + evoVP * W.proxEvo;
      if (card.tier === 'rare' || card.tier === 'legend') worth += early ? W.rlProxE : W.rlProxL; // engine anchor, esp. early
      const v = worth / (1 + gap * W.gapDiv);
      if (v > bestProx) { prox2 = bestProx; bestProx = v; } else if (v > prox2) prox2 = v;
    }
    score += (bestProx + prox2 * W.prox2) * W.prox * (cfg ? cfg.proximity : 1);  // top-2 → coherent multi-card lineup

    // opponent denial: lines that cut the strongest opponent's proximity to a big card
    // (e.g. capturing/reserving the card they were about to buy) are rewarded. Encodes the
    // "slow other players down / reserve what they need" principle in a 1-ply eval.
    if (cfg && cfg.deny) {
      let oppMax = 0;
      for (let q = 0; q < s.numPlayers; q++) {
        if (q === pid) continue;
        const op = s.players[q], ob = E.bonuses(s, op);
        let oprox = 0;
        for (const tier of FIELD_TIERS) for (const id of s.field[tier]) {
          if (!id) continue; const card = s.byId[id];
          const rl = card.tier === 'rare' || card.tier === 'legend';
          if ((card.vp || 0) < 2 && !rl) continue;
          let gap = card.cost.purple || 0;
          for (const c of COLORS) gap += Math.max(0, (card.cost[c] || 0) - ob[c] - op.tokens[c]);
          const v = ((card.vp || 0) + (rl ? 3 : 0)) / (1 + gap * 1.4);
          if (v > oprox) oprox = v;
        }
        if (oprox > oppMax) oppMax = oprox;
      }
      score -= oppMax * cfg.deny * W.denyMul;
    }

    // evolution potential: a caught Pokémon whose next form is available and
    // roughly affordable is nearly-free VP next turn — reward keeping such chains.
    for (const id of p.board) {
      const card = s.byId[id];
      if (!card.evolvesTo || !card.evoCost) continue;
      let avail = false;
      for (const tier of FIELD_TIERS) for (const fid of s.field[tier]) if (fid && s.byId[fid].name === card.evolvesTo) avail = true;
      for (const rid of p.reserve) if (s.byId[rid].name === card.evolvesTo) avail = true;
      if (!avail) continue;
      // Evolution is paid only by discounts (bonuses), not tokens: reward chains
      // whose evo color is already (nearly) covered by owned discounts.
      const need = Math.max(0, card.evoCost.count - b[card.evoCost.color]);
      const tgt = DBfind(s, card.evolvesTo);
      const gain = tgt ? Math.max(0, tgt.vp - card.vp) : 1;
      score += (gain * W.evo) / (1 + need);
    }

    if (cfg && cfg.noise) score += (E._noise ? E._noise() : 0) * cfg.noise;
    return score;
  }

  // best (highest-VP) card of a given species among all cards — for estimating
  // evolution VP gain. Cached per state.
  function DBfind(s, name) {
    if (!s._byName) {
      s._byName = {};
      for (const id in s.byId) { const c = s.byId[id]; if (!s._byName[c.name] || c.vp > s._byName[c.name].vp) s._byName[c.name] = c; }
    }
    return s._byName[name];
  }

  // ---- best end-of-turn evolution (by static eval) on a clone ----
  function bestEvolution(s, pid, cfg) {
    const opts = E.evolutionOptions(s, s.players[pid]);
    if (!opts.length) return null;
    const base = evalState(s, pid, null);
    let best = null, bestScore = base;
    for (const o of opts) {
      const c = E.clone(s);
      const r = E.actionEvolve(c, o.fromId, o.toId);
      if (!r.ok) continue;
      const sc = evalState(c, pid, null) + (cfg ? cfg.evoBias : 1) * 8; // small intrinsic bonus: free VP/action
      if (sc > bestScore) { bestScore = sc; best = o; }
    }
    return best;
  }

  // score a full line: state already has the main action applied; manage
  // discards + evolution on a clone and return the resulting eval.
  function scoreLine(s, pid, cfg) {
    const c = E.clone(s);
    manage(c, cfg);
    return evalState(c, pid, cfg);
  }

  // perform end-of-turn management (discard to 10, then best evolution) on `s`.
  // returns { discards:[color], evolution:{fromId,toId}|null }
  function manage(s, cfg) {
    const pid = s.turn;
    const p = s.players[pid];
    const plan = { discards: [], evolution: null };
    // discard greedily, choosing the color whose removal best preserves value
    while (E.needsDiscard(s, p)) {
      let bestColor = null, bestScore = -Infinity;
      for (const col of ALL_TOKENS) {
        if (!p.tokens[col]) continue;
        const c = E.clone(s);
        c.players[pid].tokens[col]--; c.supply[col]++;
        // value the resulting position *including* the evolution we could still do
        const sc = evalWithEvo(c, pid, cfg);
        if (sc > bestScore) { bestScore = sc; bestColor = col; }
      }
      if (bestColor == null) break;
      E.actionDiscard(s, bestColor); plan.discards.push(bestColor);
    }
    const evo = bestEvolution(s, pid, cfg);
    if (evo) { E.actionEvolve(s, evo.fromId, evo.toId); plan.evolution = { fromId: evo.fromId, toId: evo.toId }; }
    return plan;
  }

  function evalWithEvo(s, pid, cfg) {
    const evo = bestEvolution(s, pid, cfg);
    if (!evo) return evalState(s, pid, cfg);
    const c = E.clone(s); E.actionEvolve(c, evo.fromId, evo.toId);
    return evalState(c, pid, cfg);
  }

  // ---- choose the whole turn (1-ply eval search) ----
  function chooseTurn(s, opts) {
    opts = opts || {};
    const cfg = DIFF[opts.difficulty || 'hard'];
    const pid = s.turn;
    const acts = E.legalActions(s);
    if (!acts.length) return { action: null, discards: [], evolution: null };

    // deterministic-ish noise per call (so 'easy' varies without Math.random in engine)
    let seed = (s.round * 131 + s.turn * 17 + acts.length * 7) >>> 0;
    E._noise = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed / 4294967296) - 0.5; };

    let best = null, bestScore = -Infinity;
    for (const a of acts) {
      const c = E.clone(s);
      const r = E.applyAction(c, a);
      if (!r.ok) continue;
      const sc = scoreLine(c, pid, cfg);
      if (sc > bestScore) { bestScore = sc; best = a; }
    }
    E._noise = null;
    if (!best) best = acts[0];

    // recompute the concrete discard + evolution plan on the real chosen line
    const c = E.clone(s);
    E.applyAction(c, best);
    const mp = manage(c, cfg);
    return { action: best, discards: mp.discards, evolution: mp.evolution };
  }

  // ---- apply a chosen plan to the live state (used headless; UI animates) ----
  function playTurn(s, opts) {
    const plan = chooseTurn(s, opts);
    if (plan.action) E.applyAction(s, plan.action);
    else E.actionPass(s); // no legal main action available
    for (const col of plan.discards) E.actionDiscard(s, col);
    if (plan.evolution) E.actionEvolve(s, plan.evolution.fromId, plan.evolution.toId);
    const r = E.endTurn(s);
    return { plan, endTurn: r };
  }

  return { chooseTurn, playTurn, evalState, bestEvolution, manage, DIFF,
           DEFAULT_W, getWeights: () => Object.assign({}, W),
           setWeights: (w) => { W = Object.assign({}, DEFAULT_W, w); } };
});

