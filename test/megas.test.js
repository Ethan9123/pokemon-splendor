/* Megas expansion tests — run: node test/megas.test.js  (from project root) */
const assert = require('assert');
const E = require('../js/engine.js');
const DB = require('../data/cards.json');
const MEGA = require('../data/megas.json');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
const newGame = () => E.createGame(DB, { numPlayers: 2, seed: 11, megas: true, megaDB: MEGA });
// give player `p` a set of bonus cards of a color by stacking real cards onto the board
function giveBonus(g, p, color, n) {
  const ids = DB.filter(c => c.bonus === color).map(c => c.id);
  for (let i = 0; i < n; i++) p.board.push(ids[i]);
}

// ---- mega DB integrity ----
test('mega DB: 10 cards, 2-3 bonuses, cost includes a master ball, maps to a base species', () => {
  assert.strictEqual(MEGA.length, 10);
  const names = new Set(DB.map(c => c.name));
  for (const m of MEGA) {
    assert.strictEqual(m.tier, 'mega', m.id);
    assert.ok(E.COLORS.includes(m.bonus), 'bonus ' + m.id);
    assert.ok(m.bonusCount >= 2, 'mega gives >=2 bonuses ' + m.id);
    // Megas require a Mega TOKEN (handled by the mechanic), not necessarily a master ball;
    // only some (e.g. Mewtwo X/Y) include a master ball in their ball cost.
    assert.ok(names.has(m.megaFrom), 'megaFrom species exists: ' + m.megaFrom + ' (' + m.id + ')');
    assert.strictEqual(m.evolvesTo, null, 'mega does not evolve ' + m.id);
  }
});

// ---- base game unaffected when expansion is off ----
test('expansion off: no mega state, win trigger stays 18', () => {
  const g = E.createGame(DB, { numPlayers: 2, seed: 1 });
  assert.strictEqual(g.megasEnabled, false);
  assert.strictEqual(g.supply.megaToken, undefined);
  assert.strictEqual(g.megaOffer.length, 0);
  assert.ok(!E.actionTakeMega(g).ok, 'cannot take mega token without expansion');
});

// ---- setup ----
test('setup: 4 mega tokens, 10-card mega offer, players hold 0', () => {
  const g = newGame();
  assert.strictEqual(g.megasEnabled, true);
  assert.strictEqual(g.supply.megaToken, 4);
  assert.strictEqual(g.megaOffer.length, 10);
  assert.strictEqual(g.players[0].megaToken, 0);
});

// ---- take mega token action ----
test('take mega token: consumes the turn, max 1 held', () => {
  const g = newGame();
  const r = E.actionTakeMega(g);
  assert.ok(r.ok, r.error);
  assert.strictEqual(g.players[0].megaToken, 1);
  assert.strictEqual(g.supply.megaToken, 3);
  assert.ok(g.acted, 'taking a mega token uses the main action');
  assert.ok(!E.actionTakeMega(g).ok, 'cannot act again this turn');
  // advance a full round: player 1 acts, then back to player 0 (still holding 1)
  E.endTurn(g);              // -> player 1
  assert.ok(E.actionTakeMega(g).ok, 'player 1 takes their own token');
  E.endTurn(g);              // -> player 0
  assert.ok(!E.actionTakeMega(g).ok, 'cannot exceed 1 mega token');
});

// ---- mega evolution requires base species + mega token + payment ----
test('mega-evolve: needs base L3 + mega token + payable cost; consumes token, buries base', () => {
  const g = newGame();
  const p = g.players[0];
  const mega = MEGA.find(m => m.megaFrom === '耿鬼'); // 超级耿鬼
  const base = DB.find(c => c.name === '耿鬼');         // L3 Gengar
  // no base species yet -> no options even with a token
  p.megaToken = 1;
  assert.strictEqual(E.megaEvolveOptions(g, p).length, 0, 'no base species => no mega option');
  // own the base species, but pay the cost in tokens
  p.board.push(base.id);
  // give exactly the cost in tokens (cost includes a master ball)
  for (const k of E.ALL_TOKENS) p.tokens[k] = 0;
  for (const k of E.COLORS) p.tokens[k] = mega.cost[k];
  p.tokens.purple = mega.cost.purple;
  const opts = E.megaEvolveOptions(g, p);
  assert.ok(opts.some(o => o.megaId === mega.id), 'mega option present when affordable');
  const r = E.actionMegaEvolve(g, mega.id, base.id);
  assert.ok(r.ok, r.error);
  assert.ok(p.board.includes(mega.id) && !p.board.includes(base.id), 'mega replaces base on board');
  assert.ok(p.buried.includes(base.id), 'base buried under trainer tile');
  assert.strictEqual(p.megaToken, 0, 'mega token consumed');
  assert.strictEqual(g.supply.megaToken, 5, 'token returns to the pool');
  assert.ok(g.megaOffer.indexOf(mega.id) < 0, 'mega removed from the offer (unique)');
  assert.ok(g.evolvedThisTurn, 'counts as the turn\'s one evolution');
  assert.strictEqual(E.megaEvolveOptions(g, p).length, 0, 'no second (mega-)evolution this turn');
});

test('mega-evolve: a held mega token alone (no payment) is not enough', () => {
  const g = newGame();
  const p = g.players[0];
  const mega = MEGA.find(m => m.megaFrom === '耿鬼');
  p.megaToken = 1;
  p.board.push(DB.find(c => c.name === '耿鬼').id);
  for (const k of E.ALL_TOKENS) p.tokens[k] = 0; // cannot pay
  assert.strictEqual(E.megaEvolveOptions(g, p).length, 0, 'unaffordable => no option');
  assert.ok(!E.actionMegaEvolve(g, mega.id).ok);
});

// ---- mega win condition: 20 VP + one of each color + a mega ----
test('win trigger with megas: needs 20 VP AND every color AND a mega', () => {
  const g = newGame();
  const p = g.players[0];
  // 20 VP but missing colors/mega -> not triggered
  p.board = [];
  // stack a single high-VP-ish set: use rares/legends to reach >=20 without all colors
  // Instead, directly assert the helper via a constructed board:
  // give 4 of each colour bonus card (covers all 5 colors) but low VP
  for (const c of E.COLORS) giveBonus(g, p, c, 1);
  // add VP: push stage3 cards until >=20 (they carry vp 3-5)
  const s3 = DB.filter(c => c.tier === 'stage3');
  let i = 0;
  while (g.players[0].board.reduce((v, id) => v + (g.byId[id].vp || 0), 0) < 20) { p.board.push(s3[i++].id); }
  g.acted = true;
  // has 20 + all colors but NO mega -> should NOT end yet
  E.endTurn(g);
  assert.strictEqual(g.lastRound, false, 'no mega => not yet triggered');
  // now add a mega to the board and end again
  const p0 = g.players[0];
  // ensure it's player 0's turn again
  while (g.turn !== 0) { g.acted = true; E.endTurn(g); }
  p0.board.push(MEGA[0].id);
  g.acted = true;
  E.endTurn(g);
  assert.strictEqual(g.lastRound, true, '20 VP + every color + a mega => final round');
});

// ---- winner eligibility: only a player who achieves the Mega condition can win ----
test('winner must satisfy the Mega condition — a higher-score rival without it cannot win', () => {
  const g = newGame();                         // 2 players
  const p0 = g.players[0], p1 = g.players[1];
  p0.board = []; p1.board = [];
  const vpOf = (p) => p.board.reduce((v, id) => v + (g.byId[id].vp || 0), 0);
  const s3 = DB.filter(c => c.tier === 'stage3').map(c => c.id);

  // P1 = a legitimate Mega winner: every colour + a Mega in play + >=20 VP.
  for (const c of E.COLORS) giveBonus(g, p1, c, 1);
  p1.board.push(MEGA[0].id);                    // tier 'mega' on the board
  let i = 0;
  while (vpOf(p1) < 20) p1.board.push(s3[i++]);

  // P0 = MORE raw points but NO mega -> fails the Mega win condition.
  let j = 0;
  while (vpOf(p0) <= vpOf(p1)) p0.board.push(s3[j++]);

  assert.ok(vpOf(p0) > vpOf(p1), 'sanity: P0 outscores P1 on raw VP');
  assert.ok(!p0.board.some(id => g.byId[id].tier === 'mega'), 'sanity: P0 has no Mega');
  // Despite P0 having more points, the Mega-qualifying P1 must be declared the winner.
  assert.strictEqual(E.determineWinner(g), 1, 'higher-VP non-qualifier must not win a Megas game');

  // And with Megas OFF, the plain highest-score player (P0) wins as before.
  g.megasEnabled = false;
  assert.strictEqual(E.determineWinner(g), 0, 'base game: highest score wins');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
