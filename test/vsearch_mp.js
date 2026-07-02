/* Multiplayer (3-4p) VSearch vs heuristic(hard) tournament.
 * One VSearch seat (rotated every game) vs hard heuristics in the other seats.
 * Win% compared against fair share (1/numPlayers).
 * node test/vsearch_mp.js [players] [games] '<cfg-json>' [seed0] */
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const VS = require('../js/vsearch.js');
const DB = require('../data/cards.json');

const NP = parseInt(process.argv[2] || '3', 10);
const GAMES = parseInt(process.argv[3] || '30', 10);
const CFG = JSON.parse(process.argv[4] || '{"sims":200,"dets":3}');
const SEED0 = parseInt(process.argv[5] || '90000', 10);

function applyPlan(g, plan) {
  if (plan.action) E.applyAction(g, plan.action); else E.actionPass(g);
  for (const c of (plan.discards || [])) E.actionDiscard(g, c);
  if (!g.evolvedThisTurn && plan.evolution) E.actionEvolve(g, plan.evolution.fromId, plan.evolution.toId);
  return E.endTurn(g);
}

let vw = 0, t = Date.now();
for (let i = 0; i < GAMES; i++) {
  const vseat = i % NP;                       // rotate the search seat: no seat bias
  const g = E.createGame(DB, { numPlayers: NP, seed: SEED0 + i });
  let plies = 0;
  while (g.phase !== 'gameover' && plies < 6000) {
    const plan = (g.turn === vseat)
      ? VS.chooseTurn(g, CFG)
      : AI.chooseTurn(g, { difficulty: 'hard' });
    applyPlan(g, plan);
    plies++;
  }
  if (g.winner === vseat) vw++;
}
const dt = (Date.now() - t) / 1000;
const fair = 100 / NP;
console.log(`VSearch(${JSON.stringify(CFG)}) 1-of-${NP} vs hard: ${(vw / GAMES * 100).toFixed(1)}% (${vw}/${GAMES})  fair=${fair.toFixed(1)}%  ${dt.toFixed(0)}s`);
