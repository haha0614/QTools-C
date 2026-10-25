/**
 * personRules.js —— 人物（演员）相关的纯逻辑：素人判定 / 归一化 / 提交体组装
 *
 * 口径（唯一出处，卡片与信息抽屉共用）：
 *   - 索引 videos[].persons = [{id,name,role}]（P3-A，非空才输出）；
 *   - 索引 videos[].actors  = [name]（旧「演员」facet，键恒存在，可能为空数组）；
 *   - **「素人」是真实人物**（后端建 name='素人' 的人物，并把没有真演员的视频都绑上它）：
 *     卡片 / 抽屉按普通人物渲染，不再伪造占位；
 *   - 兜底：个别视频 persons 仍为空（索引缓存旧 / 后端升级中）时，前端补一个素人 chip；
 *     若此时 actors 还有值，就先显示真实演员名（persons=[] actors=[x] 不是素人）；
 *   - **素人与真人互斥**：集合里只要有真人，素人自动剔除；真人全被移除则自动回到素人
 *     （normalizeSelection 是唯一入口，返回 removedAmateur 供上层提示）；
 *   - 提交体沿用管理端契约（PUT /api/media/admin/videos/{id}/persons）：
 *     { personIds:[Long], roles:{ personId: 角色 } }，roles 键必须属于本次 personIds，
 *     值 <= 32 字符；站端 PUT /api/media/video/{id}/persons 同构（见 personApi.js）。
 *
 * 纯函数、无 Vue / 无网络依赖，单测见 personRules.test.mjs。
 */

/** 角色长度上限：与后端 MediaBodyParser.rolesValue 的校验一致 */
export const PERSON_ROLE_MAX = 32

/** 素人这个「人物」的名字（后端同一字符串） */
export const AMATEUR_NAME = '素人'

/** 纯名字列表也算「具名条目」：素人判定对 persons / actors 复用同一份判断 */
function namedList(list) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(list) ? list : []) {
    const raw = typeof item === 'string' ? { name: item } : item
    if (!raw || typeof raw !== 'object') continue
    const name = String(raw.name == null ? '' : raw.name).trim()
    if (!name) continue
    // 后端返回里 id 可能叫 personId（replaceVideoPersons 的 persons[] 用这个键）
    const id = raw.id != null ? raw.id : raw.personId != null ? raw.personId : null
    const key = id != null && String(id) !== '' ? 'id:' + String(id) : 'n:' + name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: id == null || String(id) === '' ? null : id,
      name,
      role: String(raw.role == null ? '' : raw.role).trim().slice(0, PERSON_ROLE_MAX)
    })
  }
  return out
}

/** 归一化：兼容 {id,name,role} / {personId,name,role} / 纯名字数组，丢掉空名字并按 id（或名字）去重 */
export function normalizePersons(list) {
  return namedList(list)
}

/** 是否至少有一个具名条目（persons 或 actors） */
export function hasNamedPerson(list) {
  return namedList(list).length > 0
}

/** 名字是不是素人 */
export function isAmateurName(name) {
  return String(name == null ? '' : name).trim() === AMATEUR_NAME
}

/** 真人（去掉素人） */
export function realPersons(list) {
  return namedList(list).filter((p) => !isAmateurName(p.name))
}

/** 从人物库里找素人这位「人物」（找不到返回 null：库未就绪 / 后端还没建） */
export function findAmateur(library) {
  return namedList(library).find((p) => isAmateurName(p.name)) || null
}

/**
 * 素人判定（**兜底**语义，person 已就绪时不会用到）：
 * persons 与 actors 都为空 → 前端补一个素人 chip。
 * @param {Array} persons 索引 / 本地覆盖里的 [{id,name,role}]
 * @param {Array} actors  索引里的 [name]
 */
export function isAmateur(persons, actors) {
  return !hasNamedPerson(persons) && !hasNamedPerson(actors)
}

/** 卡片 / 抽屉里「只有旧演员字段、没绑人物库」的名字：按名字去重，且排除已经在 persons 里的 */
export function orphanActors(persons, actors) {
  const known = new Set(namedList(persons).map((p) => p.name.toLowerCase()))
  const out = []
  for (const a of Array.isArray(actors) ? actors : []) {
    const name = String(a == null ? '' : a).trim()
    if (!name) continue
    const lower = name.toLowerCase()
    if (known.has(lower)) continue
    known.add(lower)
    out.push(name)
  }
  return out
}

/**
 * 素人 / 真人互斥的规整（唯一入口，选择器与抽屉保存都走这里）：
 *   - 有真人 → 只保留真人，removedAmateur 表示本次真的剔除了素人（上层据此提示「已自动移除『素人』」）；
 *   - 没有真人但有素人 → 只留一个素人；
 *   - 两者都没有 → 用人物库里的素人补回来；库里没有（未就绪 / 未升级）就返回空表，
 *     由卡片 / 抽屉的兜底 chip 显示素人（不向服务端提交空的 personIds，避免误删绑定）。
 * @param {Array} list     待提交 / 待展示的人物集合
 * @param {Array} [library] 人物库（GET /api/media/persons），用来取素人的 id
 * @returns {{persons:Array, removedAmateur:boolean}}
 */
export function normalizeSelection(list, library) {
  const all = namedList(list)
  const reals = all.filter((p) => !isAmateurName(p.name))
  const amateurs = all.filter((p) => isAmateurName(p.name))
  if (reals.length) return { persons: reals, removedAmateur: amateurs.length > 0 }
  if (amateurs.length) return { persons: amateurs.slice(0, 1), removedAmateur: false }
  const fromLib = findAmateur(library)
  if (fromLib) return { persons: [{ id: fromLib.id, name: AMATEUR_NAME, role: '' }], removedAmateur: false }
  return { persons: [], removedAmateur: false }
}

/** id 归一：数字串转数字（后端 personIds 是 Long），其余原样保留（本地临时 id 走不到服务端） */
export function toPersonId(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return isFinite(v) ? v : null
  const s = String(v).trim()
  if (!s) return null
  return /^\d+$/.test(s) ? Number(s) : s
}

/**
 * 组装 PUT 提交体：{ personIds, roles }
 *   - personIds：按当前顺序去重，数字串转数字；
 *   - roles：只放非空角色，键是 personId 的字符串形式（JSON 对象的键本来就是字符串）；
 *     多个人物各自角色都带上（主演 / 配角 / 客串），空角色不出现。
 * 没有 id 的条目（索引里纯名字形态的历史数据）无法写服务端，直接跳过。
 */
export function buildPersonsPayload(persons) {
  const personIds = []
  const roles = {}
  const seen = new Set()
  for (const p of namedList(persons)) {
    const id = toPersonId(p.id)
    if (id == null) continue
    const key = String(id)
    if (seen.has(key)) continue
    seen.add(key)
    personIds.push(id)
    if (p.role) roles[key] = p.role
  }
  return { personIds, roles }
}

/** 两个人列表是否等价（顺序 + id + 角色），用于「没改动就不发请求」 */
export function samePersons(a, b) {
  const x = namedList(a)
  const y = namedList(b)
  if (x.length !== y.length) return false
  return x.every((p, i) => String(p.id) === String(y[i].id) && p.name === y[i].name && p.role === y[i].role)
}

/**
 * 新建人物时后端是否「同名复用」：
 *   1) 响应体显式给了 reused / created / existing 标记；
 *   2) 否则以返回的 id 是否已经出现在本地人物库里为准（库比服务端旧 → 同名复用）。
 */
export function isReusedPerson(body, knownPersons) {
  const b = body && typeof body === 'object' ? body : null
  if (!b) return false
  if (b.reused === true || b.existing === true || b.created === false) return true
  const id = b.id != null ? b.id : b.personId
  if (id == null) return false
  return (Array.isArray(knownPersons) ? knownPersons : []).some((p) => {
    const pid = p && (p.id != null ? p.id : p.personId)
    return pid != null && String(pid) === String(id)
  })
}

export default {
  PERSON_ROLE_MAX,
  AMATEUR_NAME,
  normalizePersons,
  hasNamedPerson,
  isAmateurName,
  realPersons,
  findAmateur,
  isAmateur,
  orphanActors,
  normalizeSelection,
  toPersonId,
  buildPersonsPayload,
  samePersons,
  isReusedPerson
}
