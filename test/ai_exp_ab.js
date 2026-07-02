/* Expansion-rules A/B: NEW ai/engine (expansion-aware) vs the FROZEN shipped
 * behaviour (old engine legalActions + old eval + the ui.js Mega bolt-ons,
 * replicated here so the baseline matches what production actually did).
 * node test/ai_exp_ab.js [games] [mode: megas|pokemart|both|base] [seed0]  */
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const OLDAI = require('./ai_frozen.js');
const DB = require('../data/cards.json');
const MEGA_DB = require('../data/megas.json');
const PM_DB = require('../data/pokemart.json');

const GAMES = parseInt(process.argv[2] || '50', 10);
const MODE = process.argv[3] || 'megas';
const SEED0 = parseInt(process.argv[4] || '140000', 10);
if (process.argv[5]) AI.setWeights(JSON.parse(process.argv[5]));   // optional NEW-side weight overrides
const megas = MODE === 'megas' || MODE === 'both';
const pokemart = MODE === 'pokemart' || MODE === 'both';

// FROZEN seat = old chooseTurn + the exact ui.js bolt-ons it shipped with
function frozenTurn(g) {
  const plan = OLDAI.chooseTurn(g, { difficulty: 'hard' });
  const pid = g.turn, p = g.players[pid];
  let takeMega = false;                       // ui.js aiShouldTakeMega
  if (g.megasEnabled && p.megaToken < 1 && g.supply.megaToken >= 1) {
    for (const id of g.megaOffer) {
      const m = g.byId[id];
      if (p.board.some(b => g.byId[b].name === m.megaFrom) && E.canAfford(g, p, m)) { takeMega = true; break; }
    }
  }
  if (takeMega) E.actionTakeMega(g);
  else if (plan.action) E.applyAction(g, plan.action);
  else E.actionPass(g);
  for (const c of plan.discards) E.actionDiscard(g, c);
  if (g.megasEnabled && !g.evolvedThisTurn) { // ui.js aiTryMegaEvolve
    const opts = E.megaEvolveOptions(g, p);
    let best = null, bg = -1e9;
    for (const o of opts) {
      const gain = (g.byId[o.megaId].vp - g.byId[o.fromId].vp) + (g.byId[o.megaId].bonusCount - 1);
      if (gain > bg) { bg = gain; best = o; }
    }
    if (best) E.actionMegaEvolve(g, best.megaId, best.fromId);
  }
  if (!g.evolvedThisTurn && plan.evolution) E.actionEvolve(g, plan.evolution.fromId, plan.evolution.toId);
  E.endTurn(g);
}

let nw = 0, draws = 0;
const t = Date.now();
for (let i = 0; i < GAMES; i++) {
  const newSeat = i % 2;
  const g = E.createGame(DB, { numPlayers: 2, seed: SEED0 + i, megas, megaDB: MEGA_DB, pokemart, pokemartDB: PM_DB });
  let plies = 0;
  while (g.phase !== 'gameover' && plies < 4000) {
    if (g.turn === newSeat) AI.playTurn(g, { difficulty: 'hard' });
    else frozenTurn(g);
    plies++;
  }
  if (g.winner === newSeat) nw++; else if (g.winner == null) draws++;
}
const dt = (Date.now() - t) / 1000;
console.log(`NEW vs FROZEN [${MODE}]: NEW ${(nw / GAMES * 100).toFixed(1)}% (${nw}/${GAMES}, draws ${draws})  ${dt.toFixed(0)}s`);
