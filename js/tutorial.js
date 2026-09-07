/* ===================== Pokémon Splendor — 新手教程 (guided tutorial) =====================
 * A solo, fully-arranged practice game that walks a complete beginner through every action
 * (take balls / capture / reserve / evolve) and lets them win. Each lesson sets up its own
 * preconditions, so it is robust to mis-taps; completion is detected from cumulative state.
 * ====================================================================================== */
(function () {
  'use strict';

  // Pure layout for the coach bubble: pick a `top` (and, only when nothing fits, a
  // `maxHeight`) that keeps the bubble entirely off the `avoid` band — the spotlit
  // target merged with the action bar. Exported before the DOM guard so Node can test it.
  function placeBubble(o) {
    const { viewTop, viewH, bh, safe, avoid } = o, gap = 14, minH = 120;
    if (!avoid) return { top: Math.max(viewTop + safe, Math.min(viewTop + 58, viewTop + viewH - bh - safe)), maxHeight: null };
    const roomBelow = viewTop + viewH - avoid.bottom - gap - safe;
    const roomAbove = avoid.top - viewTop - gap - safe;
    if (roomBelow >= bh) return { top: avoid.bottom + gap, maxHeight: null };
    if (roomAbove >= bh) return { top: avoid.top - gap - bh, maxHeight: null };
    // neither side fits the whole bubble: take the roomier side and let the bubble scroll inside it
    if (roomBelow >= roomAbove) return { top: avoid.bottom + gap, maxHeight: Math.max(minH, roomBelow) };
    return { top: viewTop + safe, maxHeight: Math.max(minH, roomAbove) };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { placeBubble };

  const PS = window.PSGame;
  if (!PS) return;
  const E = PS.E;
  const byId = PS.byId;
  const COLORS = E.COLORS;
  const P = (g) => g.players[0];

  let active = false, curMode = 'base', steps = [], idx = 0, ctx = null, describedTarget = null;

  // ---------------------------------------------------------------- scenario builders
  function purge(g, id) {                       // remove an id from every deck and field slot
    for (const t of E.FIELD_TIERS) {
      g.decks[t] = g.decks[t].filter(x => x !== id);
      for (let i = 0; i < g.field[t].length; i++) if (g.field[t][i] === id) g.field[t][i] = null;
    }
  }
  function placeField(g, tier, slot, id) { purge(g, id); g.field[tier][slot] = id; }
  function placeOnly(g, tier, id) { g.field[tier].fill(null); placeField(g, tier, 0, id); }
  function give(g, id) { purge(g, id); P(g).board.push(id); }
  function setBoard(g, ids) { P(g).board = []; P(g).buried = []; P(g).assoc = {}; ids.forEach(id => give(g, id)); }
  function setTokens(g, obj) {
    const p = P(g);
    p.tokens = { red: 0, blue: 0, black: 0, pink: 0, yellow: 0, purple: 0 };
    for (const k in obj) p.tokens[k] = obj[k];
  }
  const tokenTotal = (g) => E.tokenTotal(P(g));
  const score = (g) => E.scoreOf(g, P(g));

  function buildBase() {
    const g = E.createGame(PS.DB, { numPlayers: 1, names: ['你'], ai: [false], winScore: 999 });
    give(g, 's1_14'); give(g, 's1_20');        // 2× 凯西 (pink) → 2 pink discounts + 2 VP
    placeField(g, 'stage1', 0, 's1_07');       // 杰尼龟 4red vp1
    placeField(g, 'stage1', 1, 's1_04');       // 喇叭芽 2red+2pink vp0 → 口呆花
    placeField(g, 'stage1', 2, 's1_21');       // 蚊香蝌蚪 3red
    placeField(g, 'stage1', 3, 's1_33');       // 波波 3pink
    placeField(g, 'stage2', 0, 's2_03');       // 口呆花 (evolution target)
    E.refill(g, 'stage2');
    setTokens(g, {});
    return g;
  }
  function buildMega() {
    const g = E.createGame(PS.DB, { numPlayers: 1, names: ['你'], ai: [false], megas: true, megaDB: PS.MEGA_DB, winScore: 999 });
    give(g, 's3_01');                          // 耿鬼 → 超级耿鬼 (mg_01)
    setTokens(g, { red: 3 });                  // afford 超级耿鬼 (cost 3red)
    return g;
  }
  function buildPokemart() {
    const g = E.createGame(PS.DB, { numPlayers: 1, names: ['你'], ai: [false], pokemart: true, pokemartDB: PS.POKEMART_DB, winScore: 999 });
    give(g, 's1_14');                          // one real pink bonus for copy lessons
    setTokens(g, {});
    return g;
  }

  // ---------------------------------------------------------------- steps
  // Once the picked balls form a legal take, the lesson's next tap is the (enabled) confirm
  // button — move the spotlight there so a beginner sees exactly what to press next.
  const confirmTake = () => document.querySelector('#action-bar [data-act="confirm-take"]:not([disabled])');

  const baseSteps = [
    {
      title: '欢迎来到训练家学院 🎓',
      html: '这是《璀璨宝石·宝可梦》。核心其实只有一句话：<br><b>收集精灵球 → 捕捉宝可梦得分 → 进化拿更高分</b>。<br>本练习里先凑够分数（约 <b>8</b> 分）就算冠军（正式对局是 18 分）。<br><br>看屏幕里的「我的资源」：你已经捕捉了 <b>2 只凯西</b>，它们给了你 <b>2 个粉色折扣</b>，等下有用。',
      next: true,
    },
    {
      title: '① 拿精灵球（3 个不同色）',
      html: '每个回合只能做 <b>一个</b>主要行动，最常用的就是拿球。<br>规则：一次拿 <b>3 个不同颜色</b>的精灵球。<br>👇 在高亮的精灵球区，点 <b>3 个不同颜色</b>，再点「拿取 3 个」。',
      arrange: (g) => { for (const c of COLORS) g.supply[c] = 4; setTokens(g, {}); },
      target: () => confirmTake() || document.querySelector('#supply'),
      detect: (g, c) => tokenTotal(g) >= c.tok + 3,
    },
    {
      title: '② 拿精灵球（2 个同色）',
      html: '另一种拿法：拿 <b>2 个相同</b>颜色（仅当该颜色还剩 ≥4 个时才可以）。<br>👇 连点同一种颜色 <b>2 次</b>（例如黑色），再点「拿取 2 个」。',
      arrange: (g) => { for (const c of COLORS) g.supply[c] = 4; },
      target: () => confirmTake() || document.querySelector('#supply'),
      detect: (g, c) => tokenTotal(g) >= c.tok + 2,
    },
    {
      title: '③ 捕捉宝可梦',
      html: '<b>捕捉</b> = 花精灵球把宝可梦收入囊中，<b>立刻得分</b>。<br>看 <b>喇叭芽</b>：它要 2红+2粉，但你的 <b>2 个粉色折扣</b>把粉色全抵掉了，所以只要 <b>2 红</b>就能捕捉——你手上正好有 2 红！<br>👇 点高亮的 <b>喇叭芽</b>，再点「捕捉」。',
      arrange: (g) => { setTokens(g, { red: 2 }); placeField(g, 'stage1', 1, 's1_04'); E.refill(g, 'stage1'); },
      target: () => document.querySelector('.card[data-card="s1_04"]'),
      detect: (g) => P(g).board.includes('s1_04'),
    },
    {
      title: '④ 进化',
      html: '捕捉后，<b>回合结束时</b>可以进化！<br>喇叭芽能进化成 <b>口呆花</b>，条件是你拥有足够折扣球（这里要 2 个粉色，你正好有）。<br>⚠️ 关键：进化只看「折扣球」，<b>完全不花你手里的精灵球</b>。<br>👇 点高亮的 <b>进化</b> 按钮（它会在结算时出现）。',
      bodyClass: 'tut-hide-endturn',
      target: () => document.querySelector('.evo-option'),
      detect: (g, c) => P(g).buried.length > c.buried,
    },
    {
      title: '⑤ 保留（预订一张卡）',
      html: '想要的卡现在买不起？用 <b>保留</b> 把它收进手牌（最多 3 张，别人抢不走），还会 <b>白送 1 个大师球</b>（紫色万能球，能当任意颜色用，非常珍贵）。<br>👇 点一个高亮的 <b>牌堆</b>（虚线方块）来保留它顶上的牌。',
      target: () => document.querySelector('.deck-pile.reservable'),
      detect: (g, c) => P(g).reserve.length > c.reserve,
    },
    {
      title: '⑥ 拿下胜利！🏆',
      html: '最后一步！场上出现了强大的 <b>喷火龙（5 分）</b>，捕捉它你就达到目标，成为冠军训练家！<br>我已经帮你备好了刚好够用的精灵球。<br>👇 点高亮的 <b>喷火龙</b>，再点「捕捉」。',
      arrange: (g) => {
        const p = P(g);
        placeField(g, 'stage3', 0, 's3_11');   // 喷火龙 vp5
        const card = byId['s3_11'], b = E.bonuses(g, p);
        // set tokens to EXACTLY the (bonus-reduced) cost — never over 10, so no discard step
        const t = { red: 0, blue: 0, black: 0, pink: 0, yellow: 0, purple: 0 };
        for (const c of COLORS) t[c] = Math.max(0, (card.cost[c] || 0) - (b[c] || 0));
        p.tokens = t;
        g.winScore = score(g) + (card.vp || 0); // this single capture wins exactly
      },
      target: () => document.querySelector('.card[data-card="s3_11"]'),
      detect: (g) => g.phase === 'gameover',
    },
  ];

  const megaSteps = [
    {
      title: '超级进化扩展 ⚡',
      html: '有些宝可梦能变身成更强的 <b>Mega 形态</b>（分数更高、折扣更多）。<br>你已经捕捉了 <b>耿鬼</b>（看「我的资源」），我们来把它超级进化！',
      next: true,
    },
    {
      title: '① 获得 Mega 代币',
      html: '超级进化需要 <b>1 个 Mega 代币</b>。获得它要 <b>花掉一整个回合</b>（它本身就是一个主行动）。<br>👇 点供应区里高亮的 <b>Mega 代币</b>（彩色 ⚡ 球）。',
      target: () => document.querySelector('[data-take-mega]'),
      detect: (g) => P(g).megaToken >= 1,
    },
    {
      title: '② 超级进化！',
      html: '你持有了 Mega 代币，且收藏里有耿鬼，回合结束时就能 <b>超级进化</b>！<br>需要支付 Mega 卡的成本（这里 3 个红球，你正好有），并消耗掉 Mega 代币。<br>👇 点高亮的 <b>超级进化</b> 按钮。',
      bodyClass: 'tut-hide-endturn',
      target: () => document.querySelector('.evo-option.mega-evo'),
      detect: (g) => P(g).board.some(id => byId[id] && byId[id].tier === 'mega'),
    },
  ];

  const pokemartSteps = [
    {
      title: '欢迎光临 PokéMart 🛒',
      html: 'PokéMart 是一套可选的<b>商店扩展</b>：每个等级额外翻开 2 张道具卡，购买也算你这回合的主行动。<br><br>商店分为 <b>Lv.1 基础道具</b>、<b>Lv.2 进阶道具</b>、<b>Lv.3 高级道具</b>。道具与宝可梦一样可以得分、提供折扣，但还会触发特殊效果。',
      target: '.pokemart-head', next: true,
    },
    {
      title: '① 药水：一张抵两张',
      html: '<b>药水</b>会提供 <b>2 个同色永久折扣</b>，是快速发展经济的核心道具。<br>我已准备好刚好足够的球。👇 点高亮的<b>药水</b>，然后点「购买道具」。',
      arrange: (g) => { placeOnly(g, 'pmL2', 'pm_12'); setTokens(g, { blue: 4, pink: 3 }); },
      target: () => document.querySelector('.card[data-card="pm_12"]'),
      detect: (g) => P(g).board.includes('pm_12'),
    },
    {
      title: '② 技能机：复制一种折扣',
      html: '<b>技能机</b>没有固定颜色。获得时选择你已拥有的一张彩色卡，它就永久复制那种折扣。<br>👇 点<b>技能机</b>后选「购买道具」，再在弹窗中选一张关联卡。',
      arrange: (g) => { placeOnly(g, 'pmL1', 'pm_23'); setTokens(g, { red: 3, blue: 2 }); },
      target: () => document.querySelector('.card[data-card="pm_23"]'),
      detect: (g) => P(g).board.includes('pm_23') && !!P(g).assoc.pm_23,
    },
    {
      title: '③ 图鉴：需要时再抵款',
      html: '<b>图鉴</b>平时不给颜色折扣，但购买其他卡时可丢弃，当作 <b>2 个万能球</b>。<br>你已拥有一张图鉴，现在少 2 个红球。👇 捕捉高亮的<b>蚊香蝌蚪</b>，并确认弃用图鉴抵款。',
      arrange: (g) => { setBoard(g, ['s1_14', 'pm_06']); placeOnly(g, 'stage1', 's1_21'); setTokens(g, { red: 1 }); },
      target: () => document.querySelector('.card[data-card="s1_21"]'),
      detect: (g) => P(g).board.includes('s1_21') && !P(g).board.includes('pm_06'),
    },
    {
      title: '④ 神奇糖果：一次做两件事',
      html: '<b>神奇糖果</b>同时有两个效果：① 复制你已有的一种折扣；② 立即免费拿一张场上的 <b>Lv.1 道具或一级宝可梦</b>。<br>👇 购买神奇糖果，按顺序完成两次选择。',
      arrange: (g) => { setBoard(g, ['s1_14']); placeOnly(g, 'pmL2', 'pm_18'); g.field.pmL1.fill(null); placeOnly(g, 'stage1', 's1_07'); setTokens(g, { red: 1, blue: 4, black: 3 }); },
      target: () => document.querySelector('.card[data-card="pm_18"]'),
      detect: (g) => P(g).board.includes('pm_18'),
    },
    {
      title: '⑤ 进化石：免费拿二级卡',
      html: '<b>进化石</b>会让你立即免费拿一张场上的 <b>Lv.2 道具或二级宝可梦</b>。免费卡的效果也会继续触发。<br>👇 购买<b>进化石</b>，再选一张免费卡。',
      arrange: (g) => { placeOnly(g, 'pmL3', 'pm_02'); placeOnly(g, 'pmL2', 'pm_11'); g.field.stage2.fill(null); setTokens(g, { blue: 1, black: 6, pink: 3 }); },
      target: () => document.querySelector('.card[data-card="pm_02"]'),
      detect: (g) => P(g).board.includes('pm_02'),
    },
    {
      title: '⑥ 驱虫喷雾：弃卡换高分',
      html: '<b>驱虫喷雾</b>不花精灵球，而是弃掉指定颜色的 <b>2 张已拥有卡</b>，换取 3 分。会牺牲长期折扣，适合冲分收尾。<br>我已给你两张粉色卡。👇 购买高亮的<b>驱虫喷雾</b>，在弹窗中选两张作为代价。',
      arrange: (g) => { setBoard(g, ['s1_14', 's1_20']); placeOnly(g, 'pmL3', 'pm_28'); setTokens(g, {}); },
      target: () => document.querySelector('.card[data-card="pm_28"]'),
      detect: (g) => P(g).board.includes('pm_28'),
    },
    {
      title: '商店策略课 🎯',
      html: '你已学会全部 6 种道具！<br><br><b>前期</b>：药水、技能机建立折扣。<br><b>中期</b>：神奇糖果、进化石连锁拿卡。<br><b>关键回合</b>：图鉴补费用缺口。<br><b>收尾</b>：驱虫喷雾牺牲折扣换 3 分。<br><br>正式开局时，在设置页勾选 <b>PokéMart</b> 即可启用。',
      next: true,
    },
  ];

  // ---------------------------------------------------------------- coach overlay
  function ensureDOM() {
    if (document.getElementById('tut-bubble')) return;
    const mask = document.createElement('div'); mask.id = 'tut-mask'; mask.className = 'hidden';
    const bubble = document.createElement('div'); bubble.id = 'tut-bubble'; bubble.className = 'hidden';
    bubble.setAttribute('role', 'region'); bubble.setAttribute('aria-live', 'polite'); bubble.setAttribute('aria-labelledby', 'tut-title'); bubble.setAttribute('aria-describedby', 'tut-text');
    bubble.innerHTML = '<div id="tut-step"></div><div id="tut-title"></div><div id="tut-text"></div><div id="tut-actions"></div>';
    document.body.appendChild(mask); document.body.appendChild(bubble);
  }
  const resolve = (t) => (typeof t === 'function') ? t() : (t ? document.querySelector(t) : null);

  function positionSpot() {
    const s = steps[idx], mask = document.getElementById('tut-mask'); if (!mask) return;
    const t = s ? resolve(s.target) : null;
    if (!t) { mask.classList.add('hidden'); positionBubble(null); return; }
    const r = t.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { mask.classList.add('hidden'); positionBubble(null); return; }
    const pad = 8;
    mask.style.left = (r.left - pad) + 'px';
    mask.style.top = (r.top - pad) + 'px';
    mask.style.width = (r.width + pad * 2) + 'px';
    mask.style.height = (r.height + pad * 2) + 'px';
    mask.classList.remove('hidden');
    positionBubble(r);
  }

  function positionBubble(targetRect) {
    const bubble = document.getElementById('tut-bubble');
    if (!bubble || bubble.classList.contains('hidden')) return;
    const vv = window.visualViewport;
    const viewTop = vv ? vv.offsetTop : 0, viewH = vv ? vv.height : window.innerHeight;
    const safe = 10;
    bubble.style.maxHeight = '';                       // measure the natural height, not a previous cap
    const bh = Math.min(bubble.offsetHeight, viewH - safe * 2);
    // The lesson's follow-up tap (拿取 N 个 / 捕捉 / 保留 / 进化) lives in #action-bar, which sits
    // right above the supply. Keep the bubble off the bar as well as the target — on a phone the
    // "above the target" slot IS the bar, and a covered confirm button can't be pressed.
    let avoid = targetRect ? { top: targetRect.top, bottom: targetRect.bottom } : null;
    const bar = document.getElementById('action-bar');
    if (avoid && bar && !bar.classList.contains('hidden')) {
      const br = bar.getBoundingClientRect();
      const onScreen = br.width > 0 && br.height > 0 && br.bottom > viewTop && br.top < viewTop + viewH;
      if (onScreen) avoid = { top: Math.min(avoid.top, br.top), bottom: Math.max(avoid.bottom, br.bottom) };
    }
    const p = placeBubble({ viewTop, viewH, bh, safe, avoid });
    if (p.maxHeight) bubble.style.maxHeight = p.maxHeight + 'px';
    bubble.style.top = Math.round(p.top) + 'px';
  }

  function snapshot(g) {
    const p = P(g);
    return { board: p.board.length, buried: p.buried.length, reserve: p.reserve.length, tok: E.tokenTotal(p), mega: p.megaToken, score: E.scoreOf(g, p), phase: g.phase };
  }

  function showStep() {
    const s = steps[idx]; if (!s) { finish(); return; }
    if (s.arrange) s.arrange(PS.G);
    ctx = snapshot(PS.G);            // snapshot AFTER arrange but BEFORE render, so the
    if (s.arrange) PS.render();      // render here can't mis-detect against a stale baseline
    document.body.classList.remove('tut-hide-endturn');
    if (s.bodyClass) document.body.classList.add(s.bodyClass);
    document.getElementById('tut-step').textContent = '第 ' + (idx + 1) + ' / ' + steps.length + ' 步';
    document.getElementById('tut-title').innerHTML = s.title || '';
    document.getElementById('tut-text').innerHTML = s.html || '';
    const acts = document.getElementById('tut-actions'); acts.innerHTML = '';
    if (describedTarget) { describedTarget.removeAttribute('aria-describedby'); describedTarget = null; }
    if (s.next) {
      const nx = document.createElement('button'); nx.className = 'primary'; nx.textContent = '下一步 ▶'; nx.onclick = next; acts.appendChild(nx);
      setTimeout(() => nx.focus(), 0);
    } else {
      const hint = document.createElement('span'); hint.className = 'tut-hint'; hint.textContent = '按上面的提示操作…'; acts.appendChild(hint);
      const retry = document.createElement('button'); retry.className = 'ghost small'; retry.textContent = '重来本步'; retry.onclick = retryStep; acts.appendChild(retry);
    }
    const ex = document.createElement('button'); ex.className = 'ghost small'; ex.textContent = '退出教程'; ex.onclick = exit; acts.appendChild(ex);
    document.getElementById('tut-bubble').classList.remove('hidden');
    const t = resolve(s.target);
    if (t && t.scrollIntoView) {
      t.setAttribute('aria-describedby', 'tut-text'); describedTarget = t;
      try { t.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { }
      if (!s.next && t.focus) setTimeout(() => t.focus({ preventScroll: true }), 80);
    }
    positionSpot();
  }

  function next() { idx++; if (idx >= steps.length) finish(); else showStep(); }
  function retryStep() {
    const u = PS.UI;
    if (u) { u.pick = []; u.selCard = null; u.selDeck = null; u.busy = false; }
    showStep();
  }

  function finish() {
    active = false; removeListeners();
    document.body.classList.remove('tut-hide-endturn');
    const m = document.getElementById('tut-mask'); if (m) m.classList.add('hidden');
    const wm = document.getElementById('win-modal'); if (wm) wm.classList.add('hidden');
    const b = document.getElementById('tut-bubble'); if (!b) return;
    try { localStorage.setItem('ps-tutorial-complete-' + curMode, '1'); } catch (e) { }
    document.getElementById('tut-step').textContent = '教程完成';
    document.getElementById('tut-title').innerHTML = curMode === 'megas' ? '⚡ 学会超级进化！' : curMode === 'pokemart' ? '🛒 PokéMart 毕业！' : '🏆 恭喜通关！';
    document.getElementById('tut-text').innerHTML = curMode === 'megas'
      ? '耿鬼超级进化成了 <b>超级耿鬼</b>！<br>正式的超级进化对局：达到 <b>20 分 + 集齐 5 种颜色折扣 + 至少 1 只 Mega</b> 即获胜。去挑战吧！'
      : curMode === 'pokemart'
      ? '你已亲手操作了<b>药水、技能机、图鉴、神奇糖果、进化石和驱虫喷雾</b>。<br>现在可以开一局 PokéMart 扩展对局了！'
      : '你已经体验了 <b>拿球、捕捉、保留、进化</b>，并赢得了比赛！这就是游戏的核心循环。<br>现在去开始一局真正的对局，挑战电脑或朋友吧（正式对局先到 <b>18 分</b> 者胜）。';
    const acts = document.getElementById('tut-actions'); acts.innerHTML = '';
    const go = document.createElement('button'); go.className = 'primary';
    go.textContent = curMode === 'pokemart' ? '返回设置并启用 PokéMart' : curMode === 'megas' ? '返回设置并启用 Megas' : '返回设置开始对局';
    go.onclick = () => exit(curMode); acts.appendChild(go);
    if (curMode !== 'megas') { const ag = document.createElement('button'); ag.className = 'ghost small'; ag.textContent = '再练一次'; ag.onclick = () => start(curMode); acts.appendChild(ag); }
    b.classList.remove('hidden');
    setTimeout(() => go.focus(), 0);
  }

  function onRender(g) {
    if (!active) return;
    positionSpot();
    const s = steps[idx];
    if (s && s.detect) { try { if (s.detect(g, ctx || snapshot(g))) next(); } catch (e) { } }
  }

  // ---------------------------------------------------------------- lifecycle
  function onReflow() { positionSpot(); }
  function onTutorialKey(e) {
    if (e.key !== 'Escape' || !active) return;
    const dialog = document.querySelector('.modal:not(.hidden),#inspect:not(.hidden)');
    if (dialog) return; // the top-most dialog owns Escape
    exit();
  }
  function addListeners() { window.addEventListener('scroll', onReflow, true); window.addEventListener('resize', onReflow); document.addEventListener('keydown', onTutorialKey); }
  function removeListeners() { window.removeEventListener('scroll', onReflow, true); window.removeEventListener('resize', onReflow); document.removeEventListener('keydown', onTutorialKey); }

  function start(mode) {
    stop();
    ensureDOM();
    curMode = mode === 'megas' ? 'megas' : mode === 'pokemart' ? 'pokemart' : 'base';
    if (curMode === 'megas' && (!PS.MEGA_DB || !PS.MEGA_DB.length)) {   // mega tutorial needs the Megas data loaded
      alert('超级进化扩展未加载，暂时无法开始该教程。');
      return;
    }
    if (curMode === 'pokemart' && (!PS.POKEMART_DB || !PS.POKEMART_DB.length)) {
      alert('PokéMart 扩展未加载，暂时无法开始该教程。');
      return;
    }
    const g = curMode === 'megas' ? buildMega() : curMode === 'pokemart' ? buildPokemart() : buildBase();
    steps = curMode === 'megas' ? megaSteps : curMode === 'pokemart' ? pokemartSteps : baseSteps;
    idx = 0; ctx = null; active = true;
    addListeners();
    PS.enterGame(g, { humans: 1, hasAI: false });
    showStep();
  }
  function stop() {
    active = false; steps = []; idx = 0; ctx = null;
    removeListeners();
    if (describedTarget) { describedTarget.removeAttribute('aria-describedby'); describedTarget = null; }
    document.body.classList.remove('tut-hide-endturn');
    const b = document.getElementById('tut-bubble'); if (b) b.classList.add('hidden');
    const m = document.getElementById('tut-mask'); if (m) m.classList.add('hidden');
  }
  function exit(enableMode) {
    stop(); PS.backToSetup();
    if (enableMode === 'pokemart') { const el = document.getElementById('opt-pokemart'); if (el) { el.checked = true; el.dispatchEvent(new Event('change')); } }
    if (enableMode === 'megas') { const el = document.getElementById('opt-megas'); if (el) { el.checked = true; el.dispatchEvent(new Event('change')); } }
  }

  window.Tutorial = { start, stop, onRender, active: () => active };
})();
