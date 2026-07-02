/* Micro-benchmark the AI hot path: engine clone cost + VSearch sims/sec.
 * node test/ai_bench.js */
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const VS = require('../js/vsearch.js');
const DB = require('../data/cards.json');

// a realistic mid-game state: play 10 heuristic plies from a fixed seed
const g = E.createGame(DB, { numPlayers: 2, seed: 424242 });
for (let i = 0; i < 10 && g.phase !== 'gameover'; i++) AI.playTurn(g, { difficulty: 'hard' });

// 1) clone cost
let t = process.hrtime.bigint();
const CN = 2000;
for (let i = 0; i < CN; i++) E.clone(g);
let dt = Number(process.hrtime.bigint() - t) / 1e6;
console.log(`clone x${CN}: ${dt.toFixed(0)}ms  → ${(dt / CN * 1000).toFixed(1)}µs/clone  (${(CN / dt * 1000).toFixed(0)}/s)`);

// 2) evalState cost
t = process.hrtime.bigint();
const EN = 20000;
for (let i = 0; i < EN; i++) AI.evalState(g, 0, AI.DIFF.hard);
dt = Number(process.hrtime.bigint() - t) / 1e6;
console.log(`evalState x${EN}: ${dt.toFixed(0)}ms → ${(dt / EN * 1000).toFixed(1)}µs/eval`);

// 3) legalActions cost
t = process.hrtime.bigint();
const LN = 5000;
let acts;
for (let i = 0; i < LN; i++) acts = E.legalActions(g);
dt = Number(process.hrtime.bigint() - t) / 1e6;
console.log(`legalActions x${LN}: ${dt.toFixed(0)}ms → ${(dt / LN * 1000).toFixed(1)}µs (branching=${acts.length})`);

// 4) whole-move cost at the shipped config (browser ULTRA_CFG)
for (const cfg of [{ sims: 200, dets: 3 }, { sims: 400, dets: 3 }, { sims: 800, dets: 4 }]) {
  t = process.hrtime.bigint();
  VS.chooseTurn(g, cfg);
  dt = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`VSearch.chooseTurn sims=${cfg.sims} dets=${cfg.dets}: ${dt.toFixed(0)}ms`);
}
