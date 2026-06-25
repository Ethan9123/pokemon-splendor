/* Confirm the tuned eval also improves the 2p 究极 SEARCH (not just the 1-ply heuristic).
 * ultra(tuned weights) vs ultra(base weights) head-to-head, 2p, paired seats.
 *   node test/ultra_ab.js '<tuned-weights-json>' [games] */
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const VS = require('../js/vsearch.js');
const DB = require('../data/cards.json');

const TUNED = JSON.parse(process.argv[2]);
const BASE = AI.DEFAULT_W;
const N = parseInt(process.argv[3] || '80', 10);
const CFG = { sims: 200, dets: 3 };

function applyPlan(g, plan) {
  if (plan.action) E.applyAction(g, plan.action); else E.actionPass(g);
  for (const c of (plan.discards || [])) E.actionDiscard(g, c);
  if (!g.evolvedThisTurn && plan.evolution) E.actionEvolve(g, plan.evolution.fromId, plan.evolution.toId);
  return E.endTurn(g);
}
let tw = 0, t = Date.now();
for (let i = 0; i < N; i++) {
  const tFirst = (i % 2 === 0);
  const g = E.createGame(DB, { numPlayers: 2, seed: 800000 + i });
  let plies = 0;
  while (g.phase !== 'gameover' && plies < 4000) {
    const tTurn = (g.turn === 0) === tFirst;
    AI.setWeights(tTurn ? TUNED : BASE);   // search uses AI.evalState → these weights as prior/leaf
    applyPlan(g, VS.chooseTurn(g, CFG));
    plies++;
  }
  if (g.winner === (tFirst ? 0 : 1)) tw++;
}
console.log(`ultra(tuned) vs ultra(base) @2p: ${(tw / N * 100).toFixed(1)}% (${tw}/${N})  ${((Date.now() - t) / 1000).toFixed(0)}s`);
