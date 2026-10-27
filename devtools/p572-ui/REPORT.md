# P5.72 · 人物页「背景模糊度」滑块 —— 交付报告

用户原话：「卡片背景模糊度还是太高了，这样吧，你在页面中加一个滑块来调节模糊度」
范围：只改前端（QTools-C），不动后端、不跑 git。

---

## 1. 改了什么

| 文件 | 变更 |
| --- | --- |
| `src/views/media/PersonsPage.vue` | 工具栏右侧加滑块（标签 + range + 数值小字）；根节点挂 7 个 CSS 变量；`.pw-bg img` 的 filter 与**外扩量**改成读变量；`.pw-mask` 三个 alpha 改成读变量；≤640px 折叠；文件头补 P5.72 说明 |
| `src/views/media/personBgBlur.js` | **新增**：值域夹取 / 遮罩联动斜坡 / localStorage 读写的唯一实现 |
| `src/views/media/personBgBlur.test.mjs` | **新增**：51 条纯逻辑单测（无浏览器） |
| `devtools/p572-ui/run.mjs` | **新增**：真浏览器实测 102 项（CDP + 真后端 + 像素采样） |
| `devtools/p567-ui/run.mjs` | **改 1 处旧断言**：原来写死 `blur(6px)`，改成「computed filter 与滑块当前值一致」（见 §7） |

## 2. 滑块位置与样式

- 位置：`.pp-head-right` 末尾（搜索框 → 刷新 → 背景模糊），三者 **Δy = 0px**（同一行）。
  实测 `search.right = 1323 / refresh.x = 1331 / slider.x = 1447`（1600 视口）。
- 结构：`<label for="pp-bg-blur">背景模糊</label>` + `<input id="pp-bg-blur" type="range" min="0" max="20" step="1" aria-label="背景模糊度">` + `<span>{n}px</span>`。
- 尺寸：滑块 88px（≤640px → 76px）；数值小字定宽 28px（`0px ↔ 20px` 不抖动）。
- 折叠：`≤640px` 隐藏标签，只留「滑块 + 数值」；搜索 / 刷新仍在同一行（375 档实测 Δy = 0.02px）。
  375 档 `scrollWidth 360 ≤ clientWidth 375 + 1`，无横向滚动。
- 无障碍：原生 range，键盘 ←/→ 步进 1、Home/End 到 0/20（实测 6→7→5、End→20、Home→0）；`:focus-visible` 有 2px accent 描边。

## 3. CSS 变量与外扩联动公式

根节点（`.person-page`）inline style，一次只 patch 这 7 个自定义属性：

```
--pw-bg-blur: 6px;                                    /* 半径 */
--pw-mask-l1/l2/l3: 0.93/0.88/0.62;                   /* 亮色遮罩 3 个停靠点 */
--pw-mask-d1/d2/d3: 0.9/0.82/0.66;                    /* 暗色遮罩 3 个停靠点 */
```

```scss
.pw-bg img {
  inset:  calc(var(--pw-bg-blur, 6px) * -1.5);        /* 外扩 = -1.5 × 半径 */
  width:  calc(100% + var(--pw-bg-blur, 6px) * 3);    /* 尺寸 = 100% + 3 × 半径 */
  height: calc(100% + var(--pw-bg-blur, 6px) * 3);
  filter: blur(var(--pw-bg-blur, 6px)) saturate(1.1) brightness(0.9);
}
```

实测三档（1600 / 亮色，13 张卡全部一致；`.pw-bg` 盒子 = 333.25 × 101.7，卡片外边距盒 = 335.25 × 103.7）：

| 档位 | computed filter | computed inset | 背景图盒子 | 是否盖住 |
| --- | --- | --- | --- | --- |
| 0px | `blur(0px) saturate(1.1) brightness(0.9)` | `0px 0px 0px 0px` | 333.25 × 101.7 | = 背景盒（外扩为 0，不露边） |
| 6px | `blur(6px) saturate(1.1) brightness(0.9)` | `-9px -9px -9px -9px` | 351.25 × 119.7 | = 背景盒 + 18 |
| 20px | `blur(20px) saturate(1.1) brightness(0.9)` | `-30px -30px -30px -30px` | 393.25 × 161.7 | = 背景盒 + 60 |

> 6px 一档与 P5.69 的 `-9px / +18px` 完全相等 —— 默认档视觉零变化。
> 0px 时外扩归零，图片正好等于内边距盒（1px 边框不被背景盖住，与原来一致）。

## 4. 0 档遮罩策略与阈值

- 阈值 **MASK_RAMP = 6**：`t = min(半径 / 6, 1)`，alpha = `strong + (base - strong) × t`。
  **0→6px 是连续斜坡**（2px 时 t≈0.333，遮罩已退到加强档的 1/3），不是「0–2px 一刀切」。
- 0px（纯照片背景，加强档）：亮 `0.96 / 0.94 / 0.78`、暗 `0.95 / 0.92 / 0.86`。
- ≥6px：回到现值 亮 `0.93 / 0.88 / 0.62`、暗 `0.9 / 0.82 / 0.66` 并**保持不动**
  （再薄会撞 4.5:1 下限：暗色右侧 .66 的解析值只有 4.9:1）。
- 实测 computed `background-image` 解析出的停靠点：0px → `[0.96, 0.94, 0.78]`（亮）/ `[0.95, 0.92, 0.86]`（暗）；6/20px → `[0.93, 0.88, 0.62]` / `[0.9, 0.82, 0.66]`。
- 只换 alpha、不动渐变几何（0% / 50%·46% / 100%），拖动时遮罩不会左右跳。

## 5. 对比度实测（0 档，像素采样 + WCAG，13 张可见卡）

| 主题 | 遮罩 alpha | 姓名最差 | 数量行最差 |
| --- | --- | --- | --- |
| 亮色 0px | 0.96/0.94/0.78 | **9.31:1**（底色 218,218,217） | **9.31:1**（底色 218,218,218） |
| 暗色 0px | 0.95/0.92/0.86 | **12.54:1**（底色 38,38,38） | **12.37:1**（底色 39,39,39） |
| 亮色 20px（对照） | 0.93/0.88/0.62 | 7.30:1 | 7.30:1 |

全部 ≥ 4.5:1（0 档最差也有 9.31:1，余量足够）。

## 6. 持久化

键 `ms.person.bgBlur`（值 = 半径整数字符串），默认 6。

- 拖到 13 → localStorage `"13"`；刷新后：滑块 `13`、数值 `13px`、`--pw-bg-blur: 13px`、
  computed `blur(13px) saturate(1.1) brightness(0.9)`、`inset: -19.5px …`（= 13 × -1.5）。
- 存量越界 `"99"` → 刷新夹到 `20`；删键 → 回到 `6px`；脏值 / 隐私模式（storage 抛异常）→ 默认 6 不抛错。
- `0` 是合法值：读的时候不走 `||` 兜底，存 `"0"` 能读出 0（单测 4.3 覆盖）。

## 7. 构建与测试

- `vite build`：**0 error**（✓ built in 4.89s，产物 `dist/assets/PersonsPage-*.js`）。
- 单测（全部 node 直跑，无浏览器）：
  - `src/views/media/personBgBlur.test.mjs` **PASS 51/51**（新增）
  - `personWall` 136 / `personRules` 43 / `playbackContext` 83 / `playerExtras` 175 / `playerProgress` 111 /
    `subtitleStyle` 50 / `synopsisAudio` 7 组 / `synopsisRules` 47 组 / `ctrl-autohide` 78 / `playlist-count` 43 /
    `playlist-filter` 17 —— 全部 PASS，无回归。
- `devtools/p572-ui/run.mjs`（新）：**PASS 102 / FAIL 0**，无未捕获异常 / console.error。
- `devtools/p567-ui/run.mjs`（既有 UI harness，3 视口 × 亮暗）：**PASS 120 / FAIL 0**。

### 调整的旧断言（只有 1 处）

`devtools/p567-ui/run.mjs` B 组第 4 条：

```js
// 旧（写死半径）
withBg.every((c) => /blur\(6px\)/.test(c.bgStyle.filter) && /saturate\(1\.1\)/.test(c.bgStyle.filter))
// 新（半径来自滑块；默认仍是 6px）
const blurNow = await evaluate('... [data-role="bg-blur"] ... .value')
withBg.every((c) => new RegExp('blur\\(' + blurNow + 'px\\)').test(c.bgStyle.filter) && /saturate\(1\.1\)/.test(c.bgStyle.filter))
```

其余既有断言（hover 过渡 `0.12s`、层级 0/1/2、遮罩 .93/.88/.62、object-position、头像与背景同 URL、
等高、数量行单行、3 个 chip、无横向溢出）**未改**且全绿。

## 8. 性能与「整墙不重排」

- `input` 只改 `bgBlur` **一个 ref**；`cards` 是独立 computed，不依赖它 → 列表不重算。
- 同一次 update 只 patch 根节点的 7 个自定义属性 + 数值小字；**没有 rAF 是因为不需要**：
  Vue 的 patch 本就在 microtask 合并（一次 input 一次 patch），浏览器自己也按帧合并 pointermove；
  再叠 rAF 反而会在后台标签页被节流成「拖了不动」。
- 实测：**逐格 0→20 共 20 档 × 13 张卡，卡片 rect maxDelta = 0px**，网格 `1377 × 450.81` 前后一致；
  卡片与背景图 DOM 未被重建（打标记后仍在），背景图没有重新请求。
- 真鼠标拖拽（CDP mousePressed/mouseMoved/mouseReleased）从右端拖到最左：滑块 0、`blur(0px)` 立刻生效、localStorage `"0"`。

## 9. 已知限制

1. **`filter` 退出 0.12s 过渡**（`.pw-bg img { transition: transform .12s ease }`）：拖滑块必须立刻看到半径变化，
   带过渡时每档要 120ms 才到位、途中读到的 computed filter 是插值。代价是 hover 的 `brightness(.9→1)` 变成瞬时变化
   （放大仍有过渡）。如更看重 hover 平滑，可把 `filter` 加回 transition，但「实时生效」会变成「120ms 后生效」。
2. **遮罩 6px 起不再变薄**：20px 与 6px 的遮罩完全相同。「越大越淡」只做在 0–6px 区间，
   再薄会撞暗色右侧 .66 的 4.5:1 下限。
3. **大半径取样更多**：20px 时背景图外扩 30px 并 cover 放大，视觉上比 6px 时的裁切更靠中心（这是模糊本身的性质，非 bug）。
4. **`@supports not (filter: blur())`** 的老浏览器分支仍是固定遮罩（原样保留）：那些浏览器里滑块只改变外扩量、
   不改变清晰度（filter 本来就不生效），属可接受的降级。
5. 偏好存在**当前浏览器**：换浏览器 / 清缓存回到默认 6px（没有做账号级同步，本轮只按需求做 localStorage）。
6. 无头像（首字占位）的卡片本来就没有 `.pw-bg` 层，滑块对它们无影响（需求 5；G 组用打桩人物实测确认）。

---

截图（`devtools/p572-ui/out/after/`）：
`p572-blur-0-light.png`、`p572-blur-6-light.png`、`p572-blur-20-light.png`、`p572-blur-0-dark.png`、
单卡特写 `p572-card-{0,6,20}-light.png`、持久化 `p572-persist-13.png`、窄屏 `p572-narrow-{375,640,700}.png`、
无头像 `p572-G-no-avatar.png`；原始断言数据见 `out/after/report.json`，控制台全量日志 `run.log`。
