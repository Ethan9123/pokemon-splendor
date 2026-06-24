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
  const api = factory(typeof require === 'function' ? require('./engine.js') : root.Engine);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AI = api;
})(this, function (E) {
  'use strict';
  const { COLORS, ALL_TOKENS, FIELD_TIERS } = E;

  const DIFF = {
    easy:   { evoBias: 0.4, noise: 6,   proximity: 0.5 },
    normal: { evoBias: 0.8, noise: 1.5, proximity: 1.0 },
    hard:   { evoBias: 1.0, noise: 0,   proximity: 1.0 },
  };

  // ---- static position evaluation from player `pid`'s perspective ----
  function evalState(s, pid, cfg) {
    const p = s.players[pid];
    const b = E.bonuses(s, p);
    const vp = E.scoreOf(s, p);
    let score = 0;

    score += vp * 100;                                   // VP is king
    if (vp >= 11) score += (vp - 11) * 45;               // endgame push
    if (s.lastRound) score += vp * 70;                   // race hard once final round is on

    // engine: owned bonus cards + total discount power are highly valued so
    // the AI keeps capturing rather than hoarding tokens.
    const cards = p.board.length;
    score += cards * 16;
    // 神兽/稀有 (rare/legend) anchor a colour high-score flow: 2 same-colour discounts
    // (+2VP for legend). Owning them is worth extra beyond a normal card.
    let rlOwned = 0;
    for (const id of p.board) { const t = s.byId[id].tier; if (t === 'rare' || t === 'legend') rlOwned++; }
    score += rlOwned * 10;
    let totalBonus = 0;
    const distinct = COLORS.filter(c => { totalBonus += b[c]; return b[c] > 0; }).length;
    score += totalBonus * 4;
    score += distinct * 4;                               // colour diversity
    for (const c of COLORS) if (b[c] > 4) score -= (b[c] - 4) * 3; // mild anti-overstack

    // tokens: concave value with a real anti-hoard penalty past 8 so the AI
    // converts tokens into cards instead of sitting at the 10 limit.
    const toks = E.tokenTotal(p);
    score += Math.min(toks, 5) * 1.0 + Math.max(0, Math.min(toks, 8) - 5) * 0.35;
    score -= Math.max(0, toks - 8) * 1.6;
    score += p.tokens.purple * 2.0;                      // master balls are flexible
    // Reserving is a tempo cost: keep its value low so the AI only reserves when
    // the search proves it sets up a strong capture (or grabs a master when stuck).
    score += p.reserve.length * 0.5;

    // proximity: reward being close to capturing the single most attractive
    // scoring card (field or hand). Weighted highly so the AI takes the RIGHT
    // balls toward a high-VP target instead of grabbing 0-VP junk.
    const targets = [];
    for (const tier of FIELD_TIERS) for (const id of s.field[tier]) if (id) targets.push(id);
    for (const id of p.reserve) targets.push(id);
    let bestProx = 0;
    for (const id of targets) {
      const card = s.byId[id];
      if (!card.vp && card.tier !== 'rare') continue;
      let gap = card.cost.purple || 0;
      for (const c of COLORS) gap += Math.max(0, (card.cost[c] || 0) - b[c] - p.tokens[c]);
      let worth = (card.vp || 0) + (card.bonusCount || 1) * 1.5;
      if (card.tier === 'rare' || card.tier === 'legend') worth += 3; // high-priority anchor
      const v = worth / (1 + gap * 1.4);
      if (v > bestProx) bestProx = v;
    }
    score += bestProx * 11 * (cfg ? cfg.proximity : 1);

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
      score += (gain * 6) / (1 + need);
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

  // ---- choose the whole turn ----
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

  return { chooseTurn, playTurn, evalState, bestEvolution, DIFF };
});
