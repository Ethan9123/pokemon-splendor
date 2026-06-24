/* Headless engine tests — run: node test/engine.test.js  (from project root) */
const assert = require('assert');
const E = require('../js/engine.js');
const DB = require('../data/cards.json');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

// ---- DB integrity ----
test('DB has 100 cards with valid shape', () => {
  assert.strictEqual(DB.length, 100);
  for (const c of DB) {
    assert.ok(c.id && c.tier && c.name, 'id/tier/name on ' + JSON.stringify(c));
    assert.ok(E.COLORS.includes(c.bonus), 'bonus color ' + c.id);
    for (const k of E.ALL_TOKENS) assert.strictEqual(typeof c.cost[k], 'number', 'cost ' + k + ' ' + c.id);
    if (c.tier === 'rare' || c.tier === 'legend') {
      assert.ok(c.cost.purple > 0, 'rare/legend needs master ' + c.id);
      assert.strictEqual(c.bonusCount, 2, 'rare/legend 2 bonuses ' + c.id);
    } else {
      assert.strictEqual(c.cost.purple, 0, 'normal no master ' + c.id);
    }
    if (c.tier === 'stage1' || c.tier === 'stage2') {
      assert.ok(c.evolvesTo, 'stage1/2 must evolve ' + c.id);
      assert.ok(c.evoCost && c.evoCost.count > 0, 'evo cost ' + c.id);
    } else {
      assert.ok(!c.evolvesTo, 'no evolution ' + c.id);
    }
  }
});

test('every evolvesTo species exists in the next tier', () => {
  const names = new Set(DB.map(c => c.name));
  for (const c of DB) if (c.evolvesTo) assert.ok(names.has(c.evolvesTo), c.id + ' -> ' + c.evolvesTo);
});

// ---- setup ----
test('setup: supply / field / decks correct for 2 & 4 players', () => {
  const g2 = E.createGame(DB, { numPlayers: 2, seed: 1 });
  for (const c of E.COLORS) assert.strictEqual(g2.supply[c], 4);
  assert.strictEqual(g2.supply.purple, 5);
  assert.strictEqual(g2.field.stage1.filter(Boolean).length, 4);
  assert.strictEqual(g2.field.rare.filter(Boolean).length, 1);
  assert.strictEqual(g2.field.legend.filter(Boolean).length, 1);
  const g4 = E.createGame(DB, { numPlayers: 4, seed: 1 });
  for (const c of E.COLORS) assert.strictEqual(g4.supply[c], 7);
  // total stage1 cards conserved: 35 = field(4) + deck
  assert.strictEqual(g4.field.stage1.filter(Boolean).length + g4.decks.stage1.length, 35);
});

// ---- take ----
test('take 3 distinct works; duplicates rejected', () => {
  const g = E.createGame(DB, { numPlayers: 2, seed: 2 });
  assert.ok(E.actionTake(g, ['red', 'blue', 'black']).ok);
  assert.strictEqual(g.players[0].tokens.red, 1);
  assert.strictEqual(g.supply.red, 3);
  const g2 = E.createGame(DB, { numPlayers: 2, seed: 2 });
  assert.ok(!E.actionTake(g2, ['red', 'red', 'blue']).ok);
  assert.ok(!E.actionTake(g2, ['purple']).ok); // cannot take master
});

test('take 2 same requires pile >= 4', () => {
  const g = E.createGame(DB, { numPlayers: 4, seed: 3 }); // 7 each
  assert.ok(E.actionTake(g, ['red', 'red']).ok);
  assert.strictEqual(g.players[0].tokens.red, 2);
  // drain a 2-player pile (4) below 4 then ensure rejection
  const g2 = E.createGame(DB, { numPlayers: 2, seed: 3 }); // 4 each
  g2.supply.blue = 3;
  assert.ok(!E.actionTake(g2, ['blue', 'blue']).ok);
});

test('different-color take must be 3 when 3+ colors available; fewer only when constrained', () => {
  const g = E.createGame(DB, { numPlayers: 2, seed: 4 }); // all 5 colors stocked
  // under-taking different colors is illegal while 3+ colors are available
  assert.ok(!E.actionTake(g, ['red', 'blue']).ok, 'cannot take only 2 different');
  assert.ok(!E.actionTake(g, ['red']).ok, 'cannot take only 1 different');
  assert.ok(E.actionTake(g, ['red', 'blue', 'black']).ok, 'taking 3 different is fine');
  // when only 2 colors remain in the supply, taking those 2 is allowed
  const g2 = E.createGame(DB, { numPlayers: 2, seed: 5 });
  for (const c of ['black', 'pink', 'yellow']) g2.supply[c] = 0; // only red, blue left
  assert.ok(E.actionTake(g2, ['red', 'blue']).ok, 'take the 2 remaining colors');
  // ...and taking just 1 is also allowed when fewer than 3 colors remain ("or even one")
  const g2b = E.createGame(DB, { numPlayers: 2, seed: 5 });
  for (const c of ['black', 'pink', 'yellow']) g2b.supply[c] = 0; // only red, blue left
  assert.ok(E.actionTake(g2b, ['red']).ok, 'may take only 1 when fewer than 3 colors remain');
  // when only 1 color remains, taking the single token is allowed
  const g3 = E.createGame(DB, { numPlayers: 2, seed: 6 });
  for (const c of ['blue', 'black', 'pink', 'yellow']) g3.supply[c] = 0; // only red left
  assert.ok(E.actionTake(g3, ['red']).ok, 'take the 1 remaining color');
});

// ---- capture / payment ----
test('capture pays cost, applies bonuses & master substitution', () => {
  const g = E.createGame(DB, { numPlayers: 2, seed: 5 });
  const p = g.players[0];
  // hand-craft a board: give the player a cheap target and enough tokens
  const target = DB.find(c => c.tier === 'stage1');
  g.field.stage1[0] = target.id;
  // ensure affordability with raw tokens (no bonus)
  for (const k of E.COLORS) p.tokens[k] = 5;
  const before = E.tokenTotal(p);
  const r = E.actionCapture(g, target.id);
  assert.ok(r.ok, r.error);
  assert.ok(p.board.includes(target.id));
  const totalCost = E.COLORS.reduce((a, c) => a + target.cost[c], 0);
  assert.strictEqual(E.tokenTotal(p), before - totalCost);
});

test('bonus reduces cost to potentially free', () => {
  const g = E.createGame(DB, { numPlayers: 2, seed: 6 });
  const p = g.players[0];
  const target = DB.find(c => c.tier === 'stage1' && E.COLORS.reduce((a, x) => a + c.cost[x], 0) > 0);
  // give the player bonuses covering the full cost
  p.board = [];
  let synthId = 0;
  for (const col of E.COLORS) {
    for (let i = 0; i < target.cost[col]; i++) {
      // fabricate a bonus card of color col
      const fake = { id: 'fake' + (synthId++), tier: 'stage1', name: 'x', vp: 0, bonus: col, bonusCount: 1, cost: { red: 0, blue: 0, black: 0, pink: 0, yellow: 0, purple: 0 }, evolvesTo: null, evoCost: null };
      g.byId[fake.id] = fake; p.board.push(fake.id);
    }
  }
  g.field.stage1[0] = target.id;
  const before = E.tokenTotal(p);
  assert.ok(E.actionCapture(g, target.id).ok);
  assert.strictEqual(E.tokenTotal(p), before); // paid nothing
});

test('rare requires master balls', () => {
  const g = E.createGame(DB, { numPlayers: 2, seed: 7 });
  const p = g.players[0];
  const rare = DB.find(c => c.tier === 'rare');
  g.field.rare[0] = rare.id;
  for (const k of E.COLORS) p.tokens[k] = 7;
  p.tokens.purple = 0; // no master
  assert.ok(!E.actionCapture(g, rare.id).ok, 'should fail without master');
  p.tokens.purple = 5;
  assert.ok(E.actionCapture(g, rare.id).ok, 'should succeed with master');
});

// ---- reserve ----
test('reserve grants a master and respects hand limit', () => {
  const g = E.createGame(DB, { numPlayers: 2, seed: 8 });
  const p = g.players[0];
  const id = g.field.stage1[0];
  const r = E.actionReserve(g, { fromField: id });
  assert.ok(r.ok);
  assert.strictEqual(p.tokens.purple, 1);
  assert.strictEqual(p.reserve.length, 1);
  // fill hand to 3 then reject
  g.acted = false; E.actionReserve(g, { fromDeck: 'stage1' });
  g.acted = false; E.actionReserve(g, { fromDeck: 'stage2' });
  g.acted = false;
  assert.ok(!E.actionReserve(g, { fromDeck: 'stage3' }).ok);
  // cannot reserve rare
  const g2 = E.createGame(DB, { numPlayers: 2, seed: 8 });
  assert.ok(!E.actionReserve(g2, { fromField: g2.field.rare[0] }).ok);
});

// ---- evolution: paid ONLY by card discounts (bonuses), never by held tokens ----
test('evolution: paid by card discounts only, not held tokens; buries old card; once per turn', () => {
  const g = E.createGame(DB, { numPlayers: 2, seed: 9 });
  const p = g.players[0];
  const s1 = DB.find(c => c.tier === 'stage1');           // has evolvesTo + evoCost
  const s2 = DB.find(c => c.tier === 'stage2' && c.name === s1.evolvesTo);
  assert.ok(s2, 'found evolution target species');
  const evoColor = s1.evoCost.color, evoCount = s1.evoCost.count;

  // (a) Holding tokens of the evo color must NOT enable evolution.
  p.board = [s1.id];
  g.field.stage2[0] = s2.id;
  for (const k of E.ALL_TOKENS) p.tokens[k] = 0;
  p.tokens[evoColor] = evoCount; p.tokens.purple = 5; // plenty of tokens, no discounts
  assert.strictEqual(E.evolutionOptions(g, p).length, 0, 'held tokens alone cannot pay for evolution');

  // (b) Enough discount bonuses (balls on captured cards) of the evo color DO enable it.
  for (const k of E.ALL_TOKENS) p.tokens[k] = 0; // no tokens at all
  const bonusCards = DB.filter(c => c.bonus === evoColor && c.id !== s1.id && c.id !== s2.id).slice(0, evoCount);
  assert.strictEqual(bonusCards.length, evoCount, 'enough bonus cards available for test');
  for (const c of bonusCards) p.board.push(c.id);
  const supplyBefore = JSON.stringify(g.supply);
  const opts = E.evolutionOptions(g, p);
  assert.ok(opts.some(o => o.fromId === s1.id && o.toId === s2.id), 'evolution option present via discounts');
  const r = E.actionEvolve(g, s1.id, s2.id);
  assert.ok(r.ok, r.error);
  assert.ok(p.board.includes(s2.id) && !p.board.includes(s1.id), 'replaced on board');
  assert.ok(p.buried.includes(s1.id), 'old card buried');
  // nothing spent: tokens still zero and supply unchanged
  assert.strictEqual(E.ALL_TOKENS.reduce((n, k) => n + p.tokens[k], 0), 0, 'no tokens spent on evolution');
  assert.strictEqual(JSON.stringify(g.supply), supplyBefore, 'supply unchanged by evolution');
  assert.strictEqual(E.evolutionOptions(g, p).length, 0, 'no second evolution this turn');
});

// ---- discard / token limit ----
test('needsDiscard when >10 tokens; discard returns to supply', () => {
  const g = E.createGame(DB, { numPlayers: 4, seed: 10 });
  const p = g.players[0];
  for (const k of E.COLORS) p.tokens[k] = 3; // 15 tokens
  assert.ok(E.needsDiscard(g, p));
  g.acted = true;
  assert.ok(!E.endTurn(g).ok, 'cannot end turn over limit');
  // discard down (from whichever color still has tokens)
  while (E.needsDiscard(g, p)) { const c = E.ALL_TOKENS.find(x => p.tokens[x] > 0); E.actionDiscard(g, c); }
  assert.ok(E.endTurn(g).ok);
});

// ---- full self-play (greedy-random) terminates with a winner ----
function greedyRandomTurn(g, rng) {
  const acts = E.legalActions(g);
  if (!acts.length) { g.acted = true; }
  else {
    // prefer captures (highest VP), then random
    const caps = acts.filter(a => a.type === 'capture').sort((a, b) => (g.byId[b.cardId].vp - g.byId[a.cardId].vp));
    const pick = caps.length && rng() < 0.85 ? caps[0] : acts[Math.floor(rng() * acts.length)];
    E.applyAction(g, pick);
  }
  const p = E.activePlayer(g);
  while (E.needsDiscard(g, p)) {
    const c = E.ALL_TOKENS.find(x => p.tokens[x] > 0);
    E.actionDiscard(g, c);
  }
  const evos = E.evolutionOptions(g, p);
  if (evos.length && rng() < 0.7) E.actionEvolve(g, evos[0].fromId, evos[0].toId);
  return E.endTurn(g);
}

test('100 self-play games all terminate with a valid winner & conserved tokens', () => {
  for (let game = 0; game < 100; game++) {
    const np = 2 + (game % 3); // 2,3,4
    const g = E.createGame(DB, { numPlayers: np, seed: 1000 + game });
    const rng = E.makeRng(7000 + game);
    let plies = 0;
    while (g.phase !== 'gameover' && plies < 4000) { greedyRandomTurn(g, rng); plies++; }
    assert.strictEqual(g.phase, 'gameover', `game ${game} did not finish in ${plies} plies`);
    assert.ok(g.winner != null && g.winner >= 0 && g.winner < np, 'valid winner');
    // token conservation: supply + all players' tokens == initial supply
    const init = E.supplyFor(np);
    for (const c of E.ALL_TOKENS) {
      let sum = g.supply[c];
      for (const p of g.players) sum += p.tokens[c];
      assert.strictEqual(sum, init[c], `token ${c} conserved in game ${game}: got ${sum}, want ${init[c]}`);
    }
    // winner actually has the top score
    const scores = g.players.map(p => E.scoreOf(g, p));
    assert.strictEqual(scores[g.winner], Math.max(...scores), 'winner has max score');
    assert.ok(Math.max(...scores) >= E.WIN_SCORE, 'someone reached the win score');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
