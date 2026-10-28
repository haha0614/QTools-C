# p609-ui 实测报告（P6.09 分级筛选：全局 + 持久化）

跑法 `node QTools-C/devtools/p609-ui/run.mjs` → **PASS 66/66**（`out/report.json`）。

## 现场环境

- 后端：`127.0.0.1:8080`（真后端、真库，**未做任何写操作**）；
- 前端：`QTools-C/dist`（`npm run build` 产物）+ 备份的 P6.09 之前 dist（只做「修复前」对照）；
- 索引 `built = 2026年10月27日 17:22:06`：`stats = {videos:138, albums:169, photos:8722, people:10}`，
  `ratings[] = [大众级 103, 家长指导级 204]`（`count` = 视频 + 相册合计；**限制级不出现在访客索引里**）。

| 口径 | 全量 | 大众级 | 家长指导级 |
|---|---|---|---|
| 视频 | 138 | 91 | 47 |
| 相册 | 169 | 12 | 157 |
| 照片 | 8722 | 332 | 8390 |
| 人物（该档下有可见作品） | 10 | 1 | 10 |

> 人物两档相加 11 > 10：同一个人可以两档下都有作品 —— 所以人物页「全部」必须显示**人数**
> （10），不能是各档之和（`RatingFilterBar` 的 `total` 属性就是为这条加的）。

## 关键数值（截图见 `out/`）

| 断言 | 实测 |
|---|---|
| a 视频站选家长指导级 | hash `#rating=guidance&sort=…`，`显示 47 / 138`，localStorage `guidance` |
| a 刷新后 | 仍 `rating-chip-guidance`，`显示 47 / 138` |
| b 图片站（SPA 切换） | 选中家长指导级；chip 157 本；平铺视图 `共 8390 张` |
| b 人物页 | 选中家长指导级；10 张卡片；副标题「筛选后 10 位人物」；卡片计数仍写全量（如「0 部视频 · 143 本相册 · 785 张照片」） |
| c 人物页改大众级 | hash `#rating=general`；人物 1 位；视频站 91/138；图片站 12 本 |
| d 全部 | hash 无 rating；`共 8722 张` / `138 / 138` / 10 位 |
| e 修复前 | `#rating=restricted` → `显示 0 / 138`（旧的「盲目采用不可见档位」） |
| e 修复后 | 自动回落「全部」、hash 无 rating、`138 / 138`、localStorage 仍 `restricted` |
| f 单档可见 | 三页 `[data-testid=rating-filter]` 都不存在，视频仍 138/138、人物仍 10 |
| g 375 窄屏 | 视频抽屉 `left:12 right:287.8`、图片站 `232.3→365`、人物页 `16→180.3`，均 ≤375 |
| + 叠加 / 清空 | `#q=交通&rating=general&sort=…` 且 `显示 5 / 138`（= 交集）；「清空」后 hash 空、localStorage 无键、138/138 |

## 已知限制

1. **后端 `people[].byRating` 本轮只 compile、未部署**（部署由用户做）。所以本次实测走的是前端兜底
   路径：从同一份索引的 `albums[].contentRating` / `videos[].contentRating` 反推人物维度
   （`personRating.js`，单测 `personRating.test.mjs` 覆盖两种数据源）。后端字段部署后前端自动切换到它，
   判定结果应完全一致（同一批可见行、同一套 `contentRating`）。
2. 场景 f 的「只有 1 档可见」由脚本代理改写 `ratings[]` 模拟（等价站长把另两档设成未登录不可见）：
   真跑要动生产库的 `media_rating_policy`，本脚本刻意不写库。
3. `out/*.png` 是 headless Chrome 截图，字体来自 CDN（misans）；断网时字形会退回系统字体，不影响断言。
