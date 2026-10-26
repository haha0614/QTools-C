<!--
  PlaylistFilter.vue —— 视频库顶部筛选条里的「播放列表」维度（P5.46）
  为什么是一个下拉而不是页面：播放列表从「独占页面」降级成与「时长 / 分辨率 / 体积」并列的
  **筛选维度**（用户决定：形态用 C）。选中某个列表后，网格只显示该列表的片子，并且
  顺序 = 列表顺序（覆盖排序下拉）；面板底部保留「管理播放列表…」「新建播放列表…」两个动作，
  管理能力收进弹层（PlaylistManageDialog.vue），不再有独立页。
  边界：本组件只负责「画 + 开关」；清单数据、当前值、写操作全部由 VideoPage 持有（单一来源）。
  降级：接口未就绪时面板里只显示一句可读提示，不影响库里其它筛选。
  样式：媒体站主题变量（--bg-2 / --line / --accent …），亮暗与窄屏通用，不写死颜色。
-->
<template>
  <div ref="rootEl" class="plf" data-plf="1">
    <button
      ref="btnEl"
      class="plf-btn"
      :class="{ on: !!current }"
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open ? 'true' : 'false'"
      :title="current ? '播放列表：' + currentName + '（按列表顺序）' : '按播放列表筛选'"
      :data-pl-cur="current || ''"
      @click="toggle"
    >
      <span class="plf-k">播放列表</span>
      <span class="plf-v">{{ currentName }}</span>
      <span class="plf-caret" aria-hidden="true">▾</span>
    </button>

    <!-- 面板：全部 + 各列表（带条目数）+ 分隔线 + 管理 / 新建 -->
    <div v-if="open" class="plf-pop" role="listbox" aria-label="按播放列表筛选">
      <button
        class="plf-item"
        :class="{ on: !current }"
        type="button"
        role="option"
        :aria-selected="!current"
        data-pl-id=""
        @click="pick('')"
      >
        <span class="plf-name">全部</span>
        <span class="plf-n">{{ total }}</span>
      </button>

      <button
        v-for="p in lists"
        :key="p.id"
        class="plf-item"
        :class="{ on: String(p.id) === String(current) }"
        type="button"
        role="option"
        :aria-selected="String(p.id) === String(current)"
        :data-pl-id="String(p.id)"
        :title="p.name"
        @click="pick(p.id)"
      >
        <span class="plf-name">{{ p.name }}</span>
        <span class="plf-n">{{ p.count }}</span>
      </button>

      <p v-if="loading" class="plf-hint">加载中…</p>
      <p v-else-if="unavailable" class="plf-hint plf-warn">{{ unavailable }}</p>
      <p v-else-if="!lists.length" class="plf-hint">还没有播放列表</p>

      <div class="plf-sep" role="separator"></div>
      <button class="plf-act" type="button" data-pl-act="manage" @click="act('manage')">管理播放列表…</button>
      <button class="plf-act" type="button" data-pl-act="create" @click="act('create')">新建播放列表…</button>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'

const props = defineProps({
  /** GET /api/media/playlists 归一化后的清单：[{id,name,count}] */
  lists: { type: Array, default: () => [] },
  /** 当前选中的播放列表 id（'' = 全部） */
  current: { type: String, default: '' },
  /** 清单加载中 */
  loading: { type: Boolean, default: false },
  /** 非空 = 接口未就绪的可读提示 */
  unavailable: { type: String, default: '' },
  /** 「全部」右侧的数字：全库条目数（与工具栏「显示 M / N」的 N 同源） */
  total: { type: Number, default: 0 }
})

const emit = defineEmits(['select', 'manage', 'create'])

const rootEl = ref(null)
const btnEl = ref(null)
const open = ref(false)

/** 选中项名称：清单没拿到时退化成 #id，绝不让按钮变成空白 */
const currentName = computed(() => {
  const id = String(props.current || '')
  if (!id) return '全部'
  const hit = props.lists.find((p) => String(p.id) === id)
  return hit ? hit.name : '#' + id
})

function onDocDown(ev) {
  const root = rootEl.value
  if (!root || !open.value) return
  if (root.contains(ev.target)) return
  close()
}

function onDocKey(ev) {
  if (!open.value) return
  if (ev.key === 'Escape') {
    close()
    if (btnEl.value && typeof btnEl.value.focus === 'function') btnEl.value.focus()
  }
}

function bind() {
  document.addEventListener('pointerdown', onDocDown, true)
  document.addEventListener('keydown', onDocKey, true)
}

function unbind() {
  document.removeEventListener('pointerdown', onDocDown, true)
  document.removeEventListener('keydown', onDocKey, true)
}

/** 打开面板（侧栏「播放列表」入口跳进来时由 VideoPage 调这个把下拉弹出来） */
function openPanel() {
  if (open.value) return
  open.value = true
  bind()
}

function close() {
  if (!open.value) return
  open.value = false
  unbind()
}

function toggle() {
  if (open.value) close()
  else openPanel()
}

function pick(id) {
  close()
  emit('select', id ? String(id) : '')
}

function act(kind) {
  close()
  emit(kind)
}

onBeforeUnmount(unbind)

defineExpose({ open: openPanel, close, isOpen: () => open.value })
</script>

<style lang="scss" scoped>
/* 与 QuickFilters 的 chip 同一视觉语言：同一行里看不出这是「另一个组件」 */
.plf {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  max-width: 100%;
}

.plf-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: min(260px, calc(100vw - 48px));
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1.2;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}

.plf-btn:hover {
  border-color: var(--line-2);
  color: var(--fg);
}

.plf-btn.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.plf-k {
  color: inherit;
  opacity: 0.75;
}

.plf-v {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plf-caret {
  font-size: 9px;
  opacity: 0.6;
}

/* 面板：贴着筛选条展开，不改变行高（否则整排 chip 会跳一下） */
.plf-pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 40;
  width: max-content;
  min-width: 220px;
  max-width: min(320px, calc(100vw - 24px));
  max-height: min(340px, 60vh);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  background: var(--bg-2);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.3);
  scrollbar-width: thin;
}

.plf-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--fg);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

.plf-item:hover {
  background: var(--bg-3);
}

.plf-item.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.plf-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plf-n {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--fg-dim);
}

.plf-item.on .plf-n {
  color: var(--accent);
}

.plf-hint {
  margin: 2px 6px 4px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--fg-dim);
  overflow-wrap: anywhere;
}

.plf-warn {
  color: var(--warn);
}

.plf-sep {
  height: 1px;
  margin: 4px 2px;
  background: var(--line);
}

.plf-act {
  width: 100%;
  padding: 5px 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--fg);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

.plf-act:hover {
  background: var(--bg-3);
  color: var(--accent);
}
</style>
