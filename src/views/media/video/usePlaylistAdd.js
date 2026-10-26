/**
 * usePlaylistAdd.js —— 「加入播放列表」的共享数据源与写入口（P5.1 抽出，供两个入口复用）
 * 谁在用：video/PlaylistPicker.vue（工具栏批量入口，居中弹层）
 *         video/VideoCard.vue（卡片右下角入口，锚在按钮上方的轻量菜单）
 * 一根线：GET /api/media/playlists 拉清单 → POST /api/media/playlist/{id}/videos 追加（后端按 id 幂等去重）
 *         → POST /api/media/playlists 新建（**只发 name**，视频随后单独追加：后端 create 从不读 videoIds）
 * 闸门：level=off 直接不给入口（两个入口都在自己的模板里拦）；level=local 由本模块给出统一文案并禁写，
 *       因为播放列表只存在服务端，本地档没有 localStorage 兜底 —— 与工具栏入口保持同一句话。
 * 失败：全部 silent + try/catch，不抛未捕获异常；文案由 playlistWrite.describePlaylistError 按
 *       「HTTP 状态 + 后端 {"error":…} 原文」分级给出（400 参数 / 403 策略 / 404 未就绪 / 409 / 超时 / 断网）。
 *       P5.41 之前所有失败都写成「接口未就绪或网络异常」，把「后端只认 videoId」的 400 藏成了假网络故障。
 * 已加入：清单条目自带 videoIds 时按内联 id 判定（playlistOrder.playlistMembership，零额外请求）；
 *        不带内联 id 的清单退化为「本会话内刚加入过」的内存标记（模块级 Set，卡片卸载重挂仍有效）。
 */
import { computed, ref, toValue } from 'vue'
import { useMediaApi } from '@/composables/useMediaApi'
import { normalizePlaylistList, playlistMembership } from './playlistOrder'
import { addOutcome, countAdded, describePlaylistError } from './playlistWrite'

/** local 档统一文案：与工具栏入口同一句（含「不会写入服务端」的事实说明） */
export const PL_HINT_LOCAL =
  '本地编辑：不会写入服务端 —— 播放列表保存在服务端，本地档不可写，请切到「完整编辑」档再试。'
/** 接口未就绪：菜单/弹层内展示的一句提示（不弹全局错误）；只在拿不到具体错误时兜底 */
export const PL_HINT_UNAVAILABLE = '播放列表接口未就绪（GET /api/media/playlists）'
/** 空清单文案 */
export const PL_HINT_EMPTY = '还没有播放列表'

/** 本会话内刚加入成功过的「列表id::视频id」：清单接口不给内联 videoIds 时唯一的已加入线索 */
const sessionJoined = new Set()
const joinKey = (playlistId, videoId) => String(playlistId) + '::' + String(videoId)

/** 默认新列表名：我的列表 YYYY-MM-DD（本地时区；纯函数，便于 Node 单测） */
export function defaultPlaylistName(now) {
  const d = now instanceof Date ? now : new Date()
  const p2 = (n) => (n < 10 ? '0' : '') + n
  return '我的列表 ' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
}

/** 成功提示：两个入口共用同一句话，避免两套文案 */
export function addedMessage(name, n) {
  return '已加入播放列表「' + name + '」：' + n + ' 个视频'
}

export function createdMessage(name, n) {
  return '已新建播放列表「' + name + '」并加入 ' + n + ' 个视频'
}

/** 幂等命中：目标视频本来就在这个列表里（后端 200 + added=false，不是失败） */
export function alreadyMessage(name) {
  return '「' + name + '」里已经有这些视频，无需重复加入'
}

/**
 * @param {object} options
 * @param {import('vue').MaybeRefOrGetter<string>} [options.level] 编辑策略档位（off/local/full）
 * @param {import('vue').MaybeRefOrGetter<string[]>} [options.videoIds] 要加入的视频 id（单条或批量）
 * @param {(msg: string) => void} [options.notify] 提示出口（页面 toast）
 */
export function usePlaylistAdd(options = {}) {
  const api = useMediaApi()
  const notify = (msg) => {
    if (typeof options.notify === 'function') options.notify(msg)
  }

  const loading = ref(false)
  const items = ref([])
  /** 非空 = 读取失败的可读提示（按错误分级，不再是一句笼统的「接口未就绪」） */
  const unavailable = ref('')
  /** 正在提交的播放列表 id（'__new' 表示新建中）；非空时列表按钮全禁用，防重复提交 */
  const busyId = ref('')
  const newName = ref('')
  /** 菜单内是否已展开「新建」输入态 */
  const creating = ref(false)
  /** 上一次写操作的真实结果：added=实际新增条数，already=本来就在里面（幂等命中） */
  const lastAdd = ref({ added: 0, requested: 0, already: false })

  const level = computed(() => String(toValue(options.level) || 'full'))

  function targetIds() {
    const raw = toValue(options.videoIds)
    const arr = Array.isArray(raw) ? raw : []
    return arr.map((v) => String(v == null ? '' : v)).filter(Boolean)
  }

  const targetCount = computed(() => targetIds().length)

  /** off 档不给入口；local 档给统一文案并禁写（播放列表无 localStorage 兜底） */
  const blocked = computed(() => (level.value === 'local' ? PL_HINT_LOCAL : ''))

  const canCreate = computed(
    () => !!String(newName.value || '').trim() && !busyId.value && !blocked.value && !unavailable.value
  )

  function markJoined(playlistId) {
    const ids = targetIds()
    for (const id of ids) sessionJoined.add(joinKey(playlistId, id))
  }

  function joinedNow(playlistId) {
    const ids = targetIds()
    return ids.length > 0 && ids.every((id) => sessionJoined.has(joinKey(playlistId, id)))
  }

  /** 拉一次清单：失败按错误分级记提示（调用方仍可尝试新建） */
  async function load() {
    loading.value = true
    unavailable.value = ''
    try {
      const res = await api.listPlaylists({ silent: true })
      const list = normalizePlaylistList(res)
      const inline = playlistMembership(res, targetIds())
      items.value = list.map((p) => ({ ...p, joined: !!inline[p.id] || joinedNow(p.id) }))
    } catch (err) {
      items.value = []
      unavailable.value = err ? describePlaylistError(err, 'load') : PL_HINT_UNAVAILABLE
    } finally {
      loading.value = false
    }
  }

  /** 展开菜单内新建输入态：默认名先填好，用户可直接回车 */
  function openCreate() {
    if (blocked.value || unavailable.value || busyId.value) return
    if (!String(newName.value || '').trim()) newName.value = defaultPlaylistName()
    creating.value = true
  }

  function closeCreate() {
    creating.value = false
  }

  /**
   * 把 ids 追加到列表，并返回「这次到底新加了几条」。
   *
   * 一次批量请求打过去（新后端：{videoIds:[…]} 一次加完）；
   * 只认 {videoId} 的老后端只会加进第一个 —— 响应里缺的那几个逐个补发，最终结果与后端版本无关。
   */
  async function appendAll(playlistId, ids) {
    let res = await api.addPlaylistVideos(playlistId, ids, { silent: true })
    let out = addOutcome(res, ids)
    let justAdded = countAdded(out)
    for (const missingId of out.missing) {
      res = await api.addPlaylistVideos(playlistId, [missingId], { silent: true })
      justAdded += countAdded(addOutcome(res, [missingId]))
    }
    out = addOutcome(res, ids)
    return { justAdded, out }
  }

  /** 把目标视频追加到已有列表；成功返回 true（弹层关不关由调用方决定） */
  async function addTo(p) {
    if (!p || busyId.value || blocked.value) return false
    const ids = targetIds()
    if (!ids.length) return false
    busyId.value = p.id
    lastAdd.value = { added: 0, requested: ids.length, already: false }
    try {
      const { justAdded, out } = await appendAll(p.id, ids)
      markJoined(p.id)
      const hit = items.value.find((x) => String(x.id) === String(p.id))
      if (hit) hit.joined = true
      lastAdd.value = { added: justAdded, requested: ids.length, already: out.already }
      if (out.already) notify(alreadyMessage(p.name))
      return true
    } catch (err) {
      notify(describePlaylistError(err, 'add'))
      return false
    } finally {
      busyId.value = ''
    }
  }

  /**
   * 从某个列表移出目标视频（P5.26：信息栏播放列表分区需要「移出」，两个旧入口只有「加入」）。
   * 后端：DELETE /api/media/playlist/{id}/videos/{videoId}（逐条删；批量目标就逐条调用）。
   * 成功：清掉本会话的已加入标记 + 把该条目 joined 置 false（数量同步 -1，不重拉清单）。
   * 失败：只提示真实原因，不改任何状态（用户在界面上看到的仍是「已加入」，可以重试）。
   */
  async function removeFrom(p) {
    if (!p || busyId.value || blocked.value) return false
    const ids = targetIds()
    if (!ids.length) return false
    busyId.value = p.id
    try {
      for (const id of ids) {
        await api.removePlaylistVideo(p.id, id, { silent: true })
        sessionJoined.delete(joinKey(p.id, id))
      }
      const hit = items.value.find((x) => String(x.id) === String(p.id))
      if (hit) {
        hit.joined = false
        if (typeof hit.count === 'number' && hit.count > 0) hit.count = hit.count - 1
      }
      return true
    } catch (err) {
      notify(describePlaylistError(err, 'remove'))
      return false
    } finally {
      busyId.value = ''
    }
  }

  /**
   * 新建并加入；成功返回 { id, name, added }，失败返回 null。
   *
   * 后端 create 只认 name（视频另走追加），所以这里建完必须自己追加一次：
   * 追加是幂等的，重名复用已有列表时也不会重复插。
   */
  async function createAndAdd() {
    if (!canCreate.value) return null
    const name = String(newName.value || '').trim()
    const ids = targetIds()
    busyId.value = '__new'
    lastAdd.value = { added: 0, requested: ids.length, already: false }
    try {
      const res = await api.createPlaylist({ name }, { silent: true })
      const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
      const newId = body && body.id != null ? String(body.id) : ''
      let justAdded = 0
      let already = false
      if (newId && ids.length) {
        const made = await appendAll(newId, ids)
        justAdded = made.justAdded
        already = made.out.already
        markJoined(newId)
        if (already) notify(alreadyMessage(name))
      }
      await load()
      if (newId) {
        const hit = items.value.find((x) => String(x.id) === newId)
        if (hit) hit.joined = true
      }
      lastAdd.value = { added: justAdded, requested: ids.length, already }
      return { id: newId, name, added: justAdded }
    } catch (err) {
      notify(describePlaylistError(err, 'create'))
      return null
    } finally {
      busyId.value = ''
    }
  }

  /** 关闭入口时复位（不清空已加入标记：那是会话级的） */
  function reset() {
    busyId.value = ''
    creating.value = false
    newName.value = ''
  }

  return {
    loading,
    items,
    unavailable,
    busyId,
    newName,
    creating,
    blocked,
    canCreate,
    targetCount,
    lastAdd,
    load,
    openCreate,
    closeCreate,
    addTo,
    removeFrom,
    createAndAdd,
    reset,
    joinedNow,
    markJoined
  }
}

export default usePlaylistAdd
