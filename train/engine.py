"""Pokemon-Splendor game engine — Python port of js/engine.js, tuned for RL self-play.

Single decision per turn = the main action (take / capture / reserve / pass).
Discards (over the 10-token limit) and end-of-turn evolution are auto-resolved
greedily inside step(), matching how the strategy guides play (evolve = free VP).
"""
import json, os, random, itertools

COLORS = ['red', 'blue', 'black', 'pink', 'yellow']
MASTER = 'purple'
ALL_TOKENS = COLORS + [MASTER]
NORMAL_TIERS = ['stage1', 'stage2', 'stage3']
FIELD_TIERS = ['stage1', 'stage2', 'stage3', 'rare', 'legend']
FIELD_SLOTS = {'stage1': 4, 'stage2': 4, 'stage3': 4, 'rare': 1, 'legend': 1}
SPECIAL_TIERS = ['rare', 'legend']
CANON_SPECIAL = {'rare': ['rr_06', 'rr_07', 'rr_08', 'rr_09', 'rr_10'],
                 'legend': ['lg_06', 'lg_07', 'lg_08', 'lg_09', 'lg_10']}
HAND_MAX = 3
TOKEN_MAX = 10
WIN_SCORE = 18

# ---- fixed discrete action space (53) ----
TAKE3 = list(itertools.combinations(range(5), 3))   # 10
N_TAKE3 = len(TAKE3)                                 # 10
A_TAKE3 = 0                                          # 0..9
A_TAKE2 = A_TAKE3 + N_TAKE3                          # 10..14 (double colour i)
A_TAKE1 = A_TAKE2 + 5                                # 15..19 (single colour i)
# field slot order for capture/reserve
FIELD_ORDER = []                                     # list of (tier, slot)
for t in FIELD_TIERS:
    for s in range(FIELD_SLOTS[t]):
        FIELD_ORDER.append((t, s))                   # 14 entries
NORMAL_FIELD_ORDER = [(t, s) for (t, s) in FIELD_ORDER if t in NORMAL_TIERS]  # 12
A_CAP_FIELD = A_TAKE1 + 5                            # 20..33 (capture field slot)
A_CAP_RES = A_CAP_FIELD + len(FIELD_ORDER)           # 34..36 (capture own reserve 0..2)
A_RES_FIELD = A_CAP_RES + HAND_MAX                   # 37..48 (reserve field normal slot)
A_RES_DECK = A_RES_FIELD + len(NORMAL_FIELD_ORDER)   # 49..51 (reserve deck top of stage1/2/3)
A_PASS = A_RES_DECK + 3                              # 52
N_ACTIONS = A_PASS + 1                               # 53

_CARDS = None
_BYID = None


def load_cards(path=None):
    global _CARDS, _BYID
    if _CARDS is not None:
        return _CARDS, _BYID
    if path is None:
        path = os.path.join(os.path.dirname(__file__), '..', 'data', 'cards.json')
    cards = json.load(open(path, encoding='utf-8'))
    _CARDS = cards
    _BYID = {c['id']: c for c in cards}
    return _CARDS, _BYID


def supply_for(n):
    each = 4 if n <= 2 else (5 if n == 3 else 7)
    s = {c: each for c in COLORS}
    s[MASTER] = 5
    return s


def new_game(num_players=2, seed=None, ai=None):
    load_cards()
    rng = random.Random(seed)
    decks = {}
    for tier in FIELD_TIERS:
        ids = [c['id'] for c in _CARDS if c['tier'] == tier]
        rng.shuffle(ids)
        decks[tier] = ids
    for tier in SPECIAL_TIERS:
        sset = set(CANON_SPECIAL[tier])
        decks[tier] = [i for i in decks[tier] if i in sset]
    field = {}
    for tier in FIELD_TIERS:
        field[tier] = []
        for _ in range(FIELD_SLOTS[tier]):
            field[tier].append(decks[tier].pop() if decks[tier] else None)
    players = []
    for i in range(num_players):
        players.append({'tokens': {c: 0 for c in ALL_TOKENS}, 'board': [], 'buried': [], 'reserve': []})
    return {'np': num_players, 'supply': supply_for(num_players), 'decks': decks, 'field': field,
            'players': players, 'turn': 0, 'round': 1, 'last_round': False, 'over': False, 'winner': None}


def clone(s):
    return {'np': s['np'], 'turn': s['turn'], 'round': s['round'], 'last_round': s['last_round'],
            'over': s['over'], 'winner': s['winner'],
            'supply': dict(s['supply']),
            'decks': {t: list(v) for t, v in s['decks'].items()},
            'field': {t: list(v) for t, v in s['field'].items()},
            'players': [{'tokens': dict(p['tokens']), 'board': list(p['board']),
                         'buried': list(p['buried']), 'reserve': list(p['reserve'])} for p in s['players']]}


# ---------- helpers ----------
def bonuses(p):
    b = {c: 0 for c in COLORS}
    for cid in p['board']:
        c = _BYID[cid]
        b[c['bonus']] += c.get('bonusCount', 1)
    return b


def score(p):
    return sum(_BYID[cid]['vp'] for cid in p['board'])


def token_total(p):
    return sum(p['tokens'].values())


def _payment(s, p, card):
    """Return dict of tokens to spend, or None if unaffordable."""
    b = bonuses(p)
    pay = {c: 0 for c in ALL_TOKENS}
    master_need = card['cost'].get('purple', 0)
    if master_need > p['tokens']['purple']:
        return None
    for c in COLORS:
        need = max(0, card['cost'].get(c, 0) - b[c])
        use = min(need, p['tokens'][c])
        pay[c] = use
        master_need += (need - use)
    if master_need > p['tokens']['purple']:
        return None
    pay['purple'] = master_need
    return pay


def can_afford(s, p, card):
    return _payment(s, p, card) is not None


def _refill(s, tier):
    sl = s['field'][tier]
    for i in range(len(sl)):
        if sl[i] is None and s['decks'][tier]:
            sl[i] = s['decks'][tier].pop()


def _locate(s, cid):
    for tier in FIELD_TIERS:
        if cid in s['field'][tier]:
            return ('field', tier, s['field'][tier].index(cid))
    for pi, pl in enumerate(s['players']):
        if cid in pl['reserve']:
            return ('reserve', pi, pl['reserve'].index(cid))
    return (None, None, None)


# ---------- legal actions ----------
def legal_actions(s):
    if s['over']:
        return []
    p = s['players'][s['turn']]
    acts = []
    avail = [c for c in COLORS if s['supply'][c] > 0]
    availset = set(avail)
    # take3
    for k, combo in enumerate(TAKE3):
        if all(COLORS[i] in availset for i in combo):
            acts.append(A_TAKE3 + k)
    # take2 (need >=4)
    for i, c in enumerate(COLORS):
        if s['supply'][c] >= 4:
            acts.append(A_TAKE2 + i)
    # take1 (only meaningful when fewer than 3 colours available; always allow if supply>0)
    if len(avail) < 3:
        for i, c in enumerate(COLORS):
            if s['supply'][c] > 0:
                acts.append(A_TAKE1 + i)
    # captures (field)
    for j, (tier, slot) in enumerate(FIELD_ORDER):
        cid = s['field'][tier][slot]
        if cid is not None and can_afford(s, p, _BYID[cid]):
            acts.append(A_CAP_FIELD + j)
    # captures (own reserve)
    for j in range(len(p['reserve'])):
        if can_afford(s, p, _BYID[p['reserve'][j]]):
            acts.append(A_CAP_RES + j)
    # reserves
    if len(p['reserve']) < HAND_MAX:
        for j, (tier, slot) in enumerate(NORMAL_FIELD_ORDER):
            if s['field'][tier][slot] is not None:
                acts.append(A_RES_FIELD + j)
        for i, tier in enumerate(NORMAL_TIERS):
            if s['decks'][tier]:
                acts.append(A_RES_DECK + i)
    if not acts:
        acts.append(A_PASS)
    return acts


# ---------- apply one main action ----------
def _do_take(s, colors):
    p = s['players'][s['turn']]
    for c in colors:
        s['supply'][c] -= 1
        p['tokens'][c] += 1


def _do_capture(s, cid):
    p = s['players'][s['turn']]
    card = _BYID[cid]
    pay = _payment(s, p, card)
    where, a, b = _locate(s, cid)
    for c in ALL_TOKENS:
        p['tokens'][c] -= pay[c]
        s['supply'][c] += pay[c]
    if where == 'reserve':
        s['players'][a]['reserve'].remove(cid)
    else:
        s['field'][a][b] = None
        _refill(s, a)
    p['board'].append(cid)


def _do_reserve_field(s, tier, slot):
    p = s['players'][s['turn']]
    cid = s['field'][tier][slot]
    s['field'][tier][slot] = None
    _refill(s, tier)
    p['reserve'].append(cid)
    if s['supply']['purple'] > 0:
        s['supply']['purple'] -= 1
        p['tokens']['purple'] += 1


def _do_reserve_deck(s, tier):
    p = s['players'][s['turn']]
    cid = s['decks'][tier].pop()
    p['reserve'].append(cid)
    if s['supply']['purple'] > 0:
        s['supply']['purple'] -= 1
        p['tokens']['purple'] += 1


# ---------- auto discard + evolution ----------
def _auto_discard(s):
    p = s['players'][s['turn']]
    b = bonuses(p)
    while token_total(p) > TOKEN_MAX:
        # discard the colour we hold most of and need least (bonus already high); keep master last
        best, bestkey = None, None
        for c in COLORS:
            if p['tokens'][c] > 0:
                key = (p['tokens'][c], b[c])  # most held, then most bonus (least needed)
                if bestkey is None or key > bestkey:
                    bestkey, best = key, c
        if best is None:
            best = MASTER
        p['tokens'][best] -= 1
        s['supply'][best] += 1


def _evolution_options(s):
    p = s['players'][s['turn']]
    b = bonuses(p)
    opts = []
    avail = []
    for tier in FIELD_TIERS:
        for slot, cid in enumerate(s['field'][tier]):
            if cid:
                avail.append((cid, 'field', tier, slot))
    for slot, cid in enumerate(p['reserve']):
        avail.append((cid, 'reserve', None, slot))
    for cid in p['board']:
        c = _BYID[cid]
        if not c.get('evolvesTo') or not c.get('evoCost'):
            continue
        need = max(0, c['evoCost']['count'] - b[c['evoCost']['color']])
        have = p['tokens'][c['evoCost']['color']]
        master_short = max(0, need - have)
        if master_short > p['tokens']['purple']:
            continue
        for (tid, twhere, ttier, tslot) in avail:
            if _BYID[tid]['name'] == c['evolvesTo']:
                gain = _BYID[tid]['vp'] - c['vp']
                opts.append({'from': cid, 'to': tid, 'color': c['evoCost']['color'],
                             'pay_color': min(need, have), 'pay_master': master_short,
                             'where': twhere, 'tier': ttier, 'slot': tslot, 'gain': gain})
    return opts


def _auto_evolve(s):
    opts = _evolution_options(s)
    opts = [o for o in opts if o['gain'] > 0]
    if not opts:
        return
    o = max(opts, key=lambda o: (o['gain'], -(o['pay_color'] + o['pay_master'])))
    p = s['players'][s['turn']]
    p['tokens'][o['color']] -= o['pay_color']; s['supply'][o['color']] += o['pay_color']
    p['tokens']['purple'] -= o['pay_master']; s['supply']['purple'] += o['pay_master']
    if o['where'] == 'field':
        s['field'][o['tier']][o['slot']] = None
        _refill(s, o['tier'])
    else:
        p['reserve'].remove(o['to'])
    p['board'].remove(o['from'])
    p['buried'].append(o['from'])
    p['board'].append(o['to'])


def _determine_winner(s):
    best = 0
    def rank(p):
        return (score(p), len(p['buried']), len(p['board']))
    for i in range(1, s['np']):
        if rank(s['players'][i]) > rank(s['players'][best]):
            best = i
    return best


def _end_turn(s):
    p = s['players'][s['turn']]
    if score(p) >= WIN_SCORE and not s['last_round']:
        s['last_round'] = True
    was_last = (s['turn'] == s['np'] - 1)
    if s['last_round'] and was_last:
        s['over'] = True
        s['winner'] = _determine_winner(s)
        return
    s['turn'] = (s['turn'] + 1) % s['np']
    if was_last:
        s['round'] += 1


def step(s, action):
    """Apply a main action then auto-resolve discard+evolution+end turn. Mutates s."""
    p = s['players'][s['turn']]
    if action < A_TAKE2:
        combo = TAKE3[action - A_TAKE3]
        _do_take(s, [COLORS[i] for i in combo])
    elif action < A_TAKE1:
        c = COLORS[action - A_TAKE2]
        _do_take(s, [c, c])
    elif action < A_CAP_FIELD:
        c = COLORS[action - A_TAKE1]
        _do_take(s, [c])
    elif action < A_CAP_RES:
        tier, slot = FIELD_ORDER[action - A_CAP_FIELD]
        _do_capture(s, s['field'][tier][slot])
    elif action < A_RES_FIELD:
        j = action - A_CAP_RES
        _do_capture(s, p['reserve'][j])
    elif action < A_RES_DECK:
        tier, slot = NORMAL_FIELD_ORDER[action - A_RES_FIELD]
        _do_reserve_field(s, tier, slot)
    elif action < A_PASS:
        tier = NORMAL_TIERS[action - A_RES_DECK]
        _do_reserve_deck(s, tier)
    else:
        pass  # PASS
    _auto_discard(s)
    _auto_evolve(s)
    _end_turn(s)
    return s, s['over'], s['winner']
