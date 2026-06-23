/* AI sanity & strength tests — node test/ai.test.js */
const assert = require('assert');
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const DB = require('../data/cards.json');

function randomTurn(g, rng) {
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

let t0 = Date.now(), turns = 0;
function playGame(seed, p0kind, p1kind) {
  const g = E.createGame(DB, { numPlayers: 2, seed });
  const rng = E.makeRng(seed * 3 + 1);
  let plies = 0;
  while (g.phase !== 'gameover' && plies < 3000) {
    const kind = g.turn === 0 ? p0kind : p1kind;
    if (kind === 'ai') { AI.playTurn(g, { difficulty: 'hard' }); turns++; }
    else randomTurn(g, rng);
    plies++;
  }
  return g;
}

// 1) AI vs AI terminates quickly with a valid winner
let maxPlies = 0;
for (let i = 0; i < 20; i++) {
  const g = playGame(200 + i, 'ai', 'ai');
  assert.strictEqual(g.phase, 'gameover', 'AIvAI game ' + i + ' finished');
  const scores = g.players.map(p => E.scoreOf(g, p));
  assert.ok(Math.max(...scores) >= E.WIN_SCORE);
  maxPlies = Math.max(maxPlies, g.round * 2);
}
console.log('  ✓ AI vs AI: 20 games all terminate (<=' + maxPlies + ' rounds)');

// 2) AI beats greedy-random decisively
let aiWins = 0, games = 40;
for (let i = 0; i < games; i++) {
  // alternate seats to remove first-move bias
  const aiSeat = i % 2;
  const g = playGame(500 + i, aiSeat === 0 ? 'ai' : 'rand', aiSeat === 0 ? 'rand' : 'ai');
  if (g.winner === aiSeat) aiWins++;
}
const rate = aiWins / games;
console.log(`  ✓ AI vs greedy-random: AI won ${aiWins}/${games} (${(rate * 100).toFixed(0)}%)`);
assert.ok(rate >= 0.8, 'AI should beat greedy-random >=80% (got ' + (rate * 100).toFixed(0) + '%)');

// 3) per-turn latency is acceptable for UI
const avgMs = (Date.now() - t0) / Math.max(turns, 1);
console.log(`  ✓ avg AI turn latency ~${avgMs.toFixed(1)} ms over ${turns} AI turns`);
assert.ok(avgMs < 250, 'AI turn should be < 250ms (got ' + avgMs.toFixed(0) + ')');

// 4) typical game length is humane (not a 200-turn slog)
const lengths = [];
for (let i = 0; i < 10; i++) { const g = playGame(900 + i, 'ai', 'ai'); lengths.push(g.round); }
const avgRounds = lengths.reduce((a, b) => a + b, 0) / lengths.length;
console.log(`  ✓ avg AI-vs-AI game length ~${avgRounds.toFixed(1)} rounds`);
assert.ok(avgRounds >= 8 && avgRounds <= 60, 'game length sane');

console.log('\nAI tests passed.');
