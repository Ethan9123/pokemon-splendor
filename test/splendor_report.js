/* 《璀璨宝石》健康度体检 — 对标「观鸟俱乐部」验收报告的指标口径。
 * node test/splendor_report.js [gamesPerCount] [difficulty] [seed0] > out.json
 * 除了对标指标（轮数/分差/碾压率/冷热差），额外测「经典之所以是经典」的三项：
 * 翻盘空间、决策密度、策略多样性。 */
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const DB = require('../data/cards.json');

const GAMES = parseInt(process.argv[2] || '2000', 10);
const DIFF = process.argv[3] || 'hard';
const SEED0 = parseInt(process.argv[4] || '500000', 10);
const COLORS = E.COLORS;

function runOne(np, seed) {
  const g = E.createGame(DB, { numPlayers: np, seed });
  const acts = { take3: 0, take2: 0, capture: 0, reserve: 0, pass: 0 };
  const buyTier = { stage1: 0, stage2: 0, stage3: 0, rare: 0, legend: 0 };
  const specialTaken = {};
  let evolutions = 0, reserveUses = 0, masterSpent = 0, plies = 0;
  let branchSum = 0, branchN = 0;          // 决策密度
  const roundLeader = [];                   // 每轮结束时的领先者（用于翻盘率）

  while (g.phase !== 'gameover' && plies < 4000) {
    const pid = g.turn;
    const beforeBuried = g.players[pid].buried.length;
    const beforePurple = g.players[pid].tokens.purple;
    const rBefore = g.round;

    const legal = E.legalActions(g);
    branchSum += legal.length; branchN++;

    const plan = AI.chooseTurn(g, { difficulty: DIFF });
    const a = plan.action;
    if (!a) acts.pass++;
    else if (a.type === 'take') (a.colors.length === 2 && a.colors[0] === a.colors[1]) ? acts.take2++ : acts.take3++;
    else if (a.type === 'capture') acts.capture++;
    else if (a.type === 'reserve') { acts.reserve++; reserveUses++; }

    if (a && a.type === 'capture') {
      const c = g.byId[a.cardId];
      if (buyTier[c.tier] != null) buyTier[c.tier]++;
      if (c.tier === 'rare' || c.tier === 'legend') specialTaken[a.cardId] = (specialTaken[a.cardId] || 0) + 1;
    }
    AI.playTurn(g, { difficulty: DIFF });
    const p = g.players[pid];
    if (p.buried.length > beforeBuried) evolutions++;
    if (beforePurple > p.tokens.purple) masterSpent += (beforePurple - p.tokens.purple);
    if (g.round !== rBefore) {                       // 一轮结束，记录领先者
      const sc = g.players.map(x => E.scoreOf(g, x));
      const mx = Math.max(...sc);
      roundLeader.push(sc.indexOf(mx));
    }
    plies++;
  }

  const scores = g.players.map(p => E.scoreOf(g, p));
  const sorted = scores.slice().sort((a, b) => b - a);
  // 「里程碑奖励」持有者分析（对标观鸟的成就卡「白送分」检验）：
  // 每位玩家买到的稀有/传说卡张数、其贡献分，以及扣除后的净分。
  const perPlayer = g.players.map((p, i) => {
    const sp = p.board.filter(id => ['rare', 'legend'].includes(g.byId[id].tier));
    const spVP = sp.reduce((a, id) => a + (g.byId[id].vp || 0), 0);
    return { seat: i, score: scores[i], won: g.winner === i, nSpecial: sp.length, spVP, netScore: scores[i] - spVP };
  });
  const deckEmpty = ['stage1', 'stage2', 'stage3'].some(t => g.decks[t].length === 0);
  // 策略多样性：胜者手牌的颜色集中度（最大单色占比）
  const w = g.players[g.winner];
  const wb = E.bonuses(g, w);
  const totB = COLORS.reduce((a, c) => a + wb[c], 0) || 1;
  const topColorShare = Math.max(...COLORS.map(c => wb[c])) / totB;
  // 翻盘：中局（总轮数一半）的领先者是否最终夺冠
  const midIdx = Math.max(0, Math.floor(roundLeader.length / 2) - 1);
  const midLeader = roundLeader.length ? roundLeader[midIdx] : null;

  return {
    rounds: g.round, winner: g.winner, scores, top: sorted[0], gap: sorted[0] - sorted[1],
    acts, buyTier, specialTaken, evolutions, reserveUses, masterSpent, deckEmpty,
    cardsWinner: w.board.length, buriedWinner: w.buried.length,
    branch: branchSum / branchN, topColorShare, perPlayer,
    midLeaderHeld: midLeader != null ? (midLeader === g.winner) : null,
  };
}

// 每局只有 CANON_SPECIAL 的 5 稀有 + 5 传说参战（池 20 张里的固定 10 张），
// 从一个实例反推实际参战 id，避免把「从不出场」的 10 张算进冷热差。
const _probe = E.createGame(DB, { numPlayers: 2, seed: 1 });
const SPECIAL_IDS = ['rare', 'legend'].flatMap(t => _probe.decks[t].concat(_probe.field[t]).filter(Boolean));
const out = {};
for (const np of [2, 3, 4]) {
  const R = [];
  for (let i = 0; i < GAMES; i++) R.push(runOne(np, SEED0 + np * 100000 + i));
  const n = R.length;
  const sum = (f) => R.reduce((a, r) => a + f(r), 0);
  const seatWins = new Array(np).fill(0); R.forEach(r => seatWins[r.winner]++);
  const actTot = { take3: 0, take2: 0, capture: 0, reserve: 0, pass: 0 };
  const tierTot = { stage1: 0, stage2: 0, stage3: 0, rare: 0, legend: 0 };
  const specialTot = {};
  R.forEach(r => {
    for (const k in actTot) actTot[k] += r.acts[k];
    for (const k in tierTot) tierTot[k] += r.buyTier[k];
    for (const k in r.specialTaken) specialTot[k] = (specialTot[k] || 0) + r.specialTaken[k];
  });
  const actSum = Object.values(actTot).reduce((a, b) => a + b, 0);
  const tierSum = Object.values(tierTot).reduce((a, b) => a + b, 0);
  const gaps = R.map(r => r.gap);
  // 稀有/传说：每张卡被买走的局数占比（这 10 张每局全部参战，分母就是 n）
  const specialRate = SPECIAL_IDS.map(id => ({
    id, name: DB.find(x => x.id === id).name, tier: DB.find(x => x.id === id).tier,
    rate: (specialTot[id] || 0) / n,
  })).sort((a, b) => b.rate - a.rate);
  const rates = specialRate.map(s => s.rate).filter(r => r > 0);
  const midHeld = R.filter(r => r.midLeaderHeld != null);
  // 里程碑（稀有/传说）持有者 vs 未持有者 —— 对标观鸟成就卡的「白送分」检验
  const PP = R.flatMap(r => r.perPlayer);
  const allAvg = PP.reduce((a, p) => a + p.score, 0) / PP.length;
  const grp = (pred) => {
    const s = PP.filter(pred);
    if (!s.length) return null;
    return {
      share: s.length / PP.length,
      winRate: s.filter(p => p.won).length / s.length,
      score: s.reduce((a, p) => a + p.score, 0) / s.length,
      netScore: s.reduce((a, p) => a + p.netScore, 0) / s.length,
    };
  };
  const milestone = {
    allPlayerAvgScore: allAvg,
    has2plus: grp(p => p.nSpecial >= 2),
    has1: grp(p => p.nSpecial === 1),
    has0: grp(p => p.nSpecial === 0),
  };

  out[np] = {
    games: n,
    rounds: sum(r => r.rounds) / n,
    turnsTotal: sum(r => r.rounds) / n * np,
    topScore: sum(r => r.top) / n,
    gap: sum(r => r.gap) / n,
    gapRelative: (sum(r => r.gap) / n) / (sum(r => r.top) / n),   // 归一化，跨游戏可比
    crushRate: R.filter(r => r.gap >= 6).length / n,
    crushRelative: R.filter(r => r.gap / r.top >= 0.35).length / n,
    closeRate: R.filter(r => r.gap <= 1).length / n,
    seatWinRates: seatWins.map(w => w / n),
    firstSeatEdge: seatWins[0] / n - 1 / np,
    deckEmptyRate: R.filter(r => r.deckEmpty).length / n,
    evolutionsPerGame: sum(r => r.evolutions) / n,
    reserveUsesPerGame: sum(r => r.reserveUses) / n,
    masterSpentPerGame: sum(r => r.masterSpent) / n,
    cardsWinner: sum(r => r.cardsWinner) / n,
    branchAvg: sum(r => r.branch) / n,                            // 决策密度
    topColorShare: sum(r => r.topColorShare) / n,                 // 策略集中度
    midLeaderHoldRate: midHeld.length ? midHeld.filter(r => r.midLeaderHeld).length / midHeld.length : null,
    milestone,
    actionMix: Object.fromEntries(Object.entries(actTot).map(([k, v]) => [k, v / actSum])),
    buyTierMix: Object.fromEntries(Object.entries(tierTot).map(([k, v]) => [k, v / tierSum])),
    specialRate,
    specialSpread: rates.length ? rates[0] / rates[rates.length - 1] : null,
    specialZero: specialRate.filter(s => s.rate === 0).length,
    gapHist: [0, 1, 2, 3, 4, 5, 6, 8, 10].map((lo, i, arr) => ({
      lo, hi: arr[i + 1] != null ? arr[i + 1] : 99,
      pct: gaps.filter(x => x >= lo && (arr[i + 1] == null || x < arr[i + 1])).length / n,
    })),
  };
}
console.log(JSON.stringify({ difficulty: DIFF, gamesPerCount: GAMES, seed0: SEED0, byCount: out }, null, 1));
