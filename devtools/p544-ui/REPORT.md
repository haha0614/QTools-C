# P5.44 「加入播放列表后条目数不立刻更新」—— 实测报告

真浏览器实测台：`node devtools/p544-ui/run.mjs <tag>`（vite dev 现编 + Chrome headless CDP）。
页面代码零改动即为被测对象；读取走真实 8080（索引 + 清单 + 真 MySQL），
「失败分级 / 服务端算错数」用 CDP Fetch 打桩构造（真机不方便把编辑策略切成只读）。
截图与完整 JSON 在 `devtools/p544-ui/out/p544/`。

## 1. 根因

菜单行的「N 个」只有一处来源：`GET /api/media/playlists` 归一化出来的 `count`
（`playlistOrder.normalizePlaylistList`）。加入成功后 `usePlaylistAdd.addTo` 只做了两件事：

```js
markJoined(p.id)                    // 会话级 Set
hit.joined = true                   // 只改 joined
```

**count 从头到尾没人碰**。清单只有在 `load()`（菜单打开时）里重拉一次才会变，
所以现象正好是用户截的那张图：「已加入 ✓」已经上了，数字还是 0，重开菜单才变 1。

## 2. 修法

### 2.1 计数乐观更新（两段）

| 时机 | 动作 | 幂等命中 | 失败 |
| --- | --- | --- | --- |
| 点下去（同步，不等网络） | 目标行 `count += 目标条数`，`joined = true` | 该行已是「已加入」→ 预测 +0 | — |
| 响应回来 | 用真实新增数**校正**：`before.count + countAdded(outcome)` | added=false → +0 | — |
| 出错 | 计数与 joined **一起回滚**到点击前快照 | — | toast 走既有分级文案 |

移出：成功 `count -= 实际移出条数`（`shiftCount` 夹到 ≥ 0）、`joined=false`；
失败把已删掉的算进去、其余回滚。
新建并加入：`load()` 之后新行 `count = max(服务端值, 本次实际加入数)`（服务端若还没算进这次追加，也不会显示 0 个）。

算术全部下沉到 `playlistWrite.js` 的纯函数（无 Vue / 无 DOM / 无网络）：
`shiftCount / countText / patchPlaylistRow / restorePlaylistRow`，
`patchPlaylistRow` **一次只动一行** → 同一视频加到多个列表时每个列表各自 +1，互不影响。

### 2.2 一致性兜底（一次 GET 校准，不轮询）

`SETTLE_DELAY_MS = 1200`：每次成功的写只排**一次** `settle()` —— 静默
`GET /api/media/playlists`，整表按服务端值替换（差异以服务端为准）。
不显示 loading、不清空清单、不改 unavailable；失败静默忽略。
菜单关掉再打开仍是原来的 `load()`（服务端为准）；`reset()` 会取消未执行的校准。

### 2.3 实测中发现并修掉的竞态（不修就还是会「跳回旧数字」）

两个快照请求会盖掉刚上屏的乐观值：

1. `settle()` 的 GET 在途时又发生写 → 它带回的是旧快照；
2. **`load()` 的 GET 在途时用户就点了加入**（打开菜单后 32ms 内点击，实测就命中了）→ 旧清单直接覆盖。

修法：一个 `writeSeq` 代次。任何写 +1；`load()` / `settle()` 在请求发出时记下代次，
回来时代次变了就**丢弃这次快照**（本次写自己排的校准随后对齐）。

证据（MutationObserver 逐次记录 `.pl-count` 文本，dt 相对点击）：
修前 `[10 个 → 11 个 @5ms → 10 个 @9ms]`（4ms 就被旧 load 快照盖回去），
修后该窗口稳定停在「11 个」，直到注入的 403 才回滚。

### 2.4 文案与布局

- 计数文案统一走 `countText()`：`0 个 / N 个`（缺值也写「0 个」，不出 `undefined 个`）。
- `.pl-count` / `.pp-count`：`font-variant-numeric: tabular-nums` + `min-width: 3.2em` +
  `text-align: right` + `white-space: nowrap`；`.pl-joined` 也 `nowrap`。
  菜单宽度由 `computeMenuPosition` 固定，数字位数变化不再撑宽，也不会和「已加入 ✓」挤在一起。

## 3. 真浏览器实测（55 项全过，连跑 3 次稳定）

```
== A. 点加入：POST 挂住（响应未回），计数必须已经 0 → 1
  PASS A1 DOM 计数 0 个 → 1 个  — {"text":"1 个","frames":0,"gets":1,"joined":"已加入 ✓"}
  PASS A2 同一帧或下一帧内就变了（不等网络、不重开菜单）  — frames=0
  PASS A3 变化时清单 GET 次数没变（没有重拉清单）  — gets=1 start=1
  PASS A4 这一刻 POST /videos 还挂在 Fetch 上（响应确实还没回来）
  PASS A5 「已加入 ✓」与计数在同一帧到位
  PASS A6 响应回来后按真实新增数校正，仍是 1 个
  PASS A7 采样历史：0 个 → 1 个(+✓)，只有一次变化、没有回落
  PASS A8 后端条目数 +1（乐观值与服务端一致）  — 0 -> 1
```

数字时序（250ms 逐帧采样，`dt` 相对点击时刻）：

| 场景 | 采样到的文本序列 | 结论 |
| --- | --- | --- |
| a) 加入（POST 挂住 600ms） | `0 个 @0ms → 1 个(+✓) @6~18ms`，之后 4s 内 241 帧稳定 `1 个` | 响应还没回来数字就变了，且不回落 |
| b) 幂等重复加入 | 全程只有 `1 个(+✓)`（93 帧） + toast「…无需重复加入」 | +0 |
| c) 移出（removeFrom 真代码 + 真后端） | `items: 1 → 0`、joined `true→false`、另一列表仍 1 | -1 |
| c') 播放列表页移出（真 UI） | 页面计数 `1 → 0`，DB 同步 | 移出一路没被改坏 |
| d) 403 | `10 个 @0ms → 11 个(+✓) @2~5ms → 10 个(无 ✓) @16~22ms` | 乐观值先上屏，失败整行回滚 |
| e) 校准不一致 | 服务端打桩 `count=7`，1.2s 后行文本 `1 个 → 7 个`；撤桩再校准 `7 个 → 1 个` | 差异以服务端为准，只 GET 一次（+1，无轮询） |
| f) 多列表 | 点第二个列表：该行 `0 → 1`，第一个列表仍 `1 个` | 每行独立 |

失败 toast（原文，分级文案未变）：
`加入播放列表失败：当前编辑策略禁止写入（403）：当前为演示/本地模式，站端不允许写入（管理员可在媒体库「编辑策略」中改为完全编辑）`

窄屏（375×780，计数 12 个 + 已加入 ✓ 同时在场）：
`rowW=242, overflow=0, countRight=200 ≤ joinedLeft=206, fontVariantNumeric=tabular-nums`（截图 `07-narrow-375.png`）。

## 4. 单测（`node scripts/playlist-count.test.mjs`）

`PASS 43/43 (playlist optimistic count)` —— 覆盖：
add 成功 +N / 批量 +N / 幂等 +0 / 移出 -1 / 移出不减到负数 / 缺值与非数字兜底 /
只动目标行（多列表互不影响）/ 不可变（原数组不被改）/ 失败回滚（count 与 joined 一起）/
回滚保留原「已加入 ✓」/ 文案 0 个 与 N 个 / `countAdded` 三种响应口径。

既有单测 `scripts/ctrl-autohide.test.mjs`：`PASS 78/78`（未调整任何断言）。

## 5. 既有 harness 回归

`node devtools/p541-ui/run.mjs p544-regress` → **通过 17 项，失败 0 项**（真后端 8080）。
加入/幂等「无需重复加入」/403·401·404 分级/播放列表页数量/收尾条数全部不变 —— 旧断言**零调整**。

`vite build` → `✓ built in 4.99s`，0 error。

## 6. 已知限制

1. `usePlaylistAdd.removeFrom` 目前没有 UI 入口（P5.26 撤掉了信息栏的播放列表分区），
   所以「移出 -1」的浏览器证据是：真代码 + 真后端驱动（F 组）+ 纯函数单测（T23–T26）；
   播放列表页自己的移出另有实测（G 组），但与 `removeFrom` 不是同一条代码。
2. 乐观预测对「批量里有一部分早就加过」的请求会先按目标条数 +N，响应回来立刻校正为真实新增数
   （约 1 个往返内，肉眼一般只看到最终值）。
3. 校准是「整表替换」：若同一时刻有另一个设备在改同一批列表，最多 1.2s 后以服务端为准收敛。
4. 校准只排一次；如果那次 GET 恰好在写期间发出，它会主动让位（不覆盖），
   由那次写自己排的校准兜底 —— 极端情况下（连续多次写且每次都在 1.2s 内）最后一次必定校准。
