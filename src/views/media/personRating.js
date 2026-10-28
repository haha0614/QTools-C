/**
 * personRating.js —— 「人物在该分级下有没有可见作品」的**纯逻辑**（P6.09）
 *
 * 为什么要单独一个模块：人物页的分级筛选判定有两份数据源，优先级不同但结论必须一致 ——
 *   1. 索引 {@code people[].byRating}（P6.09 后端新补：{@code {general:n, guidance:n, restricted:n}}，
 *      只统计**当前访客可见**的相册 + 视频，口径与 people[].count / videos 一致）；
 *   2. 老索引没有这个键时的**前端兜底**：从同一份索引里的 {@code albums[].contentRating} 与
 *      {@code videos[].contentRating} 反推（人物名 → 该档下的作品数）。
 *      没有兜底的话，后端还没升级的那段时间打开人物页会因为「查不到数据」把整面墙筛成空。
 *
 * 判定与计数都走 {@link matchesPersonRating} / {@link countPersonsByRating}，页面只负责渲染，
 * 单测（personRating.test.mjs）覆盖两种数据源与缺数据的放行分支。
 *
 * 约定：本模块不 import 任何运行时依赖（只 import 同目录的纯函数 contentRating.js），
 *       所以 node 直接跑单测不需要浏览器 / vue / axios。
 */
import { RATING_ALL, ratingOf } from './contentRating.js'

const list = (v) => (Array.isArray(v) ? v : [])
const text = (v) => (v == null ? '' : String(v).trim())
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 人物名的两种形态（索引里 albums[].persons 是字符串数组，videos[].persons 是 {id,name}） */
function labelOf(node) {
  if (node == null) return ''
  if (typeof node === 'string') return text(node)
  return text(node && node.name)
}

/** 相册名下的人物名：persons[] 优先，老数据只有单个 person */
function albumNames(album) {
  const many = list(album && album.persons).map(labelOf).filter(Boolean)
  if (many.length) return many
  const one = text(album && album.person)
  return one ? [one] : []
}

/** 视频名下的人物名 */
function videoNames(video) {
  return list(video && video.persons).map(labelOf).filter(Boolean)
}

function bump(map, name, rating, n) {
  let slot = map.get(name)
  if (!slot) {
    slot = Object.create(null)
    map.set(name, slot)
  }
  slot[rating] = (slot[rating] || 0) + n
}

/**
 * 人物名 → {@code {分级值: 可见作品数}}。
 *
 * @param {object} index GET /api/media/index 的响应
 * @returns {Map<string, Record<string, number>>} 没有任何可见作品的姓名不会出现在表里
 */
export function buildPersonRatings(index) {
  const map = new Map()
  const doc = index && typeof index === 'object' ? index : {}

  // 1) 后端 byRating 优先：只要有一条人物带这个键，就以它为准（口径由后端统一算好，前端不再二次推导）
  let fromBackend = false
  for (const person of list(doc.people)) {
    const name = text(person && person.name)
    const byRating = person && person.byRating
    if (!name || !byRating || typeof byRating !== 'object') continue
    fromBackend = true
    for (const key of Object.keys(byRating)) {
      const n = num(byRating[key])
      if (n > 0) bump(map, name, key, n)
    }
  }
  if (fromBackend) return map

  // 2) 兜底：老索引没有 byRating → 从可见相册 / 视频反推（索引里没有的条目本来就不该计入）
  for (const album of list(doc.albums)) {
    const rating = ratingOf(album)
    for (const name of albumNames(album)) bump(map, name, rating, 1)
  }
  for (const video of list(doc.videos)) {
    const rating = ratingOf(video)
    for (const name of videoNames(video)) bump(map, name, rating, 1)
  }
  return map
}

/**
 * 该人物在指定分级下的可见作品数（0 = 不该出现在筛选结果里）。
 *
 * @param {Map} map buildPersonRatings 的返回值
 * @param {string} name 人物名（索引按名字关联）
 * @param {string} rating 分级值
 * @returns {number}
 */
export function personRatingCount(map, name, rating) {
  if (!map || typeof map.get !== 'function') return 0
  const slot = map.get(text(name))
  return slot ? num(slot[rating]) : 0
}

/**
 * 该人物是否属于当前分级。
 *
 * **缺数据一律放行**：表是空的（索引没到 / 老索引 + 没有作品行）时返回 true ——
 * 筛不出来的正确姿势是「先显示全部」，而不是「先显示空白」（与 normalizeRating 的回落方向一致）。
 *
 * @param {Map} map
 * @param {string} name
 * @param {string} rating
 * @returns {boolean}
 */
export function matchesPersonRating(map, name, rating) {
  if (!rating || rating === RATING_ALL) return true
  // 没有名字就没法关联到索引（判不了 ≠ 不该显示）：放行
  if (!text(name)) return true
  if (!map || typeof map.size !== 'number' || map.size === 0) return true
  return personRatingCount(map, name, rating) > 0
}

/**
 * 人物分级 chip 的计数：{@code {general: n, guidance: n}}（n = 该档下有可见作品的人物数）。
 *
 * @param {Array} people 人物列表（页面那份，已被调用方剔掉占位实体）
 * @param {Map} map buildPersonRatings 的返回值
 * @param {Array} ratings 可见分级值数组（顺序 = chip 顺序）
 * @returns {Record<string, number>}
 */
export function countPersonsByRating(people, map, ratings) {
  const out = {}
  const values = list(ratings)
  for (const value of values) out[value] = 0
  for (const person of list(people)) {
    const name = text(person && person.name)
    if (!name) continue
    for (const value of values) {
      if (personRatingCount(map, name, value) > 0) out[value] += 1
    }
  }
  return out
}
