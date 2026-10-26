# P5.32 播放上下文实测台（devtools/p532-context）

跑法：

```
node devtools/p532-context/run.mjs        # 整页真实应用 + bare 播放器证据台
```

## 被测对象

- `/media` 是**整个真实应用**（真实 `index.html` → `main.js` → router → `VideoPage` →
  `MediaPlayer` → `VideoMetaPanel`，vite 现编，不是复刻），只有服务端被替身；
- `bare.html` 只挂 `MediaPlayer.vue`：整页里「上下文缺失」等价于「索引为空、根本没有播放器」，
  而验收要判的是**播放器拿到 hasPrev=false / hasNext=false 时两个按钮都禁用且不报错**，
  所以单独给一份受控 prop 的证据台。

## 打桩范围（两处，业务代码零改动）

1. HTTP 层：CDP `Fetch` 拦截 `/api/media/*`，返回固定 JSON（索引 / 用户 / 策略 / 标签 / 人物 /
   工作室 / 播放列表；封面 / 流 / 精灵图 / 预览片段一律 404）；
2. 媒体元素层：`<video>` 的 `load / play / pause` 打桩 + 捕获阶段吞掉 media error ——
   本轮全部判据是 DOM / 事件链，不需要真画面。

## 判据（对 P5.32 验收 3 的 a–e）

| 组 | 判据 |
| --- | --- |
| a | 从第 4 个视频进入：置顶分区 = 上下文列表、第 4 项高亮、点第 3 / 第 5 项切换（断言 play id 变化） |
| b | 控制条 ⏮⏭ 与快捷键 P/N → id = 上下文里的前 / 后一条（不是索引序里的其它视频） |
| c | 第一条 ⏮ 禁用、最后一条 ⏭ 禁用；禁用态点击不动 |
| d | 从 `?playlist=` 进入：分区标题显示播放列表名，顺序 = 列表顺序；退出后回落浏览顺序 |
| e | 上下文缺失：整页空态不报错 + bare 台两按钮禁用、不 emit；恢复后立即可用 |
| f | 全程无未捕获异常 / 无 console.error |

## 端口与页面身份（与其它实测台并跑）

- vite dev 端口与 Chrome CDP 端口都向系统要**空闲端口**（`net.listen(0)`），不写死；
- 连上 CDP 后先确认目标页是 `about:blank`（本轮新起的 Chrome），再注入 `window.__P532_TAG='p532'`
  作为页面身份标记；每次导航后自检 `标记 + 标题 + 路径`：
  应用页必须是 `/media` 且标题为「媒体站 · 视频库」，bare 台标题必须是 `P5.32 bare player harness`。
  对不上就立刻抛错，绝不把别人的 DOM 当自己的判据跑出脏数据。

## 产物

- `out/run.log`：最近一次完整输出；
- `out/0N-*.png`：浏览顺序上下文、越界禁用、播放列表上下文三张实拍。
