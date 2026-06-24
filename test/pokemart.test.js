/* Pokémart expansion — Phase 2 tests (foundation + POTION). run: node test/pokemart.test.js */
const assert = require('assert');
const E = require('../js/engine.js');
const DB = require('../data/cards.json');
const PM = require('../data/pokemart.json');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
const newGame = () => E.createGame(DB, { numPlayers: 2, seed: 7, pokemart: true, pokemartDB: PM });
// stock a player with tokens so they can pay any reasonable cost
function loadTokens(p, n) { for (const c of ['red', 'blue', 'black', 'pink', 'yellow']) p.tokens[c] = n; }

// ---- data integrity ----
test('Pokémart DB: 30 cards, 10 per level, 6 effects x5', () => {
  assert.strictEqual(PM.length, 30);
  const byTier = {}, byEffect = {};
  for (const c of PM) {
    byTier[c.tier] = (byTier[c.tier] || 0) + 1;
    byEffect[c.effect] = (byEffect[c.effect] || 0) + 1;
    assert.ok(E.PM_TIERS.includes(c.tier), 'valid tier ' + c.id);
    for (const k of ['red', 'blue', 'black', 'pink', 'yellow', 'purple']) assert.ok(c.cost[k] >= 0, 'cost ' + c.id);
  }
  assert.deepStrictEqual(byTier, { pmL1: 10, pmL2: 10, pmL3: 10 });
  for (const e of ['copy', 'colorless_master', 'double', 'copy_free', 'free', 'discard_buy'])
    assert.strictEqual(byEffect[e], 5, 'effect count ' + e);
});

test('POTION cards give a double bonus (bonusCount 2) of a real color', () => {
  const potions = PM.filter(c => c.effect === 'double');
  assert.strictEqual(potions.length, 5);
  for (const c of potions) {
    assert.strictEqual(c.bonusCount, 2, c.id);
    assert.ok(E.COLORS.includes(c.bonus), c.id);
    assert.strictEqual(c.tier, 'pmL2', c.id);
  }
});

// ---- base game untouched when expansion is off ----
test('expansion off: no Pokémart state or field tiers', () => {
  const g = E.createGame(DB, { numPlayers: 2, seed: 1 });
  assert.strictEqual(g.pokemartEnabled, false);
  assert.strictEqual(g.pokemartDB.length, 0);
  assert.strictEqual(g.field.pmL1, undefined);
  assert.deepStrictEqual(E.fieldTiers(g), E.FIELD_TIERS);
});

// ---- setup ----
test('setup: each Pokémart level shows 2 face-up cards', () => {
  const g = newGame();
  assert.strictEqual(g.pokemartEnabled, true);
  for (const t of E.PM_TIERS) {
    assert.strictEqual(g.field[t].length, 2, t);
    for (const id of g.field[t]) assert.strictEqual(g.byId[id].tier, t, 'right deck ' + t);
  }
  // 10 per deck minus 2 revealed = 8 left
  for (const t of E.PM_TIERS) assert.strictEqual(g.decks[t].length, 8, t);
});

// ---- capture a POTION ----
test('capture POTION: grants 2 same-color bonuses and refills the slot', () => {
  const g = newGame();
  const p = E.activePlayer(g);
  loadTokens(p, 10); p.tokens.purple = 5;
  // ensure a POTION is on offer; if not, force one into the pmL2 field slot
  let potionId = g.field.pmL2.find(id => g.byId[id].effect === 'double');
  if (!potionId) { potionId = PM.find(c => c.effect === 'double').id; g.field.pmL2[0] = potionId; }
  const potion = g.byId[potionId];
  const before = E.bonuses(g, p)[potion.bonus];
  const r = E.actionCapture(g, potionId);
  assert.ok(r.ok, r.error);
  assert.strictEqual(E.bonuses(g, p)[potion.bonus], before + 2, 'double bonus applied');
  assert.ok(p.board.includes(potionId), 'on board');
  assert.ok(!g.field.pmL2.includes(potionId), 'left the field');
  assert.strictEqual(g.field.pmL2.filter(Boolean).length, 2, 'slot refilled');
});

// ---- reserve a Pokémart card ----
test('reserve a Pokémart card: moves to hand, grants a master ball, refills', () => {
  const g = newGame();
  const p = E.activePlayer(g);
  const id = g.field.pmL1[0];
  const beforePurple = p.tokens.purple;
  const r = E.actionReserve(g, { fromField: id });
  assert.ok(r.ok, r.error);
  assert.ok(p.reserve.includes(id), 'in reserve');
  assert.strictEqual(p.tokens.purple, beforePurple + 1, 'got a master ball');
  assert.strictEqual(g.field.pmL1.filter(Boolean).length, 2, 'refilled');
});

// ---- not-yet-implemented effects are rejected, not silently mishandled ----
test('capturing a not-yet-live effect (copy_free) is rejected, not silently mishandled', () => {
  const g = newGame();
  const p = E.activePlayer(g);
  loadTokens(p, 10); p.tokens.purple = 5;
  const id = PM.find(c => c.effect === 'copy_free').id;
  g.field.pmL2[0] = id;
  const r = E.actionCapture(g, id);
  assert.ok(!r.ok, 'should be rejected');
  assert.ok(/待实现/.test(r.error), 'clear deferral message: ' + r.error);
  // and legalActions must not offer it
  assert.ok(!E.legalActions(g).some(a => a.type === 'capture' && a.cardId === id), 'not in legal moves');
});

// ---- clone (AI search) keeps Pokémart state ----
test('clone preserves Pokémart field + flag', () => {
  const g = newGame();
  const c = E.clone(g);
  assert.strictEqual(c.pokemartEnabled, true);
  assert.strictEqual(c.field.pmL2.length, 2);
  assert.strictEqual(c.byId[c.field.pmL2[0]].tier, 'pmL2');
});

// =================== Phase 3: interactive effects ===================
const give = (g, p, color, n) => { // stack n real bonus cards of a color onto board
  const ids = DB.filter(c => c.bonus === color).map(c => c.id);
  for (let i = 0; i < n; i++) p.board.push(ids[i]);
};
const pmId = (effect, color) => PM.find(c => c.effect === effect && (color ? c.bonus === color : true)).id ||
  PM.find(c => c.effect === effect).id;

test('copy (EVOLVE STONE): associates with an owned bonus card and adds that bonus', () => {
  const g = newGame();
  const p = E.activePlayer(g);
  loadTokens(p, 10); p.tokens.purple = 5;
  give(g, p, 'red', 1); // own a red bonus card
  const target = p.board[0];
  const stone = PM.find(c => c.effect === 'copy').id;
  g.field.pmL1[0] = stone;
  const redBefore = E.bonuses(g, p).red; // 1
  const r = E.actionCapture(g, stone, { copyTargetId: target });
  assert.ok(r.ok, r.error);
  assert.strictEqual(p.assoc[stone], 'red', 'association stored');
  assert.strictEqual(E.bonuses(g, p).red, redBefore + 1, 'copy card now grants red');
  assert.strictEqual(E.effBonusColor(g, p, stone), 'red');
});

test('copy (EVOLVE STONE): rejected when you own no bonus card', () => {
  const g = newGame();
  const p = E.activePlayer(g);
  loadTokens(p, 10); p.tokens.purple = 5;
  const stone = PM.find(c => c.effect === 'copy').id;
  g.field.pmL1[0] = stone;
  const r = E.actionCapture(g, stone, {});
  assert.ok(!r.ok && /带奖励/.test(r.error), 'must already own a bonus card: ' + r.error);
});

test('colorless_master (POKÉDEX): discardable as 2 virtual master balls', () => {
  const g = newGame();
  const p = E.activePlayer(g);
  // put a POKÉDEX on the board to spend, and a costly target on offer
  const dex = PM.find(c => c.effect === 'colorless_master').id;
  p.board.push(dex);
  assert.strictEqual(E.effBonusColor(g, p, dex), null, 'POKÉDEX gives no bonus');
  // target: a normal stage1 card; pay it entirely with 2 virtual + tokens
  const target = DB.find(c => c.tier === 'stage1');
  g.field.stage1[0] = target.id;
  const totalCost = E.COLORS.reduce((a, c) => a + (target.cost[c] || 0), 0);
  // give just enough non-purple tokens to cover all but 2 of the cost, 0 real master
  loadTokens(p, 10); p.tokens.purple = 0;
  const r = E.actionCapture(g, target.id, { spendPokedex: [dex] });
  assert.ok(r.ok, r.error);
  assert.ok(!p.board.includes(dex), 'POKÉDEX consumed (out of game)');
  assert.ok(p.board.includes(target.id), 'target captured with no real master balls');
});

test('discard_buy (REPEL): no token cost, discards 2 owned cards of its colour', () => {
  const g = newGame();
  const p = E.activePlayer(g);
  const repel = PM.find(c => c.effect === 'discard_buy').id;
  const color = g.byId[repel].effectParam.discardColor;
  give(g, p, color, 2); // own exactly 2 of the required colour
  const ownedBefore = p.board.slice();
  g.field.pmL3[0] = repel;
  const tokensBefore = E.tokenTotal(p);
  const r = E.actionCapture(g, repel, { discardCards: ownedBefore.slice(0, 2) });
  assert.ok(r.ok, r.error);
  assert.strictEqual(E.tokenTotal(p), tokensBefore, 'no tokens spent');
  assert.ok(p.board.includes(repel), 'REPEL acquired');
  for (const id of ownedBefore.slice(0, 2)) assert.ok(!p.board.includes(id), 'discarded ' + id);
});

test('discard_buy (REPEL): rejected without enough cards of the colour', () => {
  const g = newGame();
  const p = E.activePlayer(g);
  const repel = PM.find(c => c.effect === 'discard_buy').id;
  g.field.pmL3[0] = repel;
  const r = E.actionCapture(g, repel, {});
  assert.ok(!r.ok && /需要弃掉/.test(r.error), 'needs enough cards: ' + r.error);
});

test('copy_free / free still deferred to Phase 4', () => {
  const g = newGame();
  const p = E.activePlayer(g);
  loadTokens(p, 10); p.tokens.purple = 5;
  for (const eff of ['copy_free', 'free']) {
    const id = PM.find(c => c.effect === eff).id;
    g.field[g.byId[id].tier][0] = id;
    const r = E.actionCapture(g, id, {});
    assert.ok(!r.ok && /待实现/.test(r.error), eff + ' deferred: ' + r.error);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
