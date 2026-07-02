/* =====================================================================
 * VSearch v2 — single-tree determinized MCTS for the "究极" AI difficulty.
 *
 * v1 split the budget across `dets` INDEPENDENT trees (200 sims / 3 trees
 * ≈ 67 sims each — far too shallow to out-think the 1-ply heuristic) and
 * paid a full |A|×(clone+eval) prior expansion for every new leaf.
 * v2 restructures per the research evidence (Cowling et al.: one deep tree
 * ≫ many shallow trees; SO-ISMCTS-lite):
 *   - ONE tree over information sets: nodes keyed by the action path, no
 *     stored states; each iteration clones the real state, RE-SHUFFLES the
 *     unseen decks (fresh determinization), and replays down the tree.
 *   - Lazy expansion: a new leaf costs only a cheap eval (≈5 evalStates);
 *     the expensive softmax prior is computed on the 2nd visit. Most leaves
 *     are never revisited → ~5-10× more sims per second.
 *   - Budget: cfg.sims (iterations) or cfg.timeMs (anytime, early-stops
 *     when the leader is mathematically unassailable).
 *   - Per-seat max^n value vectors (kept from v1 — correct for 3-4p) and
 *     optional cfg.oppK pruning at opponent nodes so multiplayer budgets
 *     concentrate on OUR replies instead of predicting everyone deeply.
 *
 * Public: VSearch.chooseTurn(G, {sims,timeMs,cpuct,oppK,endgame})
 *         -> {action, discards, evolution}   (same shape as AI.chooseTurn)
 * ===================================================================== */
(function (root, factory) {
  const E = (typeof require === 'function') ? require('./engine.js') : root.Engine;
  const AI = (typeof require === 'function') ? require('./ai.js') : root.AI;
  const api = factory(E, AI);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.VSearch = api;
})(this, function (E, AI) {
  'use strict';
  const COLORS = E.COLORS, FIELD_TIERS = E.FIELD_TIERS;
  const DEFAULT_CPUCT = 1.4, PRIOR_T = 90, VAL_SCALE = 650, EXPAND_AT = 2;
  // Use the STRONGEST heuristic config (denial on, full proximity) for the search's
  // prior + leaf — same reasoning as v1: a weaker model desyncs from the real opponent.
  const HARD = (AI && AI.DIFF && AI.DIFF.hard) ? AI.DIFF.hard : null;

  // Resolve end-of-turn discard + evolution the SAME way the heuristic plays its
  // turns (consistent opponent model is what makes the lookahead valid).
  function resolveTurn(s) {
    if (AI && typeof AI.manage === 'function') { AI.manage(s, HARD); return; }
    const me = s.players[s.turn]; let guard = 0;                   // fallback: greedy
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
  function autoStep(s, a) {
    if (a) E.applyAction(s, a); else E.actionPass(s);
    resolveTurn(s);
    E.endTurn(s);
  }

  function actionKey(a) {
    if (a.type === 'take') return 't' + a.colors.slice().sort().join('');
    if (a.type === 'capture') return 'c' + a.cardId;
    if (a.type === 'reserve') return 'r' + (a.target.fromField || ('d' + a.target.fromDeck));
    if (a.type === 'takeMega') return 'm';   // must not collide with pass ('p')
    return 'p';
  }

  // fresh determinization: re-shuffle every unseen deck so the tree averages
  // over plausible futures instead of peeking at the real order
  function determinize(s) {
    for (const t of FIELD_TIERS) {
      const d = s.decks[t];
      for (let i = d.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const tmp = d[i]; d[i] = d[j]; d[j] = tmp; }
    }
  }

  // PER-SEAT value vector v[p] ∈ [-1,1] — each player's eval margin vs their
  // best opponent (max^n backup; for np==2 it's exactly a sign flip).
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
  // Final-round exact-ish value: the last round is short and deck draws can't
  // change who wins it — play the heuristic line out and return the TRUE result.
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

  // ------------------------- tree (information sets) -------------------------
  // A node stores STATS ONLY (no game state): the working state is rebuilt each
  // iteration by replaying the selected path on a fresh determinization.
  function mkNode(turn) {
    return { turn, seen: 0, expanded: false, acts: null, P: null, N: null, W: null, keys: null, children: {} };
  }

  // full expansion (the expensive |A|×(clone+step+eval) softmax prior) — paid
  // only when a node is revisited (EXPAND_AT), not for every one-shot leaf.
  function expandNode(n, s, rootTurn, oppK) {
    let acts = E.legalActions(s);
    const me = s.turn, np = s.numPlayers;
    const ev = new Float64Array(acts.length);
    let mx = -1e18;
    for (let i = 0; i < acts.length; i++) {
      const c = E.clone(s); autoStep(c, acts[i]);
      ev[i] = AI.evalState(c, me, HARD);
      if (ev[i] > mx) mx = ev[i];
    }
    // opponent k-best pruning (3-4p): at opponent nodes keep only their top-K
    // plausible replies so the budget deepens OUR line instead of fanning out.
    if (oppK > 0 && me !== rootTurn && np >= 3 && acts.length > oppK) {
      const idx = Array.from(ev.keys()).sort((a, b) => ev[b] - ev[a]).slice(0, oppK);
      acts = idx.map(i => acts[i]);
      const ev2 = new Float64Array(oppK);
      for (let i = 0; i < oppK; i++) ev2[i] = ev[idx[i]];
      mx = ev2[0];
      n.P = softmax(ev2, mx);
    } else {
      n.P = softmax(ev, mx);
    }
    n.acts = acts;
    n.keys = acts.map(actionKey);
    n.N = new Float64Array(acts.length);
    n.W = new Float64Array(acts.length);
    n.expanded = true;
  }
  function softmax(ev, mx) {
    const P = new Float64Array(ev.length); let sum = 0;
    for (let i = 0; i < ev.length; i++) { P[i] = Math.exp((ev[i] - mx) / PRIOR_T); sum += P[i]; }
    for (let i = 0; i < ev.length; i++) P[i] /= sum;
    return P;
  }

  function select(n, cpuct, mask) {
    let tot = 0; for (let i = 0; i < n.N.length; i++) tot += n.N[i];
    const sq = Math.sqrt(tot) + 1e-8; let best = -1e18, bi = -1;
    for (let i = 0; i < n.acts.length; i++) {
      if (mask && mask[i]) continue;
      const q = n.N[i] > 0 ? n.W[i] / n.N[i] : 0;
      const u = cpuct * n.P[i] * sq / (1 + n.N[i]);
      if (q + u > best) { best = q + u; bi = i; }
    }
    return bi;
  }

  // one iteration: fresh determinization → replay/descend → cheap leaf (or
  // expand on revisit) → back up the per-seat value vector along the path
  function simulate(root, G, cfg) {
    const working = E.clone(G); determinize(working);
    const cpuct = cfg.cpuct != null ? cfg.cpuct : DEFAULT_CPUCT;
    const path = []; let n = root, vVec = null;
    while (true) {
      if (working.phase === 'gameover') { vVec = terminalVec(working); break; }
      if (!n.expanded) {
        n.seen++;
        if (n.seen < EXPAND_AT) {                                   // one-shot leaf: cheap eval only
          vVec = (cfg.endgame && working.lastRound) ? endgameVec(working) : leafVec(working);
          break;
        }
        expandNode(n, working, G.turn, cfg.oppK || 0);
        if (!n.acts.length) { vVec = leafVec(working); break; }
      }
      // select an action that is legal in THIS determinization (a capture/reserve
      // below a refill may reference a card that isn't there in this shuffle)
      let bi = -1, mask = null;
      for (let tries = 0; tries < n.acts.length; tries++) {
        bi = select(n, cpuct, mask);
        if (bi < 0) break;
        const r = E.applyAction(working, n.acts[bi]);
        if (r.ok) break;
        if (!mask) mask = new Uint8Array(n.acts.length);
        mask[bi] = 1; bi = -1;
      }
      if (bi < 0) { vVec = leafVec(working); break; }                // nothing applicable here
      resolveTurn(working); E.endTurn(working);
      path.push([n, bi]);
      const key = n.keys[bi];
      let ch = n.children[key];
      if (!ch) { ch = mkNode(working.turn); n.children[key] = ch; }
      n = ch;
    }
    for (let k = 0; k < path.length; k++) {
      const nn = path[k][0], i = path[k][1];
      nn.N[i] += 1; nn.W[i] += vVec[nn.turn];
    }
  }

  // returns the best engine action (or null).
  // cfg = { sims, timeMs, cpuct, oppK, endgame }  — timeMs takes precedence.
  function move(G, cfg) {
    cfg = cfg || {};
    const sims = cfg.sims || 200;
    const deadline = cfg.timeMs ? (Date.now() + cfg.timeMs) : 0;
    const root = mkNode(G.turn);
    root.seen = EXPAND_AT;                                          // root always expands immediately
    expandNode(root, G, G.turn, 0);                                 // never prune OUR own actions
    if (!root.acts || !root.acts.length) return null;
    if (root.acts.length === 1) return root.acts[0];
    let done = 0;
    const t0 = Date.now();
    while (true) {
      for (let b = 0; b < 16; b++) { simulate(root, G, cfg); done++; }
      // budget check
      let remaining;
      if (deadline) {
        const spent = Date.now() - t0;
        if (Date.now() >= deadline) break;
        remaining = Math.max(1, ((deadline - Date.now()) / Math.max(1, spent)) * done);
      } else {
        if (done >= sims) break;
        remaining = sims - done;
      }
      // early stop: the runner-up can no longer catch the leader
      let n1 = -1, n2 = -1;
      for (let i = 0; i < root.N.length; i++) { if (root.N[i] > n1) { n2 = n1; n1 = root.N[i]; } else if (root.N[i] > n2) n2 = root.N[i]; }
      if (n1 - n2 > remaining) break;
    }
    let bi = 0, bn = -1;
    for (let i = 0; i < root.N.length; i++) if (root.N[i] > bn) { bn = root.N[i]; bi = i; }
    return root.acts[bi];
  }

  // chooseTurn-compatible plan: search picks the main action, then discard/evolution
  // are resolved on the REAL state with the heuristic's own manager (matches the model).
  function chooseTurn(G, opts) {
    opts = opts || {};
    // First-Mega override (same discipline as AI.chooseTurn): qualification is
    // binary and the offer is contested — when our base's Mega is affordable and
    // we own none, spend the turn on the token; manage() megas the same turn.
    // The tree's leaf eval can't price the binary qualification, so don't let
    // "one more capture" lines outvote it.
    if (G.megasEnabled) {
      const p = G.players[G.turn];
      const ownsMega = p.board.some(id => G.byId[id].tier === 'mega');
      if (!ownsMega && p.megaToken < 1 && G.supply.megaToken > 0) {
        for (const mid of (G.megaOffer || [])) {
          const m = G.byId[mid];
          if (p.board.some(id => G.byId[id].name === m.megaFrom) && E.canAfford(G, p, m)) {
            const c0 = E.clone(G); E.applyAction(c0, { type: 'takeMega' });
            const mp0 = (AI && AI.manage) ? AI.manage(c0, HARD) : { discards: [], evolution: null };
            return { action: { type: 'takeMega' }, discards: mp0.discards || [], evolution: mp0.evolution || null, megaEvolution: mp0.megaEvolution || null };
          }
        }
      }
    }
    const a = move(G, opts);
    if (!a) return { action: null, discards: [], evolution: null };
    const c = E.clone(G); E.applyAction(c, a);
    if (AI && typeof AI.manage === 'function') {
      const plan = AI.manage(c, HARD);
      return { action: a, discards: plan.discards || [], evolution: plan.evolution || null, megaEvolution: plan.megaEvolution || null };
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
