# p592-ui —— 人物页首屏耗时实测工具

P5.92 的采集脚本，全部只读：不写库、不改服务端，只测量 + 截图。

## 跑法

```bash
cd QTools-C
# 冷缓存 3 次，输出 devtools/p592-ui/out/<tag>/{runs.json,summary.json} 并打印拆解表
node devtools/p592-ui/measure.mjs <tag> https://127.0.0.1 3

# 打桩：只给正式图（w>=300）加 200ms 延迟，截 3 帧证明低清先出
node devtools/p592-ui/stub.mjs https://127.0.0.1 200
#   环境变量 QT_STUB_ALL=1 → 连低清一起延迟（默认只延迟正式图）
```

## 三个文件

- `probe.js`：注入到新文档里的页面内探针（`Page.addScriptToEvaluateOnNewDocument`）。记录
  13 张卡何时出现、每张卡的 `data-card-bg` / `data-card-bg-stage`（preview → full）何时变化、
  每张 `img` 何时 `load` 与 `decode`，以及 `allDoneAt` / `allFullAt` 两个汇合时间。
- `analyze.mjs`：把 runs 折成「时间线 + 请求分类 + API 明细」三张表（中位数 + 三次原始值）。
- `measure.mjs` / `stub.mjs`：CDP 驱动（Chrome headless + `Network.clearBrowserCache`），
  stub 用 `Fetch.requestPaused` 做延迟打桩。

## 口径

- 「13 张全部出图」= 每张卡的 `img[data-role="pw-bg-card"]` 都 `complete && naturalWidth > 0`（低清即可）；
  「13 张全部高清」= 每张卡的 `data-card-bg-stage="full"`。
- 协议 / 连接复用取自 CDP `Network.responseReceived.response.protocol` 与 `connectionId`。
- 两次实测之间**必须**重新 `clearBrowserCache`（脚本每轮自动做），否则第二轮全是 304。
