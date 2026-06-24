"""AlphaZero (teacher-anchored expert iteration) for Pokemon-Splendor.

  python train.py --hours 9            # long run, checkpoints to train/ckpt/
  python train.py --smoke              # quick pipeline smoke test

Why this design (v2):
  Pure net-vs-net self-play REGRESSED below the scripted heuristic — the BC
  warm-start aged out of the replay buffer and the net forgot the heuristic's
  competence (greedy winrate collapsed 30%->8%, mcts 40%->25%).
  Fixes:
    1. Persistent heuristic ANCHOR pool, mixed into every training batch
       (anchor_frac) so the policy can never drift below the teacher.
    2. Batched net(MCTS)-vs-heuristic games each iter: the net gets training
       targets + outcomes against the exact opponent it must beat.
    3. best.pt / deployed policy.json gated on MCTS winrate (what the JS uses),
       not greedy winrate.
    4. Higher self-play sims + lower LR for stabler targets.
Create train/STOP to stop gracefully.
"""
import os, sys, time, argparse, collections, json, random
import numpy as np
import torch
import torch.nn.functional as Fnn

import engine as E
import features as F
import heuristic as H
from net import PVNet
import mcts as M

HERE = os.path.dirname(__file__)
CKPT = os.path.join(HERE, 'ckpt')
os.makedirs(CKPT, exist_ok=True)
DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'


# --------------------------- batched net-vs-net self-play ---------------------------
class Slot:
    def __init__(self, seed):
        self.reset(seed)

    def reset(self, seed):
        self.state = E.new_game(2, seed=seed)
        self.root = M.Node(self.state)
        self.samples = []   # (feat, pi, player)
        self.moves = 0


def selfplay_iter(net, n_games, batch=64, sims=112, temp_moves=14):
    slots = [Slot(random.randint(0, 2**31)) for _ in range(batch)]
    finished = []
    while len(finished) < n_games:
        roots = [sl.root for sl in slots]
        M.run_sims(roots, net, DEVICE, sims, add_noise=True)
        for sl in slots:
            r = sl.root
            pi = M.root_policy(r)
            sl.samples.append([F.encode(r.state), pi, r.player])
            legal = r.legal
            counts = r.N[legal]
            if sl.moves < temp_moves and counts.sum() > 0:
                probs = counts / counts.sum()
                a = int(np.random.choice(legal, p=probs))
            else:
                a = int(legal[int(np.argmax(counts))]) if counts.sum() > 0 else int(legal[0])
            child = r.children.get(a)
            if child is None:
                child = M.Node(E.step(E.clone(r.state), a)[0])
            sl.moves += 1
            if child.over:
                w = child.winner
                for s in sl.samples:
                    s.append(0.0 if w is None else (1.0 if s[2] == w else -1.0))
                finished.append(sl.samples)
                sl.reset(random.randint(0, 2**31))
            else:
                sl.state = child.state
                sl.root = child
    return finished


# --------------------------- batched net(MCTS)-vs-heuristic ---------------------------
class HSlot:
    __slots__ = ('s', 'seat', 'samples', 'moves')

    def __init__(self, seed, seat):
        self.s = E.new_game(2, seed=seed)
        self.seat = seat
        self.samples = []
        self.moves = 0


def vs_heur_iter(net, n_games, batch=32, sims=112, temp_moves=10):
    """Net plays a fixed seat with MCTS; heuristic plays the other. Record the
    net's MCTS root policy as the training target, value = game outcome for the
    net's seat. All net-to-move roots across slots are batched per tick."""
    rng = random
    slots = [HSlot(rng.randint(0, 2**31), i % 2) for i in range(batch)]
    finished = []

    def finalize(g):
        w = g.s['winner']
        z = 0.0 if w is None else (1.0 if w == g.seat else -1.0)
        for smp in g.samples:
            smp.append(z)
        finished.append(g.samples)

    def advance(g):
        # roll heuristic replies until it's the net's move (or finalize+reset on terminal)
        while True:
            while not g.s['over'] and g.s['turn'] != g.seat:
                E.step(g.s, H.choose_action(g.s, noise=1.0, rng=rng))
            if g.s['over']:
                finalize(g)
                if len(finished) >= n_games:
                    return False
                g.s = E.new_game(2, seed=rng.randint(0, 2**31)); g.samples = []; g.moves = 0
                continue
            return True

    while len(finished) < n_games:
        active = []
        for g in slots:
            if advance(g):
                active.append(g)
        if len(finished) >= n_games or not active:
            break
        roots = [M.Node(E.clone(g.s)) for g in active]
        M.run_sims(roots, net, DEVICE, sims, add_noise=True)
        for g, r in zip(active, roots):
            g.samples.append([F.encode(g.s), M.root_policy(r), g.seat])
            legal = r.legal
            counts = r.N[legal]
            if g.moves < temp_moves and counts.sum() > 0:
                a = int(np.random.choice(legal, p=counts / counts.sum()))
            else:
                a = int(legal[int(np.argmax(counts))]) if counts.sum() > 0 else int(legal[0])
            g.moves += 1
            E.step(g.s, a)
    return finished


# --------------------------- evaluation ---------------------------
def eval_vs_heuristic(net, n=30, sims=0):
    """Net (policy-greedy, or light MCTS if sims>0) vs heuristic, seats alternated."""
    wins = 0
    for g in range(n):
        seat = g % 2
        s = E.new_game(2, seed=90000 + g)
        plies = 0
        while not s['over'] and plies < 3000:
            if s['turn'] == seat:
                if sims > 0:
                    root = M.Node(E.clone(s))
                    M.run_sims([root], net, DEVICE, sims, add_noise=False)
                    legal = root.legal
                    a = int(legal[int(np.argmax(root.N[legal]))])
                else:
                    feat = F.encode(s)[None, :]
                    mask = F.legal_mask(s)[None, :]
                    P, V = net.infer(feat, mask, DEVICE)
                    a = int(np.argmax(P[0]))
                E.step(s, a)
            else:
                E.step(s, H.choose_action(s))
            plies += 1
        if s['winner'] == seat:
            wins += 1
    return wins / n


# --------------------------- training (anchor-mixed) ---------------------------
def train_mixed(net, opt, buf, anchor, steps, bs=512, anchor_frac=0.35):
    if len(buf) < bs // 2:
        return 0.0, 0.0
    net.train()
    pl_tot = vl_tot = 0.0
    na = int(bs * anchor_frac) if len(anchor) >= 64 else 0
    nb = bs - na
    for _ in range(steps):
        idx = np.random.randint(0, len(buf), size=nb)
        samples = [buf[i] for i in idx]
        if na:
            aidx = np.random.randint(0, len(anchor), size=na)
            samples += [anchor[i] for i in aidx]
        feats = np.stack([x[0] for x in samples])
        pis = np.stack([x[1] for x in samples])
        zs = np.array([x[3] for x in samples], dtype=np.float32)
        x = torch.from_numpy(feats).to(DEVICE)
        tp = torch.from_numpy(pis).to(DEVICE)
        tz = torch.from_numpy(zs).to(DEVICE)
        logits, v = net(x)
        logp = Fnn.log_softmax(logits, dim=-1)
        ploss = -(tp * logp).sum(dim=-1).mean()
        vloss = Fnn.mse_loss(v, tz)
        loss = ploss + vloss
        opt.zero_grad(); loss.backward(); opt.step()
        pl_tot += float(ploss.detach()); vl_tot += float(vloss.detach())
    net.eval()
    return pl_tot / steps, vl_tot / steps


# --------------------------- warm start / anchor (behavioral cloning) ---------------------------
def heuristic_games(n):
    data = []
    for g in range(n):
        s = E.new_game(2, seed=random.randint(0, 2**31))
        traj = []
        plies = 0
        while not s['over'] and plies < 2000:
            a = H.choose_action(s, noise=2.0, rng=random)
            pi = np.zeros(E.N_ACTIONS, dtype=np.float32); pi[a] = 1.0
            traj.append([F.encode(s), pi, s['turn']])
            E.step(s, a); plies += 1
        w = s['winner']
        for t in traj:
            t.append(0.0 if w is None else (1.0 if t[2] == w else -1.0))
        data.extend(traj)
    return data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--hours', type=float, default=9.0)
    ap.add_argument('--smoke', action='store_true')
    ap.add_argument('--batch', type=int, default=64)
    ap.add_argument('--sims', type=int, default=112)
    ap.add_argument('--games-per-iter', type=int, default=40)
    ap.add_argument('--vs-heur-games', type=int, default=16)
    ap.add_argument('--pretrain-games', type=int, default=600)
    ap.add_argument('--anchor-frac', type=float, default=0.35)
    ap.add_argument('--anchor-cap', type=int, default=90000)
    ap.add_argument('--anchor-refresh', type=int, default=9)   # add fresh heuristic games every N iters
    ap.add_argument('--eval-sims', type=int, default=96)
    ap.add_argument('--lr', type=float, default=4e-4)
    ap.add_argument('--resume', action='store_true')
    args = ap.parse_args()
    if args.smoke:
        args.hours = 0.04; args.batch = 8; args.sims = 16; args.games_per_iter = 6
        args.vs_heur_games = 4; args.pretrain_games = 24; args.eval_sims = 12; args.anchor_refresh = 2

    print(f"device={DEVICE} feat={F.N_FEAT} actions={E.N_ACTIONS} sims={args.sims} "
          f"vs_heur={args.vs_heur_games} anchor_frac={args.anchor_frac} lr={args.lr}", flush=True)
    net = PVNet().to(DEVICE)
    opt = torch.optim.Adam(net.parameters(), lr=args.lr, weight_decay=1e-4)
    buf = collections.deque(maxlen=200000)
    anchor = collections.deque(maxlen=args.anchor_cap)
    it0 = 0
    best_wr = 0.0

    if args.resume and os.path.exists(os.path.join(CKPT, 'latest.pt')):
        ck = torch.load(os.path.join(CKPT, 'latest.pt'), map_location=DEVICE)
        net.load_state_dict(ck['net']); opt.load_state_dict(ck['opt']); it0 = ck.get('iter', 0)
        best_wr = ck.get('best_wr', 0.0)
        print(f"resumed at iter {it0} (best_wr={best_wr*100:.0f}%) — rebuilding anchor...", flush=True)
        for d in heuristic_games(args.pretrain_games):
            anchor.append(d)
    else:
        # warm-start: behavioral clone the heuristic, and KEEP it as the anchor
        print(f"warm-start: generating {args.pretrain_games} heuristic games...", flush=True)
        t = time.time()
        bc = heuristic_games(args.pretrain_games)
        for d in bc:
            anchor.append(d); buf.append(d)
        print(f"  {len(bc)} samples in {time.time()-t:.0f}s; pretraining policy+value...", flush=True)
        for e in range(4):
            pl, vl = train_mixed(net, opt, buf, anchor, steps=150, bs=512, anchor_frac=1.0)
            print(f"  bc epoch {e}: ploss={pl:.3f} vloss={vl:.3f}", flush=True)
        g0 = eval_vs_heuristic(net, n=30)
        m0 = eval_vs_heuristic(net, n=20, sims=args.eval_sims)
        best_wr = m0
        print(f"  post-BC vs heuristic: greedy={g0*100:.0f}% mcts={m0*100:.0f}%", flush=True)
        torch.save({'net': net.state_dict(), 'opt': opt.state_dict(), 'iter': 0, 'best_wr': best_wr},
                   os.path.join(CKPT, 'latest.pt'))
        torch.save({'net': net.state_dict(), 'iter': 0, 'wr': best_wr}, os.path.join(CKPT, 'best.pt'))
        export_js(net, 'policy.json'); export_js(net, 'policy_best.json')

    deadline = time.time() + args.hours * 3600
    it = it0
    while time.time() < deadline:
        if os.path.exists(os.path.join(HERE, 'STOP')):
            print("STOP file found; stopping.", flush=True); break
        it += 1
        t = time.time()
        games = selfplay_iter(net, args.games_per_iter, batch=args.batch, sims=args.sims)
        vh = vs_heur_iter(net, args.vs_heur_games, batch=max(16, args.batch // 2), sims=args.sims)
        for grp in (games, vh):
            for g in grp:
                for s in g:
                    buf.append(s)
        sp_t = time.time() - t
        if args.anchor_refresh and it % args.anchor_refresh == 0:
            for d in heuristic_games(max(8, args.pretrain_games // 12)):
                anchor.append(d)
        t = time.time()
        pl, vl = train_mixed(net, opt, buf, anchor, steps=400, bs=512, anchor_frac=args.anchor_frac)
        tr_t = time.time() - t
        msg = (f"iter {it}: sp_games={len(games)}+{len(vh)} buf={len(buf)} anc={len(anchor)} "
               f"ploss={pl:.3f} vloss={vl:.3f} sp={sp_t:.0f}s tr={tr_t:.0f}s")
        if it % 3 == 0:
            wr = eval_vs_heuristic(net, n=40)
            wr_mcts = eval_vs_heuristic(net, n=24, sims=args.eval_sims)
            msg += f" | vs-heur greedy={wr*100:.0f}% mcts={wr_mcts*100:.0f}% (best={best_wr*100:.0f}%)"
            torch.save({'net': net.state_dict(), 'opt': opt.state_dict(), 'iter': it, 'best_wr': best_wr},
                       os.path.join(CKPT, 'latest.pt'))
            export_js(net, 'policy_latest.json')
            if wr_mcts > best_wr:           # gate deployment on MCTS winrate (JS uses MCTS)
                best_wr = wr_mcts
                torch.save({'net': net.state_dict(), 'iter': it, 'wr': wr_mcts}, os.path.join(CKPT, 'best.pt'))
                export_js(net, 'policy.json'); export_js(net, 'policy_best.json')
                msg += " *new best -> deployed*"
        print(msg, flush=True)
    print(f"done. best mcts winrate vs heuristic={best_wr*100:.0f}%", flush=True)


# --------------------------- JS export ---------------------------
def export_js(net, name='policy.json'):
    sd = {k: v.detach().cpu().numpy().tolist() for k, v in net.state_dict().items()}
    meta = {'n_feat': F.N_FEAT, 'n_actions': E.N_ACTIONS, 'hidden': net.inp.out_features,
            'blocks': len(net.fcs)}
    json.dump({'meta': meta, 'weights': sd}, open(os.path.join(CKPT, name), 'w'))


if __name__ == '__main__':
    main()
