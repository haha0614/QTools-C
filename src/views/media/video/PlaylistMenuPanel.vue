<!--
  PlaylistMenuPanel.vue —— 卡片右下角「加入播放列表」的轻量菜单（P5.1）
  职责：只做「画」：已有列表（名称 + 数量 + 已加入态）/ 空态 / 新建输入态 / 接口未就绪 / 编辑策略闸门提示。
        数据与写操作全部来自 usePlaylistAdd.js（与工具栏 PlaylistPicker.vue 同一份），这里不 import 任何接口。
  边界：P5.7 起由 VideoCard 把本组件 teleport 到 body，并用 position: fixed + 视口坐标（pos prop）定位，
        自身不做任何定位计算（也算不出：它已经不在卡片里了）；
        点击不冒泡到卡片（@click.stop），避免误触「打开播放器 / 选择模式勾选」。
  样式：mediaTheme 的 --bg/--bg-2/--line/--fg/--accent（由 --qt-* 映射），亮暗通用。
-->
<template>
  <div
    v-if="open"
    class="pl-menu"
    :data-dir="pos ? (pos.up ? 'up' : 'down') : undefined"
    :style="posStyle"
    role="dialog"
    aria-label="加入播放列表"
    @click.stop
    @keydown.esc.stop="emit('close')"
  >
    <header class="pl-head">
      <span class="pl-title">加入播放列表</span>
      <span class="pl-n">{{ count }} 个视频</span>
      <button class="pl-x" type="button" aria-label="关闭" @click="emit('close')">×</button>
    </header>

    <!-- 闸门（local 档）：一句话说明为什么不给写，并保留「新建」入口之外的只读信息 -->
    <p v-if="blocked" class="pl-hint pl-blocked">{{ blocked }}</p>

    <template v-else>
      <p v-if="loading" class="pl-hint">加载中…</p>
      <p v-else-if="unavailable" class="pl-hint pl-warn">{{ unavailable }}</p>

      <ul v-if="items.length" class="pl-list">
        <li v-for="p in items" :key="p.id">
          <button
            class="pl-item"
            :class="{ on: p.joined }"
            type="button"
            :disabled="!!busyId"
            :title="p.joined ? '已在此列表，可再加入别的列表' : '加入「' + p.name + '」'"
            @click="emit('pick', p)"
          >
            <span class="pl-name">{{ p.name }}</span>
            <span class="pl-count">{{ p.count }} 个</span>
            <span v-if="p.joined" class="pl-joined">已加入 ✓</span>
            <span v-else-if="busyId === p.id" class="pl-busy">…</span>
          </button>
        </li>
      </ul>
      <p v-else-if="!loading" class="pl-hint pl-empty">还没有播放列表</p>

      <div class="pl-new">
        <button v-if="!creating" class="pl-newbtn" type="button" :disabled="!!unavailable" @click="emit('toggle-create')">
          ＋ 新建播放列表
        </button>
        <template v-else>
          <input
            ref="inputEl"
            class="pl-input"
            type="text"
            maxlength="60"
            :value="newName"
            placeholder="新建播放列表名称"
            aria-label="新建播放列表名称"
            @input="emit('update:newName', $event.target.value)"
            @keyup.enter="emit('create')"
          />
          <button class="pl-ok" type="button" :disabled="!canCreate" @click="emit('create')">创建并加入</button>
        </template>
      </div>
      <p v-if="busyId === '__new'" class="pl-hint">正在新建…</p>
    </template>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps({
  /** 菜单开关（由 VideoCard 控制） */
  open: { type: Boolean, default: false },
  /** [{id,name,count,joined}] —— usePlaylistAdd.load() 的产出 */
  items: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  /** 非空 = 接口未就绪的可读提示 */
  unavailable: { type: String, default: '' },
  /** 非空 = 编辑策略闸门文案（local 档） */
  blocked: { type: String, default: '' },
  /** 正在提交的播放列表 id（'__new' = 新建中） */
  busyId: { type: String, default: '' },
  /** 是否已展开新建输入态 */
  creating: { type: Boolean, default: false },
  newName: { type: String, default: '' },
  /** 目标视频数量（标题右侧） */
  count: { type: Number, default: 1 },
  /**
   * P5.7：菜单坐标（由 VideoCard 用 getBoundingClientRect + computeMenuPosition 算好后下发）。
   * 视口坐标系：{ up, left, width, maxHeight, top, bottom }；up=true 用 bottom，否则用 top。
   * null = 没量到（非浏览器环境）→ 回落 CSS 里的兜底定位。
   */
  pos: { type: Object, default: null }
})

const emit = defineEmits(['close', 'pick', 'create', 'toggle-create', 'update:newName'])

const inputEl = ref(null)

/**
 * 坐标 → 内联样式。菜单挂在 body 下，position: fixed 相对**视口**定位，
 * 所以坐标可以直接用视口值：不受卡片堆叠上下文 / overflow / hover transform 影响。
 * z-index 3000 也在这里下发（样式表里也有一份，拿不到坐标时同样比卡片和抽屉层高）。
 */
const posStyle = computed(() => {
  const p = props.pos
  if (!p) return null
  const s = {
    position: 'fixed',
    right: 'auto',
    left: Math.round(p.left || 0) + 'px',
    width: Math.round(p.width || 0) + 'px',
    maxHeight: Math.round(p.maxHeight || 0) + 'px',
    zIndex: 3000
  }
  if (p.up) s.bottom = Math.round(p.bottom || 0) + 'px'
  else s.top = Math.round(p.top || 0) + 'px'
  return s
})

const canCreate = computed(() => !!String(props.newName || '').trim() && !props.busyId && !props.unavailable)

/** 展开新建输入框后把焦点送进去（触屏/桌面都少一次点击） */
watch(
  () => props.creating,
  (v) => {
    if (!v) return
    nextTick(() => {
      const el = inputEl.value
      if (el && typeof el.focus === 'function') el.focus()
    })
  }
)
</script>

<style lang="scss" scoped>
/* P5.7：菜单由 VideoCard teleport 到 body，是 body 的直接子节点。
   position: fixed 在这里是「类默认」（坐标由内联 style 下发的 left/top|bottom/width/max-height 给出）：
   节点不在卡片里 → 不受任何卡片的堆叠上下文 / overflow / hover transform 影响，
   fixed 的包含块就是视口（body/html/#app 都没有 transform / filter / perspective / will-change / contain）。
   z-index 3000：高于卡片内角标（3/4/8）与卡片自身，也高于抽屉层；
   因为节点在 body 下，这个值不再受各卡片堆叠上下文的相互顺序影响。 */
.pl-menu {
  position: fixed;
  z-index: 3000;
  width: min(248px, calc(100vw - 24px));
  max-height: min(300px, 62vh);
  display: flex;
  flex-direction: column;
  padding: 8px;
  border: 1px solid var(--line-2);
  border-radius: var(--radius, 10px);
  background: var(--bg-2);
  color: var(--fg);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.38);
  text-align: left;
  cursor: default;
}

.pl-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px 6px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 6px;
}

.pl-title {
  font-size: 12.5px;
  font-weight: 600;
}

.pl-n {
  font-size: 11px;
  color: var(--fg-dim);
}

.pl-x {
  margin-left: auto;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.pl-x:hover {
  color: var(--fg);
  border-color: var(--line-2);
}

.pl-hint {
  margin: 0 0 6px;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--fg-dim);
}

.pl-warn,
.pl-blocked {
  color: var(--warn);
}

/* 列表很多时内部滚动（max-height 在 .pl-menu 上，这里再兜一层） */
.pl-list {
  flex: 1;
  min-height: 0;
  margin: 0 0 6px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.pl-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

.pl-item:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.pl-item:disabled {
  opacity: 0.6;
  cursor: default;
}

/* 已加入：描边 + 绿色系文字，仍然可点（可以再加到别的列表） */
.pl-item.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.pl-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pl-count {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--fg-dim);
}

.pl-joined {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--accent);
  font-weight: 600;
}

.pl-busy {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--fg-dim);
}

.pl-new {
  display: flex;
  gap: 5px;
  align-items: center;
  padding-top: 6px;
  border-top: 1px dashed var(--line);
}

.pl-newbtn {
  flex: 1;
  padding: 6px 8px;
  border: 1px dashed var(--line-2);
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.pl-newbtn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.pl-newbtn:disabled {
  opacity: 0.5;
  cursor: default;
}

.pl-input {
  flex: 1;
  min-width: 0;
  padding: 5px 7px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 12px;
  outline: none;
}

.pl-input:focus {
  border-color: var(--accent);
}

.pl-ok {
  flex: 0 0 auto;
  padding: 5px 9px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11.5px;
  cursor: pointer;
}

.pl-ok:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 窄屏（<768px，含 <400px）：这里的 width / max-height 只是没有内联坐标时的兜底 ——
   正常路径由 computeMenuPosition 给出「宽度 = min(期望宽, 视口宽 - 16)」与「高度 = min(期望高, 这一侧可用空间)」，
   所以窄屏下菜单一定收在视口内，列表内部滚动（.pl-list 的 overflow-y: auto） */
@media (max-width: 768px) {
  .pl-menu {
    width: min(260px, calc(100vw - 16px));
    max-height: 56vh;
  }
}
</style>
