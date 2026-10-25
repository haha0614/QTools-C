<!--
  MediaPlayer.vue —— 播放层（app.js 播放器部分的等价实现）
  覆盖：进度记忆与续播、清晰度切换（原画直连 / 实时转码 + 内容偏移）、原画与转码统一的自绘控制条
        （播放/暂停 · 进度 · 时间 · 音量 · 画质 · 上一部/下一部 · 全屏，两种模式同一套 UI，不再使用原生 controls）、
        进度条 hover 精灵图卡片 / 拖动预览片段、seek（转码重开流 + pendingSeek / 原画直写 currentTime）、
        上一个 / 下一个、收藏、字幕轨注入、异常编码回退、播放器会话式 play 埋点与 play_end 结算。
   P4.4：全屏下控制条 2.5s 无操作自动淡出（判定在 playerExtras.createCtrlAutoHide），
        进度条 / 标记轨 / 刻度层 / 浮层锚点统一按「轨道几何」（两端各半个 thumb）换算。
  约定：面板状态（当前视频 / 上一部下一个可用性 / 收藏 / 清晰度）由 VideoPage 持有，本组件通过 props 接收、
        emit 回传，不直接读写 localStorage 与服务端。
  事件监听全部通过模板绑定，组件卸载时由 Vue 自动解绑，不会残留 <video> 监听（原页手动管理 el.video）。
-->
<template>
  <div class="player" role="dialog" aria-modal="true" aria-label="播放器">
    <div class="p-head">
      <div class="p-info">
        <h2 class="p-title" :title="video.title">{{ video.title }}</h2>
        <div class="p-meta">
          <span>目录 {{ video.folder }}</span>
          <span>时长 {{ fmtDur(video.dur) }}</span>
          <span>分辨率 {{ video.w && video.h ? video.w + '×' + video.h : '未知' }} {{ resBadge(video.w) }}</span>
          <span>编码 {{ video.vcodec || '未知' }}</span>
          <span>体积 {{ fmtSize(video.size) }}</span>
          <span>字幕 {{ video.sub ? '有' : '无' }}</span>
        </div>
      </div>
      <div class="p-actions">
        <button class="btn p-fav" :class="{ on: fav }" type="button" :aria-pressed="fav" @click="emit('toggle-fav')">
          {{ fav ? '★ 已收藏' : '☆ 收藏' }}
        </button>
        <button class="btn btn-meta" type="button" title="评分 / 标签 / 标记" @click="emit('open-meta')">信息</button>
        <button class="btn" type="button" :disabled="!hasPrev" @click="emit('prev')">上一部</button>
        <button class="btn" type="button" :disabled="!hasNext" @click="emit('next')">下一部</button>
        <button class="btn btn-primary" type="button" @click="emit('close')">关闭 (Esc)</button>
      </div>
    </div>

    <div v-if="warnVisible" class="p-warn">该片为 HEVC/异常编码，浏览器可能无法播放</div>

    <!-- P4.3 全屏容器：把 <video>（.p-stage）与自绘控制栏（.p-ctrl）包在一起，
         全屏请求发到这一层 —— 只对 .p-stage 全屏时控制栏是兄弟节点，会被挡在屏幕外。 -->
    <div
      ref="fsEl"
      class="p-fs-wrap"
      :class="{ 'is-ctrl-hidden': ctrlHidden }"
      @mousemove="onUserActivity"
      @mousedown="onUserActivity"
      @touchstart.passive="onUserActivity"
    >
      <div ref="stageEl" class="p-stage">
        <!-- 原画与转码都不再挂原生 controls：控制条统一用下方自绘 .p-ctrl -->
        <video
          ref="videoEl"
          autoplay
          playsinline
          preload="metadata"
          @click="onVideoClick"
          @play="onPlay"
          @playing="onPlaying"
          @loadeddata="onLoadedData"
          @loadedmetadata="onLoadedMetadata"
          @durationchange="onDurationChange"
          @volumechange="onVolumeChange"
          @timeupdate="onTimeUpdate"
          @webkitbeginfullscreen="onIosFsIn"
          @webkitendfullscreen="onIosFsOut"
          @pause="onPause"
          @ended="onEnded"
          @seeking="onSeeking"
          @error="onError"
        >
          <track v-if="subSrc" :key="subSrc" kind="subtitles" label="字幕" srclang="zh" default :src="subSrc" />
        </video>
        <button v-if="tapVisible" class="p-tap" type="button" @click="onTapPlay">▶ 点击播放</button>
        <button v-if="restartVisible" class="p-restart" type="button" @click="onRestart">从头播放</button>
      </div>

      <!-- 自绘控制条：原画（直连）与转码共用一套 UI，原画模式不再使用浏览器原生 controls -->
      <div
        ref="ctrlEl"
        class="p-ctrl"
        @mouseenter="onCtrlPointerEnter"
        @mouseleave="onCtrlPointerLeave"
        @focusin="onCtrlFocusIn"
      >
        <div class="p-seekbar">
          <!-- P4.1：进度条 + 标记轨竖排成一列（.p-seekbar 仍是行布局，时间码在右侧）。
                P4.4：两者都按半个 thumb 左右内缩（--thumb-r），所以「同宽」是逐像素意义上的同宽 -->
          <div class="p-seek-col" :style="seekVars">
            <!-- mousemove 挂在 20px 高的容器上，命中带比 4px 轨道宽，指针略偏也能触发 -->
            <div
              class="p-seekwrap"
              @mousemove="[onSeekHover, onMarkerHover]"
              @mouseleave="[onSeekLeave, onMarkerLeave]"
            >
              <!-- P4-B 标记刻度：单点是 2px 竖线，区间是一段浅色带；hover 出 'mm:ss–mm:ss · 说明' 原生提示。
                   pointer-events:none 让鼠标照常落到下面的 range 上（既不挡 hover 预览，也不挡拖动） -->
              <div v-if="markerTickList.length" class="p-marks" aria-hidden="true">
                <span
                  v-for="t in markerTickList"
                  :key="t.key"
                  class="p-mark"
                  :class="{ 'is-range': t.width > 0 }"
                  :style="markerTickStyle(t)"
                  :title="t.title"
                ></span>
              </div>
              <input
                ref="seekEl"
                class="p-seek"
                type="range"
                min="0"
                :max="seekMax"
                step="1"
                :value="seekPos"
                :style="seekFillStyle"
                aria-label="播放位置"
                :aria-valuetext="fmtDur(seekPos) + ' / ' + fmtDur(seekDur)"
                @input="onSeekInput"
                @change="onSeekCommit"
                @keydown="onSeekKey"
              />
              <!-- P4-B 标记刻度提示：hover 到刻度附近（单点 ±1.2%、区间整段）时在刻度上方显示 'mm:ss–mm:ss · 说明'。
                   刻度本身 pointer-events:none，所以不会挡 range 的 hover 预览与拖动 -->
              <div v-if="markerHover" class="p-marker-tip" :style="floatStyle(markerHover.left / 100)">
                {{ markerHover.title }}
              </div>
              <!-- 1px 指示线：与卡片同源比例，告诉用户这里能 hover；无 hasSprite 时不渲染 -->
              <div v-if="hoverVisible" class="p-hover-line" :style="hoverLineStyle"></div>
              <!-- hover 预览：精灵图整图 + background-position 切格（10×10，共 100 格）；无 hasSprite 时永不渲染 -->
              <div v-if="hoverVisible" class="p-hover" :style="floatStyle(hoverRatio)">
                <div class="p-hover-img" :style="spriteStyle"></div>
                <span class="p-hover-t">{{ hoverTimeText }}</span>
              </div>
              <!-- 拖动预览：pv2 缩时视频，按拖动比例定位帧；无 hasPreview 时永不挂载（因此不发请求） -->
              <div v-if="clipVisible" class="p-clip" :style="floatStyle(clipRatio)">
                <video
                  ref="clipEl"
                  class="p-clip-v"
                  muted
                  playsinline
                  preload="none"
                  :src="previewSrc"
                  @loadedmetadata="onClipMetadata"
                ></video>
                <span class="p-clip-t">{{ clipTimeText }}</span>
              </div>
            </div>
          <!-- P4.1 标记轨（marker lane）：进度条下方独立一条，间距 var(--lane-gap)=3px（P4.3 起的值）。
                P4.4：左右内缩半个 thumb 后与进度条的可视轨道同宽，标记 left% 与滑块中心同源。
               单点 = 3px 通高竖条；区间 = 半透明色带 + 左右各 2px 实心边。
               轨道本身 pointer-events:none（不挡拖动与 hover 预览），只有标记可点：
               点一下跳到 pos，区间再点一下跳到 endPos；hover/focus 复用 .p-marker-tip 提示。
               无标记时整条不渲染（v-if），不留空白。 -->
          <div
            v-if="markerTickList.length"
            class="p-marklane"
            role="group"
            aria-label="进度标记"
            :style="laneVars"
          >
            <button
              v-for="t in markerTickList"
              :key="'ln' + t.key"
              class="p-lane-mark"
              :class="{ 'is-range': t.isRange }"
              type="button"
              :style="laneMarkStyle(t)"
              :title="t.title"
              :aria-label="'跳到 ' + t.title"
              @mouseenter="onLaneHover(t)"
              @mouseleave="onLaneLeave"
              @focus="onLaneHover(t)"
              @blur="onLaneLeave"
              @click.stop="onLaneClick(t)"
            ></button>
          </div>
          </div>
          <!-- P4.3 标记数量徽标：刻度太细看不见时的根本解法 —— 数字一目了然，点开就是可跳转的列表。
               位置在进度条右端、时间码左侧；无标记时整块不渲染（与标记轨同一条件）。 -->
          <span v-if="markerTickList.length" ref="mkBadgeEl" class="p-mk-badge-wrap">
            <button
              class="p-mk-badge"
              type="button"
              :aria-expanded="markerListOpen"
              :title="markerBadgeTitle"
              :aria-label="markerBadgeTitle"
              @click.stop="toggleMarkerList"
            >
              🚩 {{ markerTickList.length }}
            </button>
            <div v-if="markerListOpen" class="p-mk-list" role="menu" aria-label="标记列表">
              <button
                v-for="t in markerTickList"
                :key="'ml' + t.key"
                class="p-mk-item"
                type="button"
                role="menuitem"
                :title="'跳到 ' + t.title"
                @click.stop="onMarkPick(t)"
              >
                <span class="p-mk-dot" :style="{ background: t.color || 'var(--accent)' }"></span>
                <span class="p-mk-item-t">{{ t.title }}</span>
              </button>
            </div>
          </span>
          <span class="p-seek-now">{{ fmtDur(seekPos) }} / {{ fmtDur(seekDur) }}</span>
        </div>

        <div class="p-ctrlline">
          <button
            class="p-btn p-btn-play"
            type="button"
            :aria-label="isPlaying ? '暂停' : '播放'"
            @click="togglePlay"
          >
            {{ isPlaying ? '⏸' : '▶' }}
          </button>
          <button
            class="p-btn"
            type="button"
            :aria-label="muted || volume === 0 ? '取消静音' : '静音'"
            @click="toggleMute"
          >
            {{ muted || volume === 0 ? '🔇' : '🔊' }}
          </button>
          <input
            class="p-vol"
            type="range"
            min="0"
            max="1"
            step="0.05"
            :value="muted ? 0 : volume"
            aria-label="音量"
            @input="onVolumeInput"
          />
          <!-- P4.1：音量增益从控制条中部挪到音量滑块旁，三个按钮收敛成一个循环按钮
               （1×→1.5×→2×→1×）；WebAudio GainNode / 降级为音量映射的行为一行未改（见 setGain） -->
          <button
            class="p-btn p-gain-btn"
            :class="{ on: gainLevel > 1 }"
            type="button"
            :aria-pressed="gainLevel > 1"
            :title="gainTitle"
            @click="cycleGain"
          >
            增益 {{ gainLevel }}×
          </button>
          <!-- 降级说明：只在浏览器不给 WebAudio 时出现，hover 出完整原因 -->
          <span v-if="gainFallback" class="p-gain-note" :title="gainNote">增益降级</span>
          <!-- P4.1：原来 1×/1.5×/2× 增益按钮的位置改成真正的「视频倍速」（用户一直把它误认成倍速） -->
          <span class="p-speed">
            <label class="p-speed-lab" for="msVideoSpeed">倍速</label>
            <select
              id="msVideoSpeed"
              class="p-speed-sel"
              :value="speedLevel"
              :title="speedTitle"
              aria-label="视频倍速"
              @change="onSpeedChange"
            >
              <!-- :selected 让首屏（含 SSR 证据）就显示当前档位，而不是浏览器默认的第一项 -->
              <option v-for="s in SPEED_LEVELS" :key="'sp' + s" :value="s" :selected="s === speedLevel">
                {{ speedLabel(s) }}
              </option>
            </select>
          </span>
          <!-- P4-B AB 循环：A 设起点、B 设终点（再按各自清除），播放到 B 自动回跳 A -->
          <span class="p-ab">
            <button
              class="p-btn p-ab-btn"
              :class="{ on: abA != null }"
              type="button"
              title="设 A 点（再按 A 清除）快捷键 A"
              @click="setAbPoint('a')"
            >
              A
            </button>
            <button
              class="p-btn p-ab-btn"
              :class="{ on: abB != null }"
              type="button"
              title="设 B 点（再按 B 清除）快捷键 B"
              @click="setAbPoint('b')"
            >
              B
            </button>
            <button
              class="p-btn p-ab-btn"
              type="button"
              :disabled="abA == null && abB == null"
              title="清除 A/B"
              @click="clearAb"
            >
              清
            </button>
            <span class="p-ab-text" :class="{ on: abOn }" :title="abTitle">{{ abText }}</span>
          </span>
          <!-- P4-B 逐帧：暂停态单帧步进（1/30 近似，有 requestVideoFrameCallback 时按实测帧间隔） -->
          <span class="p-frame">
            <button class="p-btn" type="button" title="上一帧（快捷键 , 或 Shift+←）" @click="stepFrame(-1)">⏴</button>
            <button class="p-btn" type="button" title="下一帧（快捷键 . 或 Shift+→）" @click="stepFrame(1)">⏵</button>
          </span>
          <button
            class="p-btn p-help-btn"
            type="button"
            :aria-expanded="helpVisible"
            title="快捷键说明（?）"
            @click="toggleHelp"
          >
            ?
          </button>
          <span class="p-ctrl-gap"></span>
          <label class="p-q-lab" for="msVideoQ">画质</label>
          <select id="msVideoQ" class="p-q" :value="curQ" @change="onQualityChange">
            <option v-for="q in Q_VALUES" :key="q" :value="q">{{ q === 'orig' ? '原画（直连）' : Q_LABELS[q] }}</option>
          </select>
          <span class="p-q-now">{{ qLabel(curQ) }}</span>
          <span v-if="qHintVisible" class="p-q-hint">转码中…</span>
          <span class="p-ctrl-gap"></span>
          <button v-if="hasPrev" class="p-btn" type="button" aria-label="上一部" @click="emit('prev')">⏮</button>
          <button v-if="hasNext" class="p-btn" type="button" aria-label="下一部" @click="emit('next')">⏭</button>
          <button
            class="p-btn"
            type="button"
            :aria-label="fsActive ? '退出全屏' : '全屏'"
            @click="toggleFullscreen"
          >
            {{ fsActive ? '⤢' : '⛶' }}
          </button>
        </div>
      </div>
    </div>

    <div class="p-tags">
      <span v-for="(t, i) in tagList" :key="'t' + i" class="ptag"><b>{{ t[0] }}</b>{{ t[1] }}</span>
      <span v-for="(a, i) in actorList" :key="'a' + i" class="ptag ptag-actor"><b>演员</b>{{ a }}</span>
      <span v-if="!tagList.length && !actorList.length" class="ptag ptag-empty">无标签</span>
    </div>

    <!-- P4-B 快捷键总表：控制条上的 ? 按钮或键盘 ? 打开；Esc 先关浮层（见 VideoPage.onKey 的 Escape 分支） -->
    <div v-if="helpVisible" class="p-help" role="dialog" aria-modal="false" aria-label="快捷键说明" @click.self="helpVisible = false">
      <div class="p-help-box">
        <h3 class="p-help-h">快捷键 / 操作</h3>
        <ul class="p-help-list">
          <li v-for="row in SHORTCUTS" :key="row.k">
            <b class="p-help-key">{{ row.k }}</b>
            <span class="p-help-val">{{ row.v }}</span>
          </li>
        </ul>
        <p class="p-help-note">
          A/B 循环与逐帧都在「内容时间」上工作：转码模式会自动换算上流起点，与进度记忆、画质切换互不影响。
        </p>
        <button class="btn" type="button" @click="helpVisible = false">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useMediaApi } from '@/composables/useMediaApi'
// P4-B：AB 循环 / 逐帧 / 增益 / 标记刻度的纯逻辑（无 DOM，可单独单测）
// P4.1：+ 视频倍速档位与持久化、增益档位循环、标记轨尺寸与点击目标
import {
  FRAME_FALLBACK_SEC,
  LANE_EDGE_PX,
  LANE_GAP_PX,
  LANE_HEIGHT_PX,
  LANE_HEIGHT_PX_MOBILE,
  LANE_PIN_PX,
  LANE_RANGE_MIX_PCT,
  LANE_RAISE_PX,
  SPEED_LEVELS,
  abActive,
  abPress,
  abTick,
  applyGain,
  blurActiveInCtrl,
  createCtrlAutoHide,
  createGainGraph,
  frameStep,
  frameStepSize,
  markJumpTarget,
  markerTicks as buildMarkerTicks,
  nextGain,
  normalizeGain,
  normalizeSpeed,
  pointerInCtrlZone,
  readGainLevel,
  readSpeedLevel,
  seekPxToRatio,
  seekRatioCss,
  seekThumbPx,
  speedLabel,
  speedStep,
  writeGainLevel,
  writeSpeedLevel
} from './playerExtras'

const props = defineProps({
  /** 当前播放的视频对象 */
  video: { type: Object, required: true },
  /** 续播秒数（打开时由页面从 localStorage 读出） */
  startPos: { type: Number, default: 0 },
  /** 页面每次调用 openPlayer 自增；同一部片重开也算新会话 */
  openSeq: { type: Number, default: 0 },
  hasPrev: { type: Boolean, default: false },
  hasNext: { type: Boolean, default: false },
  fav: { type: Boolean, default: false },
  /** 清晰度档位：orig | 720 | 480 | 360（页面持久化在 localStorage['ms.q']） */
  quality: { type: String, default: 'orig' },
  /**
   * 播放会话埋点方法（由页面从 useMediaTrack 单例传入）：
   * { openPlaySession, trackPlayStart, trackPlayEnd }。
   * 播放层不自己调 useMediaTrack()——那样会在播放器卸载时 dispose 页面级的 pagehide 监听。
   */
  tracker: { type: Object, required: true },
  /** P4-B：该片的标记列表（信息抽屉 emit 上来），用于进度条刻度；空数组 = 不画刻度 */
  markers: { type: Array, default: () => [] }
})

const emit = defineEmits([
  'close',
  'prev',
  'next',
  'toggle-fav',
  'update:quality',
  'save-pos',
  'clear-pos',
  'push-recent',
  'open-meta'
])

const api = useMediaApi()

const Q_VALUES = ['orig', '720', '480', '360']
const Q_LABELS = { orig: '原画', 720: '720p', 480: '480p', 360: '360p' }

const videoEl = ref(null)
const stageEl = ref(null)
/** P4.3：全屏元素 = 包裹 <video> + 自绘控制栏的容器（只对 .p-stage 全屏会让控制栏消失） */
const fsEl = ref(null)
/** P4.4：控制条元素（自动隐藏的「指针是否还停在控制条上」兜底判定用） */
const ctrlEl = ref(null)
const tapVisible = ref(false)
const warnVisible = ref(false)
const restartVisible = ref(false)
const qHintVisible = ref(false)
const seekPos = ref(0)
const seekDur = ref(0)
const seekMax = ref(1)
/** 自绘控制条用的状态镜像（真值仍以 <video> 为准，事件里同步） */
const isPlaying = ref(false)
const volume = ref(1)
const muted = ref(false)
const fsActive = ref(false)

/** 当前清晰度：props.quality 的内部镜像，切换时可同步生效（不必等父级下一帧） */
const curQ = ref(Q_VALUES.indexOf(props.quality) >= 0 ? props.quality : 'orig')
const isTranscode = computed(() => curQ.value !== 'orig')

/** 转码流的内容起点（秒）：片内 currentTime 是相对它的偏移（app.js:1023-1025） */
let streamStart = 0
let pendingSeek = 0
let qSeekDragging = false
let qFallback = false
let lastQSrcAt = 0
let lastPosWrite = 0
let lastRecentPush = 0
let qHintTimer = 0
let openedVideo = null

/* ------------------------------------------------- 进度条 hover / 拖动预览 */
/* 派生资源（精灵图 / 预览视频）默认不生成，后端 /media/index 给出 hasSprite / hasPreview，
   不可用时这里一律不发请求、不显示浮层，交互与原来完全一致。 */

/** 精灵图固定 10 列 × 10 行、每格 160×90（build-thumbs.js SPRITE） */
const SPRITE_COLS = 10
const SPRITE_ROWS = 10
const SPRITE_CELLS = SPRITE_COLS * SPRITE_ROWS

/** 预览视频成片 5~8 秒（build-thumbs.js PV）：元数据没到时按 8 秒兜底 */
const CLIP_FALLBACK_SEC = 8

const clipEl = ref(null)
const seekEl = ref(null)
const hoverVisible = ref(false)
const clipVisible = ref(false)
const hoverRatio = ref(0)
const clipRatio = ref(0)
const clipTime = ref(0)
let clipDur = 0

const hasSprite = computed(() => !!(props.video && props.video.hasSprite))
const hasPreview = computed(() => !!(props.video && props.video.hasPreview))

/* hover 门槛只看断点，不看 (hover:hover)/(pointer:fine)：
   旧实现是一次性 matchMedia('(hover: hover) and (pointer: fine)')，在触屏笔记本 / 远程桌面 /
   主指针被识别成 coarse 的桌面浏览器上恒为 false —— 卡片因此永远不出现（修复的根因之一）。
   现在桌面宽度一律允许，≤768px 断点只保留拖动预览（样式再兜一层 display:none）。 */
const mobileMq =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 768px)')
    : null
const isMobile = ref(mobileMq ? mobileMq.matches : false)
const canHover = computed(() => !isMobile.value)

function onMobileMqChange(e) {
  isMobile.value = e ? !!e.matches : false
}

const spriteSrc = computed(() => (hasSprite.value ? api.spriteUrl(props.video.id) : ''))
const previewSrc = computed(() => (hasPreview.value ? api.previewUrl(props.video.id) : ''))

const hoverTimeText = computed(() => fmtDur(hoverRatio.value * (seekDur.value || 0)))
const clipTimeText = computed(() => fmtDur(clipTime.value))

/* P4.4 进度条几何：thumb 直径由 playerExtras 的唯一常量决定（桌面 14px / 窄屏 10px），
   以 CSS 变量落到 .p-seek-col 上 —— 进度条、标记轨、刻度层、浮层锚点读的是同一组数字。
   原生 range 的可视轨道 = 元素宽 - thumb 宽（两端各留半个 thumb），所以「比例 → 像素」必须带上这个内缩，
   否则标记轨按容器全宽铺开，两端各偏半个 thumb（用户看到的「进度条和刻度没有对齐」）。 */
const thumbPx = computed(() => seekThumbPx(isMobile.value))

const seekVars = computed(() => ({
  '--seek-thumb': thumbPx.value + 'px',
  '--thumb-r': thumbPx.value / 2 + 'px'
}))

/** 进度条已播放部分（CSS 渐变的断点）：原生 appearance 关掉后自己画填充，亮暗都跟 --accent */
const seekFillStyle = computed(() => {
  const dur = seekDur.value || 0
  const pos = seekPos.value || 0
  const pct = dur > 0 ? Math.min(100, Math.max(0, (pos / dur) * 100)) : 0
  return { '--p': pct.toFixed(3) + '%' }
})

/** 浮层水平位置：跟进度条比例走（与滑块中心同源，见 seekRatioCss），两侧留半宽避免出界（卡片宽 160，半宽 80） */
function floatStyle(ratio) {
  return { left: 'clamp(80px, ' + seekRatioCss(ratio) + ', calc(100% - 80px))' }
}

/** 指针位置 → 0~1 比例：先取 range 自身 rect（mousemove 挂在高 20px 的 .p-seekwrap 上，
    否则只有 4px 轨道能命中，指针稍偏就收不到事件），再按轨道几何（两端各半个 thumb）反解，
    hover 预览与标记命中的比例因此和滑块真实位置一致 */
function ratioFromEvent(e) {
  const el = seekEl.value || (e && e.currentTarget)
  if (!el || typeof el.getBoundingClientRect !== 'function') return 0
  const rect = el.getBoundingClientRect()
  if (!rect || !rect.width) return 0
  return seekPxToRatio(e.clientX - rect.left, rect.width, thumbPx.value)
}

/** 比例 → 精灵图格号 → col/row，再用 background-position 百分比切格（不依赖固定像素） */
const spriteStyle = computed(() => {
  const ratio = Math.min(1, Math.max(0, hoverRatio.value))
  const cell = Math.min(SPRITE_CELLS - 1, Math.floor(ratio * SPRITE_CELLS))
  const col = cell % SPRITE_COLS
  const row = Math.floor(cell / SPRITE_COLS)
  return {
    backgroundImage: 'url("' + spriteSrc.value + '")',
    backgroundSize: SPRITE_COLS * 100 + '% ' + SPRITE_ROWS * 100 + '%',
    backgroundPosition:
      (col / (SPRITE_COLS - 1)) * 100 + '% ' + (row / (SPRITE_ROWS - 1)) * 100 + '%'
  }
})

/** 1px 指示线位置：与卡片同源比例（同一套轨道几何），提示「这条轨道可以 hover 出预览」 */
const hoverLineStyle = computed(() => ({
  left: seekRatioCss(hoverRatio.value)
}))

function onSeekHover(e) {
  if (!canHover.value || !hasSprite.value) return
  if (clipVisible.value) {
    // 拖动中只显示预览视频：卡片与视频浮层同位置同尺寸，叠在一起看不清
    hoverVisible.value = false
    return
  }
  hoverRatio.value = ratioFromEvent(e)
  hoverVisible.value = true
}

function onSeekLeave() {
  hoverVisible.value = false
}

/** 按拖动比例把预览视频定位到对应帧（元数据未到时先 load，loadedmetadata 再补定位） */
function seekClip(ratio) {
  const r = Math.min(1, Math.max(0, Number(ratio) || 0))
  clipRatio.value = r
  const dur = clipDur > 0 ? clipDur : CLIP_FALLBACK_SEC
  clipTime.value = r * dur
  const el = clipEl.value
  if (!el) return
  if (!el.readyState) {
    try {
      el.load()
    } catch {
      /* 忽略：个别浏览器对未挂载的 src 直接抛 */
    }
    return
  }
  try {
    el.currentTime = Math.max(0, Math.min(dur - 0.04, clipTime.value))
  } catch {
    /* 忽略：未就绪的流拒绝赋值 */
  }
}

function onClipMetadata() {
  const el = clipEl.value
  const d = el && el.duration
  if (isFinite(d) && d > 0) clipDur = d
  seekClip(clipRatio.value)
}

/** 拖动开始：露出预览视频（<video> 下一帧才挂载，定位放到 nextTick） */
function showClip(ratio) {
  if (!hasPreview.value) return
  hoverVisible.value = false
  clipVisible.value = true
  seekClip(ratio)
  nextTick(() => seekClip(clipRatio.value))
}

function hideClip() {
  clipVisible.value = false
}

const subSrc = computed(() => (props.video && props.video.sub ? api.subUrl(props.video.sub) : ''))
const tagList = computed(() => props.video.tags || [])
const actorList = computed(() => props.video.actors || [])

const qLabel = (q) => Q_LABELS[q] || '原画'

/** app.js:230-234 fmtDur */
function fmtDur(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return '--:--'
  const t = Math.round(sec)
  const m = Math.floor(t / 60)
  const s = t % 60
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
}

/** app.js:236-241 fmtSize */
function fmtSize(bytes) {
  const MB = 1048576
  const GB = 1073741824
  if (bytes == null || !isFinite(bytes)) return '—'
  if (bytes >= GB) return (bytes / GB).toFixed(2) + ' GB'
  if (bytes >= MB) return (bytes / MB).toFixed(1) + ' MB'
  return Math.round(bytes / 1024) + ' KB'
}

/** app.js:221-228 resBadge */
function resBadge(w) {
  if (!w) return ''
  if (w >= 3840) return '4K'
  if (w >= 2560) return '2K'
  if (w >= 1920) return '1080p'
  if (w >= 1280) return '720p'
  return w + 'w'
}

watch(
  () => props.quality,
  (q) => {
    curQ.value = Q_VALUES.indexOf(q) >= 0 ? q : 'orig'
  }
)

/* ---------------------------------------------------------------- 位置换算 */

/** 绝对内容位置 = 流起点 + 片内偏移 */
function absPos() {
  const el = videoEl.value
  const t = (el && el.currentTime) || 0
  return (isTranscode.value ? streamStart : 0) + t
}

/** 内容总时长：原画取 video.duration；转码流取索引里的 dur（流时长是剩余段长度） */
function contentDur(v) {
  const el = videoEl.value
  const d = el ? el.duration : NaN
  if (!isTranscode.value && isFinite(d) && d > 0) return d
  const src = v || props.video || {}
  if (isFinite(src.dur) && src.dur > 0) return src.dur
  return isFinite(d) && d > 0 ? d : 0
}

/** 源地址：原画走 /file?p=，转码走 /stream?p=&q=&t=（与 app.js:1035-1039 完全一致） */
function srcFor(v, startSec) {
  if (curQ.value === 'orig') return api.mediaFileUrl(v.rel)
  return api.streamUrl(v.rel, { q: curQ.value, startSec: Math.max(0, Math.floor(startSec || 0)) })
}

/* ---------------------------------------------------------------- 转码提示 */

function endQHint() {
  if (qHintTimer) {
    clearTimeout(qHintTimer)
    qHintTimer = 0
  }
  qHintVisible.value = false
}

/** 首字节超过 3 秒才提示「转码中…」，避免一闪而过（app.js:1080-1084） */
function beginQHint() {
  endQHint()
  if (!isTranscode.value) return
  qHintTimer = setTimeout(() => {
    qHintVisible.value = true
  }, 3000)
}

/* ---------------------------------------------------------------- 进度条 */

function updateSeekUi() {
  const dur = contentDur() || 0
  if (dur > 0) seekMax.value = Math.round(dur)
  seekDur.value = dur
  if (qSeekDragging) return
  const pos = absPos()
  if (isFinite(pos) && pos >= 0) seekPos.value = Math.round(pos)
}

/** 原画模式 seek：直写 currentTime，浏览器按 Range 取新位置（不重开流、不动 streamStart） */
function seekOrigTo(sec) {
  const el = videoEl.value
  if (!el) return
  const d = isFinite(el.duration) && el.duration > 0 ? el.duration : 0
  const cap = d || (seekMax.value > 0 ? seekMax.value : 0)
  let t = Number(sec) || 0
  if (cap > 0) t = Math.min(t, cap)
  t = Math.max(0, t)
  try {
    el.currentTime = t
  } catch {
    /* 忽略：未就绪的流拒绝赋值 */
  }
  seekPos.value = Math.round(t)
}

/* ---------------------------------------------------------------- 换源 */

/** absStart 是转码流的内容起点，seekAbs 是加载后要落到的内容位置（0 = 不跳） */
function applySource(v, absStart, seekAbs) {
  streamStart = isTranscode.value ? Math.max(0, Math.floor(absStart || 0)) : 0
  pendingSeek = seekAbs > 0.5 ? seekAbs : 0
  lastQSrcAt = Date.now()
  const el = videoEl.value
  if (!el) return
  el.src = srcFor(v, streamStart)
  el.load()
  // P4.1：换源（切清晰度 / 转码重开流 / 换片）会把 playbackRate 打回 1 —— 这里重新落一次倍速，
  // 保证「切清晰度后仍保持当前倍速」（defaultPlaybackRate 一并写，避免下次 load 又丢）
  applySpeed()
  beginQHint()
  updateSeekUi()
}

/** 自动播放可能被浏览器拦截（无用户手势 + 有声音）：不报错，露出「点击播放」兜底 */
function tryPlay() {
  const el = videoEl.value
  if (!el) return
  const p = el.play()
  if (p && p.catch) p.catch(() => { tapVisible.value = true })
}

/* ---------------------------------------------------------------- 埋点结算 */

/** 完播率：absPos 已处理转码 offset，contentDur 已处理时长口径（app.js:99-107） */
function playProgress() {
  const dur = contentDur()
  if (!(dur > 0)) return 0
  const pct = (absPos() / dur) * 100
  if (!isFinite(pct)) return 0
  return Math.min(100, Math.max(0, Math.round(pct)))
}

/** 结算本段观看：暂停 / 结束 / 切视频 / 关闭 / 离开都会走到 */
function settlePlay(id) {
  const vid = id == null ? (props.video ? props.video.id : '') : id
  if (!vid) return
  props.tracker.trackPlayEnd(vid, undefined, playProgress())
}

/* ---------------------------------------------------------------- 进度记忆 */

/** 距结尾 15 秒内视为看完（app.js:1180-1194） */
function savePosFor(v) {
  const el = videoEl.value
  if (!v || !el) return
  const dur = contentDur(v)
  const pos = absPos()
  if (!dur || !isFinite(dur)) return
  if (dur - pos <= 15) {
    emit('clear-pos', v.id)
    emit('push-recent', { id: v.id, pos: 0, dur, force: true })
  } else if (pos > 1) {
    emit('save-pos', { id: v.id, pos, dur })
    emit('push-recent', { id: v.id, pos, dur })
  }
}

/** 播放中每 5 秒 / 暂停时上报服务端最近浏览（app.js:985-998，沿用原页 raw currentTime 口径） */
function pushRecentServerFor(v) {
  const el = videoEl.value
  if (!el || !v) return
  const dur = isFinite(el.duration) && el.duration > 0 ? el.duration : v.dur || 0
  const pos = el.currentTime || 0
  if (!(pos > 0.5)) return
  lastRecentPush = Date.now()
  emit('push-recent', { id: v.id, pos, dur })
}

function pushRecentServer() {
  pushRecentServerFor(props.video)
}

/* ---------------------------------------------------------------- 打开 / 切换 */

function openVideo(v, resumePos) {
  const el = videoEl.value
  if (!el || !v) return
  openedVideo = v
  // P4-B：AB 点与帧取样都是「这一部」的状态，换片/重开必须清空（增益、倍速与帮助浮层是用户偏好，保留）
  abA.value = null
  abB.value = null
  laneLastKey = '' // 换片后「区间标记再点一下跳 endPos」的记忆要重来，否则可能撞上同名 key
  stopFrameSampling()
  props.tracker.openPlaySession(v.id) // 新的播放器会话：本会话只报一次 play
  const pos = Math.max(0, Number(resumePos) || 0)
  const total = v.dur || 0
  const canResume = pos > 1 && (!total || pos < total - 15)
  restartVisible.value = canResume
  warnVisible.value = v.browserOk === false
  qFallback = false
  el.pause()
  el.removeAttribute('src')
  applySource(v, canResume ? pos : 0, canResume ? pos : 0)
  lastPosWrite = Date.now()
  lastRecentPush = Date.now()
  tapVisible.value = false
  isPlaying.value = false
  onVolumeChange()
  // 换片 / 重开：浮层不能残留上一部的格子与预览帧（clipDur 也要重测）
  hoverVisible.value = false
  hideClip()
  clipDur = 0
  tryPlay()
}

/** 打开 / 换片 / 同片重开都走这里：先结算上一段，再起新源 */
watch(
  () => (props.video ? props.video.id : '') + '#' + props.openSeq,
  () => {
    const prev = openedVideo
    if (prev && prev.id !== props.video.id) {
      savePosFor(prev)
      pushRecentServerFor(prev)
    }
    if (prev) settlePlay(prev.id)
    openVideo(props.video, props.startPos)
  }
)

/** 全屏状态镜像：只用于切换控制条上的「全屏 / 退出全屏」标签 */
function onFsChange() {
  const d = document
  fsActive.value = !!(d.fullscreenElement || d.webkitFullscreenElement)
}

/* iOS 视频元素全屏（webkitEnterFullscreen）不触发 document 的 fullscreenchange，
   靠元素自身的 webkitbegin/endfullscreen 同步按钮图标；桌面端这两个事件永不触发。 */
function onIosFsIn() {
  fsActive.value = true
}

function onIosFsOut() {
  fsActive.value = false
}

onMounted(() => {
  if (mobileMq && mobileMq.addEventListener) mobileMq.addEventListener('change', onMobileMqChange)
  document.addEventListener('fullscreenchange', onFsChange)
  document.addEventListener('webkitfullscreenchange', onFsChange)
  // P4.3：标记列表浮层的「点外部收起」（capture，先于按钮 click）
  document.addEventListener('pointerdown', onDocPointerDown, true)
  // P4.4：页面级快捷键也算「有操作」，全屏下控制条据此重新计时
  document.addEventListener('keydown', onDocKeydown)
  openVideo(props.video, props.startPos)
})

onBeforeUnmount(() => {
  if (mobileMq && mobileMq.removeEventListener) {
    mobileMq.removeEventListener('change', onMobileMqChange)
  }
  document.removeEventListener('fullscreenchange', onFsChange)
  document.removeEventListener('webkitfullscreenchange', onFsChange)
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  document.removeEventListener('keydown', onDocKeydown)
  // P4.4：清掉自动隐藏计时器（否则卸载后仍会回调一次 onChange）
  ctrlAuto.dispose()
  endQHint()
  // P4-B：释放请求的帧回调与 WebAudio 图（不释放会一直占着 AudioContext，Chrome 上限 6 个）
  stopFrameSampling()
  closeAudioGraph()
  const el = videoEl.value
  const v = openedVideo || props.video
  if (v) savePosFor(v)
  settlePlay(v ? v.id : '')
  if (el) {
    el.pause()
    el.removeAttribute('src')
    el.load()
  }
})

/* ---------------------------------------------------------------- 清晰度 */

function onQualityChange(e) {
  const nq = e.target.value
  if (Q_VALUES.indexOf(nq) < 0 || nq === curQ.value) return
  qFallback = false // 手动选档允许重试
  const el = videoEl.value
  const abs = absPos() // 先按旧档取绝对位置
  const wasPlaying = !!el && !el.paused && !el.ended
  curQ.value = nq
  emit('update:quality', nq)
  updateSeekUi()
  applySource(props.video, abs, abs)
  if (wasPlaying) tryPlay()
}

/* ---------------------------------------------------------------- 拖动 */

function onSeekInput(e) {
  qSeekDragging = true
  syncCtrlState()
  const target = Number(e.target.value) || 0
  seekPos.value = target
  // 拖动中露预览视频：比例 = 当前进度 / 总时长（与松手后的 seek 目标同源）
  if (hasPreview.value) showClip(seekMax.value > 0 ? target / seekMax.value : 0)
  // 原画：拖动即写 currentTime；转码流只能松手后重开流（拖动中不动 currentTime，不动 offset）
  if (!isTranscode.value) seekOrigTo(target)
}

function onSeekCommit(e) {
  qSeekDragging = false
  syncCtrlState()
  hideClip()
  const target = Number(e.target.value) || 0
  if (!isTranscode.value) {
    seekOrigTo(target)
    updateSeekUi()
    return
  }
  applySource(props.video, target, 0)
  tryPlay()
}

/** 进度条键盘 ←/→：自己处理并阻断冒泡，避免与页面级快捷键重复跳一次 */
function onSeekKey(e) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  e.stopPropagation()
  const step = e.shiftKey ? 15 : 5
  seekRel(e.key === 'ArrowLeft' ? -step : step)
  if (!isTranscode.value) seekPos.value = Math.round(absPos())
}

/* ================================================================================
   P4-B：AB 循环 / 逐帧 / 音量增益 / 标记刻度 / 快捷键浮层
   全部按「内容时间」工作（absPos / contentDur 已处理转码流起点），因此与进度记忆、
   清晰度切换、埋点口径完全一致；下面除了 onTimeUpdate 里新增的一行回跳判定外，
   没有改动任何既有函数体。
   ================================================================================ */

/** 快捷键总表：帮助浮层与控制条 title 共用同一份文案（避免两处写死不同步） */
const SHORTCUTS = [
  { k: '空格', v: '播放 / 暂停' },
  { k: '← / →', v: '后退 / 前进 5 秒（进度条聚焦时仍是 5 秒，Shift 为 15 秒）' },
  { k: 'Shift+← / →', v: '上一帧 / 下一帧（暂停态单帧步进）' },
  { k: ', / .', v: '上一帧 / 下一帧（与 Shift+← / → 等价，会自动先暂停）' },
  { k: 'A', v: '设 A 点（再按一次 A 清除 A 与 B）' },
  { k: 'B', v: '设 B 点（再按一次 B 只清终点）；播放到 B 自动回跳 A' },
  { k: '↑ / ↓', v: '音量 ±10%（0–100%；100% 以上用音量滑块旁的「增益」按钮循环 1×/1.5×/2×）' },
  { k: '[ / ]', v: '减速 / 加速播放（视频倍速 0.5×–2×，按档位步进，与 A/B、逐帧互不影响）' },
  { k: 'F', v: '全屏 / 退出全屏' },
  { k: 'N / P', v: '下一部 / 上一部' },
  { k: '?', v: '打开 / 关闭本浮层' },
  { k: 'Esc', v: '先关本浮层，再关播放器' }
]

const helpVisible = ref(false)

/** AB 点：绝对内容秒；null = 未设 */
const abA = ref(null)
const abB = ref(null)
const abState = computed(() => ({ a: abA.value, b: abB.value }))
const abOn = computed(() => abActive(abState.value))
const abTitle = computed(() =>
  abOn.value ? 'A/B 循环中：播放到 B 自动回跳 A（再按 A 或 B 清除）' : 'A 设起点、B 设终点；两点都设好后循环生效'
)
const abText = computed(() => {
  if (abA.value == null && abB.value == null) return 'A/B'
  const a = abA.value == null ? '--:--' : fmtMark(abA.value)
  const b = abB.value == null ? '--:--' : fmtMark(abB.value)
  return (abOn.value ? '↻ ' : '') + 'A ' + a + ' · B ' + b
})

/** 逐帧：帧间隔沿用 1/30，拿到 requestVideoFrameCallback 后按实测值校正 */
const frameSec = ref(FRAME_FALLBACK_SEC)
let frameSamples = []
let rvfcHandle = 0

/** 增益档位（持久化在 localStorage['ms.gain']；100% 之上靠 WebAudio GainNode） */
const gainLevel = ref(readGainLevel(safeStorage()))
const gainFallback = ref(false)
let audioGraph = null

/**
 * 视频倍速（P4.1）：persist 在 localStorage['ms.speed']，默认 1×。
 * 只改 <video>.playbackRate，不动 currentTime —— AB 回跳、逐帧、进度记忆与埋点都读
 * 内容时间（absPos），因此倍速对它们完全透明。
 */
const speedLevel = ref(readSpeedLevel(safeStorage()))

const gainNote = computed(() =>
  gainFallback.value ? '浏览器不支持 WebAudio 增益，已降级为 0–200% 音量映射（100% 封顶）' : ''
)

const gainTitle = computed(
  () =>
    '音量增益 ' +
    gainLevel.value +
    '×（点一下切到 ' +
    nextGain(gainLevel.value) +
    '×）' +
    (gainFallback.value && gainLevel.value > 1 ? '（浏览器不支持 WebAudio，已降级为音量映射）' : '')
)

const speedTitle = computed(() => '视频倍速 ' + speedLabel(speedLevel.value) + '（快捷键 [ 减速 / ] 加速）')

// 依赖 seekDur（响应式）而不是 contentDur()（读 videoEl.duration，非响应式）：元数据晚到时刻度也能补画
const markerTickList = computed(() => buildMarkerTicks(props.markers, seekDur.value || contentDur(), fmtMark))

/** hover 命中的刻度（null = 没命中）；提示文案直接用刻度自带的 title */
const markerHover = ref(null)

/**
 * 命中判定：单点用 ±1.2% 的容差（2px 竖线太细），区间用整段宽度；
 * 距离取到刻度中心，离得最近的优先。鼠标离开进度条时清空。
 * 注意：这里只读 markerTickList（已按位置排好序），不产生任何请求。
 */
function onMarkerHover(e) {
  if (!markerTickList.value.length) return
  const pct = ratioFromEvent(e) * 100
  let best = null
  for (const t of markerTickList.value) {
    const mid = t.width > 0 ? t.left + t.width / 2 : t.left
    const half = Math.max(1.2, t.width / 2)
    const d = Math.abs(pct - mid)
    if (d <= half + 0.6 && (best == null || d < best.d)) best = { d, t }
  }
  markerHover.value = best ? best.t : null
}

function onMarkerLeave() {
  markerHover.value = null
}

function markerTickStyle(t) {
  const style = { left: t.left + '%', background: t.color || 'var(--accent)' }
  if (t.width > 0) style.width = t.width + '%'
  return style
}

/**
 * 标记轨上单个标记的内联样式（尺寸常量来自 playerExtras，SCSS 里不再另写一套数字）：
 * - 单点：4px 宽通高竖条（P4.3 由 3px 加粗），left% 居中（margin-left 拉回半宽）；
 * - 区间：色带按 width% 铺开 + 左右各 3px 实心边（P4.3 由 2px 加粗，border-box，边框不额外加宽）；
 * - 颜色一律用标记自带的 color，没有 color 用主题强调色（--accent），亮暗主题都跟随。
 */
function laneMarkStyle(t) {
  const color = t.color || 'var(--accent)'
  const style = {
    left: t.left + '%',
    borderColor: color
  }
  if (t.isRange) {
    style.width = t.width + '%'
    // 半透明色带 + 实心边：单点用实心色，区间用 45% 混色（P4.3 由 34% 提高，亮暗底上都看得出边界）
    style.background = 'color-mix(in srgb, ' + color + ' ' + LANE_RANGE_MIX_PCT + '%, transparent)'
  } else {
    style.width = LANE_PIN_PX + 'px'
    style.marginLeft = -(LANE_PIN_PX / 2) + 'px'
    style.background = color
  }
  return style
}

/** 标记轨 hover / 聚焦：复用进度条上方的 .p-marker-tip（文案就是刻度自带的 title） */
function onLaneHover(t) {
  markerHover.value = t || null
}

function onLaneLeave() {
  markerHover.value = null
}

/** 点击标记跳转：单点跳 pos；区间第一次跳 pos，再点同一条跳 endPos（规则在 markJumpTarget） */
let laneLastKey = ''
function onLaneClick(t) {
  const jump = markJumpTarget(t, laneLastKey)
  laneLastKey = jump.next
  if (jump.sec == null) return
  seekAbsTo(jump.sec, undefined)
}

/* ================= P4.3 标记轨尺寸变量 + 标记数量徽标 ================= */

/**
 * 标记轨的尺寸只由 playerExtras 的 LANE_* 常量决定，这里把它们落到 CSS 变量，
 * 让 SCSS 里的 height / margin-top / 边宽 / 探出量都读同一份数字（窄屏高度用 --lane-h-sm）。
 */
const laneVars = {
  '--lane-h': LANE_HEIGHT_PX + 'px',
  '--lane-h-sm': LANE_HEIGHT_PX_MOBILE + 'px',
  '--lane-gap': LANE_GAP_PX + 'px',
  '--lane-edge': LANE_EDGE_PX + 'px',
  '--lane-raise': LANE_RAISE_PX + 'px'
}

/** 徽标文案：hover 提示「N 个标记」（点击展开可跳转列表） */
const markerBadgeTitle = computed(() => markerTickList.value.length + ' 个标记 · 点击展开列表')

/** 徽标列表是否展开（只在有标记时才有意义；换片 / 点外部都会收起） */
const markerListOpen = ref(false)
const mkBadgeEl = ref(null)

function toggleMarkerList() {
  if (!markerTickList.value.length) return
  markerListOpen.value = !markerListOpen.value
}

function closeMarkerList() {
  markerListOpen.value = false
}

/**
 * 列表里点一条：跳到该标记的起点（区间 = 起点；起点→终点的连点语义仍由标记轨上的 markJumpTarget 提供）。
 * 点完立即收起，避免浮层压住进度条。
 */
function onMarkPick(t) {
  markerListOpen.value = false
  if (!t || t.startSec == null) return
  seekAbsTo(t.startSec, undefined)
}

/** 点浮层外部收起：capture 阶段监听，先于任何按钮的 click 执行，不干扰播放器其它点击 */
function onDocPointerDown(e) {
  if (!markerListOpen.value) return
  const el = mkBadgeEl.value
  if (el && e.target && typeof el.contains === 'function' && el.contains(e.target)) return
  markerListOpen.value = false
}

/** 换片时收起列表（新片的标记还没到，列表留着的旧条目会跳错位置） */
watch(
  () => (props.video ? props.video.id : ''),
  () => {
    markerListOpen.value = false
  }
)

/* ============================================ P4.4 全屏控制条自动隐藏 ============================================ */

/**
 * 判定规则（完整条件见 playerExtras 的 ctrlCanHide，单测覆盖）：
 *   全屏 + 播放中 + 指针不在控制条上 + 没在拖进度条 + 没有浮层展开
 *   → 2.5s 内没有任何操作（mousemove / mousedown / keydown / touchstart）就淡出。
 * 非全屏一律常驻：鼠标一离开就消失会让人以为控制条坏了。
 * P4.7：「控制条内无焦点」已从条件里删掉 —— 点一下控制条按钮焦点就留在上面（点画面不会移走，
 * <video> 不可聚焦），条件恒不满足 = 永不隐藏。焦点改由隐藏前的 willHide/blurActiveInCtrl 处理。
 */
const ctrlHidden = ref(false)
/** 指针是否停在控制条上（mouseenter / mouseleave，并用坐标 + 矩形复核） */
let ctrlHover = false
/** 最后一次指针位置：边界事件没来时用它兜底判断「指针其实还停在控制条上」 */
let lastPointer = { x: -1, y: -1 }

/**
 * 指针是否在控制条上（几何判定见 playerExtras.pointerInCtrlZone，单测覆盖）：
 * 以「坐标 + 矩形」为准，elementFromPoint 只作补充 —— 隐藏态 .p-ctrl 是
 * translateY(100%) + pointer-events:none，getBoundingClientRect 把它算到屏幕外，
 * 只靠 rect / 只靠 mouseenter-mouseleave 都会判错。
 */
function pointerOverCtrl() {
  return pointerInCtrlZone(ctrlEl.value, fsEl.value, lastPointer)
}

/** 浮层（hover 预览 / 拖动预览 / 标记提示 / 标记列表）展开时不隐藏：否则会留下一张没有控制条的浮卡片 */
const ctrlOverlayOpen = computed(
  () => !!(hoverVisible.value || clipVisible.value || markerHover.value || markerListOpen.value)
)

const ctrlAuto = createCtrlAutoHide({
  onChange: (hidden) => {
    ctrlHidden.value = hidden
  },
  // 隐藏时 .p-ctrl 是 pointer-events:none，边界事件未必补发：按矩形兜底，指针还在条上就不隐藏
  guard: () => !pointerOverCtrl(),
  // 隐藏前把焦点挪出控制条：opacity:0 + pointer-events:none 上不该留着焦点
  // （P4.7：焦点不再是隐藏条件，这就是它的替代保护 —— 不留焦点在看不见的控件上）
  willHide: () => {
    blurActiveInCtrl(ctrlEl.value)
  }
})

/**
 * 外部状态同步：只有这几个开关影响「能不能隐藏」，每变一次都重新计时。
 * P4.7：不再上报 focus —— 焦点钳制隐藏正是「控制条再也不隐藏」的根因。
 */
function syncCtrlState() {
  ctrlAuto.update({
    fullscreen: fsActive.value,
    playing: isPlaying.value,
    hover: ctrlHover || pointerOverCtrl(),
    dragging: qSeekDragging,
    overlay: ctrlOverlayOpen.value
  })
}

/**
 * 任意用户操作：立即显示并重置 2.5s 计时（非全屏直接返回，不产生无谓的计时器）。
 * 同时用坐标复核悬停态：隐藏态 .p-ctrl 没有指针事件，mouseenter / mouseleave 收不到，
 * 只信边界事件会让 ctrlHover 卡在旧值（要么永不隐藏，要么唤不出来）。
 */
function onUserActivity(e) {
  if (e && typeof e.clientX === 'number') lastPointer = { x: e.clientX, y: e.clientY }
  if (!fsActive.value) return
  ctrlAuto.activity()
  const over = pointerOverCtrl()
  if (over !== ctrlHover) {
    ctrlHover = over
    syncCtrlState()
  }
}

function onCtrlPointerEnter(e) {
  if (e && typeof e.clientX === 'number') lastPointer = { x: e.clientX, y: e.clientY }
  ctrlHover = true
  syncCtrlState()
}

function onCtrlPointerLeave(e) {
  if (e && typeof e.clientX === 'number') lastPointer = { x: e.clientX, y: e.clientY }
  ctrlHover = pointerOverCtrl()
  syncCtrlState()
}

/** 控制条内出现焦点（鼠标点按钮 / Tab 进入）→ 显示并重新计时；焦点本身不再阻止隐藏 */
function onCtrlFocusIn() {
  if (!fsActive.value) return
  ctrlAuto.activity()
  syncCtrlState()
}

/** 页面级快捷键（空格 / A / B / [ ] / F …）不经过播放器 DOM：文档级 keydown 也算「有操作」 */
function onDocKeydown() {
  if (!fsActive.value) return
  onUserActivity()
}

watch(fsActive, syncCtrlState)
watch(isPlaying, syncCtrlState)
watch(ctrlOverlayOpen, syncCtrlState)

/* 换片 / 同片重开：控制条恢复常驻，不把上一部的隐藏状态带过来 */
watch(
  () => (props.video ? props.video.id : '') + '#' + props.openSeq,
  () => {
    ctrlHover = false
    lastPointer = { x: -1, y: -1 }
    syncCtrlState()
  }
)

/** 标记 / AB 文案用的时间格式：0 秒要显示 00:00（fmtDur 对 0 返回 --:--，是给「未知时长」用的） */
function fmtMark(sec) {
  const n = Number(sec)
  const t = Math.max(0, Math.round(isFinite(n) ? n : 0))
  const m = Math.floor(t / 60)
  const s = t % 60
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
}

function safeStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------ AB 循环 */

/** A / B 按钮与快捷键的唯一入口：按下即设点，再按一次清除（规则在 playerExtras.abPress 里） */
function setAbPoint(edge) {
  const next = abPress(abState.value, edge, absPos())
  abA.value = next.a
  abB.value = next.b
}

function clearAb() {
  abA.value = null
  abB.value = null
}

/**
 * 播放推进时的循环判定：到/过 B 就回跳 A。
 * 返回 true 表示这一帧已经发生回跳（调用方跳过存盘，避免把 A 点前的进度当成本次进度写库）。
 */
function abLoopJump() {
  const target = abTick(abState.value, absPos())
  if (target == null) return false
  seekAbsTo(target, true)
  return true
}

/** 跳转到绝对内容时间（转码 = 重开流，原画 = 直写 currentTime）——AB 回跳与逐帧共用 */
function seekAbsTo(abs, keepPlaying) {
  const el = videoEl.value
  if (!el || !props.video) return
  const dur = contentDur()
  let target = Number(abs) || 0
  if (dur > 0) target = Math.min(target, Math.max(0, dur - 0.05))
  target = Math.max(0, Math.round(target * 1000) / 1000)
  if (!isTranscode.value) {
    seekOrigTo(target)
    updateSeekUi()
    return
  }
  const wasPlaying = keepPlaying === true || (!el.paused && !el.ended)
  applySource(props.video, target, 0)
  if (wasPlaying) tryPlay()
}

/* -------------------------------------------------------------- 逐帧 */

/** 单帧步进：暂停态才有意义，播放中先暂停；转码模式按内容时间重开流（与 seekRel 同一条路径） */
function stepFrame(dir) {
  const el = videoEl.value
  if (!el) return
  if (!el.paused) el.pause()
  const cur = absPos()
  const next = frameStep(cur, dir, frameSec.value, contentDur())
  if (Math.abs(next - cur) < 0.0005) return
  seekAbsTo(next, false)
  sampleFrameDuration()
}

/**
 * 用 requestVideoFrameCallback 的 mediaTime 校正帧间隔：
 * 暂停态每 seek 一帧回调一次，攒够两帧就能算出真实间隔；两帧的差值异常则保留 1/30。
 */
function sampleFrameDuration() {
  const el = videoEl.value
  if (!el || typeof el.requestVideoFrameCallback !== 'function' || rvfcHandle) return
  const onFrame = (now, meta) => {
    rvfcHandle = 0
    if (!meta || !isFinite(meta.mediaTime)) return
    frameSamples.push(meta.mediaTime)
    if (frameSamples.length > 4) frameSamples.shift()
    if (frameSamples.length >= 2) frameSec.value = frameStepSize(frameSamples, FRAME_FALLBACK_SEC)
  }
  rvfcHandle = el.requestVideoFrameCallback(onFrame)
}

function stopFrameSampling() {
  const el = videoEl.value
  if (rvfcHandle && el && typeof el.cancelVideoFrameCallback === 'function') {
    el.cancelVideoFrameCallback(rvfcHandle)
  }
  rvfcHandle = 0
  frameSamples = []
}

/* ------------------------------------------------------------ 音量增益 */

function audioCtor() {
  if (typeof window === 'undefined') return null
  return window.AudioContext || window.webkitAudioContext || null
}

/** 增益档位：>1 才需要 WebAudio；浏览器拒绝时置 gainFallback 并说明（音量仍走 <video>.volume） */
function setGain(level) {
  const next = normalizeGain(level)
  gainLevel.value = next
  writeGainLevel(safeStorage(), next)
  if (next <= 1) {
    applyGain(audioGraph, 1)
    return
  }
  if (!audioGraph) {
    audioGraph = createGainGraph(audioCtor(), videoEl.value, next)
    if (!audioGraph.ok) {
      audioGraph = null
      gainFallback.value = true
      const el = videoEl.value
      if (el) {
        el.volume = 1
        el.muted = false
      }
      onVolumeChange()
      return
    }
  }
  if (!applyGain(audioGraph, next)) {
    gainFallback.value = true
    return
  }
  const el = videoEl.value
  if (el && el.muted) el.muted = false
  onVolumeChange()
}

/** 增益循环按钮的唯一入口：1× → 1.5× → 2× → 1×（档位切换仍走 setGain，行为与 P4-B 完全一致） */
function cycleGain() {
  setGain(nextGain(gainLevel.value))
}

/* ------------------------------------------------------------ 视频倍速 */

/** 把当前档位落到 <video> 上：playbackRate 管这一次播放，defaultPlaybackRate 兜住之后的 load */
function applySpeed() {
  const el = videoEl.value
  if (!el) return
  const rate = normalizeSpeed(speedLevel.value)
  try {
    el.defaultPlaybackRate = rate
    el.playbackRate = rate
  } catch {
    /* 忽略：个别浏览器在未就绪的流上拒绝赋值，下一次 applySource 会再落一次 */
  }
}

/** 倍速唯一写入口：归一化 → 持久化 → 落到元素（下拉与快捷键都走这里） */
function setSpeed(level) {
  speedLevel.value = normalizeSpeed(level)
  writeSpeedLevel(safeStorage(), speedLevel.value)
  applySpeed()
}

function onSpeedChange(e) {
  setSpeed(e && e.target ? e.target.value : 1)
}

/** 快捷键 [ / ]：dir<0 减速、dir>0 加速（档位表内步进，夹在 0.5×–2×） */
function changeSpeed(dir) {
  setSpeed(speedStep(speedLevel.value, dir))
}

function closeAudioGraph() {
  const graph = audioGraph
  audioGraph = null
  if (!graph) return
  try {
    if (graph.source && typeof graph.source.disconnect === 'function') graph.source.disconnect()
    if (graph.node && typeof graph.node.disconnect === 'function') graph.node.disconnect()
    if (graph.ctx && typeof graph.ctx.close === 'function') {
      const p = graph.ctx.close()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    }
  } catch {
    /* 忽略：关闭失败只影响下一次创建，不影响音频输出 */
  }
}

/* -------------------------------------------------------------- 帮助 */

function toggleHelp() {
  helpVisible.value = !helpVisible.value
}

/** 供页面级 Esc 使用：浮层开着时先关它，返回 true 表示这次 Esc 已被消费 */
function closeHelp() {
  if (!helpVisible.value) return false
  helpVisible.value = false
  return true
}

/* ---------------------------------------------------------------- video 事件 */

function onPlay() {
  isPlaying.value = true
  props.tracker.trackPlayStart(props.video.id)
}

function onPlaying() {
  isPlaying.value = true
  tapVisible.value = false
  endQHint()
}

/** 点画面切换播放/暂停：移除原生 controls 后补回等价能力 */
function onVideoClick() {
  togglePlay()
}

function onLoadedData() {
  endQHint()
  updateSeekUi()
}

function onDurationChange() {
  updateSeekUi()
}

/** 静音 / 音量滑块的唯一同步点：键盘 ↑/↓ 调 el.volume 时也会走到这里 */
function onVolumeChange() {
  const el = videoEl.value
  if (!el) return
  volume.value = isFinite(el.volume) ? el.volume : 1
  muted.value = !!el.muted
}

function onVolumeInput(e) {
  const el = videoEl.value
  if (!el) return
  const v = Math.max(0, Math.min(1, Number(e.target.value) || 0))
  el.volume = v
  el.muted = v <= 0
  onVolumeChange()
}

function toggleMute() {
  const el = videoEl.value
  if (!el) return
  el.muted = !el.muted
  if (!el.muted && el.volume <= 0) el.volume = 0.5
  onVolumeChange()
}

function onLoadedMetadata() {
  updateSeekUi()
  if (!pendingSeek) return
  const abs = pendingSeek
  pendingSeek = 0
  const el = videoEl.value
  if (!el) return
  const rel = isTranscode.value ? Math.max(0, abs - streamStart) : abs
  const d = el.duration
  const target = !isTranscode.value && isFinite(d) && d > 0 && rel >= d - 2 ? 0 : rel
  try {
    el.currentTime = target
  } catch {
    /* 忽略：部分浏览器对未就绪的流拒绝赋值 */
  }
}

function onTimeUpdate() {
  updateSeekUi()
  // P4-B：到/过 B 立即回跳 A，这一帧不再走存盘（A 点前的位置不该被当成观看进度）
  if (abLoopJump()) return
  const now = Date.now()
  if (now - lastPosWrite >= 3000) {
    lastPosWrite = now
    savePosFor(props.video)
  }
  if (now - lastRecentPush >= 5000) pushRecentServer()
}

function onPause() {
  isPlaying.value = false
  savePosFor(props.video)
  pushRecentServer()
  settlePlay()
}

function onEnded() {
  isPlaying.value = false
  const v = props.video
  if (!v) return
  emit('clear-pos', v.id)
  const dur = contentDur(v) || v.dur || 0
  emit('push-recent', { id: v.id, pos: 0, dur, force: true })
  settlePlay()
}

/** 转码模式下浏览器发起的 seeking：片内偏移超过 5 秒就从新时间点重开流；原画直接由 Range 处理 */
function onSeeking() {
  if (!isTranscode.value || !props.video) return
  if (Date.now() - lastQSrcAt < 600) return // 换源刚发生，忽略随之而来的 seeking
  const el = videoEl.value
  if (!el) return
  const rel = el.currentTime || 0
  if (rel <= 5) return
  const wasPlaying = !el.paused && !el.ended
  applySource(props.video, streamStart + rel, 0)
  if (wasPlaying) tryPlay()
}

function onError() {
  tapVisible.value = false
  endQHint()
  // 转码流取不到（404 / 429 转码忙 / 503 ffmpeg 不可用）→ 回退原画，别让用户黑屏
  if (isTranscode.value && props.video && !qFallback) {
    qFallback = true
    const abs = absPos()
    curQ.value = 'orig'
    emit('update:quality', 'orig')
    updateSeekUi()
    applySource(props.video, 0, abs)
    tryPlay()
    return
  }
  const el = videoEl.value
  if (props.video && el && el.getAttribute('src')) warnVisible.value = true
}

/* ---------------------------------------------------------------- 交互 */

function onTapPlay() {
  tapVisible.value = false
  tryPlay()
}

function onRestart() {
  if (isTranscode.value && props.video) applySource(props.video, 0, 0) // 转码「从头」= 从 t=0 重开流
  else if (videoEl.value) videoEl.value.currentTime = 0
  restartVisible.value = false
  tryPlay()
  if (props.video) emit('clear-pos', props.video.id)
}

function togglePlay() {
  const el = videoEl.value
  if (!el) return
  if (el.paused) tryPlay()
  else el.pause()
}

/** ←/→：原画走原生跳转，转码流只能从新时间点重开流（app.js:1058-1072） */
function seekRel(delta) {
  const el = videoEl.value
  if (!el || !props.video) return
  if (isTranscode.value) {
    const dur = contentDur() || 0
    const target = Math.max(0, Math.min(dur > 0 ? dur : 1e9, absPos() + delta))
    const wasPlaying = !el.paused && !el.ended
    applySource(props.video, target, 0)
    if (wasPlaying) tryPlay()
    return
  }
  const d = el.duration
  const max = isFinite(d) && d > 0 ? d : 1e9
  el.currentTime = Math.max(0, Math.min(max, (el.currentTime || 0) + delta))
}

function adjustVolume(delta) {
  const el = videoEl.value
  if (el) el.volume = Math.max(0, Math.min(1, el.volume + delta))
}

/**
 * 全屏（P4.3 修复「全屏后没有控制栏」）：
 *   旧实现请求的是 .p-stage —— 它**只包 <video>**，自绘控制栏 .p-ctrl 是它的兄弟节点，
 *   一进全屏浏览器只显示被请求的那个元素，控制栏于是被挡在屏幕外（这就是病症）。
 *   现在请求的是 .p-fs-wrap（包 video + 控制栏），并给它 :fullscreen 下 display:flex / column / 黑底，
 *   控制栏固定在底部，进度条与其中的标记轨都可见。退出（F / Esc / 浏览器手势）由
 *   fullscreenchange → onFsChange 同步按钮图标，:fullscreen 样式失效后布局自动恢复。
 */
function toggleFullscreen() {
  const d = document
  const exit = d.exitFullscreen || d.webkitExitFullscreen
  if (d.fullscreenElement || d.webkitFullscreenElement) {
    if (exit) {
      const p = exit.call(d)
      if (p && p.catch) p.catch(() => {})
    }
    return
  }
  const wrap = fsEl.value || stageEl.value
  if (!wrap) return
  const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen
  if (req) {
    const p = req.call(wrap)
    if (p && p.catch) p.catch(() => {})
  } else if (videoEl.value && videoEl.value.webkitEnterFullscreen) {
    // iOS Safari：不支持元素全屏（requestFullscreen 在 div 上不可用），退化为「视频本身全屏」，
    // 此时控制栏由系统播放器提供（含系统进度条），自绘控制栏不参与；退出后按钮图标由
    // video 的 webkitbegin/endfullscreen 事件同步（见 onIosFsIn / onIosFsOut）。
    videoEl.value.webkitEnterFullscreen()
  }
}

/** 页面隐藏 / 卸载时只结算埋点（位置存盘由 onBeforeUnmount 负责，与 app.js tkPageHide 等价） */
function settle() {
  const v = openedVideo || props.video
  if (v) settlePlay(v.id)
}

defineExpose({
  togglePlay,
  seekRel,
  adjustVolume,
  toggleFullscreen,
  settle,
  /* ---- P4-B：页面级快捷键（A / B / , . / Shift+方向 / ? / Esc）走这几个入口 ---- */
  setAbPoint,
  clearAb,
  stepFrame,
  toggleHelp,
  closeHelp,
  /** P4.1：页面级快捷键 [ / ] 的入口（dir<0 减速、dir>0 加速） */
  changeSpeed,
  /** 当前内容位置（秒）：信息抽屉「在当前时间加标记」的起点；转码流已加上流起点 */
  getCurrentTime: absPos,
  /** P4.5：内容总时长（秒）：信息抽屉回填标记「区间终点」与片尾夹取用；转码流取索引里的 dur */
  getDuration: contentDur
})
</script>

<style lang="scss" scoped>
.player {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--fg);
}

.p-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 14px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--line);
}

.p-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.p-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.p-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 12px;
  color: var(--fg-dim);
}

.p-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.btn {
  padding: 7px 11px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-3);
  color: var(--fg);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, border-color 0.12s;
}

.btn:hover {
  border-color: var(--line-2);
}

.btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.btn-primary {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.p-fav.on {
  color: var(--warn);
  border-color: var(--warn);
  background: rgba(255, 201, 119, 0.14);
}

.p-warn {
  padding: 9px 14px;
  background: rgba(255, 93, 93, 0.18);
  border-bottom: 1px solid rgba(255, 93, 93, 0.45);
  color: var(--danger);
  font-size: 13px;
  font-weight: 600;
}

/* 自绘控制条：原画（直连）与转码共用一套；颜色只取 mediaTheme 变量（--bg/--fg/--line/--accent → --qt-*） */
.p-ctrl {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 14px 8px;
  background: var(--bg-2);
  border-top: 1px solid var(--line);
  min-width: 0;
  overflow: visible;
  /* P4.4：全屏自动隐藏的淡出（200ms）；非全屏永远不会加 .is-ctrl-hidden，等同常驻
     P4.6：全屏隐藏态加了 transform 位移（覆盖层下沉自身高度），过渡同步扩到 transform */
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.p-ctrlline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
  font-size: 12.5px;
  color: var(--fg-dim);
}

.p-ctrl-gap {
  flex: 1 1 auto;
}

.p-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-3);
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}

.p-btn:hover {
  border-color: var(--line-2);
}

.p-btn:active {
  background: var(--accent-soft);
}

.p-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.p-btn-play {
  min-width: 42px;
  color: var(--accent);
}

.p-vol {
  flex-shrink: 0;
  width: 86px;
  height: 4px;
  accent-color: var(--accent);
  cursor: pointer;
}

.p-vol:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}

.p-q-lab {
  flex-shrink: 0;
}

.p-q {
  flex-shrink: 0;
  max-width: 140px;
  padding: 3px 6px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}

.p-q:focus {
  outline: none;
  border-color: var(--accent);
}

.p-q-now {
  flex-shrink: 0;
  color: var(--fg);
  font-weight: 600;
}

.p-q-hint {
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  color: var(--accent);
  font-size: 12px;
}

/* 进度条行：原画直写 currentTime，转码重开流 + pendingSeek，UI 同一套 */
.p-seekbar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  overflow: visible;
}

/* P4.1：进度条与标记轨竖排成一列；.p-seekbar 仍是行布局（时间码在右） */
.p-seek-col {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* 进度条容器：hover 卡片 / 拖动预览 / 1px 指示线都挂在这一层（position:relative 的定位基准）。
   mousemove 挂在这一层（20px 命中带），而不是只有 4px 高的 range 轨道。
   P4.1：轨道改为贴底（align-items:flex-end）—— 20px 命中带下半部分空出来的位置正好给标记轨，
   标记轨与 4px 轨道之间才是真正的 2px 间距；hover 卡片仍锚在容器上方，定位不变 */
.p-seekwrap {
  position: relative;
  flex: 0 0 auto;
  width: 100%;
  min-height: 20px;
  min-width: 0;
  display: flex;
  align-items: flex-end;
  cursor: pointer;
  overflow: visible;
}

/* P4.4 进度条：thumb 尺寸改由 --seek-thumb 决定（值来自 playerExtras.SEEK_THUMB_PX，
   MediaPlayer 注入到 .p-seek-col），并自己接管 thumb / 轨道绘制。
   这样「可视轨道 = 元素宽 - thumb 宽（两端各半个 thumb）」是确定值 —— 标记轨按 var(--thumb-r)
   左右内缩即可与滑块中心逐像素对齐，不受各浏览器原生 thumb 尺寸影响（实测 Blink 原生 16px，
   比设计值大 2px，正是用户看到的两端错位）。
   轨道用渐变自绘填充：--p 是已播放百分比（seekFillStyle），亮暗主题都只读 mediaTheme 变量。 */
.p-seek {
  flex: 1;
  min-width: 0;
  height: 4px;
  margin: 0;
  padding: 0;
  border: 0;
  overflow: visible;
  border-radius: 2px;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
  background: linear-gradient(
    to right,
    var(--accent) 0 var(--p, 0%),
    color-mix(in srgb, var(--fg-dim) 38%, transparent) var(--p, 0%) 100%
  );
}

/* thumb：直径 = --seek-thumb（桌面 14px / 窄屏 10px），压在 4px 轨道正中（4px 高的元素盒，
   thumb 允许溢出，Chrome / Edge / Safari 与 Gecko 都按轨道中心摆放） */
.p-seek::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: var(--seek-thumb, 14px);
  height: var(--seek-thumb, 14px);
  border: 0;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.28);
}

/* Gecko：轨道默认会盖住 input 自己的渐变，置空让填充透出来；thumb 同一尺寸 */
.p-seek::-moz-range-track {
  height: 4px;
  border-radius: 2px;
  background: transparent;
}

.p-seek::-moz-range-progress {
  background: transparent;
}

.p-seek::-moz-range-thumb {
  width: var(--seek-thumb, 14px);
  height: var(--seek-thumb, 14px);
  border: 0;
  border-radius: 50%;
  background: var(--accent);
}

.p-seek:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}

/* hover 卡片 / 拖动预览：同为 160×90 浮层，颜色只取 mediaTheme 变量（= --qt-* 映射）。
   卡片在控制条上方弹出（控制条在舞台下方），z-index 抬到浮层最高，父级都不裁剪 */
.p-hover,
.p-clip {
  position: absolute;
  bottom: calc(100% + 8px);
  transform: translateX(-50%);
  z-index: 6;
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  background: var(--bg-2);
  box-shadow: 0 6px 18px var(--accent-soft);
  overflow: hidden;
  pointer-events: none;
}

/* 1px 指示线：hover 位置提示；只有 hasSprite 的片子会渲染，其它片子零浮层 */
.p-hover-line {
  position: absolute;
  top: -6px;
  bottom: -6px;
  width: 1px;
  background: var(--accent);
  opacity: 0.9;
  pointer-events: none;
  z-index: 5;
}

/* 精灵图单格也是 160×90：background-size 1000% 1000% + background-position 百分比切格，
   不写死像素，卡片缩放时格子仍对齐 */
.p-hover-img {
  width: 160px;
  height: 90px;
  background-repeat: no-repeat;
  background-color: var(--bg-3);
}

.p-clip-v {
  display: block;
  width: 160px;
  height: 90px;
  object-fit: cover;
  background: var(--bg-3);
}

.p-hover-t,
.p-clip-t {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 2px 6px;
  background: color-mix(in srgb, var(--bg) 78%, transparent);
  color: var(--fg);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.p-seek-now {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--fg-dim);
}

/* P4.3 全屏容器：包住 .p-stage（<video>）与 .p-ctrl（自绘控制栏）。
   平时它就是 .player 里的弹性列（顶替原来 .p-stage 占的那一格），视觉与改动前一致。 */
.p-fs-wrap {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #000;
}

/* 全屏时浏览器只渲染被请求的那个元素：容器撑满屏幕、黑底、列布局。
   （P4.3：旧实现把全屏请求发给只包 <video> 的 .p-stage，控制栏是它的兄弟节点，一进全屏就消失。）
   P4.6：控制栏不再留在流内 —— 它改成绝对覆盖层（见下面的 .p-ctrl 规则）。
   原因：流内 + 只改 opacity 隐藏时，控制条**仍占高度**，视频区被压短、底部留一条
   与控制条等高的黑边（用户全屏截图即此）。 */
.p-fs-wrap:fullscreen,
.p-fs-wrap:-webkit-full-screen {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #000;
}

/* 全屏舞台撑满整个全屏区域：唯一个流内子元素（控制条已 absolute），无 padding / 无兄弟占位，
   视频按原比例 contain（比例不合时由 object-fit 自己 letterbox，属正常）。 */
.p-fs-wrap:fullscreen .p-stage,
.p-fs-wrap:-webkit-full-screen .p-stage {
  flex: 1 1 100%;
  height: 100%;
  min-height: 0;
}

/* P4.6 全屏控制条 = 覆盖层：脱离文档流、贴底、盖在视频上（z-index 5）。
   底部渐变（透明 → 半透明黑）保证文字/按钮在亮画面上也可读，且不再挤压视频高度。
   定位基准：:fullscreen 元素由 UA 样式表置为 position:fixed（顶层渲染），本身就是包含块，
   所以这里不改 .p-fs-wrap 的 position（作者样式若覆盖成 relative 会破坏全屏尺寸）。 */
.p-fs-wrap:fullscreen .p-ctrl,
.p-fs-wrap:-webkit-full-screen .p-ctrl {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 5;
  padding-top: 10px;
  padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
  border-top: 0;
  background: linear-gradient(
    to top,
    rgba(0, 0, 0, 0.86) 0%,
    rgba(0, 0, 0, 0.62) 55%,
    rgba(0, 0, 0, 0) 100%
  );
}

/* P4.4 全屏控制条自动隐藏（判定规则见 playerExtras.ctrlCanHide）：
   只在「全屏 + 播放中 + 2.5s 无操作 + 不悬停/不拖动/无浮层」时加 .is-ctrl-hidden。
   P4.7：焦点不再是隐藏条件（点控制条按钮留下的焦点曾让它永不隐藏），改为隐藏前 blur。
   P4.6：隐藏 = opacity:0 + 整体下沉自身高度（translateY(100%)），配合绝对定位，
   既不留任何布局空间（无黑边），也不让渐变在半透明边缘透出暗影；
   pointer-events:none 让点击穿到画面上（= 暂停/播放）；鼠标指针同时隐起，
   避免画面正中挂着一个箭头。悬停控制条区域会由 mousemove 立刻把类摘掉，所以点得到。 */
.p-fs-wrap.is-ctrl-hidden {
  cursor: none;
}

.p-fs-wrap.is-ctrl-hidden .p-ctrl {
  opacity: 0;
  transform: translateY(100%);
  pointer-events: none;
}

.p-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
}

.p-stage video {
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  background: #000;
}

.p-restart {
  position: absolute;
  left: 14px;
  bottom: 64px;
  padding: 6px 12px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: var(--radius);
  background: rgba(0, 0, 0, 0.72);
  color: #fff;
  font-size: 12.5px;
  cursor: pointer;
}

.p-restart:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.p-tap {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 2;
  padding: 13px 26px;
  border: 1px solid rgba(255, 255, 255, 0.34);
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.74);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}

.p-tap:hover {
  border-color: var(--accent);
}

.p-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 14px;
  max-height: 22vh;
  overflow-y: auto;
  background: var(--bg-2);
  border-top: 1px solid var(--line);
}

.ptag {
  display: inline-flex;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-3);
  font-size: 12px;
  color: var(--fg-dim);
}

.ptag b {
  font-weight: 600;
  color: var(--accent);
}

.ptag-actor b {
  color: var(--warn);
}

.ptag-empty {
  color: var(--fg-dim);
}

@media (max-width: 768px) {
  .p-head {
    flex-direction: column;
    gap: 8px;
    padding: 8px 10px;
  }

  .p-q {
    max-width: 118px;
  }

  .p-title {
    font-size: 13.5px;
    white-space: normal;
  }

  .p-actions {
    width: 100%;
  }

  .p-actions .btn {
    flex: 1;
    padding: 6px 8px;
    font-size: 12.5px;
  }

  .p-tags {
    max-height: 26vh;
  }

  .p-restart {
    bottom: 56px;
    left: 10px;
  }

  /* 触屏无 hover：只保留拖动时的预览视频 */
  .p-hover,
  .p-hover-line {
    display: none;
  }

  /* 移动端控制条：按钮加大到可点尺寸，音量滑块让位给静音按钮 */
  .p-ctrl {
    padding: 6px 10px 10px;
    gap: 6px;
  }

  .p-seekbar {
    gap: 8px;
  }

  .p-seekwrap {
    min-height: 26px;
  }

  .p-seek {
    height: 6px;
  }

  .p-ctrlline {
    gap: 6px;
  }

  .p-btn {
    min-width: 40px;
    height: 38px;
    font-size: 15px;
  }

  .p-btn-play {
    min-width: 54px;
  }

  .p-vol {
    display: none;
  }

  /* 画质行只留下拉，省出横向空间给按钮 */
  .p-q-lab,
  .p-q-now {
    display: none;
  }

  .p-q {
    max-width: 96px;
  }

  .p-seek-now {
    font-size: 12.5px;
  }
}

/* ============================ P4-B 新增控件（颜色只取 mediaTheme 变量） ============================ */

/* 标记刻度：绝对铺在 .p-seekwrap（position:relative）上，pointer-events:none 不挡 hover 与拖动。
   P4.4：左右各内缩半个 thumb，与 range 的可视轨道同源（否则两端各偏 8px） */
.p-marks {
  position: absolute;
  left: var(--thumb-r, 7px);
  right: var(--thumb-r, 7px);
  top: 50%;
  height: 14px;
  transform: translateY(-50%);
  pointer-events: none;
  z-index: 2;
}

.p-mark {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  background: var(--accent);
  opacity: 0.85;
}

/* 区间标记：一段浅色带（半透明），两端不用额外描边，避免和 4px 轨道抢视线 */
.p-mark.is-range {
  opacity: 0.28;
  width: auto;
  margin-left: 0;
  border-radius: 2px;
}

/* 刻度提示：与 hover 卡片同样贴着进度条上方，宽度自适应文案 */
.p-marker-tip {
  position: absolute;
  bottom: calc(100% + 6px);
  transform: translateX(-50%);
  max-width: 260px;
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg-3);
  color: var(--fg);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  z-index: 3;
}

/* ====================== P4.1 标记轨（进度条下方独立一条） ====================== */
/* 轨道本身 pointer-events:none：不挡进度条拖动，也不挡 hover 预览；只有 .p-lane-mark 吃事件。
   P4.3：高度 / 间距 / 边宽 / 探出量改读 JS 侧的 CSS 变量（值来自 playerExtras 的 LANE_* 常量，
   见 MediaPlayer 的 laneVars），SCSS 不再另写一套数字；窄屏高度用 --lane-h-sm。
   轨道加一层淡背景 + 内描边，让它是一条看得见的「带子」，而不是飘在空白里的细线。 */
.p-marklane {
  position: relative;
  height: var(--lane-h, 12px);
  /* P4.4：左右内缩半个 thumb（var(--thumb-r)），与进度条的可视轨道同宽同起点 ——
     标记 left% 与滑块中心走同一套「比例 → 像素」换算（playerExtras.seekRatioToPx） */
  margin: var(--lane-gap, 3px) var(--thumb-r, 7px) 0;
  background: color-mix(in srgb, var(--bg-3) 88%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--line) 70%, transparent);
  border-radius: 2px;
  pointer-events: none;
  z-index: 2;
}

.p-lane-mark {
  position: absolute;
  /* P4.3：向上探出 1px（--lane-raise），让单点竖条与 4px 进度条在视觉上连成一体 */
  top: calc(-1 * var(--lane-raise, 1px));
  bottom: 0;
  padding: 0;
  border: 0;
  border-radius: 1px;
  background: var(--accent);
  /* 亮暗都可见的细描边：浅色底上勾出边界，暗色底由 html.dark 加深到 1px 深色 */
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.28);
  font: inherit;
  line-height: 1;
  cursor: pointer;
  pointer-events: auto;
}

.p-lane-mark.is-range {
  /* 区间是一条带子，不向上探出（探出会与进度条叠成一块色斑） */
  top: 0;
  box-sizing: border-box;
  min-width: 6px;
  border-left: var(--lane-edge, 3px) solid;
  border-right: var(--lane-edge, 3px) solid;
  border-radius: 1px;
}

.p-lane-mark:hover,
.p-lane-mark:focus-visible {
  outline: none;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55), 0 0 0 3px var(--accent-soft);
}

/* ================== P4.3 标记数量徽标（进度条右端 / 时间码左侧）+ 标记列表 ================== */
/* 用户两次反馈「刻度看不出来」：刻度尺寸已经加到 12px/4px，但细线本身有上限，
   于是再给一个数字入口 —— 「🚩 N」一眼看出有没有标记，点开直接跳到某条。 */
.p-mk-badge-wrap {
  position: relative;
  flex: 0 0 auto;
}

.p-mk-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 20px;
  padding: 0 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg);
  font-size: 12px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
}

.p-mk-badge:hover,
.p-mk-badge[aria-expanded='true'] {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

/* 列表贴着徽标向上展开（与控制条上方其它浮层同一方向），可滚动，最长 240px */
.p-mk-list {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 7;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 168px;
  max-width: min(300px, 70vw);
  max-height: 240px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  background: var(--bg-2);
  box-shadow: 0 8px 22px var(--accent-soft);
}

.p-mk-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

.p-mk-item:hover,
.p-mk-item:focus-visible {
  background: var(--accent-soft);
  color: var(--accent);
  outline: none;
}

/* 小方块用标记自己的颜色（与轨道上的刻度同色，列表与刻度对得上） */
.p-mk-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.p-mk-item-t {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.p-gain-btn {
  flex-shrink: 0;
  min-width: 62px;
  padding: 0 6px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.p-gain-note {
  padding: 1px 6px;
  border: 1px solid var(--warn);
  border-radius: 999px;
  color: var(--warn);
  font-size: 11.5px;
  white-space: nowrap;
  cursor: help;
}

.p-gain-btn.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

/* P4.1 视频倍速：占用原来 1×/1.5×/2× 增益按钮的位置，下拉选择 0.5×–2× */
.p-speed {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.p-speed-lab {
  font-size: 12px;
  color: var(--fg-dim);
  white-space: nowrap;
}

.p-speed-sel {
  min-width: 68px;
  padding: 3px 6px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.p-speed-sel:focus {
  outline: none;
  border-color: var(--accent);
}

.p-ab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.p-ab-btn {
  min-width: 30px;
  padding: 0 6px;
  font-size: 12px;
  font-weight: 600;
}

.p-ab-btn.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.p-ab-text {
  min-width: 86px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--fg-dim);
  white-space: nowrap;
}

.p-ab-text.on {
  color: var(--accent);
  font-weight: 600;
}

.p-frame {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.p-help-btn {
  font-weight: 700;
  color: var(--accent);
}

/* 快捷键浮层：压在播放器之上（播放器自身 z-index:100） */
.p-help {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.5);
}

.p-help-box {
  width: min(520px, 100%);
  max-height: 82vh;
  overflow: auto;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-2);
  color: var(--fg);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
}

.p-help-h {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
}

.p-help-list {
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.p-help-list li {
  display: flex;
  gap: 10px;
  align-items: baseline;
  font-size: 12.5px;
  line-height: 1.55;
}

.p-help-key {
  flex: 0 0 108px;
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg-3);
  color: var(--accent);
  font-weight: 600;
  text-align: center;
  white-space: nowrap;
}

.p-help-val {
  flex: 1;
  min-width: 0;
  color: var(--fg-dim);
}

.p-help-note {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--fg-dim);
}

@media (max-width: 768px) {
  /* 移动端：增益 / AB / 逐帧按钮跟着 .p-btn 的加大尺寸走，只是文案更短 */
  .p-gain-btn {
    min-width: 0;
    padding: 0 6px;
    font-size: 12px;
  }

  .p-ab-btn {
    min-width: 38px;
    font-size: 13px;
  }

  /* P4.1：窄屏标记轨保留（它是状态指示，不是浮层）；P4.3 起窄屏 12px → 8px，间距仍 3px */
  .p-marklane {
    height: var(--lane-h-sm, 8px);
    margin-top: var(--lane-gap, 3px);
  }

  /* P4.3：触屏上徽标加大到可点尺寸（刻度太细看不见时它是主要入口） */
  .p-mk-badge {
    height: 26px;
    padding: 0 9px;
    font-size: 13px;
  }

  .p-speed-lab {
    display: none;
  }

  .p-speed-sel {
    min-width: 58px;
    padding: 3px 4px;
  }

  .p-ab-text {
    min-width: 0;
    font-size: 11.5px;
  }

  /* 触屏没有 hover：刻度仍显示（它是状态不是浮层），但隐藏 hover 才有的提示卡 */
  .p-marks {
    height: 16px;
  }

  .p-help-key {
    flex-basis: 88px;
  }
}

/* 暗色主题：标记在深底上靠一圈 1px 深色描边勾出边界（亮色下是同位置的浅描边） */
html.dark .p-lane-mark {
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.75);
}

html.dark .p-lane-mark:hover,
html.dark .p-lane-mark:focus-visible {
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.85), 0 0 0 3px var(--accent-soft);
}
</style>
