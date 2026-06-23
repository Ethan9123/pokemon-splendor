"""Batched AlphaZero MCTS over many parallel games (leaf evals batched on GPU)."""
import numpy as np
import engine as E
import features as F

C_PUCT = 1.6


class Node:
    __slots__ = ('state', 'player', 'over', 'winner', 'expanded', 'legal',
                 'P', 'N', 'W', 'children')

    def __init__(self, state):
        self.state = state
        self.player = state['turn']
        self.over = state['over']
        self.winner = state['winner']
        self.expanded = False
        self.legal = None
        self.P = None
        self.N = None
        self.W = None
        self.children = {}

    def terminal_value(self):
        # from this node's player perspective
        if self.winner is None:
            return 0.0
        return 1.0 if self.winner == self.player else -1.0


def _select(node):
    """Descend to a leaf; return (path_edges, leaf). path_edges: list of (node, action)."""
    path = []
    while True:
        if node.over:
            return path, node
        if not node.expanded:
            return path, node
        legal = node.legal
        N, W, P = node.N, node.W, node.P
        sqrt_sum = np.sqrt(N[legal].sum()) + 1e-8
        q = np.where(N[legal] > 0, W[legal] / np.maximum(N[legal], 1e-8), 0.0)
        u = C_PUCT * P[legal] * sqrt_sum / (1.0 + N[legal])
        a = legal[int(np.argmax(q + u))]
        child = node.children.get(a)
        if child is None:
            child = Node(E.step(E.clone(node.state), a)[0] if False else _child_state(node.state, a))
            node.children[a] = child
        path.append((node, a))
        node = child
        if not node.expanded and not node.over:
            return path, node


def _child_state(state, a):
    c = E.clone(state)
    E.step(c, a)
    return c


def _expand(node, prior):
    node.legal = np.array(E.legal_actions(node.state), dtype=np.int64)
    node.P = prior.copy()
    # renormalize prior over legal
    s = node.P[node.legal].sum()
    if s > 1e-8:
        node.P = node.P / s
    else:
        node.P = F.legal_mask(node.state) / max(1, len(node.legal))
    node.N = np.zeros(E.N_ACTIONS, dtype=np.float32)
    node.W = np.zeros(E.N_ACTIONS, dtype=np.float32)
    node.expanded = True


def _backup(path, leaf_player, v_ref):
    for (node, a) in path:
        v = v_ref if node.player == leaf_player else -v_ref
        node.N[a] += 1.0
        node.W[a] += v


def run_sims(roots, net, device, n_sims, add_noise=True, alpha=0.5, eps=0.25):
    # ensure roots expanded (with optional Dirichlet noise) via one batched eval
    need = [r for r in roots if not r.expanded and not r.over]
    if need:
        feats = np.stack([F.encode(r.state) for r in need])
        masks = np.stack([F.legal_mask(r.state) for r in need])
        P, V = net.infer(feats, masks, device)
        for r, p in zip(need, P):
            _expand(r, p)
    if add_noise:
        for r in roots:
            if r.over:
                continue
            legal = r.legal
            noise = np.random.dirichlet([alpha] * len(legal))
            r.P[legal] = (1 - eps) * r.P[legal] + eps * noise
    for _ in range(n_sims):
        paths = []
        leaves = []
        for r in roots:
            path, leaf = _select(r)
            paths.append(path)
            leaves.append(leaf)
        # split terminal vs needs-eval
        eval_idx = [i for i, lf in enumerate(leaves) if not lf.over]
        if eval_idx:
            feats = np.stack([F.encode(leaves[i].state) for i in eval_idx])
            masks = np.stack([F.legal_mask(leaves[i].state) for i in eval_idx])
            P, V = net.infer(feats, masks, device)
            for k, i in enumerate(eval_idx):
                _expand(leaves[i], P[k])
                _backup(paths[i], leaves[i].player, float(V[k]))
        for i, lf in enumerate(leaves):
            if lf.over:
                _backup(paths[i], lf.player, lf.terminal_value())


def root_policy(root):
    pi = np.zeros(E.N_ACTIONS, dtype=np.float32)
    if root.N is not None:
        pi = root.N.copy()
    s = pi.sum()
    if s > 0:
        pi /= s
    return pi
