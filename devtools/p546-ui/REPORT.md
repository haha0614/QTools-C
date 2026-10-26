# P5.46 —— 播放列表改为「网格筛选维度」，取消独占页面（QTools-C，仅前端）

用户决定原话：「播放列表形态用 C」—— 播放列表不再独占一个大页面，而是视频库网格上的**一个筛选维度**
（与时长 / 分辨率 / 体积并列）。

## 0. 一句话结果

| 验收 | 结果 |
| --- | --- |
| 1 vite build | **0 error**（`vite build` → ✓ built in ~5s，VideoPage 433.04 kB） |
| 2a 选列表 → 网格条目 = 列表条目且顺序一致 | **PASS**（前 3 个 id 与列表序逐条一致；排序下拉被覆盖；UI 提示「按列表顺序」） |
| 2b 清空筛选 → 回到全库 | **PASS**（下拉「全部」与工具栏「清空」两条路都验） |
| 2c 管理弹层 重命名 / 删除 / 拖拽排序 | **PASS**（PUT name / DELETE / PUT videoIds 三个真实请求都被录到并断言） |
| 2d 侧栏入口不再产生独立页面（路由与 URL） | **PASS**（点击落在 `/media`，下拉自动展开；`/media/playlists` 旧地址重定向，无死链） |
| 2e 从该筛选进播放器 → 标题 = 列表名、顺序 = 列表序 | **PASS**（「验收列表A改名 · 共 4 条」，行顺序逐条对齐，⏭ 走列表第 2 条） |
| 3 既有 harness / 单测 | 单测 10 个文件全绿（新增 1 个 17 条）；harness 见 §7（p540/p542/p544 的旧断言因页面取消而失效，已逐条说明） |

真浏览器实测：`node devtools/p546-ui/run.mjs` → **PASS 72/72**
（分组 S11 / A14 / B5 / C19 / D10 / E8 / F6，末尾 G1 一条「全程无未捕获异常」）。
A13/A14 额外验证「播放列表维度与搜索是『与』」—— 库里既有筛选能力与这一维度不打架。

## 1. 改了哪些文件

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `src/views/media/video/PlaylistFilter.vue` | **新增** | 筛选条上的「播放列表」下拉（全部 / 各列表带条目数 / 分隔线 / 管理 / 新建） |
| `src/views/media/video/PlaylistManageDialog.vue` | **新增** | 管理弹层：重命名 / 删除（两步确认）/ 拖拽排序 / 复制列表名 / 新建 / 按此列表筛选 |
| `src/views/media/VideoPage.vue` | 改 | `state.pl` 筛选维度 + 网格保序 + 播放上下文 + 两处 UI（桌面筛选条 / 移动抽屉）+ 管理弹层 + `?plf` 聚焦消费 |
| `src/views/media/video/playlistOrder.js` | 改 | 新增纯函数 `orderByPlaylistIds(videos, ids)`（只留列表内 + 严格按列表序） |
| `src/views/media/video/PlaylistGrid.vue` | 改 | 新增 `allow-remove` 开关（管理弹层在只读档位隐藏 ×）；原拖拽能力不变 |
| `src/layouts/AppShell.vue` | 改 | 侧栏「播放列表」从「页面链接」改为**动作项**（跳视频库 + 打开该下拉） |
| `src/utils/navActive.js` | 改 | 动作项（`item.action`）永不参与高亮（否则会和「视频库」双亮） |
| `src/router/index.js` | 改 | `/media/playlists` 保留为**重定向**（→ `/media?plf=…`，带 `?playlist=<id>` 时一并带上） |
| `src/views/media/PlaylistsPage.vue` | **删除** | 独占页面取消（能力已搬进弹层），路由本身保留重定向，不留死链 |
| `scripts/playlist-filter.test.mjs` | **新增** | 17 条纯逻辑单测（保序筛选 + 动作项不高亮） |
| `devtools/p546-ui/run.mjs` | **新增** | 本次真浏览器验收（CDP 打桩播放列表接口 + 空闲端口 + 页面身份自检） |
| `devtools/p535-context/run.mjs` | 改 1 条断言 | b6：`GET /api/media/playlists` 由「0 次」改为「首屏恰好 1 次」，原因见 §7 |

## 2. 筛选维度怎么实现的

- **状态**：`state.pl` = 选中的列表 id（`''` = 全部），落在 URL hash 的 `pl` 段
  （`#pl=p1&sort=name`），因此可刷新、可分享、与其它筛选条件同进同出；`清空` / `clearAll` 会一起清掉它。
- **筛选 + 保序**：`view = orderByPlaylistIds(queryVideos(...), plView.ids)`。
  先按既有筛选（分类 / 时长 / 分辨率 / 体积 / 搜索 / facet / 工作室）出候选，再「只留列表内 + 严格按列表顺序」，
  **覆盖排序下拉**（排序仍写进 hash，只是这一维度下不生效，UI 明说「按列表顺序」）。
  列表加载未完成时返回空网格（宁可短暂空白，也不显示「已筛选却看到全库」），空态文案区分
  「正在加载播放列表… / 接口未就绪 / 这个播放列表还没有视频 / 都被当前筛选挡掉了」。
- **数据**：两份、都只有一个来源 —— `plList`（清单：下拉 + 弹层共用）与 `plView`（选中列表的有序条目）。
  接口未就绪只在下拉 / 弹层里显示一句可读提示，库本身不受影响。
- **UI 提示「按列表顺序」**：① 筛选条右侧一枚虚线 chip；② 激活 chip 行写「播放列表：名称（按列表顺序）」；
  ③ 下拉按钮 title 与「按列表顺序」tooltip 说明「排序下拉此时不生效」。
- **播放上下文**：`playlistContextSource()` 里**筛选维度优先**，其次才是 URL `?playlist=<id>`（旧深链仍照旧可用）。
  上下文快照仍在 `openPlayer` 时定一次（快照语义不变），播放中改筛选不重算。

## 3. 管理弹层（PlaylistManageDialog）

- 左栏：清单（名称 + 条目数）+ 新建（沿用原页的 `trim / ≤32 字 / 同名（不区分 ASCII 大小写）` 判重）。
- 右栏：选中列表的**有序条目**（序号 = 播放顺序），复用 `PlaylistGrid` 的原生 HTML5 拖拽；
  拖完 `moveItem` → 乐观渲染 → **整份有序集合 PUT 回写**（`{ videoIds: [...] }`），失败回滚。
- 头部动作：**重命名**（PUT `{name}`）、**删除列表**（两步确认，避免弹层里 `window.confirm`）、
  **复制列表名**（Clipboard API，不可用时 toast 兜底）、**按此列表筛选**（应用到网格后关闭）。
- 条目**新增**沿用视频卡片 + 卡片菜单（未新增任何上传 / 批量加入入口）；条目**移出**保留 ×（原页能力平移，
  避免页面取消后彻底没有移除入口）。只读档位（off / local）整块禁写并给出既有文案。

## 4. 侧栏入口与旧页面处置（选择：保留路由 + 删除组件）

- 侧栏项 `{ to: '/media', action: 'playlist-filter' }`：点击时 `preventDefault` 后
  `router.push({ path: '/media', query: { ...现有query, plf: <时间戳> } })`，已在视频库时保留当前 hash
  （筛选 / 排序 / 播放深链不会被这次点击清掉）。
- VideoPage 消费 `?plf`：打开下拉 → 立刻 `router.replace` 抹掉该参数（一次性，刷新不会又弹一次）。
  时间戳做 token，所以「已经在视频库时反复点」每次都能触发。
- **为什么删除 `PlaylistsPage.vue` 而不是留成重定向组件**：路由级 `redirect` 不产生空白帧；
  留着组件反而变成没人引用的死代码。旧地址 `/media/playlists` 保留重定向（带 `?playlist=<id>` 时把 id 带过去），
  书签 / 外部链接都不 404 —— 实测 D8/D9/D10 三条断言覆盖。
- 选中态：动作项 `isNavActive` 恒 false（有单测 F14–F16），所以 `/media` 上只有「视频库」高亮。

## 5. 图片站

未改动：播放列表只含视频，`PhotosPage.vue` / 图片站工具栏一个字节都没动。

## 6. 样式 / 响应式 / 无横向溢出

- 全部用既有 token（`--bg-2 / --bg-3 / --line / --line-2 / --fg / --fg-dim / --accent / --accent-soft / --radius`），
  亮暗两套主题实测背景色不同（`rgb(245,247,250)` vs `rgb(20,20,20)`，各一张截图）。
- 下拉面板 `max-width: min(320px, calc(100vw - 24px))`、弹层 `width: min(760px, calc(100vw - 28px))`，
  窄屏弹层单列（清单在上、条目在下）。
- **顺带修掉一个窄屏既有 bug（影响「无横向溢出」验收）**：`@media (max-width:768px)` 里
  `.grid { grid-template-columns: repeat(2, 1fr) }` 的 `1fr` 最小值是 `auto`（= 卡片内容的 max-content），
  只要某张卡有不可断行内容，整条轨道就被撑到 499px，页面横向滚动 **400px**。
  改成 `repeat(2, minmax(0, 1fr))`（`cols-3` 同样处理）后实测 **documentElement 溢出 = 0**，
  两列各 165px，卡内长文本由既有的 `text-overflow: ellipsis` 截断。
  移动端抽屉里的这一维度按钮右边缘 178px < 视口 375px。

## 7. 旧断言调整（含「断言播放列表页」的用例）

| harness | 旧断言 | 现状 | 原因 / 处置 |
| --- | --- | --- | --- |
| `devtools/p535-context` | b6「打开播放器**不再请求** `GET /api/media/playlists`（死请求随分区一起删掉）」 | **已改**为「视频库首屏恰好取 1 次」 | P5.46 起这条请求是**必要**的：下拉要列出各列表 + 条目数。改后 p535 = **69 passed / 1 failed**，e1–e6（`?playlist=` 深链上下文）全绿，证明旧深链行为未被破坏 |
| `devtools/p535-context` | b5「置顶分区仍是第一块」 | **失败（不归本次）** | P5.45 已把「作品简介」提到第二位（P5.45 定稿），属另一条改动线，未代改 |
| `devtools/p540-ui` | 整段「真实 PlaylistsPage 新建播放列表 → toast」 | **运行中断**（`Cannot set properties of null (setting 'value')`） | 它 assert 的是已删除的独占页 DOM（`.pl-input` 等）。页面不存在 → 断言对象消失；等价能力改由 p546 的 C 段（弹层新建 / 重命名 / 删除）覆盖 |
| `devtools/p542-ui` | B 段「播放列表：重名 / 空 / 超长 / 后端兜底」 | **超时失败**（等待「播放列表页输入框」） | 同上：`.pl-input` / `.pl-new__err` / `.pl-page` 都不再有。判重逻辑本身搬进了 `PlaylistManageDialog`（口径未变：trim / ≤32 / 不区分大小写），只是断言入口变了 |
| `devtools/p544-ui` | 「清单行计数乐观更新」（在 `/media/playlists` 上跑） | **双重失败**：起始条件就红了（真实库里 `1111`/`111` 两个列表不存在，`[null,null]`），随后 assert `.pl-page` 的段落也失去对象 | 与本次改动无关的数据前置失败 + 页面取消。P5.44 的计数逻辑（`playlistWrite.js`）未改动，`scripts/playlist-count.test.mjs` **43/43 全绿** |

> 这三个 harness 我没有改写：它们整段围绕「独占页面」的 DOM 编写，最小改法等于重写。
> 等价覆盖已由 `devtools/p546-ui`（72 条）承担；若需要保留历史 harness，建议另起一轮把它们迁到「筛选维度 + 弹层」口径。

## 8. 单测 / 构建

```
scripts/ctrl-autohide.test.mjs                 PASS 78/78
scripts/playlist-count.test.mjs                PASS 43/43
scripts/playlist-filter.test.mjs               PASS 17/17   ← 本次新增
src/views/media/personWall.test.mjs            PASS 69
src/views/media/video/personRules.test.mjs     PASS 43
src/views/media/video/playbackContext.test.mjs 83 passed, 0 failed
src/views/media/video/playerExtras.test.mjs    175 passed, 0 failed
src/views/media/video/playerProgress.test.mjs  111 passed, 0 failed
src/views/media/video/subtitleStyle.test.mjs   50 passed, 0 failed
src/views/media/video/synopsisRules.test.mjs   47 组 / 0 失败
```

## 9. 已知限制

1. **列表顺序覆盖排序下拉**是有意的：选中列表时排序选择器仍可点，但顺序恒为列表序（UI 用「按列表顺序」说明）。
   若将来要「列表序 + 自定义排序叠加」，需要另立规则。
2. 播放列表接口未就绪时：下拉为空 + 一句可读提示，网格回升到全库（不会把库卡死）；列表详情失败时该维度显示空网格 + 提示。
3. 移出条目在弹层里的 × 仍走 `DELETE /video/{id}`，失败退回整份 PUT（与旧页面一致），两种后端都兼容。
4. 移动端底部工具栏 (`.tb-top`) 在 375 下内部被挤 25px（`scrollWidth 365 vs clientWidth 340`），
   但**不产生文档级横向滚动**（实测 doc 溢出 = 0）。该行是 P5.47「批量生成简介」按钮加入后更紧的行，
   属另一条改动线的排布问题，未代改。
5. 顺带修掉 `writeHash()` 的一个既有缺陷：它原来用 `history.replaceState(null, …)`，会丢掉 vue-router 的
   history state（控制台报「history.state seems to have been manually replaced」）。现在原样带回
   `history.state`。剩下的同类告警来自 `PhotosPage.vue`（图片站，按要求不动），已在证据日志里标注。
6. 下拉里的「新建播放列表…」入口在 S9 断言了存在与文案，弹层内的新建输入框与判重逻辑沿用原页实现
   （POST `{ name }`，成功即选中新列表）；本轮 harness 没有点穿「新建」这条链路（C 段聚焦重命名 / 删除 / 拖拽），
   因为真实库为空、桩里新建只影响桩数据，价值不如前三条。新增列表立即出现在下拉里这一点靠
   `onPlaylistDataChanged -> loadPlaylistList()` 保证（与重命名 / 删除同一条回执链路，后者已被 C8/C12 覆盖）。
7. 本仓库当前有**其它会话在并行改同一工作区**（`VideoMetaPanel.vue` / `useMediaApi.js` / `PersonDetailPage.vue` 等），
   本报告只对 §1 列出的文件负责。

## 10. 证据文件

- `devtools/p546-ui/out/after/run.log`：72 条断言全文（每行带实测值）
- `devtools/p546-ui/out/after/result.json`：facts（下拉条目 / 列表顺序 / 桩收到的写请求 / 主题背景色…）
- 截图：`p546-s-dropdown-wide-light` / `p546-a-filtered-wide-light` / `p546-a-filtered-wide-dark` /
  `p546-c-dialog-light` / `p546-c-after-dialog` / `p546-d-sidebar-action` / `p546-e-player-context` /
  `p546-f-narrow-drawer`
- 端口与身份：vite / CDP 端口均由系统分配（本次 57258 / 随机 CDP），接页面后做
  「同源 + 预期路径 + `.ms-page` 锚点 + 调试目标 URL 一致 + 标题非空」自检。
