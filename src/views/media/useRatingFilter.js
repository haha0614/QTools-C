/**
 * useRatingFilter.js —— 全站**唯一**的分级筛选状态源（P6.09）
 *
 * 用户口径：「分级筛选应作用于全局，视频站和相册站以及人物列表都应有变化且不会随刷新取消」。
 * 于是三件事必须只发生在一个地方：
 *
 *   1. **状态本体**：模块级单例（{@code rating} 一个 ref）。视频站 / 图片站 / 人物页都从这里读、
 *      都往这里写 —— 切页面（SPA 不重载）时状态天然一致，任何一页改动立刻被另一页看到。
 *   2. **持久化**：URL hash {@code #rating=xxx}（可分享、可刷新）+ {@code localStorage['ms.rating']}
 *      （刷新 / 关掉标签页都还在）。读取优先级 **hash > localStorage > all**。
 *      写 hash 用 {@code history.replaceState}：改筛选不该堆历史，后退一次要能回上一个页面。
 *   3. **可见性联动**：可见分级由索引 {@code ratings[]} 提供（后端已按「当前访客可见 + 该档有条目」筛过）。
 *      当前档位一旦不在可见列表里（未登录 + 该档被设为不可见 / 登录后档位变少），
 *      自动回落 {@link RATING_ALL} 并把 hash 里的段清掉 —— 不给用户看一个必然为空的页面。
 *      注意回落**不动 localStorage**：那是「用户的偏好」，可见性变化时先藏起来，
 *      等条件恢复（例如登录后该档重新可见）下次进入还能回到他自己选的那一档。
 *
 * 判定与 hash 解析的纯函数在 contentRating.js（node --test 直跑），这里只做 Vue 状态 + 浏览器存储。
 *
 * 用法（三页一致）：
 * <pre>
 *   const { rating, barVisible, setRating, setRatingOptions, optionsWithCounts } = useRatingFilter()
 *   // 索引到达后：setRatingOptions(idx.ratings || [])
 *   // 模板：&lt;RatingFilterBar v-if="barVisible" :options="optionsWithCounts(countByRating(albums))"
 *   //          :model-value="rating" @change="setRating" /&gt;
 * </pre>
 */
import { computed, ref } from 'vue'
import {
  RATING_ALL,
  countByRating,
  normalizeRating,
  readRatingHash,
  showRatingFilter,
  writeRatingHash
} from './contentRating.js'

/** localStorage 键：只存一个分级值字符串（all 时删除该键，避免留下一个「看似有偏好」的空键） */
export const RATING_STORAGE_KEY = 'ms.rating'

/** 当前分级（全站单例）：{@code all | general | guidance | restricted} */
const rating = ref(RATING_ALL)
/** 索引 ratings[] 的可见分级（原始 {value,label,count}，count 是「视频 + 相册」合计，只用于判定可见性） */
const ratingOptions = ref([])
let initialized = false

/** 当前访客可见的分级（顺序 = 后端 ratings[] 顺序 = 大众 → 家长指导 → 限制级） */
const availableRatings = computed(() =>
  (ratingOptions.value || []).filter((o) => o && o.value && o.value !== RATING_ALL)
)
/** 是否需要渲染筛选条：只有 ≥2 档可见时才有意义（只剩一档 = 那一档就是全部） */
const barVisible = computed(() => showRatingFilter(availableRatings.value))

function storage() {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

function storedRating() {
  const s = storage()
  if (!s) return ''
  try {
    return String(s.getItem(RATING_STORAGE_KEY) || '')
  } catch {
    return ''
  }
}

function persist(value) {
  const s = storage()
  if (!s) return
  try {
    if (value && value !== RATING_ALL) s.setItem(RATING_STORAGE_KEY, value)
    else s.removeItem(RATING_STORAGE_KEY)
  } catch {
    /* 隐私模式 / 配额满：持久化失败不影响本次筛选 */
  }
}

/** 把当前分级写回 hash（只动 rating 一段，其余筛选段原样保留） */
function syncHash() {
  if (typeof window === 'undefined' || !window.location || !window.history) return
  const next = writeRatingHash(window.location.hash, rating.value)
  if (window.location.hash === next) return
  try {
    // 与视频页 writeHash 同一套：history.state 必须原样带回，否则 vue-router 的状态丢失
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + next)
  } catch {
    /* 无 history API：hash 不写，localStorage 仍然生效 */
  }
}

/**
 * 首次读取（每个文档一次）：hash > localStorage > all。
 *
 * 读取**早于**索引到达，所以这里不做可见性校验（那时还不知道有哪些档可见），
 * 校验统一在 {@link setRatingOptions} 里做。
 */
function ensureInit() {
  if (initialized) return
  initialized = true
  const fromHash = readRatingHash(typeof window === 'undefined' ? '' : window.location.hash)
  const stored = storedRating().trim().toLowerCase()
  rating.value = fromHash || (stored && stored !== RATING_ALL ? stored : RATING_ALL)
  // 这里**不写 hash**：读到的值还没经过可见性校验（索引没到）。等 setRatingOptions 校验完
  // 再补 hash —— 否则「localStorage 里存着不可见档位」会先往地址栏写一个非法值再删掉。
}

/**
 * 索引到达（含登录态变化后的重取）：登记可见分级并校验当前值。
 *
 * 当前值不可见 → 回落 all + 清 hash 段；可见列表变大（登录后）→ 筛选条自动多出对应 chip，
 * 不需要刷新页面。
 *
 * @param {Array} list 索引 ratings[]：{@code [{value,label,count}]}
 */
export function setRatingOptions(list) {
  ratingOptions.value = Array.isArray(list) ? list.filter((o) => o && o.value) : []
  const next = normalizeRating(rating.value, availableRatings.value)
  if (next !== rating.value) rating.value = next
  // 校验之后才写 hash：从 localStorage 恢复出来的档位在这里第一次进地址栏（刷新 / 分享可带走），
  // 不可见的档位也在这里被清掉。
  syncHash()
}

/**
 * 用户改选分级（唯一的写入口）：校验 → 写状态 → 写 localStorage → 写 hash。
 *
 * @param {string} value 目标分级值（{@link RATING_ALL} = 清除筛选）
 */
export function setRating(value) {
  const next = normalizeRating(value, availableRatings.value)
  rating.value = next
  persist(next)
  syncHash()
}

/**
 * 某一页的 chip 选项：可见分级 + 该页自己的计数（视频数 / 相册数 / 人物数）。
 *
 * @param {Record<string, number>} counts {@link countByRating} 或 countPersonsByRating 的结果
 * @returns {Array<{value: string, label: string, count: number}>}
 */
export function optionsWithCounts(counts) {
  const map = counts && typeof counts === 'object' ? counts : {}
  return availableRatings.value.map((o) => ({
    value: o.value,
    label: o.label || o.value,
    count: Number(map[o.value]) || 0
  }))
}

/** 组合式入口：单例状态 + 三个写入口（三页共用同一份） */
export function useRatingFilter() {
  ensureInit()
  return { rating, availableRatings, barVisible, setRating, setRatingOptions, optionsWithCounts, countByRating }
}
