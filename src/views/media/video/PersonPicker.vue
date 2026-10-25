<!--
  PersonPicker.vue —— 演员选择器（信息抽屉「人物」区，P5.3-B）
  职责：搜索人物库、多选勾选、为每个人物填角色、现场新建人物（调 POST /api/media/persons，同名复用）。
        只负责「选哪几位 + 各自什么角色」，真正写 views 的接口由父组件（VideoMetaPanel）发起。
  与 TagPicker.vue 的关系：结构与交互同构（搜索 + 勾选 + 现场新建 + 确定/取消），差异只有两点：
    1) 这里返回的是**完整人物集合 + 角色**，不是增量 —— 角色只能挂在被选中的人身上；
    2) 选中项各带一个角色输入框（可空，<= 32 字符，与后端校验一致）。
  三态：有数据（正常列表）/ 无数据（演员库为空，可直接新建）/ 未就绪（404·405·501，
        unavailable 由父级传入：整块只读并提示「演员接口未就绪，暂只能查看」）。
  三档：off 只读；local 新建只落本机（id 前缀 lp-，不发请求）；full 走接口。
  约定：样式全部走 mediaTheme / --qt-* 变量；不 teleport，由父级容器定位（父级 position: relative）。
-->
<template>
  <div class="pp" role="dialog" aria-label="选择演员" @keydown.esc.stop="emit('close')">
    <div class="pp-head">
      <input
        ref="qEl"
        v-model="q"
        class="pp-input"
        type="search"
        placeholder="搜索演员…"
        autocomplete="off"
        spellcheck="false"
      />
      <button class="pp-x" type="button" aria-label="关闭演员选择器" @click="emit('close')">×</button>
    </div>

    <ul v-if="filtered.length" class="pp-list">
      <li v-for="row in filtered" :key="row.key" class="pp-row">
        <label class="pp-item">
          <input
            type="checkbox"
            :checked="isPicked(row.key)"
            :disabled="readOnly || notReady"
            @change="toggle(row)"
          />
          <span class="pp-name" :title="row.name">{{ row.name }}</span>
          <span v-if="row.alias" class="pp-alias" :title="row.alias">{{ row.alias }}</span>
          <span v-if="row.local" class="pp-lc" title="本地新建：仅保存在本浏览器">本地</span>
          <span v-else-if="row.onlyLocal" class="pp-lc" title="只在本机覆盖里存在，服务端人物库还没有它">本机</span>
          <span v-if="row.useCount != null" class="pp-use">{{ row.useCount }}</span>
        </label>
        <!-- 角色：只对被选中的人显示，可空 -->
        <input
          v-if="isPicked(row.key)"
          class="pp-role"
          type="text"
          :value="roleOf(row.key)"
          :disabled="readOnly || notReady"
          :maxlength="ROLE_MAX"
          placeholder="角色（可空，如：女主）"
          :aria-label="'角色：' + row.name"
          @input="setRole(row.key, $event.target.value)"
        />
      </li>
    </ul>
    <div v-else class="pp-empty">{{ emptyText }}</div>

    <div v-if="canCreate" class="pp-foot">
      <button class="pp-new" type="button" :disabled="creating" @click="createFromQuery">
        {{ creating ? '新建中…' : '＋ 新建「' + q.trim() + '」' + (isLocal ? '（仅本地）' : '') }}
      </button>
    </div>
    <!-- 未就绪 / off 档的提示行 -->
    <p v-if="notReady" class="pp-hint">{{ PERSON_NOT_READY }}</p>
    <p v-else-if="readOnly" class="pp-hint">{{ HINT_OFF }}</p>

    <div class="pp-bar">
      <span class="pp-count">已选 {{ picked.length }}</span>
      <button class="pp-ok" type="button" :disabled="readOnly || notReady || !picked.length" @click="confirm">
        确定
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { HINT_OFF } from '@/composables/useMediaEditPolicy'
import { PERSON_ROLE_MAX, isAmateurName, isReusedPerson, normalizePersons, normalizeSelection } from './personRules'
import { PERSON_NOT_READY, createPerson, errorText, isNotReady } from './personApi'

const ROLE_MAX = PERSON_ROLE_MAX

const props = defineProps({
  /** 人物库 [{id,name,alias?,useCount?}]（GET /api/media/persons；未就绪时为空数组） */
  allPersons: { type: Array, default: () => [] },
  /** 当前已选人物 [{id,name,role}]（整体集合，不是增量） */
  selected: { type: Array, default: () => [] },
  /** 人物库是否仍在加载 */
  loading: { type: Boolean, default: false },
  /** 编辑策略档位：off 只读 / local 只写本地 / full 走接口 */
  level: { type: String, default: 'full' },
  /** 演员接口未就绪（父级探测到 404 / 405）：整块只读 + 提示 */
  unavailable: { type: Boolean, default: false }
})

const emit = defineEmits(['confirm', 'close', 'created', 'notify'])

const q = ref('')
const picked = ref(normalizePersons(props.selected))
const creating = ref(false)
const qEl = ref(null)
/** 本次打开内现场新建失败且是「未就绪」→ 立刻整块转只读（不抛异常） */
const localNotReady = ref(false)

const readOnly = computed(() => props.level === 'off')
const isLocal = computed(() => props.level === 'local')
const notReady = computed(() => props.unavailable || localNotReady.value)

/** 一个人的稳定键：有 id 用 id，没有就按名字（索引里旧数据可能是纯名字） */
function keyOf(p) {
  const id = p && (p.id != null ? p.id : p.personId)
  if (id != null && String(id) !== '') return 'id:' + String(id)
  return 'n:' + String((p && p.name) || '').toLowerCase()
}

/**
 * 列表行 = 人物库 + 已选但库里没有的人（本地新建 lp-、服务端库比页面新时的旧条目）。
 * 后者必须出现，否则「已选但看不到」会让人以为丢了。
 */
const rows = computed(() => {
  const out = []
  const seen = new Set()
  const libIds = new Set()
  for (const p of props.allPersons || []) {
    if (!p || !p.name) continue
    const key = keyOf(p)
    if (seen.has(key)) continue
    seen.add(key)
    libIds.add(key)
    out.push({
      key,
      id: p.id != null ? p.id : p.personId != null ? p.personId : null,
      name: String(p.name),
      alias: p.alias ? String(p.alias) : '',
      useCount: p.useCount != null ? p.useCount : null,
      local: isLocal.value && String(p.id == null ? '' : p.id).indexOf('lp-') === 0,
      onlyLocal: false
    })
  }
  for (const p of picked.value) {
    const key = keyOf(p)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      key,
      id: p.id,
      name: p.name,
      alias: '',
      useCount: null,
      local: String(p.id == null ? '' : p.id).indexOf('lp-') === 0,
      onlyLocal: !libIds.has(key)
    })
  }
  return out
})

const filtered = computed(() => {
  const kw = q.value.trim().toLowerCase()
  if (!kw) return rows.value
  return rows.value.filter((r) => r.name.toLowerCase().includes(kw) || String(r.alias || '').toLowerCase().includes(kw))
})

const emptyText = computed(() => {
  if (props.loading) return '演员库加载中…'
  if (notReady.value) return '演员库不可用（接口未就绪）'
  if (!rows.value.length) return '演员库为空，输入名字可直接新建'
  return '无匹配演员'
})

/** 只有输入了库里没有的名字才出现「新建」入口；未就绪 / off 档没有新建 */
const canCreate = computed(() => {
  if (readOnly.value || notReady.value) return false
  const kw = q.value.trim()
  if (!kw) return false
  return !rows.value.some((r) => r.name.toLowerCase() === kw.toLowerCase())
})

function pickedIndex(key) {
  return picked.value.findIndex((p) => keyOf(p) === key)
}

function isPicked(key) {
  return pickedIndex(key) >= 0
}

function roleOf(key) {
  const i = pickedIndex(key)
  return i >= 0 ? picked.value[i].role || '' : ''
}

function setRole(key, value) {
  if (readOnly.value || notReady.value) return
  const i = pickedIndex(key)
  if (i < 0) return
  picked.value[i].role = String(value == null ? '' : value).slice(0, ROLE_MAX)
}

/**
 * 勾选 / 取消勾选，并立即执行「素人 ↔ 真人互斥」规整（唯一实现在 personRules.normalizeSelection）：
 *   - 添加任何真人 → 素人自动剔除，并提示「已自动移除『素人』」；
 *   - 移除最后一位真人 → 自动回到素人（库里有素人就用它的 id，否则留空由卡片兜底）。
 */
function toggle(row) {
  if (readOnly.value || notReady.value) return
  const i = pickedIndex(row.key)
  if (i >= 0) picked.value.splice(i, 1)
  else picked.value.push({ id: row.id, name: row.name, role: '' })
  const norm = normalizeSelection(picked.value, props.allPersons)
  if (norm.removedAmateur) emit('notify', '已自动移除「素人」')
  picked.value = norm.persons
}

/**
 * 现场新建人物：
 *   local 档 —— 只在内存里造一个 lp-<名字> 的本地人物（写盘由父级 savePersons 落 ms.orgpersons.*）；
 *   full 档  —— POST /api/media/persons（后端同名复用）；
 *               未就绪（404/405/501）→ 转只读并提示，其余失败 toast 后端原文。
 */
async function createFromQuery() {
  const name = q.value.trim()
  if (!name || creating.value || readOnly.value || notReady.value) return
  if (isLocal.value) {
    const person = { id: 'lp-' + name, name }
    const existing = picked.value.find((p) => keyOf(p) === keyOf(person))
    if (!existing) picked.value.push({ id: person.id, name: person.name, role: '' })
    emit('created', person)
    emit('notify', '已加入本地演员「' + name + '」（仅本机）')
    q.value = ''
    nextTick(() => qEl.value && qEl.value.focus())
    return
  }
  creating.value = true
  try {
    const body = await createPerson({ name })
    const reused = isReusedPerson(body, props.allPersons)
    const person = {
      id: body && body.id != null ? body.id : 'tmp-' + name,
      name: (body && body.name) || name,
      alias: (body && body.alias) || ''
    }
    emit('created', person)
    if (!isPicked(keyOf(person))) picked.value.push({ id: person.id, name: person.name, role: '' })
    emit('notify', reused ? '「' + person.name + '」已存在，已复用' : '已新建演员「' + person.name + '」')
    q.value = ''
    nextTick(() => qEl.value && qEl.value.focus())
  } catch (err) {
    if (isNotReady(err)) {
      localNotReady.value = true
      emit('notify', PERSON_NOT_READY)
    } else {
      emit('notify', '新建演员失败：' + errorText(err))
    }
  } finally {
    creating.value = false
  }
}

function confirm() {
  if (readOnly.value || notReady.value || !picked.value.length) return
  // 再规整一次（勾选路径已规整，这里防「直接确定」与本地新建的边角），结果才是最终提交集合
  const norm = normalizeSelection(picked.value, props.allPersons)
  if (norm.removedAmateur) emit('notify', '已自动移除「素人」')
  emit(
    'confirm',
    norm.persons.map((p) => ({ id: p.id, name: p.name, role: p.role || '' }))
  )
}

watch(
  () => props.selected,
  (v) => {
    picked.value = normalizePersons(v)
  }
)

onMounted(() => {
  if (qEl.value) qEl.value.focus()
})
</script>

<style lang="scss" scoped>
.pp {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 280px;
  max-width: calc(100vw - 24px);
  padding: 8px;
  background: var(--bg-2);
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.28);
  color: var(--fg);
  font-size: 13px;
}

.pp-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pp-input {
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

.pp-input:focus {
  border-color: var(--accent);
}

.pp-x {
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

.pp-list {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 240px;
  overflow-y: auto;
}

.pp-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 2px 0;
}

.pp-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 3px;
  border-radius: 6px;
  cursor: pointer;
}

.pp-item:hover {
  background: var(--bg-3);
}

.pp-item input[type='checkbox'] {
  flex: 0 0 auto;
  accent-color: var(--accent);
  cursor: pointer;
}

.pp-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pp-alias {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 76px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--fg-dim);
}

/* 本地 / 本机标记：与卡片「本地」徽标同一套虚线主色，但更小 */
.pp-lc {
  flex: 0 0 auto;
  padding: 0 4px;
  border: 1px dashed var(--accent);
  border-radius: 999px;
  font-size: 10px;
  line-height: 1.5;
  color: var(--accent);
}

.pp-use {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--fg-dim);
}

/* 角色输入：缩进到人物名下方，视觉上从属于上面那位演员 */
.pp-role {
  margin: 0 0 2px 26px;
  padding: 3px 6px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  outline: none;
}

.pp-role:focus {
  border-color: var(--accent);
}

.pp-role:disabled {
  opacity: 0.5;
}

.pp-empty {
  padding: 10px 3px;
  color: var(--fg-dim);
  text-align: center;
  font-size: 12px;
}

.pp-foot {
  border-top: 1px solid var(--line);
  padding-top: 6px;
}

/* 未就绪 / off 档提示：与 VideoPage 工具栏同一文案 */
.pp-hint {
  margin: 0;
  padding: 6px 3px;
  border-top: 1px dashed var(--line);
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--fg-dim);
}

.pp-new {
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

.pp-new:disabled {
  opacity: 0.5;
  cursor: default;
}

.pp-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px solid var(--line);
}

.pp-count {
  flex: 1;
  font-size: 12px;
  color: var(--fg-dim);
}

.pp-ok {
  padding: 4px 12px;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--accent-soft);
  color: var(--accent);
  font: inherit;
  cursor: pointer;
}

.pp-ok:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
