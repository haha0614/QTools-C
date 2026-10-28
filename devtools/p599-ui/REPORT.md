# P5.99 内容分级 + 分级维度的未登录可见 + 人物页按可见作品隐藏 —— 实测报告

真浏览器实测（Chrome headless + CDP，零第三方依赖）+ 后端探针（纯 fetch）。
被测对象：**临时实例 :18097**（当前源码 `target/classes` 直接起）与 **克隆库 `qtools_p599_tmp`**。
生产库 `qtools` 全程只读（见第 5 节核对结果）。

```bash
node QTools-C/devtools/p599-ui/api-probe.mjs   # 后端探针：PASS 82 / FAIL 0
node QTools-C/devtools/p599-ui/run.mjs         # 真浏览器：PASS 48 / FAIL 0
```

截图与原始报告在 `QTools-C/devtools/p599-ui/out/`（同一份已复制到 `evidence/p599-evidence/`）。

## 1. 环境怎么来的（生产库一次都没改）

| 项 | 值 |
|---|---|
| 临时实例 | `:18097`，`java @evidence/p599-evidence/temp-args.txt`（各模块 `target/classes` + `tmp/cp-run.txt`） |
| 库 | 克隆库 `qtools_p599_tmp`（`mysqldump qtools` → 导入；只改克隆库） |
| 迁移 | `QTools/doc/media_content_rating.sql` 在克隆库连跑 4 遍（幂等，见 `migration-run-3/4.txt`，两遍输出逐字相同） |
| 登录 | 站端 `Qing / P599test!1`、管理端 `admin / P599test!1`（密码只在克隆库里重置） |
| 并发说明 | 本仓库同时有 P6.00（`poster_source`）改动，克隆库因此补跑了 `doc/media_video_poster_source.sql`，否则管理端视频列表会 500 |

## 2. 后端探针（82 条断言，全过）

覆盖点与关键输出（完整 JSON：`out/api-report.json`）：

| 组 | 断言 |
|---|---|
| A 写入 | `PUT /video/{id}/rating` 三档各写一次 → 200；非法值 `xxx` → **400**；`PUT /album/{id}/rating` → 200；`POST /rating/batch` → `{requested:2, matched:2, updated:2}` 且 SQL 复核落库；管理端列表回显 `contentRating`（视频 / 相册两处） |
| B1 三档都可见 | 游客索引 `ratings` = 三项（general 429 / guidance 1 / restricted 2）；条目带 `contentRating` |
| B2 restricted 关掉 | 游客索引不含该视频 / 该相册；`ratings` 不含 restricted；`/video/{id}`、`/thumb/v`、`/sprite`、`/preview`、`/frame`、`/stream?p=`、`/file?p=`、`/album/{id}`、`/thumb/p/<album>/<seq>`、`/preview/p/...` **全 404**（错误体 `{"error":"not found"}`）；登录后全部恢复 200 / 在索引里 |
| C 只剩一档 | 游客 `ratings` 只有 `general`（前端据此不渲染筛选条）；guidance 视频直连也 404；登录后仍三项 |
| D 与库根叠加 | 库根 `guest_visible=0` + 该视频分级 `general`（可见）→ 索引不含、直链 **仍 404**；恢复后回到索引 |
| E 人物页 | 名下作品全不可见 → 游客列表无此人物、`/person/{id}` 404、登录后仍在；放回一本相册 → 出现且 `albumCount=1 / videoCount=0 / photoCount=73`（可见口径）、`coverPath` = 可见首册封面；头像指向不可见相册 → 列表与详情的 `avatarUrl` 均为 `null`、`/person/{id}/card-bg` 也 404；只剩视频可见 → `videoCount=159 / albumCount=0`、`coverVideoId` 有值 |
| F 复位 | 复原后游客 `stats` 回到基线（videos 239 / albums 193 / people 13），策略三档可见、库根无收紧 |

## 3. 真浏览器实测（48 条断言，全过）

### 站端（QTools-C 构建产物）

| 场景 | 断言 | 截图 |
|---|---|---|
| 三档都可见 | 筛选条出现、三个 chip（大众级 429 / 家长指导级 1 / 限制级 2） | `site-media-rating-filter-3.png` |
| 点「限制级」 | chip 选中、URL 写 `#rating=restricted`、网格只剩限制级条目（与索引计数一致） | `site-media-rating-restricted-only.png` |
| 关掉 guidance+restricted | **筛选条整条不渲染**，内容正常 | `site-media-rating-filter-hidden.png` |
| 图片站 | 筛选条出现；点「限制级」相册数 25 → 2 | `site-photos-rating-filter.png` |
| 人物页·全不可见 | 该人物卡片消失（其余 11 张仍在） | —— |
| 人物详情·404 | `.person-detail[data-state=unavailable]` | `site-person-detail-hidden.png` |
| 人物页·部分可见 | 卡片回来，计数 `0 部视频 · 1 本相册 · 73 张照片`（可见口径） | `site-persons-partial-visible.png` |
| 头像来自不可见内容 | `data-avatar=initial`（首字占位）、该卡**没有 `<img>`**（不请求不可见图片） | `site-persons-avatar-initial.png` |

### 管理端（QTools-M 构建产物，`/admin-ui`）

| 场景 | 断言 | 截图 |
|---|---|---|
| 视频列表 | 表头出现「分级」列；行内下拉 10 个；点开选「家长指导级」→ SQL 复核落库；**刷新后仍显示「家长指导级」** | `admin-media-rating-column.png` / `admin-media-rating-persist.png` |
| 相册列表 | 「分级」列 + 行内下拉；多选勾选框；勾选后出现「批量设置分级」→ 对话框 → 提交 → restricted 相册数 2 → 3 | `admin-album-batch-rating.png` |
| 库根管理 | 顶部「分级与可见性」卡片三个开关，默认都「未登录可见」；点掉「限制级」→ 库里 `guest_visible=0`、界面同步；点回来 → 1 | `admin-rating-policy.png` / `admin-rating-policy-restricted-off.png` |

## 4. 构建与单测

| 项 | 结果 |
|---|---|
| `mvn -o -DskipTests compile`（QTools） | **0 error** |
| `npm run build`（QTools-C） | **0 error**（`✓ built in 5.85s`） |
| `npm run build:prod`（QTools-M） | **0 error**（`✓ built in 23.09s`） |
| `node --test`（QTools-C 全部 23 个 `*.test.mjs`） | **23/23 通过** |
| `npm run check:menu-icons`（QTools-M） | OK（28 个菜单图标都能在 sprite 里找到） |
| 后端 junit | 仓库内没有 `src/test`（本次未新增） |

**调整的旧断言：0 条**。新增 2 组断言：
- `QTools-C/src/views/media/contentRating.test.mjs`（新增，4 组）：`ratingOf` / `showRatingFilter` / `matchesRating` / `ratingLabel`；
- `QTools-C/src/views/media/personWall.test.mjs`（追加 3 条）：`avatarHidden=true` → 首字占位且不发请求；没有该键时仍是原四级回退。

## 5. 生产库只读核对（实测时与实测后各一次）

```
roots_guest_visible_not_1   0        -- media_root 没有任何收紧行
content_rating_col          0        -- 生产库还没跑迁移（部署时由站长执行）
rating_policy_table         0
videos 239 / albums 193 / photos 9913 / persons 13   -- 与实测前基线一致
```

## 6. 已知限制

见 `docs/内容分级与可见性.md` 第八节。要点：

1. `/media/file|stream|sub?p=` 按 `rel_path` 反查分级，**文档 / 字幕**这类非媒体文件查不到 → 放行；
2. 分级只到「视频 / 相册」两级，图片继承相册；
3. 管理端列表暂无「按分级筛选」下拉（本次只做列 + 行内改 + 批量）；
4. 图片站的分级筛选状态不写 URL hash（视频页写了 `#rating=`），刷新会清空；
5. 头像可见性只覆盖手动头像（`avatar_kind`）；历史 `avatar_path` 是已落盘的站内图片，不按内容判定。
