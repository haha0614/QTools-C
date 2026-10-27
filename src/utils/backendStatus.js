/**
 * backendStatus.js —— 后端可用性状态机的纯逻辑（无 Vue / 无网络 / 可单测）
 *
 * 状态：online | degraded | offline
 *   - 探测成功 1 次        → online（立即恢复，不需要等下一轮）
 *   - 连续失败 1 次        → degraded（先给一次机会，避免网络抖动就把全站锁死）
 *   - 连续失败 2 次        → offline（兜底 UI 只认这个状态：入口禁用 / 提示条 / 占位页）
 *
 * 探测节奏随状态变：online 20s 稳着探；degraded 4s（快点确认到底是不是真挂了）；
 * offline 15s（后端恢复后最迟 15s 自动解锁，不需要刷新页面）。
 */

export const STATUS_ONLINE = 'online'
export const STATUS_DEGRADED = 'degraded'
export const STATUS_OFFLINE = 'offline'

/** 连续失败多少次判定为 offline（需求：连续 2 次） */
export const OFFLINE_AFTER_FAILURES = 2

/** 探测超时（需求：3s） */
export const PROBE_TIMEOUT = 3000

/** 各状态下的下一次探测间隔（毫秒，需求区间 15–30s；degraded 用短间隔加速确认） */
export const PROBE_DELAY = {
  [STATUS_ONLINE]: 20000,
  [STATUS_DEGRADED]: 4000,
  [STATUS_OFFLINE]: 15000
}

/** 初始状态：乐观当在线，避免首屏还没探完就把入口画成灰的 */
export function createProbeState() {
  return { status: STATUS_ONLINE, failures: 0 }
}

/**
 * 状态转移（纯函数）
 * @param {{status:string, failures:number}} state 上一次的状态
 * @param {boolean} ok 本次探测是否成功
 * @returns {{status:string, failures:number, changed:boolean}} 新状态；changed 表示状态位发生了变化
 */
export function reduceProbe(state, ok) {
  const prevStatus = state && typeof state.status === 'string' ? state.status : STATUS_ONLINE
  const prevFailures = state && Number.isFinite(state.failures) ? state.failures : 0

  if (ok) {
    return { status: STATUS_ONLINE, failures: 0, changed: prevStatus !== STATUS_ONLINE }
  }

  const failures = prevFailures + 1
  const status = failures >= OFFLINE_AFTER_FAILURES ? STATUS_OFFLINE : STATUS_DEGRADED
  return { status, failures, changed: status !== prevStatus }
}

/** 下一次探测的等待时长（未知状态回落到在线节奏） */
export function probeDelay(status) {
  return PROBE_DELAY[status] || PROBE_DELAY[STATUS_ONLINE]
}

/** 在线服务入口是否应该锁住：只有 offline 才锁，degraded 仍然放行（避免抖动体验） */
export function isServiceLocked(status) {
  return status === STATUS_OFFLINE
}
