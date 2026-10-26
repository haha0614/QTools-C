# P5.33 · 落地 A1：Lucide rabbit + 得意黑（正式资产 + 站点集成）

> 产物：`src/assets/brand/final/`（正式资产）、`public/favicon.svg`、`public/apple-touch-icon.png`、
> 站内三处集成（播放页头部 / 左栏 Logo / 顶栏品牌位）。
> 本版**未执行任何 git 命令**。构建脚本与实测台：`devtools/p533-brand/`。

---

## 0. 结论先行

| 项 | 结果 |
|---|---|
| 图标 | Lucide `rabbit`（ISC），路径**一字未改**，只按尺寸调线宽 |
| 字标 | 得意黑 Smiley Sans v2.0.1（OFL-1.1），**已转 path 轮廓**，全资产 `grep -c font-face` = **0** |
| 16px | Lucide 原件在 16px 会糊成灰边 → 采用「去眼点 + 去耳内短弧 + stroke 2.4」的像素对齐版（c3），1:1 对比见 `out/01` |
| 22px | 图标 + 「青兔」（`logo-lockup-short.svg`，22px 高时字标 16.4px） |
| ≥32px | 图标 + 「青兔工具箱」（`logo-lockup.svg`） |
| favicon | **放弃单色 + 媒体查询**（Chrome 实测不生效），改强调色圆角贴片 + 白兔，亮/暗标签栏通用 |
| 集成 | 播放页 `.p-brand`、左栏 `.qt-rail__logo`、顶栏 `.qt-topbar__brand` 三处同一枚内联 SVG |
| 构建 | `vite build` 0 error（✓ built in 4.46s） |
| 实测 | p533 22/22、p529 57/57、p531 83/83、p532 55/55、p525 63/63、playerExtras 175/175 |

尺寸规则的依据是 v3 REPORT 的实测（`src/assets/brand/v3/REPORT.md` 第 5 节）：五个汉字在 16px 高度下
物理宽度只有约 80px，任何字体都会糊成一条灰带 —— 这是尺寸下限，不是选字问题。本版照此落地：
**16px 只放图标；22px 图标 + 两字；32px 起全名**。

---

## 1. 正式资产清单（`src/assets/brand/final/`，与 v1/v2/v3 区分）

| 文件 | 尺寸 / viewBox | 用途 |
|---|---|---|
| `logo-icon.svg` | 24×24 | `currentColor` 版：内联 SVG 用（图标随继承色走） |
| `logo-icon-light.svg` / `logo-icon-dark.svg` | 24×24 | 实色版 `#1F2328` / `#F2F5F8`：`<img>` 用（`<img>` 里 currentColor 会落成黑色） |
| `logo-icon-16.svg` / `-light` / `-dark` | 24 网格 | 16px 像素对齐微调版（去眼点、去耳内短弧、线宽 2.4） |
| `logo-lockup.svg` / `-light` / `-dark` | 5.71×1.34 em | 图标 + 「青兔工具箱」，≥32px |
| `logo-lockup-short.svg` / `-light` / `-dark` | 3.31×1.34 em | 图标 + 「青兔」，22px 上栏 |
| `public/favicon.svg` | 24 网格（可任缩） | 16/32 标签栏图标：`#409eff` 圆角贴片 + 白兔 |
| `public/apple-touch-icon.png` | 180×180 | iOS 添加主屏（SVG 不被支持） |

共享数据源：`src/utils/brandMark.js`（`ICON_24` 路径 + `BRAND` 文案）。`build.mjs` 与该模块、
`components/BrandMark.vue` 读的是**同一份** Lucide 路径 —— 避免「文件里的 logo」和「页面里的 logo」各长各的。

### 锁定组合的几何（em = 得意黑 1em，单字 0.8em）

```
图标 1.34em  ·  间距 0.35em  ·  字墨框 0.982em（青兔工具箱 = 4.0em，青兔 = 1.6em）
全名 5.71em × 1.34em   |   短名 3.31em × 1.34em   |   图标与字墨框垂直居中
```

---

## 2. 字标为什么必须是轮廓（以及怎么做的）

`extract-glyphs.py`（fontTools `SVGPathPen` + `BoundsPen`）从 v3 的得意黑子集 woff2 里取出
青 / 兔 / 工 / 具 / 箱 五个字形的 cubic 轮廓，导出 em 单位 path + 上墨框，`build.mjs` 再按
**每字 cumulative advance** 横向累加拼成一行 —— 这一步踩过一个坑：把 5 个字并进同一条 `<path>`
会让它们全叠在原点，渲染出一团黑（第一版截图就是证据），字距必须靠 advance 算出来。

结果：字标不含 `@font-face`、不嵌 base64、不依赖运行时字体，换机器/无网打开都不掉字。

---

## 3. 16px：原件为什么会糊，改了什么

```
24 网格 → 16px = ×0.6667 → Lucide stroke 2 变成 1.3333px，落在半像素上被抗锯齿摊成两条灰边
```

四个候选（`devtools/p533-brand/out/candidates/`，对比图 `out/01-icon16-1to1-plus-8x.png`）：

| 候选 | 做法 | 16px 观感 |
|---|---|---|
| c1 | 原件 stroke 2 | 灰、毛边，眼睛点成一粒脏点 |
| c2 | 原件 stroke 2.4 | 稍微结实，眼点仍脏 |
| **c3（采用）** | 去眼点 `M18 12h.01` + 去耳内短弧 `M7.612…`，stroke 2.4 | **轮廓干净、可辨**，删掉的都是在 16px 下小于一个像素的细节 |
| c4 | 16 网格 + stroke 1.6 | 太细，整体发灰 |

---

## 4. favicon：一个必须记录的反例

任务书给的方案是「单色 + `prefers-color-scheme` 媒体查询」或「直接用 32 版几何」。实测结果：

- `out/05-favicon-tabs-light-scheme.png` 与 `out/06-favicon-tabs-dark-scheme.png` **sha256 完全相同**
  （`3a71f092…`）→ **Chrome 不执行 `<img>` 里 SVG 的媒体查询**，深色标签栏会拿到近黑图标贴在深色栏上。
- 因此 favicon 改为**强调色圆角贴片**（`#409eff` + rx 22% + 白兔，图标占 20/24）：底与图标自成对比，
  亮栏 / 暗栏都不用挑色。三版对比见 `out/05`：cA（采用）/ cB（22/24 更挤）/ cC（r32%）/ cM（单色对照，暗栏里基本消失）。
- `apple-touch-icon.png` 同款贴片，180×180，白兔 112px。

---

## 5. 集成位置与截图

### 5.1 播放页 `.p-brand`（`src/views/media/video/MediaPlayer.vue`）

```html
<a class="p-brand" href="/" :title="brandTitle" :aria-label="brandTitle" @click="onBrandClick($event)">
  <BrandMark class="p-brand-mark" :size="18" />
  <span class="p-brand-text">{{ brandName }}</span>
</a>
```

- **内联 SVG**（`components/BrandMark.vue`）而不是 `<img>`：`<img>` 里 currentColor 会落黑，
  内联后 `stroke=currentColor` 直接吃 `.p-brand-mark { color: var(--accent) }`，亮/暗主题共用一份。
- 几何一点没动：行高 22px、图标 18px、文本 12.5px/600、`gap 6px`、次级色；hover 从「徽标底色变强调色」
  改成「图标提到正文色」（线性图标没有底色可变了）；`<a href="/">` + `router.push('/')` + `focus-visible` 全部沿用 P5.29。
- 窄屏（≤768px）：`.p-brand-text { display: none }`，只留 18px 图标。

### 5.2 左栏 Logo + 顶栏品牌位（`src/layouts/AppShell.vue`）

- `.qt-rail__logo-badge`（28px 实心方块「青」）→ `.qt-rail__logo-mark`（24px Lucide rabbit，颜色 `--qt-primary`）；
  槽位/左缘不变，收起态只剩图标。
- `.qt-topbar__brand` 由纯文本变成「18px 图标 + 站点名」，只在 <1024px 出现。
- 站点名**仍是 `APP_INFO.name`**（「青兔在线工具箱」）：左栏 / 顶栏 / 首页 h1 / 浏览器标题口径不变。

### 5.3 截图（`devtools/p533-brand/out/`）

| 文件 | 内容 |
|---|---|
| `01-icon16-1to1-plus-8x.png` | 四版 16px 1:1 + 8× 最近邻放大 |
| `02-size-ladder-light-dark.png` | 16/22/32/64 阶梯，亮行 + 暗行 |
| `03-header-22px-light-4x.png` / `04-…dark…` | 22px 上栏复刻（真实 CSS + 15.5px/700 标题做对照），亮/暗 |
| `05-favicon-tabs-*.png` | favicon 放进模拟标签栏（亮栏/暗栏），含三版候选与单色对照 |
| `07-app-icon-180.png` | 180 应用图标（= `public/apple-touch-icon.png` 同源） |
| `08-insitu-brand-light-6x.png` / `10-…dark…` / `12-…narrow…` | **真播放页**（p525 harness，同一份 MediaPlayer.vue）上的 `.p-brand`，6× |
| `09-insitu-head-light-2x.png` / `11-…dark…` | 真播放页整条 `.p-head`，看与标题的协调度 |
| `13-shell-rail-logo-light-3x.png` / `15-…dark…` | 站内左栏 Logo，亮/暗 |
| `14-shell-topleft-light-1x.png` / `16-…dark…` | 左栏全貌（看图标与导航是否同一套语言） |
| `17-shell-topbar-brand-420-light-6x.png` / `18-…dark…` | 420 宽顶栏品牌位 |

自查结论（read_image 逐张看过）：22px 下「图标 + 青兔」清晰可辨；18px 图标与 12.5px 文本重量协调，
不与 15.5px/700 标题抢注意力；暗色下 `#409eff` 图标 + `--fg-dim` 文本对比足够（`out/10`、`out/11`）；
暗色截图走的是应用自己的主题入口（`localStorage['qtools-theme']` + `prefers-color-scheme` 后重载），
不是手动加 `html.dark` —— 后者会被 `useTheme` 的 resize 重算覆盖，截出中间态。

---

## 6. 验收记录（全部真跑）

### 6.1 构建与静态断言

```
vite build        → ✓ built in 4.46s（0 error / 0 warning 相关品牌资源）
grep -c font-face src/assets/brand/final/*.svg public/favicon.svg → 全 0（12+1 个文件逐个查过）
dist/favicon.svg / dist/apple-touch-icon.png → 存在（public/ 被复制）
dist/index.html  → <link rel="icon" type="image/svg+xml" href="/favicon.svg">
                   <link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

### 6.2 实测台与单测

| 台 | 结果 | 覆盖 |
|---|---|---|
| `devtools/p533-brand/run.mjs` | **22 passed / 0 failed**，18 张截图 | 资产 + 真播放页 + 站内壳（本轮新增） |
| `devtools/p529-player/run.mjs` | **57 passed / 0 failed** | 含 f4 图标节点 / f5 文本节点 / f7 push('/') / f10 回车回首页 |
| `devtools/p531-player/run.mjs` | **83 passed / 0 failed** | 播放页 4 项 + containment |
| `devtools/p532-context/run.mjs` | **55 passed / 0 failed** | 播放上下文 |
| `devtools/p525-player/run.mjs` | **63 passed / 0 failed** | 头部 [G] 段几何判据 |
| `node --test src/views/media/video/playerExtras.test.mjs` | **175 assertions passed** | 纯逻辑单测 |

### 6.3 调整过的旧断言及原因

| 台 | 旧断言 | 新断言 | 原因 |
|---|---|---|---|
| p529 | f4「hover 徽标 `backgroundColor` 变化」 | f6「hover 图标 `color` 从 `--accent` 提到 `--fg`」 | 徽标方块没了，线性图标只剩颜色这一层语言 |
| p529 | （无） | 新增 f4「`.p-brand-mark` 是 svg 且有 5 条 Lucide 路径」 | 本轮要求「`.p-brand` 里有图标节点」 |
| p529 | （无） | 新增 f5「文本节点 = 青兔工具箱」 | 同上，要求「有文本节点」 |
| p529 | f5–f8 | 顺延为 f7–f10（判据内容不变） | 上面插了两条，编号顺延 |
| p525 | g1「文本 = 青兔在线工具箱」 | g1「文本 = 青兔工具箱」 | 品牌位改为与 `logo-lockup.svg` 字标逐字一致的锁定名；`APP_INFO.name` 未改，页面/浏览器标题仍用它 |
| p525 | g2「badge 文本 = 青」 | g2「18px svg + 5 条路径」 | 首字徽标被图标替换 |
| p525 | g8「375 宽只剩首字徽标」 | g8「375 宽只剩 18px 图标」 | 同上 |

> ⚠️ 需要你知道的一处文案分叉：**品牌位文案是「青兔工具箱」，站点全名仍是「青兔在线工具箱」**。
> 原因具体：v3 的得意黑**子集只含「青兔工具箱」五个字**，字标要转轮廓就必须有字形；
> 「在线」两字不在子集里，取不到轮廓。两条路任选其一（都是改一处）：
> 1) 认下这个分叉（当前做法，播放页/字标资产一致，左栏/标题仍用全名）；
> 2) 把「在线」也纳入子集重新导出 —— `extract-glyphs.py` 里 `texts` 加一条、重跑 `build.mjs` 即可，
>    但需要原始整字库（v3 `fonts/SOURCES.md` 有下载地址，本机未留 17–26 MB 原件）。

---

## 7. 剩余未换的位置

| 位置 | 现状 | 是否建议换 |
|---|---|---|
| 首页 hero `h1.hero__title`（`src/views/Home.vue:260`） | 纯文字 `APP_INFO.name` | 可选：换 `logo-lockup.svg`（≥32px 规则正好适用），但它是「站点名标题」而不是「品牌位」，本轮按最小改动原则没动 |
| 旧资产 `src/assets/brand/{logo-*.svg, favicon-*.svg, preview.html, v2/, v3/}` | 原样保留 | 不换：v1/v2/v3 是历史对照，代码已无引用；如需清理另起一版 |
| `About` / 页脚版权 / 邮件等其它 `APP_INFO.name` 文本位 | 纯文本 | 不换：这些是「站点名」，不是「品牌标识」 |

---

## 8. 已知限制

1. **重量级不一致（A1 的固有弱点）**：Lucide 是 2px 细线，得意黑是斜体粗字面 —— 64px 时图标明显比字标轻。
   要更协调只能换 v3 推荐的 B1（Phosphor rabbit-fill），本轮按用户定稿的 A1 执行。
2. **favicon 不是单色**：为了在深浅两种标签栏都可见而用了强调色贴片；若坚持单色，需要在
   `<link rel="icon">` 上用 `media` 属性配两份文件（Safari/Firefox 支持，Chrome 仍只用默认那份）。
3. **`apple-touch-icon.png` 由 Chrome 截图生成**（`run.mjs` 截 `#atc` 180×180 区域），本机没装图像库；
   重新生成需要有 Chrome 的环境，或直接换用随便一个 180×180 的导出。
4. **暗色站内截图依赖应用主题状态**：`run.mjs` 先写 `localStorage` 再重载；直接改 `html.dark` 会被
   `useTheme` 的 resize 重算覆盖（第一版踩过，见 `out/` 里旧文件已删除）。
5. **`.p-brand-badge` 类名已从组件里移除**：站外若有样式/脚本指向它需要一起改（站内已无线索）。
6. 得意黑子集只含 5 个字形 + 空格，**改字标文案必须重新导轮廓**（脚本已备好）。
