/**
 * synopsisLocal.js —— local 档的「作品简介」本机覆盖（P5.38）
 *
 * 存储契约（键沿用 ms.org.* 家族，与 ms.org.<owner>.<videoId>（评分/标签/标记）、
 * ms.orgtags.<owner>（本地标签库）、ms.orgpersons.<owner>.<videoId>（本地演员）并列）：
 *   ms.orgsynopsis.<ownerKey>.<videoId> → { synopsis, at }
 *
 * 为什么不并进 ms.org.<owner>.<videoId>：那个键的结构由 useMediaLocalOrg 独占
 * （writeLocalMeta 只合并 rating / tags / markers，未知字段下一次写入就被丢掉），
 * 而且 listLocalIds() 把它当成「有本地覆盖的视频」计数，多一个字段会污染卡片「本地 N 条」。
 * 与 personLocal.js 采用同一套理由与同一套清理方式：
 * 「清除本地修改」按钮由 clearAllLocalSynopsis() 一并清（见 VideoPage.onClearLocal）。
 *
 * 约定：只读写 localStorage，绝不发请求；隐私模式 / 配额满静默忽略。
 */
import { bumpLocalOrg } from '@/composables/useMediaLocalOrg'

const OWNER_STORE_KEY = 'ms.owner'
const SYNOPSIS_PREFIX = 'ms.orgsynopsis.'

function readOwnerKey() {
  try {
    return localStorage.getItem(OWNER_STORE_KEY) || 'anon'
  } catch {
    return 'anon'
  }
}

function prefix() {
  return SYNOPSIS_PREFIX + readOwnerKey() + '.'
}

/** 单条视频的本地简介键（导出便于排查 / 单测） */
export function localSynopsisKey(id) {
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
 * 读单条本地简介（没有则 null）
 * @returns {{synopsis:string, local:true}|null} null = 本机没覆盖过（用索引 / 服务端的值）
 */
export function readLocalSynopsis(id) {
  const rec = readJson(localSynopsisKey(id))
  if (!rec || typeof rec.synopsis !== 'string') return null
  return { synopsis: rec.synopsis, local: true }
}

/** 写单条本地简介（空串 = 本机清空，仍算「有覆盖」），返回规范化后的正文 */
export function writeLocalSynopsis(id, synopsis) {
  const text = synopsis == null ? '' : String(synopsis)
  writeJson(localSynopsisKey(id), { synopsis: text, at: Date.now() })
  bumpLocalOrg()
  return text
}

/** 清掉本机全部简介覆盖（含其它 owner 遗留），返回清掉的条数 */
export function clearAllLocalSynopsis() {
  const doomed = []
  try {
    // 前缀按全部 owner 清：换过设备标识的旧键也一并清掉，不只清当前 owner
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.indexOf(SYNOPSIS_PREFIX) === 0) doomed.push(k)
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
  localSynopsisKey,
  readLocalSynopsis,
  writeLocalSynopsis,
  clearAllLocalSynopsis
}
