/* 不变量模糊测试 —— 大量随机对局，验证「无论怎么玩都不会破规则」。
 * 这类测试专抓两类最难靠人工发现的规则错误：
 *   (A) legalActions 给出了引擎随后会拒绝的行动（界面能点但点了报错/静默失败）
 *   (B) 资源/卡牌凭空产生或消失（守恒被破坏）
 * run: node test/invariants.test.js [games] */
const assert = require('assert');
const E = require('../js/engine.js');
const DB = require('../data/cards.json');
const MEGA = require('../data/megas.json');
const PM = require('../data/pokemart.json');

const GAMES = parseInt(process.argv[2] || '400', 10);
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e.message || e)); }
}
// 可复现的伪随机
function rng(seed) { let a = seed >>> 0 || 1; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; }

const SUPPLY_PER = { 2: 4, 3: 5, 4: 7 };

// 每种球的总数（供应 + 所有玩家手上）必须恒定
function checkTokenConservation(g, where) {
  for (const c of E.COLORS) {
    let tot = g.supply[c];
    g.players.forEach(p => { tot += p.tokens[c]; });
    assert.strictEqual(tot, SUPPLY_PER[g.numPlayers], where + ' 球守恒失败 ' + c + '=' + tot);
  }
  let purple = g.supply.purple;
  g.players.forEach(p => { purple += p.tokens.purple; });
  assert.strictEqual(purple, 5, where + ' 大师球守恒失败 =' + purple);
}
// 每张卡最多存在于一个地方（牌堆/明置/某人场上/某人保留/某人埋牌）
function checkCardUniqueness(g, where) {
  const seen = new Map();
  const note = (id, place) => {
    if (id == null) return;
    if (seen.has(id)) throw new Error(where + ' 卡牌重复: ' + id + ' 同时在 ' + seen.get(id) + ' 和 ' + place);
    seen.set(id, place);
  };
  for (const t in g.decks) g.decks[t].forEach(id => note(id, 'deck:' + t));
  for (const t in g.field) g.field[t].forEach(id => note(id, 'field:' + t));
  (g.megaOffer || []).forEach(id => note(id, 'megaOffer'));
  g.players.forEach((p, i) => {
    p.board.forEach(id => note(id, 'board' + i));
    p.reserve.forEach(id => note(id, 'reserve' + i));
    p.buried.forEach(id => note(id, 'buried' + i));
  });
}
// 手上球数不得超过上限（回合之间必须已经结算完）
function checkTokenCap(g, where) {
  g.players.forEach((p, i) => {
    assert.ok(E.tokenTotal(p) <= E.TOKEN_MAX, where + ' 玩家' + i + ' 持球 ' + E.tokenTotal(p) + ' 超过上限');
  });
}
// 明置区不得超过槽位数；牌堆还有牌时不得留空位
function checkFieldIntegrity(g, where) {
  for (const t of E.fieldTiers(g)) {
    const slots = g.field[t].length;
    const filled = g.field[t].filter(Boolean).length;
    assert.ok(filled <= slots, where + ' ' + t + ' 明置超出槽位');
    if (g.decks[t] && g.decks[t].length > 0) {
      assert.strictEqual(filled, slots, where + ' ' + t + ' 牌堆还有牌却留了空位（没有及时补牌）');
    }
  }
}

function playRandomGame(seed, opts) {
  const r = rng(seed);
  const g = E.createGame(DB, Object.assign({ numPlayers: 2 + (seed % 3), seed }, opts));
  let plies = 0;
  checkTokenConservation(g, '开局');
  checkCardUniqueness(g, '开局');
  checkFieldIntegrity(g, '开局');

  while (g.phase !== 'gameover' && plies < 3000) {
    const acts = E.legalActions(g);
    if (acts.length) {
      const a = acts[Math.floor(r() * acts.length)];
      // (A) legalActions 承诺的行动必须真的能执行
      const res = E.applyAction(g, a);
      assert.ok(res && res.ok, '合法行动被引擎拒绝: ' + JSON.stringify(a) + ' -> ' + (res && res.error));
    } else {
      const res = E.actionPass(g);
      assert.ok(res.ok, '无合法行动时 pass 也失败: ' + res.error);
    }
    // 回合结束前必须先弃到上限
    let guard = 0;
    const me = g.players[g.turn];
    while (E.needsDiscard(g, me) && guard++ < 30) {
      const c = E.ALL_TOKENS.filter(x => me.tokens[x] > 0)[0];
      assert.ok(c, '需要弃球却没有球可弃');
      assert.ok(E.actionDiscard(g, c).ok, '弃球失败');
    }
    // 随机进化（一半概率）
    const evo = E.evolutionOptions(g, me);
    if (evo.length && r() < 0.5) {
      const o = evo[Math.floor(r() * evo.length)];
      assert.ok(E.actionEvolve(g, o.fromId, o.toId).ok, '给出的进化选项却执行失败');
    }
    const et = E.endTurn(g);
    assert.ok(et.ok, '回合无法结束: ' + et.error);

    checkTokenConservation(g, 'ply' + plies);
    checkCardUniqueness(g, 'ply' + plies);
    checkTokenCap(g, 'ply' + plies);
    checkFieldIntegrity(g, 'ply' + plies);
    plies++;
  }
  assert.ok(plies < 3000, '对局没有收敛（可能死循环）');
  assert.strictEqual(g.phase, 'gameover');
  assert.ok(g.winner != null && g.winner >= 0, '结束时必须有胜者');
  // 胜者必须是分数最高者之一（Megas 另有资格规则，单独测）
  if (!g.megasEnabled) {
    const scores = g.players.map(p => E.scoreOf(g, p));
    assert.strictEqual(scores[g.winner], Math.max.apply(null, scores), '胜者不是最高分');
  }
  return g;
}

test('基础规则：' + GAMES + ' 局随机对局，全程守恒 + 合法行动必可执行', () => {
  for (let i = 0; i < GAMES; i++) playRandomGame(1000 + i);
});

test('Megas 扩展：' + Math.floor(GAMES / 2) + ' 局随机对局，同样守恒', () => {
  for (let i = 0; i < Math.floor(GAMES / 2); i++) playRandomGame(50000 + i, { megas: true, megaDB: MEGA });
});

test('Pokémart 扩展：' + Math.floor(GAMES / 2) + ' 局随机对局，同样守恒', () => {
  for (let i = 0; i < Math.floor(GAMES / 2); i++) playRandomGame(90000 + i, { pokemart: true, pokemartDB: PM });
});

test('双扩展同开：' + Math.floor(GAMES / 2) + ' 局随机对局，同样守恒', () => {
  for (let i = 0; i < Math.floor(GAMES / 2); i++)
    playRandomGame(130000 + i, { megas: true, megaDB: MEGA, pokemart: true, pokemartDB: PM });
});

test('Megas：AI 对局中，胜者必须真正满足资格（20分 + 集齐每色 + 1只Mega）', () => {
  // 用 AI 而不是随机走子：随机玩家永远不会去买 Mega，样本里根本不会出现合格胜者，
  // 测不到「资格判定」这条规则。AI 会主动追 Mega，正好覆盖。
  const AI = require('../js/ai.js');
  let qualifiedGames = 0;
  const N = 30;
  for (let i = 0; i < N; i++) {
    const g = E.createGame(DB, { numPlayers: 2, seed: 300000 + i, megas: true, megaDB: MEGA });
    let plies = 0;
    while (g.phase !== 'gameover' && plies < 2000) { AI.playTurn(g, { difficulty: 'hard' }); plies++; }
    assert.strictEqual(g.phase, 'gameover', '第' + i + '局未结束（' + plies + ' 手）');
    checkTokenConservation(g, 'AI局' + i);
    checkCardUniqueness(g, 'AI局' + i);
    if (g.stalemate) continue;                    // 和棋局按分数结算，不要求资格
    const anyQualified = g.players.some(p => {
      const b = E.bonuses(g, p);
      return E.scoreOf(g, p) >= E.MEGA_WIN_SCORE && E.COLORS.every(c => b[c] > 0)
        && p.board.some(id => g.byId[id].tier === 'mega');
    });
    if (!anyQualified) continue;
    qualifiedGames++;
    const w = g.players[g.winner], bw = E.bonuses(g, w);
    assert.ok(E.scoreOf(g, w) >= E.MEGA_WIN_SCORE, '第' + i + '局胜者分数不足');
    assert.ok(E.COLORS.every(c => bw[c] > 0), '第' + i + '局胜者未集齐每色');
    assert.ok(w.board.some(id => g.byId[id].tier === 'mega'), '第' + i + '局胜者没有 Mega');
  }
  assert.ok(qualifiedGames > 0, 'AI 对局里应出现达成 Mega 胜利条件的局（实际 ' + qualifiedGames + '/' + N + '）');
});

test('和棋兜底：牌与球耗尽且无人达成胜利条件时，对局必须终止（不能永久卡死）', () => {
  // 构造僵局：所有牌堆与明置清空、球全在玩家手上 → 双方都只能 pass
  const g = E.createGame(DB, { numPlayers: 2, seed: 12345, megas: true, megaDB: MEGA });
  for (const t2 of E.fieldTiers(g)) { g.decks[t2] = []; g.field[t2] = g.field[t2].map(() => null); }
  g.megaOffer = [];
  E.ALL_TOKENS.forEach(c => { g.supply[c] = 0; });
  g.supply.megaToken = 0;
  g.players.forEach(p => { p.megaToken = 1; });
  let plies = 0;
  while (g.phase !== 'gameover' && plies < 50) {
    assert.strictEqual(E.legalActions(g).length, 0, '构造前提：确实无合法行动');
    assert.ok(E.actionPass(g).ok);
    E.endTurn(g);
    plies++;
  }
  assert.strictEqual(g.phase, 'gameover', '僵局必须被判定结束，而不是无限 pass');
  assert.strictEqual(g.stalemate, true, '应标记为和棋');
  assert.ok(g.winner != null && g.winner >= 0, '和棋也要按分数决出名次');
  assert.ok(plies <= g.numPlayers + 1, '应在一圈之内判定，实际 ' + plies + ' 手');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
