import { createApp, computed, h, reactive, ref } from 'vue'
import {
  Player, fileSource,
  qualityPlugin, subtitlesPlugin, markersPlugin, spritePreviewPlugin
} from '../../src/components/player/index.js'

/**
 * 播放器实验室 —— 只跑开发服务器，不进 dist。
 * 用一段本地 mp4 + 一套假 capabilities，把四个插件同时挂上去，用来验证插件契约与外观。
 *   cd QTools-C && node node_modules/vite/bin/vite.js
 *   打开 http://localhost:5173/devtools/player-lab/index.html
 */
const cap = {
  qualities: [
    { value: 'orig', label: '原画' },
    { value: 'hd', label: '高清 720P' },
    { value: 'sd', label: '流畅 480P' }
  ],
  quality: 'orig',
  selectQuality(v) { cap.quality = v },
  sprite: { url: '/web/202492/cover.jpg', cols: 3, rows: 3, count: 9 },
  preview: null,
  markers: [
    { pos: 3, title: '开场' },
    { pos: 8, title: '第一个转折' },
    { pos: 14, endPos: 22, title: '区间标记：14s → 22s' }
  ],
  subtitles: [{ src: '/devtools/player-lab/sample.vtt', label: '中文', lang: 'zh', default: true }]
}

const src = fileSource('/web/202057/video.mp4', { capabilities: cap })

const PLUGINS = {
  quality: qualityPlugin,
  subtitles: subtitlesPlugin,
  markers: markersPlugin,
  sprite: spritePreviewPlugin
}

const App = {
  setup() {
    const on = reactive({ quality: true, subtitles: true, markers: true, sprite: true })
    const rev = ref(0)
    const features = computed(() => Object.keys(PLUGINS)
      .filter((k) => on[k])
      .map((k) => PLUGINS[k]()))
    return () => h('div', null, [
      h('div', { class: 'lab-bar' }, Object.keys(PLUGINS).map((k) => h('label', { class: 'lab-chk' }, [
        h('input', {
          type: 'checkbox',
          checked: on[k],
          onChange: (e) => { on[k] = e.target.checked; rev.value += 1 }
        }),
        k
      ]))),
      h('div', { class: 'lab-stage' }, [
        h(Player, {
          key: rev.value,
          source: src,
          cover: '/web/202492/cover.jpg',
          features: features.value
        })
      ]),
      h('p', { class: 'lab-tip' }, '齿轮 = 画质 + 字幕；进度条下方 = 标记刻度；进度条悬停 = 雪碧图预览')
    ])
  }
}

createApp(App).mount('#app')
