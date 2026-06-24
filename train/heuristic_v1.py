"""Strong strategy heuristic encoding the guide knowledge:
   - 神兽/稀有 (rare/legend) first: 2 same-colour discounts (+2VP for legend) seed a colour high-score flow.
   - Build a discount engine, chase the single best scoring target, evolve for free VP.
   - Concave token value (anti-hoard), colour focus, endgame VP push.
Used as the AlphaZero baseline opponent and warm-start teacher (1-ply eval search)."""
import engine as E

W_VP = 100.0


def eval_state(s, me):
    p = s['players'][me]
    b = E.bonuses(p)
    vp = E.score(p)
    sc = 0.0
    sc += vp * W_VP
    if vp >= 11:
        sc += (vp - 11) * 45
    if s['last_round']:
        sc += vp * 70
    # engine: owned discount cards + total discount power
    cards = len(p['board'])
    sc += cards * 16
    total_b = sum(b[c] for c in E.COLORS)
    sc += total_b * 4
    distinct = sum(1 for c in E.COLORS if b[c] > 0)
    sc += distinct * 4
    for c in E.COLORS:
        if b[c] > 4:
            sc -= (b[c] - 4) * 3
    # 神兽/稀有 owned: each is a 2-bonus engine piece anchoring a colour flow
    rl = sum(1 for cid in p['board'] if E._BYID[cid]['tier'] in ('rare', 'legend'))
    sc += rl * 10
    # tokens: concave with anti-hoard penalty
    toks = E.token_total(p)
    sc += min(toks, 5) * 1.0 + max(0, min(toks, 8) - 5) * 0.35
    sc -= max(0, toks - 8) * 1.6
    sc += p['tokens']['purple'] * 2.0
    sc += len(p['reserve']) * 0.5
    # proximity to the single most attractive target (field + own hand)
    targets = []
    for tier in E.FIELD_TIERS:
        for cid in s['field'][tier]:
            if cid:
                targets.append(cid)
    targets += p['reserve']
    best_prox = 0.0
    for cid in targets:
        card = E._BYID[cid]
        if not card['vp'] and card['tier'] != 'rare':
            continue
        gap = card['cost'].get('purple', 0)
        for c in E.COLORS:
            gap += max(0, card['cost'].get(c, 0) - b[c] - p['tokens'][c])
        worth = card['vp'] + card.get('bonusCount', 1) * 1.5
        if card['tier'] in ('rare', 'legend'):
            worth += 3  # high-priority anchors
        v = worth / (1 + gap * 1.4)
        if v > best_prox:
            best_prox = v
    sc += best_prox * 11
    # evolution potential: a caught Pokemon whose next form is available and nearly affordable
    names_field = set()
    for tier in E.FIELD_TIERS:
        for cid in s['field'][tier]:
            if cid:
                names_field.add(E._BYID[cid]['name'])
    for cid in p['reserve']:
        names_field.add(E._BYID[cid]['name'])
    for cid in p['board']:
        card = E._BYID[cid]
        if not card.get('evolvesTo') or not card.get('evoCost'):
            continue
        if card['evolvesTo'] not in names_field:
            continue
        need = max(0, card['evoCost']['count'] - b[card['evoCost']['color']])
        sc += 6.0 / (1 + max(0, need - p['tokens'][card['evoCost']['color']]))
    return sc


def choose_action(s, noise=0.0, rng=None):
    me = s['turn']
    acts = E.legal_actions(s)
    if not acts:
        return E.A_PASS
    best, best_sc = None, -1e18
    for a in acts:
        c = E.clone(s)
        E.step(c, a)
        v = eval_state(c, me)
        if noise and rng is not None:
            v += rng.uniform(-noise, noise)
        if v > best_sc:
            best_sc, best = v, a
    return best
