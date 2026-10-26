/**
 * playbackContext.js —— 播放上下文（P5.32）的纯逻辑层（无 Vue / 无 DOM / 无网络）
 *
 * 用途：把「从哪个列表点进来」这件事固化成一份**快照**，让播放器的上/下一部、信息栏置顶的
 *       「播放列表」分区、键盘 P/N 三处共用同一份有序 id 与同一下标，口径只此一处。
 *
 * 上下文形状（页面 openPlayer 时构造一次，之后随片切换只重算 index）：
 *   { ids: string[], index: number, total: number, source, name, playlistId,
 *     hasPrev, hasNext, prevId, nextId }
 *
 * 来源优先级（高 → 低，见 pickPlaybackContext）：
 *   1) playlist —— URL ?playlist=<id>：服务端给的有序条目，顺序即播放顺序；
 *   2) browse   —— 媒体库当前筛选 + 排序结果（视频首页那张网格的完整顺序，不是可见页）；
 *   3) recent   —— 「最近观看」条（唯一能点进播放器的非网格入口）；
 *   4) library  —— 全库索引序：深链进来的片子不在当前筛选里时仍能照旧上/下一部。
 *   都没有 → null（context 缺失：上/下一部禁用，不报错）。
 *
 * 性能：id 列表上限 CONTEXT_MAX = 1000（去重后截断），只存 id 字符串，不存视频对象。
 */
import { toId, uniqIds } from './playlistOrder.js'

/** 上下文 id 列表上限（性能闸门：面板要渲染、上/下一部要 indexOf） */
export const CONTEXT_MAX = 1000

/** 来源枚举（字符串常量，便于面板与单测断言，也便于日志里读） */
export const CTX_PLAYLIST = 'playlist'
export const CTX_BROWSE = 'browse'
export const CTX_RECENT = 'recent'
export const CTX_LIBRARY = 'library'
/** 面板标题文案里「没有上下文」的那一档 */
export const CTX_NONE = 'none'

/** 来源展示前缀（信息栏置顶分区标题下那一行） */
export const CTX_SOURCE_LABEL = {
  [CTX_PLAYLIST]: '来自播放列表',
  [CTX_BROWSE]: '按当前浏览顺序',
  [CTX_RECENT]: '按最近观看顺序',
  [CTX_LIBRARY]: '全部视频'
}

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
 * 顺序由调用方给（页面按 playlist → browse → recent → library 排好），这里只做「第一个命中」，
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
 * 面板行数据：序号用**上下文里的真实下标**（1 起），这样面板上的第 N 条与上/下一部一致；
 * 索引里查不到的 id（视频已下架 / 索引未加载完）直接跳过 —— 面板不提供点不动的行。
 * @param {object} ctx
 * @param {(id:string)=>string|undefined} titleOf 取标题；返回空/undefined 视为查不到
 * @returns {Array<{id:string, n:number, title:string, current:boolean}>}
 */
export function contextRows(ctx, titleOf) {
  if (!ctx || !Array.isArray(ctx.ids) || !ctx.ids.length) return []
  const fn = typeof titleOf === 'function' ? titleOf : null
  const out = []
  for (let i = 0; i < ctx.ids.length; i++) {
    const id = ctx.ids[i]
    const title = fn ? fn(id) : id
    if (title == null || title === '') continue
    out.push({ id: id, n: i + 1, title: String(title), current: i === ctx.index })
  }
  return out
}

/**
 * 置顶分区的来源说明（面板标题下那一行）。
 *   播放列表 → 「来自播放列表：XXX · 共 N 条」
 *   其它来源 → 「按当前浏览顺序 · 共 N 条」（无播放列表时的默认口径 = 播放前的页面视频排序）
 * @param {object|null} ctx
 * @returns {string}
 */
export function contextLabel(ctx) {
  if (!ctx || !Array.isArray(ctx.ids) || ctx.index < 0) return '未记录播放上下文 · 上/下一部不可用'
  const head = CTX_SOURCE_LABEL[ctx.source] || CTX_SOURCE_LABEL[CTX_LIBRARY]
  const body = ctx.source === CTX_PLAYLIST ? head + '：' + (ctx.name || '未命名列表') : head
  return body + ' · 共 ' + ctx.total + ' 条'
}

export default {
  CONTEXT_MAX,
  CTX_PLAYLIST,
  CTX_BROWSE,
  CTX_RECENT,
  CTX_LIBRARY,
  CTX_NONE,
  CTX_SOURCE_LABEL,
  normalizeContextIds,
  makePlaybackContext,
  pickPlaybackContext,
  navFromContext,
  stepContextId,
  contextRows,
  contextLabel
}
