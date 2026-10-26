# P5.42 首页标题字体 / hero logo / 播放列表重名校验 —— 实测报告

真浏览器实测台：`node devtools/p542-ui/run.mjs after`（**跑的是 dist 构建产物**：静态服务 + `/api` 反代到真实后端
127.0.0.1:8080，正常路径不打桩，只有「后端幂等兜底」那一条用 CDP Fetch 造 `created:false`）。
改前基线来自同一台机器上**线上 nginx 还在发的那份旧 dist**：`node devtools/p542-ui/capture-before.mjs`，
截图在 `out/before/`。改后线上复验：`node devtools/p542-ui/capture-live.mjs`（`out/after-live/`）。

---

## 1. 字体为什么「没生效」—— 根因是**两处不是同一款字**，不是字体没加载

先按清单逐条查，硬证据如下：

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| `fonts.scss` 是否被 `index.scss` @use | ✅ 是 | `src/styles/index.scss:6` `@use './fonts.scss';` |
| `@font-face` 的 src 路径 | ✅ 相对路径，被 Vite 处理 | `src: url("../assets/brand/v3/fonts/smiley-sans.woff2")`（fonts.scss:11） |
| dist 里有没有该 woff2 | ⚠️ **没有独立文件**，被内联成 base64 | `ls dist/assets \| grep woff2` → 0 个；`grep -c '@font-face' dist/assets/index-*.css` → 1；`grep -o 'data:font/woff2' … \| wc -l` → 1。原因：文件只有 **1556 B**，小于 Vite 默认 `assetsInlineLimit` 4096，于是被内联进 CSS —— 功能上更好（少一次请求、CSS 解析完即用），只是「dist 里找不到 woff2 文件」很容易被误判成「字体资源丢了」 |
| unicode-range 是否覆盖「青兔工具箱」 | ✅ 正好这 5 个字 | fontTools 读子集：cmap = `0x20 / 0x5154 兔 / 0x5177 具 / 0x5DE5 工 / 0x7BB1 箱 / 0x9752 青`，5 个字轮廓都非空（兔 5 轮廓 69 点、箱 7 轮廓 83 点…），upem 1000，advance 800/1000 em |
| `--qt-font-display` 是否被 hero__title 使用 | ✅ 是 | `src/views/Home.vue:445`（改前） |
| 浏览器里 computed font-family / document.fonts | ✅ 全都通过 | 见下表 |

**真正的问题**：站点名在两处用了**两种字**。

| 位置 | 改前 computed font-family | 5 字实际宽 | 字号 |
| --- | --- | --- | --- |
| 首页 hero 标题 `.hero__title` | `SmileySans, MiSans, …` | 128px（= 5 x 25.6，0.8em 得意黑度量） | 32px |
| **左栏 logo 站点名** `.qt-rail__logo-text` | `MiSans, MiSans, …`（继承 body） | **80px（= 5 x 16，1em 常规字度量）** | 16px |
| 顶栏品牌名 `.qt-topbar__brand-text` | 同上（MiSans） | — | 14px |

也就是说：用户说「侧边栏的 logo 和首页标题不是同一个字体吧」——**他说得对，之前确实不是**；
错误的那一半是**左栏**（P5.33 定稿的品牌字体是得意黑，只有 hero 用上了，左栏/顶栏漏了）。
另一个真实观感问题是 hero 标题只有 32px、旁边又没有 logo，斜切/圆头的得意黑在正文级的字号下读起来就像「普通粗体」。

改前证据（`out/diagnosis/`）：`zoom-hero-title.png`（hero = 得意黑斜切）vs `zoom-sidebar-logo.png`（左栏 = MiSans 直立圆头），
两处并排一眼能看出不是一款字。

### 修法

1. `src/layouts/AppShell.vue`：`.qt-rail__logo` 与 `.qt-topbar__brand` 加
   `font-family: var(--qt-font-display, "SmileySans", sans-serif); font-synthesis: none;`
   → 左栏 / 顶栏 / hero 三处站点名从此同一款字（实测两处 computed font-family 完全相等，左栏字宽 80 → 64px，
   更窄所以更不会截断）。
2. `src/views/Home.vue` `.hero__title`：**32px → 44px**（窄屏 30 → 34px），
   `font-family` 带显式兜底 `var(--qt-font-display, "SmileySans", sans-serif)`，
   并加 `font-synthesis: none` —— 子集是单份静态字形，声明 `100–900` 时浏览器本不会合成假粗，
   但这行让「永远不会被合成粗体糊成普通粗体」变成硬约束。
3. 没有改 `@font-face`、没有改 `unicode-range`、没有把 woff2 挪出内联——它们本来就是对的。

改后实测（1500x900，dist 产物）：
- `getComputedStyle(h1).fontFamily` = `SmileySans, MiSans, MiSans, -apple-system, …`
- `document.fonts.check('600 44px SmileySans', '青兔工具箱')` = **true**
- `document.fonts` 里 `SmileySans` 状态 **loaded**（unicode-range 仍是那 5 个码位）
- 标题 5 字实际宽 **176px = 44 x 0.8 x 5**（回退字体是 1em/字；把 `--qt-font-display` 强制换成回退栈后实测 44px/字 —— 见 `out/compare-fallback-vs-smiley.png`，上半是回退、下半是得意黑，字形差异肉眼可辨）

---

## 2. hero logo（新增）

`Home.vue` hero 里新增一行 `.hero__brand`（flex 行）：

```html
<div class="hero__brand">
  <BrandMark class="hero__logo" :size="44" :stroke-width="1.7" />
  <h1 class="hero__title">{{ APP_INFO.name }}</h1>
</div>
```

- 用的是**站内同一枚 BrandMark**（Lucide rabbit 内联 SVG，吃 `currentColor` → `--qt-primary`），
  不是另画一张图，与左栏 24px、顶栏 18px 是同一份路径数据（`@/utils/brandMark`）。
- 尺寸：桌面 **44x44**，`≤639px` 缩到 **30x30**（不放“只留图标”：节点字只有 5 字、30px 图标 + 34px 标题在 375 宽实测不溢出，留字信息量更大）。
- 对齐：flex `align-items: center` + `gap: var(--qt-space-3)`（窄屏 `--qt-space-2`）。
  实测 rect：`logo {w:44,h:44,x:714.5,y:70.5}`，与标题**行盒中心 Δ=0px**、与字形墨迹中心 **Δ=1px**（窄屏同样 Δ=0 / 30x30）。
- 线宽压到 1.7（24 网格单位）：图标从 18/24px 放大到 44px 时，原本 2 的线宽会显粗，压一档才和字重匹配。

前后对比：`out/compare-before-after.png`（上=改前 32px 无图标，下=改后 44px + 44px 图标）；
暗色/亮色/窄屏：`out/after/hero-dark.png`、`hero-light.png`、`hero-mobile-375.png`。

---

## 3. 播放列表名判重（前端拦截 + 后端兜底）

### 判重口径（明确写死并解释）

**trim 后整串相等；ASCII 不区分大小写**（`String.prototype.toLowerCase()` 归一后比较）。

- 为什么不是纯「完全相等」：库里唯一键 `uk_media_playlist_name_owner (name, owner_key)` 走 MySQL 8 默认
  `utf8mb4_0900_ai_ci`，后端本来就把 `Demo` 与 `demo` 当同名。前端若区分大小写，就会出现
  「前端放行 → 请求发出去 → 后端说已存在」，正是这次要消灭的自相矛盾。
- 不做全半角 / 空白折叠：那是后端 collation 之外的行为，前端不擅自猜（只 trim 首尾空白）。

### 实现

1. 提交前先校验（`createList` 第一段）——**三种情况一个请求都不发**：
   - 空 / 全空白 → 行内「请输入播放列表名称」
   - 超长（>32）→ 行内「名称最多 32 个字符（当前 N 个）」
   - 与**已加载清单**（`loadPlaylists` 的结果）重名 → 行内「已存在同名播放列表「X」」+ toast 同文案，
     并顺手 `selectList` 选中那个旧列表（用户不用自己去左栏找）
2. 输入框标红：`:class="{ 'is-invalid': !!nameError }"` + `:aria-invalid` + `aria-describedby="pl-new-err"`，
   错误文案 `role="alert"`。实测边框 `rgb(65,66,67) → rgb(247,137,137)`（= `--danger`，暗色），文案色同为 `--danger`。
3. 输入长度：输入框 `maxlength` 从 60 改成 **32**（与校验同源，改一处 `NAME_MAX` 即可）；
   校验分支仍保留兜底（JS 赋值 / 粘贴 / 未来 maxlength 放宽时不会被绕过）。
4. **后端幂等兜底的区分**：`MediaPlaylistServiceImpl.create()` 对同名是「查到就返回它 + `created:false`」（HTTP 200，不是错误）。
   前端据此分开提示：
   - `created === false` → toast「已存在同名播放列表「X」，已为你打开原来的那个」（不是「已新建」）
   - `created === true` / 字段缺失（老后端）→ toast「已新建播放列表「X」」
5. **后端契约现状（本轮不改后端）**：唯一约束 **已经存在**（`docker/init/45-media_playlist.sql` 的
   `UNIQUE KEY uk_media_playlist_name_owner (name, owner_key)`，owner 之间不互相卡名字，设计正确），
   `create` 也做了先查后写；并发下极端情况仍可能撞唯一键 → 落到 500 / 异常分支，前端会显示「新建失败」。
   若要更严谨，建议后端在 `insert` 捕获 `DuplicateKeyException` 后回落成 `created:false`（本轮不动）。

### 顺带修掉的一个真 bug（不修就没法「标红」）

`PlaylistsPage.vue` **从来没有 `@use './mediaTheme.scss'`**（PersonsPage / PhotosPage / MePage / PersonDetailPage 都有）。
后果：`--bg / --fg / --line / --danger …` 在本页全是空值，整条声明作废 —— 实测 `.pl-input` 的
`border-top-style: none`（描边根本没画）、错误文案 `color: var(--danger)` 无效从而继承文字色（“红字不红”），
卡片/列表项底色也全丢。修法与其他页一致：scoped 样式首行
`@use './mediaTheme.scss' with ($global: false);` + 根容器加 `media-scope` class。
修后实测 `--line`=`#414243`、`--danger`=`#f78989`，描边 `solid`，红框红字成立（见 `out/after/playlists-dup-inline-error.png`）。

---

## 4. 构建与测试

### vite build（0 error）

```
$ node node_modules/vite/bin/vite.js build
dist/assets/index-6ZWDOWOp.js   2,815.98 kB │ gzip: 627.59 kB
✓ built in 5.50s
```

dist 字体证据：`@font-face` 1 处、`data:font/woff2` 1 处（1.5KB 子集被内联，无独立 .woff2 文件，见第 1 节）。

### 新 harness：`devtools/p542-ui/run.mjs` → **43/43 PASS**

```
== A. 首页：标题字体 + hero logo ==
PASS hero h1 computed font-family 含 SmileySans — SmileySans, MiSans, …
PASS document.fonts.check(600 44px SmileySans, 青兔工具箱) = true
PASS SmileySans @font-face status = loaded
PASS 标题实际字宽 = 0.8em — 35.2px/字 @ 44px
PASS 左栏站点名与 hero 标题同一款字体 / 两处 computed font-family 完全一致
PASS 左栏 16px/600 也吃得意黑（check = true） / 左栏站点名未被截断 — 64px
PASS 标题关闭合成粗体（font-synthesis: none）
PASS hero 出现品牌图形（BrandMark <svg>）— svg {"w":44,"h":44,"x":714.5,"y":70.5}
PASS 桌面 logo 尺寸 44x44 / logo 与标题行盒居中 Δ=0px / 与字形墨迹光学居中 Δ=1px
PASS 首页无横向溢出 1485 <= 1500
PASS 强制回退后字宽变化（字形差异来自字体本身）44px vs 35.2px
PASS 窄屏 logo 30x30 / 窄屏标题 34px / 窄屏 logo 仍居中 / 窄屏无横向溢出 375 <= 375
== B. 播放列表：重名 / 空 / 超长 / 后端兜底 ==
PASS 输入框 maxlength = 32
PASS 媒体站主题变量已接上（--line / --danger 有值）— line=#414243 danger=#f78989
PASS 输入框描边真的画出来了（不是 none）— solid / rgb(65, 66, 67)
PASS B1 新名字 → 恰好 1 个 POST — {"name":"P542 甲 vx4y2"} ；toast = 已新建播放列表「…」；左栏真的多了这个列表
PASS B2 同名 → 请求数 0 ；行内/ toast = 已存在同名播放列表「…」；边框 rgb(65,66,67) → rgb(247,137,137) = --danger
PASS B2 清单里没有多出同名项
PASS B3 仅大小写不同也算重名（utf8mb4 ci 口径）— 0 请求
PASS B4 全空白 → 行内「请输入播放列表名称」+ 0 请求
PASS B5 33 字 → 行内「名称最多 32 个字符（当前 33 个）」+ 0 请求
PASS B5b 窄屏 375 带错误态无横向溢出 375 <= 375 ；窄屏下行内错误仍然可见
PASS B5c 窄屏重名 toast 在页头之下（不压新建/刷新）— toast.y=262 >= head.bottom=164
PASS B6 本地不知道重名 → 真的发 1 请求，created:false → 提示「已存在…已为你打开原来的那个」
PASS B7 打桩关闭后新建仍正常（1 请求 + 成功 toast）
PASS 收尾清理本次新建的列表（DELETE 200 x2）
passed=43  failures=0
```

### 既有 harness

| 台子 | 结果 | 说明 |
| --- | --- | --- |
| `devtools/p540-ui/run.mjs after` | **26/26 PASS** | 一条没改。站点名字宽 80 → 64px 后「站点名不被截断」仍过（64/64）；hero 的字体断言、toast 几何、左栏 176px、折叠 56px 全过 |
| `scripts/ctrl-autohide.test.mjs` | **78/78 PASS**（`node --test`） | 未改 |
| `devtools/p541-ui/run.mjs after` | **4 FAIL，与本次改动无关** | 见下 |

**p541 的 4 条失败（数据前置条件，不是代码）**：p541 假定视频库第一张卡片（`36b36203288b`）**不在**「来不及」列表里，
但现在它就在（`GET /api/media/playlist/1` → `count:10`，该 id 在 `seq:1`）。于是这次「加入」是幂等 no-op：
拿到的是「「来不及」里已经有这些视频，无需重复加入」，条目数 10 → 10，四条「+1 / 成功提示」自然不过。
旁证：同一轮里「菜单项变「已加入 ✓」」是 PASS —— 即点之前就已经在列表里了。
本次改动没有碰 VideoPage / usePlaylistAdd / 播放列表写入路径；p542 台子只新建并删除了自己的两条列表（DELETE 200）。

**旧断言调整清单：无。** 三个旧台子一条断言都没改。

---

## 5. 已知限制

1. 得意黑只有「青兔工具箱」5 个字 + 空格的子集：**站点名一旦改字，新字会逐个回退到 MiSans/系统栈**（左栏/顶栏/hero 同样如此）。
   要覆盖更多字得重新出子集（`scripts`/SOURCES.md 里那条 pyftsubset 命令），不是 CSS 能解决的。
2. dist 里没有独立 `.woff2` 文件是**内联**的结果（<4096B）。若确实要独立文件，设
   `build.assetsInlineLimit: 0`（或给该 url 加 `?inline=false`），代价是首屏多一个请求；本轮保持内联。
3. 名称上限 32 是我选的（输入框 `maxlength` 同步改 32，原先是 60；DB 列是 `VARCHAR(64)`）。
   已有更长名字的列表**照常显示**，只是不能再新建超过 32 字的新名字。若要放宽，改 `PlaylistsPage.vue` 的 `NAME_MAX` 一处即可。
4. 重名判定的 ASCII 大小写折叠与库的 ci collation 对齐；全角/半角、连续空白**不做**折叠——这类等价后端可能判重、前端不会预拦，
   那种情况下仍是「发一次请求 → 后端 `created:false` → 提示已存在」，行为正确但多一个请求。
5. 改名（PUT `/playlist/{id}`）的重名后端会返回 409 `MediaException.conflict`，前端 `putOrder` 目前只显示「排序保存失败」；
   本轮验收范围只覆盖「新建」，改名提示未动（建议下一轮统一）。
6. hero 标题字号从 32 提到 44（窄屏 34）是视觉决策：为了让得意黑的斜切/圆头在首屏读得出来；如果产品希望更克制，改 `Home.vue` 里 `.hero__title` 的 `font-size` 两处即可，其余不受影响。

---

## 6. 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/views/Home.vue` | hero 加 `.hero__brand` + BrandMark（44/30px）；标题 44/34px、`font-synthesis: none`、变量兜底 |
| `src/layouts/AppShell.vue` | `.qt-rail__logo`、`.qt-topbar__brand` 改用 `--qt-font-display`（站点名三处同款字） |
| `src/views/media/PlaylistsPage.vue` | 判重 / 空 / 超长行内校验 + 红框；`created:false` 区分为「已存在」；**补 `@use mediaTheme` + `.media-scope`**（修描边/红字失效）；窄屏行内错误出现时 `.is-name-error` 把 toast 下移到 214px（不压「刷新」） |
| `devtools/p542-ui/`（新增） | `run.mjs`（40 断言）、`snippets/*`、`capture-before.mjs`、`capture-live.mjs`、`out/{before,after,after-live,diagnosis}` 截图与 `report.json` |

（未跑 git；dist 已按 `vite build` 重新生成，线上 nginx 指向的这份 dist 已生效 —— `capture-live.mjs` 实测 :80 上 hero 44px + 44px logo + 左栏同款字。）
