# Pokémart 扩展 — 实现规划（基于官方扩展 PDF）

> 官方 Pokémart 扩展（仿 Splendor「东方 The Orient」）。本文件是分阶段实现的权威规格，
> 供后续提交逐步落地。原始规则与卡面见上传的 `POKEMONSPLENDOR_POKEMART_*.pdf`。

## 组成与设置
- **30 张 Pokémart 卡**：每个等级（1/2/3）各 10 张，分 3 副牌堆按等级单独洗混。
- 每个等级的牌行**最右侧另开 2 个位置**，翻开该等级 Pokémart 牌堆顶 **2 张**（共 6 张面朝上）。
- 捕捉或保留一张 Pokémart 卡后，立即从同等级 Pokémart 牌堆补一张（堆空则留空）。
- 其余规则同基础游戏，除非卡面效果另有说明。

## 六种效果（每种 5 张，按颜色各一：红/蓝/黑/粉/黄）

| 卡名 | 等级 | 效果 | 是否需玩家交互 |
|---|---|---|---|
| **EVOLVE STONE（进化石）** | 1 | 购买时，选你场上**另一张有奖励的卡**，本卡颜色/奖励永久视同该卡。无该类卡则不能买。 | 是（选卡）|
| **POKÉDEX（图鉴, M✕M）** | 1 | 本卡**无颜色**；在「捕捉」时可弃掉本卡，充当**2 个万能（大师球）代币**支付当次捕捉（只用 1 个则另一个作废）。弃掉后退出游戏。 | 是（捕捉时选择弃用）|
| **POTION（药水）** | 2 | 提供**2 个**该色奖励（其余用途仍算 1 张卡）。**无交互**，等价于一张强力奖励卡。 | 否 |
| **RARE CANDY（神奇糖果）** | 2 | 购买时先「关联」（同进化石），然后立即从**等级 1 行**免费取 1 张面朝上的基础/Pokémart 卡（不付成本、结算其效果、不算一次购买）。 | 是（选关联卡 + 选免费卡）|
| **TM（技能机, 磁盘）** | 3 | 购买时立即从**等级 2 行**免费取 1 张面朝上的卡（不付成本、结算其效果、不算购买）。 | 是（选免费卡）|
| **REPEL（驱虫喷雾）** | 3 | 购买**不花费球/折扣**；改为从场上**弃掉 2 张该色的卡**（无色 Pokémart 卡须优先弃；弃进化形时保留其基础卡）。被弃卡退出游戏。 | 是（选弃 2 张）|

> 说明：等级与 VP 不同——卡面左上角是 VP（胜利点）。Pokémart 卡的 VP/奖励色/成本仍需逐张从卡面精确提取（彩虹边框可能干扰像素分类器，建议用白底成本列；颜色按右上角奖励球判读）。

## 数据 schema（`data/pokemart.json` + `js/pokemart.js`，opt-in）
```jsonc
{
  "id": "pm_xx", "tier": "pmL1|pmL2|pmL3", "name": "进化石",
  "vp": 0, "bonus": "red|none", "bonusCount": 1,
  "cost": { "red":0,"blue":0,"black":0,"pink":0,"yellow":0,"purple":0 },
  "effect": "copy | colorless_master | double | copy_free | free | discard_buy",
  "effectParam": { "discardColor": "red", "freeFromTier": "pmL1|stage1" },
  "img": "assets/cards/pm_xx.jpg"
}
```

## 引擎改动（`engine.js`，全部 guard 在 `pokemartEnabled`）
1. 设置：每级 Pokémart 牌堆 + 每级 offer 2 张；补牌逻辑。
2. 捕捉：支持 Pokémart 卡；处理 `discard_buy`（弃 2 同色卡而非付球）、`colorless_master`（捕捉时弃图鉴抵 2 万能）。
3. 关联：`copy`/`copy_free` 在购买时绑定到另一张卡（动态奖励：bonuses() 需解析关联色）。
4. 免费取卡：`copy_free`/`free` 购买后立即免费取一张并结算其效果（可能再触发免费取，递归一层）。
5. `double`：bonusCount=2，无新机制（沿用现有 bonuses()）。
6. 计分/折扣：关联卡的颜色随被关联卡变化；无色卡（图鉴/进化石未关联）不计颜色。

## UI（`ui.js`）
- 设置开关「Pokémart」；牌行右侧 Pokémart 列（每级 2 张）。
- 交互流程（新「子选择」阶段）：选关联卡、选免费卡、选弃 2 张、捕捉时勾选弃图鉴抵款。

## AI
- 启发式：把 POTION（双奖励）/进化石（补色）计入价值；REPEL/免费取卡作为机会性增益。AlphaZero 席位不支持。

## 分阶段（进度）
- **阶段1 ✅**：catalog + 规格（本文件）。
- **阶段2 ✅**：`data/pokemart.json`+`js/pokemart.js`（30 张，成本暂定待核对）；引擎基座——
  动态牌行（`field.pmL1/2/3` 各 2 张）+ setup/补牌 + 捕捉/保留接入 + POTION 双奖励（沿用 `bonusCount`）；
  未实现效果的卡在捕捉时被明确拒绝（不静默误触）；8/8 headless 测试，基础+Megas 回归全过。
- **阶段3（下一步）**：交互效果引擎逻辑（copy / colorless_master / discard_buy；以选择参数传入，可 headless 测试）+ 测试。
- **阶段4**：免费取卡（copy_free / free，含递归结算）+ **UI 子选择**（设置开关、Pokémart 列、选关联/免费/弃牌流程）+ AI 适配 + 联调。
