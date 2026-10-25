/**
 * personLocal.js —— local 档的「演员编辑」本机覆盖（P5.3-B）
 *
 * 存储契约（键沿用 ms.org.* 家族，与 ms.org.<owner>.<videoId>（元信息）、
 * ms.orgtags.<owner>（本地标签库）并列，互不干扰）：
 *   ms.orgpersons.<ownerKey>.<videoId> → { persons:[{id?,name,role?}], at }
 *
 * 为什么不并进 ms.org.<owner>.<videoId>：那个键的结构由 useMediaLocalOrg 独占
 * （writeLocalMeta 只合并 rating / tags / markers，未知字段会在下一次写入时被丢掉），
 * 而且它被 listLocalIds() 当成「有本地覆盖的视频」计数，多一个字段会污染卡片「本地 N 条」。
 * 代价：页面上的「清除本地修改」（clearLocalOrg）默认清不到这批键 —— 由 clearAllLocalPersons
 * 在同一个按钮里一并清掉（见 VideoPage.onClearLocal）。
 *
 * 约定：只读写 localStorage，绝不发请求；隐私模式 / 配额满静默忽略。
 */
import { bumpLocalOrg } from '@/composables/useMediaLocalOrg'

const OWNER_STORE_KEY = 'ms.owner'
const PERSON_PREFIX = 'ms.orgpersons.'

function readOwnerKey() {
  try {
    return localStorage.getItem(OWNER_STORE_KEY) || 'anon'
  } catch {
    return 'anon'
  }
}

function prefix() {
  return PERSON_PREFIX + readOwnerKey() + '.'
}

/** 单条视频的本地演员覆盖的键（导出便于排查 / 单测） */
export function localPersonsKey(id) {
  return prefix() + String(id == null ? '' : id)
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
    /* 隐私模式 / 配额满：静默忽略，页面按乐观值渲染 */
  }
}

/**
 * 读单条本地演员覆盖（没有则 null）。
 * 返回 { persons, local:true } 形态，调用方与索引 persons 区分开：null = 没覆盖过。
 */
export function readLocalPersons(id) {
  const rec = readJson(localPersonsKey(id))
  if (!rec || !Array.isArray(rec.persons)) return null
  return { persons: rec.persons, local: true }
}

/** 写单条本地演员覆盖（整体替换，与 PUT 的「整体替换」语义一致），返回写入的 persons */
export function writeLocalPersons(id, persons) {
  const list = (Array.isArray(persons) ? persons : []).map((p) => ({
    id: p && p.id != null ? p.id : null,
    name: String((p && p.name) || ''),
    role: String((p && p.role) || '')
  }))
  writeJson(localPersonsKey(id), { persons: list, at: Date.now() })
  bumpLocalOrg()
  return list
}

/** 清掉本机全部演员覆盖（含其它 owner 遗留），返回清掉的条数 */
export function clearAllLocalPersons() {
  const mine = prefix()
  const doomed = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k) continue
      if (k.indexOf(mine) === 0 || k.indexOf(PERSON_PREFIX) === 0) doomed.push(k)
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
  if (doomed.length) bumpLocalOrg()
  return doomed.length
}

export default {
  localPersonsKey,
  readLocalPersons,
  writeLocalPersons,
  clearAllLocalPersons
}
