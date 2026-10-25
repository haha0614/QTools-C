<!--
  SavedFilters.vue —— 筛选抽屉底部的「保存的筛选」（P2-B）
  契约：GET /api/media/filters → [{id,name,params}]；POST 保存（同名覆盖）；DELETE 删除。
  交互：点条目 = 把 params 还原成当前筛选（父级 VideoPage 负责写 hash + 触发列表重算）；
        右侧「×」删除，先就地二次确认再发请求；底部「保存当前筛选」展开输入框，默认名由当前条件生成。
  降级：父级把接口未就绪的结论放进 error，这里只在列表区显示一句提示；
        保存/删除失败由父级 toast，本组件不做任何异常处理、不阻塞筛选。
-->
<template>
  <section class="saved-filters">
    <div class="sf-head">
      <span class="sf-title">保存的筛选</span>
      <em v-if="items.length">{{ items.length }} 个</em>
      <button v-if="!formOpen" class="sf-btn sf-btn-save" type="button" title="把当前筛选条件存下来" @click="openForm">
        保存当前筛选
      </button>
    </div>

    <p v-if="error" class="sf-note sf-note-warn">{{ error }}</p>

    <form v-if="formOpen" class="sf-form" @submit.prevent="confirmSave">
      <input
        ref="nameEl"
        v-model="nameInput"
        class="sf-input"
        type="text"
        maxlength="60"
        autocomplete="off"
        spellcheck="false"
        placeholder="筛选名称"
        @keydown.esc.stop.prevent="closeForm"
      />
      <button class="sf-btn sf-btn-primary" type="submit">保存</button>
      <button class="sf-btn" type="button" @click="closeForm">取消</button>
    </form>

    <p v-if="loading && !items.length" class="sf-note">正在读取…</p>
    <p v-else-if="!items.length" class="sf-note">还没有保存的筛选</p>
    <ul v-else class="sf-list">
      <li v-for="it in items" :key="it.id" class="sf-item">
        <button class="sf-apply" type="button" :title="itemTitle(it)" @click="emit('apply', it)">
          <span class="sf-name">{{ it.name }}</span>
          <em v-if="condCount(it)">{{ condCount(it) }} 项条件</em>
        </button>
        <template v-if="pendingId === it.id">
          <button class="sf-btn sf-btn-danger" type="button" @click="confirmDelete(it)">确认删除</button>
          <button class="sf-btn" type="button" @click="pendingId = ''">取消</button>
        </template>
        <button v-else class="sf-del" type="button" :aria-label="'删除筛选 ' + it.name" :title="'删除 ' + it.name" @click="pendingId = it.id">
          ×
        </button>
      </li>
    </ul>
  </section>
</template>

<script setup>
import { nextTick, ref } from 'vue'

const props = defineProps({
  /** 已保存的筛选：[{ id, name, params }] */
  items: { type: Array, required: true },
  /** 正在读取列表 */
  loading: { type: Boolean, default: false },
  /** 接口未就绪时的列表区提示（非空即显示），如「保存筛选暂不可用」 */
  error: { type: String, default: '' },
  /** 按当前筛选条件自动生成的默认名称 */
  suggestName: { type: String, default: '' }
})

const emit = defineEmits(['apply', 'remove', 'save'])

const formOpen = ref(false)
const nameInput = ref('')
const nameEl = ref(null)
/** 待二次确认删除的条目 id */
const pendingId = ref('')

/** params 里的有效条件数（用于条目副标题，params 缺失时返回 0） */
function condCount(item) {
  const p = (item && item.params) || {}
  let n = 0
  if (p.q) n += 1
  if (Array.isArray(p.cats)) n += p.cats.length
  if (Array.isArray(p.durs)) n += p.durs.length
  if (Array.isArray(p.ress)) n += p.ress.length
  if (Array.isArray(p.sizes)) n += p.sizes.length
  if (p.unsafe) n += 1
  const f = p.facets
  if (f && typeof f === 'object') {
    for (const k of Object.keys(f)) if (Array.isArray(f[k])) n += f[k].length
  }
  return n
}

function itemTitle(item) {
  const n = condCount(item)
  return '应用「' + (item && item.name) + '」' + (n ? '（' + n + ' 项条件）' : '')
}

function openForm() {
  nameInput.value = props.suggestName || ''
  pendingId.value = ''
  formOpen.value = true
  nextTick(() => {
    if (nameEl.value) {
      nameEl.value.focus()
      nameEl.value.select()
    }
  })
}

function closeForm() {
  formOpen.value = false
  nameInput.value = ''
}

function confirmSave() {
  const name = String(nameInput.value || '').trim()
  if (!name) return
  emit('save', name)
  closeForm()
}

function confirmDelete(item) {
  pendingId.value = ''
  emit('remove', item)
}
</script>

<style lang="scss" scoped>
/* 抽屉内常驻底栏上方的一条：自身不定高，列表最多撑 180px 后内部滚动，
   保证筛选抽屉本身的滚动区（FilterSidebar 的 .side-scroll）不被挤到看不见。 */
.saved-filters {
  flex: 0 0 auto;
  padding: 10px 14px 8px;
  border-top: 1px solid var(--line);
  background: var(--bg-2);
}

.sf-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 6px;
}

.sf-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--fg-dim);
}

.sf-head em {
  font-style: normal;
  font-size: 11px;
  color: var(--fg-dim);
  opacity: 0.8;
}

.sf-btn-save {
  margin-left: auto;
}

.sf-btn {
  padding: 4px 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius, 10px);
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1.2;
  cursor: pointer;
  white-space: nowrap;
}

.sf-btn:hover {
  border-color: var(--line-2);
  color: var(--fg);
}

.sf-btn-primary {
  background: var(--accent-btn);
  border-color: var(--accent-btn);
  color: var(--accent-on);
}

.sf-btn-primary:hover {
  border-color: var(--accent);
  color: var(--accent-on);
}

.sf-btn-danger {
  border-color: var(--warn);
  color: var(--warn);
}

.sf-form {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 6px;
}

.sf-input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--fg);
  font-size: 12.5px;
  outline: none;
}

.sf-input:focus {
  border-color: var(--accent);
}

.sf-note {
  margin: 0;
  padding: 2px 2px 4px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--fg-dim);
}

.sf-note-warn {
  color: var(--warn);
}

.sf-list {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 180px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-gutter: stable;
}

.sf-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}

.sf-apply {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg);
  color: var(--fg);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

.sf-apply:hover {
  border-color: var(--line-2);
  background: var(--bg-3);
}

.sf-apply:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.sf-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sf-apply em {
  margin-left: auto;
  flex: 0 0 auto;
  font-style: normal;
  font-size: 11px;
  color: var(--fg-dim);
  opacity: 0.8;
}

.sf-del {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: transparent;
  color: var(--fg-dim);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

.sf-del:hover {
  border-color: var(--warn);
  color: var(--warn);
}

@media (max-width: 768px) {
  .saved-filters {
    padding: 8px 12px 6px;
  }
}
</style>
