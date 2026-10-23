<!--
  BatchBar.vue —— 卡片墙多选批量操作条
  职责：显示「已选 N 项」、全选 / 清空 / 退出，以及三类批量写入入口（加标签 / 移除标签 / 设置评分）。
  约定：不自己发请求——full 档由 VideoPage 合并成一次 batch-meta 调用，local 档只写 localStorage；
        local 档额外显示「本地」徽标与「清除本地修改」；off 档整条不出现（选择按钮已禁用）。
        标签选择器复用 TagPicker；弹层用绝对定位挂在操作条内（父级 position: relative）。
-->
<template>
  <div class="bb" @mousedown.stop>
    <span class="bb-count">已选 <b>{{ count }}</b> 项</span>
    <span v-if="isLocal" class="bb-local" title="本地编辑：只保存在本浏览器，清除缓存即消失">本地</span>

    <button class="bb-btn" type="button" @click="emit('select-all')">全选</button>
    <button class="bb-btn" type="button" :disabled="!count" @click="emit('clear')">清空</button>

    <span class="bb-sep" aria-hidden="true"></span>

    <button
      class="bb-btn bb-main"
      type="button"
      :disabled="!count || busy"
      :aria-expanded="panel === 'add' ? 'true' : 'false'"
      @click="togglePanel('add')"
    >
      ＋ 加标签
    </button>
    <button
      class="bb-btn bb-main"
      type="button"
      :disabled="!count || busy"
      :aria-expanded="panel === 'remove' ? 'true' : 'false'"
      @click="togglePanel('remove')"
    >
      － 移除标签
    </button>
    <button
      class="bb-btn bb-main"
      type="button"
      :disabled="!count || busy"
      :aria-expanded="panel === 'rating' ? 'true' : 'false'"
      @click="togglePanel('rating')"
    >
      ★ 评分
    </button>

    <button
      v-if="isLocal"
      class="bb-btn bb-ghost"
      type="button"
      :disabled="!localCount"
      :title="localCount ? '清除本机 ' + localCount + ' 条本地修改' : '本机没有本地修改'"
      @click="emit('clear-local')"
    >
      清除本地修改<span v-if="localCount" class="bb-clear-n">{{ localCount }}</span>
    </button>

    <span class="bb-sep" aria-hidden="true"></span>
    <button class="bb-btn bb-ghost" type="button" @click="emit('exit')">取消</button>

    <span v-if="busy" class="bb-busy">处理中…</span>

    <!-- 标签选择器：加标签与移除标签共用，区别只在提交时用 addTagIds 还是 removeTagIds -->
    <div v-if="panel === 'add' || panel === 'remove'" class="bb-pop">
      <TagPicker
        :all-tags="allTags"
        :selected="EMPTY"
        :loading="tagsLoading"
        :level="level"
        @confirm="onTagsConfirm"
        @close="panel = ''"
        @created="(t) => emit('created', t)"
        @notify="(m) => emit('notify', m)"
      />
    </div>

    <!-- 评分：0-10 的滑条 + 直接点星落值，0 表示清除评分 -->
    <div v-if="panel === 'rating'" class="bb-pop bb-pop-rate">
      <div class="br-head">设置评分</div>
      <div class="br-stars">
        <button
          v-for="n in 10"
          :key="n"
          class="br-star"
          :class="{ on: n <= ratingDraft }"
          type="button"
          :aria-label="'评分 ' + n"
          @click="ratingDraft = n"
        >
          ★
        </button>
      </div>
      <input
        class="br-slider"
        type="range"
        min="0"
        max="10"
        step="1"
        :value="ratingDraft"
        aria-label="评分"
        @input="onRatingInput"
      />
      <div class="br-foot">
        <span class="br-val">{{ ratingDraft > 0 ? ratingDraft + ' 分' : '清除评分' }}</span>
        <button class="br-ok" type="button" :disabled="busy" @click="applyRating">应用</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import TagPicker from './TagPicker.vue'

const props = defineProps({
  /** 已选卡片数 */
  count: { type: Number, default: 0 },
  /** 标签库 */
  allTags: { type: Array, default: () => [] },
  /** 标签库是否加载中 */
  tagsLoading: { type: Boolean, default: false },
  /** 批量请求进行中：按钮置灰避免重复提交 */
  busy: { type: Boolean, default: false },
  /** 编辑策略档位：local 档显示本地徽标 + 清除入口 */
  level: { type: String, default: 'full' },
  /** 本机已有的本地修改条数（0 = 「清除本地修改」置灰） */
  localCount: { type: Number, default: 0 }
})

const emit = defineEmits(['select-all', 'clear', 'exit', 'add-tags', 'remove-tags', 'rating', 'created', 'notify', 'clear-local'])

const isLocal = computed(() => props.level === 'local')

/** 稳定引用：每次渲染新建 [] 会让 TagPicker 的 selected 侦听器反复重置已勾选项 */
const EMPTY = []

/** '' | 'add' | 'remove' | 'rating'：同一时刻只开一个弹层 */
const panel = ref('')
const ratingDraft = ref(0)

function togglePanel(name) {
  panel.value = panel.value === name ? '' : name
  if (panel.value === 'rating') ratingDraft.value = 0
}

function onTagsConfirm(ids) {
  if (!ids || !ids.length) return
  if (panel.value === 'add') emit('add-tags', ids.slice())
  else emit('remove-tags', ids.slice())
  panel.value = ''
}

function onRatingInput(e) {
  ratingDraft.value = Number(e.target.value) || 0
}

function applyRating() {
  emit('rating', ratingDraft.value)
  panel.value = ''
}

/** 点空白处收起弹层：只在点击落在操作条之外时生效 */
function onDocDown() {
  panel.value = ''
}

onMounted(() => document.addEventListener('mousedown', onDocDown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocDown))
</script>

<style lang="scss" scoped>
.bb {
  position: relative;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 8px;
  background: var(--bg-3);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}

.bb-count {
  font-size: 13px;
  color: var(--fg-dim);
  white-space: nowrap;
}

.bb-count b {
  color: var(--accent);
  font-weight: 600;
}

/* local 档徽标：与卡片上的「本地」同一套视觉语言（虚线描边 + 主色） */
.bb-local {
  padding: 0 6px;
  border: 1px dashed var(--accent);
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--accent);
}

.bb-clear-n {
  margin-left: 4px;
  font-size: 11px;
  opacity: 0.7;
}

.bb-btn {
  padding: 5px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-2);
  color: var(--fg);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.3;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}

.bb-btn:hover:not(:disabled) {
  border-color: var(--line-2);
}

.bb-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.bb-main {
  border-color: var(--line-2);
}

.bb-main[aria-expanded='true'] {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.bb-ghost {
  background: transparent;
  color: var(--fg-dim);
}

.bb-ghost:hover {
  color: var(--fg);
}

.bb-sep {
  width: 1px;
  height: 18px;
  background: var(--line);
}

.bb-busy {
  font-size: 12px;
  color: var(--fg-dim);
}

.bb-pop {
  position: absolute;
  left: 8px;
  top: calc(100% + 6px);
  z-index: 5;
}

.bb-pop-rate {
  left: auto;
  right: 8px;
  width: 236px;
  max-width: calc(100vw - 24px);
  padding: 9px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  background: var(--bg-2);
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.28);
}

.br-head {
  font-size: 12.5px;
  color: var(--fg-dim);
}

.br-stars {
  display: flex;
  gap: 1px;
}

.br-star {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--line-2);
  font-size: 15px;
  line-height: 20px;
  cursor: pointer;
}

.br-star.on {
  color: var(--warn);
}

.br-slider {
  width: 100%;
  accent-color: var(--accent);
  cursor: pointer;
}

.br-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}

.br-val {
  flex: 1;
  font-size: 12px;
  color: var(--fg-dim);
}

.br-ok {
  padding: 4px 12px;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--accent-soft);
  color: var(--accent);
  font: inherit;
  cursor: pointer;
}

.br-ok:disabled {
  opacity: 0.45;
  cursor: default;
}

@media (max-width: 768px) {
  /* 移动端：操作条换行，弹层贴左右边 */
  .bb {
    gap: 5px;
    padding: 6px;
  }

  .bb-sep {
    display: none;
  }

  .bb-pop {
    left: 0;
    right: 0;
  }

  .bb-pop-rate {
    left: 0;
    right: 0;
    width: auto;
  }
}
</style>
