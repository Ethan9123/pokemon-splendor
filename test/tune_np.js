/* Per-player-count SPSA tuner with ANTITHETIC / common-random-number fitness (low variance):
 * for each base seed, rotate the candidate through ALL np seats on the SAME deck (controls seat+deck),
 * candidate-win-rate vs the current DEFAULT_W. Tunes to beat the (already-tuned) baseline AT THAT COUNT.
 *   node test/tune_np.js [np] [iters] [seedsPerEval] [seedBase]
 */
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const DB = require('../data/cards.json');

const NP = parseInt(process.argv[2] || '3', 10);
const ITERS = parseInt(process.argv[3] || '90', 10);
const SPE = parseInt(process.argv[4] || '16', 10);   // base seeds per evaluation (×NP games each)
const SEEDBASE = parseInt(process.argv[5] || '600000', 10);

const KEYS = Object.keys(AI.DEFAULT_W);
const BASE = AI.DEFAULT_W;
const vecToW = (t) => { const w = {}; KEYS.forEach((k, i) => w[k] = Math.exp(t[i])); return w; };

function applyPlan(g, plan) {
  if (plan.action) E.applyAction(g, plan.action); else E.actionPass(g);
  for (const c of (plan.discards || [])) E.actionDiscard(g, c);
  if (!g.evolvedThisTurn && plan.evolution) E.actionEvolve(g, plan.evolution.fromId, plan.evolution.toId);
  return E.endTurn(g);
}
// candidate vs BASE, rotate candidate through all np seats on each seed (CRN). Returns candidate win-rate.
function fitness(wCand, seeds) {
  let cw = 0, tot = 0;
  for (const s of seeds) {
    for (let seat = 0; seat < NP; seat++) {
      const g = E.createGame(DB, { numPlayers: NP, seed: s });
      let plies = 0;
      while (g.phase !== 'gameover' && plies < 6000) {
        AI.setWeights(g.turn === seat ? wCand : BASE);
        applyPlan(g, AI.chooseTurn(g, { difficulty: 'hard' }));
        plies++;
      }
      if (g.winner === seat) cw++;
      tot++;
    }
  }
  return cw / tot;
}
const fair = 1 / NP;

let theta = KEYS.map(k => Math.log(BASE[k]));
const a0 = 0.10, c0 = 0.15, A = 10, alpha = 0.602, gamma = 0.101;
let rng = 777 + NP;
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
const VAL_SEEDS = Array.from({ length: 120 }, (_, i) => 900000 + NP * 100000 + i);

let bestTheta = theta.slice(), bestVal = fair;
const t0 = Date.now();
console.log(`SPSA np=${NP}: ${KEYS.length} weights, ${ITERS} iters, ${SPE} seeds/eval (x${NP}), fair=${(fair * 100).toFixed(1)}%`);
for (let k = 0; k < ITERS; k++) {
  const ck = c0 / Math.pow(k + 1, gamma);
  const ak = a0 / Math.pow(k + 1 + A, alpha);
  const delta = KEYS.map(() => rand() < 0.5 ? -1 : 1);
  const seeds = Array.from({ length: SPE }, () => SEEDBASE + Math.floor(rand() * 2000000));
  const yp = fitness(vecToW(theta.map((t, i) => t + ck * delta[i])), seeds);
  const ym = fitness(vecToW(theta.map((t, i) => t - ck * delta[i])), seeds);   // same seeds → CRN
  for (let i = 0; i < theta.length; i++) theta[i] += ak * (yp - ym) / (2 * ck * delta[i]);
  if ((k + 1) % 10 === 0) {
    const v = fitness(vecToW(theta), VAL_SEEDS);
    if (v > bestVal) { bestVal = v; bestTheta = theta.slice(); }
    console.log(`  iter ${k + 1}: val=${(v * 100).toFixed(1)}% best=${(bestVal * 100).toFixed(1)}% (fair ${(fair * 100).toFixed(1)}) (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
}
const finalVal = fitness(vecToW(bestTheta), Array.from({ length: 200 }, (_, i) => 980000 + NP * 50000 + i));
console.log(`FINAL best θ vs base @${NP}p (held-out): ${(finalVal * 100).toFixed(1)}%  (fair ${(fair * 100).toFixed(1)})`);
const wB = vecToW(bestTheta); const r = {}; for (const k of KEYS) r[k] = Math.round(wB[k] * 1000) / 1000;
console.log(`BEST_W_${NP}P=` + JSON.stringify(r));
