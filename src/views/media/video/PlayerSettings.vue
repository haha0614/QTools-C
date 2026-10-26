<!--
  PlayerSettings.vue —— 播放器「设置」浮层（P5.24-A 从 MediaPlayer.vue 里拆出来的纯展示组件）

  为什么要拆：用户反馈 5 要求「倍速 / 增益 / 画质 / 字幕 / AB / 标记 / 快捷键说明收进一个齿轮」。
  这些控件原本摊在控制条上（一级按钮 12 个），收纳后如果仍写在 MediaPlayer.vue 里，
  那个文件会同时承担「播放状态机」和「一屏表单」两件事。拆出来之后：
    - 本组件无状态、无副作用、不碰 <video>：只吃「当前值 + 选项 + 文案」，只 emit 用户意图；
    - 所有取值口径（档位、文案、title）仍由 MediaPlayer 一处生成，行为与拆之前逐字一致。
  约定：颜色只用 mediaTheme 映射变量（--bg-2 / --fg / --line / --accent / --warn），
        底色是**不透明**的 —— 面板里的文字必须始终可读，不能依赖底下压着什么画面。
  data-qt-set-panel 是证据脚本的锚点（evidence/playerHarness.js 按它判定「面板开了 / 被收纳项可点」）。
-->
<template>
  <div class="p-set" data-qt-set-panel role="dialog" aria-modal="false" aria-label="播放设置">
    <!-- 倍速 -->
    <div class="p-set-row">
      <label class="p-set-lab" for="msVideoSpeed">倍速</label>
      <select
        id="msVideoSpeed"
        class="p-set-sel"
        :value="speed"
        :title="speedTitle"
        aria-label="视频倍速"
        @change="emit('update:speed', numberValue($event))"
      >
        <!-- :selected 让首屏（含 SSR / 证据）就显示当前档位，而不是浏览器默认的第一项 -->
        <option v-for="o in speedOptions" :key="'sp' + o.value" :value="o.value" :selected="o.value === speed">
          {{ o.label }}
        </option>
      </select>
    </div>

    <!-- 音量增益：1× → 1.5× → 2× → 1× 循环（WebAudio GainNode，降级说明只在降级时出现） -->
    <div class="p-set-row">
      <span class="p-set-lab">增益</span>
      <button
        class="p-set-btn p-gain-btn"
        :class="{ on: gain > 1 }"
        type="button"
        :aria-pressed="gain > 1"
        :aria-label="'音量增益 ' + gain + ' 倍'"
        :title="gainTitle"
        @click="emit('gain')"
      >
        增益 {{ gain }}×
      </button>
      <span v-if="gainFallback" class="p-set-note" :title="gainNote">增益降级</span>
    </div>

    <!-- 画质：原画直连 / 实时转码 -->
    <div class="p-set-row">
      <label class="p-set-lab" for="msVideoQ">画质</label>
      <select
        id="msVideoQ"
        class="p-set-sel"
        :value="quality"
        title="画质：原画直连，或实时转码到 720p / 480p / 360p"
        aria-label="画质"
        @change="emit('update:quality', $event.target.value)"
      >
        <option v-for="o in qualityOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
      <span v-if="qualityHint" class="p-set-note p-set-note-accent">转码中…</span>
    </div>

    <!-- 字幕：只有该片真的带字幕轨时才出现（没有字幕就不放一个永远点不动的开关）。
         P5.34（用户需求「能不能对视频字幕的样式进行自定义，如果可以那么在字幕开关旁边加一个
         字幕样式设置」）：开关右边多一个「样式」入口，展开下面的小面板。
         字幕样式是**站点级偏好**（localStorage['ms.substyle']），换片不重置；
         面板里自带实时预览 —— 改一个值预览立刻变，不必等字幕真的滚出来。 -->
    <div v-if="subShow" class="p-set-row">
      <span class="p-set-lab">字幕</span>
      <button
        class="p-set-btn p-sub-btn"
        :class="{ on: subVisible }"
        type="button"
        :aria-pressed="subVisible"
        :aria-label="subVisible ? '隐藏字幕' : '显示字幕'"
        title="字幕显示 / 隐藏（只影响本次播放，不改片源）"
        @click="emit('toggle-sub')"
      >
        {{ subVisible ? '显示中' : '已隐藏' }}
      </button>
      <button
        class="p-set-btn p-substyle-btn"
        data-qt-substyle
        type="button"
        :aria-expanded="subStyleOpen"
        aria-controls="pSubStyle"
        aria-label="字幕样式"
        title="字幕样式：字号 / 颜色 / 背景 / 描边 / 位置 / 字重"
        @click="subStyleOpen = !subStyleOpen"
      >
        样式
      </button>
    </div>

    <div v-if="subShow && subStyleOpen" id="pSubStyle" class="p-substyle" data-qt-substyle-panel>
      <p class="p-substyle-h">
        字幕样式<span class="p-substyle-n">站点级 · 换片仍生效</span>
      </p>
      <!-- 实时预览：与屏幕字幕读的是**同一批** CSS 变量（--p-sub-*），所以这里看到的就是播放时的样子 -->
      <div class="p-sub-prev" :style="previewVars" aria-hidden="true">
        <span class="p-sub-prev-t">示例字幕 Sample</span>
      </div>

      <div class="p-set-row p-sub-row">
        <label class="p-set-lab" for="msSubSize">字号</label>
        <input
          id="msSubSize"
          class="p-sub-range"
          data-qt-sub-size
          type="range"
          :min="FONT_MIN"
          :max="FONT_MAX"
          step="0.05"
          :value="s.fontScale"
          aria-label="字幕字号"
          title="字幕字号（0.8×–1.6×，相对舞台字号）"
          @input="patch({ fontScale: num($event) })"
        />
        <span class="p-sub-val">{{ fontLabel }}</span>
      </div>

      <div class="p-set-row p-sub-row">
        <label class="p-set-lab" for="msSubColor">颜色</label>
        <input
          id="msSubColor"
          class="p-sub-color"
          data-qt-sub-color
          type="color"
          :value="s.color"
          aria-label="字幕颜色"
          title="字幕颜色"
          @input="patch({ color: $event.target.value })"
        />
        <label class="p-set-lab p-set-lab-2" for="msSubBg">背景</label>
        <input
          id="msSubBg"
          class="p-sub-range"
          data-qt-sub-bg
          type="range"
          min="0"
          max="100"
          step="1"
          :value="s.bgOpacity"
          aria-label="字幕背景不透明度"
          title="字幕背景不透明度（0–100%）"
          @input="patch({ bgOpacity: num($event) })"
        />
        <span class="p-sub-val">{{ s.bgOpacity }}%</span>
      </div>

      <div class="p-set-row p-sub-row">
        <span class="p-set-lab">描边</span>
        <button
          class="p-set-btn"
          :class="{ on: s.outline }"
          data-qt-sub-outline
          type="button"
          :aria-pressed="s.outline"
          title="字幕描边（4 向 1px 阴影）：亮帧上也能读清"
          @click="patch({ outline: !s.outline })"
        >
          {{ s.outline ? '开' : '关' }}
        </button>
        <span class="p-set-lab p-set-lab-2">字重</span>
        <button
          class="p-set-btn"
          :class="{ on: s.bold }"
          data-qt-sub-bold
          type="button"
          :aria-pressed="s.bold"
          title="字幕加粗"
          @click="patch({ bold: !s.bold })"
        >
          {{ s.bold ? '加粗' : '常规' }}
        </button>
      </div>

      <div class="p-set-row p-sub-row">
        <span class="p-set-lab">位置</span>
        <button
          v-for="p in POS"
          :key="'sp' + p"
          class="p-set-btn p-sub-pos"
          :class="{ on: s.pos === p }"
          type="button"
          :aria-pressed="s.pos === p"
          :data-qt-sub-pos="p"
          :title="'字幕垂直位置：' + POS_LABEL[p] + '（::cue 做不到，由自绘层落位）'"
          @click="patch({ pos: p })"
        >
          {{ POS_LABEL[p] }}
        </button>
        <button
          class="p-set-btn p-sub-reset"
          data-qt-sub-reset
          type="button"
          title="恢复默认字幕样式"
          @click="emit('reset-sub-style')"
        >
          重置
        </button>
      </div>
    </div>

    <!-- AB 循环：一级控制条不再放 A / B（用户要求精简），全部收在这里；键盘 A / B 仍然直达 -->
    <div class="p-set-row">
      <span class="p-set-lab">AB 循环</span>
      <button
        class="p-set-btn p-ab-btn"
        :class="{ on: abA != null }"
        type="button"
        aria-label="设 A 点"
        title="设 A 点（再按 A 清除）快捷键 A"
        @click="emit('ab', 'a')"
      >
        A
      </button>
      <button
        class="p-set-btn p-ab-btn"
        :class="{ on: abB != null }"
        type="button"
        aria-label="设 B 点"
        title="设 B 点（再按 B 清除）快捷键 B"
        @click="emit('ab', 'b')"
      >
        B
      </button>
      <button
        class="p-set-btn p-ab-btn"
        type="button"
        :disabled="abA == null && abB == null"
        aria-label="清除 A/B"
        title="清除 A / B 两点"
        @click="emit('clear-ab')"
      >
        清
      </button>
      <span class="p-set-now" :class="{ on: abOn }" :title="abTitle">{{ abText }}</span>
    </div>

    <!-- 标记列表：原来贴在进度条上的 🚩 徽标（会变成第 9 个一级按钮）改为常显列表 -->
    <div v-if="markers && markers.length" class="p-set-row p-set-row-marks">
      <span class="p-set-lab">标记 {{ markers.length }}</span>
      <div class="p-set-marks" role="menu" aria-label="标记列表">
        <button
          v-for="t in markers"
          :key="'ml' + t.key"
          class="p-set-mark"
          type="button"
          role="menuitem"
          :title="'跳到 ' + t.title"
          @click="emit('pick-marker', t)"
        >
          <span class="p-set-dot" :style="{ background: t.color || 'var(--accent)' }"></span>
          <span class="p-set-mark-t">{{ t.title }}</span>
        </button>
      </div>
    </div>

    <!-- 快捷键说明：原来是控制条上的「?」按钮（第 9~10 个一级按钮），键盘 ? 仍然直达 -->
    <div class="p-set-row p-set-row-end">
      <button
        class="p-set-btn p-help-btn"
        data-qt-help
        type="button"
        :aria-expanded="helpOpen"
        aria-label="快捷键说明"
        title="快捷键说明（?）"
        @click="emit('help')"
      >
        ？快捷键说明
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
// P5.34：字幕样式的默认值 / 归一化 / CSS 变量 —— 与 MediaPlayer 共用一份真值
import { SUB_STYLE_DEFAULT, SUB_POS, SUB_POS_LABEL, SUB_FONT_MIN, SUB_FONT_MAX, normalizeSubStyle, subStyleVars } from './subtitleStyle'

/** 倍速 select 的值是字符串，父级的档位是数字 —— 只在这一层做一次转换 */
const props = defineProps({
  speed: { type: Number, required: true },
  /** [{ value, label }]：档位与文案都由父级用 SPEED_LEVELS / speedLabel 生成 */
  speedOptions: { type: Array, default: () => [] },
  speedTitle: { type: String, default: '' },

  gain: { type: Number, default: 1 },
  gainTitle: { type: String, default: '' },
  gainFallback: { type: Boolean, default: false },
  gainNote: { type: String, default: '' },

  quality: { type: String, default: 'orig' },
  qualityOptions: { type: Array, default: () => [] },
  qualityHint: { type: Boolean, default: false },

  subShow: { type: Boolean, default: false },
  subVisible: { type: Boolean, default: true },
  /** P5.34：字幕样式（站点级偏好）。面板只读它 + emit 局部 patch，不自己存 */
  subStyle: { type: Object, default: () => SUB_STYLE_DEFAULT },

  abA: { type: Number, default: null },
  abB: { type: Number, default: null },
  abText: { type: String, default: 'A/B' },
  abTitle: { type: String, default: '' },
  abOn: { type: Boolean, default: false },

  markers: { type: Array, default: () => [] },
  helpOpen: { type: Boolean, default: false }
})

const emit = defineEmits([
  'update:speed',
  'gain',
  'update:quality',
  'toggle-sub',
  'update:sub-style',
  'reset-sub-style',
  'ab',
  'clear-ab',
  'pick-marker',
  'help'
])

/* P5.34 字幕样式：面板自身的「展开 / 收起」是本视图状态（不进 props，也不落盘 —
   用户没要求「记住我上次开着面板」，YAGNI）。样式值一律走 props.subStyle + emit patch。 */
const subStyleOpen = ref(false)

/** 归一化后的样式（脏 props 也不会把面板画成 NaN） */
const s = computed(() => normalizeSubStyle(props.subStyle))
/** 预览与屏幕字幕共用同一批变量 → 所见即所得 */
const previewVars = computed(() => subStyleVars(s.value))
const fontLabel = computed(() => Math.round(s.value.fontScale * 100) + '%')
const POS = SUB_POS
const POS_LABEL = SUB_POS_LABEL
const FONT_MIN = SUB_FONT_MIN
const FONT_MAX = SUB_FONT_MAX

/** 滑块值 → 数字 patch（父级再做一次归一化 / 夹取） */
function num(e) {
  return Number(e && e.target ? e.target.value : NaN)
}
function patch(p) {
  emit('update:sub-style', p)
}

/** select 的 value 恒为字符串，这里转回数字再 emit（父级的档位是 Number） */
function numberValue(e) {
  const v = Number(e && e.target ? e.target.value : NaN)
  return Number.isFinite(v) ? v : props.speed
}
</script>

<style lang="scss" scoped>
/* 浮层贴控制条上沿向上展开：父级 .p-ctrl 是绝对定位（= 包含块），这里只负责自身的定位与外观。
   底色仍以 --bg-2 为准（面板里的文字与原生 select 永远可读，与底座的「近乎透明」互不影响）；
   P5.25：底座透明度下调到 .11/.12、blur 提到 12px 之后，把面板也改成同一套语言 ——
   --bg-2 94% + 同一档 12px blur：透出一点背景（不再像一块硬纸板），文字仍压在自己的底色上。 */
.p-set {
  position: absolute;
  right: 10px;
  bottom: calc(100% - 2px);
  z-index: 8;
  width: min(320px, calc(100% - 20px));
  max-height: min(62vh, 420px);
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--line-2);
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-2) 94%, transparent);
  backdrop-filter: blur(12px) saturate(1.05);
  -webkit-backdrop-filter: blur(12px) saturate(1.05);
  color: var(--fg);
  font-size: 12.5px;
  box-shadow: 0 16px 38px rgba(0, 0, 0, 0.45);
  scrollbar-width: thin;
}

.p-set-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

/* 标签列定宽：三行下拉框左边缘对齐，不会因为「倍速 / 增益 / AB 循环」字数不同而参差 */
.p-set-lab {
  flex: 0 0 52px;
  color: var(--fg-dim);
  font-size: 12px;
  white-space: nowrap;
}

.p-set-sel {
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}

.p-set-sel:focus {
  outline: none;
  border-color: var(--accent);
}

.p-set-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg-3);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;
}

.p-set-btn:hover {
  border-color: var(--line-2);
}

.p-set-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.p-set-btn:disabled {
  opacity: 0.42;
  cursor: default;
}

/* 选中态：描边 + 浅色底（不改变尺寸，避免点一下按钮就跳一行） */
.p-set-btn.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.p-gain-btn {
  min-width: 68px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.p-ab-btn {
  min-width: 30px;
  font-weight: 600;
}

.p-set-now {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--fg);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.p-set-now.on {
  color: var(--accent);
  font-weight: 600;
}

/* 提示胶囊：降级原因 / 转码中，都是「一段短状态」，不是可点控件 */
.p-set-note {
  flex: 0 0 auto;
  padding: 1px 7px;
  border: 1px solid var(--warn);
  border-radius: 999px;
  color: var(--warn);
  font-size: 11.5px;
  white-space: nowrap;
  cursor: help;
}

.p-set-note-accent {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  cursor: default;
}

/* 标记：列表在面板里是静态列（面板自己滚动），不再贴着徽标向上弹 */
.p-set-row-marks {
  align-items: flex-start;
}

.p-set-marks {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 148px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.p-set-mark {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 4px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.p-set-mark:hover,
.p-set-mark:focus-visible {
  background: var(--accent-soft);
  color: var(--accent);
  outline: none;
}

/* 小方块用标记自己的颜色：与进度条刻度同色，列表与刻度对得上 */
.p-set-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.p-set-mark-t {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.p-set-row-end {
  justify-content: flex-end;
}

.p-help-btn {
  font-weight: 600;
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* ====================== P5.34 字幕样式面板 ====================== */

/* 入口按钮：与「显示中 / 已隐藏」同款的次要按钮，但用强调色描边表明「这里能改样式」 */
.p-substyle-btn {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
}

/* 面板本体：设置在设置浮层**内部**再嵌一层，所以不另开浮层（不开第二层 z-index / 不抢焦点），
   只用自己的左边线 + 浅底表示从属关系；设置浮层自己滚动，这一块跟着滚。 */
.p-substyle {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-left: 2px;
  padding: 8px 9px 9px;
  border-left: 2px solid var(--accent);
  border-radius: 0 8px 8px 0;
  background: color-mix(in srgb, var(--bg-3) 70%, transparent);
}

.p-substyle-h {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
}

.p-substyle-n {
  font-size: 11px;
  font-weight: 400;
  color: var(--fg-dim);
}

/* 实时预览：一半亮一半暗的假画面 —— 白字 / 描边 / 背景不透明度在两种背衬上都要看得清，
   所以只给纯色底的预览框没有意义。样式值与屏幕字幕读同一批 var（--p-sub-*）。 */
.p-sub-prev {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 52px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background-color: #2b3038;
  background-image: linear-gradient(135deg, rgba(255, 255, 255, 0.18) 0 50%, rgba(0, 0, 0, 0.55) 50% 100%);
  overflow: hidden;
}

.p-sub-prev-t {
  padding: 1px 8px;
  border-radius: 4px;
  /* 预览框只有 320px 宽，所以基准字号固定 16px（真实字幕是 vmin 基准）——
     用户调的是**倍率**，预览要看到的是「相对变化」，不是绝对像素。 */
  font-size: calc(var(--p-sub-scale, 1) * 16px);
  font-weight: var(--p-sub-weight, 400);
  line-height: 1.3;
  color: var(--p-sub-color, #fff);
  background: var(--p-sub-bg, rgba(0, 0, 0, 0.6));
  text-shadow: var(--p-sub-shadow, 0 1px 2px rgba(0, 0, 0, 0.55));
  text-align: center;
  max-width: 100%;
  overflow-wrap: anywhere;
}

/* 面板里的行：标签列比主面板窄一档（面板只有 320px，两列标签要放得下） */
.p-sub-row {
  gap: 6px;
}

.p-set-lab-2 {
  flex: 0 0 34px;
}

.p-sub-range {
  /* 原生 range 有 ~129px 的内在宽度；不给 flex-basis + min-width:0 就会把「背景 10%」挤到下一行 */
  flex: 1 1 48px;
  min-width: 0;
  height: 18px;
  accent-color: var(--accent);
  cursor: pointer;
}

.p-sub-color {
  flex: 0 0 auto;
  width: 34px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg);
  cursor: pointer;
}

.p-sub-val {
  flex: 0 0 34px;
  text-align: right;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--fg-dim);
}

.p-sub-pos {
  min-width: 40px;
}

/* 重置靠右：与「位置」三个按钮分开，避免误点 */
.p-sub-reset {
  margin-left: auto;
  color: var(--fg-dim);
}

/* 窄屏：面板改成「占满一行的底部抽屉」—— 320px 固定宽在 375 上会顶到视口外 */
@media (max-width: 767px) {
  .p-set {
    left: 8px;
    right: 8px;
    width: auto;
    max-height: 56vh;
    padding: 9px 10px;
  }

  .p-set-lab {
    flex-basis: 44px;
  }

  .p-set-btn {
    height: 30px;
    padding: 0 10px;
    font-size: 12.5px;
  }

  .p-ab-btn {
    min-width: 38px;
  }
}
</style>
