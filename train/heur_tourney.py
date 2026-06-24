"""Quick check: new heuristic vs frozen old heuristic. Seats alternated, seeded.
   python heur_tourney.py [games]"""
import sys
import engine as E
import heuristic as NEW
import heuristic_v1 as OLD

E.load_cards()
N = int(sys.argv[1]) if len(sys.argv) > 1 else 80


def play(seed, f0, f1):
    s = E.new_game(2, seed=seed)
    plies = 0
    while not s['over'] and plies < 4000:
        f = f0 if s['turn'] == 0 else f1
        E.step(s, f(s))
        plies += 1
    return s


def match(A, B, n, seed0):
    aw = 0
    for i in range(n):
        aseat = i % 2
        s = play(seed0 + i, A if aseat == 0 else B, B if aseat == 0 else A)
        if s['winner'] == aseat:
            aw += 1
    return aw / n


import random as _r


def greedy_action(s):
    """Prefer the highest-VP affordable capture, else a random legal action (weak baseline)."""
    acts = E.legal_actions(s)
    if not acts:
        return E.A_PASS
    best, bv = None, -1
    for a in acts:
        if E.A_CAP_FIELD <= a < E.A_RES_FIELD:   # capture actions
            c = E.clone(s)
            E.step(c, a)
            v = E.score(c['players'][s['turn']])
            if v > bv:
                bv, best = v, a
    return best if best is not None else acts[_r.Random(s['round'] * 7 + s['turn']).randrange(len(acts))]


import time
t = time.time()
h2h = match(NEW.choose_action, OLD.choose_action, N, 10000)
ng = match(NEW.choose_action, greedy_action, N, 20000)
og = match(OLD.choose_action, greedy_action, N, 20000)   # same seeds → paired
print(f"NEW vs OLD(v1): NEW {h2h*100:.1f}%  ({int(round(h2h*N))}/{N})")
print(f"NEW vs greedy : {ng*100:.1f}%   OLD vs greedy : {og*100:.1f}%   (paired)")
print(f"{time.time()-t:.1f}s")
