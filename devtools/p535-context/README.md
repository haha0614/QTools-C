# P5.35 播放列表上下文增强实测台（devtools/p535-context）

跑法：

```
node devtools/p535-context/run.mjs        # 整页真实应用（人物页 → 视频库 → 播放器全链路）
```

## 被测对象

`/media` 与 `/media/person/:id` 都是**整个真实应用**（真实 `index.html` → `main.js` → router →
`PersonDetailPage` / `VideoPage` → `MediaPlayer` → `VideoMetaPanel`，vite 现编，不是复刻）。
只有服务端被替身，业务代码零改动。

## 打桩范围（两处）

1. HTTP 层：CDP `Fetch` 拦截 `/api/media/*` —— 索引 / 用户 / 策略 / 标签 / 人物 / 工作室 /
   播放列表 / 人物页（信息 + 该人物视频 + 相册）；
   **缩略图 `/api/media/thumb/v/*` 返回一张真实的 1×1 PNG**（若一律 404，面板会按设计把 `<img>` 摘掉，
   就断言不到 `img src` 了）；`stub.thumbFail` 开关专门验「加载失败静默回占位」；
2. 不需要媒体元素打桩：本台判据是 DOM / 路由 / sessionStorage。

## 判据（对 P5.35 验收 3 的 a–f）

| 组 | 判据 |
| --- | --- |
| a | 每行有缩略图与时长：`img src = /api/media/thumb/v/<id>`、`loading=lazy` + `decoding=async`、容器占位底色、文本形如 `03:21`、行高 ≥ 34px、区间滚动高度仍在 |
| b | 「我的播放列表」分区已不在 DOM（含 `.vp-pl*` 节点与整页文案），不再请求 `GET /api/media/playlists`；人物 / 评分 / 标签 / 标记四分区照旧，置顶分区仍是第一块 |
| c | 从人物页点卡片进入：标题 = 人物名 · 共 N 条、顺序 = 该页展示顺序、⏮⏭ 走该顺序、有序 id 落进 sessionStorage 快照 |
| d | 从标签筛选进入：标题 = 标签名（ASMR · 共 3 条）；组合筛选（标签+类型）→ 回落到「按当前浏览顺序」 |
| e | 从播放列表 `?playlist=` 进入：标题 = 列表名、顺序 = 自定义顺序、边界 ⏭ 禁用 |
| f | 同标签页刷新：来源名与顺序都恢复（sessionStorage）；清掉快照的深链：整档来源作废、标题一起回退到「按当前浏览顺序」 |
| g | 缩略图 404：行与占位照旧、失败 `<img>` 被摘掉、时长与行高不变、无异常 |
| h | 全程无未捕获异常 / 无 console.error |

## 端口与页面身份（与其它实测台并跑）

- vite dev 端口与 Chrome CDP 端口都向系统要**空闲端口**（`net.listen(0)`），不写死；
- 连上 CDP 后先确认目标页是 `about:blank`（本轮新起的 Chrome），再注入 `window.__P535_TAG='p535'`
  作为页面身份标记；每次导航后自检 `标记 + 标题 + 路径`：
  视频库页必须是 `/media` 且标题「媒体站 · 视频库」，人物页必须是 `/media/person/p1` 且标题
  「媒体站 · 人物详情」。对不上就立刻抛错，绝不把别人的 DOM 当判据。
- 控制条 ⏮⏭ 按**语义**定位（`上一条/上一部`、`下一条/下一部` 两种文案都认），不锁死按钮措辞。

## 产物

- `out/0N-*.png`：行缩略图+时长、人物来源、标签来源、播放列表来源、缩略图失败兜底五张实拍。
