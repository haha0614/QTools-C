# P5.30 · logo v3：现成开源图标 + 现成中文字体

> 产物目录：`src/assets/brand/v3/`（本版**未执行任何 git 命令**）
> 本版零自绘：图形 100% 原样取自开源图标库，字标 100% 由开源中文字体的真实字形轮廓导出。

---

## 0. 结论先行

**许可先筛一道（重要）**：核对了各库仓库里真实的 LICENSE 文件，结果与任务书假设有出入 —— Lucide 现在是 **ISC**（不是 MIT）；**Remix Icon 已改为自定义的 "Remix Icon License v1.0"（2026-01），第 3.3 条明确禁止把图标用作 logo / 品牌标识**。所以可作 logo 的组合只剩 **Lucide (ISC) / Phosphor (MIT) / Tabler (MIT)** 三家，Remix 的 D1 候选**只能作对照、不可采用**（`svg/lockup-remix-*.svg` 已从成品里删除）。

| 排名 | 候选 | 组合 | 许可 | 理由 | 弱点 |
|---|---|---|---|---|---|
| **1（首选）** | **B1** | Phosphor **rabbit-fill** + **得意黑 Smiley Sans** | MIT + OFL | 实心兔与得意黑同为「实心块面 + 圆头 + 速度感」，10 个候选里唯一**图标与字形重量级一致**的；16/22px 靠实心剪影仍可辨；有品牌性格 | 得意黑只有斜体；实心图标建议再光学缩到 0.9× |
| **2（最稳）** | **A2** | Lucide **rabbit** + **思源黑体 Noto Sans SC Medium** | ISC + OFL | 线性图标 + 中等字重，重量最平衡；32px 以上正文级可读；最像「工具软件该有的样子」，风险最低 | 没有性格，容易与同类产品撞脸 |

- 分工建议：**B1** 用在品牌位（启动器、关于页、官网）；**A2** 用在产品内上栏/窗口标题这类「不该抢注意力」的位置。
- **16px / favicon 一律只用图标**：五个汉字在 16px 的物理宽度只有约 80px，任何字体都会糊成一条灰带（实测见第 5 节），这是尺寸下限而非选字问题。

可直接用的成品矢量（无需再拼装，单色 currentColor）：
- `svg/lockup-phosphor-rabbitfill-smiley.svg` — 推荐 1
- `svg/lockup-lucide-rabbit-noto.svg` — 推荐 2
- `svg/mark-phosphor-rabbit-fill.svg` / `mark-lucide-rabbit.svg` / `mark-tabler-player-play.svg` — 16px 图标版
- `svg/wordmark-smiley-sans.svg` / `wordmark-noto-sans-sc.svg` / `wordmark-lxgw-wenkai.svg` — 三种字体纯字标

---

## 1. 图标：实际拿到了什么

环境实测：`registry.npmjs.org` / `unpkg.com` / `cdn.jsdelivr.net` / `fonts.googleapis.com` **全部连接失败（curl 返回 000）**，只有 `github.com` / `raw.githubusercontent.com` 通。因此**没有走 npm 包，全部走 GitHub raw**——这是本任务下唯一可行路径。

| 图标库 | 许可证（以仓库 LICENSE 为准） | 请求 | 结果 | 落盘 |
|---|---|---|---|---|
| Lucide | **ISC**（任务书写的 MIT 已过时） | `rabbit` / `play` / `package` | ✅ 3/3 成功 | `icons/lucide/*.svg` + `LICENSE.txt` |
| Phosphor | MIT | `rabbit`(regular+fill) / `play` / `package` | ✅ 4/4 成功 | `icons/phosphor/*.svg` + `LICENSE.txt` |
| Tabler | MIT | `rabbit` / `play` / `player-play` / `package` | ⚠️ **`rabbit`、`play` 该库不存在（重试 3 次均 404，非网络问题）**；改用 `player-play` + `package`（200） | `icons/tabler/*.svg` + `LICENSE.txt` |
| Remix Icon | **Remix Icon License v1.0**（自定义） | `rabbit` | ⚠️ **仓库无 rabbit**（`icons/Others`、`icons/Media` 全量核对均无），按预案改用 `play-circle-line`；但**其许可 §3.3 禁止 logo 用途**，故不可用于本任务 | `icons/remix/*.svg` + `LICENSE.txt`（仅留档） |

- Tabler 无 rabbit 是「该库没有」，不是「没拿到」：用 GitHub Contents API 全量列过 `icons/outline`，零命中。**没有用别的库的同名图标冒充。**
- 所有 SVG 均**原样保存**（未改路径、未改 stroke-width），组合时只做 viewBox 缩放。

## 2. 字体：三种真实获取状态

| 字体 | 许可证 | 来源 | 结果 | 原始体积 |
|---|---|---|---|---|
| 得意黑 Smiley Sans **v2.0.1** | OFL-1.1 | `atelier-anchor/smiley-sans` Release `smiley-sans-v2.0.1.zip`（内含现成 woff2/otf/ttf） | ✅ 成功 | 5.78 MB |
| 思源黑体 **Noto Sans SC Medium** | OFL-1.1 | `google/fonts` → `ofl/notosanssc/NotoSansSC[wght].ttf`，用 fontTools 实例化为 **wght=500** | ✅ 成功 | 17.77 MB |
| 霞鹜文楷 **LXGW WenKai Regular v1.530** | OFL-1.1 | `lxgw/LxgwWenKai` Release `LXGWWenKai-Regular.ttf` | ✅ 成功 | 25.93 MB |

- **三种目标字体全部拿到，没有任何系统字体占位**，因此不需要「非目标字体，仅占位」标注。
- `fonts/` 里放的是**只含「青兔工具箱」5 字 + 空格的字形子集 woff2**（1.5–2.4 KB/个），可直接提交。原始 17–26 MB 整字库未提交，重下方式见 `fonts/SOURCES.md`。
- 字标 SVG 不是「引用字体」而是把字形**导出成 path 轮廓**（`fonttools` + `SVGPathPen`，按 ascent 归基、em 单位），换机器打开不掉字、不依赖安装字体——这也是 OFL 字体做字标的标准做法。

## 3. 候选矩阵（图标源 × 字体，10 个）

每个候选都给 **16 / 22 / 32 / 64 / 180px 五档 + 亮/暗两底**（180px 在「一、三种组合」与「三、仅字标」里单独整行展示；第二节矩阵为 16/22/32/64）。

| ID | 图标（源·许可） | 字体 | 意图 | 自查 |
|---|---|---|---|---|
| A1 | Lucide rabbit · ISC | 得意黑 | 语义直给，线性兔 + 速度感字 | 32px 起协调；16px 图标线太细 |
| **A2** | Lucide rabbit · ISC | 思源黑 Medium | 最稳的工具软件观感 | **推荐 2**，32px+ 最佳可读 |
| A3 | Lucide rabbit · ISC | 霞鹜文楷 | 楷味最强 | ❌ 风格冲突（见第 5 节） |
| **B1** | Phosphor rabbit-fill · MIT | 得意黑 | 实心剪影 + 实心块面，重量一致 | **推荐 1** |
| B2 | Phosphor rabbit(regular) · MIT | 思源黑 Medium | 极简克制，小尺寸稳 | 好，但个性偏弱 |
| C1 | Tabler package · MIT | 霞鹜文楷 | 工具箱隐喻 + 楷体 | ⚠️ 最「土」，package 还容易被读成快递箱 |
| C2 | Tabler player-play · MIT | 思源黑 Medium | 三角最简，22px 可读性第一 | 图标最好读，但「播放」语义偏媒体 |
| D1 | Remix play-circle-line · **不许 logo** | 得意黑 | 圆底播放键 = 启动器 | ⛔ 许可禁用（仅对照）；且圆底在小尺寸糊成一团 |
| D2 | Lucide package · ISC | 霞鹜文楷 | C1 的更细版本 | ⚠️ 比 C1 更弱，盒子太细 |
| E1 | Lucide play · ISC | 思源黑 Medium | 中性基线 | 干净，无记忆点 |

## 4. 交付物

```
src/assets/brand/v3/
├─ compare.html                 # 全部候选平铺，自带 <defs>/<symbol>，无外部依赖（双击可开，~100 KB）
├─ REPORT.md
├─ out/
│  ├─ compare.png               # 整页 1800×9781，宽 ≥1400 ✔
│  ├─ section-1-combos.png      # 三种组合 × 五档（16/22/32/64/180，亮暗）
│  ├─ section-2-matrix.png      # 10 个图标×字体候选（16/22/32/64，亮暗）
│  ├─ section-3-wordmark.png    # 仅字标 / 字标+圆点（三种字体）
│  ├─ section-4-strip-16-22.png # 16px 真尺寸列 + 22px 上栏列（1:1 像素）
│  ├─ section-5-appbar.png      # 22px appbar 实感
│  ├─ zoom-16-22-1to1.png       # 16/22 列原始像素裁剪
│  ├─ zoom-16-22-2x.png         # 同区域 2× 最近邻放大（看结构用，判断仍以 1:1 为准）
│  └─ lockups-preview.png       # 成品 lockup SVG 的渲染回看
├─ svg/                         # 成品矢量（见第 0 节）
├─ wordmark-svg/                # 三种字体的纯字形大纲
├─ fonts/                       # 5 字子集 woff2 + SOURCES.md + metrics.json
└─ icons/                       # 原样图标 SVG + 各库 LICENSE + SOURCES.md
```

复现链路：GitHub raw 下载 → `fonttools` 子集/实例化 → `SVGPathPen` 导出字形轮廓（ascent 归基、em 单位）→ 内联 SVG 组合 → Chrome headless（`--headless=new`，`--force-device-scale-factor=1`，1800px 宽）截图 → 逐张 `read_image` 目视自查。

## 5. 自查（看图后的实话）

1. **16px 不可辨，是尺寸问题不是字体问题。** 五个汉字在 16px 总宽约 80px，三种字体都糊成一条灰带（`section-4-strip-16-22.png`、`zoom-16-22-1to1.png` 为 1:1 证据）。结论：**16px 只上图标**（`svg/mark-*.svg`）。
2. **22px 是「有形无字」**：appbar 里能认出「左边兔子 + 右边一坨字」，字读不出来。若必须 22px 带字，建议减到「青兔」两字（本版未做，需要可补）。
3. **32px 是分水岭**：32px 起思源黑/得意黑都能读全「青兔工具箱」；霞鹜文楷仍偏细弱。
4. **最协调：B1**（Phosphor 实心兔 + 得意黑）。图标与字的重心、笔头圆度、斜向动势一致，像一套东西。
5. **仍然土：C1 / D2**（package + 楷体）——盒子图标 + 毛笔楷体 = 文具店招牌，和「工具箱」这个中性词叠在一起更老气，C1 的 package 还容易被读成「快递/包裹」。**A3**（线性兔 + 楷体）也失败：线性图标太轻、楷体太软，两个都不立。
6. **不够好的地方（诚实记录）**：
   - 得意黑只有斜体，做正体字标需人工校正斜度，本版没做；
   - 实心图标已做 **0.88em 光学缩放**（线性图标保持 1.0em），成品见 `svg/lockup-*`；`compare.html` 的矩阵演示仍是严格 1:1 em，所以截图里 B1 的图标看着比成品略大——**以 `svg/` 下的成品为准**；
   - `COMBO-3` 的「记忆点」用的是**字标末尾品牌色圆点**，不是原计划的「兔字末点变圆点」——后者要改字形轮廓，等于改字体，与本轮「只用现成资产」的原则冲突，所以退了一步；
   - D1 想出过效果（圆底播放键 + 得意黑），但许可不允许，已判死。
7. **没做的**：未做彩色/多色版本（保持单色 currentColor）；未做独立深色配色（亮暗两底都用 currentColor 反转验证）；未跑 git。

## 6. 失败项与原因（全量）

| 项 | 状态 | 原因 |
|---|---|---|
| npm / unpkg / jsDelivr | ❌ | 三域名连接失败（000），只能走 GitHub raw |
| Google Fonts CSS API | ❌ | `fonts.googleapis.com` 连接失败；改用 `google/fonts` 仓库原始文件 |
| Tabler `rabbit` | ❌ 不存在 | 库内无此图标（Contents API 全量核对零命中） |
| Tabler `play` | ❌ 不存在 | 库内实为 `player-play`，已改用 |
| Remix `rabbit` | ❌ 不存在 | 库内无此图标，按预案用 `play-circle-line` |
| Remix 作 logo | ⛔ 许可禁止 | Remix Icon License v1.0 §3.3 禁止 logo/trademark 用途 → D1 判死，成品 SVG 已删 |
| 任务书写的「Lucide = MIT」 | ⚠️ 事实修正 | 仓库 LICENSE 实为 **ISC**（同为宽松许可，可商用、可作 logo） |
| 原计划「兔字末点变圆点」 | ⚠️ 未做 | 需改字形轮廓，违反「不自绘/只用现成资产」 |
| 自绘几何方案（前两版） | ❌ 已废弃 | 用户否决（「不好看…太土了」），本版零自绘 |
