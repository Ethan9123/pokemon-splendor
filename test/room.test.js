/* Headless tests for the online Room authority — run: node test/room.test.js */
const assert = require('assert');
const { Room } = require('../js/room.js');
const E = require('../js/engine.js');
const DB = require('../data/cards.json');
const MEGA = require('../data/megas.json');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e.stack || e.message)); }
}

// a Room wired to an in-memory mailbox per connection
function makeRoom(extra) {
  const inbox = {};
  const room = new Room(Object.assign({ cardDB: DB, maxSeats: 4, send: (cid, msg) => { (inbox[cid] = inbox[cid] || []).push(msg); } }, extra || {}));
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
  room.onMessage('cB', { t: 'takeover', plan: {} });            // 由对手触发（不能替自己代打）
  assert.strictEqual(last('cB', 'state').state.turn, 1, 'turn advanced despite empty plan');
});

test('malformed network action is rejected without crashing the room', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: {} });
  assert.doesNotThrow(() => room.onMessage('cA', { t: 'action', seq: 1, action: null }));
  assert.ok(last('cA', 'reject'), 'bad payload gets a controlled rejection');
  assert.doesNotThrow(() => room.onMessage('cA', { t: 'action', seq: 2, action: { type: 'reserve' } }));
  assert.ok(last('cA', 'reject'), 'missing reserve target gets a controlled rejection');
});

test('takeover cannot discard tokens unless the timed-out player is over the limit', () => {
  const { room } = makeRoom();
  room.now = 0;
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: {} });
  room.G.players[0].tokens.red = 3;
  room.now = 200000;
  room.onMessage('cB', { t: 'takeover', plan: {
    action: TAKE, discards: Array(20).fill('red'), evolution: null,
  } });
  assert.strictEqual(room.G.players[0].tokens.red, 4, 'malicious extra discards ignored');
});

test('takeover applies a planned Mega evolution before ending the turn', () => {
  const { room, last } = makeRoom({ megaDB: MEGA });
  room.now = 0;
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: { megas: true } });
  const mega = MEGA[0], base = DB.find(c => c.name === mega.megaFrom), p = room.G.players[0];
  p.board.push(base.id);
  for (const c of E.ALL_TOKENS) p.tokens[c] = mega.cost[c] || 0;
  room.now = 200000;
  room.onMessage('cB', { t: 'takeover', plan: {
    action: { type: 'takeMega' }, discards: [],
    megaEvolution: { megaId: mega.id, fromId: base.id }, evolution: null,
  } });
  assert.ok(p.board.includes(mega.id) && !p.board.includes(base.id), 'Mega evolution executed by authority');
  assert.strictEqual(last('cB', 'state').state.turn, 1, 'turn advanced after Mega evolution');
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

// ---- 改名 / 再来一局（联机体验改进）----
test('rename: 大厅改名立即广播；观战者无名字；空名被忽略', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', name: 'Alice', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: 'Bob', token: 'tB' });
  room.onMessage('cB', { t: 'name', name: '小明' });
  assert.strictEqual(last('cA', 'roster').players[1].name, '小明', '对手能看到新名字');
  room.onMessage('cB', { t: 'name', name: '   ' });
  assert.strictEqual(last('cA', 'roster').players[1].name, '小明', '空名被忽略');
  room.onMessage('cB', { t: 'name', name: 'A'.repeat(50) });
  assert.strictEqual(last('cA', 'roster').players[1].name.length, 12, '超长名截断');
});

test('rename: 开局后改名同步进游戏状态（计分板/日志跟着变）', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', name: 'Alice', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: 'Bob', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: {} });
  room.onMessage('cB', { t: 'name', name: '小红' });
  assert.strictEqual(last('cA', 'state').state.players[1].name, '小红');
});

test('rematch: 仅房主 + 仅对局结束后；重置回大厅但保留座位与 token', () => {
  const { room, last, clear } = makeRoom();
  room.now = 0;
  room.onMessage('cA', { t: 'join', name: 'Alice', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: 'Bob', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: {} });
  room.onMessage('cA', { t: 'rematch' });
  assert.ok(/还没结束/.test((last('cA', 'reject') || {}).reason || ''), '未结束时应拒绝');
  room.G.phase = 'gameover'; room.G.winner = 0;
  clear();
  room.onMessage('cB', { t: 'rematch' });
  assert.ok(/只有房主/.test((last('cB', 'reject') || {}).reason || ''), '非房主应被拒绝');
  clear();
  room.onMessage('cA', { t: 'rematch' });
  assert.ok(last('cA', 'lobby'), '广播 lobby 让客户端回大厅');
  assert.ok(last('cB', 'lobby'), '对手也回大厅');
  assert.strictEqual(room.started, false);
  assert.strictEqual(room.G, null);
  assert.strictEqual(room.seats.length, 2, '座位保留');
  assert.strictEqual(room.seats[0].token, 'tA', 'token 保留 → 不用重新发链接');
  clear();
  room.onMessage('cA', { t: 'start', opts: {} });
  assert.ok(last('cA', 'state'), '房主可以直接开下一局');
  assert.ok(last('cB', 'state'), '对手也收到新对局');
});

// ---- 房间码解析（朋友常常直接粘贴邀请链接）----
const NetApi = require('../js/net.js');
test('parseRoomCode: 邀请链接 / 纯房间码 / 带中文前缀 都能解析', () => {
  const P = NetApi.parseRoomCode;
  assert.strictEqual(P('ABC12'), 'ABC12');
  assert.strictEqual(P('  abc12 '), 'ABC12', '大小写与空格');
  assert.strictEqual(P('https://pokemon-splendor.try-board-game.uk/?room=ABC12'), 'ABC12', '整条邀请链接');
  assert.strictEqual(P('http://localhost:8012/?room=abc12'), 'ABC12', '本地链接');
  assert.strictEqual(P('pokemon-splendor.try-board-game.uk/?room=XY7Z9'), 'XY7Z9', '没有协议头的链接');
  assert.strictEqual(P('房间码：ABC12'), 'ABC12', '带中文前缀');
  assert.strictEqual(P('ABC12。'), 'ABC12', '带中文标点');
  assert.strictEqual(P(''), '');
  assert.strictEqual(P('   '), '');
  assert.strictEqual(P(null), '');
});

test('观战者：开局后加入只能观战；房主重开后重新 join 可入座（兑现 UI 的承诺）', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', name: 'A', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: 'B', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: {} });
  // 开局后进来的人只能观战
  room.onMessage('cS', { t: 'join', name: '围观群众', token: 'tS' });
  assert.strictEqual(last('cS', 'welcome').seat, -1, '开局后加入 = 观战');
  // 房主重开
  room.G.phase = 'gameover'; room.G.winner = 0;
  room.onMessage('cA', { t: 'rematch' });
  assert.ok(last('cS', 'lobby'), '观战者也收到回大厅广播');
  // 客户端据此重新 join → 应真的拿到座位（否则 UI 的提示就是空头支票）
  room.onMessage('cS', { t: 'join', name: '围观群众', token: 'tS' });
  const seat = last('cS', 'welcome').seat;
  assert.ok(seat >= 0, '重开后观战者应能入座，实际 seat=' + seat);
  assert.strictEqual(room.seats.length, 3, '应新增一个座位');
  // 新座位在下一局里真的参战
  room.onMessage('cA', { t: 'start', opts: {} });
  assert.strictEqual(last('cS', 'state').state.numPlayers, 3, '下一局是 3 人局');
});

test('观战者：房间已满时重开仍只能观战（不能挤掉别人）', () => {
  const { room, last } = makeRoom({ maxSeats: 2 });
  room.onMessage('cA', { t: 'join', name: 'A', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: 'B', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: {} });
  room.onMessage('cS', { t: 'join', name: 'S', token: 'tS' });
  room.G.phase = 'gameover'; room.G.winner = 0;
  room.onMessage('cA', { t: 'rematch' });
  room.onMessage('cS', { t: 'join', name: 'S', token: 'tS' });
  assert.strictEqual(last('cS', 'welcome').seat, -1, '满员时仍是观战');
  assert.strictEqual(room.seats.length, 2, '不应挤出新座位');
});

test('代打：任何在座玩家都能替超时者触发（修复「房主自己掉线全场卡死」）', () => {
  const { room, last, clear } = makeRoom();
  room.now = 0;
  room.onMessage('cA', { t: 'join', name: 'A', token: 'tA' });   // A = 房主(seat0)
  room.onMessage('cB', { t: 'join', name: 'B', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: {} });                // 轮到房主 A
  // 场景：房主 A 自己掉线/挂机 —— 以前只有房主能代打，且房主不代打自己 → 全场永久卡死
  room.now = 200000;
  clear();
  room.onMessage('cB', { t: 'takeover', plan: { action: TAKE } });   // 由非房主 B 触发
  const s = last('cB', 'state');
  assert.ok(s, '非房主也应能替超时的房主代打');
  assert.strictEqual(s.state.players[0].tokens.red, 1, 'AI 替房主(seat0)行动了');
  assert.strictEqual(s.state.turn, 1, '回合推进到 B');
});

test('代打：不能替自己代打；观战者不能代打', () => {
  const { room, last, clear } = makeRoom();
  room.now = 0;
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: {} });                // 轮到 A
  room.now = 200000;
  clear();
  room.onMessage('cA', { t: 'takeover', plan: { action: TAKE } });   // A 想替自己
  assert.ok(/不能替自己/.test((last('cA', 'reject') || {}).reason || ''), '不能替自己代打');
  assert.ok(!last('cA', 'state'), '不应产生任何状态变化');
  // 观战者
  room.onMessage('cS', { t: 'join', token: 'tS' });
  clear();
  room.onMessage('cS', { t: 'takeover', plan: { action: TAKE } });
  assert.ok(/观战者/.test((last('cS', 'reject') || {}).reason || ''), '观战者不能代打');
});

test('代打：多人同时触发只生效一次（第二个被「尚未超时」挡下）', () => {
  const { room, last, clear } = makeRoom();
  room.now = 0;
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cC', { t: 'join', token: 'tC' });
  room.onMessage('cA', { t: 'start', opts: {} });                // 轮到 A
  room.now = 200000;
  clear();
  room.onMessage('cB', { t: 'takeover', plan: { action: TAKE } });
  const turnAfterFirst = last('cB', 'state').state.turn;
  clear();
  room.onMessage('cC', { t: 'takeover', plan: { action: TAKE } });   // 同一时刻的第二个请求
  assert.ok(/尚未超时/.test((last('cC', 'reject') || {}).reason || ''), '第二个应被计时校验挡下');
  assert.strictEqual(room.G.turn, turnAfterFirst, '回合不应被推进两次');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
