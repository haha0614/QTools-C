# P5.88 人物卡片背景「手动调整位置与缩放」实测报告

用户原话：「人物页增加一个功能，可以手动设置人物卡片背景图片的位置和尺寸缩放」。
范围：只改前端（QTools-C/src），不跑 git 写操作。构建 = vite build，实测 = 真 Chrome（CDP）+ 真后端（127.0.0.1:8080）。

## 1 改了什么

| 文件 | 作用 |
| --- | --- |
| src/views/media/personBgAdjust.js（新） | 叠加公式 / 值域 / 预设 / 存储 + LRU / 全局默认 的**唯一实现**（纯函数，无 Vue、无 DOM） |
| src/views/media/personBgAdjust.test.mjs（新） | 上述纯函数的单测，59 项断言（含 LRU 上限、脏数据、等比预览） |
| src/views/media/PersonBgAdjustDialog.vue（新） | 调整弹层：同比例预览（同一套三层图）+ 拖拽平移 + 缩放滑块 + 三个快捷按钮 + 吸附 + 全局默认 + 保存 / 取消 |
| src/views/media/PersonsPage.vue | 入口按钮「⛶」、弹层实例、逐人调整表 / 全局默认的 reactive 状态、`bgAppliedOf()` 把调整叠到 `--pw-img-*`、`data-bg-adjust` 实测属性、头部文档补 P5.88 一节 |

**入口**：卡片 hover 时头像**右上角**的「⛶」（`data-role="bg-adjust-open"`）。原来的「换」在头像右下角，
两者都是 22px 小圆钮，不重叠；`v-if="bgSrcOf(c)"` —— 没有背景图的卡（首字占位卡）连按钮都不渲染；
`@click.stop.prevent` 保证不跳详情；`position: absolute` 不参与卡片排版。

**弹层**：宽 `min(560px, 92vw)`，不 teleport（要继承 `.media-scope` 的 `--bg / --accent / --pw-bg-blur`）。
预览盒尺寸由 JS 按**卡片盒比例**算（宽 min(520, 容器宽)，高 ≤ 240），三层图与卡片用同一套 CSS 变量、
同一条 mask 曲线、同一档 `--pw-bg-blur`。

## 2 叠加公式（几何仍归 layoutCrop，本功能只在其上叠加）

    imgW = autoImgW × scale            imgH = autoImgH × scale
    tx   = autoTx + dx × bgW           ty   = autoTy + dy × bgH

* `scale` ∈ [0.5, 3]（滑块 50%–300%，100% = 自动尺寸），保留 3 位小数。
* `dx / dy` 存的是**卡片宽高的比例**（不是 px），夹到 ±200%：卡片是流式 grid（1600 四~五列 / 375 单列），
  存 px 换个视口同一份调整就偏；存比例则「拖到卡片 30% 的位置」在任何宽度下都是 30%。
  弹层里显示的是**按卡片实际像素**换算后的值（`dx × 卡片宽`）。
* 三层共用同一份 `--pw-img-w/h/tx/ty` → 「三层 rect 逐像素一致」在任何调整下都成立（实测 0px 偏差）。
* 等于自动几何（scale 1 / dx dy 0）时 `applyAdjust` 原样返回自动几何 → 「重置为自动」与基线**逐值相等**。
* 不放大到覆盖的老约束不变：scale 1 时仍是 `imgW = bgW × 0.44 / cropW`；只有用户手动放大才可能 `coversW/H`。

快捷按钮：`重置为自动` = {1,0,0}；`居中` = 保持当前 scale，把**裁剪中心**（自动几何钉在 76%/50% 的那个点）
移到卡片正中；`填满卡片` = 在裁剪中心居中的前提下取刚好盖满的最小 scale（裁剪中心不在图片正中时四向取最大）。

## 3 存储

    localStorage['ms.person.bgAdjust.v1']      = { [personId]: { scale, dx, dy } }   上限 500 条 LRU
    localStorage['ms.person.bgAdjust.default'] = { scale, dx, dy }                   全局默认

* 优先级：逐人记录 > 全局默认 > 自动几何（`resolveAdjust`）。
* LRU 不存时间戳：JSON 保留插入顺序，写入时「先删后写」把该 id 挪到末尾，超过 500 从最前面淘汰。
  值域严格是 `{ scale, dx, dy }`，没有额外字段。
* 写成自动（scale 1 / 偏移 0）→ **删除**该条（不留 scale 1 的垃圾），全局默认同样删键。
* 脏数据（坏 JSON / 非对象条目 / 越界值）逐条丢弃或夹取，不抛异常（storage 不可用时静默）。

## 4 实测（真浏览器，74/74 断言全过，两次运行结果一致）

跑法：`cd QTools-C && node devtools/p588-ui/run.mjs`（输出 `devtools/p588-ui/out/p588/`、
日志 `out/p588/run.log`、`report.json`、8 张截图）。全部结论来自 CDP 真鼠标事件 + rect / computed / localStorage。

基线（1600×1200，light）：13 张卡（13 张有背景）· 4 列 · 目标卡 key=125 ·
自动几何 `imgW=244.2 imgH=434.676 tx=128.269 ty=-103.853`，裁剪中心 (0.5111, 0.35625) ·
卡片盒 333.25×101.7（client 333×102）· 三层 rect 均为 `[321.27, -39.85, 244.19, 434.67]` · 卡片等高 103.7。

### a 拖拽平移（CDP mousePressed → 8 步 mouseMoved → mouseReleased，位移 -70 / +34px）

| | 拖前 | 拖后 |
| --- | --- | --- |
| 预览 sharp rect | [733.8, 301.69, 381.33, 678.77] | [666.2, 335.14, 381.33, 678.77] |
| 读数 | 缩放 1.00× · 偏移 (dx 0, dy 0) | 缩放 1.00× · 偏移 (dx -43.3, dy +21.4) |

预览图位移 (-67.6, +33.45) ≈ 鼠标位移（差异来自 1% 吸附）；拖拽后预览三层 rect 仍一致。

### b 缩放滑块 50% / 100% / 300%（每次保存后读卡片）

| 滑块 | 预览 imgW（期望） | 卡片 image 宽（期望） | computed width | localStorage |
| --- | --- | --- | --- | --- |
| 50% | 190.66（190.67） | 122.09（122.1） | 122.094px | {"scale":0.5,"dx":0,"dy":0} |
| 100% | 381.33（381.33） | 244.19（244.2） | 244.188px | 无条目（= 自动，不落库） |
| 300% | 1143.98（1144） | 732.59（732.6） | 732.594px | {"scale":3,"dx":0,"dy":0} |

### c 保存后立即应用 + 刷新仍在

保存 160% + 拖拽 (46, -22) 后（**未刷新**）：

    data-bg-adjust = 1.6,0.09,-0.14,390.72,695.482,158.239,-118.133
    三层 rect      = [351.24, -54.13, 390.72, 695.47] ×3（偏差 0px）
    transform      = matrix(1, 0, 0, 1, 158.239, -118.133)（三层 computed 完全相同）
    localStorage   = {"125":{"scale":1.6,"dx":0.09,"dy":-0.14}}
    校验：imgW = 244.2 × 1.6 = 390.72 ✓；tx = 128.269 + 0.09 × 333 = 158.239 ✓；ty = -103.853 + (-0.14) × 102 = -118.133 ✓

刷新（重新导航）后：`data-bg-adjust` 与 rect 与刷新前**逐值一致**（±1px 断言实测 0px），localStorage 一字不差。

### d 「重置为自动」回到 76% / 50% 锚点

    data-bg-adjust = ""（不写库）· rect 与基线自动 rect 偏差 0px
    裁剪中心 = (253.08, 51)，卡盒 333×102 → 76% = 253.08 ✓ / 50% = 51 ✓
    localStorage = {}（该条被删掉）

### e 「设为所有卡片默认」

勾选后保存：`ms.person.bgAdjust.default = {"scale":1.5,"dx":0.04,"dy":0.08}`；
另外两张卡（122 / 112）立即变成 `1.5,0.04,0.08,...`，imgW = 各自自动 imgW × 1.5（651.2 / 366.3）且三层一致。
本卡保留逐人记录（逐人 > 默认）。点「清除全局默认」→ 键被删除，其它卡回到自动几何（`data-bg-adjust=""`）。

### f 三层 rect 逐像素一致

基线、拖拽后、调整后、刷新后、暗色下、其它卡（全局默认）全部 0px 偏差（阈值 ±0.5px）。

### g 截图（`devtools/p588-ui/out/p588/`）

`p588-a-dialog-open-1600-light.png`、`p588-b-drag-preview-1600-light.png`、
`p588-g-375-light.png`、`p588-g-375-light-dialog.png`、`p588-g-375-dark.png`、
`p588-g-1600-dark-dialog.png`、`p588-g-1600-dark-adjusted.png`、`p588-h-no-bg-card-1600-light.png`。

375：列数 1；弹层宽 328px（≤ 92vw），面板 [16 … 344] 不越出视口。
暗色 1600：卡 125 调整 180% 后 imgW 439.56，三层一致。

### h 无背景卡的调整按钮不存在

「⛶」按钮数 = 有背景卡数（13 / 13）。让最后一张卡的头像触发 error（走既有的 `avatarFailed` 分支）后，
该卡 `.pw-bg` 消失、`data-bg='0'`、头像回落首字占位，按钮**同步消失**（hasBg=false, hasBtn=false）。

### 其余不变项

* 卡片等高：调整前后高度差 0px（103.7）。
* 3 chip 卡（key=122）：chip 数 3 → 3，卡片高 103.7 → 103.7；`.pw-adjust` computed `position: absolute / 22px / 22px`，不进文档流。
* 模糊滑块：调整过的卡上 0 → `blur(0px) saturate(1.1) brightness(0.9)`，20 → `blur(20px)`，仍生效。
* `prefers-reduced-motion: reduce`：`.pw-bg-img` transition 0s、新增的 `.pw-adjust` transition 0s（没有引入过渡）。
* 点卡片正文仍跳详情（`/media/person/125`）；点「⛶」不跳（URL 不变）。
* 全程 0 页面异常（Runtime.exceptionThrown / console.error 均无）。

## 5 构建与测试

| 命令 | 结果 |
| --- | --- |
| `node node_modules/vite/bin/vite.js build` | ✓ built in 5.02s，**0 error**（PersonsPage 72.36 kB / css 22.93 kB） |
| `node --test scripts/*.test.mjs src/views/media/*.test.mjs src/views/media/video/*.test.mjs` | **16 files / 16 pass / 0 fail**（含新增 personBgAdjust.test.mjs 59 项） |
| `node src/views/media/personBgAdjust.test.mjs` | PASS 59/59 |
| `node devtools/p588-ui/run.mjs` | PASS 74/74（断言），exit 0 |
| `node devtools/p586-ui/run.mjs p586`（既有 P5.86 背景入场 harness，回归） | PASS 29 / FAIL 0：几何 244.2/434.676/128.269/-103.853 不变、裁剪中心 76%/50%（±0px）、三层 rect 13 张全 0px、滑块 0/6/20 生效、首帧不滑动 |

**旧断言改动：无。** 既有 16 个单测文件、p586 harness 的断言一个字都没改，全部原样通过。
新增的只有 `personBgAdjust.test.mjs`（新文件）。`data-bg-geom` 仍是**自动几何**（旧脚本读它不受影响），
调整后的值另挂在新的 `data-bg-adjust="scale,dx,dy,imgW,imgH,tx,ty"` 上。

## 6 已知限制

1. `dx / dy` 存比例（不是 px），这是为了让调整跨视口保持构图；如果将来要「像素级绝对偏移」，
   需要在参数里加一个参考宽度，属于改语义，不在本轮范围。
2. 「填满卡片」= 最小 cover scale 夹到滑块上限 300%：极端裁切（裁剪中心贴近图片边缘，需要 >3×）时
   可能盖不满，此时宁可少盖也不越出手动值域。
3. 预览盒最高 240px：卡片比例特别高的极窄卡会按高度回收宽度，预览仍是同构图（等比），只是小一点。
4. 逐人键是 `person.id`；没有 id 的老数据只能保存「全局默认」，不能逐人保存（当前库 13/13 都有 id）。
5. 弹层是 `position: fixed` 的整页单实例（与换头像弹层同一约定），不进 v-for —— 卡片 hover 的
   transform 会让 fixed 定位漂移。
6. 调整只影响背景三层，不动拾色底（`--pw-tone`）：放大到盖满时底色被图盖住，缩小后露出的仍是这张图的拾色。
