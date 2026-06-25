/* A/B two VSearch configs head-to-head (paired seats, rotated seeds).
 * node test/vsearch_ab.js [games] '<cfgA-json>' '<cfgB-json>' [seed0]
 * A wins reported. Example (node-prior on vs off at 200/3):
 *   node test/vsearch_ab.js 100 '{"sims":200,"dets":3,"nodePrior":true}' '{"sims":200,"dets":3,"nodePrior":false}' 60000 */
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const VS = require('../js/vsearch.js');
const DB = require('../data/cards.json');

const GAMES = parseInt(process.argv[2] || '100', 10);
const CFGA = JSON.parse(process.argv[3] || '{"sims":200,"dets":3,"nodePrior":true}');
const CFGB = JSON.parse(process.argv[4] || '{"sims":200,"dets":3,"nodePrior":false}');
const SEED0 = parseInt(process.argv[5] || '60000', 10);

function applyPlan(g, plan) {
  if (plan.action) E.applyAction(g, plan.action); else E.actionPass(g);
  for (const c of (plan.discards || [])) E.actionDiscard(g, c);
  if (!g.evolvedThisTurn && plan.evolution) E.actionEvolve(g, plan.evolution.fromId, plan.evolution.toId);
  return E.endTurn(g);
}

function play(seed, aFirst) {
  const g = E.createGame(DB, { numPlayers: 2, seed });
  let plies = 0;
  while (g.phase !== 'gameover' && plies < 4000) {
    const aTurn = (g.turn === 0) === aFirst;
    applyPlan(g, VS.chooseTurn(g, aTurn ? CFGA : CFGB));
    plies++;
  }
  return g;
}

let aw = 0, t = Date.now();
for (let i = 0; i < GAMES; i++) {
  const aFirst = (i % 2 === 0);
  const g = play(SEED0 + i, aFirst);
  const aSeat = aFirst ? 0 : 1;
  if (g.winner === aSeat) aw++;
}
const dt = (Date.now() - t) / 1000;
console.log(`A=${process.argv[3]}  vs  B=${process.argv[4]}`);
console.log(`A win-rate: ${(aw / GAMES * 100).toFixed(1)}%  (${aw}/${GAMES})  ${dt.toFixed(1)}s  (${(dt / GAMES).toFixed(2)}s/game)`);
