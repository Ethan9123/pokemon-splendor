# AlphaZero 训练 — 璀璨宝石·宝可梦

用强化学习（AlphaZero 风格：MCTS 自对弈 + 策略/价值网络）训练专家级 AI。
基于攻略教学提炼的策略，先用启发式（`heuristic.py`）热启动，再自对弈提升。

## 环境
- GPU：检测到 RTX 5060（CUDA），PyTorch 2.11 (cu128)。
- 纯 Python 引擎 `engine.py` 是 `../js/engine.js` 的忠实移植（含固定的配色均衡 5 神兽 + 5 稀有）；
  每回合一个主行动，弃球(>10) 与回合末进化在 `step()` 内按"进化=白嫖分"贪心自动结算。

## 组成
| 文件 | 作用 |
|---|---|
| `engine.py` | 游戏引擎（53 个离散行动的动作空间） |
| `heuristic.py` | 攻略策略启发式（神兽优先/配色高分流/进化链）；基线对手 + 行为克隆教师 |
| `features.py` | 状态→380 维特征 + 合法动作掩码 |
| `net.py` | 策略+价值网络（残差 MLP） |
| `mcts.py` | 批量化 AlphaZero MCTS（多局并行、叶子批量推理） |
| `train.py` | 主训练：行为克隆热启动 → 自对弈 → 训练 → 评估 → 存档 |

## 运行
```bash
python train.py --hours 9      # 长训练（默认）
python train.py --smoke        # 30 秒流水线自检
python train.py --resume       # 从 ckpt/latest.pt 续训
```
- 产物：`ckpt/latest.pt`（续训用）、`ckpt/best.pt`（最佳）、`ckpt/policy.json`/`policy_best.json`（导出给前端的网络权重）。
- 每 3 个 iter 评估一次"网络 vs 启发式"（贪心 & MCTS 两种）并存档。
- 优雅停止：在本目录创建空文件 `STOP`（`touch STOP`），或直接结束进程。

## 监控
```bash
tail -f train.log
```

## 接入网页 AI（训练成熟后）
`ckpt/policy.json` 即网络权重。待 MCTS 评估稳定超过启发式后，把它接到浏览器
（JS 端复刻 `features.py` 编码 + `net.py` 前向 + 轻量 MCTS），作为"AlphaZero AI"难度。
目前网页默认用已升级的启发式 AI（融入攻略策略，对贪心 98%）。
