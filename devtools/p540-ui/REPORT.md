# P5.40 三处样式/布局修复 —— 实测报告

真浏览器实测台：`node devtools/p540-ui/run.mjs after`（vite dev 现编 + Chrome headless CDP，
只有 `/api/media/*` 被打桩，页面代码零改动）。改前基线同一条命令：`run.mjs before`。
截图与完整 JSON 在 `devtools/p540-ui/out/{before,after}/`。

## 1. 左栏过宽 / 留白过多

| 量 | 改前 | 改后 |
| --- | --- | --- |
| `.qt-rail` 实测宽度 | **200px** | **176px** |
| `--qt-rail-w`（variables.scss:72） | 200px | 176px |
| 导航区左右 padding | 8 / 8 | 6 / 6 |
| 导航项左右 padding | 10 / 10 | 8 / 8 |
| 图标-文字间距 gap | 10 | 8 |
| Logo 左右 padding / gap | 14 / 10 | 12 / 8 |
| 底部区左右 padding | 8 | 6 |
| 单个导航项可用文字宽度 | 135px | **121px**（最长标签「全部工具」= 56px，余量 65px） |
| 全部标签截断 | 无 | 无（9 项 scrollWidth == clientWidth） |
| hover/选中块与导航内容盒对齐 | 8/191 | **6/169**（左右各 0 偏差） |
| 折叠态宽度 | 56px | 56px（不变；图标仍居中，240→56 的历史契约未动） |
| 移动端抽屉宽度（390px 视口） | 200px | 176px，未超视口 |

hover 实测：鼠标移入第 3 项 → `background-color: rgb(38,39,39)`（暗底），选中竖条仍是
`left:0 / width:3px / height:18px`，贴住内容盒左缘。

## 2. hero 标题改用得意黑（Smiley Sans）

- 字体：`src/assets/brand/v3/fonts/smiley-sans.woff2`（P5.33 子集，cmap **仅 6 个码位**：青兔工具箱 5 字 + 空格，
  fontTools 实测）。新增 `src/styles/fonts.scss`：`@font-face` + `font-display: swap` +
  `font-weight: 100 900`（单份静态字形，600 字重取真实字形、不合成假粗）+ `unicode-range` 只声明那 5 个字。
- 令牌：`--qt-font-display: "SmileySans", var(--qt-font-sans)`（variables.scss:16）；
  只在首页 hero 标题用（Home.vue:445）。
- 实测（1600×1000，home）：
  - `getComputedStyle(h1).fontFamily` = `SmileySans, MiSans, MiSans, -apple-system, …, Arial, sans-serif`
  - `document.fonts` 中 `SmileySans` 状态 **loaded**；资源 `smiley-sans.woff2` 实际下载 1 次
  - `document.fonts.check('32px "SmileySans"', '青兔工具箱')` = true
  - 字形生效证据（canvas 同字号量宽）：`青` = 25.6px vs monospace 32px（换掉了）；
    `龙` = 32px == monospace 32px（子集外 → 回退）
  - h1 实际文字宽 128px（改前系统字体 160px）
- 已知限制：子集只有这 5 字。标题之外的任何文字（含把站点名改掉后的新字）都会回退到系统栈；
  要覆盖更多字需重新出子集，不是 CSS 能解决的。logo 字标本身是转轮廓 SVG，按要求未改动。

## 3. toast 位置（真正的 bug 不只是「位置」）

根因：`.ms-toast` 的样式只写在 **VideoPage.vue 的 scoped 块**里；`PlaylistsPage.vue` 只在模板里用了
同一个类名，却没有样式 → 那条提示退化成**文档流里的裸 div**。改前实测：
`position: static`、`background: transparent`、rect `x=56 y=152 w=1529 h=22.4` ——
整幅透明块横在内容区左侧中部（用户截图里「飘在左侧压住侧栏」的东西），既不是药丸也不是浮层。

统一方案：
- 新增 `src/views/media/usePageToast.js`（队列：纵向堆叠、2.4s、同时最多 3 条、卸载清理计时器）
- 新增 `src/views/media/PageToast.vue`（**唯一** toast 实现）：`position: fixed; left/right:0; z-index:900;
  pointer-events:none; align-items:center`，顶部居中，`gap:8px` 堆叠，`max-width: min(480px,100%)`、
  `overflow-wrap:anywhere`（播放列表名最长 60 字也不溢出）
- 播放列表页、视频库页都改成 `<PageToast :toasts="toasts" />`；VideoPage 里旧的 `.ms-toast` scoped 样式删除
- 位置参数：`top: calc(var(--qt-topbar-h,0px) + var(--ms-toast-top, 12px))`；
  视频库吸顶工具栏高 86.4px → 设 96px；窄屏工具栏 102px（含顶栏 48 的底边 150）→ 设 168px；
  播放列表页窄屏页头折行 → 设 138px

实测 rect（1600×1000）：

| 场景 | toast rect | 与 `.qt-rail`(0–176) 相交 | 与主操作控件相交 |
| --- | --- | --- | --- |
| 播放列表页 · 新建成功 | x=711.1 y=12 162.7×36.2 | 面积 0 | 与「新建/刷新/名称输入」无交集 |
| 播放列表页 · 连发 3 条 | y=12 / 56.2 / 100.4（gap 8,8） | 0 | 无 |
| 播放列表页 · 暗色 | x=707.5 y=12 170.1×36.2 | 0 | 无；底色 rgb(35,35,36)、文字 rgb(229,234,243) |
| 视频库页（点「加入播放列表」真路径） | x=660.5 y=96 264×36.2 | 0 | 工具栏底边 86.4 < 96，无交集 |
| 视频库页 · 390×844 | x=63 y=216 264×36.2 | 0 | 无（工具栏底边 150 < 216） |
| 播放列表页 · 390×844 | x=109.7 y=186 170.6×36.2 | 0 | 无（页头底边 124.2 < 186，且与页头控件无交集） |

横向溢出：390px 视口 `scrollWidth == innerWidth == 390`；1600px 视口 `1585 <= 1600`。

「统一到一套」的口径：全站提示分两类 —— 工具页走 Element Plus 的 `ElMessage`（顶部居中，z 2000+），
媒体站走 `PageToast`（顶部居中，z 900）。两者槽位一致，媒体页不再各自写 toast 样式；
`public/media/profile.js` 里的 `.pf-toast` 属于旧静态站（未被 Vue 应用引用），本轮不动，属已知遗留。

## 4. 回归

- `vite build`：0 error（dist 正常产出）
- `node scripts/ctrl-autohide.test.mjs`：**78/78 通过**（无断言需调整）
- `node devtools/p533-brand/run.mjs`（品牌/左栏/顶栏/暗色，既有 harness）：**30 通过 / 0 失败**
- `node devtools/p540-ui/run.mjs after`：**26/26 通过**
- 旧断言调整：**无需调整** —— 仓库里没有任何既有断言写死 `--qt-rail-w = 200px` 或 `.ms-toast` 的位置
  （`grep` 过 devtools/*、scripts/*）；只有 `doc/用户端改版方案.md` 的令牌表把 200/56 写成文档事实，
  已同步改成 176/56。p526/p529/p531 等播放器 harness 直接挂载 MediaPlayer/VideoMetaPanel，不经过
  VideoPage 的 toast，故不受影响。

## 5. 已知限制

1. 得意黑子集只有「青兔工具箱」5 个字；换标题文案后新字回退系统字体（需重新出子集）。
2. 提示条 2.4s 内会覆盖它下方的那一行内容（顶部居中的固有属性）；已通过页面级偏移保证
   **不覆盖侧栏、不覆盖按钮/输入框**，并 `pointer-events:none` 保证永远不挡点击。
3. 窄屏偏移值是实测的定值（视频库 168 / 播放列表 138）：若以后页头增删一行，需要跟着调。
