/* Lobby features of the online Room authority: bot seats, seat-order shuffle,
 * host identity that survives reordering, server-driven AI turns.
 * run: node test/room_lobby.test.js */
const assert = require('assert');
const { Room } = require('../js/room.js');
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const DB = require('../data/cards.json');
const MEGA = require('../data/megas.json');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e.stack || e.message)); }
}
function makeRoom(extra) {
  const inbox = {};
  const room = new Room(Object.assign({ cardDB: DB, megaDB: MEGA, maxSeats: 4, ai: AI,
    send: (cid, msg) => { (inbox[cid] = inbox[cid] || []).push(msg); } }, extra || {}));
  const last = (cid, t) => { const a = (inbox[cid] || []).filter(m => m.t === t); return a[a.length - 1]; };
  const all = (cid, t) => (inbox[cid] || []).filter(m => m.t === t);
  const clear = () => { for (const k in inbox) inbox[k] = []; };
  return { room, inbox, last, all, clear };
}
const seatOfToken = (room, token) => room.seats.findIndex(s => s.token === token);
const SUPPLY_PER = { 2: 4, 3: 5, 4: 7 };
function assertConserved(g) {
  for (const c of E.COLORS) {
    let tot = g.supply[c]; g.players.forEach(p => { tot += p.tokens[c]; });
    assert.strictEqual(tot, SUPPLY_PER[g.numPlayers], '球守恒失败 ' + c);
  }
}

// ---------------------------------------------------------------- bot seats
test('addAI: 仅房主、仅大厅、最多 4 座；默认难度 normal；名字不重复；在名单里标记为电脑且始终在线', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', name: '小明', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: '阿强', token: 'tB' });
  room.onMessage('cB', { t: 'addAI' });
  assert.ok(/只有房主/.test(last('cB', 'reject').reason), '非房主不能加电脑');
  room.onMessage('cA', { t: 'addAI' });
  room.onMessage('cA', { t: 'addAI', level: 'hard' });
  const r = last('cA', 'roster');
  assert.strictEqual(r.players.length, 4);
  assert.strictEqual(r.players[2].ai, 'normal', '未指定难度 → normal');
  assert.strictEqual(r.players[3].ai, 'hard');
  assert.strictEqual(r.players[2].connected, true, '电脑始终在线');
  assert.notStrictEqual(r.players[2].name, r.players[3].name, '电脑名字不重复');
  assert.strictEqual(r.maxSeats, 4);
  room.onMessage('cA', { t: 'addAI' });
  assert.ok(/座位已满/.test(last('cA', 'reject').reason), '满 4 座后不能再加');
  room.onMessage('cA', { t: 'addAI', level: 'godlike' });
  assert.strictEqual(room.seats.length, 4, '非法难度也不会多开座位');
});

test('addAI / removeAI / aiLevel / shuffle：开局后一律拒绝', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI' });
  room.onMessage('cA', { t: 'start', opts: {} });
  for (const m of [{ t: 'addAI' }, { t: 'removeAI', seat: 1 }, { t: 'aiLevel', seat: 1, level: 'hard' }, { t: 'shuffle' }]) {
    room.onMessage('cA', m);
    assert.ok(/对局进行中/.test(last('cA', 'reject').reason), m.t + ' 开局后应被拒绝');
  }
  assert.strictEqual(room.seats.length, 2);
});

test('aiLevel: 改电脑难度；不能对真人座位改；非法难度拒绝', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI', level: 'easy' });
  room.onMessage('cA', { t: 'aiLevel', seat: 1, level: 'hard' });
  assert.strictEqual(last('cA', 'roster').players[1].ai, 'hard');
  room.onMessage('cA', { t: 'aiLevel', seat: 0, level: 'hard' });
  assert.ok(/不是电脑/.test(last('cA', 'reject').reason), '真人座位不能改难度');
  room.onMessage('cA', { t: 'aiLevel', seat: 1, level: 'ultra' });
  assert.ok(/未知的电脑难度/.test(last('cA', 'reject').reason));
});

test('removeAI: 移除后后面的真人座位前移，且该真人收到新的 welcome 座位号，开局后能正常行动', () => {
  const { room, last, clear } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });   // seat 0 host
  room.onMessage('cA', { t: 'addAI' });                // seat 1 bot
  room.onMessage('cB', { t: 'join', token: 'tB' });   // seat 2 human
  assert.strictEqual(last('cB', 'welcome').seat, 2);
  clear();
  room.onMessage('cA', { t: 'removeAI', seat: 0 });
  assert.ok(/不是电脑/.test(last('cA', 'reject').reason), '不能用 removeAI 踢真人');
  room.onMessage('cA', { t: 'removeAI', seat: 1 });
  assert.strictEqual(room.seats.length, 2);
  assert.strictEqual(last('cB', 'welcome').seat, 1, 'B 的座位号变了必须重新告知');
  assert.strictEqual(room.conns.cB, 1);
  room.onMessage('cA', { t: 'start', opts: {} });
  room.onMessage('cA', { t: 'action', action: { type: 'take', colors: ['red', 'blue', 'black'] } });
  room.onMessage('cA', { t: 'action', action: { type: 'endTurn' } });
  room.onMessage('cB', { t: 'action', action: { type: 'take', colors: ['red', 'blue', 'black'] } });
  assert.strictEqual(room.G.players[1].tokens.red, 1, 'B 以新座位号 1 行动成功');
});

test('真人加入已满（含电脑）的房间：顶替最后一个电脑，不会被挡在门外', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI', level: 'easy' });
  room.onMessage('cA', { t: 'addAI', level: 'normal' });
  room.onMessage('cA', { t: 'addAI', level: 'hard' });
  room.onMessage('cB', { t: 'join', name: '阿强', token: 'tB' });
  assert.strictEqual(last('cB', 'welcome').seat, 3, '顶替最后一个电脑座位');
  const r = last('cA', 'roster');
  assert.strictEqual(r.players.length, 4, '总人数不变');
  assert.strictEqual(r.players.filter(p => p.ai).length, 2, '只替换了一个电脑');
  assert.strictEqual(r.players[3].name, '阿强');
  assert.strictEqual(r.players[3].ai, null);
  const n = last('cA', 'notice');
  assert.ok(n && /阿强/.test(n.msg) && /电脑3/.test(n.msg), '全房间收到「谁顶替了哪个电脑」的提示：' + (n && n.msg));
  assert.ok(last('cB', 'notice'), '加入者自己也看得到');
});

test('房间满员且全是真人：后来者只能观战（不会误伤）', () => {
  const { room, last } = makeRoom({ maxSeats: 2 });
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cC', { t: 'join', token: 'tC' });
  assert.strictEqual(last('cC', 'welcome').seat, -1);
  assert.strictEqual(last('cA', 'notice'), undefined, '普通加入不发替换提示');
});

// ---------------------------------------------------------------- host identity
test('房主身份跟着 token 走：换座后房主不在 0 号位也还是房主；坐到 0 号位的人不会变房主', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  let tries = 0;
  while (seatOfToken(room, 'tA') === 0 && tries++ < 200) room.onMessage('cA', { t: 'shuffle' });
  assert.notStrictEqual(seatOfToken(room, 'tA'), 0, '前提：房主已不在 0 号位');
  assert.strictEqual(last('cA', 'welcome').host, true, '房主收到的 welcome 仍标记 host');
  assert.strictEqual(last('cB', 'welcome').host, false);
  assert.strictEqual(last('cA', 'roster').hostSeat, seatOfToken(room, 'tA'), 'roster.hostSeat 指向房主当前座位');
  room.onMessage('cB', { t: 'start', opts: {} });
  assert.ok(/只有房主/.test(last('cB', 'reject').reason), '坐在 0 号位的非房主不能开局');
  room.onMessage('cA', { t: 'start', opts: {} });
  assert.ok(room.started, '不在 0 号位的房主可以开局');
});

test('房主离线后身份不丢；旧版快照（无 hostToken）恢复时房主=原 0 号位', () => {
  const { room } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.leave('cA');
  room.onMessage('cA2', { t: 'join', token: 'tA' });
  assert.ok(room._isHost('cA2'), '重连回来的房主仍是房主');

  const inbox = {};
  const legacy = new Room({ cardDB: DB, send: (c, m) => { (inbox[c] = inbox[c] || []).push(m); } });
  legacy.restore({ seq: 3, started: false, turnStartedAt: 0, g: null,
    seats: [{ token: 'tA', name: 'A' }, { token: 'tB', name: 'B' }] });
  legacy.onMessage('xA', { t: 'join', token: 'tA' });
  legacy.onMessage('xB', { t: 'join', token: 'tB' });
  assert.strictEqual(inbox.xA.filter(m => m.t === 'welcome').pop().host, true);
  assert.strictEqual(inbox.xB.filter(m => m.t === 'welcome').pop().host, false);
});

// ---------------------------------------------------------------- shuffle
test('shuffle: 仅房主；每次向全员广播（含第几次与先手是谁），座位号变化的人都会收到新 welcome', () => {
  const { room, last, all, clear } = makeRoom();
  room.onMessage('cA', { t: 'join', name: '小明', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: '阿强', token: 'tB' });
  room.onMessage('cA', { t: 'addAI' });
  room.onMessage('cB', { t: 'shuffle' });
  assert.ok(/只有房主/.test(last('cB', 'reject').reason));
  for (let k = 1; k <= 5; k++) {
    clear();
    room.onMessage('cA', { t: 'shuffle' });
    const s = last('cB', 'shuffled');
    assert.ok(s, '非房主也能看到随机结果');
    assert.strictEqual(s.count, k, '重随次数对全员可见');
    assert.strictEqual(s.first, room.seats[0].name, '播报的先手就是当前 0 号位');
    // 每个连接自认为的座位号必须与服务器一致
    for (const [cid, tok] of [['cA', 'tA'], ['cB', 'tB']]) {
      assert.strictEqual(room.conns[cid], seatOfToken(room, tok), cid + ' 连接映射正确');
      const w = all(cid, 'welcome').pop();
      if (w) assert.strictEqual(w.seat, seatOfToken(room, tok), cid + ' welcome 座位号正确');
    }
  }
  assert.strictEqual(room.seats.length, 3, '随机不增减座位');
});

test('shuffle: 均匀随机（3 座 6 种排列，各约 1/6）', () => {
  const { room, clear } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cC', { t: 'join', token: 'tC' });
  const N = 3000, counts = {};
  for (let i = 0; i < N; i++) {
    room.onMessage('cA', { t: 'shuffle' });
    const key = room.seats.map(s => s.token).join(',');
    counts[key] = (counts[key] || 0) + 1;
    if (i % 200 === 0) clear();
  }
  const keys = Object.keys(counts);
  assert.strictEqual(keys.length, 6, '6 种排列都应出现');
  for (const k of keys) assert.ok(Math.abs(counts[k] - N / 6) < 120, '排列 ' + k + ' 次数 ' + counts[k] + ' 偏离 1/6 过多');
});

test('shuffle 后开局：先后手真的按新座位顺序进行（0 号位先走）', () => {
  const { room } = makeRoom();
  room.onMessage('cA', { t: 'join', name: '小明', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: '阿强', token: 'tB' });
  let tries = 0;
  while (seatOfToken(room, 'tB') !== 0 && tries++ < 200) room.onMessage('cA', { t: 'shuffle' });
  assert.strictEqual(seatOfToken(room, 'tB'), 0, '前提：阿强被随机到 0 号位');
  room.onMessage('cA', { t: 'start', opts: {} });
  assert.strictEqual(room.G.turn, 0);
  assert.strictEqual(room.G.players[0].name, '阿强', '游戏内 0 号玩家就是阿强');
  room.onMessage('cA', { t: 'action', action: { type: 'take', colors: ['red', 'blue', 'black'] } });
  assert.ok(!room.G.players.some(p => p.tokens.red), '不是小明的回合，小明不能先走');
  room.onMessage('cB', { t: 'action', action: { type: 'take', colors: ['red', 'blue', 'black'] } });
  assert.strictEqual(room.G.players[0].tokens.red, 1, '阿强先走成功');
});

// ---------------------------------------------------------------- server-driven AI turns
test('开局：电脑座位在游戏里标记为 isAI 且带难度；真人不能替电脑行动；代打不能针对电脑', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI', level: 'hard' });
  room.onMessage('cA', { t: 'start', opts: {} });
  assert.strictEqual(room.G.players[0].isAI, false);
  assert.strictEqual(room.G.players[1].isAI, true);
  assert.strictEqual(room.G.players[1].diff, 'hard');
  assert.strictEqual(last('cA', 'state').state.players[1].isAI, true, '客户端能知道谁是电脑');
  room.onMessage('cA', { t: 'action', action: { type: 'take', colors: ['red', 'blue', 'black'] } });
  room.onMessage('cA', { t: 'action', action: { type: 'endTurn' } });
  assert.ok(room.aiPending(), '轮到电脑');
  room.onMessage('cA', { t: 'action', action: { type: 'take', colors: ['red', 'blue', 'pink'] } });
  assert.ok(last('cA', 'reject'), '真人不能替电脑行动');
  room.now = 10 * 60 * 1000;
  room.onMessage('cA', { t: 'takeover', plan: { action: { type: 'take', colors: ['red', 'blue', 'pink'] } } });
  assert.ok(/电脑的回合由服务器执行/.test(last('cA', 'reject').reason), '不能对电脑回合提交代打计划');
  assert.ok(room.aiPending(), '电脑回合未被外部推进');
});

test('stepAI: 只在电脑回合生效；执行完整一回合并广播给所有人', () => {
  const { room, last, clear } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI' });
  room.onMessage('cA', { t: 'start', opts: {} });
  assert.strictEqual(room.stepAI(), false, '真人回合 stepAI 不做任何事');
  room.onMessage('cA', { t: 'action', action: { type: 'take', colors: ['red', 'blue', 'black'] } });
  room.onMessage('cA', { t: 'action', action: { type: 'endTurn' } });
  clear();
  room.now = 5000;
  assert.strictEqual(room.stepAI(), true);
  assert.strictEqual(room.G.turn, 0, '电脑走完交回真人');
  assert.ok(last('cA', 'state'), '真人收到电脑走完后的状态');
  assert.strictEqual(room.turnStartedAt, 5000, '空闲计时从电脑走完那一刻重新开始');
  assertConserved(room.G);
});

test('stepAI: 没注入 AI 模块或 AI 抛错时也绝不卡住（退化为合法走法）', () => {
  for (const ai of [null, { chooseTurn() { throw new Error('boom'); } }, { chooseTurn() { return { action: { type: 'capture', cardId: 'nope' } }; } }]) {
    const { room } = makeRoom({ ai });
    room.onMessage('cA', { t: 'join', token: 'tA' });
    room.onMessage('cA', { t: 'addAI' });
    room.onMessage('cA', { t: 'start', opts: {} });
    room.onMessage('cA', { t: 'action', action: { type: 'take', colors: ['red', 'blue', 'black'] } });
    room.onMessage('cA', { t: 'action', action: { type: 'endTurn' } });
    assert.ok(room.stepAI());
    assert.strictEqual(room.G.turn, 0, '仍然推进到真人回合');
    assertConserved(room.G);
  }
});

function playOut(room, humanConns, guardMax) {
  let guard = 0;
  while (room.G.phase === 'play' && guard++ < (guardMax || 3000)) {
    if (room.aiPending()) { room.stepAI(); continue; }
    const seat = room.G.turn;
    const cid = humanConns[seat];
    const plan = AI.chooseTurn(room.G, { difficulty: 'easy' });
    room.onMessage(cid, { t: 'action', action: plan.action || { type: 'pass' } });
    const p = room.G.players[seat];
    let d = 0;
    while (E.needsDiscard(room.G, p) && d++ < 20) {
      room.onMessage(cid, { t: 'action', action: { type: 'discard', color: E.ALL_TOKENS.find(c => p.tokens[c] > 0) } });
    }
    room.onMessage(cid, { t: 'action', action: { type: 'endTurn' } });
    assertConserved(room.G);
  }
  return guard;
}

test('完整对局：1 真人 + 1 电脑（2 人），打到结束且全程守恒', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI', level: 'normal' });
  room.onMessage('cA', { t: 'start', opts: {} });
  const plies = playOut(room, { 0: 'cA' });
  assert.strictEqual(room.G.phase, 'gameover', '对局应在 ' + plies + ' 步内结束');
  assert.ok(last('cA', 'over'), '真人收到结束广播');
});

test('完整对局：1 真人 + 3 电脑（4 人，Megas），打乱座位后开局，打到结束', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI', level: 'easy' });
  room.onMessage('cA', { t: 'addAI', level: 'normal' });
  room.onMessage('cA', { t: 'addAI', level: 'hard' });
  room.onMessage('cA', { t: 'shuffle' });
  room.onMessage('cA', { t: 'start', opts: { megas: true } });
  const humanSeat = seatOfToken(room, 'tA');
  const plies = playOut(room, { [humanSeat]: 'cA' });
  assert.strictEqual(room.G.phase, 'gameover', '对局应在 ' + plies + ' 步内结束');
  assert.ok(last('cA', 'over'));
});

test('再来一局：电脑座位与难度保留，随机次数清零', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI', level: 'hard' });
  room.onMessage('cA', { t: 'shuffle' });
  room.onMessage('cA', { t: 'start', opts: {} });
  room.G.phase = 'gameover'; room.G.winner = 0;
  room.onMessage('cA', { t: 'rematch' });
  const r = last('cA', 'roster');
  assert.strictEqual(r.players.filter(p => p.ai === 'hard').length, 1, '电脑与难度保留');
  assert.strictEqual(room.shuffleCount, 0, '回到大厅后随机次数重新计');
  room.onMessage('cA', { t: 'shuffle' });
  assert.strictEqual(last('cA', 'shuffled').count, 1);
});

test('持久化：快照往返保留电脑座位、难度、房主与随机次数；电脑座位不会被 token 重绑', () => {
  const { room } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cA', { t: 'addAI', level: 'easy' });
  let tries = 0;
  while (seatOfToken(room, 'tA') === 0 && tries++ < 200) room.onMessage('cA', { t: 'shuffle' });
  const snap = JSON.parse(JSON.stringify(room.snapshot()));
  const inbox = {};
  const r2 = new Room({ cardDB: DB, ai: AI, send: (c, m) => { (inbox[c] = inbox[c] || []).push(m); } });
  r2.restore(snap);
  assert.strictEqual(r2.seats.filter(s => s.ai === 'easy').length, 1);
  assert.strictEqual(r2.shuffleCount, room.shuffleCount);
  assert.strictEqual(r2.rebind('w1', 'tA'), seatOfToken(room, 'tA'), '休眠唤醒后按 token 重绑到正确座位');
  assert.ok(r2._isHost('w1'), '唤醒后房主身份不丢');
  const aiSeat = r2.seats.findIndex(s => s.ai);
  assert.strictEqual(r2.seats[aiSeat].token, null, '电脑座位没有 token');
  assert.strictEqual(r2.rebind('w2', null), -1, '空 token 不会绑到电脑座位');
});

function humanTurn(room, cid) {
  const p = room.G.players[room.G.turn];
  const plan = AI.chooseTurn(room.G, { difficulty: 'easy' });
  room.onMessage(cid, { t: 'action', action: plan.action || { type: 'pass' } });
  let d = 0;
  while (E.needsDiscard(room.G, p) && d++ < 20) {
    room.onMessage(cid, { t: 'action', action: { type: 'discard', color: E.ALL_TOKENS.find(c => p.tokens[c] > 0) } });
  }
  room.onMessage(cid, { t: 'action', action: { type: 'endTurn' } });
}

test('stepAI(attempt)：同一电脑回合重试时逐级降低思考开销（同难度单视图 → 新手 → 不搜索），且每次都能走完', () => {
  const calls = [];
  const spy = { chooseTurn(s, o) { calls.push(o); return AI.chooseTurn(s, o); } };
  const { room } = makeRoom({ ai: spy });
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI', level: 'hard' });
  room.onMessage('cA', { t: 'start', opts: {} });
  const expected = { 0: [{ difficulty: 'hard' }], 1: [{ difficulty: 'hard', beliefs: 1 }], 2: [{ difficulty: 'easy' }], 3: [], 9: [] };
  for (const attempt of [0, 1, 2, 3, 9]) {
    humanTurn(room, 'cA');
    assert.ok(room.aiPending(), '轮到电脑');
    calls.length = 0;
    assert.ok(room.stepAI(attempt));
    assert.strictEqual(room.G.turn, 0, 'attempt ' + attempt + '：电脑回合仍然走完');
    assert.deepStrictEqual(calls, expected[attempt], 'attempt ' + attempt + ' 的思考参数');
    assertConserved(room.G);
  }
});

test('humansConnected：电脑不算；真人全部断线时为 false（DO 据此暂停电脑回合），重连后恢复', () => {
  const { room } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI' });
  room.onMessage('cA', { t: 'start', opts: {} });
  assert.strictEqual(room.humansConnected(), true);
  room.leave('cA');
  assert.strictEqual(room.humansConnected(), false, '只剩电脑 → 暂停');
  room.onMessage('cA2', { t: 'join', token: 'tA' });
  assert.strictEqual(room.humansConnected(), true);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
