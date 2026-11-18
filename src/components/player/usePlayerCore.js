import { computed, onBeforeUnmount, onMounted, reactive, watch } from 'vue'

/**
 * 播放内核：只管"播放语义"（播放/暂停、进度、音量、倍速、全屏、错误），
 * 不关心控件长什么样、也不关心业务字段。所有控件与插件都通过这里读写。
 */
export function usePlayerCore(videoRef, getSource) {
  const state = reactive({
    playing: false,
    waiting: false,
    currentTime: 0,
    duration: 0,
    buffered: 0,
    volume: 1,
    muted: false,
    rate: 1,
    fullscreen: false,
    error: '',
    hint: '',
    ready: false
  })

  const api = {
    state,
    fail(msg) { state.error = String(msg || '播放失败') },
    retrying({ attempt, max }) { state.hint = '源站地址已过期，正在后台重新签名…（第 ' + attempt + '/' + max + ' 次重试）' }
  }

  let cleanup = null
  let disposed = false

  function el() { return videoRef.value }

  function onTime() { const v = el(); if (v) { state.currentTime = v.currentTime; const b = v.buffered; state.buffered = b && b.length ? b.end(b.length - 1) : 0 } }
  function onDur() { const v = el(); if (v) state.duration = Number.isFinite(v.duration) ? v.duration : 0 }
  function onPlay() { state.playing = true; state.error = ''; state.hint = ''; state.waiting = false }
  function onPause() { state.playing = false }
  function onWait() { state.waiting = true }
  function onReady() { state.waiting = false; state.ready = true; state.hint = '' }
  function onFsChange() {
    const d = typeof document !== 'undefined' ? document : null
    state.fullscreen = !!(d && (d.fullscreenElement || d.webkitFullscreenElement))
  }

  async function attach() {
    const v = el()
    const src = getSource && getSource()
    if (!v || !src) return
    detach()
    state.error = ''
    state.hint = ''
    state.ready = false
    cleanup = await src.attach(v, api)
    if (disposed) { if (cleanup) cleanup(); return }
  }

  function detach() {
    if (cleanup) { try { cleanup() } catch (e) { /* 忽略 */ } cleanup = null }
  }

  function toggle() { const v = el(); if (!v) return; if (v.paused) v.play().catch(() => {}); else v.pause() }
  function seek(t) { const v = el(); if (!v) return; const d = state.duration || 0; v.currentTime = Math.max(0, Math.min(t, d || t)) }
  function seekBy(dt) { seek(state.currentTime + dt) }
  function setVolume(x) { const v = el(); if (!v) return; v.volume = Math.max(0, Math.min(1, x)); state.volume = v.volume; v.muted = v.volume === 0 }
  function toggleMute() { const v = el(); if (!v) return; v.muted = !v.muted; state.muted = v.muted }
  function setRate(r) { const v = el(); if (!v) return; v.playbackRate = r; state.rate = r }
  async function toggleFullscreen() {
    const v = el()
    if (!v) return
    const d = document
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      (d.exitFullscreen || d.webkitExitFullscreen || (() => {})).call(d)
    } else {
      const target = v.closest('.qtp') || v
      const fn = target.requestFullscreen || target.webkitRequestFullscreen
      if (fn) await fn.call(target)
    }
  }

  function bind() {
    const v = el()
    if (!v) return
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('durationchange', onDur)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('waiting', onWait)
    v.addEventListener('playing', onReady)
    v.addEventListener('canplay', onReady)
    v.addEventListener('volumechange', () => { state.volume = v.volume; state.muted = v.muted })
    document.addEventListener('fullscreenchange', onFsChange)
    document.addEventListener('webkitfullscreenchange', onFsChange)
  }

  function unbind() {
    const v = el()
    if (v) {
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('durationchange', onDur)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('waiting', onWait)
      v.removeEventListener('playing', onReady)
      v.removeEventListener('canplay', onReady)
    }
    document.removeEventListener('fullscreenchange', onFsChange)
    document.removeEventListener('webkitfullscreenchange', onFsChange)
  }

  // 必须等 <video> 真正挂载后再绑定事件与源：setup 阶段 videoRef 还是 null
  onMounted(() => {
    bind()
    const v = el()
    if (v) state.rate = v.playbackRate || 1
    attach()
  })
  watch(() => (getSource && getSource() && getSource().url), () => {
    if (!el()) return
    bind()
    attach()
  })
  onBeforeUnmount(() => { disposed = true; unbind(); detach() })

  return {
    state,
    api,
    toggle, seek, seekBy, setVolume, toggleMute, setRate, toggleFullscreen,
    progress: computed(() => (state.duration ? state.currentTime / state.duration : 0)),
    bufferedRatio: computed(() => (state.duration ? Math.min(1, state.buffered / state.duration) : 0))
  }
}
