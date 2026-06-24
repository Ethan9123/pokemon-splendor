/* Validate the JS determinized-search port vs the 1-ply heuristic.
 * node test/vsearch_tourney.js [games] [sims] [dets]
 * Seats alternated, rotated seeds — mirrors the Python eval methodology. */
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const VS = require('../js/vsearch.js');
const DB = require('../data/cards.json');

const GAMES = parseInt(process.argv[2] || '40', 10);
const SIMS = parseInt(process.argv[3] || '96', 10);
const DETS = parseInt(process.argv[4] || '2', 10);
const SEED0 = parseInt(process.argv[5] || '30000', 10);   // distinct base → parallel shards of unique games

function applyPlan(g, plan) {
  if (plan.action) E.applyAction(g, plan.action); else E.actionPass(g);
  for (const c of (plan.discards || [])) E.actionDiscard(g, c);
  if (!g.evolvedThisTurn && plan.evolution) E.actionEvolve(g, plan.evolution.fromId, plan.evolution.toId);
  return E.endTurn(g);
}

function play(seed, who0, who1) {
  const g = E.createGame(DB, { numPlayers: 2, seed });
  let plies = 0;
  while (g.phase !== 'gameover' && plies < 4000) {
    const who = g.turn === 0 ? who0 : who1;
    const plan = who === 'vs'
      ? VS.chooseTurn(g, { sims: SIMS, dets: DETS })
      : AI.chooseTurn(g, { difficulty: 'hard' });
    applyPlan(g, plan);
    plies++;
  }
  return g;
}

let aw = 0;
const t = Date.now();
for (let i = 0; i < GAMES; i++) {
  const aseat = i % 2;
  const g = play(SEED0 + i, aseat === 0 ? 'vs' : 'h', aseat === 0 ? 'h' : 'vs');
  if (g.winner === aseat) aw++;
}
const dt = (Date.now() - t) / 1000;
console.log(`VSearch(sims=${SIMS} dets=${DETS}) vs heuristic(hard): ${(aw / GAMES * 100).toFixed(1)}%  (${aw}/${GAMES})  ${dt.toFixed(1)}s  (${(dt / GAMES).toFixed(2)}s/game)`);
