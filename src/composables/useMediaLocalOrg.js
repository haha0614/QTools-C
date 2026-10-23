/**
 * useMediaLocalOrg.js —— local 档的本地组织信息（评分 / 标签 / 标记）
 * 存储契约：
 *   ms.org.<ownerKey>.<videoId> → { rating?, tags?:[{id?,name,color?}], markers?:[{id,pos,label,color}], at }
 *   ms.orgtags.<ownerKey>       → [{id,name,color}]（local 档现场新建的标签）
 * 约定：
 *   1. 只读写 localStorage，绝不发请求（off 档不写、full 档不读）。
 *   2. 合并顺序固定为 索引 → 本地覆盖 → 渲染，mergeCardMeta 是唯一合并入口。
 *   3. 清缓存 / 换浏览器即丢，页面用 HINT_LOCAL 说明。
 */
import { ref } from 'vue'

const OWNER_STORE_KEY = 'ms.owner'
const META_PREFIX = 'ms.org.'
const TAG_PREFIX = 'ms.orgtags.'

/** 版本号：localStorage 本身不可侦测，任何写入后自增，供 computed 重算 */
export const localOrgVersion = ref(0)

export function bumpLocalOrg() {
  localOrgVersion.value += 1
}

function readOwnerKey() {
  try {
    return localStorage.getItem(OWNER_STORE_KEY) || 'anon'
  } catch {
    return 'anon'
  }
}

function metaPrefix() {
  return META_PREFIX + readOwnerKey() + '.'
}

function tagKey() {
  return TAG_PREFIX + readOwnerKey()
}

export function localMetaKey(id) {
  return metaPrefix() + String(id == null ? '' : id)
}

function readJson(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 隐私模式 / 配额满：静默忽略，页面仍可按乐观值渲染 */
  }
}

/* 一次性把当前 owner 的覆盖层读成表：卡片墙一次要算上百条，逐条 getItem 太贵 */
let snapshot = null
let snapshotVersion = -1
let snapshotOwner = ''

function snapshotMap() {
  const owner = readOwnerKey()
  if (snapshot && snapshotVersion === localOrgVersion.value && snapshotOwner === owner) return snapshot
  const out = {}
  const prefix = META_PREFIX + owner + '.'
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || k.indexOf(prefix) !== 0) continue
      const v = readJson(k)
      if (v && typeof v === 'object') out[k.slice(prefix.length)] = v
    }
  } catch {
    /* 隐私模式：等同没有本地覆盖 */
  }
  snapshot = out
  snapshotVersion = localOrgVersion.value
  snapshotOwner = owner
  return out
}

/** 读单条本地覆盖（没有则 null） */
export function readLocalMeta(id) {
  return snapshotMap()[String(id == null ? '' : id)] || null
}

/** 列出所有有本地覆盖的视频 id */
export function listLocalIds() {
  return Object.keys(snapshotMap())
}

/**
 * 写单条本地覆盖（按字段合并：rating / tags / markers 各自整体覆盖）
 * @param {string} id
 * @param {{rating?:number, tags?:Array, markers?:Array}} patch
 * @returns {object} 合并后的完整本地元信息
 */
export function writeLocalMeta(id, patch) {
  const key = localMetaKey(id)
  const cur = readJson(key) || {}
  const next = Object.assign({}, cur)
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'rating')) next.rating = Number(patch.rating) || 0
  if (patch && Array.isArray(patch.tags)) next.tags = patch.tags
  if (patch && Array.isArray(patch.markers)) next.markers = patch.markers
  next.at = Date.now()
  writeJson(key, next)
  bumpLocalOrg()
  return next
}

/** 本地新建的标签 */
export function readLocalTags() {
  const list = readJson(tagKey())
  return Array.isArray(list) ? list.filter((t) => t && t.id && t.name) : []
}

/** 本地新建标签（同名复用），返回 { id, name, color } */
export function addLocalTag(name, color) {
  const nm = String(name == null ? '' : name).trim()
  if (!nm) return null
  const list = readLocalTags()
  const hit = list.find((t) => String(t.name).toLowerCase() === nm.toLowerCase())
  if (hit) return hit
  const tag = { id: 'lt-' + nm + '-' + Date.now().toString(36), name: nm, color: color || '' }
  writeJson(tagKey(), list.concat([tag]))
  bumpLocalOrg()
  return tag
}

/** 清除本机全部本地修改（视频覆盖 + 本地标签），返回清掉的条数 */
export function clearLocalOrg() {
  const prefix = metaPrefix()
  const doomed = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k) continue
      if (k.indexOf(prefix) === 0 || k === tagKey()) doomed.push(k)
    }
  } catch {
    return 0
  }
  for (const k of doomed) {
    try {
      localStorage.removeItem(k)
    } catch {
      /* 忽略 */
    }
  }
  bumpLocalOrg()
  return doomed.length
}

/**
 * 合并顺序（唯一入口）：索引 → 本地覆盖 → 渲染
 * 索引里的 tags 是 [facet, name] 成对数组（或名称数组），本地覆盖里是 {id,name,color}；
 * 有本地覆盖时整体替换，避免两套形态混着拼接。
 */
export function mergeCardMeta(indexVideo, localMeta) {
  const v = indexVideo || {}
  const base = { rating: Number(v.rating) || 0, tags: v.tags || [], local: false }
  if (!localMeta || typeof localMeta !== 'object') return base
  return {
    rating: Object.prototype.hasOwnProperty.call(localMeta, 'rating') ? Number(localMeta.rating) || 0 : base.rating,
    tags: Array.isArray(localMeta.tags) ? localMeta.tags : base.tags,
    local: true
  }
}

export default {
  localOrgVersion,
  bumpLocalOrg,
  readLocalMeta,
  writeLocalMeta,
  listLocalIds,
  readLocalTags,
  addLocalTag,
  clearLocalOrg,
  mergeCardMeta
}
