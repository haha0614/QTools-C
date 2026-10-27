# P5.90 · 人物卡背景「服务端预渲染成一张图」

用户口径：「在我编辑后把我所选的区域裁下来作为一个文件或缓存，然后每次加载就直接加载这个图片就行了，不用每次都计算了」。

改造前：每张卡 3 个 img（清晰 / 模糊 / 雾）+ 前端 layoutCrop + applyAdjust 现算几何写 CSS 变量 + mask 合成。
改造后：每张卡 1 个 img，指向 `GET /api/media/person/{id}/card-bg`，服务端把几何、模糊、渐变、拾色底、柔光
全部烘进一张 JPEG，前端只拼 URL。

---

## 1 端点与缓存键

```
GET /api/media/person/{id}/card-bg?w=666&h=204&s=1&dx=0&dy=0&blur=6&d=0&bg=ffffff&v=<头像版本>
```

| 参数 | 语义 | 校验 |
| --- | --- | --- |
| w / h | 输出像素（= .pw-bg 的 clientWidth/Height × DPR，前端取偶） | 缺省 666×204；1–2000 之外 400；超过 1200×600 按比例缩（不报错） |
| s / dx / dy | 背景缩放与偏移（P5.88 口径；dx/dy 是卡片宽高比例） | 缺省用人物已保存的 bg_scale/bg_dx/bg_dy；传了就以请求为准；夹到 0.5–3 / ±2 |
| blur | 模糊半径 0–20（滑块） | 越界夹取 |
| d | 1 = 暗色主题（柔光往 #0b0d10 混） | — |
| bg | 卡片底色 --bg-2（RRGGBB），拾色混合的目标色 | 脏值 → ffffff |
| v | 头像版本（前端按 avatar.ref 算的短哈希），只用于「换头像 = 换 URL」 | 不参与渲染 |

为什么 s/dx/dy 还要前端带：模糊滑块是全局 UI 偏好（localStorage），亮暗与 --bg-2 决定柔光，普通用户的调整只在
本机 localStorage —— 后端都读不到。后端只在参数缺省时回落到库里的 bg_scale/bg_dx/bg_dy，两条口径互不冲突
（站长保存后前端拿到的就是服务端值，URL 里带的就是同一份）。

缓存文件：`<thumbs>/cardbg/<personId>-<w>x<h>-<paramsHash>.jpg`

```
paramsHash = sha1(
  "v<RENDER_VERSION>|" + personId +
  "|" + 原图标识（photo：绝对路径+size+mtime；frame：videoId+秒+字节数）+
  "|" + w + "x" + h +
  "|" + "%.3f,%.4f,%.4f"(scale,dx,dy) + "|b" + blur + "|d" + dark + "|" + bg +
  "|f0.78|" + avatar_ref
)[:20]
```

* 内容是**内容寻址**的：任何输入（含原图 mtime、渲染版本）变化 → 换文件名，旧文件不会被误用；
  文件名不变 = 字节不变 → 响应给 Cache-Control: public, max-age=31536000, immutable。
* RENDER_VERSION 是唯一的版本阀门：改渲染管线必须 +1（本次开发中就靠它作废了第一版有 bug 的缓存）。
* 清理：命中时若 mtime 超过 1 天会 touch 一次，因此「30 天未访问」= 真的没人看；清理在渲染后顺带跑
  （6 小时最多一次），不需要外部定时任务，也不需要人工 --gc。
* 并发：同一 key 的并发未命中会各渲染一次，写临时文件 + ATOMIC_MOVE，字节相同，不会出现半张图。
* 排障头：X-Card-Bg: HIT|MISS、X-Card-Bg-Key（内容哈希）、X-Card-Bg-Ms（服务端耗时）。

## 2 渲染管线（逐式复刻 P5.84–P5.88 的 CSS）

几何（与 personBgImage.layoutCrop + personBgAdjust.applyAdjust 完全同式）：

```
imgW = bgW × 0.44 / cropW ;  imgH = imgW × natH / natW
tx   = bgW × 0.76 − imgW × cx ;  ty = bgH × 0.50 − imgH × cy      (cx,cy = 裁剪中心)
imgW *= scale ; imgH *= scale ; tx += dx × bgW ; ty += dy × bgH
```

合成顺序（自下而上，与 DOM 一致）：

1. 卡片底色 --pw-tone：原图 8×8 降采样均值 → 按主题亮度约束二分混到 --bg-2（personTone.toneFill 镜像，
   18 次二分，误差 < 1/255）；
2. .pw-glow：145%×165% @ (0%,50%) 的径向光晕，26% 实心 → 70% 透明，整体 opacity .35，色 =
   color-mix(tone 70%, #fff)（暗色 #0b0d10）；
3. 清晰层：原图按几何摆放，mask = 图片自身左缘渐显（0% → .45 @9% → 1 @20%）；
4. 模糊层：同一张图 高斯 σ = 半径（CSS blur 的 std-dev 语义）+ saturate(1.1) + brightness(.9)，
   mask = min(横向停靠点 0/.18/.34/.50/.64/.78 → 1/.92/.62/.30/.08/0, 图片左缘渐显)；
5. 雾层：同一张图 blur(半径 × 2.6)，mask = min(横向 0% 实 → 52% 透明, 图片左缘渐显)。

**mask 坐标系是相对图片元素盒子（imgW × imgH），不是卡片** —— CSS 的 mask-size: 100% 100% 就是这样定义的，
写错就会「右边也糊」。这是复刻里最容易踩的坑，已按元素盒实现。

模糊实现：预乘浮点 + 可分离高斯（对 TYPE_INT_ARGB 用 ConvolveOp 会在边缘渗黑边）；σ > 6 时先按整数因子
降采样再模糊、最后双线性放大（视觉等价，首个请求从 ~300ms 降到 ~70–200ms）。JPEG 质量 0.82。

合成公式：mask 是不透明度，必须同乘到**颜色**上（layer 通道已按自身 alpha 预乘）；只乘 alpha 会让 55% 的层
贡献 100% 的颜色 → 整张图发白过曝。第一版就是这里错，渲染出「左侧一片死白 + 右侧硬竖边」，已修。

## 3 实测（本机，w=666 h=204 = 333×102 CSS @2x）

| 人物 | 头像来源 | 首次生成（X-Card-Bg-Ms / HTTP） | 缓存命中（X-Card-Bg-Ms / HTTP） | 文件 | 字节 |
| --- | --- | --- | --- | --- | --- |
| 125 素人 | photo a159:0（400×712） | 205ms / 210ms | 3–20ms / 21ms | cardbg/125-666x204-04d9ef744baf2fcb3525.jpg | 9089 |
| 122 娜娜 | frame 485470e2cc08 t=93（480×270） | 74ms / 77ms | 3–13ms / 11ms | cardbg/122-666x204-6025f47d13d40bf49648.jpg | 7999 |
| 124 深田咏美 | frame 046839cff1cd t=1472 | 71ms / 74ms | 3–12ms / 10ms | cardbg/124-666x204-26077fa4ab12aaef8861.jpg | 9384 |

* 命中 < 30ms 的目标达成（服务端 3–20ms，剩下的是一次环回的固定开销）。
* 三个人物都**没有** bg_scale/bg_dx/bg_dy（自动几何）→「参数未设置也能出图」得到验证。
* 删掉 data/media/thumbs/cardbg/ 再请求：重新生成且字节一致（同参数），随后又命中。

像素抽样（左 10–35% vs 右 62–95% 的边缘能量，FIND_EDGES 均值）：

| 文件 | 左 | 右 | 左/右 | 相邻列均值最大跳变 |
| --- | --- | --- | --- | --- |
| cbg-125 | 2.12 | 5.17 | 0.41 | 9.61 |
| cbg-122 | 2.39 | 3.66 | 0.65 | 4.35 |
| cbg-124 | 2.41 | 3.73 | 0.65 | 3.25 |

→ 左侧明显更「平」（糊），右侧细节多（清晰）；相邻列最大跳变 < 10 灰度级，说明没有硬竖边。

与改造前的视觉对照（同卡同位置，1600 宽亮色）：

| 卡片 | 平均绝对差（每通道） | p90 最大通道差 |
| --- | --- | --- |
| 125 | 4.94 | 11 |
| 122 | 3.82 | 10 |
| 124 | 2.33 | 9 |
| 123 | 2.72 | 9 |
| 119 | 4.85 | 11 |
| 115 | 6.13 | 11 |

差异来自「服务端高斯 vs 浏览器 blur 实现」「8×8 采样滤波的细微差别」「332 vs 333 的 1px 重采样」，肉眼不可分辨。

## 4 前端接线

PersonsPage.vue：

* 每张卡（有 id + 有背景来源）只挂一个 img.pw-bg-card，src 由 personCardBg.cardBgUrl() 拼；
  卡片上**不再写 --pw-img-***（data-bg-geom 为空），也没有 transform / mask / filter。
* 尺寸：.pw-bg 的 clientWidth/Height × min(2, DPR)，取偶并夹到 1200×600；布局稳定 200ms 后才量
  （早量会多出「84 → 103.7 撑高」的第二个尺寸 = 每张卡多一次白请求；实测 12 张卡 33 个请求 → 12 个）。
  尺寸变化（ResizeObserver）防抖 200ms 换 URL。
* 兜底：端点 404/500、或该人物没有可预渲染的头像来源 → cardBgFailed[key]，这一张卡退回 P5.84 三层；
  换头像 / 服务端回包会清掉失败标记重试。
* 模糊滑块：bgBlur（已烘进图里，进 URL）与 bgBlurInput（滑块此刻的值）分开 ——
  拖动期只改 CSS 近似 filter: blur(max(0, preview-committed))（只能加不能减），
  松手 / 300ms 无输入才提交成新 URL（实测 12 → 换图 1.7s 内到位，含 300ms 防抖 + 服务端渲染）。
* 「⛶」弹层：预览仍用 P5.84 三层（组件未改）；预渲染后卡片里没有原图可读 naturalWidth，
  弹层打开时用临时 new Image() 量一次自然尺寸（与头像同源，命中 HTTP 缓存）。
  保存后 URL 里的 s/dx/dy 立即变 → 新 hash → 新图。
* 主题：html.dark 与 --bg-2 都进 URL（d / bg），切主题 = 一次新渲染（每张卡最多两份缓存）。

## 5 构建与测试

* mvn -o -q -DskipTests compile：exit 0。
* vite build：0 error（✓ built）。
* 单测：personBgAdjust 68/68、personBgBlur 38/38、personBgImage 15/15、personCardBg 39/39（新增）、
  personTone 45/45、personWall 136/136。
* 真浏览器 devtools/p590-ui/run.mjs：30/30 PASS（改造前的对照截图见 out/before，由 capture.mjs 采集）：
  a1–a8 单图形态（**每张有背景的卡恰好 1 个 card-bg 请求、0 个三层 img、没有 --pw-img-* 几何**，实测 12–13 张）；
  g1–g3 亮暗与 375；c1–c6 弹层保存换 URL 且新图加载；d1–d6 滑块近似与换图；
  e1–e3 命中平均 1.7–3.1ms vs 冷渲染 32.6–125.3ms；f1–f4 打桩 500 → 全部卡退回三层且兜底图加载成功、无 console 错误。
  注意：P5.78 的访客可见性会把主库对未登录访客整个 404（连头像都没有），harness 会在这种状态下直接提示并退出，
  而不是报一堆「渲染管线坏了」的假失败。
* 既有 devtools/p588-ui/run.mjs（P5.88 交互回归）：46/46 PASS，另有 28 条几何断言按名字 SKIP。
  为让它在新形态下跑通，改了这些地方：
  1. cardProbeExpr 增加 mode: 'card' 分支（读 .pw-bg-card，sharp/blur/fog 三个 rect 指向同一个 img）；
  2. READY 判据改成「三层已解码 或 服务端单图已解码」；
  3. ok() 增加 SUPERSEDED 规则：单图模式下按名字跳过 28 条几何断言（三层 rect 一致 / imgW / tx/ty /
     --pw-img / 裁剪中心 76%·50% / 100% 预览尺寸 等），弹层、保存、localStorage、等高、chip、375、暗色照旧断言；
  4. blurFilter 在单图模式下改为读 URL 的 blur 参数；reduced-motion 与 J 段改为兼容两种 DOM。
  被跳过的断言明细：A7 A9 A10 B3 C1×3 C2×3 C3×3 D2 D3 D4 D5 D6 D7 D9 E3 E4 E5 F4 F5 F8 I6
  —— 它们量的都是「前端算出来的几何 / 三层 rect」，P5.90 之后这些量已不在 DOM 里（改由服务端负责），
  对应等价断言在 p590-ui 的 a2/a4/a8（1 个 img、无几何变量、自然尺寸 = URL 的 w）与 c5/c6（URL 参数 = 调整值）。

## 6 已知限制

* DPR 上限 2：3x 屏按 2x 出图（再多只是让缓存文件翻倍）。
* 尺寸上限 1200×600：再大按比例缩；超出 2000 直接 400（不静默夹取）。
* 头像来源只支持 photo（相册缩略图）与 frame（视频取帧）：url 档是外部地址（服务端不去抓，SSRF 面），
  只有 avatar_path 的人物同理 —— 这两类由前端三层兜底，行为与改造前一致。
* 取帧依赖 ffmpeg：首次取某一秒要解码（可能 503），此时前端回落三层；取过之后就命中 frames 缓存。
* 缓存文件随尺寸增长：每个「卡片尺寸 × 主题 × 参数」一份；30 天没人访问自动清。
* 主题是烘进图里的：亮暗各一份（同一张卡最多两份），不存在「一份图两套主题」。
* 服务端与浏览器的模糊/采样实现不同：肉眼不可分辨，但不是逐像素等同（对照数据见第 3 节）。
* 并发首次生成：同一 URL 的并发未命中会各渲染一次（结果字节相同）。

## 7 部署注意（重要）

1. **P5.89 的 DDL 必须先执行**：本仓库 qtools-media 的 selectPersonDetail 已经选
   bg_scale / bg_dx / bg_dy 三列，而本机 qtools 库里原本**没有**这三列（P5.89 后端代码在 16:13 落地，
   DDL 没跑过）。我为了跑通实测执行了 QTools/doc/media_person_bg.sql（幂等）；部署时同样必须先跑，
   否则 /api/media/persons、/person/{id} 会直接 500。
2. **访客可见性**：新端点已接入 P5.78 的未登录拦截（IMediaGuestAccessService.isBlocked 新增
   /media/person/{id}/card-bg → 按头像所属根判定）。本机 media_root.id=1 主库 目前
   guest_visible=0，所以未登录访客拿不到任何图片（含 card-bg，与 /thumb、/frame 同口径）。
   这一点改造前就存在（8080 也是 404）；实测期间我临时把它置 1 以便截图，**已恢复为 0**。
3. 缓存目录 data/media/thumbs/cardbg/ 可随时删除，下次请求自动重建。

## 8 改动文件

后端（新增）：
* qtools-media/.../support/MediaPersonCardBg.java（几何 / 模糊 / 渐变 / 拾色 / JPEG）
* qtools-media/.../service/IMediaPersonCardBgService.java
* qtools-media/.../service/impl/MediaPersonCardBgServiceImpl.java（来源解析 / 缓存 / GC）
* qtools-media/.../controller/MediaPersonCardBgController.java（端点 / 参数校验 / 缓存头）

后端（改动）：
* mapper/MediaGuestMapper.java + mapper/media/MediaGuestMapper.xml：selectAvatarOfPerson
* service/impl/MediaGuestAccessServiceImpl.java：personBgBlocked（新端点的访客可见性）

前端（新增）：
* src/views/media/personCardBg.js + personCardBg.test.mjs
* devtools/p590-ui/{capture.mjs,run.mjs,out/}

前端（改动）：
* src/views/media/PersonsPage.vue（单图接线 / 尺寸测量 / 兜底 / 滑块 / 主题 / CSS）
* devtools/p588-ui/run.mjs（探针与 READY 兼容两种形态、28 条几何断言 SKIP）
