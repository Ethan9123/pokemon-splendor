/* SPSA tuner for the heuristic eval weights (js/ai.js W).
 * Objective: maximize win-rate of candidate weights vs the FIXED current weights (DEFAULT_W),
 * 2-player self-play, paired/common-seed matches for variance reduction. Keeps the best θ by a
 * held-out validation set. Prints a JSON weights blob to paste back / load.
 *   node test/tune.js [iters] [gamesPerEval] [seedBase]
 */
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const DB = require('../data/cards.json');

const ITERS = parseInt(process.argv[2] || '80', 10);
const NG = parseInt(process.argv[3] || '50', 10);
const SEEDBASE = parseInt(process.argv[4] || '500000', 10);

const KEYS = Object.keys(AI.DEFAULT_W);
const BASE = AI.DEFAULT_W;                 // fixed opponent = current hand-tuned eval

function applyPlan(g, plan) {
  if (plan.action) E.applyAction(g, plan.action); else E.actionPass(g);
  for (const c of (plan.discards || [])) E.actionDiscard(g, c);
  if (!g.evolvedThisTurn && plan.evolution) E.actionEvolve(g, plan.evolution.fromId, plan.evolution.toId);
  return E.endTurn(g);
}
// win-rate of weights wA vs wB over n paired games (seats alternated)
function match(wA, wB, n, seed0) {
  let aw = 0;
  for (let i = 0; i < n; i++) {
    const aFirst = (i % 2 === 0);
    const g = E.createGame(DB, { numPlayers: 2, seed: seed0 + i });
    let plies = 0;
    while (g.phase !== 'gameover' && plies < 4000) {
      const aTurn = (g.turn === 0) === aFirst;
      AI.setWeights(aTurn ? wA : wB);
      applyPlan(g, AI.chooseTurn(g, { difficulty: 'hard' }));
      plies++;
    }
    if (g.winner === (aFirst ? 0 : 1)) aw++;
  }
  return aw / n;
}
const vecToW = (theta) => { const w = {}; KEYS.forEach((k, i) => w[k] = Math.exp(theta[i])); return w; };

// SPSA
let theta = KEYS.map(k => Math.log(BASE[k]));
const a0 = 0.12, c0 = 0.16, A = 10, alpha = 0.602, gamma = 0.101;
// PRNG (no Math.random dependence on global determinism needed, but vary by iter)
let rng = 12345;
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };

let bestTheta = theta.slice(), bestVal = 0.5;
const t0 = Date.now();
console.log(`SPSA: ${KEYS.length} weights, ${ITERS} iters x ${NG} games/eval`);
for (let k = 0; k < ITERS; k++) {
  const ck = c0 / Math.pow(k + 1, gamma);
  const ak = a0 / Math.pow(k + 1 + A, alpha);
  const delta = KEYS.map(() => rand() < 0.5 ? -1 : 1);
  const tp = theta.map((t, i) => t + ck * delta[i]);
  const tm = theta.map((t, i) => t - ck * delta[i]);
  const seed = SEEDBASE + k * 2000;
  const yp = match(vecToW(tp), BASE, NG, seed);
  const ym = match(vecToW(tm), BASE, NG, seed);   // same seeds → variance reduction
  for (let i = 0; i < theta.length; i++) theta[i] += ak * (yp - ym) / (2 * ck * delta[i]);
  if ((k + 1) % 8 === 0) {
    const v = match(vecToW(theta), BASE, 300, 900000);   // held-out validation seeds
    if (v > bestVal) { bestVal = v; bestTheta = theta.slice(); }
    console.log(`  iter ${k + 1}: yp=${yp.toFixed(2)} ym=${ym.toFixed(2)} | val(θ vs base)=${(v * 100).toFixed(1)}% best=${(bestVal * 100).toFixed(1)}% (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
}
// final held-out check of best
const finalVal = match(vecToW(bestTheta), BASE, 600, 950000);
console.log(`FINAL best θ vs base (n=400 held-out): ${(finalVal * 100).toFixed(1)}%`);
const wBest = vecToW(bestTheta);
const rounded = {}; for (const k of KEYS) rounded[k] = Math.round(wBest[k] * 1000) / 1000;
console.log('BEST_WEIGHTS=' + JSON.stringify(rounded));
