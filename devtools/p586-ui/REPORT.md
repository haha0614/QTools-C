# P5.86 · 人物卡背景图「入场滑动」修复（QTools-C）

只改前端（`src/views/media/PersonsPage.vue`），未跑任何 git 操作。

## 1. 现象
用户：「每次进入或刷新，卡片背景图都会有一个滑入的动画，好像是从中间滑到自己应在的位置。」

## 2. 真因（CDP 逐帧实测，非推测）

命中的 CSS（改前）：

```css
.pw-bg-img {
  transform: translate(var(--pw-img-tx, 0px), var(--pw-img-ty, 0px));
  transition: transform 0.12s ease;   /* ← 真因 */
}
.pw-card:hover .pw-bg-img { transform: translate(var(--pw-img-tx, 0px), var(--pw-img-ty, 0px)) scale(1.03); }
```

- `.pw-bg-img` 的 computed `transition` = **`transform 0.12s`**（三层都有，同一个 class）；`.pw-bg` = `all 0s`。
- 几何是 `@load` 之后由 `layoutCrop` 异步算出来的，写进 `--pw-img-tx/ty`。在那之前变量为空 → `translate(0,0)`。

进入页面的逐帧（页面内 rAF 录制器，`out/prefix/report.json`）：

| t(ms) | --pw-img-tx/ty | width | computed matrix | rect.xy |
|---|---|---|---|---|
| 1040.1 | "" / "" | 0px | matrix(1,0,0,1,**0,0**) | 193,64 |
| 1060.7 | 128.269 / -113.853 | 244.19px | matrix(1,0,0,1,**0,0**) | 193,64 |
| 1070.1 | 128.269 / -113.853 | 244.19px | matrix(1,0,0,1, **9.08,-7.35**) | 202.08,56.65 |
| 1081.2 | 同上 | 同上 | matrix(1,0,0,1, 28.54,-23.10) | 221.54,40.9 |
| 1091.2 | 同上 | 同上 | matrix(1,0,0,1, 52.40,-42.42) | 245.4,21.58 |
| 1101.2 | 同上 | 同上 | matrix(1,0,0,1, 73.86,-59.80) | 266.86,4.2 |
| 1111.2 | 同上 | 同上 | matrix(1,0,0,1, 90.51,-73.28) | 283.51,-9.28 |
| 1121.2 | 同上 | 同上 | matrix(1,0,0,1, 102.92,-83.33) | 295.92,-19.33 |
| 1131.2 | 同上 | 同上 | matrix(1,0,0,1, 112.13,-90.78) | 305.13,-26.78 |

→ 目标位移写进去之后，`transform` 在 ~112ms 里从 `0,0` 线性逼近 `128.27,-103.85`，**8 个不同的 matrix**、
图片在页面上横向走了 **112.12px**、纵向 **90.78px**。这就是用户看到的那次「滑入」。
（宽度 `var(--pw-img-w)` 没有过渡，是「瞬间变大」；只有 transform 在动，所以观感是整张图从中间滑过去。）

## 3. 修法

1. **`.pw-bg-img` 不再过渡 transform**：`transition: transform 0.12s ease` → `transition: opacity 0.12s linear`。
   transform 只由几何写死，永远瞬时到位。
2. **几何未就绪不显示**：`.pw-bg-img { opacity: 0 }`，`.pw-bg.is-ready .pw-bg-img { opacity: 1 }`；
   `is-ready` 与 `--pw-img-*` 来自同一份 `bgGeom`，同一个 tick 落地 → 第一个可见帧就在正确位置。
3. **几何稳定后才放行**（`BG_SETTLE_MS = 150`，`armBgReady`）：卡片高度会被晚到的文字/拾色再撑开一次
   （实测 84 → 103.7px），高度一变 `ty` 就要重算；若那时已可见就变成「跳一下」。所以最后一次几何变动后
   稳定 150ms 才淡入，且**一旦显示不再隐藏**（resize / crop 变化只更新变量，不会二次入场）。
4. **hover 放大搬家**：`.pw-card:hover .pw-bg-img{...scale(1.03)}` → `.pw-card:hover .pw-bg { transform: scale(1.03) }`，
   容器 `transition: transform 0.12s ease`。容器的 transform 恒为 `none/scale(1)`，入场时不会变，所以这个过渡
   永远碰不到入场位移；三层随容器一起缩放，彼此 rect 仍然逐像素一致（mask 也跟着缩，与原来挂在 img 上的观感一致）。
5. `prefers-reduced-motion` 同步更新（层只关 opacity 过渡、hover 不再放大）。
6. 检查过：这些层上**没有** `will-change`，也没有 `transition: all`；`.pw-card` 自己的 `transition: transform .12s`
   只服务 hover 的 `translateY(-1px)`，入场时基态不变化，不参与。

## 4. 实测（`node devtools/p586-ui/run.mjs after`，真 Chrome + CDP + 真后端）

### 4.1 连续 10 帧（rAF ≈10ms/帧）×刷新 3 次

| 次 | Δx | Δy | Δw | Δh | 不同 transform 数 |
|---|---|---|---|---|---|
| 1 | 0 | 0 | 0 | 0 | 1 |
| 2 | 0 | 0 | 0 | 0 | 1 |
| 3 | 0 | 0 | 0 | 0 | 1 |

（abs 位移同样 0/0/0/0，卡片自身位移 0，说明连卡片都没有抖动；判据：rel 与 abs 都 ≤0.5px。）

改前同一脚本：dx 112.12 / 112.09 / 112.10，dy 90.78 / 90.75 / 90.76，transforms=8 → 复现并证实真因。

### 4.2 筛选 / 刷新按钮

| 操作 | Δx | Δy | Δw | Δh | transform 数 |
|---|---|---|---|---|---|
| 搜「彩花」 | 0 | 0 | 0 | 0 | 1 |
| 清空搜索 | 0 | 0 | 0 | 0 | 1 |
| 点「刷新」 | 0 | 0 | 0 | 0 | 1 |

（该页没有分页器，翻页用「刷新」+ 搜索过滤覆盖。筛选/刷新本来就不滑动：几何按卡片 key 缓存在 `bgGeom`，重渲染时首个 tick 就带着变量，`transition` 也就无从做起——真因只在「首次算几何」那一刻。）

### 4.3 截图（`out/after/`）

- `first-frame.png`：首个可见帧之后 **65.91ms**（Page.startScreencast 带时间戳对齐）。
- `entrance-120ms.png`：+305.5ms（淡入已完成，仍在入场段内）。
- `stable-500ms.png`：+500ms（CDP captureScreenshot）。
- 位置对比：首帧 rect `321.27,-39.85,244.19,434.67`；+500ms rect 完全相同，**delta = 0px**；两张图肉眼一致。

### 4.4 hover

| 状态 | .pw-bg transform | 层 transform |
|---|---|---|
| hover 前 | none | matrix(1,0,0,1,128.269,-103.853) |
| hover 中 | **matrix(1.03,0,0,1.03,0,0)** | matrix(1,0,0,1,128.269,-103.853)（不变） |
| 移开 | none | 不变 |

三层 hover 中 rect 仍一致（251.513 / 251.513 / 251.513）。

### 4.5 稳定性

同一脚本连跑 **3 次**，全部 `PASS 29 / FAIL 0`（每次都是新 Chrome profile + 冷缓存 + 真后端）。

量测口径上顺手修掉了两个**测试侧**的坑（都写进脚本注释）：
1. 筛选/清空会让 `.pw-card.has-bg[0]` 变成另一张卡，跨卡的 10 帧混在一起会算出 87px 的假位移
   → 按 `data-card-key` 取最长的一段帧再比较。
2. 重渲染瞬间探针可能拿到 0 张卡（`cards[0]` undefined 直接抛）→ `probeRetry()` 重试到够数，
   不把渲染时序当断言。

## 5. 回归（同一轮实测，全 PASS）

- 三层 rect 逐像素一致：1600×1200 / 700×2400 / 375×2600 三档，13 张卡，最大偏差 **0px**。
- 裁剪中心 76% / 50%：三档 **dx=0px / dy=0px**（±1px 内）。
- 模糊滑块 0 / 6 / 20 → 模糊层 blur 0 / 6 / 20px，雾层 0 / 15.6 / 52px；拖滑块不改变层 transform。
- 375 → 1 列，700 → 2 列。0 console error。
- `vite build`：✓ built in 4.8s，**0 error**。
- 单测：`node --test src/views/media/*.test.mjs` → 4 files / 4 pass / 0 fail（personBgBlur、personBgImage、personTone 45 项、personWall 136 项）。

## 6. 已知限制 / 取舍

1. 首屏背景**比之前晚约 150ms** 出现（`BG_SETTLE_MS`），这期间显示拾色底。换来入场零位移。
2. 只在「几何已稳定」后放行；若卡片在**可见之后**仍因很慢的数据改变高度，几何会重算、图片瞬移到新的居中位置
   （无过渡、不是滑动，但仍是一次跳变）。要彻底消除只能等所有数据到位再显示，代价是首屏更空。
3. 图片 `@load` 不触发 / 加载失败时，背景层保持 `opacity: 0`，卡片显示拾色底（原来是显示一张空/破图）。
4. hover 放大移到 `.pw-bg` 容器：连带 mask 一起缩放（观感与原来挂在 img 上一致），三层彼此 rect 仍一致。
5. 该页无分页器，验收里的「翻页」以「刷新」+ 搜索过滤替代。

## 7. 复跑

```bash
# 需要后端 http://127.0.0.1:8080 在线（人物数据走真实接口）
cd QTools-C
node devtools/p586-ui/run.mjs after     # 输出到 devtools/p586-ui/out/after/
```

`out/prefix/` 保留的是**改前**同一脚本的输出（滑动证据），`out/after/` 是改后。

产物：`report.json`（全部逐帧数据）、`run.log`、`first-frame.png`、`entrance-120ms.png`、`stable-500ms.png`、`final-1600.png`。

脚本只读地观察页面：用 `Page.addScriptToEvaluateOnNewDocument` 注入一个 rAF 录制器（早于页面脚本），
逐帧记录第一张有背景卡片的 rect / computed transform / opacity / width / `--pw-img-tx`+`--pw-img-ty` / transition，
并把卡片自身 rect 一起记下来，于是「图片相对卡片有没有动」可以分开算（rel / abs / card 三列）。
