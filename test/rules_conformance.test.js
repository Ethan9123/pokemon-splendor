/* 规则符合性审计 —— 逐条对照官方《Splendor: Pokémon Rules Summary》(Igor Knop, 2024-01-28)
 * 与基础 Splendor 官方规则（ultraboardgames / BGG 裁定）。
 * 每条断言都标注它对应规则书的哪一条，方便日后改规则时定位。
 * run: node test/rules_conformance.test.js */
const assert = require('assert');
const E = require('../js/engine.js');
const DB = require('../data/cards.json');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e.message || e)); }
}
const mk = (np, seed) => E.createGame(DB, { numPlayers: np || 2, seed: seed || 7 });
const has = (acts, pred) => acts.some(pred);

// ---------- §1 准备 ----------
test('§1a 大师球恒为 5 个（与人数无关）', () => {
  for (const np of [2, 3, 4]) assert.strictEqual(mk(np).supply.purple, 5, np + '人局');
});
test('§1b 每色球数：2人=4 / 3人=5 / 4人=7', () => {
  const want = { 2: 4, 3: 5, 4: 7 };
  for (const np of [2, 3, 4]) for (const c of E.COLORS)
    assert.strictEqual(mk(np).supply[c], want[np], np + '人局 ' + c);
});
test('§1d 明置：一/二/三阶各 4 张，稀有 1 张，传说 1 张', () => {
  const g = mk(2);
  for (const t of ['stage1', 'stage2', 'stage3']) assert.strictEqual(g.field[t].filter(Boolean).length, 4, t);
  assert.strictEqual(g.field.rare.filter(Boolean).length, 1);
  assert.strictEqual(g.field.legend.filter(Boolean).length, 1);
});

// ---------- §3 回合行动 ----------
test('§3a 拿 3 异色：不得包含大师球', () => {
  const g = mk(2);
  assert.ok(!has(E.legalActions(g), a => a.type === 'take' && a.colors.indexOf('purple') >= 0), '合法行动里不该出现大师球');
  assert.strictEqual(E.actionTake(g, ['red', 'blue', 'purple']).ok, false, '直接拿大师球必须被拒绝');
});
test('§3b 拿 2 同色：供应 ≥4 才允许（=4 可以，=3 不行）', () => {
  const g = mk(2);                       // 2人局每色 4 个
  assert.strictEqual(g.supply.red, 4);
  assert.ok(has(E.legalActions(g), a => a.type === 'take' && a.colors.length === 2 && a.colors[0] === a.colors[1] && a.colors[0] === 'red'), '恰好4个时应允许拿2同色');
  g.supply.red = 3;
  assert.ok(!has(E.legalActions(g), a => a.type === 'take' && a.colors.length === 2 && a.colors[0] === 'red'), '只剩3个时不该允许');
  assert.strictEqual(E.actionTake(g, ['red', 'red']).ok, false, '只剩3个时直接调用也必须拒绝');
});
test('§3c 保留：只能保留一/二/三阶，不能保留稀有/传说', () => {
  const g = mk(2);
  const rareId = g.field.rare.filter(Boolean)[0], legendId = g.field.legend.filter(Boolean)[0];
  assert.strictEqual(E.actionReserve(g, { fromField: rareId }).ok, false, '稀有不可保留');
  assert.strictEqual(E.actionReserve(g, { fromField: legendId }).ok, false, '传说不可保留');
  assert.ok(!has(E.legalActions(g), a => a.type === 'reserve' && a.target.fromField === rareId), '合法行动里不该出现保留稀有');
});
test('§3c 保留：手牌上限 3 张', () => {
  const g = mk(2); const p = g.players[0];
  for (let i = 0; i < 3; i++) { g.acted = false; assert.strictEqual(E.actionReserve(g, { fromDeck: 'stage1' }).ok, true, '第' + (i + 1) + '张'); }
  assert.strictEqual(p.reserve.length, 3);
  g.acted = false;
  assert.strictEqual(E.actionReserve(g, { fromDeck: 'stage1' }).ok, false, '第4张必须被拒绝');
});
test('§3c 保留同时获得 1 个大师球', () => {
  const g = mk(2); const before = g.supply.purple;
  E.actionReserve(g, { fromDeck: 'stage1' });
  assert.strictEqual(g.players[0].tokens.purple, 1);
  assert.strictEqual(g.supply.purple, before - 1);
});
test('§3c 大师球耗尽时：仍可保留，只是拿不到球（基础Splendor官方裁定）', () => {
  const g = mk(2); g.supply.purple = 0;
  const r = E.actionReserve(g, { fromDeck: 'stage1' });
  assert.strictEqual(r.ok, true, '没有大师球时保留动作本身仍然合法');
  assert.strictEqual(g.players[0].reserve.length, 1, '牌要真的进保留区');
  assert.strictEqual(g.players[0].tokens.purple, 0, '但拿不到大师球');
  const g2 = mk(2); g2.supply.purple = 0;
  assert.ok(has(E.legalActions(g2), a => a.type === 'reserve'), '合法行动里仍应有保留');
});
test('§3d 捕捉：大师球可当任意色使用（万能球）', () => {
  const g = mk(2); const p = g.players[0];
  const id = g.field.stage1.filter(Boolean)[0]; const card = g.byId[id];
  const need = E.COLORS.reduce((a, c) => a + (card.cost[c] || 0), 0) + (card.cost.purple || 0);
  p.tokens.purple = need;                      // 全部用大师球支付
  assert.strictEqual(E.canAfford(g, p, card), true, '纯大师球应能买下');
});
test('§3d 捕捉/保留后立即补牌', () => {
  const g = mk(2);
  const before = g.field.stage1.filter(Boolean).length;
  E.actionReserve(g, { fromField: g.field.stage1.filter(Boolean)[0] });
  assert.strictEqual(g.field.stage1.filter(Boolean).length, before, '保留后该位应立刻补上');
});
test('§3 一回合只能做一个主行动', () => {
  const g = mk(2);
  assert.strictEqual(E.actionTake(g, ['red', 'blue', 'black']).ok, true);
  assert.strictEqual(E.actionTake(g, ['red', 'blue', 'yellow']).ok, false, '已行动过不能再拿');
  assert.strictEqual(E.actionReserve(g, { fromDeck: 'stage1' }).ok, false, '已行动过不能再保留');
});

// ---------- §4 回合结束 ----------
test('§4a 超过 10 个球必须弃到 10（回合结束时结算）', () => {
  const g = mk(4); const p = g.players[0];
  E.COLORS.forEach(c => { p.tokens[c] = 3; });      // 15 个
  assert.strictEqual(E.tokenTotal(p), 15);
  assert.strictEqual(E.needsDiscard(g, p), true);
  g.acted = true;
  assert.strictEqual(E.endTurn(g).ok, false, '没弃够不能结束回合');
  let guard = 0;
  while (E.needsDiscard(g, p) && guard++ < 20) E.actionDiscard(g, E.COLORS.filter(c => p.tokens[c] > 0)[0]);
  assert.strictEqual(E.tokenTotal(p), 10);
  assert.strictEqual(E.endTurn(g).ok, true, '弃到10后可以结束');
});
test('§4b 每回合只能进化 1 次', () => {
  const g = mk(2);
  g.evolvedThisTurn = true;
  assert.strictEqual(E.evolutionOptions(g, g.players[0]).length, 0, '本回合已进化过就不该再有选项');
});
test('§4b-iii 进化只能用奖励（折扣）支付，不能用手上的球', () => {
  const g = mk(2); const p = g.players[0];
  const base = DB.filter(c => c.evolvesTo && c.evoCost)[0];
  const tgt = DB.filter(c => c.name === base.evolvesTo)[0];
  p.board.push(base.id);
  g.field[tgt.tier][0] = tgt.id;
  E.COLORS.forEach(c => { p.tokens[c] = 10; });     // 满手球，但没有任何奖励卡
  assert.strictEqual(E.evolutionOptions(g, p).length, 0, '光有球没有奖励时不能进化');
});
test('§4b-ii 进化目标必须在明置区或自己的保留区', () => {
  const g = mk(2); const p = g.players[0];
  const base = DB.filter(c => c.evolvesTo && c.evoCost)[0];
  const tgt = DB.filter(c => c.name === base.evolvesTo)[0];
  p.board.push(base.id);
  const need = base.evoCost.count, col = base.evoCost.color;
  DB.filter(c => c.bonus === col && c.id !== base.id).slice(0, need + 1).forEach(c => p.board.push(c.id));
  for (const t of E.FIELD_TIERS) g.field[t] = g.field[t].map(x => (x === tgt.id ? null : x));
  p.reserve = [];
  assert.strictEqual(E.evolutionOptions(g, p).filter(o => o.toId === tgt.id).length, 0, '目标不可得时不该给选项');
  p.reserve = [tgt.id];
  assert.ok(E.evolutionOptions(g, p).some(o => o.toId === tgt.id), '目标在保留区时应可进化');
});
test('§4c 进化后：旧卡进「角色下方」，不再提供分数与奖励', () => {
  const g = mk(2); const p = g.players[0];
  const base = DB.filter(c => c.evolvesTo && c.evoCost)[0];
  const tgt = DB.filter(c => c.name === base.evolvesTo)[0];
  p.board.push(base.id);
  const need = base.evoCost.count, col = base.evoCost.color;
  DB.filter(c => c.bonus === col && c.id !== base.id).slice(0, need).forEach(c => p.board.push(c.id));
  g.field[tgt.tier][0] = tgt.id;
  const r = E.actionEvolve(g, base.id, tgt.id);
  assert.strictEqual(r.ok, true, '应能进化: ' + (r.error || ''));
  assert.ok(p.buried.indexOf(base.id) >= 0, '旧卡应进入 buried（角色下方）');
  assert.ok(p.board.indexOf(base.id) < 0, '旧卡不应还留在场上');
  // buried 不贡献分数
  const boardVp = p.board.reduce((a, id) => a + (g.byId[id].vp || 0), 0);
  assert.strictEqual(E.scoreOf(g, p), boardVp, '总分应只来自场上卡，不含 buried');
  // buried 不贡献奖励
  const b = E.bonuses(g, p);
  let boardBonus = 0;
  for (const id of p.board) if (g.byId[id].bonus === base.bonus) boardBonus += (g.byId[id].bonusCount || 1);
  assert.strictEqual(b[base.bonus], boardBonus, '埋掉的卡不应再提供奖励');
});

// ---------- §5 结束与胜负 ----------
test('§5a/b 达到 18 分触发最后一轮，且所有人回合数相同', () => {
  const g = mk(3);
  DB.filter(c => (c.vp || 0) >= 3).slice(0, 6).forEach(c => g.players[0].board.push(c.id));
  assert.ok(E.scoreOf(g, g.players[0]) >= 18, '前提：已达 18 分');
  g.acted = true; E.endTurn(g);
  assert.strictEqual(g.lastRound, true, '应进入最后一轮');
  assert.strictEqual(g.phase, 'play', '触发时不应立刻结束');
  g.acted = true; E.endTurn(g);
  assert.strictEqual(g.phase, 'play', '还有人没打完，不该结束');
  g.acted = true; E.endTurn(g);
  assert.strictEqual(g.phase, 'gameover', '最后一位打完后结束');
});
test('§5c 平局判定：进化数（角色下方卡数）多者胜', () => {
  const g = mk(2);
  const c3 = DB.filter(c => (c.vp || 0) === 3).slice(0, 12);
  c3.slice(0, 6).forEach(c => g.players[0].board.push(c.id));
  c3.slice(6, 12).forEach(c => g.players[1].board.push(c.id));
  assert.strictEqual(E.scoreOf(g, g.players[0]), E.scoreOf(g, g.players[1]), '前提：同分');
  g.players[1].buried.push(DB[0].id, DB[1].id);
  g.acted = true; g.turn = 1; g.lastRound = true;
  E.endTurn(g);
  assert.strictEqual(g.phase, 'gameover');
  assert.strictEqual(g.winner, 1, '同分时进化多的一方获胜');
});

// ---------- Megas 扩展（官方扩展说明书）----------
const MEGA = require('../data/megas.json');
const mkM = (np, seed) => E.createGame(DB, { numPlayers: np || 2, seed: seed || 7, megas: true, megaDB: MEGA });

test('[Megas] Mega 代币共 4 个', () => {
  assert.strictEqual(mkM(2).supply.megaToken, 4);
});
test('[Megas] 拿 Mega 代币要花掉一整个回合，且每人上限 1 个', () => {
  const g = mkM(2); const p = g.players[0];
  assert.strictEqual(E.actionTakeMega(g).ok, true);
  assert.strictEqual(p.megaToken, 1);
  assert.strictEqual(g.acted, true, '应占用整个回合');
  assert.strictEqual(E.actionTake(g, ['red', 'blue', 'black']).ok, false, '拿了代币就不能再做别的主行动');
  g.acted = false;
  assert.strictEqual(E.actionTakeMega(g).ok, false, '不能持有第 2 个代币');
});
test('[Megas] 超级进化会消耗代币并归还公共池', () => {
  const g = mkM(2); const p = g.players[0];
  const mega = g.byId[g.megaOffer[0]];
  const base = DB.filter(c => c.name === mega.megaFrom)[0];
  p.board.push(base.id); p.megaToken = 1; g.supply.megaToken = 3;
  E.COLORS.forEach(c => { p.tokens[c] = 10; }); p.tokens.purple = 5;
  const r = E.actionMegaEvolve(g, mega.id, base.id);
  assert.strictEqual(r.ok, true, r.error || '');
  assert.strictEqual(p.megaToken, 0, '代币被消耗');
  assert.strictEqual(g.supply.megaToken, 4, '代币归还公共池');
  assert.ok(p.buried.indexOf(base.id) >= 0, '基础宝可梦进入角色下方');
  assert.ok(p.board.indexOf(mega.id) >= 0, 'Mega 卡进入场上');
});
test('[Megas] 胜利条件替换为：20分 + 集齐每色 + 1只Mega（光有分数不算）', () => {
  const g = mkM(2); const p = g.players[0];
  DB.filter(c => (c.vp || 0) >= 3).slice(0, 8).forEach(c => p.board.push(c.id));
  assert.ok(E.scoreOf(g, p) >= 20, '前提：分数已够');
  g.acted = true; E.endTurn(g);
  assert.strictEqual(g.lastRound, false, '不满足集齐每色+Mega 时，光有分数不该触发结束');
});
test('[Megas] 设计意图固化：超梦是传说卡，超级超梦只能由它进化', () => {
  // 规则书写「需要三阶宝可梦才能超级进化」，但本作根本没有三阶超梦 ——
  // 若强行按 tier==='stage3' 限制，超级超梦X/Y 会变成永远打不出的废卡。
  // 因此引擎按「名字」匹配是正确解读。此测试防止后人把它「修」成 bug。
  const byName = {};
  DB.forEach(c => { (byName[c.name] = byName[c.name] || []).push(c.tier); });
  const mewtwoMegas = MEGA.filter(m => (byName[m.megaFrom] || []).indexOf('stage3') < 0);
  assert.ok(mewtwoMegas.length > 0, '前提：确实存在非三阶来源的 Mega');
  for (const m of mewtwoMegas) {
    const g = mkM(2); const p = g.players[0];
    const base = DB.filter(c => c.name === m.megaFrom)[0];
    g.megaOffer = [m.id]; g.byId[m.id] = m;
    p.board.push(base.id); p.megaToken = 1;
    E.COLORS.forEach(c => { p.tokens[c] = 10; }); p.tokens.purple = 5;
    assert.ok(E.megaEvolveOptions(g, p).some(o => o.megaId === m.id), m.name + ' 必须可由 ' + m.megaFrom + ' 进化，否则是废卡');
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
