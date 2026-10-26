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

    <!-- 字幕：只有该片真的带字幕轨时才出现（没有字幕就不放一个永远点不动的开关） -->
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

  abA: { type: Number, default: null },
  abB: { type: Number, default: null },
  abText: { type: String, default: 'A/B' },
  abTitle: { type: String, default: '' },
  abOn: { type: Boolean, default: false },

  markers: { type: Array, default: () => [] },
  helpOpen: { type: Boolean, default: false }
})

const emit = defineEmits(['update:speed', 'gain', 'update:quality', 'toggle-sub', 'ab', 'clear-ab', 'pick-marker', 'help'])

/** select 的 value 恒为字符串，这里转回数字再 emit（父级的档位是 Number） */
function numberValue(e) {
  const v = Number(e && e.target ? e.target.value : NaN)
  return Number.isFinite(v) ? v : props.speed
}
</script>

<style lang="scss" scoped>
/* 浮层贴控制条上沿向上展开：父级 .p-ctrl 是绝对定位（= 包含块），这里只负责自身的定位与外观。
   底色不透明（--bg-2）+ 1px 描边 + 投影：面板里的文字与原生 select 永远可读，与底座的「近乎透明」互不影响。 */
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
  background: var(--bg-2);
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
