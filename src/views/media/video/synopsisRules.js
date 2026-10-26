/**
 * synopsisRules.js —— 作品简介 / 剧情梗概的**纯规则**（P5.38）
 *
 * 与后端 `MediaOrganizeServiceImpl.normalizeSynopsis` 同一套口径，两边必须逐字一致：
 *   1. 去首尾空白（含换行；U+00A0 / 全角空格这类「Zs 空格」也算空白）；
 *   2. 去掉空白后为空 = **清空**（不是存空串）；
 *   3. 长度按 **code point** 计（CJK / emoji 各算 1 个字符），上限 SYNOPSIS_MAX = 8000；
 *   4. 内部换行**原样保留**（渲染用 white-space: pre-wrap）。
 *
 * 这里不碰 Vue / DOM / localStorage：折叠行数、长度上限、三档分支都做成纯函数，
 * 组件只负责「调规则 + 渲染」，单测直接跑本文件（见 synopsisRules.test.mjs）。
 */

/** 字节层面的上限不是它：上限是**字符数**，与后端 SYNOPSIS_MAX 对齐 */
export const SYNOPSIS_MAX = 8000

/** 折叠阈值：超过这么多**逻辑行**就折叠 + 出「展开」按钮 */
export const SYNOPSIS_FOLD_LINES = 6

export const LEVEL_OFF = 'off'
export const LEVEL_LOCAL = 'local'
export const LEVEL_FULL = 'full'

/* Character.isWhitespace / isSpaceChar 的 JS 近似：\s 之外再补 Zs 与零宽 BOM，
   否则「复制粘贴来的正文首尾带 NBSP」会让「纯空白视为清空」失效（后端 stripSpaces 同理）。 */
const BLANK = /[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/

function isBlankChar(ch) {
  return BLANK.test(ch)
}

/**
 * 去首尾空白，内部换行原样保留（后端 stripSpaces 的 JS 版）
 * @param {*} raw
 * @returns {string} 一定返回字符串（null / undefined → ''）
 */
export function trimSynopsis(raw) {
  const text = raw == null ? '' : String(raw)
  let start = 0
  let end = text.length
  while (start < end && isBlankChar(text.charAt(start))) start++
  while (end > start && isBlankChar(text.charAt(end - 1))) end--
  return text.slice(start, end)
}

/**
 * 字符数（code point）：与后端 `String.codePointCount` 等价 ——
 * 一个 emoji（代理对）算 1 个字符，不能用 `String.length`（那是 UTF-16 码元数，会多算）。
 */
export function countSynopsisChars(text) {
  if (!text) return 0
  return Array.from(String(text)).length
}

/**
 * 保存前校验：唯一入口（组件保存按钮 / 计数提示都用它）
 * @param {*} raw 输入框里的原文
 * @returns {{ok:boolean, text:string, chars:number, error:string|null}}
 *   text —— 规范化后的正文（'' = 清空）；ok=false 时 text 仍是规范化后的值（便于展示字数）
 */
export function validateSynopsis(raw) {
  const text = trimSynopsis(raw)
  const chars = countSynopsisChars(text)
  if (chars > SYNOPSIS_MAX) {
    return { ok: false, text, chars, error: '简介最多 ' + SYNOPSIS_MAX + ' 字符，本次 ' + chars + ' 字符' }
  }
  return { ok: true, text, chars, error: null }
}

/** 逻辑行数：\r\n / \r / \n 都只算一次换行；空文本 0 行 */
export function countLines(raw) {
  const text = raw == null ? '' : String(raw)
  if (!text) return 0
  return text.split(/\r\n|\r|\n/).length
}

/**
 * 是否折叠：逻辑行数 > maxLines。
 *
 * 只按逻辑行判断是**故意**的：单行长文靠 CSS line-clamp 视觉截断（组件里还会按
 * scrollHeight 复测一次真实溢出，那一步依赖 DOM，不进纯函数）。
 */
export function shouldFold(raw, maxLines = SYNOPSIS_FOLD_LINES) {
  const limit = Number(maxLines) > 0 ? Number(maxLines) : SYNOPSIS_FOLD_LINES
  return countLines(raw) > limit
}

/**
 * 三档编辑策略 → 写入通道（与 VideoMetaPanel 里评分 / 标签 / 标记完全一致）
 *   off   → 'blocked'（只读：不显示编辑入口，写接口会 403）
 *   local → 'local'  （只写 localStorage，键见 synopsisLocal.js，不发请求）
 *   full  → 'server' （PUT /api/media/video/{id}/synopsis）
 * 未知档位按 full 处理（后端 resolve 也是「非法值回退 full」）。
 */
export function writeMode(level) {
  if (level === LEVEL_OFF) return 'blocked'
  if (level === LEVEL_LOCAL) return 'local'
  return 'server'
}

/** 是否给编辑入口（off 档没有；local / full 都有） */
export function canEditSynopsis(level) {
  return writeMode(level) !== 'blocked'
}

export default {
  SYNOPSIS_MAX,
  SYNOPSIS_FOLD_LINES,
  trimSynopsis,
  countSynopsisChars,
  validateSynopsis,
  countLines,
  shouldFold,
  writeMode,
  canEditSynopsis
}
