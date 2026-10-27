<!--
  PersonsPage.vue —— 媒体站「人物」墙（P3-B / P5.45 加厚卡片）
  路由：/media/persons（在侧栏「媒体」分组下，与视频库 / 图片站并列）
  数据：GET /api/media/persons —— 站端匿名读，silent；后端未部署（404）时整页退化为
         「人物数据暂不可用」提示，不抛未捕获异常、不弹全局错误。
  三态：loading / unavailable（接口未就绪或其它错误）/ empty / ready，状态挂在根节点的
         data-state 上，便于测试与前端断言（也方便排查线上到底是哪种状态）。
  主题：容器 .media-scope + mediaTheme.scss（局部模式）—— 颜色只用 --bg/--fg/--line/--accent，
         亮 / 暗跟随 html.dark，栅格在 ≤768px 收成两列。

  P5.45（用户需求 3）：卡片从「首字母 + 名字」升级为「头像 + 名字（别名）+ 数量 + 资料 chip + 最近更新」。
  三份数据源，**全部走既有接口**（本轮没有为人物墙新增后端读接口）：
    1. GET /api/media/persons       —— 字典（id / name / alias / useCount），决定有哪些卡片；
    2. GET /api/media/index         —— 纯前端聚合：albums[].persons / albums[].count 算「本相册 + 张照片」，
                                       videos[].persons 算「部视频」，albums[].cover / people[].cover 算头像，
                                       people[].mtime（P5.45 后端新增字段）算「最近更新」；
    3. GET /api/media/person/{id}   —— 单人详情：avatarPath（显式头像）+ P5-A 的 14 个资料字段 + 计数兜底。
       15 位人物 → 15 个并发上限 6 的小请求，任一失败只少一块信息、不报错（catch 里什么都不做）。
  拼装规则（谁优先 / 怎么降级 / chip 取哪 3 个 / 日期怎么格式化）唯一实现在 personWall.js，
  单测见 personWall.test.mjs —— 页面这里只发请求与渲染。
  头像四级优先：avatarPath → 名下第一个相册的封面（/api/media/thumb/p/<albumId>/0000）→
                名下第一个视频的**内容帧**（/api/media/frame/<videoId>?t=<时长×0.3 的整秒>&w=400）→
                首字彩色圆底占位（加载失败同样回落）。P5.60：取帧这一档走 IntersectionObserver 懒加载，
                屏外卡片一个 ffmpeg 请求都不发；img onerror 静默退回首字（见 observeFrameCards）。
  布局：网格 minmax(280px, 1fr) + grid-auto-rows: 1fr —— 整面墙等高；数量行单行不折，
        chip 区可换行不裁切；没有数量的卡片不渲染那一行（不留空洞）。
  埋点：沿用 useMediaTrack 的 pageView / dwell（与视频库、图片站同一套 page_view 口径）。

  P5.48：头像支持**手动指定**。卡片头像 hover 出现小「换」按钮 → PersonAvatarDialog 两 tab
         （从相册挑选 / 图片地址）→ PUT /api/media/person/{id}/avatar；「恢复自动头像」→ DELETE。
         保存走**乐观更新**：先改本地详情（卡片立刻变），失败用保存前的快照回滚并 toast。
         头像优先级变成：手动 avatarUrl（后端解析）→ 历史 avatarPath → 相册首图 → 视频内容帧 → 首字占位，
         拼装规则仍然只在 personWall.js 一处。
         入口只在编辑策略 full 档渲染（off / local 档连「换」按钮都不出现）。

  P5.60（用户反馈 1 + 3）：
    · 卡片「加宽」而不是「加高」：列宽 200 → 280，卡片回紧凑（min-height 108 → 84），
      数量行改单行 nowrap（原来 -webkit-line-clamp: 2 就是用户说的「还是会折行」）；
      ≤430px 收成单列，窄屏数量行也不会被省略号切。
    · 「未归类」不再出现在人物墙：它是**相册归档容器**（名下 a158 images / a159 写真），不是人。
      判定在 personWall.isPlaceholderPerson（后端 isPlaceholder 优先，老后端按名字 + note 兜底）。
    · 「素人」**保留**：它是无演员视频的兜底人物（MediaPersonServiceImpl.AMATEUR_NAME），有业务含义，
      note 补了一句说明（见 QTools/doc/p560_person_placeholder_cleanup.sql）。
    · 「E2E演员」是端到端测试造的空壳人物（无相册 / 无视频 / 无引用），按测试残留从库里删除，
      备份见 QTools/doc/backup/media_person_before_p560_*.sql。

  P5.67（用户需求）：「卡片背景也用头像，展示面积比头像大」—— 卡片内两层：
    · .pw-bg  同一张头像（**同一个 URL**，浏览器只下载一次）铺满卡片，object-fit: cover、
      object-position: center 25%（偏上，尽量露出人脸）、blur(6px) saturate(1.1) brightness(.9)（P5.69 取整）。
      四周再外扩 9px（inset: -9px，= 模糊半径 6px 的 1.5 倍）——高斯模糊会从图片边缘往里渗，图若正好
      压着卡片边，模糊后边上会透出底色；外扩后模糊只吃图片自身像素，卡片内看不到「模糊边缘发白」。
    · .pw-mask 遮罩（亮色白 / 暗色黑，左强右弱），保证文字压在照片上仍可读。
    可读性口径：背景是照片 → 数量行 / 最近更新 / 别名在 has-bg 卡片上从 --fg-dim 提到 --fg
    （--fg-dim 压在照片上最坏只有 2.5–3.9:1，提色后实测最差 5.33:1，见 devtools/p567-ui/REPORT.md）。
    背景与头像用**同一个 URL**，浏览器把两个 img 合并成同一次请求（实测 26 个 img → 后端只收到 13 次）；
    姓名此前继承 .media-scope a 的强调蓝 #409eff（压在卡片上 2.78:1），本轮显式改回 --fg（12.6:1）。
    首字占位 / 头像失败 / 背景自身 onerror 一律不渲染背景层（保持纯色卡片，不出空背景或碎图）。

  P5.69（用户反馈）：「人物卡片背景的模糊度是不是过高了，淡一点」——P5.67 的 blur(12px) 把整张脸糊成
  一团色块，视觉上压过了卡片主体。两个方向一起收：
    · 模糊 12px → 6px（外扩随之为模糊半径的 1.5 倍：16px → 9px），轮廓可辨，不再是色块；
    · 整层 .pw-bg 降不透明度到 .7，背景退成「隐约的人像氛围」，不再抢主体。
  遮罩没动（左侧 .93/.9、右侧 .62/.66 原值保留）：降不透明度本身就让亮暗两侧的底都往卡片底色
  --bg-2 收，对文字对比度是纯加分项；而加厚遮罩会把「看得出人像」再压回去。所以可读性靠实测复核，
  不靠遮罩补。实测三档 × 亮暗最差值见 devtools/p567-ui/out/p569/run.log（同一套像素采样口径）。

  P5.72（用户需求）：「背景模糊度还是太高了，在页面中加一个滑块自己调」——工具栏右侧加一个紧凑滑块
  （标签「背景模糊」+ range 0–20px 步长 1 + 当前值小字），与搜索 / 刷新同一行，≤640px 只留滑块与数值。
    · **实时生效**：滑块写根节点的 CSS 变量 --pw-bg-blur（半径）与 --pw-mask-l1/l2 / -d1/d2（遮罩），
      .pw-bg img 的 filter 与**外扩量**都读它：inset = -1.5 × 半径、尺寸 = 100% + 3 × 半径 ——
      任意半径下模糊只吃图片自身像素，卡片边不露底色；0px 时外扩为 0，正好等于卡片尺寸。
    · **持久化**：localStorage 键 ms.person.bgBlur，默认 6（= P5.69 的线上值）。
    · 值域 / 联动 / 持久化的唯一实现在 personBgBlur.js（单测 personBgBlur.test.mjs），页面只挂变量与写回。
    · 无头像的卡片本来就没有 .pw-bg 层，滑块不影响它们。

  P5.75（用户反馈：「拉到 0 了但是还是看不清背景」）—— P5.72 的补偿方向错了：
  （P5.76 复盘：这一段连同 P5.67/P5.69 的「横向遮罩 + 半透明垫底 + 整层不透明度」三层补偿，
   在 P5.76 全部删除 —— 背景图不再 cover 铺满，遮罩与垫底失去存在理由，见下面 P5.76 那一段。）
  它在 0px 时把**整块**遮罩加厚到 亮 .96/.94/.78、暗 .95/.92/.86，对比度确实保住了，但照片被整片
  压成灰白，0px 想说「看清照片」反而什么都看不见。文字只占卡片**左侧**（头像 + 姓名 + 数量 + chips），
  右侧没有文字，没有理由一起压。于是遮罩从「整体加厚」改成「**横向分区**」：
    · 0–45%   左区（文字区）恒定高压暗 亮 .94 / 暗 .92 —— 与半径无关（文字对比度不随拖动变）；
    · 45–62%  过渡带（线性）—— 由文字块下面那层半透明垫底兜底；
    · 62–100% 右区（纯图片）几乎透明 亮 .10→.20 / 暗 .15→.25，照片真正露出来。
  右区随滑块联动（t = n/20）：半径越小 = 越想看清照片 → 越透（0px 取 .10/.15）；半径越大照片本来
  就被糊开，右区回到 .20/.25。左区不参与联动。
  另一半是整层不透明度：.pw-bg 的 opacity（P5.69 的 .7 = 只留 70% 照片，剩下 30% 是卡片底色）
  也跟滑块走 —— 0px 到 1（照片原样），6px 起仍是 .7（默认档不变）。只松遮罩不松不透明度，0 档
  照片依旧是「洗白」的，所以两层一起联动。
  **文字兜底**：文字块（.pw-body）在 has-bg 卡片上垫一层 65% 卡片底色的半透明板（+ 极轻 text-shadow），
  宽度只按最宽的一行收缩（flex: 0 1 auto），照片在垫底后面还能透出约三分之一；
  实测最差 三档 × 亮暗全部 ≥6:1（像素采样口径同 p567/p572，见 devtools/p575-ui/REPORT.md）。
  保留：滑块 0–20、外扩联动、hover scale、无头像卡不出背景、@supports 回退（回退档整块回到厚遮罩）。

  P5.76（用户反馈三条）：「文字下面还有遮罩，去掉」「左侧遮罩太深了，而且过渡不自然」
  「背景图像的位置大小不对，头像没有在背景中完整展示…卡片右侧是空着的」——
  根因不是遮罩该调轻还是调重，而是**定位方式错了**：object-fit: cover 把竖图裁成一条横带，
  人像只剩中段被放大铺满整卡；文字没有一处落在纯底色上，于是只能靠遮罩 + 垫底去救。P5.76 换定位：
    · .pw-bg img：height: 100% + width: 32%（固定盒）+ right: 0（object-fit: contain，object-position: right center）
      —— **按卡片高度等比缩放、右对齐**。人像完整不裁，卡片右半部就是整张头像；左侧空出来的部分是
      卡片底色 --bg-2（不拉伸、不变形）。外扩（P5.72 的 inset = -1.5 × 半径、尺寸 +3 × 半径）随之删除：
      图片不再被裁，「被裁的边缘」不需要兜底；模糊在最外圈 ≤ 半径的像素上自然变淡，
      与左侧淡出是同一种观感（0 档无外扩、无模糊，正好等于卡片内高）。
    · 左侧渐隐：图片自己的 mask-image = linear-gradient(to right, transparent 0%,
      rgba(0,0,0,.35) 18%, #000 45%)，亮暗同款（淡出不是压暗，与主题无关）。渐变按**图片自身宽度**
      算百分比 —— 不论卡片多宽、图片什么比例，淡出段永远是图片宽度的 0–45%，右缘永远全不透明。
    · .pw-mask 整块删除（元素 + CSS + 亮暗 4 个 alpha 变量）；--pw-bg-opacity / bgOpacity 一并删除：
      照片以原亮度呈现（P5.69 的 .7 = 只留七成照片，与「看清照片」直接冲突）。
    · 文字可读性改由文字自己承担：has-bg 卡片的 姓名 / 数量 / 最近 / chip 加 text-shadow
      （亮 0 1px 2px rgba(255,255,255,.85) / 暗 0 1px 3px rgba(0,0,0,.75)），文字块**没有任何底色**。
    · 保留：滑块 0–20（0 档 = 清晰完整人像 + 左侧淡出）、hover scale、无头像卡不出背景层、亮暗主题、
      窄屏单列、@supports 回退（不支持 filter 时文字块退一层 88% 垫底，只有老内核才走得到）。
    三档视口 × 亮暗 × 模糊 0/6 的截图与实测数据见 devtools/p576-ui/REPORT.md。

  P5.83（用户需求）：「人物卡片背景改为左文右图**分区**，彻底消除文字压图」——
  P5.67–P5.81 一直是「整卡背景图 + 文字压在上面」，于是反复调遮罩 / 拾色底 / 自适应字色，
  仍然治不了根：同一行文字一半压在照片上、一半压在底色上，实测对比度只有 1.0–1.6:1。
  这一版换**形态**，不再让文字压到图上：
    · 卡片是横向 flex：左侧 .pw-main（文字区，纯 --bg-2 底色）+ 右侧 .pw-bg（图片面板，
      flex: 0 0 40%，align-self: stretch 撑满卡片内高，border-left: 1px solid var(--line) 作边界，
      左缘 3px 圆角，右缘靠卡片的 overflow: hidden 贴住卡片右缘）。两者是**兄弟节点**，
      文字在结构上就不可能覆盖图片 —— 对比度由纯底色天然保证，不需要遮罩、不需要自适应字色。
    · 面板内是**原图**（去 crop 参数的 URL，P5.78 的 originalSrc），几何仍走 personBgImage.layoutCrop，
      只是容器从整卡换成面板：裁剪块中心落在**面板宽 76% / 面板高 50%**（实测 Δ = 0px）。
      倍率由 panelMagnify 算：**大到刚好盖满面板**（等价 object-fit: cover，四边零空条），
      下限仍是 P5.82 的 0.44。layoutCrop 的 tx/ty 按「中心钉在 76%/50%」反算、与倍率无关，
      所以「盖满」和「中心在 76%/50%」同时成立 —— 面板里不会出现半条空白。
    · 模糊滑块（0–20，键 ms.person.bgBlur）不变，但只作用于面板内的**单层图**：
      .pw-bg-img 的 filter: blur(var(--pw-bg-blur))。P5.80 的「清晰层 + 模糊层 + 横向 mask 渐变」
      双图作废（面板与文字区之间有实线边界，不再需要 mask 做过渡）。
    · 作废：.pw-mask / .pw-scrim / .needs-scrim::after / .has-tone 底色渐变 / [data-text-tone]
      自适应字色 / P5.81 sampleTextRegion 采样 / P5.77 拾色整条链路（personTone.js 文件保留不动，
      本页已无任何调用方）/ text-shadow 晕边 / @supports 垫底回退。
    · 文字色：姓名 --fg；数量 / chip / 最近 / 别名改用卡片局部变量 --pw-fg-2
      （= color-mix(--fg 78%, --fg-dim)），亮暗实测均 ≥10:1；.pw-recent 的 opacity .85 也一并去掉
      （半透明字会把对比度按透明度打折）。
    实测见 devtools/p583-ui/REPORT.md（13 张卡 × 三档视口 × 亮暗的对比度表 + 零重叠断言）。

  P5.84（用户需求）：「人物卡片背景恢复为**整卡背景图 + 左糊右清渐变**」——
  用户原话：「你老纠结文字可读性干什么，先按照我的意思做不行吗，如果看不清我自然会让你优化的」。
  对比度在本页**不再是设计约束**：只作为 INFO 记录（实测数值见 devtools/p584-ui/REPORT.md），
  不作验收门槛、不据此改设计。
    · 形态回到「整卡背景图 + 文字压在上面」：.pw-bg 是 inset: 0 的铺满层，里面**同一张原图两层**：
      底层清晰原图（.pw-bg-sharp）；上层同一张原图 blur(var(--pw-bg-blur)) saturate(1.1) brightness(.9)
      + mask-image: linear-gradient(to right, #000 0%, #000 45%, transparent var(--pw-blur-fade-end, 70%))
      （.pw-bg-blur）—— 左端糊、45% 起往右淡出模糊层，70% 之后只剩底层清晰图。
      两层同 src、同 transform（同一组 CSS 变量），rect 逐像素一致 —— 本版唯一的硬断言。
    · 几何沿用 personBgImage.layoutCrop（基准 = .pw-bg 的 padding-box）：imgW = bgW × 0.44 / cropW
      （**不为了盖满而放大**）、imgH = imgW × natH / natW、tx = bgW × 0.76 − imgW × cx、
      ty = bgH × 0.5 − imgH × cy。图片盖不满卡片的区域用**拾色底**（personTone 采样，P5.77 链路恢复）填充。
    · 文字：正常渲染在图片之上（avatar-wrap / body 都是 z-index: 2），颜色用默认主题色
      （--fg / --fg-dim），**不加 text-shadow、不加任何 scrim / 渐变层 / 垫底、不做自适应字色**。
    · 滑块 0–20（键 ms.person.bgBlur）不变，只改 --pw-bg-blur；渐变终点用 --pw-blur-fade-end（默认 70%）。
    · 作废（P5.83 的分区形态）：.pw-main 文字区、面板 flex: 0 0 40%、border-left 边界线、panelMagnify()、
      「文字 .right < 面板 .left」零重叠断言、P5.83 的 --pw-fg-2 提色。
    · 见下面的 P5.85。

  P5.85（用户需求）：「把过渡做成参考图那种柔和雾化渐变」——用户原话：「能不能把过渡做成类似于图二这种效果？」
  P5.84 的 45%→70% 单层线性 mask 斜率恒定、过渡区只有 25% 卡宽，视觉上是可辨认的斜切，不够雾。
    · mask 换成**缓动多停靠点**（smoothstep 手感，过渡区拉宽到 18%→78% 共 60% 卡宽）：
      #000 0% / .92 18% / .62 34% / .3 50% / .08 64% / transparent --pw-blur-fade-end（**默认 78%**，
      变量保留，声明在 .pw-card 上）。相邻停靠点 alpha 落差 0.08–0.3，没有斜率突变 → 看不出分界线。
    · **渐进模糊**（参考图的雾感来自「越往左越糊」，不是单档糊 + 一条 alpha 斜坡）：同一张原图三层 ——
      层 1 .pw-bg-sharp 清晰；层 2 .pw-bg-blur blur(半径) + 上述 mask；层 3 .pw-bg-fog
      blur(半径 × 2.6)、mask 只盖左半（#000 0% → transparent 52%）。三层同 src / 同 transform，
      rect 逐像素一致（本版唯一的硬断言，三层一起查）；同一 URL 浏览器只下一个请求。
    · **左侧柔光** .pw-glow：垫在拾色底之上、图片之下的一层极淡径向光晕，色 = 拾色色的亮化版
      color-mix(in srgb, var(--pw-tone) 70%, #fff)（暗色主题换成压暗版 #0b0d10），opacity 0.35 封顶。
      **没有**纯白 / 纯黑遮罩块，也不加字色补偿 / text-shadow。
    · **图片自身左缘渐显** --pw-img-fade（本轮实测才发现的真问题）：imgW = bgW × 0.44 / cropW 且**不放大**，
      所以 cropW > 0.44 时图片比卡片窄，它的左边界就是卡片内一条**硬直竖线**（卡 125 上在卡内 129px）——
      这条线在元素盒子内部，mask 停靠点再怎么缓动都碰不到它（P5.84 的截图里多条卡都能看到）。
      做法：每层先按**图片宽度**做一次 transparent 0% → .45 9% → #000 20% 的左缘渐显，
      模糊层 / 雾层再用 mask-composite: intersect 与自己那条停靠点渐变取交集 —— **停靠点数值一个字没改**。
      实测接缝处相邻像素最大跳变 1.98 / 255（旧版 6.15 / 255）。
    · 保留：滑块 0–20（--pw-bg-blur）、裁剪中心 76% / 50%（±1px）、不放大（imgW = bgW × 0.44 / cropW）、
      拾色填充、文字直接压图。对比度仍**只记录 INFO**，不作门槛。
    实测（三层 rect / mask computed / 三档滤镜 / 20 点色差表 / 接缝剖面 / 24 张截图）见 devtools/p585-ui/REPORT.md。
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useMediaApi } from '@/composables/useMediaApi'
import { useMediaTrack } from '@/composables/useMediaTrack'
// P5.45：卡片信息（头像 / 数量 / 资料 chip / 最近更新）的唯一实现在 personWall.js
import { buildCard, buildWallIndex, explicitAvatarUrl, isPlaceholderPerson, parseAvatarRef, personKey } from './personWall.js'
// P5.48：手动头像 —— 弹层 + 两个写接口 + 站端编辑策略闸门 + 页面级提示
import PersonAvatarDialog from './PersonAvatarDialog.vue'
import PageToast from './PageToast.vue'
import { usePageToast } from './usePageToast.js'
import { useMediaEditPolicy } from '@/composables/useMediaEditPolicy'
import { clearPersonAvatar, errorText, setPersonAvatar } from './video/personApi'
// P5.72：背景模糊度滑块 —— 值域 / 遮罩联动 / 持久化的唯一实现（单测 personBgBlur.test.mjs）
import { blurCssVars, clampBlur, readStoredBlur, saveStoredBlur } from './personBgBlur.js'
// P5.84：整卡原图（清晰层 + 模糊层）—— 裁剪块中心落在整卡 76% / 50%，倍率固定 0.44（单测 personBgImage.test.mjs）
import { layoutCrop, originalSrc, parseCrop } from './personBgImage.js'
// P5.84：图片盖不满卡片的区域 = 从同一张图拾到的颜色（采样 / 缓存 / 落地色的唯一实现在 personTone.js）
import { parseColor, readToneCache, rgbCss, sampleTone, toneCacheKey, toneFill, writeToneCache } from './personTone.js'

const api = useMediaApi()
const tk = useMediaTrack()
const router = useRouter()
/** 站端编辑策略：只有 full 档才允许「换头像」（off / local 档入口不渲染，点了也不该发请求） */
const policy = useMediaEditPolicy()
const { toasts, push: showToast } = usePageToast()

const persons = ref([])
const loading = ref(true)
const errText = ref('')
const keyword = ref('')
/** 头像加载失败的人物（失败后退回首字母占位，不显示碎图）；键 = personWall 的卡片 key */
const avatarFailed = reactive({})
/** 索引统计（人名 → 数量 / 封面 / mtime）；索引取不到时为 null，卡片按详情兜底 */
const wallIndex = ref(null)
/** 单人详情（键 = 人物 id 字符串）：avatarPath / avatarKind+avatarRef+avatarUrl + 资料字段 + 计数兜底 */
const details = reactive({})
/** 换头像弹层（整页只有一个实例；卡片 hover 的「换」按钮负责打开并指定人物） */
const avatarDialog = reactive({ open: false, person: null, saving: false })

/**
 * URL 构造沿用 useMediaApi 的同名实现（与相册卡 / 视频卡封面完全同一套规则）。
 * P5.60：头像 ③ 档改成「视频内容帧」—— frameOf 给 /api/media/frame/{id}?t=<整秒>&w=400。
 * 整秒是关键：后端只对整秒落盘缓存，带小数每次都要真跑 ffmpeg。
 */
const URLS = { thumbOf: api.thumbUrlFromRel, frameOf: (id, sec) => api.frameUrl(id, sec, 400) }

/** 详情请求的并发上限：15 人也只开 6 条连接，避免和 1MB 索引抢带宽 */
const DETAIL_CONCURRENCY = 6

const NOT_READY = '人物数据暂不可用：后端人物接口（/media/persons）尚未就绪'

/** 接口可能返回裸数组 / {rows|list|items|data}，统一成数组 */
function normalizePersons(res) {
  if (Array.isArray(res)) return res
  const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
  if (Array.isArray(body)) return body
  const list = (body && (body.rows || body.list || body.items || body.data)) || []
  return Array.isArray(list) ? list : []
}

function toNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function sortPersons(list) {
  return list.slice().sort((a, b) => {
    const va = toNum(a && (a.videoCount != null ? a.videoCount : a.video_count))
    const vb = toNum(b && (b.videoCount != null ? b.videoCount : b.video_count))
    if (va !== vb) return vb - va
    const ua = toNum(a && a.useCount)
    const ub = toNum(b && b.useCount)
    if (ua !== ub) return ub - ua
    return String((a && a.name) || '').localeCompare(String((b && b.name) || ''), 'zh-Hans-CN')
  })
}

/**
 * P5.60：先剔掉**非真人占位实体**（「未归类」这类相册归档容器），再排序 / 过滤 / 渲染。
 * 判定只在 personWall.isPlaceholderPerson 一处（后端 isPlaceholder 优先，老后端按名字 + note 标记兜底），
 * 页面这里不做第二套规则；「素人」不是占位实体，照常展示。
 */
const visible = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  const list = sortPersons(persons.value.filter((p) => !isPlaceholderPerson(p)))
  if (!q) return list
  return list.filter((p) => {
    const name = String((p && p.name) || '').toLowerCase()
    const alias = String((p && (p.alias || p.aliases)) || '').toLowerCase()
    return name.indexOf(q) >= 0 || alias.indexOf(q) >= 0
  })
})

/** 根节点状态：loading > unavailable > empty > ready */
const uiState = computed(() => {
  if (loading.value) return 'loading'
  if (errText.value) return 'unavailable'
  if (!visible.value.length) return 'empty'
  return 'ready'
})

/** 一条卡片就是一次纯函数调用（索引统计 + 详情 + URL 构造），模板只做 v-for */
const cards = computed(() => {
  const map = wallIndex.value
  return visible.value.map((p) => {
    const key = personKey(p)
    const name = String((p && p.name) || '').trim()
    const stats = map && name ? map.get(name) : null
    const detail = details[String(p && p.id != null ? p.id : '')] || null
    return buildCard(p, { stats, detail, urls: URLS })
  })
})

/**
 * 头像 ③ 档（视频取帧）**懒加载**的开关表（键 = 卡片 key）。
 * 只有进入（或接近）视口的卡片才挂 src —— 取帧要真跑 ffmpeg，一屏几十张卡同时请求会把后端打满。
 */
const frameInView = reactive({})
let wallRef = ref(null)
let cardObserver = null

/** 给还没观察过的「取帧」卡片挂上 IntersectionObserver（进入视口才置 frameInView[key]） */
function observeFrameCards() {
  if (typeof IntersectionObserver === 'undefined') return
  if (!wallRef.value) return
  if (!cardObserver) {
    cardObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const key = entry.target.getAttribute('data-card-key') || ''
          if (key) frameInView[key] = true
          cardObserver.unobserve(entry.target)
        }
      },
      // 提前 120px 开始取帧：滚到卡片时图已经在路上，但**屏外**的卡片一张都不请求
      { rootMargin: '120px 0px' }
    )
  }
  wallRef.value.querySelectorAll('.pw-card[data-avatar="frame"]').forEach((node) => {
    cardObserver.observe(node)
  })
  ensureWallObserver()
}

/** 卡片头像该用的 src：取帧档在进入视口前返回空串（=> 先渲染首字占位，不占一张空白图） */
function avatarSrcOf(card) {
  if (!card || !card.avatar || !card.avatar.url) return ''
  if (card.avatar.kind !== 'frame') return card.avatar.url
  return frameInView[String(card.key)] ? card.avatar.url : ''
}

// 每次渲染后都重新挂观察（首屏 / 搜索 / 详情补齐 / 索引晚到都会重渲染）：
// 只观察「取帧」档的卡片，其它档本来就直接出图；onUpdated 比 watch(cards) 更稳，
// 不依赖「数据先到还是 DOM 先到」的时序。
onUpdated(() => observeFrameCards())
watch(cards, () => {
  nextTick(observeFrameCards)
  // P5.84：数据晚到 / 搜索过滤后，新出现的卡片也要排队拾色（已采过的命中 toneRaw，不重复）
  nextTick(() => queueTones(cards.value))
  // P5.84：详情晚到会让头像换一张 crop（背景 src 不变 → @load 不再触发），几何必须重算
  nextTick(refreshBgGeom)
})

function markAvatarFailed(card) {
  if (card && card.key) avatarFailed[String(card.key)] = true
}

/* --------------------------------------------------------- P5.67 卡片背景层 */

/** 背景图自己加载失败（头像可能是好的）：只摘背景层，不动头像 */
const bgFailed = reactive({})

/**
 * 卡片背景层的 src —— 与头像**同一个 URL、同一套可用性规则**：
 *   1. 首字占位（kind=initial，avatarSrcOf 返回空串）/ 头像加载失败 / 背景自己加载失败
 *      → 空串 = 不渲染背景层。用户口径「背景图像也是头像」：没有头像就没有背景，
 *      卡片保持纯色，不出空背景、不出碎图。
 *   2. 取帧档（kind=frame）沿用 avatarSrcOf 的懒加载：进入视口前也是空串。
 * 网络层不额外下载：背景与头像用同一个 URL，浏览器把它们合并成同一次请求
 * （实测：13 张卡 × 2 个图元素 = 26 个 img，后端只收到 13 次 thumb 请求，见 devtools/p567-ui）。
 */
function bgSrcOf(card) {
  if (!card || !card.key) return ''
  const key = String(card.key)
  if (avatarFailed[key] || bgFailed[key]) return ''
  // P5.78：背景用**整张原图**（avatarUrl 是后端按 crop 裁好的方块，不能当背景）
  return originalSrc(avatarSrcOf(card))
}

/* --------------------------------- P5.84 整卡背景几何：裁剪块中心落在整卡 76% / 50% */

/**
 * 容器回到**整张卡片**（.pw-bg 是 inset: 0 的铺满层）—— 几何算法 personBgImage.layoutCrop 一字未改：
 *   imgW = bgW × 0.44 / cropW（只按裁剪块宽度定倍，**不为了盖满而放大**）
 *   imgH = imgW × natH / natW
 *   tx   = bgW × 0.76 − imgW × cx        ty = bgH × 0.5 − imgH × cy
 * 图片盖不满卡片的区域由拾色底（personTone）填充，不做任何放大去覆盖。
 * 用 clientWidth/clientHeight 而不是 rect 宽高：三层图都是 .pw-bg 的绝对定位子元素，left/top: 0 的原点
 * 是 .pw-bg 的 **padding-box**（.pw-bg 自身没有边框，两者数值相同，口径按 padding-box 写死）。
 */
const bgGeom = reactive({})
const bgGeomMemo = new Map()
let wallResizeObserver = null

/** 卡片当前的 crop 参数（ref 优先，退化到头像 URL）；没有就是整图 */
function bgCropOf(card) {
  return parseCrop(card && card.avatar && card.avatar.ref) || parseCrop(card && card.avatar && card.avatar.url)
}

/**
 * 缓存键 = 原图 src + **crop** + .pw-bg 的 padding-box 尺寸。
 * crop 必须进键：背景 src 是 originalSrc(头像 URL)（去掉了 crop 参数），换头像时若只有 crop 变，
 * src 不变 —— 只用 src 当键会命中旧几何（实测踩过：详情晚到后头像换了一张 crop，
 * 图片按旧 crop 定位，裁剪中心偏出 76%）。详见 devtools/p584-ui/REPORT.md 的 C3 一节。
 */
function bgGeomKey(img, crop) {
  const bg = img && img.parentElement
  if (!bg) return ''
  const ck = crop ? [crop.x, crop.y, crop.w, crop.h].join(':') : 'full'
  return (img.currentSrc || img.src || '') + '|' + ck + '#' + Math.round(bg.clientWidth) + 'x' + Math.round(bg.clientHeight)
}

/**
 * 清晰层 @load 后算一次：三层同 src、同 transform（同一组 CSS 变量），算一次三层同时到位。
 * 详情晚到（头像从相册封面升级成显式头像 → crop 变了）时 src 不变、@load 不会再触发，
 * 所以 watch(cards) 里还会调一次 refreshBgGeom()。
 */
function computeBgGeom(card, img) {
  if (!card || !img || !img.naturalWidth || !img.naturalHeight) return
  const bg = img.parentElement
  if (!bg) return
  const crop = bgCropOf(card)
  const key = bgGeomKey(img, crop)
  if (!key) return
  let out = bgGeomMemo.get(key)
  if (!out) {
    out = layoutCrop({ natW: img.naturalWidth, natH: img.naturalHeight, bgW: bg.clientWidth, bgH: bg.clientHeight, crop })
    if (!out) return
    bgGeomMemo.set(key, out)
  }
  bgGeom[String(card.key)] = out
}

/** 重扫整墙：尺寸变了（ResizeObserver）或卡片数据变了（crop / URL）都走这里 */
function refreshBgGeom() {
  if (!wallRef.value) return
  wallRef.value.querySelectorAll('.pw-card.has-bg').forEach((node) => {
    const key = node.getAttribute('data-card-key')
    const card = cards.value.find((c) => String(c.key) === String(key))
    const img = node.querySelector('.pw-bg-sharp')
    if (card && img) computeBgGeom(card, img)
  })
}

/** 只给实测脚本看：'imgW,imgH,tx,ty,cropX,cropY'（面板内坐标系，px） */
function bgGeomOf(card) {
  const g = card && bgGeom[String(card.key)]
  return g ? [g.imgW, g.imgH, g.tx, g.ty, g.cropX, g.cropY].join(',') : ''
}

function bgGeomStyleOf(card) {
  const g = card && bgGeom[String(card.key)]
  if (!g) return null
  return { '--pw-img-w': g.imgW + 'px', '--pw-img-h': g.imgH + 'px', '--pw-img-tx': g.tx + 'px', '--pw-img-ty': g.ty + 'px' }
}

function markBgFailed(card) {
  if (card && card.key) bgFailed[String(card.key)] = true
}

/* ------------------------------- P5.84 卡片底色 = 从同一张图拾到的颜色（P5.77 链路恢复） */

/**
 * 图片按 0.44 倍宽铺在卡片上，**盖不满整卡**（用户口径：不够就用拾色填充，不放大）。
 * 这里从同一张头像原图采样出印象色，落到卡片 background-color：露出来的那条边不是纯灰白，
 * 而是这张图自己的色调，能和图片边缘接上。
 *
 * 采样规则（8×8 网格均值 / 缓存键 / 落地色）全在 personTone.js，单测 personTone.test.mjs。
 * 页面只负责：什么时候采（空闲、限并发 2）、采完挂到卡片的 --pw-tone、主题切换时重算落地色。
 * 采样不在首帧的关键路径上：requestIdleCallback（没有就 setTimeout 0）逐张算。
 * 缓存键是 **toneCacheKey(card)**（头像来源 kind:ref，不是卡片 id）—— 详情请求晚到会把头像
 * 从「相册封面」升级成「显式头像 / 视频帧」，URL 一变键就变，不会拿旧图的颜色刷新卡。
 */
const toneRaw = reactive({})
/** 同一个键 → 落地色 'rgb(…)'（按当前主题算好的拾色，不参与任何对比度约束） */
const toneFillCss = reactive({})
/** 采样队列与在飞计数（并发 2：别和缩略图抢主线程） */
const toneQueue = []
const tonePending = new Set()
let toneInFlight = 0
let toneDisposed = false
let themeObserver = null

const toneCache = readToneCache(typeof localStorage === 'undefined' ? null : localStorage)

/** 读当前主题的卡片底色（--bg-2）：放一个探针元素让浏览器自己解析变量，页面不硬编码色值 */
let toneBgProbe = null
function themeBgRgb() {
  if (!toneBgProbe) {
    toneBgProbe = document.createElement('div')
    toneBgProbe.setAttribute('data-role', 'tone-bg-probe')
    toneBgProbe.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;background:var(--bg-2)'
    // --bg-2 是 .media-scope 的局部变量：探针必须挂进页面，挂 body 上读到的是空值
    const host = document.querySelector('.person-page') || document.body
    host.appendChild(toneBgProbe)
  }
  return parseColor(getComputedStyle(toneBgProbe).backgroundColor) || [255, 255, 255]
}

function currentTheme() {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

/** 用原始采样色重算落地色（主题切换后重跑一遍） */
function applyTone(cacheKey) {
  const raw = toneRaw[cacheKey]
  if (!raw) return
  toneFillCss[cacheKey] = toneFill(raw, themeBgRgb(), currentTheme()) || ''
}

function applyAllTones() {
  for (const k of Object.keys(toneRaw)) applyTone(k)
}

function toneStyleOf(card) {
  const key = card ? toneCacheKey(card) : ''
  const css = key && toneFillCss[key]
  if (!css) return null
  const raw = toneRaw[key]
  // --pw-tone = 落地色（卡片 background-color）；--pw-tone-raw = 原始采样色（只给实测脚本对照）
  return raw ? { '--pw-tone': css, '--pw-tone-raw': rgbCss(raw) } : { '--pw-tone': css }
}

/** 落地色（'rgb(…)'）：卡片 background-color 用它；空串 = 还没采到 / 采样失败 → 退回 --bg-2 */
function toneOf(card) {
  return (card && toneFillCss[toneCacheKey(card)]) || ''
}

const idle = (fn) =>
  typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 0)

function pumpTones() {
  if (toneDisposed) return
  while (toneInFlight < 2 && toneQueue.length) {
    const job = toneQueue.shift()
    toneInFlight++
    sampleTone(job.url).then((tone) => {
      toneInFlight--
      tonePending.delete(job.cacheKey)
      if (tone) {
        toneRaw[job.cacheKey] = tone
        toneCache[job.cacheKey] = tone
        applyTone(job.cacheKey)
        writeToneCache(toneCache, typeof localStorage === 'undefined' ? null : localStorage)
      }
      if (toneQueue.length) idle(pumpTones)
    })
  }
}

/** 给「有背景层、还没采样过」的卡片排队（同一张图只排一次；命中缓存直接落地） */
function queueTones(list) {
  if (toneDisposed) return
  let queued = false
  for (const c of list || []) {
    if (!c || !c.key) continue
    const cacheKey = toneCacheKey(c)
    if (!cacheKey || toneRaw[cacheKey] || tonePending.has(cacheKey)) continue
    const url = bgSrcOf(c)
    if (!url) continue
    if (toneCache[cacheKey]) {
      toneRaw[cacheKey] = toneCache[cacheKey]
      applyTone(cacheKey)
      continue
    }
    tonePending.add(cacheKey)
    toneQueue.push({ url, cacheKey })
    queued = true
  }
  if (queued) idle(pumpTones)
}

/** P5.84：卡片尺寸变了要重算背景几何（三层共用同一组 CSS 变量，只算一次） */
function ensureWallObserver() {
  if (typeof ResizeObserver !== 'function' || !wallRef.value || wallResizeObserver) return
  wallResizeObserver = new ResizeObserver(() => refreshBgGeom())
  wallResizeObserver.observe(wallRef.value)
}

onMounted(() => {
  ensureWallObserver()
  queueTones(cards.value)
  if (typeof MutationObserver === 'function') {
    themeObserver = new MutationObserver(applyAllTones)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
  }
})

onBeforeUnmount(() => {
  toneDisposed = true
  if (wallResizeObserver) wallResizeObserver.disconnect()
  wallResizeObserver = null
  if (themeObserver) themeObserver.disconnect()
  themeObserver = null
  if (toneBgProbe && toneBgProbe.parentNode) toneBgProbe.parentNode.removeChild(toneBgProbe)
  toneBgProbe = null
})

/* --------------------------------------------- P5.72 卡片背景模糊度（用户可调） */

/**
 * 用户口径：「背景模糊度还是太高了，加一个滑块自己调」。
 * 规则（值域 0–20 步长 1 / 遮罩分区与右区联动 / 键 ms.person.bgBlur / 默认 6）全在 personBgBlur.js，
 * 页面这里只做两件事：把 blurCssVars(n) 挂到根节点 style、拖动时写回 localStorage。
 *
 * 性能：input 只改 bgBlur **一个** ref ——
 *   · cards(v-for 的数据源) 是独立 computed，不依赖 bgBlur，列表不重算；
 *   · 下发到 DOM 的只有根节点上的 6 个 CSS 自定义属性 + 数值小字，卡片尺寸不参与计算 → 整墙不重排；
 *   · Vue 的 patch 本来就在 microtask 里合并（一次 input 一次 patch），浏览器自身也按帧合并
 *     pointermove，所以不必再叠一层 rAF（叠了反而在后台标签页里被 rAF 节流成「拖了不动」）。
 */
const bgBlur = ref(readStoredBlur())
const bgBlurVars = computed(() => blurCssVars(bgBlur.value))

/** 拖动 / 键盘方向键：夹取到 0–20 的整数并落盘（存储不可用时静默，本次会话照常生效） */
function onBgBlurInput(event) {
  bgBlur.value = saveStoredBlur(clampBlur(event && event.target ? event.target.value : bgBlur.value, bgBlur.value))
}

function openCard(card) {
  const id = card && card.id !== '' && card.id != null ? card.id : card && card.name
  if (id == null || id === '') return
  router.push('/media/person/' + encodeURIComponent(String(id)))
}

/* --------------------------------------------------------- P5.48 手动头像 */

function detailOfId(id) {
  return details[String(id)] || null
}

/** 能不能换头像：必须 full 档 + 有真实 id（没有 id 的老数据拼不出接口路径） */
function canChangeAvatar(card) {
  return policy.isFull.value && !!card && card.id !== '' && card.id != null
}

/** 弹层里「当前手动头像」：kind / ref 用来打勾，url 用来预览 */
const avatarCurrent = computed(() => {
  const p = avatarDialog.person
  if (!p) return null
  const d = detailOfId(p.id)
  const kind = d && d.avatarKind ? String(d.avatarKind) : ''
  if (!kind) return null
  return { kind, ref: d.avatarRef == null ? '' : String(d.avatarRef), url: explicitAvatarUrl(d) }
})

/**
 * 乐观 URL：与后端 avatarUrlOf 同一条规则，只为「点完立刻看到」；服务端回包会覆盖它。
 *
 * P5.64：拆串走 personWall.parseAvatarRef（photo 的 {@code <albumId>:<seq>} 与 frame 的
 * {@code frame:<videoId>:<sec>} 位置语义不同，不能用同一段 indexOf(':') 硬套）。
 */
function optimisticAvatarUrl(payload) {
  const parsed = parseAvatarRef(payload.kind, payload.ref)
  if (parsed.type === 'url') return parsed.raw
  if (parsed.type === 'photo') {
    const url = api.photoThumbUrl(parsed.albumId, parsed.seq)
    return parsed.crop ? url + '?crop=' + parsed.crop : url
  }
  if (parsed.type === 'frame') return api.frameAvatarUrl(parsed.videoId, parsed.sec, parsed.crop)
  return ''
}

/** 写本地详情，返回「回滚函数」（把这张卡恢复成保存前的样子，含头像加载失败标记） */
function applyLocalAvatar(id, patch) {
  const key = String(id)
  const had = Object.prototype.hasOwnProperty.call(details, key)
  const before = had ? { ...details[key] } : null
  const failedBefore = avatarFailed[key]
  details[key] = Object.assign({}, had ? details[key] : {}, patch)
  delete avatarFailed[key]
  // P5.67：换头像 = 换 URL → 清掉「背景失败」，让背景层跟着新图重新挂上
  delete bgFailed[key]
  return () => {
    if (had) details[key] = before
    else delete details[key]
    if (failedBefore) avatarFailed[key] = true
  }
}

/** 服务端回包就是落库后的整个人物节点：直接当详情用（avatarUrl 以后端为准） */
function mergeServerPerson(id, res) {
  const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
  if (body && typeof body === 'object' && !Array.isArray(body) && body.id != null) {
    details[String(id)] = body
    delete avatarFailed[String(id)]
    // P5.67：服务端回包可能换了头像 URL，背景层同样跟着新图重挂
    delete bgFailed[String(id)]
  }
}

function openAvatarDialog(card) {
  if (!canChangeAvatar(card)) return
  avatarDialog.person = { id: card.id, name: card.name }
  avatarDialog.open = true
}

function closeAvatarDialog() {
  if (avatarDialog.saving) return
  avatarDialog.open = false
}

async function saveAvatar(payload) {
  const person = avatarDialog.person
  if (!person || avatarDialog.saving) return
  const rollback = applyLocalAvatar(person.id, {
    avatarKind: payload.kind,
    avatarRef: payload.ref,
    avatarUrl: optimisticAvatarUrl(payload)
  })
  avatarDialog.saving = true
  try {
    mergeServerPerson(person.id, await setPersonAvatar(person.id, payload.kind, payload.ref))
    avatarDialog.open = false
    showToast('头像已更新')
  } catch (err) {
    rollback()
    showToast('头像更新失败：' + errorText(err))
  } finally {
    avatarDialog.saving = false
  }
}

async function clearAvatar() {
  const person = avatarDialog.person
  if (!person || avatarDialog.saving) return
  const rollback = applyLocalAvatar(person.id, { avatarKind: null, avatarRef: null, avatarUrl: null })
  avatarDialog.saving = true
  try {
    mergeServerPerson(person.id, await clearPersonAvatar(person.id))
    avatarDialog.open = false
    showToast('已恢复自动头像')
  } catch (err) {
    rollback()
    showToast('恢复自动头像失败：' + errorText(err))
  } finally {
    avatarDialog.saving = false
  }
}

/** 索引统计：失败一律静默 —— 少了它只是卡片信息变少，人物墙本身照常可用 */
function loadWallIndex() {
  return api
    .getIndex({ silent: true })
    .then((idx) => {
      wallIndex.value = buildWallIndex(idx)
    })
    .catch(() => {
      wallIndex.value = null
    })
}

/** 单人详情：并发上限 6，单人失败只跳过该人（不影响其它卡片） */
function loadDetails(list) {
  const queue = (list || []).filter((p) => p && p.id != null && p.id !== '')
  if (!queue.length) return Promise.resolve()
  let cursor = 0
  const worker = () => {
    if (cursor >= queue.length) return Promise.resolve()
    const p = queue[cursor]
    cursor += 1
    return api
      .getPerson(p.id, { silent: true })
      .then((res) => {
        const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
        if (body && typeof body === 'object' && !Array.isArray(body)) details[String(p.id)] = body
      })
      .catch(() => {})
      .then(worker)
  }
  const lanes = []
  for (let i = 0; i < Math.min(DETAIL_CONCURRENCY, queue.length); i++) lanes.push(worker())
  return Promise.all(lanes)
}

function load() {
  loading.value = true
  errText.value = ''
  const indexPromise = loadWallIndex()
  api
    .listPersons({ silent: true })
    .then((res) => {
      persons.value = normalizePersons(res).filter((p) => p && (p.id != null || p.name))
      loadDetails(persons.value)
    })
    .catch((err) => {
      persons.value = []
      const status = err && err.response && err.response.status
      // 404 / 501 / 连接失败（无 response）都按「接口未就绪」处理，其余带上错误文案
      errText.value =
        status === 404 || status === 501 || !status
          ? NOT_READY + '（HTTP ' + (status || '无法连接') + '）'
          : '人物数据暂不可用：' + ((err && err.message) || '请求失败')
    })
    .finally(() => {
      loading.value = false
    })
  return indexPromise
}

onMounted(() => {
  tk.pageView()
  // 编辑策略与人物数据并行取：策略晚到只是入口晚一步出现，不阻塞列表
  policy.loadEditPolicy()
  load()
})

onBeforeUnmount(() => {
  tk.dwell()
  if (cardObserver) cardObserver.disconnect()
  cardObserver = null
})
</script>

<template>
  <!-- P5.83：根节点只挂一个 --pw-bg-blur（滑块半径），.pw-bg-img 的 filter 继承它 -->
  <div class="media-scope person-page" :data-state="uiState" :style="bgBlurVars" :data-bg-blur="bgBlur">
    <header class="pp-head">
      <div class="pp-head-left">
        <h1 class="pp-title">人物</h1>
        <span v-if="uiState === 'ready'" class="pp-sub">{{ visible.length }} 位{{ keyword ? '（已过滤）' : '' }}</span>
      </div>
      <div class="pp-head-right">
        <input v-model="keyword" class="pp-search" type="search" placeholder="搜索人物名…" autocomplete="off" />
        <button class="pp-btn" type="button" :disabled="loading" @click="load">刷新</button>
        <!-- P5.72：背景模糊度 —— 0–20px 步长 1，拖动实时生效（只改 CSS 变量），值写 localStorage -->
        <div class="pp-blur" data-role="bg-blur-field">
          <label class="pp-blur-label" for="pp-bg-blur">背景模糊</label>
          <input
            id="pp-bg-blur"
            class="pp-blur-range"
            type="range"
            min="0"
            max="20"
            step="1"
            :value="bgBlur"
            aria-label="背景模糊度"
            data-role="bg-blur"
            @input="onBgBlurInput"
          />
          <span class="pp-blur-val" data-role="bg-blur-value">{{ bgBlur }}px</span>
        </div>
      </div>
    </header>

    <p v-if="uiState === 'loading'" class="pp-state">人物数据加载中…</p>

    <div v-else-if="uiState === 'unavailable'" class="pp-state pp-state-err" data-role="unavailable">
      <strong>人物数据暂不可用</strong>
      <span class="pp-err-text">{{ errText }}</span>
      <button class="pp-btn" type="button" @click="load">重试</button>
    </div>

    <p v-else-if="uiState === 'empty'" class="pp-state" data-role="empty">
      {{ persons.length ? '没有匹配的人物，换个关键词试试' : '还没有人物数据' }}
    </p>

    <div v-else class="pp-wall" ref="wallRef">
      <a
        v-for="c in cards"
        :key="c.key"
        class="pw-card"
        :class="{ 'has-bg': !!bgSrcOf(c), 'has-tone': !!toneOf(c) }"
        :style="[toneStyleOf(c), bgGeomStyleOf(c)]"
        :data-bg-geom="bgGeomOf(c)"
        :data-bg="bgSrcOf(c) ? '1' : '0'"
        :data-tone="toneOf(c)"
        :href="'#/media/person/' + encodeURIComponent(c.id !== '' && c.id != null ? c.id : c.name)"
        :data-person-id="c.id"
        :data-avatar="c.avatar.kind"
        :data-card-key="c.key"
        :data-frame-inview="c.avatar.kind === 'frame' ? (frameInView[String(c.key)] ? '1' : '0') : ''"
        @click.prevent="openCard(c)"
      >
        <!-- P5.85：整卡背景层 = **同一张原图三层**（同 src / 同 transform，rect 逐像素一致）。
             层 1 .pw-bg-sharp 清晰；层 2 .pw-bg-blur blur(半径) + 缓动多停靠点 mask（到 78%）；
             层 3 .pw-bg-fog blur(半径 × 2.6) + 只盖左半的 mask（到 52%）—— 越往左越糊。
             层 0 .pw-glow 是垫在图片之下的极淡柔光（拾色色的亮化版），给左端「雾白 / 淡粉」的底。 -->
        <span v-if="bgSrcOf(c)" class="pw-glow" data-role="pw-glow" aria-hidden="true"></span>
        <span v-if="bgSrcOf(c)" class="pw-bg" data-role="pw-bg" aria-hidden="true">
          <img
            class="pw-bg-img pw-bg-sharp"
            data-role="pw-bg-sharp"
            :src="bgSrcOf(c)"
            alt=""
            loading="lazy"
            decoding="async"
            @load="computeBgGeom(c, $event.target)"
            @error="markBgFailed(c)"
          />
          <img
            class="pw-bg-img pw-bg-blur"
            data-role="pw-bg-blur"
            :src="bgSrcOf(c)"
            alt=""
            loading="lazy"
            decoding="async"
            @error="markBgFailed(c)"
          />
          <img
            class="pw-bg-img pw-bg-fog"
            data-role="pw-bg-fog"
            :src="bgSrcOf(c)"
            alt=""
            loading="lazy"
            decoding="async"
            @error="markBgFailed(c)"
          />
        </span>
        <!-- 文字直接压在图片上（z-index: 2），默认主题色，没有遮罩 / 垫底 / text-shadow -->
        <span class="pw-avatar-wrap">
          <span class="pw-avatar">
            <img
              v-if="avatarSrcOf(c) && !avatarFailed[c.key]"
              :src="avatarSrcOf(c)"
              alt=""
              loading="lazy"
              decoding="async"
              @error="markAvatarFailed(c)"
            />
            <template v-else>{{ c.initial }}</template>
          </span>
          <!-- P5.48：hover 头像才出现的小「换」按钮；off / local 档整块不渲染 -->
          <button
            v-if="canChangeAvatar(c)"
            class="pw-change"
            type="button"
            title="换头像"
            data-role="avatar-change"
            @click.stop.prevent="openAvatarDialog(c)"
          >
            换
          </button>
        </span>
        <span class="pw-body">
          <span class="pw-name" :title="c.alias ? c.name + '（' + c.alias + '）' : c.name">
            {{ c.name }}<i v-if="c.alias" class="pw-alias">（{{ c.alias }}）</i>
          </span>
          <span v-if="c.counts" class="pw-counts">{{ c.counts }}</span>
          <span v-if="c.chips.length" class="pw-chips">
            <span v-for="chip in c.chips" :key="chip" class="pw-chip" :title="chip">{{ chip }}</span>
          </span>
          <span v-if="c.recent" class="pw-recent">{{ c.recent }}</span>
        </span>
      </a>
    </div>

    <!-- P5.48 换头像弹层（整页一个实例，不放进 v-for：卡片 hover 的 transform 会让 fixed 定位漂移） -->
    <PersonAvatarDialog
      :open="avatarDialog.open"
      :person="avatarDialog.person"
      :current="avatarCurrent"
      :busy="avatarDialog.saving"
      @close="closeAvatarDialog"
      @save="saveAvatar"
      @clear="clearAvatar"
    />
    <PageToast :toasts="toasts" />
  </div>
</template>

<style lang="scss" scoped>
@use './mediaTheme.scss' with ($global: false);

.person-page {
  min-height: 100vh;
  padding: 16px var(--ms-gutter, 16px) 32px;
  background: var(--bg);
  color: var(--fg);
}

.pp-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.pp-head-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.pp-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.pp-sub {
  font-size: 12.5px;
  color: var(--fg-dim);
}

.pp-head-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pp-search {
  width: 200px;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg);
  font-size: 13px;
  outline: none;
}

.pp-search:focus {
  border-color: var(--accent);
}

.pp-btn {
  padding: 6px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 13px;
  cursor: pointer;
}

.pp-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.pp-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

/* ------------------------------------------------ P5.72 背景模糊度滑块（工具栏右侧） */
/* 紧凑一行三件套：标签 + 滑块 + 数值。flex: 0 1 auto 让它随行宽收缩，不把搜索框挤出容器。 */
.pp-blur {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 1 auto;
  min-width: 0;
}

.pp-blur-label {
  font-size: 12.5px;
  color: var(--fg-dim);
  white-space: nowrap;
  cursor: pointer;
}

/* 原生 range：只定尺寸与强调色，轨道 / 滑块交给浏览器（键盘 ←→ / Home / End 自带行为） */
.pp-blur-range {
  width: 88px;
  min-width: 0;
  height: 16px;
  margin: 0;
  padding: 0;
  accent-color: var(--accent);
  background: transparent;
  cursor: pointer;
}

.pp-blur-range:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 999px;
}

/* 数值小字（如 6px）：定宽防止「0px ↔ 20px」抖动把后面的元素推来推去 */
.pp-blur-val {
  min-width: 28px;
  text-align: right;
  font-size: 11.5px;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}

.pp-state {
  margin: 32px 0;
  padding: 18px;
  border: 1px dashed var(--line);
  border-radius: var(--radius, 10px);
  text-align: center;
  font-size: 13.5px;
  color: var(--fg-dim);
}

.pp-state-err {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  border-style: solid;
  border-color: var(--line-2);
}

.pp-err-text {
  font-size: 12.5px;
  color: var(--fg-dim);
}

/* P5.60：用户口径「要加宽，不是加高」—— 最小列宽 200 → 280（P5.45 的 168 → 200 是同一路调整）。
   280px 一列 = 12px 内边距 ×2 + 56px 头像 + 10px gap 之后还有 190px 文本宽，
   「0 部视频 · 144 本相册 · 9017 张照片」这种最长实测文案（约 181px @11.5px）单行放得下，
   所以数量行不再需要折行、卡片也不必为了容纳两行而拉高。
   grid-auto-rows: 1fr 让**整面墙**的行等高（不是只同排等高）—— 某张卡因 chip 换行变高时
   其它卡片跟着长到同一高度，网格始终是整齐的棋盘，不会出现高低错落。 */
.pp-wall {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  grid-auto-rows: 1fr;
  gap: 12px;
}

.pw-card {
  /* P5.84：文字重新压在图片上 —— 卡片是定位容器，.pw-bg（z-index: 0）铺满整卡，
     文字（.pw-avatar-wrap / .pw-body，都是 z-index: 2）在它上面。
     **没有遮罩 / 垫底 / 自适应字色 / text-shadow**：用户明确要求文字直接压在图片上。 */
  position: relative;
  overflow: hidden;
  isolation: isolate;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 100%;
  /* P5.60：卡片紧凑高度（84 是下限，内容更高时由 grid-auto-rows: 1fr 统一拉平） */
  min-height: 84px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius, 10px);
  background: var(--bg-2);
  color: var(--fg);
  text-decoration: none;
  /* P5.85：模糊层横向渐隐的终点（多停靠点 mask 的最后一段，默认 78%） */
  --pw-blur-fade-end: 78%;
  /* P5.85：图片**自身**的左缘渐显（按图片宽度算，不按卡片宽度）。
     几何上图片可能比卡片窄（imgW = bgW × 0.44 / cropW，不放大），它的左边界本来是一条硬直竖线；
     这条渐显以 intersect 的方式叠在每层 mask 上，把那条竖线化开。 */
  --pw-img-fade: linear-gradient(to right, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.45) 9%, #000 20%);
  transition: transform 0.12s, border-color 0.12s;
}

.pw-card:hover {
  transform: translateY(-1px);
  border-color: var(--line-2);
}

/* P5.84：拾色底 —— 图片盖不满卡片的区域用这张图自己的颜色填（personTone 采样）。
   采样还没回来 / 采样失败时没有 has-tone，卡片退回 --bg-2。 */
.pw-card.has-tone {
  background-color: var(--pw-tone, var(--bg-2));
}

/* -------------------------------------- P5.84 整卡背景层（同一张原图 × 2） */

/* 铺满整卡（inset: 0 相对卡片的 padding-box）+ overflow: hidden：两张图按几何变量定位，
   超出卡片的部分在这里被裁掉，不会撑出滚动条。 */
.pw-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
}

/* 三层共用同一组几何变量（由 layoutCrop 算好挂在卡片上），
   所以三层 rect 逐像素一致 —— 本版唯一的硬断言。 */
.pw-bg-img {
  position: absolute;
  left: 0;
  top: 0;
  width: var(--pw-img-w, auto);
  height: var(--pw-img-h, auto);
  max-width: none;
  transform: translate(var(--pw-img-tx, 0px), var(--pw-img-ty, 0px));
  transition: transform 0.12s ease;
  /* 每层都先按图片自身的左缘渐显一次（--pw-img-fade）；模糊 / 雾层再与自己的横向 mask 取交集 */
  -webkit-mask-image: var(--pw-img-fade);
  mask-image: var(--pw-img-fade);
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-size: 100% 100%;
  mask-size: 100% 100%;
}

/* P5.85 柔光（层 0）：垫在图片**之下**、卡片拾色底**之上**。用拾色色的亮化版
   （color-mix 往 #fff 提，暗色主题往 #0b0d10 压）做一层极淡的径向光晕，只在左端出现
   （右边全透明），给左缘补上参考图那种「雾白 / 淡粉」的底。opacity 0.35 是上限：
   它是柔光，不是白色遮罩块。 */
.pw-glow {
  position: absolute;
  inset: 0;
  opacity: 0.35;
  background: radial-gradient(
    145% 165% at 0% 50%,
    color-mix(in srgb, var(--pw-tone, var(--bg-2)) 70%, #fff) 0%,
    color-mix(in srgb, var(--pw-tone, var(--bg-2)) 70%, #fff) 26%,
    transparent 70%
  );
}

.dark .pw-glow {
  background: radial-gradient(
    145% 165% at 0% 50%,
    color-mix(in srgb, var(--pw-tone, var(--bg-2)) 70%, #0b0d10) 0%,
    color-mix(in srgb, var(--pw-tone, var(--bg-2)) 70%, #0b0d10) 26%,
    transparent 70%
  );
}

/* 层 2（中间档模糊）：blur(半径) + 缓动多停靠点横向 mask —— 不再是 45%→70% 的直线，
   而是 0/18/34/50/64%（alpha 1 → .92 → .62 → .3 → .08）一路 smoothstep 到 78% 才透明。
   过渡区从卡的 18% 一直铺到 78%，中间没有可辨认的斜率突变，所以看不出「分界线」。
   brightness(.9) 沿用 P5.69 的口径：模糊层比清晰层暗一档。 */
.pw-bg-blur {
  filter: blur(var(--pw-bg-blur, 6px)) saturate(1.1) brightness(0.9);
  -webkit-mask-image:
    linear-gradient(
      to right,
      #000 0%,
      rgba(0, 0, 0, 0.92) 18%,
      rgba(0, 0, 0, 0.62) 34%,
      rgba(0, 0, 0, 0.3) 50%,
      rgba(0, 0, 0, 0.08) 64%,
      transparent var(--pw-blur-fade-end, 78%)
    ),
    var(--pw-img-fade);
  mask-image:
    linear-gradient(
      to right,
      #000 0%,
      rgba(0, 0, 0, 0.92) 18%,
      rgba(0, 0, 0, 0.62) 34%,
      rgba(0, 0, 0, 0.3) 50%,
      rgba(0, 0, 0, 0.08) 64%,
      transparent var(--pw-blur-fade-end, 78%)
    ),
    var(--pw-img-fade);
  /* 两层 mask 取交集（intersect）：上面那排停靠点原样不动，只把图片左缘的硬竖线化开 */
  -webkit-mask-composite: source-in;
  mask-composite: intersect;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-size: 100% 100%;
  mask-size: 100% 100%;
}

/* 层 3（最糊）：同一张图 blur(半径 × 2.6)，mask 只盖左半（0% 实 → 52% 透明）。
   叠加在层 2 上面 → 越往左越糊，而不是「同一档糊 + 一条 alpha 斜坡」。 */
.pw-bg-fog {
  filter: blur(calc(var(--pw-bg-blur, 6px) * 2.6));
  -webkit-mask-image: linear-gradient(to right, #000 0%, transparent 52%), var(--pw-img-fade);
  mask-image: linear-gradient(to right, #000 0%, transparent 52%), var(--pw-img-fade);
  -webkit-mask-composite: source-in;
  mask-composite: intersect;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-size: 100% 100%;
  mask-size: 100% 100%;
}

/* hover：三层一起放大 3%（同一 transform，rect 仍然一致），模糊层顺手提一档饱和 / 亮度 */
.pw-card:hover .pw-bg-img,
.pw-card:focus-visible .pw-bg-img {
  transform: translate(var(--pw-img-tx, 0px), var(--pw-img-ty, 0px)) scale(1.03);
}

.pw-card:hover .pw-bg-blur,
.pw-card:focus-visible .pw-bg-blur {
  filter: blur(var(--pw-bg-blur, 6px)) saturate(1.12) brightness(1);
}

@media (prefers-reduced-motion: reduce) {
  .pw-bg-img,
  .pw-card:hover .pw-bg-img,
  .pw-card:focus-visible .pw-bg-img {
    transform: translate(var(--pw-img-tx, 0px), var(--pw-img-ty, 0px));
    transition: none;
  }
}

.pw-avatar-wrap {
  position: relative;
  z-index: 2;
  flex: 0 0 56px;
  width: 56px;
  height: 56px;
}

.pw-change {
  position: absolute;
  right: -4px;
  bottom: -4px;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 0;
  border: 1px solid var(--line-2);
  border-radius: 50%;
  background: var(--bg-2);
  color: var(--fg-dim);
  font-size: 11px;
  line-height: 1;
  text-align: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s, border-color 0.12s, color 0.12s;
}

.pw-avatar-wrap:hover .pw-change,
.pw-avatar-wrap:focus-within .pw-change {
  opacity: 1;
}

.pw-change:hover,
.pw-change:focus-visible {
  opacity: 1;
  border-color: var(--accent);
  color: var(--accent);
}

.pw-avatar {
  width: 100%;
  height: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent-soft);
  border: 1px solid var(--line);
  color: var(--accent);
  font-size: 18px;
  font-weight: 600;
  overflow: hidden;
}

.pw-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pw-body {
  position: relative;
  z-index: 2;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.pw-name {
  color: var(--fg);
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pw-alias {
  margin-left: 2px;
  font-style: normal;
  font-size: 12px;
  font-weight: 400;
  color: var(--fg-dim);
}

.pw-counts {
  font-size: 11.5px;
  line-height: 1.35;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pw-chips {
  display: flex;
  flex-wrap: nowrap;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}

.pw-chip {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  padding: 0 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 10.5px;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pw-recent {
  font-size: 10.5px;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 768px) {
  .pp-wall {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .pp-search {
    width: 140px;
  }

  .pw-card {
    gap: 8px;
    padding: 9px 10px;
  }

  .pw-avatar-wrap {
    flex-basis: 40px;
    width: 40px;
    height: 40px;
  }

  .pw-avatar {
    font-size: 16px;
  }

  .pw-counts {
    font-size: 11px;
  }
}

@media (max-width: 640px) {
  .pp-blur-label {
    display: none;
  }

  .pp-blur-range {
    width: 76px;
  }
}

@media (max-width: 430px) {
  .pp-wall {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
}
</style>
