/* The Durable Object's bot-turn driver (worker/index.js), run against in-memory
 * storage + alarms: a bot turn is armed only when a bot is to move AND a human is
 * connected; each alarm plays exactly one bot turn, persists it and chains to the
 * next bot; a retried alarm thinks more cheaply; `sync` revives a lost alarm; lobby
 * edits (bots / difficulty / shuffle) are persisted.
 * run: node test/worker_ai.test.js */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const RoomAuthority = require('../js/room.js').Room;
const AI = require('../js/ai.js');
const E = require('../js/engine.js');
const DB = require('../data/cards.json'), MEGA_DB = require('../data/megas.json'), POKEMART_DB = require('../data/pokemart.json');
const NL = String.fromCharCode(10);
const source = fs.readFileSync(require.resolve('../worker/index.js'), 'utf8')
  .split(NL).filter(line => !line.startsWith('import ')).join(NL)
  .replace('export class Room', 'class Room')
  .replace('export default {', 'const entry = {') + NL + 'this.WorkerRoom = Room;';

function harness(aiModule) {
  const context = { RoomAuthority, AI: aiModule || AI, DB, MEGA_DB, POKEMART_DB };
  vm.runInNewContext(source, context);
  const sockets = [];
  const store = { snap: undefined, alarm: null, puts: 0 };
  const state = {
    storage: {
      get: async () => store.snap,
      put: async (_, v) => { store.snap = JSON.parse(JSON.stringify(v)); store.puts++; },
      getAlarm: async () => store.alarm,
      setAlarm: async (t) => { store.alarm = t; },
    },
    getWebSockets: () => sockets,
  };
  const room = new context.WorkerRoom(state, {});
  const h = {
    context, state, store, room,
    socket(id) {
      const ws = { meta: { connId: id }, out: [], send(d) { this.out.push(JSON.parse(d)); },
        serializeAttachment(v) { this.meta = v; }, deserializeAttachment() { return this.meta; } };
      sockets.push(ws); room.conns.set(ws, id); return ws;
    },
    send: (ws, m) => room.webSocketMessage(ws, JSON.stringify(m)),
    // the platform clears a firing alarm before invoking the handler
    fire: async (info) => { store.alarm = null; await room.alarm(info || { retryCount: 0, isRetry: false }); },
    get a() { return room.authority; },
  };
  return h;
}

async function humanTurn(h, ws) {
  const a = h.a, p = a.G.players[a.G.turn];
  const plan = AI.chooseTurn(a.G, { difficulty: 'easy' });
  await h.send(ws, { t: 'action', action: plan.action || { type: 'pass' } });
  let d = 0;
  while (E.needsDiscard(a.G, p) && d++ < 20) {
    await h.send(ws, { t: 'action', action: { type: 'discard', color: E.ALL_TOKENS.find(c => p.tokens[c] > 0) } });
  }
  await h.send(ws, { t: 'action', action: { type: 'endTurn' } });
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + NL + '      ' + (e.stack || e.message)); }
}

(async () => {
  await test('大厅：加电脑 / 改难度 / 随机座位 / 移除电脑 都会落盘；开局前不排电脑回合', async () => {
    const h = harness();
    const host = h.socket('host');
    await h.send(host, { t: 'join', token: 'tH', name: '小明' });
    await h.send(host, { t: 'addAI', level: 'normal' });
    assert.strictEqual(h.store.snap.seats.filter(s => s.ai).length, 1, 'addAI 已落盘');
    await h.send(host, { t: 'aiLevel', seat: h.a.seats.findIndex(s => s.ai), level: 'easy' });
    assert.strictEqual(h.store.snap.seats.find(s => s.ai).ai, 'easy', 'aiLevel 已落盘');
    await h.send(host, { t: 'shuffle' });
    assert.strictEqual(h.store.snap.shuffleCount, 1, 'shuffle 已落盘');
    assert.strictEqual(h.store.alarm, null, '大厅阶段不排电脑回合');
    await h.send(host, { t: 'removeAI', seat: h.a.seats.findIndex(s => s.ai) });
    assert.strictEqual(h.store.snap.seats.length, 1, 'removeAI 已落盘');
    assert.strictEqual(h.store.snap.hostToken, 'tH', '房主身份已落盘');
  });

  await test('电脑回合：真人走完后排上 alarm；每个 alarm 只走一个电脑并落盘、连续电脑自动续排；轮回真人时停止', async () => {
    const h = harness();
    const host = h.socket('host');
    await h.send(host, { t: 'join', token: 'tH', name: '小明' });
    await h.send(host, { t: 'addAI', level: 'normal' });
    await h.send(host, { t: 'addAI', level: 'easy' });
    await h.send(host, { t: 'start', opts: {} });
    assert.strictEqual(h.a.G.turn, 0);
    assert.strictEqual(h.store.alarm, null, '真人先手：不排');
    await humanTurn(h, host);
    assert.ok(h.a.aiPending(), '轮到电脑');
    const armed = h.store.alarm;
    assert.ok(armed > 0, '已排上电脑回合');
    await h.send(host, { t: 'sync' });
    assert.strictEqual(h.store.alarm, armed, 'sync 不会把已排好的电脑回合往后推');
    const puts = h.store.puts;
    await h.fire();
    assert.strictEqual(h.a.G.turn, 2, '一个 alarm 只走一个电脑');
    assert.ok(h.store.puts > puts, '电脑走完已落盘');
    assert.ok(h.store.alarm > 0, '下一位还是电脑 → 自动续排');
    assert.ok(host.out.some(m => m.t === 'state' && m.state.turn === 2), '真人收到电脑走完的状态');
    await h.fire();
    assert.strictEqual(h.a.G.turn, 0, '两个电脑走完回到真人');
    assert.strictEqual(h.store.alarm, null, '轮到真人：不再排');
    const restored = new h.context.WorkerRoom(h.state, {});
    await restored._init();
    assert.strictEqual(restored.authority.G.turn, 0, '快照恢复到同一时刻');
    assert.strictEqual(restored.authority.seq, h.a.seq);
    assert.deepStrictEqual(restored.authority.seats.map(s => s.ai), [null, 'normal', 'easy']);
  });

  await test('随机到电脑先手：开局即排上电脑回合', async () => {
    const h = harness();
    const host = h.socket('host');
    await h.send(host, { t: 'join', token: 'tH' });
    await h.send(host, { t: 'addAI' });
    let tries = 0;
    while (!h.a.seats[0].ai && tries++ < 200) await h.send(host, { t: 'shuffle' });
    await h.send(host, { t: 'start', opts: {} });
    assert.ok(h.a.aiPending());
    assert.ok(h.store.alarm > 0, '开局就轮到电脑 → 已排');
    await h.fire();
    assert.strictEqual(h.a.G.players[h.a.G.turn].isAI, false, '电脑走完交给真人');
  });

  await test('真人全部断线 → 电脑暂停（不走、不续排）；真人重连 → 自动恢复', async () => {
    const h = harness();
    const host = h.socket('host');
    await h.send(host, { t: 'join', token: 'tH' });
    await h.send(host, { t: 'addAI' });
    await h.send(host, { t: 'start', opts: {} });
    await humanTurn(h, host);
    assert.ok(h.store.alarm > 0);
    await h.room.webSocketClose(host);
    const turn = h.a.G.turn, seq = h.a.seq;
    await h.fire();
    assert.strictEqual(h.a.G.turn, turn, '无人在线：电脑不走');
    assert.strictEqual(h.a.seq, seq);
    assert.strictEqual(h.store.alarm, null, '暂停时不续排（不产生费用）');
    const back = h.socket('host2');
    await h.send(back, { t: 'join', token: 'tH' });
    assert.ok(h.store.alarm > 0, '真人回来 → 重新排上');
    await h.fire();
    assert.strictEqual(h.a.G.turn, 0, '电脑继续走完');
  });

  await test('alarm 重试（上一次执行没走完）时降级思考；定时器丢失时客户端的 sync 能唤醒', async () => {
    const calls = [];
    const spy = { chooseTurn(s, o) { calls.push(o); return AI.chooseTurn(s, o); } };
    const h = harness(spy);
    const host = h.socket('host');
    await h.send(host, { t: 'join', token: 'tH' });
    await h.send(host, { t: 'addAI', level: 'hard' });
    await h.send(host, { t: 'start', opts: {} });
    await humanTurn(h, host);
    calls.length = 0;
    await h.fire({ retryCount: 1, isRetry: true });
    assert.deepStrictEqual(calls, [{ difficulty: 'hard', beliefs: 1 }], '第 1 次重试：同难度单视图');
    await humanTurn(h, host);
    calls.length = 0;
    await h.fire({ retryCount: 5, isRetry: true });
    assert.deepStrictEqual(calls, [], '多次重试后不再搜索，直接合法走法');
    assert.strictEqual(h.a.G.turn, 0);
    await humanTurn(h, host);
    h.store.alarm = null;                               // the platform gave up on the alarm
    await h.send(host, { t: 'sync' });
    assert.ok(h.store.alarm > 0, 'sync 重新排上丢失的电脑回合');
  });

  await test('完整对局经由 alarm 驱动打到结束：1 真人 + 3 电脑', async () => {
    const h = harness();
    const host = h.socket('host');
    await h.send(host, { t: 'join', token: 'tH' });
    for (const lv of ['easy', 'normal', 'hard']) await h.send(host, { t: 'addAI', level: lv });
    await h.send(host, { t: 'shuffle' });
    await h.send(host, { t: 'start', opts: {} });
    let guard = 0;
    while (h.a.G.phase === 'play' && guard++ < 2000) {
      if (h.a.aiPending()) { assert.ok(h.store.alarm > 0, '电脑回合必有 alarm'); await h.fire(); }
      else await humanTurn(h, host);
    }
    assert.strictEqual(h.a.G.phase, 'gameover', '对局结束（' + guard + ' 步）');
    assert.ok(host.out.some(m => m.t === 'over'));
    assert.strictEqual(h.store.alarm, null, '结束后不再排');
    assert.strictEqual(h.store.snap.g.phase, 'gameover', '终局已落盘');
  });

  console.log(NL + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
