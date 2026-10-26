# P5.45 · 信息栏分区顺序 / 提示挪底 / 人物卡片加厚 —— 实测报告

跑法：`cd QTools-C && node devtools/p545-ui/run.mjs after`
产物：`devtools/p545-ui/out/after/`（report.json + 10 张截图）
最近一次：**64 通过 / 0 失败，exit 0**（验证时点 2026-10-26T07:29Z，与当前工作树一致）

被测对象 = 应用本身（`vite dev` 现编真 SFC + 真 useMediaApi + 真 request.js），
数据 = 真运行中的后端（`/api` 代理 → `127.0.0.1:8080`，真 MySQL / 真索引 / 真缩略图）。
vite 与 CDP 端口都 **向系统要空闲端口**（bind 0 → 读回 → 释放）；接上页面后先做
**页面身份自检**（同源 + 预期路径 + 应用 DOM 锚点 + 调试目标 URL 与当前页一致），不过就中止。

---

## 1 信息栏分区顺序（需求 1）

真数据（`/media#play=1d74d2cc5d20`，full 档）：

| 位 | 分区 | 证据 |
| --- | --- | --- |
| 0 | 收藏（`.vp-fav-row`，不是 section） | E3：`["vp-fav-row","vp-sec vp-sec-syn","vp-sec vp-sec-ctx"]` |
| 1 | 作品简介 `data-vp-sec="synopsis"` | E4：syn=0 |
| 2 | 播放列表（上下文）`data-vp-sec="playlist-context"` | E4：ctx=1（简介在上下文**之前**） |
| 3 | 人物 | E2 顺序数组 |
| — | 工作室 | E2b：真数据不渲染（见「已知限制 2」） |
| 4 | 评分 | E6：10 颗星、0 个 disabled（full 档可点） |
| 5 | 标签 | E7：`＋ 加标签` 在 |
| 6 | 标记 | E7：`＋ 加标记` 在 |

打桩补证「工作室」的位置（CDP 给索引塞 `videos[].studios = ['Prestige','S1']`）：

- E9 完整顺序 = `作品简介 → 播放列表 → 人物 → 工作室 → 评分 → 标签 → 标记`（7 个 section，收藏在其前）
- E9b 工作室 index = 3（夹在人物与评分之间）
- E9c 简介仍在上下文之前

## 2 提示行挪到最底部（需求 2）

- F2 提示是 `.vp-body` 的**最后一个子节点**：`["vp-sec","vp-hint vp-note"]`
- F3 `compareDocumentPosition` 证明它在「标记」分区之后
- F4 `font-size: 11.5px`；F5 颜色 = `--fg-dim`（不再是 `--warn` 橙）
- F7 只是说明文字：`＋ 加标记` / `＋ 加标签` 照旧在（锁定只看编辑策略）
- F8 窄屏 420px 浮层仍在最底部
- E10 打桩让元信息可读 → **提示不出现**（证明它只由「读不到」触发，不是常驻）
- E5/E5b 真后端状态：站端 `GET /video/{id}/meta` 业务码 500（405 包成 500）、`/admin/video/{id}/meta` 401
  → 所以真环境一定出现提示，正好用来实测它能落在底部

## 3 人物卡片（需求 3）

### 3a 头像三级回退 + 命中率

URL 形态（与 VideoCard / 相册卡同一套构造，取自 `useMediaApi`）：

| 档 | 数据来源 | URL |
| --- | --- | --- |
| ① 相册首图 | 索引 `albums[].cover` = `thumbs/p/<albumId>/0000.jpg`（该人物名下**第一个**相册） | `api.thumbUrlFromRel()` → `/api/media/thumb/p/<albumId>/0000` |
| ② 视频封面 | 第一个含此人的 `videos[].id` | `api.videoThumbUrl()` → `/api/media/thumb/v/<videoId>` |
| ③ 首字彩底 | —— | 无 `<img>`，`.pw-avatar` 文本 = 首字 |

实测命中（15 位人物，真索引 + 真 `/persons` + 真 `/person/{id}`）：

- 相册封面 **10** 位、视频封面 **4** 位、首字回退 **1** 位（`E2E演员`，无相册无视频的空壳）
- **命中 14 / 15 = 93%**
- 样例真 URL 逐个回源：`/api/media/thumb/p/a164/0000`、`/api/media/thumb/p/a153/0000`、`/api/media/thumb/v/1d74d2cc5d20`
  → 全部 HTTP 200 `image/jpeg`（23–28KB），且 DOM 里 `naturalWidth > 0`（A5/A6 全量）
- G1 数据驱动校验：念念的头像 = 索引里**第一个**含她的相册（a164）的封面，不写死 id
- C 组（CDP 把 `/api/media/thumb/p/a164/*` 打成 404）：img 被移除 → 回退「念」，
  占位盒子仍是 48×48（C4，不抖动），同页其它 13 张不受影响（C5）

### 3b 卡片字段

`pw-card`（`<a>`，`data-person-id` / `data-avatar=profile|album|video|initial`）：

1. 头像 48×48 圆形（`object-fit: cover`；回退时是首字）
2. 姓名（`.pw-name`，省略号）
3. 别名（跟在名字后括号里，`--fg-dim` 小一号；无别名不渲染）
4. `X 部视频 · Y 本相册 · Z 张照片`（`.pw-counts`；三个数全 0 → 整行不渲染）
5. 最多 3 个有值的人物资料 chip（`.pw-chips` 单行 nowrap + overflow 裁；顺序 = 身高/体重/三围/出生/国籍/…）
6. `最近 YYYY-MM-DD`（`.pw-recent`；mtime 取最大；无时间 → 整行不渲染）

真数据样例：`念念` → `0 部视频 · 144 本相册 · 9017 张照片` + chip `性别 女`；
打桩（CDP 注入 mtime + 资料字段）→ `念念（念念 Nian Nian）` / `0 部视频 · 144 本相册 · 9017 张照片` /
`["身高 165cm","体重 48kg","三围 B88/W58/H88"]`（按优先级取前 3 个有值字段，第 4 个「出生」被截掉）/ `最近 2026-10-17`。

### 3c 布局

- A9 整墙等高：min=max=99.4px，**spread 0**；A10 无一张横向溢出；A11 chip 区单行（≤20px）
- A7b/A7c 数量行完整可见（`scrollHeight ≤ clientHeight`）：最长那条 `0 部视频 · 144 本相册 · 9017 张照片` 折成 2 行显示，不被省略号吃掉
- B1 窄屏 375px → **2 列**；B2 spread 0；B3 页面不横向滚动（pageOverflow = −15）
- A8 全空人物（E2E演员）→ 无数量行、无 chip 行、无「最近」行（不留空洞）
- D6 信息变多后仍等高（spread 0）

## 4 既有能力未被破坏

- G2/G3/G4：点卡片 → `/media/person/111`（标题「念念」，`data-state=ready`）→ 「← 人物」回墙 15 张卡片都在
- E6/E7/E11：评分 10 星可点、标签 / 标记 / 简介编辑入口都在（三档策略未动）
- E8：简介正文 + 上下文 176 行都真渲染
- 既有单测全绿（见下）

## 5 构建与测试

- `vite build` → `✓ built in 5.03s`，**0 error**（产物含 PersonsPage / PersonDetailPage / VideoMetaPanel chunk）
- 既有真浏览器 harness：`node src/views/media/video/synopsisBrowserEvidence.mjs` →
  **P5.38 真浏览器证据：47 组 / 0 失败**（简介折叠 6 行像素、展开收起、编辑保存往返真发 PUT、
  失败回滚、off/local/full 三档、8001 字符边界）—— 证明这次把简介分区搬到第二位没碰任何行为
- 单测（node，无浏览器）：

| 文件 | 结果 |
| --- | --- |
| `scripts/ctrl-autohide.test.mjs` | PASS 78/78 |
| `scripts/playlist-count.test.mjs` | PASS 43/43 |
| `scripts/playlist-filter.test.mjs` | PASS 17/17（并发代理新增） |
| `src/views/media/personWall.test.mjs` | PASS 69 项断言 |
| `src/views/media/video/personRules.test.mjs` | PASS 43 项断言 |
| `src/views/media/video/playbackContext.test.mjs` | 83 passed / 0 failed |
| `src/views/media/video/playerExtras.test.mjs` | 175 passed / 0 failed |
| `src/views/media/video/playerProgress.test.mjs` | 111 passed / 0 failed |
| `src/views/media/video/subtitleStyle.test.mjs` | 50 passed / 0 failed |
| `src/views/media/video/synopsisRules.test.mjs` | 47 组 / 0 失败 |

## 6 调整过的旧断言（都在 `devtools/p545-ui/run.mjs`）

| 原断言 | 为什么改 | 改成 |
| --- | --- | --- |
| A5「三个样例头像 URL 都是图片」（样例全是 video 档） | 三条都是视频封面，相册档没被验真；且 Node 24 undici 在「响应体没读完就收到 FIN」时 `assert(!this.paused)` 崩进程 | 样例固定取 **相册封面 + 视频封面** 各一，并 `await res.arrayBuffer()` 读完响应体 |
| E2「分区顺序 = 简介→列表→人物→工作室→评分→标签→标记」 | 工作室是 `v-if="studioNames.length"`，而真索引 `videos[].studios` 压根没这个字段 → 真数据恒缺该段，等值断言必假 | E2 改为「现有顺序是目标顺序的子序列」；另设 **E9**（CDP 给索引进 studios）断言含工作室的完整 7 段顺序与 studioIdx=3 |
| E5「真 meta 成功时没有提示行」 | 事实错误：真后端没有匿名读元信息（站端 500 业务码、/admin 401），提示**必然**出现 | 改为 E5（直接请求两条接口证明读不到）+ E5b（因此提示出现且在最后）+ 新 **E10**（打桩 200 → 提示不出现） |
| F6 同上等值断言 | 同上（真索引无 studios） | 改为子序列判定 |
| （新增）A7b/A7c | 上一版数量行是 `nowrap + ellipsis`，200px 一列 + 48px 头像只剩 ~150px 文本宽，`0 部视频 · 144 本相册 · 9017 张照片` 直接变成 `…9…`，「三个数字」白给 | 数量行改成最多折 **2 行**（`-webkit-line-clamp: 2`），并加断言：每张卡 `scrollHeight ≤ clientHeight`、念念那条完整可见；等高由 `grid-auto-rows: 1fr` 继续保证（A9/B2/D6 全 spread 0） |
| E/F/G 的开场等待（只等 `.vp-body` / `.pd-title` / pathname） | 抽屉与详情页都是异步的：过早探到「加载中…」/ 占位标题 `#111`，会误判 E3、E5b、G3、G4 | `openPanels()` 等到「收藏行已渲染且不再显示加载中」；G 等 `.person-detail[data-state=ready]` |

仓库里**没有**其它既有 harness 断言因这两处顺序改动而失效：
`devtools/p532-context`、`devtools/p535-context` 只断言「我的播放列表」分区被删；
`evidence/synopsisHarness.js`、`src/views/media/video/synopsis*Evidence.mjs` 只断言简介内容 / 折叠 / 三档，
不断言它在第几位，也不断言那条提示的位置。

## 7 改动清单（本轮）

| 文件 | 改了什么 |
| --- | --- |
| `src/views/media/video/VideoMetaPanel.vue` | ①「作品简介」section 整块移到「播放列表（上下文）」之前；②`readNote` 那条提示从 `.vp-body` 顶部移到**最后一个子节点**（标记分区之后），新增 `.vp-note{color:var(--fg-dim);font-size:11.5px;line-height:1.5}`；文件头分区注释同步定稿 |
| `src/views/media/personWall.js` | 卡片信息唯一实现：`buildWallIndex`（albums/videos/people 三源拼装，cover / posterId / counts / **mtime 取 max**）、`avatarOf`（profile → album → video → initial）、`countsText`、`profileChips`、`aliasOf`、`formatDay` + `toMs`（毫秒数 / `yyyy-MM-dd HH:mm:ss` / ISO 都认）、`buildCard` |
| `src/views/media/personWall.test.mjs` | 补 `toMs` / 三处 mtime 取 max / 日期字符串 / null mtime 的用例（现 69 项断言） |
| `src/views/media/PersonsPage.vue` | `pw-card` 卡片（头像 + 名字 + 别名 + 数量 + ≤3 chip + 最近）、`grid-auto-rows: 1fr` 整墙等高、≤768px 2 列、无数据不渲染行；数量行允许折 2 行 |
| `src/views/media/PersonDetailPage.vue` | 只补一个 `computed` 导入（P5.48 在途改动漏的，缺它详情页运行时报错） |
| `devtools/p545-ui/run.mjs` | 真浏览器实测脚本（A–G 七组、64 条断言；端口向系统要、页面身份自检、CDP 打桩三处） |

## 8 已知限制

1. **「最近 YYYY-MM-DD」在现行后端不出现**：`/api/media/index` 的 `people[]` 只有
   `name/count/photos/albums/cover`，没有 `mtime`；`/person/{id}`、`/album/{id}`、`/video/{id}` 也都不带
   （DB 的 `media_album.mtime` / `media_video.mtime` 存在，只是没出接口）。
   前端已按 `people[].mtime → albums[].mtime → videos[].mtime` 三处取 max（`toMs()` 兼收毫秒数与
   `2026-10-17 09:30:00` / ISO 字符串），后端补字段后即可直接显示，无需再改前端。
2. **「工作室」分区真数据下不渲染**：同样是索引缺 `videos[].studios`（`VideoMetaPanel` 的 `v-if`），
   属既有数据条件，本次只保证它一旦有值时位置正确（E9 打桩证明）。
3. **显式头像（avatarPath）全站为 null**：所以「① 相册首图」实际是第一位生效的档；
   P5.48 的手动头像（`avatarUrl`）由并发代理在做人。
4. **资料 chip 真数据最多 1 个**：`/person/{id}` 目前只填了 `gender`（如「性别 女」），
   其余 13 个资料字段为空 → 3 个 chip 的上限要等资料补齐才看得到（D3 用打桩证明取前 3 的逻辑）。
5. **并发改动**：`PersonsPage.vue` / `PersonDetailPage.vue` 同时被 P5.48（手动头像）代理修改；
   本次顺手修掉它漏的 `computed` 导入（否则 `/media/person/:id` 运行时 ReferenceError、页面空白）。
6. 页面控制台有既有的 `[Vue warn] Extraneous non-props attributes (create-mode)`（`PlaylistManageDialog`），
   与本次改动无关。

## 9 P5.51 追记：站端匿名 meta 落地后，E2b / E5 / E5b 的断言口径改为「按能力 / 按数据」

后端 P5.50 把 `GET /api/media/video/{id}/meta` 变成 @Anonymous 只读（hidden 与不存在同为 404），
并把 `videos[].studios` 的形态从 `[name]` 扩成 `[{id,name}]`。原来这三条断言把「当时那一天的部署状态」写死了，
后端一升级就变成假失败，所以改成**先探能力 / 先看数据，再断言前端表现与之一致**：

| 断言 | 旧（P5.45 时的事实） | 新（P5.51） |
| --- | --- | --- |
| E2b | 「真数据里**没有**工作室分区」（理由：索引缺 `videos[].studios`） | 「分区是否渲染**与索引里的实际数据一致**」：`videosWithStudios === 0` ↔ 不渲染。真库 media_studio 仍 0 行 → 当前仍不渲染；后端有数据时断言自动跟着成立 |
| E5 | 「真后端**没有**匿名读元信息」（`site!==200 && admin===401`） | 「提示行与站端读能力**一致**」：探到可读 → 必须无提示；探不到 → 提示必须在 `.vp-body` 最底部。能力判据兼容两种应答形态（裸媒体对象 / AjaxResult），只有 `{error:"not found"}` 算读不到 |
| E5b | 「于是提示行必然出现」 | 分支：读得到 → 标记分区按**真值**落地（标记数 = 响应里 `markers.length`；空则「暂无标记」）；读不到 → 提示在最底部 |
| E 块等待 | `waitFor('.vp-note')` 写死 | 按能力等对应终态（读得到等标记区块结论，读不到等 `.vp-note`） |
| （新增）E10b | — | 打桩 `markers:[]` →「暂无标记」且无提示（P5.51 的「读成功即权威」语义） |
| （新增）F9 | — | 读失败时**不**显示「暂无标记」 |
| （新增健壮性）A/B/C/D/G 探针 | `evaluate(wallProbe)` 直接取属性 | 探针返回 null 时兜空壳（`{cards:[]}`），让断言 FAIL 而不是整段 `TypeError` 崩掉；A5 / A6 补非空前提，避免空集合假 PASS |

复跑（后端已升级到 P5.50 构建，`GET /api/media/video/1d74d2cc5d20/meta` 匿名 200、markers=[]）：

    node devtools/p545-ui/run.mjs p551-after   →   P5.45 实测：66 通过 / 0 失败

其中 E5 走的是**真后端可读**分支：「站端 /meta 可读，markers=0；/admin 一路 401」→ 面板显示「暂无标记」且无提示；
E9 / E10 / E10b 仍用 CDP 打桩补证「有 studios 时的 7 段顺序」与「读成功无提示」。
