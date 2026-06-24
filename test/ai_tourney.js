/* AI tournament harness — measures a candidate AI vs the v1 baseline and vs greedy.
 * node test/ai_tourney.js [games]
 * Reports win% with seats alternated (no first-move bias). Deterministic by seed. */
const E = require('../js/engine.js');
const NEW = require('../js/ai.js');       // candidate
const OLD = require('./ai_v1.js');    // frozen baseline
const DB = require('../data/cards.json');

const GAMES = parseInt(process.argv[2] || '300', 10);

function greedyTurn(g, rng) {
  const acts = E.legalActions(g);
  if (!acts.length) g.acted = true;
  else {
    const caps = acts.filter(a => a.type === 'capture').sort((a, b) => g.byId[b.cardId].vp - g.byId[a.cardId].vp);
    const pick = (caps.length && rng() < 0.85) ? caps[0] : acts[Math.floor(rng() * acts.length)];
    E.applyAction(g, pick);
  }
  const p = E.activePlayer(g);
  while (E.needsDiscard(g, p)) { const c = E.ALL_TOKENS.find(x => p.tokens[x] > 0); E.actionDiscard(g, c); }
  const evos = E.evolutionOptions(g, p); if (evos.length && rng() < 0.7) E.actionEvolve(g, evos[0].fromId, evos[0].toId);
  return E.endTurn(g);
}
// players: {kind:'ai', api:NEW|OLD, diff} | {kind:'greedy'}
function play(seed, p0, p1) {
  const g = E.createGame(DB, { numPlayers: 2, seed });
  const rng = E.makeRng(seed * 3 + 1);
  let plies = 0;
  while (g.phase !== 'gameover' && plies < 4000) {
    const who = g.turn === 0 ? p0 : p1;
    if (who.kind === 'ai') who.api.playTurn(g, { difficulty: who.diff || 'hard' });
    else greedyTurn(g, rng);
    plies++;
  }
  return g;
}
// returns winrate of A (seats alternated) over n games
function match(A, B, n, seed0) {
  let aw = 0, draws = 0;
  for (let i = 0; i < n; i++) {
    const aSeat = i % 2;
    const g = play(seed0 + i, aSeat === 0 ? A : B, aSeat === 0 ? B : A);
    if (g.winner === aSeat) aw++; else if (g.winner == null) draws++;
  }
  return { rate: aw / n, wins: aw, draws, n };
}

const newAI = { kind: 'ai', api: NEW, diff: 'hard' };
const oldAI = { kind: 'ai', api: OLD, diff: 'hard' };
const greedy = { kind: 'greedy' };

const t = Date.now();
const h2h = match(newAI, oldAI, GAMES, 10000);
const ng = match(newAI, greedy, GAMES, 20000);
const og = match(oldAI, greedy, GAMES, 20000);  // same seeds as ng for fair compare
console.log(`games/match=${GAMES}`);
console.log(`NEW vs OLD(v1) : NEW ${(h2h.rate * 100).toFixed(1)}%  (${h2h.wins}/${GAMES}, draws ${h2h.draws})`);
console.log(`NEW vs greedy  : ${(ng.rate * 100).toFixed(1)}%  (${ng.wins}/${GAMES})`);
console.log(`OLD vs greedy  : ${(og.rate * 100).toFixed(1)}%  (${og.wins}/${GAMES})`);
console.log(`elapsed ${((Date.now() - t) / 1000).toFixed(1)}s`);
