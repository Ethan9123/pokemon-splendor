"""AlphaZero training for Pokemon-Splendor.

  python train.py --hours 9            # long run, checkpoints to train/ckpt/
  python train.py --smoke              # quick pipeline smoke test

Warm-starts the net by cloning the strategy heuristic, then improves it with
MCTS self-play. Checkpoints + JS export (ckpt/policy.json) written periodically.
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


# --------------------------- self-play ---------------------------
class Slot:
    def __init__(self, seed):
        self.reset(seed)

    def reset(self, seed):
        self.state = E.new_game(2, seed=seed)
        self.root = M.Node(self.state)
        self.samples = []   # (feat, pi, player)
        self.moves = 0


def selfplay_iter(net, n_games, batch=48, sims=64, temp_moves=14):
    slots = [Slot(random.randint(0, 2**31)) for _ in range(batch)]
    finished = []
    while len(finished) < n_games:
        roots = [sl.root for sl in slots]
        M.run_sims(roots, net, DEVICE, sims, add_noise=True)
        for sl in slots:
            r = sl.root
            if r.over:  # safety
                pass
            pi = M.root_policy(r)
            feat = F.encode(r.state)
            sl.samples.append([feat, pi, r.player])
            # choose action
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
                z = 0.0 if child.winner is None else 1.0
                w = child.winner
                for s in sl.samples:
                    s.append(1.0 if s[2] == w else -1.0)
                finished.append(sl.samples)
                sl.reset(random.randint(0, 2**31))
            else:
                sl.state = child.state
                sl.root = child
    return finished


# --------------------------- evaluation ---------------------------
def eval_vs_heuristic(net, n=30, sims=0):
    """Policy-greedy (deployment-style) net vs heuristic. sims>0 uses light MCTS."""
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


# --------------------------- training ---------------------------
def train_on_buffer(net, opt, buf, steps, bs=512):
    if len(buf) < bs:
        return 0.0, 0.0
    net.train()
    pl_tot = vl_tot = 0.0
    for _ in range(steps):
        idx = np.random.randint(0, len(buf), size=bs)
        feats = np.stack([buf[i][0] for i in idx])
        pis = np.stack([buf[i][1] for i in idx])
        zs = np.array([buf[i][3] for i in idx], dtype=np.float32)
        x = torch.from_numpy(feats).to(DEVICE)
        tp = torch.from_numpy(pis).to(DEVICE)
        tz = torch.from_numpy(zs).to(DEVICE)
        logits, v = net(x)
        logp = Fnn.log_softmax(logits, dim=-1)
        ploss = -(tp * logp).sum(dim=-1).mean()
        vloss = Fnn.mse_loss(v, tz)
        loss = ploss + vloss
        opt.zero_grad(); loss.backward(); opt.step()
        pl_tot += float(ploss); vl_tot += float(vloss)
    net.eval()
    return pl_tot / steps, vl_tot / steps


# --------------------------- warm start (behavioral cloning) ---------------------------
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
            t.append(1.0 if t[2] == w else -1.0)
        data.extend(traj)
    return data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--hours', type=float, default=9.0)
    ap.add_argument('--smoke', action='store_true')
    ap.add_argument('--batch', type=int, default=64)
    ap.add_argument('--sims', type=int, default=80)
    ap.add_argument('--games-per-iter', type=int, default=60)
    ap.add_argument('--pretrain-games', type=int, default=600)
    ap.add_argument('--resume', action='store_true')
    args = ap.parse_args()
    if args.smoke:
        args.hours = 0.03; args.batch = 8; args.sims = 16; args.games_per_iter = 8; args.pretrain_games = 30

    print(f"device={DEVICE} feat={F.N_FEAT} actions={E.N_ACTIONS}", flush=True)
    net = PVNet().to(DEVICE)
    opt = torch.optim.Adam(net.parameters(), lr=1e-3, weight_decay=1e-4)
    buf = collections.deque(maxlen=200000)
    it0 = 0
    if args.resume and os.path.exists(os.path.join(CKPT, 'latest.pt')):
        ck = torch.load(os.path.join(CKPT, 'latest.pt'), map_location=DEVICE)
        net.load_state_dict(ck['net']); opt.load_state_dict(ck['opt']); it0 = ck.get('iter', 0)
        print(f"resumed at iter {it0}", flush=True)
    else:
        # warm-start: behavioral clone the heuristic
        print(f"warm-start: generating {args.pretrain_games} heuristic games...", flush=True)
        t = time.time()
        bc = heuristic_games(args.pretrain_games)
        for d in bc:
            buf.append(d)
        print(f"  {len(bc)} samples in {time.time()-t:.0f}s; pretraining policy+value...", flush=True)
        for e in range(4):
            pl, vl = train_on_buffer(net, opt, buf, steps=150, bs=512)
            print(f"  bc epoch {e}: ploss={pl:.3f} vloss={vl:.3f}", flush=True)
        wr = eval_vs_heuristic(net, n=30)
        print(f"  post-BC policy-greedy vs heuristic: {wr*100:.0f}%", flush=True)
        torch.save({'net': net.state_dict(), 'opt': opt.state_dict(), 'iter': 0}, os.path.join(CKPT, 'latest.pt'))
        export_js(net)

    deadline = time.time() + args.hours * 3600
    best_wr = 0.0
    it = it0
    while time.time() < deadline:
        if os.path.exists(os.path.join(HERE, 'STOP')):
            print("STOP file found; stopping.", flush=True); break
        it += 1
        t = time.time()
        games = selfplay_iter(net, args.games_per_iter, batch=args.batch, sims=args.sims)
        for g in games:
            for s in g:
                buf.append(s)
        sp_t = time.time() - t
        t = time.time()
        pl, vl = train_on_buffer(net, opt, buf, steps=400, bs=512)
        tr_t = time.time() - t
        msg = f"iter {it}: games={len(games)} buf={len(buf)} ploss={pl:.3f} vloss={vl:.3f} sp={sp_t:.0f}s tr={tr_t:.0f}s"
        if it % 3 == 0:
            wr = eval_vs_heuristic(net, n=40)
            wr_mcts = eval_vs_heuristic(net, n=20, sims=args.sims)
            msg += f" | vs-heur greedy={wr*100:.0f}% mcts={wr_mcts*100:.0f}%"
            torch.save({'net': net.state_dict(), 'opt': opt.state_dict(), 'iter': it}, os.path.join(CKPT, 'latest.pt'))
            export_js(net)
            if wr >= best_wr:
                best_wr = wr
                torch.save({'net': net.state_dict(), 'iter': it, 'wr': wr}, os.path.join(CKPT, 'best.pt'))
                export_js(net, name='policy_best.json')
        print(msg, flush=True)
    print(f"done. best greedy winrate vs heuristic={best_wr*100:.0f}%", flush=True)


# --------------------------- JS export ---------------------------
def export_js(net, name='policy.json'):
    sd = {k: v.detach().cpu().numpy().tolist() for k, v in net.state_dict().items()}
    meta = {'n_feat': F.N_FEAT, 'n_actions': E.N_ACTIONS, 'hidden': net.inp.out_features,
            'blocks': len(net.fcs)}
    json.dump({'meta': meta, 'weights': sd}, open(os.path.join(CKPT, name), 'w'))


if __name__ == '__main__':
    main()
