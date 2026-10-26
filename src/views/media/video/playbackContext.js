/**
 * playbackContext.js —— 播放上下文（P5.32 引入，P5.35 来源驱动）的纯逻辑层（无 Vue / 无 DOM / 无网络）
 *
 * 用途：把「从哪个列表点进来」这件事固化成一份**快照**，让播放器的上/下一部、信息栏置顶的
 *       「播放列表」分区、键盘 P/N 三处共用同一份有序 id 与同一下标，口径只此一处。
 *
 * 上下文形状（页面 openPlayer 时构造一次，之后随片切换只重算 index）：
 *   { ids: string[], index: number, total: number, source, name, playlistId,
 *     hasPrev, hasNext, prevId, nextId }
 *   name = **来源名**（P5.35）：播放列表名 / 人物名 / 标签名；browse 等无来源名的档位留空。
 *
 * 来源优先级（高 → 低，见 pickPlaybackContext）：
 *   1) playlist —— URL ?playlist=<id>：服务端给的有序条目，顺序即播放顺序；
 *   2) person   —— 从人物详情页点进来：标题 = 人物名，顺序 = 该页展示的顺序（来源页给的有序快照）；
 *   3) tag      —— 媒体库按标签（单个筛选条件）筛过：标题 = 标签名，顺序 = 该筛选结果顺序；
 *   4) browse   —— 媒体库当前筛选 + 排序结果（视频首页那张网格的完整顺序，不是可见页）；
 *   5) recent   —— 「最近观看」条（唯一能点进播放器的非网格入口）；
 *   6) library  —— 全库索引序：深链进来的片子不在当前筛选里时仍能照旧上/下一部。
 *   都没有 → null（context 缺失：上/下一部禁用，不报错）。
 *
 * 性能：id 列表上限 CONTEXT_MAX = 1000（去重后截断），只存 id 字符串，不存视频对象。
 */
import { toId, uniqIds } from './playlistOrder.js'
// P5.35：面板行右侧的时长与列表页（VideoCard 的角标 / 进度条）**同一口径** ——
// 直接复用 playerExtras 的纯函数，不再在面板里复制一份 fmtDur（两份就会漂移）。
import { durText } from './playerExtras.js'

/** 上下文 id 列表上限（性能闸门：面板要渲染、上/下一部要 indexOf） */
export const CONTEXT_MAX = 1000

/** 来源枚举（字符串常量，便于面板与单测断言，也便于日志里读） */
export const CTX_PLAYLIST = 'playlist'
export const CTX_PERSON = 'person'
export const CTX_TAG = 'tag'
export const CTX_BROWSE = 'browse'
export const CTX_RECENT = 'recent'
export const CTX_LIBRARY = 'library'
/** 面板标题文案里「没有上下文」的那一档 */
export const CTX_NONE = 'none'

/**
 * 来源兜底名（P5.35）：只有在**来源名为空**时才用得上 ——
 * 例如播放列表详情没读回来（name=''），标题就退化成「播放列表 · 共 N 条」而不是一句空话。
 * 有来源名时标题行一律是「<来源名> · 共 N 条」（用户需求 7：来源是什么就叫什么）。
 */
export const CTX_SOURCE_LABEL = {
  [CTX_PLAYLIST]: '播放列表',
  [CTX_PERSON]: '人物',
  [CTX_TAG]: '标签筛选',
  [CTX_BROWSE]: '按当前浏览顺序',
  [CTX_RECENT]: '按最近观看顺序',
  [CTX_LIBRARY]: '全部视频'
}

/** 上下文缺失（深链没带来源 / 索引没加载出来）时分区里那句话，只说明不报错 */
export const CTX_NONE_TEXT = '未记录播放上下文 · 上/下一部不可用'

/**
 * 来源快照的 sessionStorage 键（P5.35）：人物页在跳转前把「该页的有序 id」写进来，
 * VideoPage 打开播放器时读回来 —— 顺序与标题都不必挤进 URL。
 * 为什么是 sessionStorage 而不是 localStorage：它天然按标签页隔离、关页即清，
 * 不会让「上周从人物页点过」的旧顺序在今天从地址栏直接打开时生效。
 */
export const CTX_SNAPSHOT_KEY = 'ms.pbctx'
/** 快照有效期：超过就不再采用（防止同一标签页里很久以前的来源名 / 顺序被当成这次的） */
export const CTX_SNAPSHOT_TTL = 60 * 60 * 1000

/**
 * 归一化：字符串 / 对象（{id}）混合 → 去空去重的字符串 id，按原顺序保留；超过上限截断。
 * 顺序绝不重排（顺序就是播放顺序，与 playlistOrder.uniqIds 同一口径）。
 * @param {Array} list
 * @param {number} [max]
 * @returns {string[]}
 */
export function normalizeContextIds(list, max) {
  const cap = max == null ? CONTEXT_MAX : Number(max)
  const out = uniqIds(list)
  return cap > 0 && out.length > cap ? out.slice(0, cap) : out
}

/**
 * 构造一份播放上下文快照。
 * index = 当前片在 ids 里的下标；不在列表里即 -1（此时 hasPrev/hasNext 都是 false，
 * 页面应改用下一优先级来源，或按「上下文缺失」处理）。
 * @param {Array} ids 有序 id（或视频对象数组）
 * @param {string} currentId
 * @param {{source?:string, name?:string, playlistId?:string, max?:number}} [opts]
 */
export function makePlaybackContext(ids, currentId, opts) {
  const o = opts || {}
  const list = normalizeContextIds(ids, o.max)
  const id = toId(currentId)
  const i = id ? list.indexOf(id) : -1
  return {
    ids: list,
    index: i,
    total: list.length,
    source: o.source == null ? CTX_NONE : String(o.source),
    name: o.name == null ? '' : String(o.name),
    playlistId: o.playlistId == null ? '' : String(o.playlistId),
    hasPrev: i > 0,
    hasNext: i >= 0 && i < list.length - 1,
    prevId: i > 0 ? list[i - 1] : '',
    nextId: i >= 0 && i < list.length - 1 ? list[i + 1] : ''
  }
}

/**
 * 按来源优先级挑第一份**确实包含当前片**的列表。
 * 顺序由调用方给（页面按 playlist → person → tag → browse → recent → library 排好），这里只做「第一个命中」，
 * 所以优先级口径在页面上是一行字，单测里可以任意排列验证。
 * @param {Array<{source:string, ids:Array, name?:string, playlistId?:string}>} sources
 * @param {string} currentId
 * @param {number} [max]
 * @returns {object|null} 上下文快照；都不包含当前片则 null
 */
export function pickPlaybackContext(sources, currentId, max) {
  const id = toId(currentId)
  if (!id) return null
  for (const s of sources || []) {
    if (!s || !Array.isArray(s.ids) || !s.ids.length) continue
    const ctx = makePlaybackContext(s.ids, id, {
      source: s.source,
      name: s.name,
      playlistId: s.playlistId,
      max: max
    })
    if (ctx.index >= 0) return ctx
  }
  return null
}

/**
 * 播放器可用的上/下状态：页面 navState 直接用这一份 —— 「上下文缺失 ⇒ 两个方向都禁用」只有这一个判定点，
 * 缺上下文 / 当前片不在上下文里都返回禁用，调用方不必另写兜底分支。
 * @param {object|null} ctx
 * @returns {{hasPrev:boolean, hasNext:boolean, ids:string[], i:number, source:string}}
 */
export function navFromContext(ctx) {
  if (!ctx || !Array.isArray(ctx.ids) || ctx.index < 0) {
    return { hasPrev: false, hasNext: false, ids: [], i: -1, source: '' }
  }
  return { hasPrev: ctx.hasPrev, hasNext: ctx.hasNext, ids: ctx.ids, i: ctx.index, source: ctx.source }
}

/**
 * 在上下文里前进 / 后退一步（dir = -1 上一条，+1 下一条）。
 * 越界返回 ''（调用方据此禁用按钮），绝不跳出上下文。
 * @param {object} ctx
 * @param {number} dir
 * @returns {string} 目标 id，或 ''
 */
export function stepContextId(ctx, dir) {
  if (!ctx || !Array.isArray(ctx.ids) || ctx.index < 0) return ''
  const j = ctx.index + (dir < 0 ? -1 : 1)
  return j >= 0 && j < ctx.ids.length ? ctx.ids[j] : ''
}

/**
 * 面板行数据（P5.35 起一行带齐「缩略图 + 序号 + 标题 + 时长」）。
 * 序号用**上下文里的真实下标**（1 起），这样面板上的第 N 条与上/下一部一致；
 * 索引里查不到的 id（视频已下架 / 索引未加载完）直接跳过 —— 面板不提供点不动的行。
 *
 * infoOf 的两种返回形态都收（向后兼容 P5.32 的调用点与单测）：
 *   - 字符串 → 只当标题，时长 / 缩略图留空（旧调用口径）；
 *   - 对象 { title, dur, thumb } → 全字段；缺字段按空值处理，duration 走 playerExtras.durText。
 *
 * @param {object} ctx
 * @param {(id:string)=>({title?:string, dur?:number, thumb?:string}|string|undefined|null)} infoOf
 * @returns {Array<{id:string, n:number, title:string, dur:number, durText:string, thumb:string, current:boolean}>}
 */
export function contextRows(ctx, infoOf) {
  if (!ctx || !Array.isArray(ctx.ids) || !ctx.ids.length) return []
  const fn = typeof infoOf === 'function' ? infoOf : null
  const out = []
  for (let i = 0; i < ctx.ids.length; i++) {
    const id = ctx.ids[i]
    const info = fn ? fn(id) : id
    if (info == null) continue
    const isStr = typeof info === 'string'
    const title = isStr ? info : info.title
    if (title == null || title === '') continue
    const dur = isStr || info.dur == null ? 0 : Number(info.dur) || 0
    out.push({
      id: id,
      n: i + 1,
      title: String(title),
      dur: dur,
      // 时长文案与列表页角标同口径（0 / 未知 → --:--），页面不必再算一次
      durText: durText(dur),
      thumb: isStr || info.thumb == null ? '' : String(info.thumb),
      current: i === ctx.index
    })
  }
  return out
}

/**
 * 置顶分区的标题行（P5.35 用户需求 7）：**来源名 · 共 N 条**，四种来源同一个句式。
 *   播放列表 → 「周末片单 · 共 3 条」
 *   人物     → 「深田咏美 · 共 12 条」
 *   标签筛选 → 「ASMR · 共 8 条」
 *   一般浏览 → 「按当前浏览顺序 · 共 8 条」
 * 来源名为空时退化成来源兜底名（播放列表 / 人物 / 标签筛选），绝不留空标题。
 * @param {object|null} ctx
 * @returns {string}
 */
export function contextLabel(ctx) {
  if (!ctx || !Array.isArray(ctx.ids) || ctx.index < 0) return CTX_NONE_TEXT
  const named = String(ctx.name || '').trim()
  const head = named || CTX_SOURCE_LABEL[ctx.source] || CTX_SOURCE_LABEL[CTX_LIBRARY]
  return head + ' · 共 ' + ctx.total + ' 条'
}

/**
 * 「当前筛选条件」能否当作来源名（P5.35：从标签筛选进入 → 标题 = 标签名）。
 * 口径：全部筛选条件（各 facet 的选中值 + 分类）加起来**恰好一个**才认 ——
 *   0 个（一般浏览）或多于 1 个（组合筛选）都返回 ''，标题回落到「按当前浏览顺序」，
 *   因为组合条件下没有「一个能代表这批结果的名字」，硬取第一个会骗人。
 * @param {{facets?:Object<string,string[]>, cats?:string[]}} st
 * @returns {string}
 */
export function filterSourceName(st) {
  const s = st || {}
  const names = []
  const facets = s.facets && typeof s.facets === 'object' ? s.facets : {}
  for (const k of Object.keys(facets)) {
    const arr = facets[k]
    if (!Array.isArray(arr)) continue
    for (const v of arr) if (v != null && String(v) !== '') names.push(String(v))
  }
  const cats = Array.isArray(s.cats) ? s.cats : []
  for (const c of cats) if (c != null && String(c) !== '') names.push(String(c))
  const uniq = names.filter((n, i) => names.indexOf(n) === i)
  return uniq.length === 1 ? uniq[0] : ''
}

/**
 * 写来源快照（来源页 → 播放页的唯一通道；storage 由调用方注入，便于单测用假实现）。
 * 只收「来源 + 来源名 + 有序 id」，其它字段一律不进快照（不存视频对象，避免过期数据）。
 * @param {{setItem:(k:string,v:string)=>void}} storage sessionStorage
 * @param {{source?:string, name?:string, ids?:Array}} snap
 * @param {number} [now]
 * @returns {boolean} 是否写入成功（隐私模式 / 配额满 → false，调用方不必 try/catch）
 */
export function writeContextSnapshot(storage, snap, now) {
  const s = snap || {}
  const source = String(s.source == null ? '' : s.source)
  const name = String(s.name == null ? '' : s.name)
  const ids = normalizeContextIds(Array.isArray(s.ids) ? s.ids : [])
  if (!source || source === CTX_NONE || !ids.length) return false
  try {
    storage.setItem(
      CTX_SNAPSHOT_KEY,
      JSON.stringify({ source: source, name: name, ids: ids, ts: now == null ? Date.now() : Number(now) })
    )
    return true
  } catch {
    return false
  }
}

/**
 * 读来源快照：来源 / 来源名 / 有效期三关都对上才返回 { source, name, ids }，否则 null。
 * 「对不上就当没有」是刷新与深链的降级口径：页面拿到 null 就不使用该来源，
 * 标题与顺序一起回落到下一档（一般是 browse → library），不会出现「标题是人物名、顺序是全库」的半吊子状态。
 * @param {{getItem:(k:string)=>string|null}} storage sessionStorage
 * @param {string} source
 * @param {string} [name]
 * @param {number} [now]
 * @returns {{source:string, name:string, ids:string[]}|null}
 */
export function readContextSnapshot(storage, source, name, now) {
  const want = String(source == null ? '' : source)
  const wantName = String(name == null ? '' : name)
  if (!want || want === CTX_NONE) return null
  try {
    const raw = storage.getItem(CTX_SNAPSHOT_KEY)
    if (!raw) return null
    const o = JSON.parse(raw)
    if (!o || typeof o !== 'object') return null
    if (String(o.source || '') !== want) return null
    if (String(o.name || '') !== wantName) return null
    const ts = Number(o.ts) || 0
    const t = now == null ? Date.now() : Number(now)
    if (!ts || !isFinite(t) || t - ts > CTX_SNAPSHOT_TTL || t - ts < 0) return null
    const ids = normalizeContextIds(Array.isArray(o.ids) ? o.ids : [])
    return ids.length ? { source: want, name: wantName, ids: ids } : null
  } catch {
    return null
  }
}

export default {
  CONTEXT_MAX,
  CTX_PLAYLIST,
  CTX_PERSON,
  CTX_TAG,
  CTX_BROWSE,
  CTX_RECENT,
  CTX_LIBRARY,
  CTX_NONE,
  CTX_SOURCE_LABEL,
  CTX_NONE_TEXT,
  CTX_SNAPSHOT_KEY,
  CTX_SNAPSHOT_TTL,
  normalizeContextIds,
  makePlaybackContext,
  pickPlaybackContext,
  navFromContext,
  stepContextId,
  contextRows,
  contextLabel,
  filterSourceName,
  writeContextSnapshot,
  readContextSnapshot
}
