"""Policy + value network (MLP) for AlphaZero."""
import torch
import torch.nn as nn
import torch.nn.functional as F
from features import N_FEAT
from engine import N_ACTIONS


class PVNet(nn.Module):
    def __init__(self, hidden=512, blocks=3):
        super().__init__()
        self.inp = nn.Linear(N_FEAT, hidden)
        self.bns = nn.ModuleList([nn.LayerNorm(hidden) for _ in range(blocks)])
        self.fcs = nn.ModuleList([nn.Linear(hidden, hidden) for _ in range(blocks)])
        self.policy = nn.Linear(hidden, N_ACTIONS)
        self.value = nn.Sequential(nn.Linear(hidden, 128), nn.ReLU(), nn.Linear(128, 1))

    def forward(self, x):
        h = F.relu(self.inp(x))
        for ln, fc in zip(self.bns, self.fcs):
            h = h + F.relu(fc(ln(h)))   # residual MLP block
        return self.policy(h), torch.tanh(self.value(h)).squeeze(-1)

    @torch.no_grad()
    def infer(self, feats_np, masks_np, device):
        """feats_np: (B,N_FEAT) masks_np: (B,N_ACTIONS) -> (priors(B,A) np, values(B,) np)."""
        x = torch.from_numpy(feats_np).to(device)
        logits, v = self.forward(x)
        m = torch.from_numpy(masks_np).to(device)
        logits = logits.masked_fill(m < 0.5, -1e9)
        p = torch.softmax(logits, dim=-1)
        return p.cpu().numpy(), v.cpu().numpy()
