# P5.83 —— 人物卡片「左文右图分区」实测报告（QTools-C）

> 目标：卡片 **左文右图分区**，从结构上不再让文字压到图上。
> 结论：**43 条断言全 PASS / 0 FAIL**；13 张卡 × 三档视口 × 亮暗共 **312 条文字实例对比度 9.88–13.83:1（<7:1 的 0 条）**；
> 每张卡每个文字元素 **right < 面板 left**，面板左侧 3px 竖条内 **0 个非底色像素**。
>
> 跑法：`cd QTools-C && node devtools/p583-ui/run.mjs`（自带 vite dev + headless Chrome，走真实后端 127.0.0.1:8080）
> 产物：`out/p583/`（9 张截图 + `contrast.json` + `contrast-table.md` + `report.json`）

---

## 1. 形态与实现

```
.pw-card (flex, align-items: stretch, padding: 0, overflow: hidden)
├── .pw-main  (文字区: flex 1 1 auto, padding 10px 12px, z-index 2)
│   ├── .pw-avatar-wrap 56×56
│   └── .pw-body (姓名 / 数量 / chips / 最近)
└── .pw-bg    (图片面板: flex 0 0 40%, align-self: stretch,
                border-left: 1px solid var(--line), 左缘 3px 圆角,
                overflow: hidden, z-index 1)
    └── img.pw-bg-img (绝对定位 + --pw-img-w/h/tx/ty)
```

- **为什么 `border-left: 1px solid var(--line)` 而不是 12px 渐变**：渐变的「边」没有确定位置，
  没法断言「文字.right < 面板.left」，也没法做「面板左侧竖条必须是纯底色」的像素级检查；
  实线边界同时让「图 / 文字」两块一眼分开（截图里那条 1px 线就是分区线）。
- **文字区是纯 `--bg-2` 底色**：没有遮罩、没有自适应字色、没有 text-shadow 晕边、没有半透明垫底。
  对比度由底色天然保证（见 §3）。
- **面板内是原图**（`originalSrc` 去掉 `crop=` 参数），几何仍走 `personBgImage.layoutCrop`，
  只是 `bgW/bgH` 从「整卡」换成「面板 padding-box」：
  - 用 `clientWidth/clientHeight` 而不是 `getBoundingClientRect()` 的宽高 —— 图片是面板的绝对定位子元素，
    `left/top: 0` 的原点是面板 **padding-box**，而面板有 1px 左边框，用 rect 会白差这 1px；
  - 倍率由新增的 `panelMagnify()` 算：**大到刚好盖满面板**（等价 `object-fit: cover`，四边零空条），
    下限仍是 P5.82 的 0.44。`layoutCrop` 的 `tx/ty` 是按「裁剪块中心钉在 76% / 50%」反算的、与倍率无关，
    所以「盖满」与「中心在 76%/50%」同时成立 —— 实测 Δ = 0px（§4）。
- **模糊滑块 0–20（键 `ms.person.bgBlur`）不变**，只作用于面板内的**单层图**：
  `filter: blur(var(--pw-bg-blur, 6px)) saturate(1.1) brightness(0.95)`。P5.80 的「清晰层 + 模糊层 + 横向 mask 渐变」双图作废。
- **作废的整条链路**：`.pw-mask` / `.pw-scrim` / `.needs-scrim::after` / `.has-tone` 底色渐变 /
  `[data-text-tone]` 自适应字色 / P5.81 `sampleTextRegion` / P5.77 拾色（`personTone.js` 文件本身未动，
  本页已无任何调用方 —— `grep personTone src --include=*.vue --include=*.js` 只剩两行注释）。
---

## 2. 面板 rect（1600 / 亮 / blur 6，13 张卡全部一致）

| 项 | 实测 | 断言 |
|---|---|---|
| 卡片外框 | 335.25 × 103.7（content-box 高 102） | — |
| 面板宽 | **133.3** = 卡宽 **0.40**（13/13 都是 0.400） | 38–42% ✅ |
| 面板高 | 101.7 vs 卡片 `clientHeight` 102 → 偏差 **−0.3px**（clientHeight 取整） | = 卡内高 ✅ |
| 面板右缘 − 卡片右缘 | **1.0px**（= 卡片 1px 右边框；对 padding-box 差 0） | ≤1px ✅ |
| 面板左边框 / 圆角 | `1px solid` / `3px` | ✅ |
| 面板内图四边空条 | L0 / T0 / R0 / B0（13/13） | 无空条 ✅ |
| 375 档面板宽比 | 0.398 | 38–42% ✅ |

## 3. 对比度（13 张卡 × 三档视口 1600/1200/375 × 亮暗 = 78 个卡次 / 312 条文字）

口径：文字色 = `getComputedStyle(el).color`（`color-mix` 的 `color(srgb …)` 由 canvas 归一化）；
底色 = 文字上下各 1px / chip 自身 padding 区（水平中线）的**实测像素**（截图解码后采样，丢掉与文字色 ΔRGB<40 的抗锯齿残留）；
对比度取 `min(computed 底色, 实测底色)` 两个口径的较小值。

| 卡片 key | 1600/亮 | 1600/暗 | 1200/亮 | 1200/暗 | 375/亮 | 375/暗 | 卡片最差 |
|---|---|---|---|---|---|---|---|
| 125 | 10.72 | 12.03 | 10.72 | 12.03 | 10.72 | 12.03 | 10.72 |
| 122 | 9.88 | 10.79 | 9.88 | 10.79 | 9.88 | 10.79 | 9.88 |
| 124 | 9.88 | 10.79 | 9.88 | 10.79 | 9.88 | 10.79 | 9.88 |
| 123 | 9.88 | 10.79 | 9.88 | 10.79 | 9.88 | 10.79 | 9.88 |
| 119 | 10.72 | 12.03 | 10.72 | 12.03 | 10.72 | 12.03 | 10.72 |
| 115 | 9.88 | 10.79 | 9.88 | 10.79 | 9.88 | 10.79 | 9.88 |
| 111 | 9.88 | 10.79 | 9.88 | 10.79 | 9.88 | 10.79 | 9.88 |
| 117 | 10.72 | 12.03 | 10.72 | 12.03 | 10.72 | 12.03 | 10.72 |
| 114 | 9.88 | 10.79 | 9.88 | 10.79 | 9.88 | 10.79 | 9.88 |
| 116 | 10.72 | 12.03 | 10.72 | 12.03 | 10.72 | 12.03 | 10.72 |
| 118 | 10.72 | 12.03 | 10.72 | 12.03 | 10.72 | 12.03 | 10.72 |
| 120 | 10.72 | 12.03 | 10.72 | 12.03 | 10.72 | 12.03 | 10.72 |
| 112 | 9.88 | 10.79 | 9.88 | 10.79 | 9.88 | 10.79 | 9.88 |

按文字类型（全部实例）：

| 文字 | 实例数 | 对比度区间 |
|---|---|---|
| 姓名 `.pw-name`（`--fg`） | 78 | **13.02–13.83:1** |
| 数量 `.pw-counts`（`--pw-fg-2`） | 78 | **10.72–12.03:1** |
| 最近 `.pw-recent`（`--pw-fg-2`，已去掉 `opacity .85`） | 78 | **10.72–12.03:1** |
| chip `.pw-chip`（`--pw-fg-2` on `--bg-3`） | 78 | **9.88–10.79:1** |

- **最差 9.88:1**（`1600/light/122/chip1`：`rgb(61,62,64)` on `rgb(242,246,252)`，「国籍 中国」），
  **最好 13.83:1**，**< 7:1 的实例 0 条**。
- 卡片局部变量 `--pw-fg-2: color-mix(in srgb, var(--fg) 78%, var(--fg-dim))` —— 亮色解析成 `rgb(61,62,64)`、
  暗色按主题解析，比原 `--fg-dim`（亮 4.90:1 / 暗 6.76:1，**都不到 7:1**）高出一大截；这是本轮唯一动文字色的地方。
- C4 同时断言「实测底色像素 = computed 底色（±8 RGB）」→ 证明文字背后那片颜色就是卡片底色，不是照片上的取样巧合。

## 4. 零重叠（文字与图片）

- **结构**：`.pw-main` 与 `.pw-bg` 是同一个 `<a>` 下的兄弟节点（A7，13/13）；
  `.pw-main` 内只有 56px 头像这 1 个 `<img>`，非头像 img = **0**（A8，13/13）。
- **几何**：312 条文字实例（13 卡 × 各文字 × 6 组合）逐条断言 `文字.right < 面板.left` → **0 例越界**（D1）。
- **像素**：每张卡在面板左边 3px 的竖条里（`panel.left−4 … panel.left−2`，卡高内每 2px 一行）逐像素检查，
  与卡片底色 RGB 距离 ≤14 才算通过 → **0 个非底色像素**（D2），图片没有任何一个像素渗进文字区。
- chip 不越界：0 张卡越界（H2），允许的「chip 换行/截断」只发生在文字区内部。
---

## 5. 图片内容正确（3 张卡逐条贴）

| 卡片 | 头像 URL（后端按 crop 裁好的方块） | 面板内原图（去 crop） | 原始尺寸 / 面板 padding-box | 几何（`data-bg-geom`） | crop 中心 X | crop 中心 Y |
|---|---|---|---|---|---|---|
| 125 | `/api/media/thumb/p/a159/0000?crop=0.2111,0.1875,0.6000,0.3375` | `/api/media/thumb/p/a159/0000` | 400×712 / 132×102 | `imgW=196.283 imgH=349.383 tx=0 ty=-73.468 cropX=0.5111 cropY=0.35625` | 100.32 vs 0.76×132 = **100.32**（Δ0） | 51 vs 0.5×102 = **51**（Δ0） |
| 122 | `/api/media/frame/485470e2cc08?t=93&w=480&crop=0.2708,0.0000,0.3375,0.6000` | `/api/media/frame/485470e2cc08?t=93&w=480` | 480×270 / 132×102 | `imgW=302.222 imgH=170 tx=-32.522 ty=0 cropX=0.43955 cropY=0.3` | 100.32 vs **100.32**（Δ0） | 51 vs **51**（Δ0） |
| 124 | `/api/media/frame/046839cff1cd?t=1472&w=480&crop=0.3333,0.0000,0.2979,0.5296` | `/api/media/frame/046839cff1cd?t=1472&w=480` | 480×270 / 132×102 | `imgW=342.397 imgH=192.598 tx=-64.801 ty=0 cropX=0.4823 cropY=0.2648` | 100.32 vs **100.32**（Δ0） | 51 vs **51**（Δ0） |

- **E2**：裁剪块中心 = 面板宽 76% / 高 50%，三张卡都是 **Δ = (0, 0) px**。
- **E3**：图片真实 `getBoundingClientRect` 与 `data-bg-geom` 的偏差 Δleft ≤0.01 / Δtop ≤0.01 / ΔW ≤0.02px。
- **E4**：面板内 URL **无 `crop=` 参数**（是原图），头像 URL 全部带 `crop=`（是裁好的方块）。
- **B5**：图片四边盖满面板（空条 L/T/R/B 全 0），面板里不会再出现「半条空白」。

## 6. 模糊滑块 0 / 6 / 20

| 滑块 | 根节点 `--pw-bg-blur` | `.pw-bg-img` computed filter | localStorage `ms.person.bgBlur` |
|---|---|---|---|
| 0 | `0px` | `blur(0px) saturate(1.1) brightness(0.95)` | `0` |
| 6 | `6px` | `blur(6px) saturate(1.1) brightness(0.95)` | `6` |
| 20 | `20px` | `blur(20px) saturate(1.1) brightness(0.95)` | `20` |

滑块 → CSS 变量 → 面板内单层图的 filter 全部生效，键名与默认值未变（F1/F2/F3）。

## 7. 截图（read_image 自查结论）

`out/p583/` 共 9 张：`view-1600-light`、`view-1600-dark`、`view-1200-light`、`view-1200-dark`、
`view-375-light`、`view-375-dark`、`card-closeup-light`、`card-closeup-light-blur0`、`panel-closeup-light-blur0`。

自查（1600 亮 / 1200 暗 / 375 亮 / 两档特写）：

- 左侧文字全部落在**纯卡片底色**上，没有一处压到照片；右侧是人物图片，两者之间是一条干净的 1px 边；
- 特写 `card-closeup-light-blur0`：面板里就是该人物的原图（同一张脸、同一副眼镜），不是色块；
  `card-closeup-light`（默认 6px）是更柔的氛围底；
- 暗色档文字与卡片底色反差正常，无灰糊；
- 375 档单列，文字区 / 面板比例不变（0.398），没有横向溢出。
---

## 8. 作废的旧断言清单（含处理方式）

**源文件里已删除的实现**（`src/views/media/PersonsPage.vue`）：

| 作废项 | 说明 |
|---|---|
| `.pw-mask` 元素 + 亮暗 4 个遮罩变量 | P5.67–P5.72 的分区遮罩；P5.83 不需要遮罩 |
| `.pw-scrim` / `.pw-card.needs-scrim::after` | P5.80 的兜底渐变层；文字已不压图 |
| `.pw-card.has-tone` + `--pw-tone` / `--pw-tone-raw` 渐变底 | P5.77 拾色链路（`toneRaw/toneFillCss/toneQueue/toneCache/themeBgRgb/applyTone/pumpTones/queueTones` 全删） |
| `.pw-card[data-text-tone]` + `textStyleOf` / `textToneOf` + `sampleTextRegion()` | P5.81 自适应文字色（该函数原本还有一个 `out.imgW` 未定义变量，异常被 catch 吞掉 → 从来没真正生效过） |
| `.pw-bg-sharp` / `.pw-bg-blur` 双图层 + 横向 `mask-image` 渐隐 | P5.76 / P5.80 的双图 + `--pw-blur-fade-end` |
| `text-shadow` 晕边（亮 / 暗两套） | 文字在纯底色上，不需要 halo |
| `@supports not (filter: blur(4px))` 的 `.pw-body` 88% 垫底 | 同上 |
| `.pw-card.has-bg { padding-right: calc(32% + 10px) }` 整卡右让位 | 改成 flex 分区，面板自己占位 |
| `.pw-recent { opacity: .85 }`、`--fg-dim` 做正文色 | 半透明 / 低对比会把对比度折价，改用 `--pw-fg-2` |

**旧实测脚本已标记作废**（保留历史记录，只在文件头加 `【已作废 · P5.83】` 横幅，正文一字未改）：
`devtools/p567-ui/run.mjs`、`devtools/p572-ui/run.mjs`、`devtools/p575-ui/run.mjs`、`devtools/p576-ui/run.mjs`。
其中 p576-ui 里具体失效的断言：图片按卡片内高贴合 / 宽高比未拉伸 / 完整落在卡片内 /
`mask-image = linear-gradient(to right, transparent 0%, … 45%)` / `.pw-mask` 元素 0 个且遮罩变量消失 /
文字块背景透明且 padding-margin 为 0 / has-bg 卡片的姓名数量**带** text-shadow / 右侧 32% 固定盒 / 左缘列均值剖面渐隐比值 /
对比度口径 4.5:1（本轮改为 7:1）/ 0↔6 档不重排（本轮面板尺寸与滑块无关，断言口径改为 filter 变化）。

本轮全新的断言脚本：**`devtools/p583-ui/run.mjs`（43 条断言，全部通过）**。

## 9. 已知限制

1. **chip 会被省略号截断**：面板占 40% 卡宽后，1600 档 4 列时卡片 ≈335px、文字区 ≈ 60%−24(padding)−56(头像)−10(gap) ≈ **110px**，
   3 个 chip 只剩约 33px/个，实测显示成「身… 体… 三国…」。3 个 chip **仍然都在**（H3：6 张卡有 chip，最多 3 个），
   也仍然不越界，但信息量被压缩。要改善只能加宽列（`minmax(280px,1fr)` → 320px+）或让 `.pw-chips` 换行 —— 两者都会改变整墙密度，
   超出本轮「换形态」的范围，留作下一轮可选项。
2. **面板宽比固定 40%**，窄屏也不缩（375 档 0.398）—— 落在需求给的 38–42% 内；以后若想让窄屏文字更宽，
   只需在 `@media (max-width: 768px)` 里把 `.pw-bg { flex-basis }` 调到 38%。
3. **横图 / 竖图都靠 cover 撑满面板**：面板 132×102（比高略宽），竖图按宽度撑满、横图按高度撑满；
   极端退化 crop（`cropY ≈ 0` 或 1）时倍率上限 4 倍兜底，此时可能出现细窄空条（本轮 13 张卡都没走到）。
4. **面板里的图没有 `object-fit`**：尺寸由 `--pw-img-w/h` + `translate` 决定（沿用 personBgImage 几何），
   `object-fit` 在这个模型下是 no-op，所以没写。
5. 本轮**未改** `personBgImage.js` / `personTone.js` / `personBgBlur.js` 及其单测（几何与滑块规则完全复用）；
   `git diff` 里 `personBgImage.js` 的改动来自上一轮的未提交工作，不是本轮。

## 10. 本轮 diff（只读 `git diff --stat`）

```
$ git --no-pager diff --stat -- src/views/media/PersonsPage.vue devtools/p567-ui/run.mjs devtools/p572-ui/run.mjs devtools/p575-ui/run.mjs devtools/p576-ui/run.mjs
 devtools/p567-ui/run.mjs        |   3 +
 devtools/p572-ui/run.mjs        |   3 +
 devtools/p575-ui/run.mjs        |   3 +
 devtools/p576-ui/run.mjs        | 108 ++++----   （含上一轮未提交的改动，本轮只 +4 行横幅）
 src/views/media/PersonsPage.vue | 591 ++++++++++++----------------------------
 5 files changed, 244 insertions(+), 464 deletions(-)

$ git status --porcelain devtools/p583-ui
?? devtools/p583-ui/
```

新增（未跟踪）：`devtools/p583-ui/{run.mjs, REPORT.md, out/p583/**}`。