# P5.84 —— 人物卡片「整卡背景图 + 左糊右清渐变」实测报告（QTools-C）

> 用户口径（原话）：「你老纠结文字可读性干什么，先按照我的意思做不行吗，如果看不清我自然会让你优化的」。
> 本版把文字**直接压在图片上**：没有遮罩、没有垫底、没有自适应字色、没有 text-shadow。
> 硬断言只剩四条：两层图 rect 逐像素一致、裁剪中心落 76%/50%、滑块 0/6/20 的 filter、图片盖满时无拾色残留。
> 对比度**只作 INFO 记录**，不作门槛、不据此改设计。
>
> 结论：**33 条断言全 PASS / 0 FAIL**；两层 rect 最大偏差 **0px**；裁剪中心 Δ **0 / 0.01px**；
> 实测最低对比度 **1.00:1**（仅记录，见 §5）。作废旧断言清单见 §6。
>
> 跑法：`cd QTools-C && node devtools/p584-ui/run.mjs`（自带 vite dev + headless Chrome，走真实后端 127.0.0.1:8080）
> 产物：`devtools/p584-ui/out/p584/`（24 张截图 + `geometry.json` + `contrast.json` + `report.json` + `run.log`）

---

## 1. 形态与实现

```
.pw-card (flex, align-items: center, padding: 10px 12px, overflow: hidden, isolation: isolate)
├── .pw-bg   (position: absolute; inset: 0; z-index: 0; overflow: hidden)   ← 铺满整卡（= 卡片 padding-box）
│   ├── img.pw-bg-img.pw-bg-sharp  (清晰原图, filter: none)
│   └── img.pw-bg-img.pw-bg-blur   (同一张原图, blur(var(--pw-bg-blur)) saturate(1.1) brightness(.9)
│                                   + mask-image: linear-gradient(to right, #000 0%, #000 45%,
│                                     transparent var(--pw-blur-fade-end, 70%)))
├── .pw-avatar-wrap (z-index: 2, 56×56, hover 出现「换」按钮)
└── .pw-body        (z-index: 2, 姓名 / 数量 / 3 chip / 最近)
```

- **左糊右清**：两层是**同一张原图**（`src` / `currentSrc` 完全一致，A5），模糊层压在清晰层上，
  mask 0–45% 全不透明（只看得到模糊图）→ 70% 渐隐到透明（只剩底层清晰图）。
  computed mask 实测：`linear-gradient(to right, rgb(0, 0, 0) 0%, rgb(0, 0, 0) 45%, rgba(0, 0, 0, 0) 70%)`。
- **两层 rect 逐像素一致**：宽 / 高 / 位移只有一组 CSS 变量（`--pw-img-w/-h/-tx/-ty`，由 `layoutCrop` 算出挂在卡片上），
  两层共用 → 13 张卡 × 三档视口实测 |Δx|,|Δy|,|Δw|,|Δh| 最大 **0px**（B1 / I7）。
- **文字**：`.pw-avatar-wrap` / `.pw-body` 都是 `position: relative; z-index: 2`，颜色用默认主题色
  （姓名 `--fg`；数量 / chip / 别名 / 最近 `--fg-dim`）。**没有 text-shadow**（A8：带 shadow 的文字节点 0 个），
  没有 `.pw-mask` / `.pw-scrim` / `::before` 渐变层 / 半透明垫底 / `[data-text-tone]` 自适应字色（A7）。
- **拾色底**：`.pw-card.has-tone { background-color: var(--pw-tone) }` —— 图片按 0.44 倍宽定位后盖不满的区域，
  用 `personTone` 从同一张原图采到的印象色填（P5.77 链路恢复；`personTone.js` 文件本身一行未改）。
- 作废的 P5.83 分区结构：`.pw-main` 元素 0 个、面板 `flex: 0 0 40%`、`border-left` 边界线、`panelMagnify()` 全部删除（A7）。

### 1.1 本轮顺带修掉的一个几何 bug（实测发现）

`bgGeomMemo` 原先用「原图 src + 尺寸」当缓存键。背景 src 是 `originalSrc(头像 URL)`（**去掉了 crop 参数**），
所以详情请求晚到、头像换了一张 crop 时 src 不变 → 命中旧缓存 → 图片按旧 crop 定位。
实测表现：13 张卡里有 10 张 imgW 停在 146.52px（= 0.44 × 卡宽，等于「没有 crop」的退化结果），裁剪中心偏出 76%。
修法：缓存键加入 crop（`bgGeomKey(img, crop)`），并在 `watch(cards)` 里补一次 `refreshBgGeom()`
（src 不变时 `@load` 不会再触发）。修后 C3 全部命中（见 §3）。

---

## 2. 几何（基准 = `.pw-bg` 的 padding-box，不放大）

`personBgImage.layoutCrop` 一字未改，只把容器参数换回整卡：

| 量 | 公式 | 实测 |
|---|---|---|
| 图片宽 | `imgW = bgW × 0.44 / cropW` | 13 张卡逐张等于公式值（C3，Δ = 0；无 crop 的卡片走整图 `cropW = 1`） |
| 图片高 | `imgH = imgW × natH / natW` | 等比，无拉伸 |
| 水平位移 | `tx = bgW × 0.76 − imgW × cropCx` | 裁剪中心 = 253.08px = 333 × 0.76（C1，Δ = 0px） |
| 垂直位移 | `ty = bgH × 0.5 − imgH × cropCy` | 裁剪中心 = 51px = 102 × 0.5（C2，Δ ≤ 0.01px） |
| 真实盒子 | = `data-bg-geom` 记录的几何 | Δleft/Δtop/ΔW/ΔH ≤ 0.01px（C4） |

- 用 `clientWidth/clientHeight`（padding-box）而不是 rect 宽高 —— 两张图都是 `.pw-bg` 的绝对定位子元素，
  `left/top: 0` 的原点就是 padding-box。
- **不为了盖满而放大**：1600 档 13 张卡里只有 2 张（117 / 118，imgW 764.72 / 727.51 > 卡宽 333）横向盖满整卡，
  其余 11 张按公式留出左侧/右侧空档，由拾色底填充（截图里左侧那块同色调的平色就是它）。
- 卡片等高（I1：103.7px 全部一致）、头像 56×56（I3）、3 个 chip（I2）、窄屏 375 → 1 列 / 700 → 2 列（I6）。

---

## 3. 模糊滑块（0 / 6 / 20）

| 滑块 | 根节点 `--pw-bg-blur` | 模糊层 computed filter | 清晰层 filter | localStorage `ms.person.bgBlur` |
|---|---|---|---|---|
| 0 | `0px` | `blur(0px) saturate(1.1) brightness(0.9)` | `none` | `0` |
| 6 | `6px` | `blur(6px) saturate(1.1) brightness(0.9)` | `none` | `6` |
| 20 | `20px` | `blur(20px) saturate(1.1) brightness(0.9)` | `none` | `20` |

滑块**只改 `--pw-bg-blur`**（D1–D4）；渐变终点由 `--pw-blur-fade-end` 决定，页面未显式设置 → 走 CSS 默认 **70%**（E2）。

---

## 4. 截图结论（24 张，read_image 逐张自查）

产物：`wall-{1600,1200,375}-{light,dark}-blur{0,6,20}.png`（18 张）+ `card-closeup-{light,dark}-blur{0,6,20}.png`（6 张，3× 放大）。

- **卡片背景层铺满整卡**：`.pw-bg` 与卡片 padding-box 四边差 1px（= 卡片边框），整卡范围内没有空白、没有露出页面底色。
- **有图的地方就是图**：图片覆盖区域（右半部）能看到原图内容；模糊 0 档清晰可辨（脸部细节、眼镜框都在）。
- **左端糊**：模糊层 0–45% 全不透明，左半部就是这张图的模糊版本；滑块 0 → 20 的左半部从清晰到糊成色块（closeup 0/6/20 三张对比明显）。
- **70% 处开始清晰**：mask 在 45%→70% 之间淡出模糊层，70% 之后只剩清晰层；
  closeup-light-blur20 右侧仍能看清眼镜框与脸部轮廓（模糊 20px 下依然锐利），证明「右清」这一半没被模糊层盖住。
- **拾色底**：图片盖不满时露出的那块是**这张图采到的颜色**（不是灰白），与图片边缘同色调；
  图片**四边全盖满**的 2 张卡（117 / 118）逐像素检查（步长 4px，跳过头像圆框）：等于平色的像素占比 **0%**（F1）→ 无拾色残留。
- **滑块实时生效**：同一档位下 0 / 6 / 20 三张截图肉眼可辨（左半部模糊半径递增），且 18 组配置各自落盘。
- 窄屏 375 单列：文字 / chip / 头像 / 「换」按钮都在卡内，图片与拾色底按同一套几何；700 两列时两层 rect 仍 0px 偏差（I7）。

---

## 5. 对比度 —— **INFO，仅记录**

口径：文字元素的 computed color × 其矩形内实测像素中位数（截图采样；另附「剔除字形像素」的第二口径）。
测了 **18 组配置**（三档视口 × 亮暗 × 滑块 0/6/20），共 **598 个文字实例**：

> **实测最低 1.00:1（仅记录，不作为门槛，不据此改设计）**；剔除字形像素口径最低 1.41:1。
> 最差实例：`1200-light-blur0` 卡 111 姓名 `rgb(48, 49, 51)` 压在 `rgb(80, 36, 36)` 上。

按用户口径，这个数字**不触发任何改动**：文字就是直接压在图上，看不清时再由用户提优化要求。
（0 档最差：模糊半径 0 时照片的高对比细节直接顶在字后面；滑块拉大后模糊层把细节抹开，最差值随之回升。）

---

## 6. 作废旧断言清单（P5.83 及更早）

| 旧断言（出处） | 状态 | 原因 |
|---|---|---|
| A4 `P5.80 双图层 .pw-bg-blur/.pw-bg-sharp 元素 = 0`（p583） | **作废→反转** | 双图层就是本版的核心结构（13 张卡各 2 层，A4） |
| A5 `拾色底 / has-tone / --pw-tone = 0`（p583） | **作废** | P5.77 拾色链路恢复，`has-tone` 卡片 > 0 |
| A7 `.pw-main 与 .pw-bg 是兄弟节点（文字不叠加图片）`（p583） | **作废** | `.pw-main` 元素已删除；文字与 `.pw-bg` 就是叠加关系 |
| A8 `文字区内只有 56px 头像一个 img`（p583） | **作废** | 背景图在卡片内、文字之下 |
| A9 `卡片 padding = 0`（p583） | **作废** | 回到 `10px 12px`（A9 已改为断言它） |
| A10 `面板 border-left 1px + 左缘 3px 圆角`（p583） | **作废** | 没有面板，也没有分区边界线 |
| B1–B5 `面板宽 38–42% / 面板高 = 卡片内高 / 右缘贴卡片右缘 / 面板内图盖满四边`（p583） | **整组作废** | 容器回到整卡；图片**不保证**盖满（按 0.44 定倍、不放大） |
| C `文字对比度 ≥ 7:1`（p583，及 p567/p569/p575/p576 的同口径门槛） | **降级为 INFO** | 用户明确：不要为对比度改设计 |
| D `文字 .right < 面板 .left` / `面板左侧 3px 竖条内 0 个非底色像素`（p583） | **整组作废** | 文字本来就该压在图片上 |
| H2 `chip 不越界到面板`、H4 `「换」按钮不进面板`、H7 `375 档面板宽比 38–42%`（p583） | **作废** | 面板不存在；H4 改为「按钮落在卡片内」（I4） |
| `@supports not (filter: blur())` 时给文字垫 88% 卡片底色的回退断言（p576） | **作废** | 垫底整体删除（用户不要任何垫底） |
| `.pw-mask` / `.pw-scrim` / `--pw-fg-2` 提色 / `[data-text-tone]` 自适应字色（p567–p583） | **保持作废** | 本版继续不渲染（A7 / A8 断言 0 个） |

新增/保留的硬断言：**A1–A10 结构、B1 两层 rect 一致（±0.5px）、C1–C4 几何（76%/50% ±1px、不放大）、
D1–D4 滑块 filter、E1–E4 左糊右清 mask、F1 无拾色残留**；I / J 为保留项与 0 console error。

---

## 7. 本轮改动

- `src/views/media/PersonsPage.vue`：卡片形态回到「整卡背景图 + 双层左糊右清 + 拾色底」，
  删掉 P5.83 的 `.pw-main` / 面板 / `panelMagnify()`，恢复 `personTone` 引用；
  修掉 crop 变化时的几何缓存 bug（§1.1）。`personTone.js` / `personBgImage.js` / `personBgBlur.js` **一行未改**。
- `devtools/p584-ui/run.mjs`（新增）+ `out/p584/`（截图与 JSON 证据）。
