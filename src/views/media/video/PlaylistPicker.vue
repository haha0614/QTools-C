<!--
  PlaylistPicker.vue —— 「加入播放列表」弹层（视频库工具栏入口）
  职责：列出已有播放列表（GET /api/media/playlists）+ 新建一个（POST /api/media/playlists），
        选一个后把当前目标视频批量追加进去（POST /api/media/playlist/{id}/videos）。
  边界：受编辑策略闸门 —— off 档页面不打开本弹层；local 档在这里直接说明「不写服务端」并禁用写按钮。
       所有请求 silent + try/catch，接口未就绪时弹层内显示一句可读提示（不弹全局错误、不抛异常）。
  样式：媒体站主题变量（--bg-2 / --line / --accent …，由 mediaTheme.scss 从 --qt-* 映射而来），亮暗通用。
-->
<template>
  <div v-if="open" class="pp-back" @click="emit('close')"></div>
  <aside
    v-if="open"
    class="pp"
    role="dialog"
    aria-modal="true"
    aria-label="加入播放列表"
    @keydown.esc.stop="emit('close')"
  >
    <header class="pp-head">
      <h2 class="pp-title">加入播放列表</h2>
      <span class="pp-sub">{{ count }} 个视频</span>
      <button class="pp-x" type="button" aria-label="关闭" @click="emit('close')">×</button>
    </header>

    <div class="pp-body">
      <p v-if="blocked" class="pp-hint pp-blocked">{{ blocked }}</p>

      <template v-else>
        <p v-if="loading" class="pp-hint">加载中…</p>
        <p v-else-if="unavailable" class="pp-hint pp-warn">{{ unavailable }}</p>
        <ul v-else-if="items.length" class="pp-list">
          <li v-for="p in items" :key="p.id">
            <button class="pp-item" type="button" :disabled="!!busyId" @click="addTo(p)">
              <span class="pp-name" :title="p.name">{{ p.name }}</span>
              <span class="pp-count">{{ countText(p.count) }}</span>
            </button>
          </li>
        </ul>
        <p v-else-if="!loading" class="pp-hint">还没有播放列表，先在下面新建一个</p>

        <div class="pp-new">
          <input
            v-model="newName"
            class="pp-input"
            type="text"
            maxlength="60"
            placeholder="新建播放列表名称"
            aria-label="新建播放列表名称"
            @keyup.enter="createAndAdd"
          />
          <button class="pp-ok" type="button" :disabled="!canCreate" @click="createAndAdd">新建并加入</button>
        </div>
        <p v-if="busyId === '__new'" class="pp-hint">正在新建…</p>
      </template>
    </div>
  </aside>
</template>

<script setup>
import { computed, watch } from 'vue'
// P5.44：计数文案统一「0 个 / N 个」（与卡片菜单同一份纯函数）
import { countText } from './playlistWrite'
import { addedMessage, createdMessage, usePlaylistAdd } from './usePlaylistAdd'

const props = defineProps({
  /** 弹层开关（由 VideoPage 控制） */
  open: { type: Boolean, default: false },
  /** 要加入的视频 id 列表（单条播放器上下文 / 多选批量都走这里） */
  videoIds: { type: Array, default: () => [] },
  /** 编辑策略档位：off 不打开；local 不写服务端；full 正常 */
  level: { type: String, default: 'full' }
})

const emit = defineEmits(['close', 'added', 'notify'])

/**
 * 数据源 / 写入口 / 闸门文案全部来自 usePlaylistAdd（与卡片右下角入口同一份实现）：
 * 这里只负责「居中弹层」的展示与关窗时机（加入成功即关，卡片入口则保持打开）。
 */
const {
  loading,
  items,
  unavailable,
  busyId,
  newName,
  blocked,
  canCreate,
  targetCount,
  lastAdd,
  load,
  addTo: addToList,
  createAndAdd: createAndAddToList,
  reset
} = usePlaylistAdd({
  level: () => props.level,
  videoIds: () => (props.videoIds || []).slice(),
  notify: (msg) => emit('notify', msg)
})

const count = computed(() => targetCount.value)

watch(
  () => props.open,
  (v) => {
    if (!v) {
      reset()
      return
    }
    load()
  }
)

/**
 * 批量入口：加入成功就关弹层（工具栏入口是一次性动作）。
 * 「已加入…N 个」只报真实新增数（lastAdd.added）：幂等命中时 usePlaylistAdd 已经给过提示，这里不再重复（P5.41）。
 */
async function addTo(p) {
  if (!(await addToList(p))) return
  if (lastAdd.value.added > 0) emit('added', addedMessage(p && p.name, lastAdd.value.added))
  emit('close')
}

async function createAndAdd() {
  const made = await createAndAddToList()
  if (!made) return
  if (made.added > 0) emit('added', createdMessage(made.name, made.added))
  emit('close')
}
</script>

<style lang="scss" scoped>
.pp-back {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(0, 0, 0, 0.42);
}

.pp {
  position: fixed;
  z-index: 61;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(420px, calc(100vw - 28px));
  max-height: min(560px, calc(100vh - 80px));
  display: flex;
  flex-direction: column;
  background: var(--bg-2);
  color: var(--fg);
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.42);
  overflow: hidden;
}

.pp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}

.pp-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.pp-sub {
  font-size: 12px;
  color: var(--fg-dim);
}

.pp-x {
  margin-left: auto;
  width: 26px;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

.pp-x:hover {
  color: var(--fg);
  border-color: var(--line-2);
}

.pp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px 12px;
  scrollbar-width: thin;
}

.pp-hint {
  margin: 0 0 8px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--fg-dim);
}

.pp-warn {
  color: var(--warn);
}

.pp-blocked {
  color: var(--warn);
}

.pp-list {
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 300px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.pp-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.pp-item:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.pp-item:disabled {
  opacity: 0.55;
  cursor: default;
}

.pp-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* P5.44：等宽数字 + 最小宽度 —— 计数从 0 变 10 时行宽不跳（与卡片菜单同一口径） */
.pp-count {
  flex: 0 0 auto;
  min-width: 3.2em;
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
  font-size: 11.5px;
  color: var(--fg-dim);
}

.pp-new {
  display: flex;
  gap: 6px;
  align-items: center;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}

.pp-input {
  flex: 1;
  min-width: 0;
  padding: 6px 9px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
  outline: none;
}

.pp-input:focus {
  border-color: var(--accent);
}

.pp-ok {
  flex: 0 0 auto;
  padding: 6px 12px;
  border: 1px solid var(--accent);
  border-radius: 7px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12.5px;
  cursor: pointer;
}

.pp-ok:disabled {
  opacity: 0.5;
  cursor: default;
}

@media (max-width: 768px) {
  .pp {
    top: auto;
    bottom: 0;
    left: 0;
    transform: none;
    width: 100%;
    max-height: 82vh;
    border-radius: var(--radius) var(--radius) 0 0;
  }
}
</style>
