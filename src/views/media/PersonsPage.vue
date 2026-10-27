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
    · **实时生效**：滑块只写根节点的 CSS 变量 --pw-bg-blur（半径）与 --pw-mask-l1..l3 / -d1..d3（遮罩），
      .pw-bg img 的 filter 与**外扩量**都读它：inset = -1.5 × 半径、尺寸 = 100% + 3 × 半径 ——
      任意半径下模糊只吃图片自身像素，卡片边不露底色；0px 时外扩为 0，正好等于卡片尺寸。
    · **持久化**：localStorage 键 ms.person.bgBlur，默认 6（= P5.69 的线上值）。
    · **0px = 纯照片背景**：模糊没了就等于把清晰的原始像素重新压回文字底下，遮罩自动**加厚一档**
      （亮 .96/.94/.78、暗 .95/.92/.86）；半径越大越不需要补偿，6px 起回到现值 .93/.88/.62 / .9/.82/.66
      并保持不动。阈值 MASK_RAMP = 6：0→6px 是**连续斜坡**（2px 时已退到加强档的 1/3），不是一刀切。
    · 值域 / 联动 / 持久化的唯一实现在 personBgBlur.js（单测 personBgBlur.test.mjs），页面只挂变量与写回。
    · 无头像的卡片本来就没有 .pw-bg 层，滑块不影响它们。
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
watch(cards, () => nextTick(observeFrameCards))

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
  return avatarSrcOf(card)
}

function markBgFailed(card) {
  if (card && card.key) bgFailed[String(card.key)] = true
}

/* --------------------------------------------- P5.72 卡片背景模糊度（用户可调） */

/**
 * 用户口径：「背景模糊度还是太高了，加一个滑块自己调」。
 * 规则（值域 0–20 步长 1 / 0px 遮罩加厚 / 键 ms.person.bgBlur / 默认 6）全在 personBgBlur.js，
 * 页面这里只做两件事：把 blurCssVars(n) 挂到根节点 style、拖动时写回 localStorage。
 *
 * 性能：input 只改 bgBlur **一个** ref ——
 *   · cards(v-for 的数据源) 是独立 computed，不依赖 bgBlur，列表不重算；
 *   · 下发到 DOM 的只有根节点上的 7 个 CSS 自定义属性 + 数值小字，卡片尺寸不参与计算 → 整墙不重排；
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
  <!-- P5.72：--pw-bg-blur + 6 个遮罩 alpha 挂在根节点上，全页 .pw-bg / .pw-mask 继承（只挂变量，不碰布局） -->
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
      <!-- data-avatar = 头像来源（profile / album / video / initial），真浏览器实测据此断言命中率 -->
      <a
        v-for="c in cards"
        :key="c.key"
        class="pw-card"
        :class="{ 'has-bg': !!bgSrcOf(c) }"
        :data-bg="bgSrcOf(c) ? '1' : '0'"
        :href="'#/media/person/' + encodeURIComponent(c.id !== '' && c.id != null ? c.id : c.name)"
        :data-person-id="c.id"
        :data-avatar="c.avatar.kind"
        :data-card-key="c.key"
        :data-frame-inview="c.avatar.kind === 'frame' ? (frameInView[String(c.key)] ? '1' : '0') : ''"
        @click.prevent="openCard(c)"
      >
        <!-- P5.67：底层 = 同一张头像铺满卡片（模糊 + 遮罩），头像/文字在上面两层 -->
        <span v-if="bgSrcOf(c)" class="pw-bg" aria-hidden="true">
          <img
            :src="bgSrcOf(c)"
            alt=""
            loading="lazy"
            decoding="async"
            @error="markBgFailed(c)"
          />
        </span>
        <span v-if="bgSrcOf(c)" class="pw-mask" aria-hidden="true"></span>
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
  /* P5.67：卡片是背景层的定位容器，圆角裁切靠 overflow: hidden（背景不溢出卡片）；
     isolate 让每张卡自成一个层叠上下文 —— 背景（0）/ 遮罩（1）/ 头像与文字（2）的次序只在卡内比较，
     不会和相邻卡片的 hover 层缠在一起。 */
  position: relative;
  overflow: hidden;
  isolation: isolate;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 100%;
  /* P5.60：卡片回到紧凑高度（P5.55 的 108 → 84）—— 加宽后数量行只有一行、chip 也基本一行，
     自然内容高 ≈ 92px（名字 20 + 数量 16 + chip 16 + 最近 14 + 行距 9 + 上下内边距 20），
     84 只是下限（内容更高时由内容撑、由 grid-auto-rows: 1fr 统一拉平），
     不再靠 min-height 硬撑出「空一大截」的观感。 */
  min-height: 84px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius, 10px);
  background: var(--bg-2);
  color: var(--fg);
  text-decoration: none;
  transition: transform 0.12s, border-color 0.12s;
}

.pw-card:hover {
  transform: translateY(-1px);
  border-color: var(--line-2);
}

/* ------------------------------------------------ P5.67 卡片背景层（头像铺满） */

/* 底层：整卡铺满的模糊人像。inset 负值外扩 9px —— 见文件头 P5.69 注释（避免模糊边缘透底） */
.pw-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
  /* P5.69：整层降不透明度 —— 背景从「主体」退成「隐约的人像氛围」。
     0.7 与上面 blur(6px) 叠加后：轮廓还能辨认（人像不再是色块），但整片亮度/对比都往卡片底色
     --bg-2 收，压在照片上的文字反而更干净（亮色往近白收、暗色往近黑收，两侧都是对比度加分）。 */
  opacity: 0.7;
}

.pw-bg img {
  position: absolute;
  /* P5.72：**外扩量随模糊半径联动** = 半径 × 1.5（默认 6px → 9px，与 P5.69 的实测值完全一致；
     拖到 0px 时外扩 = 0，图片正好等于卡片尺寸）。高斯模糊会从图片自身边缘往里渗，
     图若压着卡片边，模糊后边上会透出卡片底色（「一圈发白的模糊边」）；外扩后模糊只吃图片
     自身的像素，任意半径下卡片内都不露边。宽度同步 100% + 3 × 半径，cover 的裁切比例不变。 */
  inset: calc(var(--pw-bg-blur, 6px) * -1.5);
  width: calc(100% + var(--pw-bg-blur, 6px) * 3);
  height: calc(100% + var(--pw-bg-blur, 6px) * 3);
  /* center 25%：人像竖图里脸通常在偏上 1/4，cover 按这个锚点裁，尽量露出人脸 */
  object-fit: cover;
  object-position: center 25%;
  /* P5.69 的 6px 现在是**默认值**（滑块初值）；实际半径来自根节点 --pw-bg-blur（P5.72） */
  filter: blur(var(--pw-bg-blur, 6px)) saturate(1.1) brightness(0.9);
  /* P5.72：filter 退出 0.12s 过渡 —— 拖滑块必须**立刻**看到半径变化，
     带过渡时每一档都要 120ms 才到位（且途中读到的 computed filter 是插值）。transform 仍过渡。 */
  transition: transform 0.12s ease;
}

/* hover：背景轻轻放大 + 提亮（120ms）。缩放锚在中心，卡片边框由 .pw-card 的 overflow 裁住；
   「换」按钮在 .pw-avatar-wrap（z-index: 2）里，永远压在背景之上，不会被盖住/挡住点击。 */
.pw-card:hover .pw-bg img,
.pw-card:focus-visible .pw-bg img {
  transform: scale(1.03);
  /* P5.72：半径照样读滑块变量，只把 saturate / brightness 提一档 */
  filter: blur(var(--pw-bg-blur, 6px)) saturate(1.12) brightness(1);
}

/* 遮罩：左强右弱 —— 左侧是头像 + 名字（要最清楚），右侧只留人像氛围。
   取值是按「最坏情况」算的：亮色下背景可能整片近黑（255×α），暗色下可能整片近白（18×α + 255×(1-α)）；
   文字色统一用 --fg 时，亮色 α=.62（只有卡片最右边那一小条，名字被省略号截断时才到得了）→ 5.0:1 解析值，
   暗色 α=.66 → 4.9:1 解析值；实测像素最差 5.33:1（亮）/ 6.27:1（暗），见 devtools/p567-ui/REPORT.md。
   亮色右边留到 .62 是为了让人像在卡片右侧真的看得见（左侧 .93 保证头像与名字区最清楚）。 */
.pw-mask {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  border-radius: inherit;
  /* P5.72：三个停靠点的 alpha 改由根节点变量给 —— 0px（纯照片）时自动加厚到 .96/.94/.78，
     6px 起回到 P5.69 的 .93/.88/.62。只换 alpha、不动渐变几何，所以拖动时遮罩不会左右跳。 */
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, var(--pw-mask-l1, 0.93)) 0%,
    rgba(255, 255, 255, var(--pw-mask-l2, 0.88)) 50%,
    rgba(255, 255, 255, var(--pw-mask-l3, 0.62)) 100%
  );
}

html.dark .pw-mask {
  background: linear-gradient(
    90deg,
    rgba(18, 18, 18, var(--pw-mask-d1, 0.9)) 0%,
    rgba(18, 18, 18, var(--pw-mask-d2, 0.82)) 46%,
    rgba(18, 18, 18, var(--pw-mask-d3, 0.66)) 100%
  );
}

/* 文字压在照片上：数量行 / 最近更新 / 别名从「卡片底上的次级色」--fg-dim 提到 --fg。
   --fg-dim 对纯底是 4.9:1，但压在照片上（遮罩最薄处 + 近黑/近白像素）只剩 2.5–3.9:1；
   提到 --fg 后三档实测最差 5.33:1。没有背景层的卡片（首字占位 / 无头像）保持原来的 --fg-dim。 */
.pw-card.has-bg .pw-counts,
.pw-card.has-bg .pw-alias,
.pw-card.has-bg .pw-recent {
  color: var(--fg);
}

/* 最近更新那行平时带 opacity: .85（压在纯色底上没问题）；压在照片上会再掉一档对比度，has-bg 时取消 */
.pw-card.has-bg .pw-recent {
  opacity: 1;
}

/* 浏览器不支持 filter（模糊失效 → 背景是清晰原图）：退化成更厚的半透明遮罩，文字照样 ≥4.5:1 */
@supports not (filter: blur(4px)) {
  .pw-bg img {
    filter: none;
  }

  .pw-mask {
    background: linear-gradient(
      90deg,
      rgba(255, 255, 255, 0.96) 0%,
      rgba(255, 255, 255, 0.93) 46%,
      rgba(255, 255, 255, 0.84) 100%
    );
  }

  html.dark .pw-mask {
    background: linear-gradient(
      90deg,
      rgba(18, 18, 18, 0.95) 0%,
      rgba(18, 18, 18, 0.92) 46%,
      rgba(18, 18, 18, 0.84) 100%
    );
  }
}

/* 系统要求减少动效：hover 不再放大/提亮 */
@media (prefers-reduced-motion: reduce) {
  .pw-bg img,
  .pw-card:hover .pw-bg img,
  .pw-card:focus-visible .pw-bg img {
    transform: none;
    transition: none;
  }
}

/* 头像外层（P5.48）：只负责定位「换」按钮，尺寸口径与旧 .pw-avatar 完全一致 */
.pw-avatar-wrap {
  position: relative;
  /* P5.67：压在背景（0）/ 遮罩（1）之上 */
  z-index: 2;
  flex: 0 0 56px;
  width: 56px;
  height: 56px;
}

/* hover 头像才出现的小「换」按钮：默认 opacity 0（不占视觉、仍可聚焦），
   hover / 键盘 focus 时点亮；点它不触发卡片跳转（stop + prevent） */
.pw-change {
  position: absolute;
  right: -4px;
  bottom: -4px;
  width: 22px;
  height: 22px;
  /* P5.55：「换」字以前靠 line-height:1 的默认行为居中，CJK 的 ascent/descent 不对称 →
     视觉上偏下偏右（实测中心偏差 -0.5px / +1.0px）。改成 flex 居中 + font-size 与盒高解耦，
     再把 border 用 box-sizing 算进盒里，文字盒中心与按钮中心重合（实测偏差 ≤ 0.5px）。 */
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

/* 头像：有图时圆形容器裁切（object-fit: cover），无图时是首字占位（同一个盒子，尺寸不抖） */
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
  /* P5.67：文字层在遮罩之上（与头像同层，同为 2） */
  position: relative;
  z-index: 2;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.pw-name {
  /* P5.67：姓名**显式**给 --fg。卡片是 <a>，mediaTheme 的 .media-scope a{color:--accent} 特异性
     高过 .pw-card{color:--fg}，所以姓名此前一直继承强调蓝 #409eff —— 压在纯白卡片上只有 2.78:1、
     压在照片背景上更低（实测 1.25:1）。姓名是卡片主信息不是行内链接，改为 --fg 后亮色 12.6:1、
     压在照片上最差 5.9:1（实测见 devtools/p567-ui/REPORT.md）。 */
  color: var(--fg);
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 别名跟在名字后面的括号里：不抢主名（次级色 + 小一号），太长就一起被省略号截掉 */
.pw-alias {
  margin-left: 2px;
  font-style: normal;
  font-size: 12px;
  font-weight: 400;
  color: var(--fg-dim);
}

/* 数量行（P5.60）：**单行、不折**—— 加宽到 280px 一列后最长实测文案也放得下（见 .pp-wall 注释）。
   以前是 -webkit-line-clamp: 2（允许折两行），那正是用户说的「还是会折行」；
   现在 white-space: nowrap 明令不折，省略号只是 ≤430px 单列窄屏的超长兜底（正常情况下 scrollWidth == clientWidth）。
   等高仍由 .pp-wall 的 grid-auto-rows: 1fr 统一。 */
.pw-counts {
  font-size: 11.5px;
  line-height: 1.35;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* chip 区（P5.60）：**单行**（flex-nowrap）—— 折行会让卡片长高，而那正是用户反对的
   「拉长=变高」。加宽到 280px 后 3 个 chip 基本一行放得下；个别超长值已在
   personWall.profileChips 里截到 14 字，真还放不下就让 chip 自己压缩、文字打省略号
   （title 里有原文、详情页给全量），容器绝不折行。
   「最多 3 个」仍由 personWall.profileChips 决定，容器只负责排版。 */
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
  opacity: 0.85;
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

/* P5.72：≤640px「折叠」—— 标签收起，只留滑块与数值，仍与搜索 / 刷新同一行。
   不给滑块设 min-width：窄屏下它随行宽收缩（flex 0 1 auto），宁可变短也不让页面横向滚动。 */
@media (max-width: 640px) {
  .pp-blur-label {
    display: none;
  }

  .pp-blur-range {
    width: 76px;
  }
}

/* P5.60：≤430px（手机竖屏，375 档）收成**单列** —— 两列时每张卡只有约 166px，
   「X 部视频 · Y 本相册 · Z 张照片」必然被省略号切掉（用户抱怨的那件事在窄屏同样成立）。
   单列 ≈ 343px 一列，文本宽 ≈ 271px，数量行照样单行完整；页面仍无横向滚动。 */
@media (max-width: 430px) {
  .pp-wall {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
}
</style>
