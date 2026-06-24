"""Paired tournament: vsearch (heuristic-prior MCTS) vs the 1-ply heuristic.
   python eval_vsearch.py [games] [sims] [dets]"""
import sys
import time
import engine as E
import heuristic as H
import vsearch as V

E.load_cards()
N = int(sys.argv[1]) if len(sys.argv) > 1 else 24
SIMS = int(sys.argv[2]) if len(sys.argv) > 2 else 64
DETS = int(sys.argv[3]) if len(sys.argv) > 3 else 1

leaf = V.heuristic_leaf


def search_player(s):
    return V.value_mcts_move(s, leaf, sims=SIMS, dets=DETS)


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


t = time.time()
r = match(search_player, H.choose_action, N, 30000)
dt = time.time() - t
print(f"vsearch(heur-leaf sims={SIMS} dets={DETS}) vs heuristic: {r*100:.1f}%  ({int(round(r*N))}/{N})   {dt:.1f}s  ({dt/N:.1f}s/game)")
