# 品牌资产目录（QTools-C）

**唯一真相是 `final/`。** 页面里渲染的 logo 与这里必须同源：

| 位置 | 是什么 | 谁在用 |
| --- | --- | --- |
| `final/` | P5.33 定稿 A1 资产：Lucide rabbit 图标 + 得意黑字标（已转 path，无字体依赖） | `public/favicon.svg`、`public/apple-touch-icon.png` 由它派生；`src/utils/brandMark.js` 与它同一份图标路径 |
| `logo-mark.svg` / `logo-mark-mono.svg` / `logo-lockup.svg` / `logo-dark.svg` / `logo-light.svg` / `favicon-16.svg` / `favicon-32.svg` | v1 迭代稿（P5.27 阶段） | **无运行时引用**；仅 `preview.html` 与 `out/report.json` 留档 |
| `v2/` `v3/` | v2 / v3 迭代稿（P5.31–P5.32） | **无运行时引用**；仅历史比较页引用 |
| `out/` `preview.html` | 资产尺寸/对比自查产物 | 只给人看，不进包 |

结论：旧资产**保留**（它们是 `final/` 的溯源与复现证据，且因为没有任何 `import` 指向它们，Vite 不会打进 dist）。
新增页面图标请走 `@/components/BrandMark.vue`（数据源 `@/utils/brandMark.js`），不要直接 `<img>` 引用本目录的 svg —— `<img>` 里的 `currentColor` 会落到黑色，深色主题下不可见。
