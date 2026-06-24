"""Determinized MCTS with a heuristic PRIOR and a pluggable LEAF evaluator.

Design (from the deep-research recommendation):
  - PRIOR over legal actions = softmaxed heuristic 1-ply eval  → strong, never-collapses guidance.
  - LEAF value = either a static heuristic margin (baseline, no learning) OR a learned value net.
  - CHANCE handling = re-determinize the unseen decks before each search (and average over a few
    determinizations), so the tree does NOT peek at the real deck order / overfit one drawn future.
  - 2p-style backup (value flips by player); approximate but fine for our mostly-2p deployment.

Public:
  value_mcts_move(state, leaf_fn, sims, dets)  -> best action index
  heuristic_leaf(s)                            -> static leaf value in [-1,1]
  make_net_leaf(net, device)                   -> leaf value from a trained value net
"""
import math
import random
import numpy as np
import engine as E
import heuristic as H
try:
    import features as F
except Exception:
    F = None

C_PUCT = 1.4
PRIOR_T = 90.0      # temperature on heuristic eval (eval scale ~ VP*100) for the prior
VAL_SCALE = 650.0   # heuristic static-value scale (≈ one strong lead saturates tanh)


def _heuristic_prior(s):
    """(legal actions, prior probs) — prior = softmax over the heuristic eval of each action's result."""
    acts = E.legal_actions(s)
    me = s['turn']
    ev = np.empty(len(acts), dtype=np.float64)
    for i, a in enumerate(acts):
        c = E.clone(s)
        E.step(c, a)
        ev[i] = H.eval_state(c, me)
    z = (ev - ev.max()) / PRIOR_T
    p = np.exp(z)
    p /= p.sum()
    return acts, p


def heuristic_leaf(s):
    """Static heuristic value in [-1,1] from the side-to-move's perspective (no rollout)."""
    me = s['turn']
    if s['over']:
        return 1.0 if s['winner'] == me else -1.0
    opp = max(H.eval_state(s, q) for q in range(s['np']) if q != me)
    return math.tanh((H.eval_state(s, me) - opp) / VAL_SCALE)


def make_net_leaf(net, device):
    def leaf(s):
        me = s['turn']
        if s['over']:
            return 1.0 if s['winner'] == me else -1.0
        feat = F.encode(s)[None, :]
        mask = F.legal_mask(s)[None, :]
        _, v = net.infer(feat, mask, device)
        return float(v[0])
    return leaf


class _Node:
    __slots__ = ('s', 'turn', 'over', 'winner', 'acts', 'P', 'N', 'W', 'children', 'expanded')

    def __init__(self, s):
        self.s = s
        self.turn = s['turn']
        self.over = s['over']
        self.winner = s['winner']
        self.acts = None
        self.P = None
        self.N = None
        self.W = None
        self.children = {}
        self.expanded = False


def _expand(node):
    if node.over:
        node.expanded = True
        return
    acts, p = _heuristic_prior(node.s)
    node.acts = acts
    node.P = p
    node.N = np.zeros(len(acts))
    node.W = np.zeros(len(acts))
    node.expanded = True


def _select(node):
    sq = math.sqrt(node.N.sum()) + 1e-8
    q = np.where(node.N > 0, node.W / np.maximum(node.N, 1e-9), 0.0)
    u = C_PUCT * node.P * sq / (1.0 + node.N)
    return int(np.argmax(q + u))


def _simulate(root, leaf_fn):
    path = []   # (node, action_index)
    node = root
    while True:
        if node.over:
            leaf_player = node.turn
            v_leaf = 1.0 if node.winner == node.turn else -1.0
            break
        bi = _select(node)
        a = node.acts[bi]
        path.append((node, bi))
        child = node.children.get(a)
        if child is None:
            c = E.clone(node.s)
            E.step(c, a)
            child = _Node(c)
            node.children[a] = child
            if child.over:
                leaf_player = child.turn
                v_leaf = 1.0 if child.winner == child.turn else -1.0
            else:
                _expand(child)
                leaf_player = child.turn
                v_leaf = leaf_fn(child.s)
            break
        node = child
    for (n, bi) in path:
        v = v_leaf if n.turn == leaf_player else -v_leaf
        n.N[bi] += 1.0
        n.W[bi] += v


def _determinize(s, rng):
    """Re-shuffle the unseen decks (field stays — it is observable). Removes deck-order peeking."""
    for tier in E.FIELD_TIERS:
        d = s['decks'][tier]
        rng.shuffle(d)


def value_mcts_move(state, leaf_fn, sims=128, dets=2, rng=None):
    """Return the best action: run `dets` determinizations × (sims/dets) simulations, most-visited root action."""
    rng = rng or random
    if state['over']:
        return E.A_PASS
    agg = {}
    per = max(1, sims // max(1, dets))
    for _ in range(dets):
        s = E.clone(state)
        _determinize(s, rng)
        root = _Node(s)
        _expand(root)
        if root.over or not root.acts:
            return E.A_PASS
        if len(root.acts) == 1:
            return root.acts[0]
        for _ in range(per):
            _simulate(root, leaf_fn)
        for i, a in enumerate(root.acts):
            agg[a] = agg.get(a, 0.0) + root.N[i]
    return max(agg, key=lambda a: agg[a])


def make_player(leaf_fn, sims=128, dets=2, seed=0):
    """A choose_action-compatible player using this search."""
    rng = random.Random(seed)
    return lambda s: value_mcts_move(s, leaf_fn, sims=sims, dets=dets, rng=rng)
