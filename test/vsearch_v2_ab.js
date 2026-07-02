/* A/B the rewritten VSearch v2 (js/vsearch.js) vs the frozen v1 baseline.
 * Paired seats, rotated seeds. Reports v2's winrate.
 * node test/vsearch_v2_ab.js [games] '<v2cfg>' '<v1cfg>' [seed0] */
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const V2 = require('../js/vsearch.js');
const V1 = require('./vsearch_v1_frozen.js');
const DB = require('../data/cards.json');

const GAMES = parseInt(process.argv[2] || '50', 10);
const CFG2 = JSON.parse(process.argv[3] || '{"sims":200}');
const CFG1 = JSON.parse(process.argv[4] || '{"sims":200,"dets":3}');
const SEED0 = parseInt(process.argv[5] || '110000', 10);

function applyPlan(g, plan) {
  if (plan.action) E.applyAction(g, plan.action); else E.actionPass(g);
  for (const c of (plan.discards || [])) E.actionDiscard(g, c);
  if (!g.evolvedThisTurn && plan.evolution) E.actionEvolve(g, plan.evolution.fromId, plan.evolution.toId);
  return E.endTurn(g);
}

let w2 = 0, t = Date.now();
for (let i = 0; i < GAMES; i++) {
  const v2First = (i % 2 === 0);
  const g = E.createGame(DB, { numPlayers: 2, seed: SEED0 + i });
  let plies = 0;
  while (g.phase !== 'gameover' && plies < 4000) {
    const isV2 = (g.turn === 0) === v2First;
    applyPlan(g, isV2 ? V2.chooseTurn(g, CFG2) : V1.chooseTurn(g, CFG1));
    plies++;
  }
  if (g.winner === (v2First ? 0 : 1)) w2++;
}
const dt = (Date.now() - t) / 1000;
console.log(`v2(${JSON.stringify(CFG2)}) vs v1(${JSON.stringify(CFG1)}): v2 ${(w2 / GAMES * 100).toFixed(1)}% (${w2}/${GAMES})  ${dt.toFixed(0)}s`);
