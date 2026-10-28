# p609-ui —— 分级筛选「全局 + 持久化」真浏览器实测（P6.09）

用户口径：**「分级筛选应作用于全局，视频站和相册站以及人物列表都应有变化且不会随刷新取消」**。

## 跑法

```bash
node QTools-C/devtools/p609-ui/run.mjs
```

前置只要求「站点能跑」：后端在 `127.0.0.1:8080`、`QTools-C/dist` 是当前构建产物。
脚本自己起两台静态服务器（当前 dist / P6.09 之前的备份 dist），`/api/*` 原样反代到后端，
然后用 Chrome CDP 真点真刷。**不写库、不读管理端**：现场库一行没动。

环境变量（都有默认值）：`QT_CHROME` / `QT_API` / `QT_DIST` / `QT_OLD_DIST`。

## 输出

- `out/*.png`：17 张截图（三页 × 全部 / 各档 / 375 窄屏 / 暗色 / 修复前后对照 / 单档无条）；
- `out/report.json`：`{passed, failures, facts}`，`facts` 里按场景存了当场读到的 DOM 数值与期望值。

## 断言覆盖（对应验收 a–g）

| 场景 | 做了什么 |
|---|---|
| a | 视频站 chip = 全部 + 可见两档（限制级对未登录不可见，不出现）；chip 计数 = 视频数；点家长指导级 → hash `#rating=guidance`、列表 47/138、localStorage=guidance；**刷新**后仍是 47 且 hash 还在 |
| b | 点顶栏导航（SPA 路由，不重载）→ 图片站筛选条已选中家长指导级、相册 157 本 / 8390 张；再切人物页 → 同样选中，「筛选后 10 位人物」，卡片计数仍是完整口径 |
| c | 人物页改选大众级 → hash 变 `#rating=general`，人物 1 位；回视频站 91/138；回图片站 12 本——三页同步 |
| d | 三页各选「全部」→ hash 无 rating 段、localStorage 无键、8722 张 / 138 部 / 10 位全量恢复 |
| e | **修复前**（备份 dist）：`#rating=restricted` 被盲目采用 → `显示 0 / 138`（空页）；**修复后**：localStorage 存 restricted + 未登录（该档不可见）→ 自动回落「全部」、hash 无 rating、138 部全量，localStorage 偏好保留 |
| f | 代理把 `ratings[]` 砍到 1 档（等价站长把另两档设为未登录不可见）→ 三页都不渲染筛选条，内容照常 |
| g | 375×812：视频页抽屉里的筛选条、图片站、人物页三条都不溢出视口；暗色（`html.dark`）三页截图 |
| + | 分级 + 搜索叠加（hash 两段并存，条数 = 交集）；「清空」把 rating 从 hash 与 localStorage 一并清掉 |
