# P5.60 人物卡片：加宽 / 非真人条目 / 头像取帧 —— 实测报告

被测对象：QTools-C（vite dev 现编，真 SFC + 真 useMediaApi）+ 运行中后端 127.0.0.1:8080 + 真实库 qtools。
真浏览器：headless Chrome（CDP 直连），三档视口 1600×1000 / 1200×900 / 375×812。

跑法：

```
node QTools-C/devtools/p560-ui/run.mjs after        # 本轮全部断言（73 项）
node QTools-C/src/views/media/personWall.test.mjs  # 纯逻辑单测（107 项断言）
```

## 1. 卡片加宽（不是加高）

CSS：`.pp-wall { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)) }`（原 200px）；
`.pw-card { min-height: 84px; padding: 10px 12px }`（原 min-height 108px / padding 12px）；
`.pw-counts { white-space: nowrap; overflow: hidden; text-overflow: ellipsis }`（原 `-webkit-line-clamp: 2`，允许折两行）；
`.pw-chips { flex-wrap: nowrap; overflow: hidden }`（原 `wrap`）。

| 视口 | 声明 minmax | 实测列宽 | 卡片高（整墙等高） | 数量行 | 数量行 scrollWidth / clientWidth | 横向溢出 |
|---|---|---|---|---|---|---|
| 1600×1000 | 280px | 335.25px ×4 列 | 103.7px（min=max） | 13/13 张 1 行 + nowrap | 243 == 243（最紧：素人「159 部视频 · 2 本相册 · 118 张照片」） | scroll 1585 ≤ client 1600 |
| 1200×900 | 280px | 317.66px ×3 列 | 103.7px（min=max） | 13/13 张 1 行 + nowrap | 226 == 226 | scroll 1185 ≤ client 1200 |
| 375×812 | 280px（≤430px 收单列） | 328px ×1 列 | 101.03px（min=max） | 13/13 张 1 行 + nowrap | 258 == 258 | scroll 360 ≤ client 375 |

- 数量行判据：`round(clientHeight / lineHeight) === 1` 且 `scrollWidth === clientWidth`（没被省略号切）。
- chip：3 个 chip 的卡（娜娜 / 深田咏美 / 河北彩花）在三档视口全部 **1 行**；pill 无越出卡片、无 0 宽 pill。
- 高度与 P5.55 的 108px 起相比：内容自然高 ≈100px（名字 20 + 数量 16 + chip 18 + 最近 14 + 间距 9 + 内边距 20），不再靠 min-height 硬撑。

## 2. 「E2E演员」（测试残留）—— 已删除

查库事实（清理前）：`media_person` id=126，note 自述「非真实人物（测试空壳）：人物墙 UI 自检用的空壳人物」；
三条关联全 0：`media_video_actor` 0 行、`media_album_person` 0 行、`media_album.person_id` 0 行。

处置：备份 `doc/backup/media_person_before_p560_20261026_175502.sql` → 跑 `doc/p560_person_placeholder_cleanup.sql`（幂等）：

```
deleted_e2e: 首跑 1 / 重跑 0（幂等）
```

DELETE 带三重 NOT EXISTS 守卫 —— 只要它绑了任何真实视频 / 相册就一行都不删（那时应改「隐藏 + note 标注」）。

## 3. 「未归类」（相册归档容器）—— 不删，打标记 + 前端过滤

**方案 A（采用）**：后端 `MediaPersonServiceImpl.isPlaceholderPerson` 判定并输出 `isPlaceholder`；
前端 `personWall.isPlaceholderPerson` 是同一套规则的镜像（同一个函数同时兜底老后端：响应里没有该键时按名字判）。
规则两条取或：名字 ∈ {未归类}，或 note 带 `[placeholder]` 标记（标记让「改个名字」也认得出来）。

接口兼容：只在 `/media/persons` 与 `/media/person/{id}` **新增** `isPlaceholder` 键，既有键一个没动（当前后端已带此键，13 位全 false）。

「素人」：**保留**。它是无演员视频的兜底人物（`MediaPersonServiceImpl.AMATEUR_NAME`），有业务含义；
note 已补「（保留说明：人物页照常展示 —— 无演员视频的兜底人物，不是相册容器。）」。

机制的真浏览器证明（只打桩 `/api/media/persons`，页面/判定/渲染全是真的）：

| 用例 | 构造 | 期望 | 实测 |
|---|---|---|---|
| F1 | `{id:113,name:'未归类'}`（老后端形态，无 isPlaceholder 键） | 隐藏 | PASS |
| F2 | `{name:'归档容器X', note:'[placeholder] …'}`（改过名） | 隐藏 | PASS |
| F3 | `{name:'任意容器名', isPlaceholder:true}` + 素人 | 隐藏容器、保留素人 | PASS |
| F4 | `{name:'未归类', isPlaceholder:false}`（后端显式否认） | 展示 | PASS |

> 数据侧变化（并行会话，务必知悉）：17:56 另一个会话做了 `media_person` 合并（备份 `doc/backup/media_person_merge_p562_before_20261026.sql`），
> 已把「未归类」整行删除并把名下相册并入「素人」（见素人 note 末尾与 `doc/media_person_merge_uncategorized.sql`）。
> 因此库里已无「未归类」一行：人物墙不显示它，既来自前端过滤（机制由 F1–F4 独立证明），也来自该行不存在。

## 4. 头像 ③ 档：视频内容帧（追加需求）

回退链（`personWall.avatarOf`）：① 手动/显式头像 → ② 名下第一个相册首图 → ③ 名下第一个视频的**内容帧** → ④ 姓名首字彩底。

- URL：`/api/media/frame/<videoId>?t=<整秒>&algo=f1&w=400`，`t = floor(dur × 0.3)`（`frameSecondOf`）。
  **整秒是刻意的**：后端只有整秒那一支按 `<秒>.jpg` 落盘永久缓存；带小数会走「精确取帧、no-store、每次真跑 ffmpeg」。
- 懒加载：`IntersectionObserver`（rootMargin 120px）+ `onUpdated` 重新挂观察；进入视口前不挂 `src`，先渲染首字占位。
- 失败静默：`loading="lazy" decoding="async"` + `img@error → markAvatarFailed → 首字`。

实测（真实数据里 3 位「无相册有视频」的人物）：

```
娜娜     → /api/media/frame/485470e2cc08?t=562&algo=f1&w=400   dur=1873.79 → floor(×0.3)=562 ✓
深田咏美 → /api/media/frame/046839cff1cd?t=2209&algo=f1&w=400
河北彩花 → /api/media/frame/d1d123208f95?t=358&algo=f1&w=400
```

内容帧 ≠ 封面（同一支片子，两张图确实不同）：

```
封面   /api/media/thumb/v/485470e2cc08         480x270  10735B  sha256 12e474a3d77a…
内容帧 /api/media/frame/485470e2cc08?t=562    480x270  10498B  sha256 fe57037a7327…
```

图片证据：`devtools/p560-ui/out/after/g-cover-485470e2cc08.jpg` 与 `g-frame-485470e2cc08.jpg`
（封面是带字幕的片头场景，内容帧是 562 秒处的画面，视觉完全不同）。

懒加载实测：真实数据只有 3 张取帧卡且都在首排，量不出屏外行为 → 用构造的 20 位「有视频无相册」人物 + 构造索引，
只打桩 `persons` / `index` 两个接口（其余全真实）：

```
卡片 20 张全部 data-avatar=frame；视口 1000×300（刻意压矮，屏外必然有卡）
首屏（进入视口 12 张）：取帧请求 12 个    ← 屏外 8 张一个请求都没发
滚到底              ：取帧请求 20 个；data-frame-inview=1 的卡 12 → 20
```

> 构造数据里的视频 id（sv0…sv19）当然取不到帧 → 这些卡会走 onerror 退回首字，所以 G2 只量「进入视口标记」与「请求数」的增长，不量「还挂着 img 的卡数」。

取帧失败（CDP 把 `/api/media/frame/*` 全部打桩成 404）：3 张取帧卡 `img` 数量 0/3，头像退回**首字**「娜 / 深 / 河」，无未捕获异常。

人物详情页（PersonDetailPage）也同步接了同一档：`URLS.frameOf` + `posterDur: videos[0].dur`，
所以「两页头像优先级永远一致」这条 P5.48 的口径没有被这次改动打破（该页 img 本就有 `@error → 首字`）。

## 5. 构建与测试

| 项 | 结果 |
|---|---|
| `vite build`（QTools-C） | 0 error（built in 4.62s） |
| `mvn -o -pl qtools-media -am compile`（QTools） | exit 0（`javap` 可见 `isPlaceholderPerson`） |
| `personWall.test.mjs` | 107 项断言全过（新增 16 项：占位判定 / 值截断 / 取帧秒数 / posterDur） |
| 其余前端单测（personRules / playbackContext / playerExtras / playerProgress / subtitleStyle / synopsisAudio / synopsisRules / ctrl-autohide / playlist-count / playlist-filter） | 全绿 |
| `devtools/p560-ui/run.mjs`（本轮新 harness） | 73 / 73 |
| `devtools/p552-ui/run.mjs`（既有 harness） | 40 / 40（调整 2 条旧断言，见下） |

调整的旧断言（P5.55 口径 → P5.60 口径）：

1. `devtools/p552-ui/run.mjs`：`cardGeo.minH >= 108`（「卡片拉长」）→ `84 ≤ minH ≤ 110`（紧凑：靠加宽而不是加高）。
2. `devtools/p552-ui/run.mjs`：chip 容器 `wrap + overflow:visible` → `nowrap + overflow:hidden`（单行不撑高；超长值在 `profileChips` 截到 14 字）。
3. `personWall.test.mjs`：四张卡的 stats 期望对象补 `posterDur: 0`；头像 ② 档断言 `kind:'video' → 'frame'`、URL `/thumb/v/<id>` → `/frame/<id>?t=<秒>`；两处 `E2E演员` 夹具改成中性的「空壳人物」（该人物已从库里删除）。

## 6. 已知限制

1. **chip 内文字会被省略号收尾**：深田咏美 / 河北彩花 的「三围」值太长（`B87.8 / W63.5 / H91.1（2020 年時点）` 一个字 30 字），
   已在 `profileChips` 截到 14 字，但 3 个 chip 加起来仍可能略超一行 → flex 收缩 + pill 内省略号收尾（pill 本身不越界、不折行）。
   完整值在 `title` 悬浮与人物详情页（`profileFacts` 不截断）。要一个字都不省只能折行，那会重新长高卡片。
2. 真实数据里只有 3 位人物走取帧档，「屏外不请求」用构造数据（20 位）证明——不是真实数据里真有大量取帧卡。
3. 「未归类」行已被并行会话的合并删除（并入素人），`isPlaceholder` 目前对生产数据没有命中；机制由 F1–F4 + 单测固定。
4. 整秒取帧的缓存键 = 内容 hash + 秒；`dur` 若被重扫改写，取帧秒数会变（换键、重生成一张），不影响正确性。
5. 本会话同时有另一个会话在改 QTools-C（`PersonAvatarDialog.vue` / `PersonDetailPage.vue`）并重启后端，harness 内置 90s 探活 + 3 次重试。
