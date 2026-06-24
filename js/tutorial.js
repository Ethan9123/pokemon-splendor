/* ===================== Pokémon Splendor — 新手教程 (guided tutorial) =====================
 * A solo, fully-arranged practice game that walks a complete beginner through every action
 * (take balls / capture / reserve / evolve) and lets them win. Each lesson sets up its own
 * preconditions, so it is robust to mis-taps; completion is detected from cumulative state.
 * ====================================================================================== */
(function () {
  'use strict';
  const PS = window.PSGame;
  if (!PS) return;
  const E = PS.E;
  const byId = PS.byId;
  const COLORS = E.COLORS;
  const P = (g) => g.players[0];

  let active = false, curMode = 'base', steps = [], idx = 0, ctx = null;

  // ---------------------------------------------------------------- scenario builders
  function purge(g, id) {                       // remove an id from every deck and field slot
    for (const t of E.FIELD_TIERS) {
      g.decks[t] = g.decks[t].filter(x => x !== id);
      for (let i = 0; i < g.field[t].length; i++) if (g.field[t][i] === id) g.field[t][i] = null;
    }
  }
  function placeField(g, tier, slot, id) { purge(g, id); g.field[tier][slot] = id; }
  function give(g, id) { purge(g, id); P(g).board.push(id); }
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

  // ---------------------------------------------------------------- steps
  const baseSteps = [
    {
      title: '欢迎来到训练家学院 🎓',
      html: '这是《璀璨宝石·宝可梦》。核心其实只有一句话：<br><b>收集精灵球 → 捕捉宝可梦得分 → 进化拿更高分</b>。<br>本练习里先凑够分数（约 <b>8</b> 分）就算冠军（正式对局是 18 分）。<br><br>看屏幕里的「我的资源」：你已经捕捉了 <b>2 只凯西</b>，它们给了你 <b>2 个粉色折扣</b>，等下有用。',
      next: true,
    },
    {
      title: '① 拿精灵球（3 个不同色）',
      html: '每个回合只能做 <b>一个</b>主要行动，最常用的就是拿球。<br>规则：一次拿 <b>3 个不同颜色</b>的精灵球。<br>👇 在高亮的精灵球区，点 <b>3 个不同颜色</b>，再点「确定拿取」。',
      arrange: (g) => { for (const c of COLORS) g.supply[c] = 4; setTokens(g, {}); },
      target: '#supply',
      detect: (g, c) => tokenTotal(g) >= c.tok + 3,
    },
    {
      title: '② 拿精灵球（2 个同色）',
      html: '另一种拿法：拿 <b>2 个相同</b>颜色（仅当该颜色还剩 ≥4 个时才可以）。<br>👇 连点同一种颜色 <b>2 次</b>（例如黑色），再点「确定拿取」。',
      arrange: (g) => { for (const c of COLORS) g.supply[c] = 4; },
      target: '#supply',
      detect: (g, c) => tokenTotal(g) >= c.tok + 2,
    },
    {
      title: '③ 捕捉宝可梦',
      html: '<b>捕捉</b> = 花精灵球把宝可梦收入囊中，<b>立刻得分</b>。<br>看 <b>喇叭芽</b>：它要 2红+2粉，但你的 <b>2 个粉色折扣</b>把粉色全抵掉了，所以只要 <b>2 红</b>就能捕捉——你手上正好有 2 红！<br>👇 点高亮的 <b>喇叭芽</b>，再点「捕捉」。',
      arrange: (g) => { setTokens(g, { red: 2 }); placeField(g, 'stage1', 1, 's1_04'); E.refill(g, 'stage1'); },
      target: () => document.querySelector('.card[data-card="s1_04"]'),
      detect: (g, c) => P(g).board.length > c.board,
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

  // ---------------------------------------------------------------- coach overlay
  function ensureDOM() {
    if (document.getElementById('tut-bubble')) return;
    const mask = document.createElement('div'); mask.id = 'tut-mask'; mask.className = 'hidden';
    const bubble = document.createElement('div'); bubble.id = 'tut-bubble'; bubble.className = 'hidden';
    bubble.innerHTML = '<div id="tut-step"></div><div id="tut-title"></div><div id="tut-text"></div><div id="tut-actions"></div>';
    document.body.appendChild(mask); document.body.appendChild(bubble);
  }
  const resolve = (t) => (typeof t === 'function') ? t() : (t ? document.querySelector(t) : null);

  function positionSpot() {
    const s = steps[idx], mask = document.getElementById('tut-mask'); if (!mask) return;
    const t = s ? resolve(s.target) : null;
    if (!t) { mask.classList.add('hidden'); return; }
    const r = t.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { mask.classList.add('hidden'); return; }
    const pad = 8;
    mask.style.left = (r.left - pad) + 'px';
    mask.style.top = (r.top - pad) + 'px';
    mask.style.width = (r.width + pad * 2) + 'px';
    mask.style.height = (r.height + pad * 2) + 'px';
    mask.classList.remove('hidden');
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
    if (s.next) {
      const nx = document.createElement('button'); nx.className = 'primary'; nx.textContent = '下一步 ▶'; nx.onclick = next; acts.appendChild(nx);
    } else {
      const hint = document.createElement('span'); hint.className = 'tut-hint'; hint.textContent = '按上面的提示操作…'; acts.appendChild(hint);
      const sk = document.createElement('button'); sk.className = 'ghost small'; sk.textContent = '跳过此步'; sk.onclick = next; acts.appendChild(sk);
    }
    const ex = document.createElement('button'); ex.className = 'ghost small'; ex.textContent = '退出教程'; ex.onclick = exit; acts.appendChild(ex);
    document.getElementById('tut-bubble').classList.remove('hidden');
    const t = resolve(s.target);
    if (t && t.scrollIntoView) { try { t.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { } }
    positionSpot();
  }

  function next() { idx++; if (idx >= steps.length) finish(); else showStep(); }

  function finish() {
    active = false; removeListeners();
    document.body.classList.remove('tut-hide-endturn');
    const m = document.getElementById('tut-mask'); if (m) m.classList.add('hidden');
    const wm = document.getElementById('win-modal'); if (wm) wm.classList.add('hidden');
    const b = document.getElementById('tut-bubble'); if (!b) return;
    document.getElementById('tut-step').textContent = '教程完成';
    document.getElementById('tut-title').innerHTML = curMode === 'megas' ? '⚡ 学会超级进化！' : '🏆 恭喜通关！';
    document.getElementById('tut-text').innerHTML = curMode === 'megas'
      ? '耿鬼超级进化成了 <b>超级耿鬼</b>！<br>正式的超级进化对局：达到 <b>20 分 + 集齐 5 种颜色折扣 + 至少 1 只 Mega</b> 即获胜。去挑战吧！'
      : '你已经体验了 <b>拿球、捕捉、保留、进化</b>，并赢得了比赛！这就是游戏的核心循环。<br>现在去开始一局真正的对局，挑战电脑或朋友吧（正式对局先到 <b>18 分</b> 者胜）。';
    const acts = document.getElementById('tut-actions'); acts.innerHTML = '';
    const go = document.createElement('button'); go.className = 'primary'; go.textContent = '开始一局对局'; go.onclick = exit; acts.appendChild(go);
    if (curMode !== 'megas') { const ag = document.createElement('button'); ag.className = 'ghost small'; ag.textContent = '再练一次'; ag.onclick = () => start('base'); acts.appendChild(ag); }
    b.classList.remove('hidden');
  }

  function onRender(g) {
    if (!active) return;
    positionSpot();
    const s = steps[idx];
    if (s && s.detect) { try { if (s.detect(g, ctx || snapshot(g))) next(); } catch (e) { } }
  }

  // ---------------------------------------------------------------- lifecycle
  function onReflow() { positionSpot(); }
  function addListeners() { window.addEventListener('scroll', onReflow, true); window.addEventListener('resize', onReflow); }
  function removeListeners() { window.removeEventListener('scroll', onReflow, true); window.removeEventListener('resize', onReflow); }

  function start(mode) {
    stop();
    ensureDOM();
    curMode = (mode === 'megas') ? 'megas' : 'base';
    const g = curMode === 'megas' ? buildMega() : buildBase();
    steps = curMode === 'megas' ? megaSteps : baseSteps;
    idx = 0; ctx = null; active = true;
    addListeners();
    PS.enterGame(g, { humans: 1, hasAI: false });
    showStep();
  }
  function stop() {
    active = false; steps = []; idx = 0; ctx = null;
    removeListeners();
    document.body.classList.remove('tut-hide-endturn');
    const b = document.getElementById('tut-bubble'); if (b) b.classList.add('hidden');
    const m = document.getElementById('tut-mask'); if (m) m.classList.add('hidden');
  }
  function exit() { stop(); PS.backToSetup(); }

  window.Tutorial = { start, stop, onRender, active: () => active };
})();
