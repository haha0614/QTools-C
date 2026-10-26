# P5.51 证据（前端接线：标记列表改读站端匿名 meta）

跑法（真浏览器，vite 现编 + 真后端代理 + CDP 打桩）：

    cd QTools-C && node devtools/p551-ui/run.mjs            # 默认 tag=after
    cd QTools-C && node devtools/p545-ui/run.mjs p551-after # 既有信息栏顺序 harness（断言已按 P5.50 事实改）

## 1. 接线改动（只动前端，2 个文件）

**src/views/media/video/VideoMetaPanel.vue**

| 位置 | 改动 |
| --- | --- |
| L365-367 | 标记列表空态由无条件 `v-else` 改为 `v-else-if="markersKnownEmpty"`：只有「权威为空」才说「暂无标记」 |
| L636-645 | 新增 `markersKnownEmpty = markersTrusted \|\| !isFull` —— 复用 P4.3 的权威标记，不新增一套状态；读失败时 `markersTrusted` 仍为 false，空态交给 readNote 那条提示 |
| L627-635 | `markersTrusted` 注释改写：P5.50 起站端 /meta 是 @Anonymous 只读，「读成功即权威（空 = 真没有）」，只有读失败才保持 false |
| L723-728 | `load()` 注释改写：404 / 网络 / 非 200（含 getVideoMeta 里 /admin 回退也失败）才算失败 |

**src/composables/useMediaApi.js 未改**：`getVideoMeta`（L219-227）本来就是「先打站端 /video/{id}/meta，失败才回退 /admin/video/{id}/meta」，
本次确认保留该顺序（真浏览器 E2 还证明新增标记的 PUT 也仍打站端 URL、不回退 /admin）。

站端不再需要管理员身份：本次会话里 8080 实例先后是两种构建，都被跑过一遍——

- 升级前（P5.50 之前的 jar）：`GET /api/media/video/{id}/meta` → `{"code":500,"msg":"Request method 'GET' is not supported"}`、`/admin` 一路 → `{"code":401}`（都不带任何 Authorization 头）→ 面板落回那条提示；
- 升级后（当前）：`GET /api/media/video/1d74d2cc5d20/meta` 纯匿名 → **200** `{id,rating,tags,persons,studios,markers,fps,dur}`，`/admin` 一路仍是 401 → 面板直接渲染标记 / 「暂无标记」。

所以前端**两种后端都能跑**：读得到 → 直接渲染（markers 即权威）；读不到 → /admin 回退，仍失败才提示。

## 2. 四态实测（真浏览器 + CDP 打桩）

`node devtools/p551-ui/run.mjs` → **33 通过 / 0 失败**（`devtools/p551-ui/out/after/report.json` + 同名 png 截图）

| 态 | 桩 | 结果 |
| --- | --- | --- |
| a 有标记 | meta 200，`markers:[{id:7,pos:4698,endPos:null,label:"P551甲标记",color:"#4f9cf9"}]` | `.vp-mark` 1 条、pos 文本 `78:18`、label 正确、标题计数 1；**无** `.vp-note`；无「暂无标记」 |
| b 无标记 | meta 200，`markers:[]` | `.vp-mark` 0 条、显示「暂无标记」、**无** `.vp-note`、标题计数 0 |
| c 404 | 站端 /meta 404 + /admin 一路也 404 | `.vp-note` 文本 =「标记需要管理员身份读取，站端暂不展示；评分与标签按索引显示，仍可直接编辑」（逐字比对）；**不**显示「暂无标记」；评分回落索引 80 分、标签回落索引 5 个 |
| d studios 两形态 | 索引注入 `[{id:1,name:"P550甲工作室"}]` 与 `["P551乙工作室"]` | 三处归一化都吃：VideoCard `.cp-studio`、FilterSidebar 工作室分组（名称 + 计数 1）、VideoMetaPanel `.vp-studio`；勾选该工作室后列表只剩 1 部（videoStudioNames 判名命中） |
| e 写入非回归 | 捕获 PUT（不落库） | `PUT /api/media/video/{id}/meta`（不含 /admin）；body `markers` 2 条整表覆盖；新标记只有 `{pos:62,label:"P551新增",color:"#4f9cf9"}`（本机 id 不外泄、无 at/note/endAt）；已有标记 id=7 原样回传；PUT 回包照旧当权威值渲染成 2 条 |

真后端（不打桩）的旁证：升级后的 8080 实例上 `GET /api/media/video/1d74d2cc5d20/meta` 匿名 200、`markers:[]`，
p545 的 E5 / E5b 于是在**真数据、零打桩**下走的就是这条新建分支——「站端 /meta 可读，markers=0；/admin 一路 401」→
面板显示「暂无标记」且无提示行（旧断言在这里会假失败，已按第 3 节的口径改掉）。

## 3. 旧断言调整（devtools/p545-ui/run.mjs）

改的是**断言口径**，不是放宽：原来把「某一天的部署状态」写死，后端一升级就变成假失败。

| 断言 | 旧 | 新 |
| --- | --- | --- |
| E2b | 「真数据里**没有**工作室分区」（理由是索引缺 `videos[].studios` 字段） | 「分区是否渲染**与索引里的实际数据一致**」（`videosWithStudios === 0` ↔ 不渲染）；真库 media_studio 仍 0 行 → 当前仍不渲染，后端有数据时该断言自动跟着成立 |
| E5 | 「真后端**没有**匿名读元信息」（`site!==200 && admin===401`） | 「提示行与站端读能力**一致**」：探到 200 → 必须无提示；探到非 200 → 提示必须在最底部 |
| E5b | 「于是提示行必然出现」 | 分支：读得到 → 标记分区按**真值**落地（标记数 = 响应里 markers.length；空则「暂无标记」）；读不到 → 提示在 `.vp-body` 最底部 |
| E 块等待 | `waitFor('.vp-note')` 写死 | 按能力等对应终态（读得到等标记区块结论，读不到等 `.vp-note`） |
| E10b | 新增 | 打桩 `markers:[]` →「暂无标记」且无提示（P5.51 的权威语义） |
| F9 | 新增 | 读失败时**不**显示「暂无标记」 |
| bodyProbe | 新增两字段 `markCount` / `noMarkHint` | 供 E5b / E10b / F9 复用 |

E9（打桩 studio 夹在人物与评分之间 studioIdx=3）、E10（读成功无提示）、F1-F8（提示在最后、字号 11.5px、颜色 --fg-dim）**未改**，照旧通过。

## 4. 构建输出

`node node_modules/vite/bin/vite.js build` → **0 error**，`✓ built in 5.75s`

## 5. 已知限制

1. **off 档仍不发读请求**：`onMounted` 里 `if (!isFull) { loading = false; return }` 未动（本次要求「评分 / 标签仍按索引显示、三档编辑策略无回归」）。
   所以 off 档空态仍按旧展示走「暂无标记」。若要让**匿名站端（off 档）**也看到标记，需要放宽档位（读接口本身不受编辑策略限制，技术上可行），属产品决策，本次未做。
2. 8080 实例在本次会话中从「P5.50 之前的构建」被换成了「P5.50 构建」（jar 时间 15:46），中间有几分钟 /api/media/persons 因
   `Unknown column 'p.avatar_kind'` 报 500 —— 与前端无关，但会让 p545 的 A/B/C/D/G 段假失败（已给探针加 null 兜底，使其报 FAIL 而不是崩）。
   两边都跑过：升级前 p545 走「读不到 → 提示」分支、升级后走「读得到 → 渲染 / 暂无标记」分支，同一套 harness 两种口径都断言。
3. 四态 a/b/c/d 的 meta / index 应答由 CDP 打桩构造（真库没有 P550 甲工作室、media_studio 0 行），写入路径也是打桩捕获、**没有真落库**（不做破坏性验证）。
4. 区间标记本次只断言「字段名保持 pos/endPos」；打桩的新标记是单点，`endPos` 分支沿用 P4-B 旧逻辑未改。
5. 后端 jar 换版期间 p545 有两轮 A 段人物墙未渲染（见上条），后端恢复后单独复跑 **66 通过 / 0 失败**，见第 6 节。

## 6. 既有 harness / 单测

| 命令 | 结果 | 备注 |
| --- | --- | --- |
| `node devtools/p551-ui/run.mjs` | **33 通过 / 0 失败** | 本卡新增，四态 + 归一化 + PUT 非回归 |
| `node devtools/p545-ui/run.mjs p551-after` | **66 通过 / 0 失败** | 原 64 条 + 新增 E10b / F9；E2b / E5 / E5b 口径见第 3 节 |
| `node src/views/media/video/synopsisBrowserEvidence.mjs` | **47 组 / 0 失败** | 未调整任何断言（它给 meta 打的是 200 + markers:[] 的桩，本次改动后仍成立） |
| `node --test scripts/*.test.mjs src/views/media/*.test.mjs src/views/media/video/*.test.mjs` | **10 files / 10 pass / 0 fail** | ctrl-autohide 78/78、playlist-count、playlist-filter、personWall、personRules、playbackContext 83、playerExtras 175、playerProgress 111、subtitleStyle 50、synopsisRules 47 组；**未改任何单测断言** |
