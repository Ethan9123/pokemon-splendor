/* Headless tests for the online Room authority — run: node test/room.test.js */
const assert = require('assert');
const { Room } = require('../js/room.js');
const E = require('../js/engine.js');
const DB = require('../data/cards.json');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e.stack || e.message)); }
}

// a Room wired to an in-memory mailbox per connection
function makeRoom() {
  const inbox = {};
  const room = new Room({ cardDB: DB, maxSeats: 4, send: (cid, msg) => { (inbox[cid] = inbox[cid] || []).push(msg); } });
  const last = (cid, t) => { const a = (inbox[cid] || []).filter(m => m.t === t); return a[a.length - 1]; };
  const clear = () => { for (const k in inbox) inbox[k] = []; };
  return { room, inbox, last, clear };
}
const TAKE = { type: 'take', colors: ['red', 'blue', 'black'] };

test('two players join → seats assigned, host = seat 0, roster broadcast', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', name: 'Alice', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: 'Bob', token: 'tB' });
  assert.strictEqual(last('cA', 'welcome').seat, 0);
  assert.strictEqual(last('cA', 'welcome').host, true);
  assert.strictEqual(last('cB', 'welcome').seat, 1);
  assert.strictEqual(last('cB', 'welcome').host, false);
  const roster = last('cB', 'roster');
  assert.strictEqual(roster.players.length, 2);
  assert.strictEqual(roster.players[0].name, 'Alice');
  assert.strictEqual(roster.started, false);
});

test('only host (seat 0) can start; start deals a redacted state per seat', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', name: 'A', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: 'B', token: 'tB' });
  room.onMessage('cB', { t: 'start', opts: {} });            // non-host
  assert.ok(last('cB', 'reject'));
  assert.ok(!last('cA', 'state'), 'no game started yet');
  room.onMessage('cA', { t: 'start', opts: { seed: 42 } });  // host
  const sA = last('cA', 'state'), sB = last('cB', 'state');
  assert.strictEqual(sA.state.viewerId, 0);
  assert.strictEqual(sB.state.viewerId, 1);
  assert.strictEqual(sA.state.numPlayers, 2);
  assert.ok(sA.state.decks.stage1.every(x => x === null), 'deck order hidden in broadcast');
});

test('action validated + broadcast; ownership enforced by seat', () => {
  const { room, last, clear } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: { seed: 7 } });
  clear();
  room.onMessage('cB', { t: 'action', seq: 1, action: TAKE });   // seat 1 on seat 0's turn
  assert.ok(last('cB', 'reject'), 'wrong-seat move rejected');
  assert.ok(!last('cB', 'state'), 'no state pushed on a rejected move');
  room.onMessage('cA', { t: 'action', seq: 1, action: TAKE });   // active seat
  assert.strictEqual(last('cA', 'state').state.players[0].tokens.red, 1);
  assert.ok(last('cB', 'state'), 'opponent also receives the new state');
});

test('illegal move (e.g. unaffordable capture) is rejected with the engine error', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: { seed: 7 } });
  const sA = last('cA', 'state');
  const fieldId = sA.state.field.stage3.find(Boolean);          // expensive, unaffordable at game start
  room.onMessage('cA', { t: 'action', seq: 1, action: { type: 'capture', cardId: fieldId } });
  assert.ok(last('cA', 'reject'), 'authority refuses an illegal capture');
});

test('reserve stays hidden from opponent; visible to its owner', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: { seed: 5 } });
  room.onMessage('cA', { t: 'action', seq: 1, action: { type: 'reserve', target: { fromDeck: 'stage1' } } });
  const ownId = last('cA', 'state').state.players[0].reserve[0];
  assert.strictEqual(typeof ownId, 'string');                  // owner sees the real id
  const stub = last('cB', 'state').state.players[0].reserve[0];
  assert.strictEqual(stub.hidden, true);                       // opponent sees only a stub
  assert.strictEqual(stub.tier, 'stage1');
});

test('endTurn advances the seat; the other player may then act', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: { seed: 9 } });
  room.onMessage('cA', { t: 'action', seq: 1, action: TAKE });
  room.onMessage('cA', { t: 'action', seq: 2, action: { type: 'endTurn' } });
  assert.strictEqual(last('cA', 'state').state.turn, 1);
  room.onMessage('cB', { t: 'action', seq: 1, action: TAKE });
  assert.strictEqual(last('cB', 'state').state.players[1].tokens.red, 1);
});

test('reconnect: a NEW connId with the SAME token reclaims the seat + resyncs', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', name: 'A', token: 'tA' });
  room.onMessage('cB1', { t: 'join', name: 'B', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: { seed: 3 } });
  room.onMessage('cA', { t: 'action', seq: 1, action: TAKE });
  room.leave('cB1');
  assert.strictEqual(room.seats[1].connected, false);
  // Bob's tab reloaded → brand-new connId, same stored token
  room.onMessage('cB2', { t: 'join', name: 'B', token: 'tB' });
  assert.strictEqual(last('cB2', 'welcome').seat, 1, 'reclaimed seat 1, not a spectator');
  assert.strictEqual(room.seats[1].connected, true);
  const s = last('cB2', 'state');
  assert.ok(s && s.state.players[0].tokens.red === 1, 'resynced to current game state');
});

test('snapshot/restore round-trips the game (DO persistence across eviction)', () => {
  const { room } = makeRoom();
  room.onMessage('cA', { t: 'join', name: 'A', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: 'B', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: { seed: 21 } });
  room.onMessage('cA', { t: 'action', seq: 1, action: TAKE });
  const snap = JSON.parse(JSON.stringify(room.snapshot()));    // simulate storage round-trip

  // a fresh Room (DO woke on a new isolate) restores and a client reconnects
  const inbox2 = {};
  const room2 = new Room({ cardDB: DB, send: (cid, msg) => { (inbox2[cid] = inbox2[cid] || []).push(msg); } });
  room2.restore(snap);
  assert.strictEqual(room2.started, true);
  assert.strictEqual(room2.G.players[0].tokens.red, 1);
  room2.onMessage('cA2', { t: 'join', name: 'A', token: 'tA' });   // reconnect after restore
  const s = (inbox2['cA2'] || []).filter(m => m.t === 'state').pop();
  assert.ok(s && s.state.players[0].tokens.red === 1, 'continues consistently after restore');
  // and still enforces rules: it's seat 0's turn, seat 1's token can't move
  room2.onMessage('cB2', { t: 'join', name: 'B', token: 'tB' });
  room2.onMessage('cB2', { t: 'action', seq: 1, action: TAKE });
  const rej = (inbox2['cB2'] || []).filter(m => m.t === 'reject').pop();
  assert.ok(rej, 'rules still enforced after restore');
});

// ---- security/robustness regressions (from the adversarial worker review) ----
test('FIX1: a spectator (no seat) gets a fully-redacted view — no reserve leaks', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: {} });
  room.onMessage('cA', { t: 'action', seq: 1, action: { type: 'reserve', target: { fromDeck: 'stage1' } } });
  room.onMessage('cS', { t: 'join', token: 'tS' });               // 3rd conn after start → spectator
  const spec = last('cS', 'state');
  assert.ok(spec, 'spectator receives a state');
  assert.strictEqual(spec.state.viewerId, -1);
  const r0 = spec.state.players[0].reserve[0];
  assert.strictEqual(typeof r0, 'object');                        // a {hidden,tier} stub, NOT a real id
  assert.strictEqual(r0.hidden, true);
  assert.ok(spec.state.decks.stage1.every(x => x === null), 'decks still blanked for spectator');
});

test('FIX2: a client-supplied seed is ignored (server mints its own RNG)', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: { seed: 12345 } });
  const got = last('cA', 'state').state.field.stage1.join(',');
  const ifHonored = E.createGame(DB, { numPlayers: 2, seed: 12345 }).field.stage1.join(',');
  assert.notStrictEqual(got, ifHonored, 'server must not honor the client seed (would leak deck order)');
});

test('FIX3: rebind silently restores a seat by token (hibernation wake, no message storm)', () => {
  const { room } = makeRoom();
  room.onMessage('cA', { t: 'join', name: 'A', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: 'B', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: {} });
  const snap = JSON.parse(JSON.stringify(room.snapshot()));        // DO hibernates → new isolate
  const inbox2 = {};
  const room2 = new Room({ cardDB: DB, send: (cid, msg) => { (inbox2[cid] = inbox2[cid] || []).push(msg); } });
  room2.restore(snap);
  room2.rebind('cA', 'tA'); room2.rebind('cB', 'tB');             // quiet re-attach
  assert.strictEqual((inbox2['cA'] || []).length, 0, 'rebind emits nothing');
  room2.onMessage('cB', { t: 'action', seq: 1, action: TAKE });
  assert.ok((inbox2['cB'] || []).some(m => m.t === 'reject'), 'seat mapping restored: cB blocked on cA turn');
  room2.onMessage('cA', { t: 'action', seq: 1, action: TAKE });
  assert.ok((inbox2['cA'] || []).some(m => m.t === 'state'), 'cA can act after rebind');
});

test('FIX3: a lobby that hibernated BEFORE start is not bricked (host can still start)', () => {
  const { room } = makeRoom();
  room.onMessage('cA', { t: 'join', name: 'A', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: 'B', token: 'tB' });
  const snap = JSON.parse(JSON.stringify(room.snapshot()));        // hibernate while NOT started
  const inbox2 = {};
  const room2 = new Room({ cardDB: DB, send: (cid, msg) => { (inbox2[cid] = inbox2[cid] || []).push(msg); } });
  room2.restore(snap);
  room2.rebind('cA', 'tA'); room2.rebind('cB', 'tB');
  room2.onMessage('cA', { t: 'start', opts: {} });                // host = seat 0
  assert.ok((inbox2['cA'] || []).some(m => m.t === 'state'), 'host could start after pre-start hibernation');
  assert.ok(!(inbox2['cA'] || []).some(m => m.t === 'reject'), 'no 房主 rejection after rebind');
});

// ---- idle/disconnect takeover by the host's AI ----
test('takeover: host-only + must wait the timeout, then plays the active seat & advances', () => {
  const { room, last, clear } = makeRoom();
  room.now = 0;
  room.onMessage('cA', { t: 'join', name: 'A', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: 'B', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: {} });               // turn=0, turnStartedAt=0
  room.onMessage('cA', { t: 'action', seq: 1, action: TAKE });
  room.onMessage('cA', { t: 'action', seq: 2, action: { type: 'endTurn' } }); // → turn=1 (B), turnStartedAt=0
  assert.strictEqual(last('cA', 'state').state.turn, 1);
  clear();

  room.now = 1000;                                              // 1s — before timeout
  room.onMessage('cA', { t: 'takeover', plan: { action: TAKE } });
  assert.ok(last('cA', 'reject') && /超时/.test(last('cA', 'reject').reason), 'rejected before timeout');
  assert.ok(!last('cA', 'state'), 'no state change before timeout');

  room.now = 200000;                                            // past 3 min
  room.onMessage('cB', { t: 'takeover', plan: { action: TAKE } });
  assert.ok(last('cB', 'reject'), 'non-host takeover rejected even after timeout');

  clear();
  room.onMessage('cA', { t: 'takeover', plan: { action: TAKE, discards: [], evolution: null } });
  const s = last('cA', 'state');
  assert.ok(s, 'state broadcast after takeover');
  assert.strictEqual(s.state.players[1].tokens.red, 1, 'AI took a token for the timed-out seat 1');
  assert.strictEqual(s.state.turn, 0, 'turn advanced back to seat 0');
});

test('takeover with an empty/garbage plan still advances the turn (never stalls)', () => {
  const { room, last } = makeRoom();
  room.now = 0;
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: {} });               // turn = 0 (host A)
  room.now = 200000;
  room.onMessage('cA', { t: 'takeover', plan: {} });            // empty → forced legal fallback
  assert.strictEqual(last('cA', 'state').state.turn, 1, 'turn advanced despite empty plan');
});

test('state broadcast carries turnStartedAt / serverNow / turnTimeoutMs for the idle clock', () => {
  const { room, last } = makeRoom();
  room.now = 5000;
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: {} });
  const s = last('cA', 'state');
  assert.strictEqual(s.turnStartedAt, 5000);
  assert.strictEqual(s.serverNow, 5000);
  assert.ok(s.turnTimeoutMs > 0, 'a turn timeout is advertised');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
