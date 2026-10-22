<!--
  FilterSidebar.vue —— 筛选抽屉的内容体（分类 chips + 快捷筛选插槽 + facet 折叠组）
  来源：index.html:14-25 的 DOM + app.js renderCats (662-670) / renderFacetGroups (672-692) /
        syncFacetUI (695-715) / facetGroups 的 change+input 监听 (1361-1388)。
  与原页的差异：原页只同步勾选态不重建 DOM 以保住折叠与搜索框状态；Vue 用局部状态（openMap / searchMap）
        达到同样效果——勾选变化不重置折叠与组内搜索词。
-->
<template>
  <div class="fs-scope">
    <div ref="scrollEl" class="side-scroll">
      <section class="fgroup fgroup-cat">
        <div class="fgroup-head">
          <h2>分类</h2>
          <em>{{ catNames.length }} 个</em>
        </div>
        <div class="chips">
          <button
            v-for="c in catNames"
            :key="c"
            class="chip"
            :class="{ on: selectedCats.indexOf(c) >= 0 }"
            type="button"
            :aria-pressed="selectedCats.indexOf(c) >= 0"
            @click="emit('toggle-cat', c)"
          >
            {{ c }}<em>{{ catCounts[c] || 0 }}</em>
          </button>
        </div>
      </section>

      <div class="quick-slot"><slot name="quick"></slot></div>

      <div class="facet-groups">
        <details
          v-for="facet in facetKeys"
          :key="facet"
          class="fg"
          :data-facet="facet"
          :open="isOpen(facet)"
          @toggle="onToggleOpen(facet, $event)"
        >
          <summary>
            <span class="fg-name">{{ facet }}</span>
            <span class="fg-n">{{ countText(facet) }}</span>
            <span class="fg-caret"></span>
          </summary>
          <input
            class="fg-search"
            type="search"
            :placeholder="'搜索' + facet + '…'"
            autocomplete="off"
            spellcheck="false"
            :value="searchMap[facet] || ''"
            @input="onSearchInput(facet, $event)"
          />
          <div class="fg-list">
            <label
              v-for="item in visibleItems(facet)"
              :key="item[0]"
              class="opt"
              :class="{ on: (selectedFacets[facet] || []).indexOf(item[0]) >= 0 }"
            >
              <input
                type="checkbox"
                :value="item[0]"
                :checked="(selectedFacets[facet] || []).indexOf(item[0]) >= 0"
                @change="emit('toggle-facet', facet, item[0])"
              />
              <span class="opt-t">{{ item[0] }}</span><em>{{ item[1] }}</em>
            </label>
          </div>
          <div v-if="!visibleItems(facet).length" class="fg-none">无匹配</div>
        </details>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps({
  /** 分类名（已按 zh-Hans-CN 排序） */
  catNames: { type: Array, required: true },
  /** 分类 → 数量 */
  catCounts: { type: Object, required: true },
  /** facet → [[值, 计数], …] */
  groups: { type: Object, required: true },
  selectedCats: { type: Array, required: true },
  selectedFacets: { type: Object, required: true }
})

const emit = defineEmits(['toggle-cat', 'toggle-facet'])

const scrollEl = ref(null)

/** 折叠状态：用户手动展开/收起后覆盖默认值（有选中项默认展开，与 app.js:684 一致） */
const openMap = reactive({})
/** 组内搜索词：原页保存 DOM 输入框状态，这里用状态保存 */
const searchMap = reactive({})

const facetKeys = computed(() => Object.keys(props.groups || {}))

function selectedCount(facet) {
  const arr = props.selectedFacets[facet]
  return Array.isArray(arr) ? arr.length : 0
}

function isOpen(facet) {
  if (openMap[facet] === undefined) return selectedCount(facet) > 0
  return openMap[facet]
}

function onToggleOpen(facet, event) {
  openMap[facet] = event.target.open
}

function countText(facet) {
  const total = (props.groups[facet] || []).length
  const n = selectedCount(facet)
  return n ? '已选 ' + n + '/' + total : String(total)
}

function visibleItems(facet) {
  const q = String(searchMap[facet] || '').trim().toLowerCase()
  const all = props.groups[facet] || []
  if (!q) return all
  return all.filter((it) => String(it[0]).toLowerCase().indexOf(q) >= 0)
}

function onSearchInput(facet, event) {
  searchMap[facet] = event.target.value
}

/** 选中项出现时自动展开该组（app.js:713 `if (n && !d.open) d.open = true`） */
watch(
  () => props.selectedFacets,
  (sel) => {
    for (const f of Object.keys(sel || {})) {
      if ((sel[f] || []).length && openMap[f] === false) openMap[f] = true
    }
  },
  { deep: true }
)

/** 滚动到快捷筛选区（app.js:1602-1613 scrollDrawerToQuick 的等价实现） */
function scrollToQuick() {
  const box = scrollEl.value
  if (!box) return
  const target = box.querySelector('.quick-slot')
  if (!target) return
  const move = () => {
    const dy = target.getBoundingClientRect().top - box.getBoundingClientRect().top
    box.scrollTop = Math.max(0, box.scrollTop + dy - 8)
  }
  move()
  setTimeout(move, 240)
}

defineExpose({ scrollToQuick })
</script>

<style lang="scss" scoped>
/* 抽屉内容体：自身不定宽、不定位——宽度与滑入由 VideoPage.vue 的 .filter-drawer 决定，
   这里只做「头/尾固定、中段滚动」的弹性列：.fs-scope 撑满抽屉剩余高度，.side-scroll 在内部滚动。 */
.fs-scope {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

/* scrollbar-gutter: 展开分组时滚动条出现不再挤窄内容、导致 chips 重新折行 */
.side-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px 16px;
  scrollbar-width: thin;
  scrollbar-gutter: stable;
}

.fgroup {
  margin-bottom: 14px;
}

.fgroup-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 4px 8px;
}

.fgroup-head h2 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--fg-dim);
}

.fgroup-head em {
  font-style: normal;
  font-size: 11px;
  color: var(--fg-dim);
  opacity: 0.8;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 12.5px;
  line-height: 1.2;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
  white-space: nowrap;
}

.chip:hover {
  border-color: var(--line-2);
  color: var(--fg);
}

.chip.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.chip em {
  font-style: normal;
  font-size: 11px;
  opacity: 0.6;
}

.facet-groups {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

details.fg {
  border: 1px solid var(--line);
  border-radius: var(--radius, 10px);
  background: var(--bg);
  overflow: hidden;
}

details.fg > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  cursor: pointer;
  list-style: none;
  font-size: 12.5px;
  color: var(--fg);
}

details.fg > summary::-webkit-details-marker {
  display: none;
}

details.fg > summary:hover {
  background: var(--bg-3);
}

.fg-name {
  font-weight: 600;
}

.fg-n {
  margin-left: auto;
  font-size: 11px;
  color: var(--fg-dim);
  font-style: normal;
}

.fg-caret {
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid var(--fg-dim);
  transition: transform 0.15s;
}

details.fg[open] .fg-caret {
  transform: rotate(180deg);
}

.fg-search {
  width: calc(100% - 16px);
  margin: 0 8px 6px;
  padding: 4px 8px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 6px;
  font-size: 12px;
  color: var(--fg);
  outline: none;
}

.fg-search:focus {
  border-color: var(--accent);
}

.fg-list {
  max-height: 260px;
  overflow-y: auto;
  padding: 0 6px 6px;
  scrollbar-width: thin;
  scrollbar-gutter: stable;
}

.opt {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 3px 6px;
  border-radius: 5px;
  font-size: 12.5px;
  color: var(--fg-dim);
  cursor: pointer;
}

.opt:hover {
  background: var(--bg-3);
  color: var(--fg);
}

.opt.on {
  color: var(--fg);
  background: var(--accent-soft);
}

.opt input {
  accent-color: var(--accent);
  margin: 0;
}

.opt-t {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.opt em {
  font-style: normal;
  font-size: 11px;
  color: var(--fg-dim);
}

.fg-none {
  padding: 4px 10px 8px;
  font-size: 12px;
  color: var(--fg-dim);
}

/* 抽屉在 ≤768px 占满全宽，内容体自身不再需要任何宽度/位移规则，只有组内留白略收紧 */
@media (max-width: 768px) {
  .side-scroll {
    padding: 10px 12px 14px;
  }
}
</style>
