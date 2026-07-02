/* =====================================================================
 * VSearch 鈥?determinized MCTS for the "绌舵瀬" AI difficulty.
 *
 * The deep-research result: with our strong 1-ply heuristic as the search
 * PRIOR + LEAF and the unseen decks RE-SHUFFLED before each search (so the
 * tree averages over plausible futures instead of peeking at the real deck
 * order), a light MCTS beats the plain 1-ply heuristic by a real margin
 * (~55-58% head-to-head in Python validation). No neural net required, and
 * it uses NATIVE engine actions so it works in every mode (incl. Megas /
 * Pok茅mart), unlike the base-only AlphaZero net.
 *
 * Public: VSearch.chooseTurn(G, {sims, dets}) -> {action, discards, evolution}
 * (same shape as AI.chooseTurn, so the UI reuses its apply/animation path.)
 * ===================================================================== */
(function (root, factory) {
  const E = (typeof require === 'function') ? require('../js/engine.js') : root.Engine;
  const AI = (typeof require === 'function') ? require('../js/ai.js') : root.AI;
  const api = factory(E, AI);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.VSearch = api;
})(this, function (E, AI) {
  'use strict';
  const COLORS = E.COLORS, FIELD_TIERS = E.FIELD_TIERS;
  const DEFAULT_CPUCT = 1.4, PRIOR_T = 90, VAL_SCALE = 650;
  // mutable per-search params (set by move() from its cfg) so configs can be A/B-compared in one process
  let CPUCT = DEFAULT_CPUCT;   // exploration constant
  let NODE_PRIOR = false;      // A/B showed it does NOT help (58.3% off vs 52.5% on @2p) 鈥?opt-in only
  let ENDGAME = false;         // in the final round, replace the tanh leaf with a true heuristic playout result
  // Use the STRONGEST heuristic config (denial=10, full proximity) for the search's prior + leaf,
  // matching the Python validation (where eval_state has denial always-on) and the 'hard' opponent.
  // Passing cfg=null would silently disable opponent-denial 鈫?the search plans blind and ties.
  const HARD = (AI && AI.DIFF && AI.DIFF.hard) ? AI.DIFF.hard : null;

  // Resolve end-of-turn discard + evolution the SAME way the heuristic actually plays its turns
  // (eval-based discard + bestEvolution). Consistent modeling is what makes the lookahead valid 鈥?
  // a cheap greedy resolver desyncs the search's game model from the real opponent and ties.
  function resolveTurn(s) {
    if (AI && typeof AI.manage === 'function') { AI.manage(s, HARD); return; }
    const pid = s.turn, me = s.players[pid]; let guard = 0;          // fallback: greedy
    while (E.needsDiscard(s, me) && guard++ < 24) {
      let best = null, bn = -1;
      for (const c of COLORS) if (me.tokens[c] > 0 && me.tokens[c] > bn) { bn = me.tokens[c]; best = c; }
      if (best == null) best = 'purple';
      E.actionDiscard(s, best);
    }
    const opts = E.evolutionOptions(s, me);
    if (opts && opts.length) {
      let bo = null, bg = 0;
      for (const o of opts) { const g = (s.byId[o.toId].vp || 0) - (s.byId[o.fromId].vp || 0); if (g > bg) { bg = g; bo = o; } }
      if (bo) E.actionEvolve(s, bo.fromId, bo.toId);
    }
  }
  // apply a main action then auto-resolve discard + evolution + end turn (鈮?engine.step)
  function autoStep(s, a) {
    if (a) E.applyAction(s, a); else E.actionPass(s);
    resolveTurn(s);
    E.endTurn(s);
  }

  function actionKey(a) {
    if (a.type === 'take') return 't' + a.colors.slice().sort().join('');
    if (a.type === 'capture') return 'c' + a.cardId;
    if (a.type === 'reserve') return 'r' + (a.target.fromField || ('d' + a.target.fromDeck));
    return 'p';
  }

  // prior over legal actions = softmax of the heuristic eval of each action's result, PLUS a
  // node-prior Q-init per action = the side-to-move's static eval margin at that child, in [-1,1]
  // (reuses the same clone+autoStep we already do for the prior; +1 opponent eval per action).
  function priorAndQ(s) {
    const acts = E.legalActions(s), me = s.turn, np = s.numPlayers;
    if (!acts.length) return { acts: acts, P: null, Q0: null };
    const ev = new Float64Array(acts.length);
    const Q0 = new Float64Array(acts.length);
    let mx = -1e18;
    for (let i = 0; i < acts.length; i++) {
      const c = E.clone(s); autoStep(c, acts[i]);
      if (c.phase === 'gameover') {
        ev[i] = AI.evalState(c, me, HARD);
        Q0[i] = c.winner === me ? 1 : -1;
      } else {
        const meEv = AI.evalState(c, me, HARD);
        ev[i] = meEv;
        let opp = -1e18;
        for (let q = 0; q < np; q++) if (q !== me) { const v = AI.evalState(c, q, HARD); if (v > opp) opp = v; }
        Q0[i] = Math.tanh((meEv - opp) / VAL_SCALE);
      }
      if (ev[i] > mx) mx = ev[i];
    }
    const P = new Float64Array(acts.length); let sum = 0;
    for (let i = 0; i < acts.length; i++) { P[i] = Math.exp((ev[i] - mx) / PRIOR_T); sum += P[i]; }
    for (let i = 0; i < acts.length; i++) P[i] /= sum;
    return { acts: acts, P: P, Q0: Q0 };
  }

  // PER-SEAT value vector v[p] 鈭?[-1,1] 鈥?each player's eval margin vs their best opponent.
  // Correct for N players (non-zero-sum); for np==2 it is exactly the old 卤sign-flip.
  function terminalVec(s) {
    const v = new Float64Array(s.numPlayers);
    for (let p = 0; p < s.numPlayers; p++) v[p] = (p === s.winner) ? 1 : -1;
    return v;
  }
  function leafVec(s) {
    const np = s.numPlayers, ev = new Float64Array(np), v = new Float64Array(np);
    for (let p = 0; p < np; p++) ev[p] = AI.evalState(s, p, HARD);
    for (let p = 0; p < np; p++) {
      let opp = -1e18;
      for (let q = 0; q < np; q++) if (q !== p && ev[q] > opp) opp = ev[q];
      v[p] = Math.tanh((ev[p] - opp) / VAL_SCALE);
    }
    return v;
  }

  // Final-round exact-ish value: play the heuristic's best line to terminal (the final round is short
  // and deck draws can't change who wins it), return the TRUE per-seat result vector.
  function endgameVec(s) {
    const c = E.clone(s); let guard = 0;
    while (c.phase !== 'gameover' && guard++ < 16) {
      const acts = E.legalActions(c);
      if (!acts.length) { autoStep(c, null); continue; }
      const meNow = c.turn; let best = acts[0], bs = -1e18;
      for (let i = 0; i < acts.length; i++) {
        const cc = E.clone(c); autoStep(cc, acts[i]);
        const v = AI.evalState(cc, meNow, HARD);
        if (v > bs) { bs = v; best = acts[i]; }
      }
      autoStep(c, best);
    }
    return terminalVec(c);
  }

  function mkNode(s) {
    return { s: s, turn: s.turn, over: s.phase === 'gameover', winner: s.winner,
             acts: null, P: null, Q0: null, N: null, W: null, children: {}, expanded: false };
  }
  function expand(n) {
    if (n.over) { n.expanded = true; return; }
    const r = priorAndQ(n.s);
    n.acts = r.acts; n.P = r.P; n.Q0 = r.Q0;
    n.N = new Float64Array(r.acts.length); n.W = new Float64Array(r.acts.length); n.expanded = true;
  }
  function select(n) {
    let tot = 0; for (let i = 0; i < n.N.length; i++) tot += n.N[i];
    const sq = Math.sqrt(tot) + 1e-8; let best = -1e18, bi = 0;
    for (let i = 0; i < n.acts.length; i++) {
      const q = n.N[i] > 0 ? n.W[i] / n.N[i] : (NODE_PRIOR ? n.Q0[i] : 0);
      const u = CPUCT * n.P[i] * sq / (1 + n.N[i]);
      if (q + u > best) { best = q + u; bi = i; }
    }
    return bi;
  }
  function simulate(root) {
    const path = []; let n = root, vVec;
    while (true) {
      if (n.over) { vVec = terminalVec(n.s); break; }
      const bi = select(n); const a = n.acts[bi]; path.push([n, bi]);
      const key = actionKey(a); let ch = n.children[key];
      if (!ch) {
        const c = E.clone(n.s); autoStep(c, a); ch = mkNode(c); n.children[key] = ch;
        if (ch.over) vVec = terminalVec(ch.s);
        else { expand(ch); vVec = (ENDGAME && ch.s.lastRound) ? endgameVec(ch.s) : leafVec(ch.s); }
        break;
      }
      n = ch;
    }
    for (let k = 0; k < path.length; k++) {
      const nn = path[k][0], bi = path[k][1];
      nn.N[bi] += 1; nn.W[bi] += vVec[nn.turn];
    }
  }
  function determinize(s) {
    for (const t of FIELD_TIERS) {
      const d = s.decks[t];
      for (let i = d.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const tmp = d[i]; d[i] = d[j]; d[j] = tmp; }
    }
  }

  // returns the best engine action object (or null). cfg = {sims, dets, cpuct, nodePrior}
  function move(G, cfg) {
    cfg = cfg || {};
    const sims = cfg.sims || 96, dets = cfg.dets || 2;
    CPUCT = cfg.cpuct != null ? cfg.cpuct : DEFAULT_CPUCT;
    NODE_PRIOR = cfg.nodePrior === true;
    ENDGAME = !!cfg.endgame;
    const agg = {}, byKey = {};
    const per = Math.max(1, (sims / dets) | 0);
    for (let d = 0; d < dets; d++) {
      const s = E.clone(G); determinize(s);
      const root = mkNode(s); expand(root);
      if (!root.acts || !root.acts.length) return null;
      if (root.acts.length === 1) return root.acts[0];
      for (let i = 0; i < per; i++) simulate(root);
      for (let i = 0; i < root.acts.length; i++) {
        const k = actionKey(root.acts[i]);
        agg[k] = (agg[k] || 0) + root.N[i]; byKey[k] = root.acts[i];
      }
    }
    let bestK = null, bn = -1;
    for (const k in agg) if (agg[k] > bn) { bn = agg[k]; bestK = k; }
    return bestK == null ? null : byKey[bestK];
  }

  // chooseTurn-compatible plan: search picks the main action, then resolve discard/evolution on the
  // REAL state with the heuristic's own manager (so the applied plan matches what the search modeled).
  function chooseTurn(G, opts) {
    opts = opts || {};
    const a = move(G, opts);
    if (!a) return { action: null, discards: [], evolution: null };
    const c = E.clone(G); E.applyAction(c, a);
    if (AI && typeof AI.manage === 'function') {
      const plan = AI.manage(c, HARD);
      return { action: a, discards: plan.discards || [], evolution: plan.evolution || null };
    }
    const me = c.players[c.turn]; const discards = []; let guard = 0;
    while (E.needsDiscard(c, me) && guard++ < 24) {
      let best = null, bn = -1;
      for (const col of COLORS) if (me.tokens[col] > 0 && me.tokens[col] > bn) { bn = me.tokens[col]; best = col; }
      if (best == null) best = 'purple';
      E.actionDiscard(c, best); discards.push(best);
    }
    let evolution = null;
    const eo = E.evolutionOptions(c, me);
    if (eo && eo.length) {
      let bo = null, bg = 0;
      for (const o of eo) { const g = (c.byId[o.toId].vp || 0) - (c.byId[o.fromId].vp || 0); if (g > bg) { bg = g; bo = o; } }
      if (bo) evolution = { fromId: bo.fromId, toId: bo.toId };
    }
    return { action: a, discards: discards, evolution: evolution };
  }

  return { move, chooseTurn, autoStep };
});

