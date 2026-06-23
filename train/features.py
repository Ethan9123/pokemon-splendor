"""State -> feature vector (from the current player's perspective) + action mask."""
import numpy as np
import engine as E

COLOR_IDX = {c: i for i, c in enumerate(E.COLORS)}
TIER_IDX = {t: i for i, t in enumerate(E.FIELD_TIERS)}

# precompute static per-card features: [tier onehot(5), vp/5, bonus onehot(5), bonusCount/2, cost5/7, costpurple/1]
_CARD_FEAT = {}


def _card_static(card):
    f = np.zeros(18, dtype=np.float32)
    f[TIER_IDX[card['tier']]] = 1.0
    f[5] = card['vp'] / 5.0
    f[6 + COLOR_IDX[card['bonus']]] = 1.0
    f[11] = card.get('bonusCount', 1) / 2.0
    for c in E.COLORS:
        f[12 + COLOR_IDX[c]] = card['cost'].get(c, 0) / 7.0
    f[17] = card['cost'].get('purple', 0)  # 0 or 1
    return f


def _ensure_static():
    if _CARD_FEAT:
        return
    E.load_cards()
    for cid, card in E._BYID.items():
        _CARD_FEAT[cid] = _card_static(card)


# size: global(8) + 2*player(17) + field(14*21) + reserve(3*13) + decks(5)
FIELD_SLOT_F = 21
RES_SLOT_F = 13
N_FEAT = 8 + 2 * 17 + 14 * FIELD_SLOT_F + 3 * RES_SLOT_F + 5


def _player_block(s, pi):
    p = s['players'][pi]
    b = E.bonuses(p)
    out = np.zeros(17, dtype=np.float32)
    for c in E.COLORS:
        out[COLOR_IDX[c]] = b[c] / 5.0
    for i, c in enumerate(E.ALL_TOKENS):
        out[5 + i] = p['tokens'][c] / 10.0
    out[11] = E.score(p) / 18.0
    out[12] = len(p['board']) / 15.0
    out[13] = len(p['reserve']) / 3.0
    out[14] = len(p['buried']) / 10.0
    out[15] = sum(1 for cid in p['board'] if E._BYID[cid]['tier'] == 'rare') / 3.0
    out[16] = sum(1 for cid in p['board'] if E._BYID[cid]['tier'] == 'legend') / 3.0
    return out


def encode(s):
    _ensure_static()
    me = s['turn']
    opp = (me + 1) % s['np']
    p = s['players'][me]
    b = E.bonuses(p)
    feats = np.zeros(N_FEAT, dtype=np.float32)
    i = 0
    # global
    for c in E.ALL_TOKENS:
        feats[i] = s['supply'][c] / 7.0; i += 1
    feats[i] = min(s['round'], 40) / 40.0; i += 1
    feats[i] = 1.0 if s['last_round'] else 0.0; i += 1
    # players (me, opp)
    feats[i:i + 17] = _player_block(s, me); i += 17
    feats[i:i + 17] = _player_block(s, opp); i += 17
    # field
    board_names = {}
    for cid in p['board']:
        c = E._BYID[cid]
        if c.get('evolvesTo'):
            board_names[c['evolvesTo']] = True
    for (tier, slot) in E.FIELD_ORDER:
        cid = s['field'][tier][slot]
        if cid is None:
            i += FIELD_SLOT_F; continue
        card = E._BYID[cid]
        feats[i] = 1.0
        feats[i + 1:i + 1 + 18] = _CARD_FEAT[cid]
        feats[i + 19] = 1.0 if E.can_afford(s, p, card) else 0.0
        feats[i + 20] = 1.0 if card['name'] in board_names else 0.0
        i += FIELD_SLOT_F
    # my reserve
    for j in range(3):
        if j < len(p['reserve']):
            cid = p['reserve'][j]; card = E._BYID[cid]
            feats[i] = 1.0
            feats[i + 1] = card['vp'] / 5.0
            feats[i + 2 + COLOR_IDX[card['bonus']]] = 1.0
            for c in E.COLORS:
                feats[i + 7 + COLOR_IDX[c]] = card['cost'].get(c, 0) / 7.0
            feats[i + 12] = 1.0 if E.can_afford(s, p, card) else 0.0
        i += RES_SLOT_F
    # decks remaining
    for t in E.FIELD_TIERS:
        feats[i] = len(s['decks'][t]) / 35.0; i += 1
    return feats


def legal_mask(s):
    m = np.zeros(E.N_ACTIONS, dtype=np.float32)
    for a in E.legal_actions(s):
        m[a] = 1.0
    return m
