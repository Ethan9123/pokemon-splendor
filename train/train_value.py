"""Value-net training for the heuristic-prior MCTS hybrid (the deep-research Top Pick).

Key choices (each fixes a diagnosed failure of our old AlphaZero):
  * Learn ONLY a value head v(s)∈[-1,1] that predicts the TRUE terminal outcome (win=+1 / not=-1)
    from the side-to-move's perspective. The heuristic stays the MCTS prior — we never try to learn
    a competitive policy (that is what plateaued at 37%). (small aux policy-CE to the heuristic move,
    weight 0.1, only shapes the trunk; never used at inference.)
  * Labels are REAL terminal outcomes, never bootstrapped (EfficientZero lesson) → stable in non-zero-sum.
  * Data from 2 / 3 / 4-player heuristic games (deploy is 2-4p) + later value-MCTS-vs-heuristic (expert
    iteration). A persistent heuristic ANCHOR pool is mixed into every batch (prevents drift).
  * 50k buffer (NOT 200k that aged out the anchor and caused the v1 collapse).
  * Eval = LARGE paired tournament vs heuristic with ROTATED seeds (fixes the 24-fixed-seed mis-gate).

  python train_value.py --smoke
  python train_value.py --minutes 360 --warm-games 900
"""
import os, sys, time, argparse, collections, random, json
import numpy as np
import torch
import torch.nn.functional as Fnn

import engine as E
import features as F
import heuristic as H
import vsearch as V
from net import PVNet

HERE = os.path.dirname(__file__)
CKPT = os.path.join(HERE, 'ckpt')
os.makedirs(CKPT, exist_ok=True)
DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'


def heuristic_game_positions(npl, rng):
    """Play one heuristic-vs-heuristic game; return [(feat, z, heur_action, mask)] with real outcomes."""
    s = E.new_game(npl, seed=rng.randint(0, 2**31))
    traj = []
    plies = 0
    while not s['over'] and plies < 2000:
        a = H.choose_action(s, noise=2.0, rng=rng)
        traj.append((F.encode(s), s['turn'], a, F.legal_mask(s)))
        E.step(s, a)
        plies += 1
    w = s['winner']
    return [(feat, 1.0 if turn == w else -1.0, act, mask) for (feat, turn, act, mask) in traj]


def value_mcts_game_positions(npl, net, rng, sims, dets):
    """Value-MCTS (net leaf) plays one seat vs heuristic the others; record the net-seat positions."""
    leaf = V.make_net_leaf(net, DEVICE)
    s = E.new_game(npl, seed=rng.randint(0, 2**31))
    net_seat = rng.randrange(npl)
    traj = []
    plies = 0
    while not s['over'] and plies < 2000:
        if s['turn'] == net_seat:
            a = V.value_mcts_move(s, leaf, sims=sims, dets=dets, rng=rng)
            traj.append((F.encode(s), s['turn'], a, F.legal_mask(s)))
        else:
            a = H.choose_action(s, noise=1.0, rng=rng)
        E.step(s, a)
        plies += 1
    w = s['winner']
    return [(feat, 1.0 if turn == w else -1.0, act, mask) for (feat, turn, act, mask) in traj]


def train_steps(net, opt, buf, anchor, steps, bs=512, anchor_frac=0.30, aux=0.1):
    if len(buf) < bs // 2:
        return 0.0, 0.0
    net.train()
    vl_tot = pl_tot = 0.0
    na = int(bs * anchor_frac) if len(anchor) >= 64 else 0
    nb = bs - na
    for _ in range(steps):
        idx = np.random.randint(0, len(buf), size=nb)
        sample = [buf[i] for i in idx]
        if na:
            aidx = np.random.randint(0, len(anchor), size=na)
            sample += [anchor[i] for i in aidx]
        feats = np.stack([x[0] for x in sample])
        zs = np.array([x[1] for x in sample], dtype=np.float32)
        acts = np.array([x[2] for x in sample], dtype=np.int64)
        x = torch.from_numpy(feats).to(DEVICE)
        tz = torch.from_numpy(zs).to(DEVICE)
        ta = torch.from_numpy(acts).to(DEVICE)
        logits, v = net(x)
        vloss = Fnn.mse_loss(v, tz)
        ploss = Fnn.cross_entropy(logits, ta)        # aux only — shapes trunk, ignored at inference
        loss = vloss + aux * ploss
        opt.zero_grad(); loss.backward(); opt.step()
        vl_tot += float(vloss.detach()); pl_tot += float(ploss.detach())
    net.eval()
    return vl_tot / steps, pl_tot / steps


def eval_vs_heuristic(net, n, sims, dets, seed0):
    """Paired tournament (seats alternated, rotated seeds) of value-MCTS vs the heuristic."""
    leaf = V.make_net_leaf(net, DEVICE)

    def play(seed, net_first):
        s = E.new_game(2, seed=seed)
        plies = 0
        while not s['over'] and plies < 4000:
            net_turn = (s['turn'] == 0) == net_first
            if net_turn:
                E.step(s, V.value_mcts_move(s, leaf, sims=sims, dets=dets))
            else:
                E.step(s, H.choose_action(s))
            plies += 1
        return s

    w = 0
    for i in range(n):
        net_first = (i % 2 == 0)
        s = play(seed0 + i, net_first)
        win_seat = 0 if net_first else 1
        if s['winner'] == win_seat:
            w += 1
    return w / n


def export_value_js(net, name='value.json'):
    sd = {k: v.detach().cpu().numpy().tolist() for k, v in net.state_dict().items()}
    meta = {'n_feat': F.N_FEAT, 'n_actions': E.N_ACTIONS, 'hidden': net.inp.out_features,
            'blocks': len(net.fcs), 'kind': 'value_hybrid'}
    json.dump({'meta': meta, 'weights': sd}, open(os.path.join(CKPT, name), 'w'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--minutes', type=float, default=300.0)
    ap.add_argument('--smoke', action='store_true')
    ap.add_argument('--warm-games', type=int, default=900)
    ap.add_argument('--sims', type=int, default=96)
    ap.add_argument('--dets', type=int, default=1)
    ap.add_argument('--eval-n', type=int, default=120)
    ap.add_argument('--ei-games', type=int, default=24)   # value-MCTS expert-iteration games per round
    args = ap.parse_args()
    if args.smoke:
        args.minutes = 0.0; args.warm_games = 40; args.eval_n = 16; args.sims = 48; args.ei_games = 4

    print(f"device={DEVICE} feat={F.N_FEAT}", flush=True)
    E.load_cards()
    net = PVNet().to(DEVICE)
    opt = torch.optim.Adam(net.parameters(), lr=1e-3, weight_decay=1e-4)
    rng = random.Random(12345)
    anchor = []
    buf = collections.deque(maxlen=50000)

    # ---- warm-fill: heuristic-vs-heuristic across 2/3/4p ----
    t = time.time()
    for g in range(args.warm_games):
        npl = rng.choice([2, 2, 2, 3, 4])
        for p in heuristic_game_positions(npl, rng):
            anchor.append(p); buf.append(p)
        if (g + 1) % 100 == 0:
            print(f"  warm {g+1}/{args.warm_games} games, buf={len(buf)} ({time.time()-t:.0f}s)", flush=True)
    if len(anchor) > 40000:
        anchor = anchor[-40000:]
    print(f"  warm done: {len(buf)} positions in {time.time()-t:.0f}s; pretraining value...", flush=True)
    for e in range(6):
        vl, pl = train_steps(net, opt, buf, anchor, steps=300)
        print(f"  bc value epoch {e}: vloss={vl:.3f} ploss={pl:.3f}", flush=True)

    best = -1.0
    wr = eval_vs_heuristic(net, args.eval_n, args.sims, args.dets, 90000)
    print(f"  post-warm value-MCTS(sims={args.sims}) vs heuristic: {wr*100:.1f}%", flush=True)
    if wr > best:
        best = wr; export_value_js(net, 'value_best.json')
    export_value_js(net, 'value.json')
    torch.save({'net': net.state_dict()}, os.path.join(CKPT, 'value_latest.pt'))

    # ---- expert iteration: add value-MCTS-vs-heuristic positions, re-train, re-eval ----
    deadline = time.time() + args.minutes * 60
    it = 0
    while time.time() < deadline:
        if os.path.exists(os.path.join(HERE, 'STOP')):
            print("STOP found; stopping.", flush=True); break
        it += 1
        t = time.time()
        for _ in range(args.ei_games):
            npl = rng.choice([2, 2, 3, 4])
            for p in value_mcts_game_positions(npl, net, rng, args.sims, args.dets):
                buf.append(p)
        vl, pl = train_steps(net, opt, buf, anchor, steps=400)
        msg = f"iter {it}: buf={len(buf)} vloss={vl:.3f} ploss={pl:.3f} sp={time.time()-t:.0f}s"
        if it % 3 == 0:
            wr = eval_vs_heuristic(net, args.eval_n, args.sims, args.dets, 90000 + it * 7919)
            msg += f" | value-MCTS vs heuristic={wr*100:.1f}% (best={best*100:.1f}%)"
            torch.save({'net': net.state_dict()}, os.path.join(CKPT, 'value_latest.pt'))
            export_value_js(net, 'value.json')
            if wr > best:
                best = wr
                torch.save({'net': net.state_dict()}, os.path.join(CKPT, 'value_best.pt'))
                export_value_js(net, 'value_best.json')
                msg += " *new best*"
        print(msg, flush=True)
    print(f"done. best value-MCTS winrate vs heuristic={best*100:.1f}%", flush=True)


if __name__ == '__main__':
    main()
