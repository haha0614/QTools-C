/**
 * useBackendHealth.js —— 后端可用性探测（全站单例）
 *
 * 探什么：GET /api/toolInfo/list（后端没有 /api/health，404；toolInfo/list 是最轻的既有只读接口），
 *         超时 3s。请求走 utils/request.js 的 silent 通道 —— 失败不弹 toast、不 console.error，
 *         避免后端挂掉时每个探测周期刷一屏错误。
 * 转什么：utils/backendStatus.js 的纯状态机（连续 2 次失败 → offline，成功 1 次 → online，中间是 degraded）。
 * 节奏：online 20s / degraded 4s / offline 15s；页面隐藏（document.hidden）时暂停，回到前台立刻补探一次，
 *       因此后端恢复后不需要刷新页面，入口会自己解锁。
 * 副作用：只有「状态位真的变化」才有反应 —— 掉线放出提示条（不弹 toast，避免和提示条重影）、
 *         恢复弹一次 success；周期探测本身完全静默（不 console、不 toast）。
 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import request from '@/utils/request'
import {
  PROBE_TIMEOUT,
  STATUS_DEGRADED,
  STATUS_OFFLINE,
  STATUS_ONLINE,
  probeDelay,
  reduceProbe
} from '@/utils/backendStatus'

/** 探测目标：后端最轻的既有只读接口（换成 /api/health 时只改这一行） */
const PROBE_URL = '/toolInfo/list'

// ---------- 模块级单例状态（全站共用一份，任一处调用看到的是同一状态） ----------
const status = ref(STATUS_ONLINE)
const failures = ref(0)
const checking = ref(false)
const lastCheckedAt = ref(0)
const bannerDismissed = ref(false)

let timer = null
let started = false
let paused = false

/**
 * 状态位变化时的处理（周期探测什么都不做）
 * 掉线：只负责把提示条放出来 —— 提示条本身就是那条「状态变化」的 UI，
 *       再叠一个 toast 会和提示条在同一位置重影（真浏览器截图可见），所以不再弹。
 * 恢复：提示条自动消失是无声的，补一个短 toast 告诉用户在线服务回来了。
 */
function notify(prev, next) {
  if (prev === next) return
  if (next === STATUS_OFFLINE) {
    // 新一轮离线：把用户上次关掉的提示条重新放出来
    bannerDismissed.value = false
    return
  }
  if (next === STATUS_ONLINE && prev === STATUS_OFFLINE) {
    ElMessage({ type: 'success', message: '在线服务已恢复', duration: 2000 })
  }
}

/**
 * 探一次
 * @returns {Promise<string>} 探测后的状态
 */
async function probe() {
  // 同一时刻只允许一次探测：手动重试与周期定时撞车时不叠加请求
  if (checking.value) return status.value
  checking.value = true

  let ok = false
  try {
    // silent: true → request.js 的拦截器不弹 ElMessage；timeout 覆盖默认 10s
    await request({ url: PROBE_URL, method: 'get', silent: true, timeout: PROBE_TIMEOUT })
    ok = true
  } catch (err) {
    ok = false
  } finally {
    checking.value = false
  }

  const prev = status.value
  const next = reduceProbe({ status: prev, failures: failures.value }, ok)
  status.value = next.status
  failures.value = next.failures
  lastCheckedAt.value = Date.now()
  notify(prev, next.status)
  return status.value
}

/** 排下一次探测；永远只有一根定时器 */
function schedule(delay) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(tick, delay)
}

/** 一次「探测 + 重排」 */
async function tick() {
  timer = null
  if (paused) return
  await probe()
  if (!paused) schedule(probeDelay(status.value))
}

/** visiblechange：隐藏就停表（不在后台空转），回到前台立刻补探一次 */
function onVisibilityChange() {
  if (typeof document === 'undefined') return
  if (document.hidden) {
    paused = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    return
  }
  paused = false
  if (started && !timer) tick()
}

/** 启动周期探测（幂等：AppShell 重复挂载也只启动一次） */
function start() {
  if (started || typeof window === 'undefined') return
  started = true
  document.addEventListener('visibilitychange', onVisibilityChange)
  paused = !!document.hidden
  if (!paused) tick()
}

/** 立即重试（占位页 / 提示条上的「重试」按钮）：不走下一轮定时 */
async function retryNow() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const next = await probe()
  if (!paused) schedule(probeDelay(next))
  return next
}

/** 关掉顶部提示条（状态再次变为 offline 时会自动重新出现） */
function dismissBanner() {
  bannerDismissed.value = true
}

export function useBackendHealth() {
  return {
    status,
    failures,
    checking,
    lastCheckedAt,
    isOnline: computed(() => status.value === STATUS_ONLINE),
    isDegraded: computed(() => status.value === STATUS_DEGRADED),
    isOffline: computed(() => status.value === STATUS_OFFLINE),
    /** 提示条是否可见：仅 offline，且用户还没关掉 */
    bannerVisible: computed(() => status.value === STATUS_OFFLINE && !bannerDismissed.value),
    dismissBanner,
    probe,
    start,
    retryNow
  }
}
