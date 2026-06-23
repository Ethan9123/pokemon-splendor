/* =====================================================================
 * AlphaZero net inference for the browser AI.
 * Ports train/features.py (encoder), train/net.py (forward), and the
 * train/engine.py 53-action layer + auto-resolve, so the trained policy
 * plays in the web game. Light MCTS guided by the net.
 *
 * Load weights via AZAI.setWeights(obj) where obj = JSON of train/ckpt/policy.json.
 * ===================================================================== */
(function (root, factory) {
  const E = (typeof require !== 'undefined') ? require('./engine.js') : root.Engine;
  const api = factory(E);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AZAI = api;
})(this, function (E) {
  'use strict';
  const COLORS = ['red', 'blue', 'black', 'pink', 'yellow'];
  const ALL_TOKENS = ['red', 'blue', 'black', 'pink', 'yellow', 'purple'];
  const NORMAL_TIERS = ['stage1', 'stage2', 'stage3'];
  const FIELD_TIERS = ['stage1', 'stage2', 'stage3', 'rare', 'legend'];
  const FIELD_SLOTS = { stage1: 4, stage2: 4, stage3: 4, rare: 1, legend: 1 };
  const HAND_MAX = 3, TOKEN_MAX = 10;
  const COLOR_IDX = { red: 0, blue: 1, black: 2, pink: 3, yellow: 4 };
  const TIER_IDX = { stage1: 0, stage2: 1, stage3: 2, rare: 3, legend: 4 };

  // ---- action space (must match engine.py) ----
  const TAKE3 = [];
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) for (let k = j + 1; k < 5; k++) TAKE3.push([i, j, k]);
  const FIELD_ORDER = [];
  for (const t of FIELD_TIERS) for (let s = 0; s < FIELD_SLOTS[t]; s++) FIELD_ORDER.push([t, s]);
  const NORMAL_FIELD_ORDER = FIELD_ORDER.filter(([t]) => NORMAL_TIERS.includes(t));
  const A_TAKE3 = 0, A_TAKE2 = 10, A_TAKE1 = 15, A_CAP_FIELD = 20;
  const A_CAP_RES = A_CAP_FIELD + FIELD_ORDER.length;       // 34
  const A_RES_FIELD = A_CAP_RES + HAND_MAX;                 // 37
  const A_RES_DECK = A_RES_FIELD + NORMAL_FIELD_ORDER.length; // 49
  const A_PASS = A_RES_DECK + 3;                            // 52
  const N_ACTIONS = A_PASS + 1;                             // 53
  const N_FEAT = 380;

  // ---------------- state-field accessors (engine.js state) ----------------
  const me = (s) => s.players[s.turn];
  function bonuses(p, byId) { const b = { red: 0, blue: 0, black: 0, pink: 0, yellow: 0 }; for (const id of p.board) { const c = byId[id]; b[c.bonus] += c.bonusCount || 1; } return b; }
  function score(p, byId) { let v = 0; for (const id of p.board) v += byId[id].vp; return v; }
  function tokenTotal(p) { let t = 0; for (const c of ALL_TOKENS) t += p.tokens[c]; return t; }
  function canAfford(s, p, card) { return E.canAfford(s, p, card); }

  // ---------------- encoder (ports features.py encode) ----------------
  function cardStatic(card) {
    const f = new Float32Array(18);
    f[TIER_IDX[card.tier]] = 1;
    f[5] = card.vp / 5;
    f[6 + COLOR_IDX[card.bonus]] = 1;
    f[11] = (card.bonusCount || 1) / 2;
    for (const c of COLORS) f[12 + COLOR_IDX[c]] = (card.cost[c] || 0) / 7;
    f[17] = card.cost.purple || 0;
    return f;
  }
  function playerBlock(s, pi) {
    const p = s.players[pi], byId = s.byId, b = bonuses(p, byId);
    const o = new Float32Array(17);
    for (const c of COLORS) o[COLOR_IDX[c]] = b[c] / 5;
    for (let i = 0; i < 6; i++) o[5 + i] = p.tokens[ALL_TOKENS[i]] / 10;
    o[11] = score(p, byId) / 18;
    o[12] = p.board.length / 15;
    o[13] = p.reserve.length / 3;
    o[14] = p.buried.length / 10;
    let nr = 0, nl = 0; for (const id of p.board) { const t = byId[id].tier; if (t === 'rare') nr++; else if (t === 'legend') nl++; }
    o[15] = nr / 3; o[16] = nl / 3;
    return o;
  }
  function encode(s) {
    const byId = s.byId, mp = me(s), opp = s.players[(s.turn + 1) % s.numPlayers];
    const b = bonuses(mp, byId);
    const f = new Float32Array(N_FEAT);
    let i = 0;
    for (const c of ALL_TOKENS) f[i++] = s.supply[c] / 7;
    f[i++] = Math.min(s.round, 40) / 40;
    f[i++] = s.lastRound ? 1 : 0;
    f.set(playerBlock(s, s.turn), i); i += 17;
    f.set(playerBlock(s, (s.turn + 1) % s.numPlayers), i); i += 17;
    const boardNames = {};
    for (const id of mp.board) { const c = byId[id]; if (c.evolvesTo) boardNames[c.evolvesTo] = 1; }
    for (const [tier, slot] of FIELD_ORDER) {
      const cid = s.field[tier][slot];
      if (cid == null) { i += 21; continue; }
      const card = byId[cid];
      f[i] = 1;
      f.set(cardStatic(card), i + 1);
      f[i + 19] = canAfford(s, mp, card) ? 1 : 0;
      f[i + 20] = boardNames[card.name] ? 1 : 0;
      i += 21;
    }
    for (let j = 0; j < 3; j++) {
      if (j < mp.reserve.length) {
        const card = byId[mp.reserve[j]];
        f[i] = 1; f[i + 1] = card.vp / 5; f[i + 2 + COLOR_IDX[card.bonus]] = 1;
        for (const c of COLORS) f[i + 7 + COLOR_IDX[c]] = (card.cost[c] || 0) / 7;
        f[i + 12] = canAfford(s, mp, card) ? 1 : 0;
      }
      i += 13;
    }
    for (const t of FIELD_TIERS) f[i++] = s.decks[t].length / 35;
    return f;
  }

  // ---------------- legal actions (ports engine.py legal_actions) ----------------
  function legalActionsIdx(s) {
    if (s.phase === 'gameover') return [];
    const p = me(s), acts = [];
    const avail = COLORS.filter(c => s.supply[c] > 0);
    const aset = new Set(avail);
    for (let k = 0; k < TAKE3.length; k++) if (TAKE3[k].every(i => aset.has(COLORS[i]))) acts.push(A_TAKE3 + k);
    for (let i = 0; i < 5; i++) if (s.supply[COLORS[i]] >= 4) acts.push(A_TAKE2 + i);
    if (avail.length < 3) for (let i = 0; i < 5; i++) if (s.supply[COLORS[i]] > 0) acts.push(A_TAKE1 + i);
    for (let j = 0; j < FIELD_ORDER.length; j++) { const [t, sl] = FIELD_ORDER[j]; const cid = s.field[t][sl]; if (cid != null && canAfford(s, p, s.byId[cid])) acts.push(A_CAP_FIELD + j); }
    for (let j = 0; j < p.reserve.length; j++) if (canAfford(s, p, s.byId[p.reserve[j]])) acts.push(A_CAP_RES + j);
    if (p.reserve.length < HAND_MAX) {
      for (let j = 0; j < NORMAL_FIELD_ORDER.length; j++) { const [t, sl] = NORMAL_FIELD_ORDER[j]; if (s.field[t][sl] != null) acts.push(A_RES_FIELD + j); }
      for (let i = 0; i < 3; i++) if (s.decks[NORMAL_TIERS[i]].length) acts.push(A_RES_DECK + i);
    }
    if (!acts.length) acts.push(A_PASS);
    return acts;
  }
  function legalMask(s) { const m = new Float32Array(N_ACTIONS); for (const a of legalActionsIdx(s)) m[a] = 1; return m; }

  // ---------------- apply action + auto-resolve (ports engine.py step) ----------------
  function applyIdx(s, a) {
    const p = me(s);
    if (a < A_TAKE2) { const combo = TAKE3[a - A_TAKE3]; E.actionTake(s, combo.map(i => COLORS[i])); }
    else if (a < A_TAKE1) { const c = COLORS[a - A_TAKE2]; E.actionTake(s, [c, c]); }
    else if (a < A_CAP_FIELD) { const c = COLORS[a - A_TAKE1]; E.actionTake(s, [c]); }
    else if (a < A_CAP_RES) { const [t, sl] = FIELD_ORDER[a - A_CAP_FIELD]; E.actionCapture(s, s.field[t][sl]); }
    else if (a < A_RES_FIELD) { E.actionCapture(s, p.reserve[a - A_CAP_RES]); }
    else if (a < A_RES_DECK) { const [t, sl] = NORMAL_FIELD_ORDER[a - A_RES_FIELD]; E.actionReserve(s, { fromField: s.field[t][sl] }); }
    else if (a < A_PASS) { E.actionReserve(s, { fromDeck: NORMAL_TIERS[a - A_RES_DECK] }); }
    else { E.actionPass(s); }
  }
  function autoDiscard(s) {
    const p = me(s), b = bonuses(p, s.byId);
    while (E.needsDiscard(s, p)) {
      let best = null, bk = null;
      for (const c of COLORS) if (p.tokens[c] > 0) { const k = p.tokens[c] * 100 + b[c]; if (bk == null || k > bk) { bk = k; best = c; } }
      if (best == null) best = 'purple';
      E.actionDiscard(s, best);
    }
  }
  function autoEvolve(s) {
    const p = me(s);
    const opts = E.evolutionOptions(s, p).map(o => ({ o, gain: s.byId[o.toId].vp - s.byId[o.fromId].vp }));
    const good = opts.filter(x => x.gain > 0);
    if (!good.length) return;
    good.sort((x, y) => (y.gain - x.gain) || ((x.o.payColor + x.o.payMaster) - (y.o.payColor + y.o.payMaster)));
    E.actionEvolve(s, good[0].o.fromId, good[0].o.toId);
  }
  function stepAuto(s, a) { applyIdx(s, a); autoDiscard(s); autoEvolve(s); E.endTurn(s); }

  // ---------------- net forward (ports net.py PVNet) ----------------
  let W = null, META = null;
  function setWeights(obj) { W = obj.weights; META = obj.meta; }
  function hasWeights() { return W != null; }
  function matvec(Wm, x, bias) { const out = new Float32Array(Wm.length); for (let o = 0; o < Wm.length; o++) { const row = Wm[o]; let s = bias ? bias[o] : 0; for (let k = 0; k < row.length; k++) s += row[k] * x[k]; out[o] = s; } return out; }
  function relu(v) { const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] > 0 ? v[i] : 0; return o; }
  function layernorm(v, g, bta) { let m = 0; for (let i = 0; i < v.length; i++) m += v[i]; m /= v.length; let va = 0; for (let i = 0; i < v.length; i++) { const d = v[i] - m; va += d * d; } va /= v.length; const inv = 1 / Math.sqrt(va + 1e-5); const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = (v[i] - m) * inv * g[i] + bta[i]; return o; }
  function forward(x, mask) {
    let h = relu(matvec(W['inp.weight'], x, W['inp.bias']));
    const blocks = META.blocks;
    for (let k = 0; k < blocks; k++) {
      const n = layernorm(h, W['bns.' + k + '.weight'], W['bns.' + k + '.bias']);
      const f = relu(matvec(W['fcs.' + k + '.weight'], n, W['fcs.' + k + '.bias']));
      for (let i = 0; i < h.length; i++) h[i] += f[i];
    }
    const logits = matvec(W['policy.weight'], h, W['policy.bias']);
    // masked softmax
    let mx = -1e30; for (let i = 0; i < N_ACTIONS; i++) { if (mask[i] < 0.5) logits[i] = -1e30; else if (logits[i] > mx) mx = logits[i]; }
    let sum = 0; const p = new Float32Array(N_ACTIONS);
    for (let i = 0; i < N_ACTIONS; i++) { if (mask[i] < 0.5) { p[i] = 0; continue; } const e = Math.exp(logits[i] - mx); p[i] = e; sum += e; }
    if (sum > 0) for (let i = 0; i < N_ACTIONS; i++) p[i] /= sum;
    const v0 = relu(matvec(W['value.0.weight'], h, W['value.0.bias']));
    const v = Math.tanh(matvec(W['value.2.weight'], v0, W['value.2.bias'])[0]);
    return { policy: p, value: v };
  }
  function infer(s) { return forward(encode(s), legalMask(s)); }

  // ---------------- light MCTS (ports mcts.py) ----------------
  const C_PUCT = 1.6;
  function Node(state) { this.state = state; this.player = state.turn; this.over = state.phase === 'gameover'; this.winner = state.winner; this.expanded = false; this.legal = null; this.P = null; this.N = null; this.Wv = null; this.children = {}; }
  Node.prototype.terminalValue = function () { return this.winner == null ? 0 : (this.winner === this.player ? 1 : -1); };
  function expand(node, prior) {
    node.legal = legalActionsIdx(node.state);
    node.P = prior.slice ? Float32Array.from(prior) : prior;
    let s = 0; for (const a of node.legal) s += node.P[a];
    if (s > 1e-8) { for (let i = 0; i < N_ACTIONS; i++) node.P[i] /= s; } else { node.P = legalMask(node.state); for (let i = 0; i < N_ACTIONS; i++) node.P[i] /= node.legal.length; }
    node.N = new Float32Array(N_ACTIONS); node.Wv = new Float32Array(N_ACTIONS); node.expanded = true;
  }
  function childState(state, a) { const c = E.clone(state); stepAuto(c, a); return c; }
  function mctsMove(state, sims) {
    const root = new Node(E.clone(state));
    { const r = infer(root.state); expand(root, r.policy); }
    for (let it = 0; it < sims; it++) {
      let node = root; const path = [];
      while (true) {
        if (node.over || !node.expanded) break;
        const legal = node.legal; let totN = 0; for (const a of legal) totN += node.N[a];
        const sq = Math.sqrt(totN) + 1e-8; let ba = legal[0], bs = -1e30;
        for (const a of legal) { const q = node.N[a] > 0 ? node.Wv[a] / node.N[a] : 0; const u = C_PUCT * node.P[a] * sq / (1 + node.N[a]); const sc = q + u; if (sc > bs) { bs = sc; ba = a; } }
        let ch = node.children[ba];
        if (!ch) { ch = new Node(childState(node.state, ba)); node.children[ba] = ch; }
        path.push([node, ba]); node = ch;
        if (!node.expanded && !node.over) break;
      }
      let vref;
      if (node.over) vref = node.terminalValue();
      else { const r = infer(node.state); expand(node, r.policy); vref = r.value; }
      for (const [n, a] of path) { const v = (n.player === node.player) ? vref : -vref; n.N[a] += 1; n.Wv[a] += v; }
    }
    let ba = root.legal[0], bn = -1;
    for (const a of root.legal) if (root.N[a] > bn) { bn = root.N[a]; ba = a; }
    return ba;
  }

  // ---------------- public: play a full turn on engine.js state G ----------------
  function playTurn(G, opts) {
    opts = opts || {};
    const sims = opts.sims || 120;
    const a = hasWeights() ? mctsMove(G, sims) : pickByEval(G);
    stepAuto(G, a);
    return a;
  }
  // decode an action index into {type, colors|cardId|deck} for the UI's move animation
  function decodeAction(s, a) {
    if (a < A_TAKE2) return { type: 'take', colors: TAKE3[a - A_TAKE3].map(i => COLORS[i]) };
    if (a < A_TAKE1) { const c = COLORS[a - A_TAKE2]; return { type: 'take', colors: [c, c] }; }
    if (a < A_CAP_FIELD) return { type: 'take', colors: [COLORS[a - A_TAKE1]] };
    if (a < A_CAP_RES) { const [t, sl] = FIELD_ORDER[a - A_CAP_FIELD]; return { type: 'capture', cardId: s.field[t][sl] }; }
    if (a < A_RES_FIELD) return { type: 'capture', cardId: s.players[s.turn].reserve[a - A_CAP_RES] };
    if (a < A_RES_DECK) { const [t, sl] = NORMAL_FIELD_ORDER[a - A_RES_FIELD]; return { type: 'reserve', cardId: s.field[t][sl] }; }
    if (a < A_PASS) return { type: 'reserve', deck: NORMAL_TIERS[a - A_RES_DECK] };
    return { type: 'pass' };
  }
  // fallback when no net loaded: 1-ply by engine score (rough)
  function pickByEval(G) {
    const acts = legalActionsIdx(G); let best = acts[0], bv = -1e30;
    for (const a of acts) { const c = E.clone(G); stepAuto(c, a); const v = score(c.players[G.turn], c.byId); if (v > bv) { bv = v; best = a; } }
    return best;
  }

  return {
    N_ACTIONS, N_FEAT, encode, legalMask, legalActionsIdx, applyIdx, stepAuto,
    setWeights, hasWeights, infer, forward, mctsMove, playTurn, decodeAction,
    A_TAKE3, A_TAKE2, A_TAKE1, A_CAP_FIELD, A_CAP_RES, A_RES_FIELD, A_RES_DECK, A_PASS,
    FIELD_ORDER, NORMAL_FIELD_ORDER, TAKE3, COLORS,
  };
});
