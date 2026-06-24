"""Robust head-to-head eval of ckpt/best.pt vs the heuristic, larger sample,
at the deployment MCTS sim count. Prints winrate + binomial 95% CI."""
import sys, math
import numpy as np
import torch
import engine as E, features as F, heuristic as H
from net import PVNet
import train as T   # reuse eval_vs_heuristic (importing does NOT run main())

E.load_cards()
ck = torch.load('ckpt/best.pt', map_location=T.DEVICE)
net = PVNet().to(T.DEVICE); net.load_state_dict(ck['net']); net.eval()
print(f"best.pt: iter={ck.get('iter')} recorded_wr={ck.get('wr')}", flush=True)


def ci(p, n):
    se = math.sqrt(p * (1 - p) / n)
    return 1.96 * se


N_GREEDY = int(sys.argv[1]) if len(sys.argv) > 1 else 200
N_MCTS = int(sys.argv[2]) if len(sys.argv) > 2 else 120
SIMS = int(sys.argv[3]) if len(sys.argv) > 3 else 100

wr_g = T.eval_vs_heuristic(net, n=N_GREEDY)
print(f"greedy (no search)  n={N_GREEDY}: {wr_g*100:.1f}%  ±{ci(wr_g, N_GREEDY)*100:.1f}", flush=True)

wr_m = T.eval_vs_heuristic(net, n=N_MCTS, sims=SIMS)
print(f"MCTS sims={SIMS}      n={N_MCTS}: {wr_m*100:.1f}%  ±{ci(wr_m, N_MCTS)*100:.1f}", flush=True)
print(f"VERDICT: {'BEATS' if wr_m > 0.5 else 'does NOT beat'} heuristic at deployment settings", flush=True)
