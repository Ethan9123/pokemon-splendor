/* Strength eval for N players + expansions: 1 candidate seat vs (np-1) heuristic seats,
 * candidate seat ROTATED across all positions, fresh seeds. Reports candidate win-rate;
 * fair baseline (equal strength) = 100/np %.
 *   node test/ai_eval.js [np] [mode] [candidate] [games] [seed0]
 *   mode: base | pokemart      candidate: 'hard' or a VSearch cfg JSON
 * e.g. node test/ai_eval.js 3 base '{"sims":200,"dets":3,"nodePrior":true}' 120 70000 */
global.window = global.window || {};
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const VS = require('../js/vsearch.js');
const DB = require('../data/cards.json');
require('../js/megas.js');      // → window.MEGA_DB
require('../js/pokemart.js');   // → window.POKEMART_DB
const PM_DB = global.window.POKEMART_DB;

const NP = parseInt(process.argv[2] || '3', 10);
const MODE = process.argv[3] || 'base';
const CAND = process.argv[4] || '{"sims":200,"dets":3,"nodePrior":true}';
const N = parseInt(process.argv[5] || '120', 10);
const SEED0 = parseInt(process.argv[6] || '70000', 10);

const candIsHard = (CAND === 'hard');
const candCfg = candIsHard ? null : JSON.parse(CAND);
const candPlan = (g) => candIsHard ? AI.chooseTurn(g, { difficulty: 'hard' }) : VS.chooseTurn(g, candCfg);
const oppPlan = (g) => AI.chooseTurn(g, { difficulty: 'hard' });

function gameOpts(seed) {
  const o = { numPlayers: NP, seed };
  if (MODE === 'pokemart') { o.pokemart = true; o.pokemartDB = PM_DB; }
  return o;
}
function applyPlan(g, plan) {
  if (plan.action) E.applyAction(g, plan.action); else E.actionPass(g);
  for (const c of (plan.discards || [])) E.actionDiscard(g, c);
  if (!g.evolvedThisTurn && plan.evolution) E.actionEvolve(g, plan.evolution.fromId, plan.evolution.toId);
  return E.endTurn(g);
}
function play(seed, candSeat) {
  const g = E.createGame(DB, gameOpts(seed));
  let plies = 0;
  while (g.phase !== 'gameover' && plies < 8000) {
    applyPlan(g, (g.turn === candSeat) ? candPlan(g) : oppPlan(g));
    plies++;
  }
  return g;
}

let cw = 0, unfinished = 0, t = Date.now();
for (let i = 0; i < N; i++) {
  const candSeat = i % NP;
  const g = play(SEED0 + i, candSeat);
  if (g.phase !== 'gameover') unfinished++;
  if (g.winner === candSeat) cw++;
}
const dt = (Date.now() - t) / 1000;
console.log(`${MODE} ${NP}p: candidate=${CAND}`);
console.log(`  win-rate ${(cw / N * 100).toFixed(1)}% (${cw}/${N}) vs fair baseline ${(100 / NP).toFixed(1)}%  | unfinished=${unfinished}  ${dt.toFixed(1)}s (${(dt / N).toFixed(2)}s/game)`);
