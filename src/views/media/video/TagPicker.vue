<!--
  TagPicker.vue —— 标签选择器（批量条与单条信息面板共用）
  职责：搜索标签库、多选勾选、现场新建标签；只负责「选哪几个」，真正写接口由父组件发起。
  约定：全部走 --qt-* / mediaTheme 变量；不 teleport，由父级容器定位（父级需 position: relative）。
        新建标签的接口不在 M3-A 契约内，失败只提示、不影响已勾选项（见 createFromQuery）。
-->
<template>
  <div class="tp" role="dialog" aria-label="选择标签" @keydown.esc.stop="emit('close')">
    <div class="tp-head">
      <input
        ref="qEl"
        v-model="q"
        class="tp-input"
        type="search"
        placeholder="搜索标签…"
        autocomplete="off"
        spellcheck="false"
      />
      <button class="tp-x" type="button" aria-label="关闭标签选择器" @click="emit('close')">×</button>
    </div>

    <ul v-if="filtered.length" class="tp-list">
      <li v-for="t in filtered" :key="t.id">
        <label class="tp-item">
          <input type="checkbox" :checked="picked.includes(t.id)" @change="toggle(t.id)" />
          <span class="tp-dot" :style="{ background: t.color || 'transparent' }"></span>
          <span class="tp-name" :title="t.name">{{ t.name }}</span>
          <span v-if="t.useCount != null" class="tp-use">{{ t.useCount }}</span>
        </label>
      </li>
    </ul>
    <div v-else class="tp-empty">{{ loading ? '标签加载中…' : '无匹配标签' }}</div>

    <div v-if="canCreate" class="tp-foot">
      <button class="tp-new" type="button" :disabled="creating" @click="createFromQuery">
        {{ creating ? '新建中…' : '＋ 新建「' + q.trim() + '」' }}
      </button>
    </div>

    <div class="tp-bar">
      <span class="tp-count">已选 {{ picked.length }}</span>
      <button class="tp-ok" type="button" :disabled="!picked.length" @click="emit('confirm', picked.slice())">
        确定
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useMediaApi } from '@/composables/useMediaApi'

const props = defineProps({
  /** 标签库 [{id,name,color,useCount}] */
  allTags: { type: Array, default: () => [] },
  /** 初始已选标签 id */
  selected: { type: Array, default: () => [] },
  /** 标签库是否仍在加载 */
  loading: { type: Boolean, default: false }
})

const emit = defineEmits(['confirm', 'close', 'created', 'notify'])

const api = useMediaApi()

const q = ref('')
const picked = ref((props.selected || []).slice())
const creating = ref(false)
const qEl = ref(null)

const filtered = computed(() => {
  const kw = q.value.trim().toLowerCase()
  const list = props.allTags || []
  if (!kw) return list
  return list.filter((t) => String(t.name || '').toLowerCase().includes(kw))
})

/** 只有输入了库里没有的名称才出现「新建」入口 */
const canCreate = computed(() => {
  const kw = q.value.trim()
  if (!kw) return false
  return !(props.allTags || []).some((t) => String(t.name || '').toLowerCase() === kw.toLowerCase())
})

function toggle(id) {
  const i = picked.value.indexOf(id)
  if (i >= 0) picked.value.splice(i, 1)
  else picked.value.push(id)
}

/**
 * 现场新建：POST /api/media/admin/tags 不在 M3-A 契约内，
 * 失败只提示并保留已勾选项，不阻塞后续加标签/评分。
 */
async function createFromQuery() {
  const name = q.value.trim()
  if (!name || creating.value) return
  creating.value = true
  try {
    const body = await api.createAdminTag({ name }, { silent: true })
    const tag = body && body.id ? body : { id: 'tmp-' + name, name, color: '' }
    emit('created', tag)
    if (!picked.value.includes(tag.id)) picked.value.push(tag.id)
    q.value = ''
    nextTick(() => qEl.value && qEl.value.focus())
  } catch {
    emit('notify', '新建标签失败：后端暂不支持，请使用已有标签')
  } finally {
    creating.value = false
  }
}

watch(
  () => props.selected,
  (v) => {
    picked.value = (v || []).slice()
  }
)

onMounted(() => {
  if (qEl.value) qEl.value.focus()
})
</script>

<style lang="scss" scoped>
.tp {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 260px;
  max-width: calc(100vw - 24px);
  padding: 8px;
  background: var(--bg-2);
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.28);
  color: var(--fg);
  font-size: 13px;
}

.tp-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tp-input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--fg);
  outline: none;
  font: inherit;
}

.tp-input:focus {
  border-color: var(--accent);
}

.tp-x {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-3);
  color: var(--fg-dim);
  line-height: 1;
  cursor: pointer;
}

.tp-list {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 220px;
  overflow-y: auto;
}

.tp-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 3px;
  border-radius: 6px;
  cursor: pointer;
}

.tp-item:hover {
  background: var(--bg-3);
}

.tp-item input[type='checkbox'] {
  flex: 0 0 auto;
  accent-color: var(--accent);
  cursor: pointer;
}

.tp-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border: 1px solid var(--line-2);
  border-radius: 50%;
}

.tp-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-use {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--fg-dim);
}

.tp-empty {
  padding: 10px 3px;
  color: var(--fg-dim);
  text-align: center;
}

.tp-foot {
  border-top: 1px solid var(--line);
  padding-top: 6px;
}

.tp-new {
  width: 100%;
  padding: 5px 8px;
  border: 1px dashed var(--line-2);
  border-radius: var(--radius);
  background: transparent;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-new:disabled {
  opacity: 0.5;
  cursor: default;
}

.tp-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px solid var(--line);
}

.tp-count {
  flex: 1;
  font-size: 12px;
  color: var(--fg-dim);
}

.tp-ok {
  padding: 4px 12px;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--accent-soft);
  color: var(--accent);
  font: inherit;
  cursor: pointer;
}

.tp-ok:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
