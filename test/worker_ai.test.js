/* The Durable Object's bot-turn driver (worker/index.js), run against in-memory storage,
 * alarms and a fake clock:
 *  - a bot turn is armed only when a bot is to move AND a human is connected;
 *  - each alarm plays exactly one bot turn, persists it and chains to the next bot;
 *  - a duplicate alarm (at-least-once delivery) keeps the pacing;
 *  - attempts are counted per bot turn, durably, so a turn that died thinks more cheaply;
 *  - `sync` revives a lost alarm; lobby edits (bots / difficulty / shuffle) are persisted.
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
const DELAY = 1200;   // AI_TURN_DELAY_MS in worker/index.js

function harness(aiModule) {
  const clock = { t: 1000000 };
  const context = { RoomAuthority, AI: aiModule || AI, DB, MEGA_DB, POKEMART_DB, Date: { now: () => clock.t } };
  vm.runInNewContext(source, context);
  const sockets = [];
  const store = { snap: undefined, kv: {}, alarm: null, puts: 0 };
  const copy = v => JSON.parse(JSON.stringify(v));
  const state = {
    storage: {
      get: async (k) => (k === 'snap' ? store.snap : store.kv[k]),
      put: async (k, v) => { if (k === 'snap') { store.snap = copy(v); store.puts++; } else store.kv[k] = copy(v); },
      getAlarm: async () => store.alarm,
      setAlarm: async (t) => { store.alarm = t; },
    },
    getWebSockets: () => sockets,
  };
  const room = new context.WorkerRoom(state, {});
  return {
    clock, context, state, store, room,
    socket(id) {
      const ws = { meta: { connId: id }, out: [], send(d) { this.out.push(JSON.parse(d)); },
        serializeAttachment(v) { this.meta = v; }, deserializeAttachment() { return this.meta; } };
      sockets.push(ws); room.conns.set(ws, id); return ws;
    },
    send: (ws, m) => room.webSocketMessage(ws, JSON.stringify(m)),
    // the platform fires the alarm at its scheduled time and clears it before invoking the handler
    fire: async () => {
      if (store.alarm != null) clock.t = Math.max(clock.t, store.alarm);
      store.alarm = null;
      await room.alarm({ retryCount: 0, isRetry: false });
    },
    get a() { return room.authority; },
  };
}

async function humanTurn(h, ws) {
  const a = h.a, p = a.G.players[a.G.turn];
  const plan = AI.chooseTurn(E.clone(a.G), { difficulty: 'easy' });
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

  await test('电脑回合：真人走完后按节奏排上；sync 不会推迟；每个 alarm 只走一个电脑并落盘、连续电脑自动续排；重复触发不抢跑；轮回真人时停止', async () => {
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
    assert.strictEqual(armed, h.clock.t + DELAY, '按节奏排上电脑回合');
    h.clock.t += 50;                                  // a later message must not re-arm (would move it to +50)
    await h.send(host, { t: 'sync' });
    assert.strictEqual(h.store.alarm, armed, 'sync 不会把已排好的电脑回合往后推');
    const puts = h.store.puts;
    await h.fire();
    assert.strictEqual(h.a.G.turn, 2, '一个 alarm 只走一个电脑');
    assert.ok(h.store.puts > puts, '电脑走完已落盘');
    assert.strictEqual(h.store.alarm, h.clock.t + DELAY, '下一位还是电脑 → 按节奏续排');
    assert.ok(host.out.some(m => m.t === 'state' && m.state.turn === 2), '真人收到电脑走完的状态');
    await h.room.alarm({ retryCount: 0, isRetry: false });   // at-least-once: the same alarm delivered again at once
    assert.strictEqual(h.a.G.turn, 2, '重复触发不会让下一个电脑立刻走');
    assert.strictEqual(h.store.alarm, h.a.turnStartedAt + DELAY, '重复触发只是把 alarm 排回应有的时间');
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
    assert.strictEqual(h.store.alarm, h.clock.t + DELAY, '开局就轮到电脑 → 已排');
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
    h.clock.t += 60000;
    await h.send(back, { t: 'join', token: 'tH' });
    assert.ok(h.store.alarm > 0, '真人回来 → 重新排上');
    await h.fire();
    assert.strictEqual(h.a.G.turn, 0, '电脑继续走完');
  });

  await test('尝试次数按「电脑回合」计、在思考前落盘：没走完的回合下次思考更省；成功后下一个回合从头计；丢失的 alarm 由 sync 补排', async () => {
    const calls = [];
    const spy = { beliefState: AI.beliefState, chooseTurn(s, o) { calls.push(o); return AI.chooseTurn(s, o); } };
    const h = harness(spy);
    const host = h.socket('host');
    await h.send(host, { t: 'join', token: 'tH' });
    await h.send(host, { t: 'addAI', level: 'hard' });
    await h.send(host, { t: 'start', opts: {} });
    await humanTurn(h, host);
    calls.length = 0;
    await h.fire();
    assert.deepStrictEqual(calls, [{ difficulty: 'hard' }], '第一次：原难度');
    assert.deepStrictEqual(h.store.kv.aiAttempt, { seq: h.a.seq - 1, n: 0 }, '思考前已把本回合的尝试次数落盘');
    // Simulate: the previous run of the NEXT bot turn died mid-think (attempt recorded, state not persisted)
    await humanTurn(h, host);
    h.store.kv.aiAttempt = { seq: h.a.seq, n: 0 };
    calls.length = 0;
    await h.fire();
    assert.deepStrictEqual(calls, [{ difficulty: 'hard', beliefs: 1 }], '同一回合第 2 次：单视图');
    await humanTurn(h, host);
    h.store.kv.aiAttempt = { seq: h.a.seq, n: 1 };
    calls.length = 0;
    await h.fire();
    assert.deepStrictEqual(calls, [], '同一回合第 3 次：不再搜索，直接合法走法');
    assert.strictEqual(h.a.G.turn, 0, '仍然走完');
    await humanTurn(h, host);
    calls.length = 0;
    await h.fire();
    assert.deepStrictEqual(calls, [{ difficulty: 'hard' }], '新的电脑回合从头计');
    await humanTurn(h, host);
    h.store.alarm = null;                               // the platform gave up on the alarm
    h.clock.t += 20000;
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
