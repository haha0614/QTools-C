/**
 * personWall.js —— 「人物」墙（/media/persons）卡片信息的**纯逻辑**（无 Vue / 无网络 / 无 DOM）
 *
 * 为什么要单独一个模块：人物页从「首字母 + 名字」升级成「头像 + 数量 + 资料 chip + 最近更新」后，
 * 每条卡片要同时读三份数据源（P5.45）：
 *   1. GET /api/media/persons       —— 人物字典（id / name / alias / useCount）；
 *   2. GET /api/media/index         —— 纯前端聚合：albums[].persons / albums[].count / videos[].persons /
 *                                      people[].{photos,count,albums,cover,mtime}；
 *   3. GET /api/media/person/{id}   —— 单人详情（avatarPath + P5-A 的 14 个资料字段 + 计数兜底）。
 * 三份数据的拼装规则（谁优先、缺哪个降级到哪个、怎么排 chip、日期怎么格式化）集中在这里，
 * 页面只负责发请求与渲染，单测（personWall.test.mjs）覆盖所有降级分支。
 *
 * 头像来源（P5.45(a)，按可行性优先级）：
 *   0. 人物详情里的 avatarPath（显式头像，站端目前全为空，有就用）；
 *   1. 该人物名下**第一个相册**的封面 —— 索引 albums[].cover（形如 thumbs/p/a164/0000.jpg，由页面注入的
 *      thumbOf() 转成 /api/media/thumb/p/a164/0000，与相册卡封面同一个 URL 构造）；
 *   2. 名下没有相册但有视频 → 第一个视频的封面 /api/media/thumb/v/<videoId>（videoThumb() 注入）；
 *   3. 都没有 → 首字彩色圆底占位（initialOf）。
 * 命中率（真实数据 14 位人物）：1 档 10 位 + 2 档 4 位 = 14/14（P5.60 删掉测试空壳「E2E演员」后无人落回首字）。
 *
 * 非真人条目（P5.60）：media_person 里有两类「不是人」的行 ——「未归类」（相册归档容器）与
 * 「素人」（无演员视频的兜底人物）。前者不该出现在人物墙（isPlaceholderPerson 判定 + 后端 isPlaceholder
 * 标记，两条规则同一份实现），后者有业务含义要保留。判定见 isPlaceholderPerson。
 *
 * 约定：本模块不 import 任何运行时依赖（URL 构造由调用方以函数注入），
 *       所以 node 直接跑单测时不需要浏览器 / vue / axios。
 */

/**
 * mtime 归一成 epoch 毫秒。后端 MediaAlbum/MediaVideo.mtime 是 java.util.Date，
 * Jackson 序列化视配置可能是毫秒数、也可能是 `2026-10-17T09:30:00` / `2026-10-17 09:30:00`
 * 这种字符串（本项目时区为本地）；两种都认，认不出来的当 0（= 该条不计入「最近」）。
 */
export function toMs(v) {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 0 : v.getTime()
  const s = String(v).trim()
  if (!s) return 0
  if (/^\d+(\.\d+)?$/.test(s)) return toMs(Number(s))
  const n = Date.parse(s.replace(' ', 'T'))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 「最近更新」的日期格式：YYYY-MM-DD（本地时区，与人物页其它日期同口径） */
export function formatDay(ms) {
  const n = toMs(ms)
  if (!n) return ''
  const d = new Date(n)
  if (Number.isNaN(d.getTime())) return ''
  const p = (v) => (v < 10 ? '0' + v : String(v))
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/**
 * P5-A 的 14 个「人物资料」字段 + 两个基础列（生日 / 性别，用户原文里的「出生年」就是 birthday）。
 * 顺序 = 卡片 chip 的**取值优先级**：先放最想看的硬指标（身高体重三围出生年国籍），
 * 再放外观与从业（族裔 / 发色 / 瞳色 / 出道），最后才是长文本与社交账号 —— 卡片最多取前 3 个，
 * 所以顺序本身就是「撑爆卡片之前先保住重要的那几个」。
 */
export const PROFILE_FIELDS = [
  { key: 'heightCm', label: '身高', fmt: (v) => v + 'cm' },
  { key: 'weightKg', label: '体重', fmt: (v) => v + 'kg' },
  { key: 'measurements', label: '三围' },
  { key: 'birthday', label: '出生' },
  { key: 'nationality', label: '国籍' },
  { key: 'ethnicity', label: '族裔' },
  { key: 'gender', label: '性别' },
  { key: 'hairColor', label: '发色' },
  { key: 'eyeColor', label: '瞳色' },
  { key: 'careerStart', label: '出道', fmt: (v) => String(v) + ' 年' },
  { key: 'careerEnd', label: '退役', fmt: (v) => String(v) + ' 年' },
  { key: 'tattoos', label: '纹身' },
  { key: 'piercings', label: '穿孔' },
  { key: 'fakeBoobs', label: '隆胸', fmt: (v) => (v === true || v === 1 || v === '1' || v === 'true' ? '是' : '否') },
  { key: 'twitter', label: '推特' },
  { key: 'instagram', label: 'IG' }
]

const CHIP_MAX = 3

const list = (v) => (Array.isArray(v) ? v : [])
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const text = (v) => (v == null ? '' : String(v).trim())

function nameOf(node) {
  return text(node && node.name)
}

/**
 * 人物名的两种形态：索引里 albums[].persons 是**纯字符串数组**（`["念念"]`），
 * videos[].persons 与 people[] 是**对象**（`{id,name,role?}` / `{name,count,...}`）。
 * 这层差异只在索引侧存在，卡片侧统一拿到字符串，所以先在这里抹平。
 */
function labelOf(node) {
  if (node == null) return ''
  if (typeof node === 'string') return text(node)
  return text(node.name)
}

/** 人物名的对齐口径：索引按名字关联（people[] 只有 name，/persons 给的是 DB id），所以两边都 trim */
export function personKey(person) {
  const id = person && person.id != null ? String(person.id) : ''
  return id || nameOf(person)
}

/**
 * 非真人「容器 / 兜底」实体（P5.60）。
 *
 * 判定分两层，**一次实现、页面与单测共用**：
 *   1. 后端标记优先：`person.isPlaceholder` 由 `MediaPersonServiceImpl.personBriefList` 输出
 *      （规则：名字在 PLACEHOLDER_NAMES 里，或 note 带 PLACEHOLDER_NOTE_MARK）—— 新后端一定走这条；
 *   2. 老后端 / 离线快照兜底：响应里没有这个布尔值时按名字 + note 标记自己判（方案 B 的那套规则
 *      收进这里，而不是散落在页面里，所以只有一处要维护）。
 *
 * 只排除「未归类」这种**归档容器**：它名下挂着相册（a158 a159），删不掉也不该当演员展示。
 * 「素人」是**有业务含义的兜底人物**（没有演员的视频归到它），保留在人物墙。
 */
export const PLACEHOLDER_NAMES = ['未归类']

/** note 里的机器可读标记：靠名字判会把「改个名」变成「它就冒出来了」，所以标记进库 */
export const PLACEHOLDER_NOTE_MARK = '[placeholder]'

/**
 * 这条人物字典记录是不是**占位实体**（不是真人，人物墙不展示）。
 * @param {object} person /persons 的一条（isPlaceholder / name / note 取得到就用）
 * @returns {boolean}
 */
export function isPlaceholderPerson(person) {
  if (!person || typeof person !== 'object') return false
  if (person.isPlaceholder === true) return true
  if (person.isPlaceholder === false) return false
  if (text(person.note).indexOf(PLACEHOLDER_NOTE_MARK) >= 0) return true
  return PLACEHOLDER_NAMES.indexOf(text(person.name)) >= 0
}

/** 首字占位：中文取第一个字，英文取首字母大写（Array.from 保证 emoji / 代理对不被截断） */
export function initialOf(name) {
  const s = text(name)
  if (!s) return '?'
  const first = Array.from(s)[0]
  return /[a-z]/.test(first) ? first.toUpperCase() : first
}

/**
 * 索引 → 「人名 → 统计」的查找表。
 *
 * 三个坑（都在真实数据上踩过，单测固定住）：
 *   1. 索引里既有 albums[].persons（数组）也有老字段 albums[].person（单选镜像列），前者优先；
 *   2. people[].count 的语义是**相册数**（后端 own.size()），不是视频数 ——
 *      视频数只能靠 videos[].persons 现算；两者都没有时 people[].albums.length 兜底；
 *   3. 「最近更新」的时间取 people[].mtime（聚合值，有就用），没有就退到 albums[].mtime /
 *      videos[].mtime，三处一起取 max；哪一处都没有（现行后端 people[] 只有 name/count/photos/
 *      albums/cover）→ 0 → 卡片不渲染「最近」行，不留空洞。toMs() 同时认毫秒数与日期字符串。
 *
 * @param {object} index GET /api/media/index 的响应
 * @returns {Map<string, {albums:number, photos:number, videos:number, coverRel:string, posterId:string, mtime:number}>}
 */
export function buildWallIndex(index) {
  const byName = new Map()
  const slot = (name) => {
    let s = byName.get(name)
    if (!s) {
      s = { albums: 0, photos: 0, videos: 0, coverRel: '', posterId: '', mtime: 0 }
      byName.set(name, s)
    }
    return s
  }
  const namesOfAlbum = (album) => {
    const many = list(album && album.persons).map(labelOf).filter(Boolean)
    if (many.length) return many
    const one = text(album && album.person)
    return one ? [one] : []
  }

  for (const album of list(index && index.albums)) {
    for (const name of namesOfAlbum(album)) {
      const s = slot(name)
      s.albums += 1
      s.photos += num(album.count)
      if (!s.coverRel && album.cover) s.coverRel = text(album.cover)
      // mtime 三处都能给：people[].mtime（优先，后端聚合值）/ albums[].mtime / videos[].mtime。
      // 这里全部取 max —— 谁先到都一样，「最近更新」= 名下任一相册 / 视频里最新的那个时间。
      s.mtime = Math.max(s.mtime, toMs(album.mtime))
    }
  }

  for (const video of list(index && index.videos)) {
    for (const node of list(video && video.persons)) {
      const name = labelOf(node)
      if (!name) continue
      const s = slot(name)
      s.videos += 1
      if (!s.posterId && video.id != null && video.id !== '') s.posterId = String(video.id)
      s.mtime = Math.max(s.mtime, toMs(video.mtime))
    }
  }

  for (const person of list(index && index.people)) {
    const name = labelOf(person)
    if (!name) continue
    const s = slot(name)
    if (!s.coverRel && person.cover) s.coverRel = text(person.cover)
    // 索引按相册数遍历时上面已经累加过；这里只补「索引里 albums[] 与 people[] 不一致」的兜底
    const albumIds = list(person.albums)
    if (!s.albums && albumIds.length) s.albums = albumIds.length
    if (!s.albums) s.albums = num(person.count)
    if (!s.photos) s.photos = num(person.photos)
    s.mtime = Math.max(s.mtime, toMs(person.mtime))
  }

  return byName
}

/** 站内头像路径归一：http(s) / '//' / 以 '/' 开头原样用；否则当成站点根相对（后端约定「站内相对路径」） */
export function normalizeAvatarPath(raw) {
  const s = text(raw)
  if (!s) return ''
  if (/^https?:\/\//i.test(s) || s.indexOf('//') === 0) return s
  if (s.charAt(0) === '/') return s
  return '/' + s
}

/**
 * 显式头像 URL（P5.48）：「后端解析，前端不拼」—— 优先用后端给的 `avatarUrl`
 * （手动头像 photo 型后端已拼成 /api/media/thumb/p/<albumId>/<pad4(seq)>，url 型就是原始地址），
 * 老后端没有这个键时退回 `avatarPath` 自己归一（历史行为，一字不改）。
 * data: 内联图不能走 normalizeAvatarPath（会被加上 '/' 前缀变成无效地址），原样返回。
 */
export function explicitAvatarUrl(detail) {
  const resolved = text(detail && (detail.avatarUrl || detail.avatar_url))
  if (resolved) return /^data:/i.test(resolved) ? resolved : normalizeAvatarPath(resolved)
  return normalizeAvatarPath(detail && (detail.avatarPath || detail.avatar_path))
}

/**
 * 卡片头像：0 显式（手动 avatarUrl / 历史 avatarPath，kind = 'profile'）→ 1 相册封面 → 2 视频封面 → 3 首字占位。
 * @param {object} person   /persons 里的一条（id / name / alias）
 * @param {object} detail   /person/{id} 的响应（可空）
 * @param {object} stats    buildWallIndex() 里该人名的统计（可空）
 * @param {{thumbOf?:Function, videoThumb?:Function}} urls  URL 构造（页面注入 useMediaApi 的同名实现）
 * @returns {{url:string, kind:'profile'|'album'|'video'|'initial'}}
 */
export function avatarOf(person, detail, stats, urls) {
  const u = urls || {}
  const explicit = explicitAvatarUrl(detail)
  if (explicit) return { url: explicit, kind: 'profile' }
  if (stats && stats.coverRel && typeof u.thumbOf === 'function') {
    const url = u.thumbOf(stats.coverRel)
    if (url) return { url, kind: 'album' }
  }
  if (stats && stats.posterId && typeof u.videoThumb === 'function') {
    const url = u.videoThumb(stats.posterId)
    if (url) return { url, kind: 'video' }
  }
  return { url: '', kind: 'initial' }
}

/**
 * 数量行：`X 部视频 · Y 本相册 · Z 张照片`（三个数全 0 → 空串，卡片不渲染这一行）。
 * 部分为 0 仍保留（「0 部视频 · 144 本相册」本身就是有效信息）。
 */
export function countsText(videos, albums, photos) {
  const v = num(videos)
  const a = num(albums)
  const p = num(photos)
  if (!v && !a && !p) return ''
  return v + ' 部视频 · ' + a + ' 本相册 · ' + p + ' 张照片'
}

/**
 * 资料字段的「有值项」清单：[{key,label,value}]，顺序 = PROFILE_FIELDS。
 * 空 / 空串 / 纯空白一律算没填（后端 personDetail 对空值整键不输出，这里两种都吃）。
 * max 省略 = 不限条数（人物详情页要全量）；卡片走 profileChips（限 3）。
 */
export function profileFacts(detail, max) {
  const limit = max == null ? PROFILE_FIELDS.length : Math.max(0, num(max))
  const src = detail && typeof detail === 'object' ? detail : {}
  const out = []
  for (const field of PROFILE_FIELDS) {
    if (out.length >= limit) break
    const raw = src[field.key]
    if (raw == null) continue
    if (typeof raw === 'string' && !raw.trim()) continue
    const value = typeof field.fmt === 'function' ? field.fmt(raw) : String(raw)
    if (!value) continue
    out.push({ key: field.key, label: field.label, value })
  }
  return out
}

/** 卡片上单个 chip 的值最长多少字（P5.60，见 profileChips） */
export const CHIP_VALUE_MAX = 14

/**
 * 资料 chip（**卡片**用）：按 PROFILE_FIELDS 顺序取有值的前 max 个（默认 3）。
 * 拼装规则与详情页共用 profileFacts —— 「取哪几个 / 空值怎么算 / 单位怎么加」只有一份实现。
 *
 * P5.60：卡片那一行 chip **只排一行**（用户口径：加宽是为了「一行放得下」，不是为了「加高」），
 * 但库里真有超长值（深田咏美「三围 B87.8 / W63.5 / H91.1（2020 年時点）」一个字 30 字），
 * 一个 chip 就能吃掉整行、把另外两个挤成省略号。所以卡片层的值截到 {@link CHIP_VALUE_MAX} 字加省略号：
 * 「三围 B87.8 / W63…」。完整值不丢 —— chip 元素的 title 里有原文，详情页（profileFacts 不截断）给全量。
 * 详情页不走这条截断：那是「看资料」的地方，不该为了排版丢字。
 */
export function profileChips(detail, max) {
  return profileFacts(detail, max == null ? CHIP_MAX : max).map((f) => f.label + ' ' + clipValue(f.value, CHIP_VALUE_MAX))
}

/** 超长值截断（按 rune 截，不切坏代理对 / emoji）；未超长原样返回 */
export function clipValue(value, max) {
  const s = text(value)
  const limit = num(max)
  if (!limit || limit <= 0) return s
  const chars = Array.from(s)
  return chars.length <= limit ? s : chars.slice(0, limit).join('') + '…'
}

/** 别名：/persons 与 /person/{id} 两处都可能有，先取字典那份 */
export function aliasOf(person, detail) {
  return text((person && person.alias) || (detail && (detail.alias || detail.aliases)))
}

/**
 * 一条卡片的渲染数据（页面只做 v-for）。
 * @param {object} person /persons 里的一条
 * @param {{detail?:object, stats?:object, urls?:object}} ctx
 */
export function buildCard(person, ctx) {
  const c = ctx || {}
  const detail = c.detail || null
  const stats = c.stats || null
  const name = text(person && person.name)
  const counts = countsText(
    stats ? stats.videos : detail && detail.videoCount,
    stats ? stats.albums : detail && detail.albumCount,
    stats ? stats.photos : 0
  )
  const mtime = stats ? stats.mtime : 0
  const day = formatDay(mtime)
  return {
    key: personKey(person),
    id: person && person.id != null ? person.id : '',
    name,
    alias: aliasOf(person, detail),
    initial: initialOf(name),
    avatar: avatarOf(person, detail, stats, c.urls),
    counts,
    chips: profileChips(detail),
    recent: day ? '最近 ' + day : ''
  }
}
