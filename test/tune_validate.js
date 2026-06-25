/* Validate tuned eval weights BROADLY: vs the current eval at 2p/3p/4p, and vs greedy (anti-overfit).
 * node test/tune_validate.js '<weights-json>' [N]   (weights from tune.js BEST_WEIGHTS) */
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const DB = require('../data/cards.json');

const W = JSON.parse(process.argv[2]);
const BASE = AI.DEFAULT_W;
const N = parseInt(process.argv[3] || '300', 10);

function applyPlan(g, plan) {
  if (plan.action) E.applyAction(g, plan.action); else E.actionPass(g);
  for (const c of (plan.discards || [])) E.actionDiscard(g, c);
  if (!g.evolvedThisTurn && plan.evolution) E.actionEvolve(g, plan.evolution.fromId, plan.evolution.toId);
  return E.endTurn(g);
}
function greedyTurn(g, rng) {
  const acts = E.legalActions(g);
  if (!acts.length) g.acted = true;
  else {
    const caps = acts.filter(a => a.type === 'capture').sort((a, b) => g.byId[b.cardId].vp - g.byId[a.cardId].vp);
    const pick = (caps.length && rng() < 0.85) ? caps[0] : acts[Math.floor(rng() * acts.length)];
    E.applyAction(g, pick);
  }
  const p = E.activePlayer(g);
  while (E.needsDiscard(g, p)) { const c = E.ALL_TOKENS.find(x => p.tokens[x] > 0); E.actionDiscard(g, c); }
  const evos = E.evolutionOptions(g, p); if (evos.length && rng() < 0.7) E.actionEvolve(g, evos[0].fromId, evos[0].toId);
  return E.endTurn(g);
}

// candidate W (seat candSeat) vs BASE everywhere else, np players, candSeat rotated
function npEval(np, n, seed0) {
  let cw = 0;
  for (let i = 0; i < n; i++) {
    const candSeat = i % np;
    const g = E.createGame(DB, { numPlayers: np, seed: seed0 + i });
    let plies = 0;
    while (g.phase !== 'gameover' && plies < 6000) {
      AI.setWeights(g.turn === candSeat ? W : BASE);
      applyPlan(g, AI.chooseTurn(g, { difficulty: 'hard' }));
      plies++;
    }
    if (g.winner === candSeat) cw++;
  }
  return cw / n;
}
function vsGreedy(n, seed0) {
  let w = 0;
  for (let i = 0; i < n; i++) {
    const aiSeat = i % 2;
    const g = E.createGame(DB, { numPlayers: 2, seed: seed0 + i });
    let rng = (seed0 + i) * 3 + 1; const r = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    let plies = 0;
    while (g.phase !== 'gameover' && plies < 4000) {
      if (g.turn === aiSeat) { AI.setWeights(W); applyPlan(g, AI.chooseTurn(g, { difficulty: 'hard' })); }
      else greedyTurn(g, r);
      plies++;
    }
    if (g.winner === aiSeat) w++;
  }
  return w / n;
}

console.log('tuned weights vs CURRENT eval (>50% = stronger), and vs greedy (anti-overfit sanity):');
console.log(`  2p vs base : ${(npEval(2, N, 700000) * 100).toFixed(1)}%  (fair 50)`);
console.log(`  3p vs base : ${(npEval(3, N, 710000) * 100).toFixed(1)}%  (fair 33.3)`);
console.log(`  4p vs base : ${(npEval(4, N, 720000) * 100).toFixed(1)}%  (fair 25)`);
console.log(`  2p vs greedy: ${(vsGreedy(Math.min(N, 200), 730000) * 100).toFixed(1)}%  (current ~91)`);
