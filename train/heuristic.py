"""Strong strategy heuristic encoding the guide knowledge:
   - 神兽/稀有 (rare/legend) first: 2 same-colour discounts (+2VP for legend) seed a colour high-score flow.
   - Build a discount engine, chase the single best scoring target, evolve for free VP.
   - Concave token value (anti-hoard), colour focus, endgame VP push.
Used as the AlphaZero baseline opponent and warm-start teacher (1-ply eval search)."""
import engine as E

W_VP = 100.0
DENY = 10.0          # opponent-denial weight (matches js/ai.js hard)
_BYNAME = None       # species name -> best (max-VP) card, for evolved-VP estimates


def _evolved_vp(name):
    """Highest VP attainable for a species (estimate of an evolution's payoff)."""
    global _BYNAME
    if _BYNAME is None:
        _BYNAME = {}
        for cid, c in E._BYID.items():
            cur = _BYNAME.get(c['name'])
            if cur is None or c['vp'] > cur:
                _BYNAME[c['name']] = c['vp']
    return _BYNAME.get(name, 0)


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
    # 神兽/稀有 owned: each is a 2-bonus engine piece anchoring a colour flow (can't be reserved)
    rl = sum(1 for cid in p['board'] if E._BYID[cid]['tier'] in ('rare', 'legend'))
    sc += rl * 14
    # colour COHERENCE (高分流): a deep primary + a moderate secondary colour unlock the
    # expensive same-colour high-VP cards. Reward concentration over a flat 1-of-each spread.
    bvals = sorted((b[c] for c in E.COLORS), reverse=True)
    total_b = sum(bvals)
    sc += total_b * 4
    sc += min(bvals[0], 4) * 5 + min(bvals[1], 3) * 3
    distinct = sum(1 for v in bvals if v > 0)
    sc += min(distinct, 2) * 3
    if bvals[0] > 5:
        sc -= (bvals[0] - 5) * 3
    # tokens: concave with anti-hoard penalty
    toks = E.token_total(p)
    sc += min(toks, 5) * 1.0 + max(0, min(toks, 8) - 5) * 0.35
    sc -= max(0, toks - 8) * 1.6
    sc += p['tokens']['purple'] * 2.0
    sc += len(p['reserve']) * 0.5
    # proximity: top-2 attractive targets (field + own hand), incl. cheap evolvable cards
    early = s['round'] <= 6
    targets = []
    for tier in E.FIELD_TIERS:
        for cid in s['field'][tier]:
            if cid:
                targets.append(cid)
    targets += p['reserve']
    best_prox = 0.0
    prox2 = 0.0
    for cid in targets:
        card = E._BYID[cid]
        evo_vp = 0
        if card.get('evolvesTo'):
            evo_vp = max(0, _evolved_vp(card['evolvesTo']) - card['vp'])
        if not card['vp'] and card['tier'] != 'rare' and evo_vp <= 0:
            continue
        gap = card['cost'].get('purple', 0)
        for c in E.COLORS:
            gap += max(0, card['cost'].get(c, 0) - b[c] - p['tokens'][c])
        worth = card['vp'] + card.get('bonusCount', 1) * 1.5 + evo_vp * 0.7
        if card['tier'] in ('rare', 'legend'):
            worth += 6 if early else 3  # engine anchor, esp. early
        v = worth / (1 + gap * 1.4)
        if v > best_prox:
            prox2 = best_prox
            best_prox = v
        elif v > prox2:
            prox2 = v
    sc += (best_prox + prox2 * 0.4) * 11
    # opponent denial: penalise the strongest opponent's proximity to a big card, so
    # capturing/reserving the card they were about to buy is rewarded (slow them down).
    opp_max = 0.0
    for q in range(s['np']):
        if q == me:
            continue
        op = s['players'][q]
        ob = E.bonuses(op)
        oprox = 0.0
        for tier in E.FIELD_TIERS:
            for cid in s['field'][tier]:
                if not cid:
                    continue
                card = E._BYID[cid]
                is_rl = card['tier'] in ('rare', 'legend')
                if card['vp'] < 2 and not is_rl:
                    continue
                gap = card['cost'].get('purple', 0)
                for c in E.COLORS:
                    gap += max(0, card['cost'].get(c, 0) - ob[c] - op['tokens'][c])
                v = (card['vp'] + (3 if is_rl else 0)) / (1 + gap * 1.4)
                if v > oprox:
                    oprox = v
        if oprox > opp_max:
            opp_max = oprox
    sc -= opp_max * DENY
    # evolution potential: a caught Pokemon whose next form is available → near-free VP
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
        gain = max(0, _evolved_vp(card['evolvesTo']) - card['vp']) or 1
        sc += (gain * 6.0) / (1 + need)
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
