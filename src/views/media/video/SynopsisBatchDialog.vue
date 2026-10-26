<!--
  SynopsisBatchDialog.vue —— 批量生成简介的**安全壳**（P5.55）

  为什么要有这个弹层：P5.47 的批量按钮点一下就直接全库开跑（overwrite=false 只保证「不覆盖」，
  但「点错一下 = 176 条任务入队」这件事本身没有拦）。P5.55 把入口改成三段：

    1) confirm  两步确认：先看清「将对 N 部片子生成、已有内容的 M 部将跳过/覆盖」，
                再在输入框里敲「确认」。全库（没有选中项）时还要额外勾一个「我确认对全库操作」。
                overwrite 默认 false，要覆盖必须显式勾「包括已有内容」。
    2) run      进度 + 停止按钮（协作式：正在生成的那一条会跑完，之后的不再开始）。
    3) summary  成果汇总（总条数/已生成/已跳过（分类）/失败/未处理），done / stopped / failed 三种标题，
                有旧值快照时给「撤销本次批量」。

  状态机在页面（VideoPage）：本组件只渲染 props.phase 对应的那一段并 emit 意图。
  这与 PersonAvatarDialog 的分工一致 —— 组件不碰接口、不碰轮询。
-->
<script setup>
import { computed, ref, watch } from 'vue'
import { batchSummary } from './synopsisGenerate'

const props = defineProps({
  open: { type: Boolean, default: false },
  /** confirm | run | summary | undo */
  phase: { type: String, default: 'confirm' },
  /** { hasSelection:boolean, count:number } —— 本次的目标范围（只用于文案） */
  target: { type: Object, default: () => ({ hasSelection: false, count: 0 }) },
  /** 影响面预览 { total, withExisting, withoutExisting, willProcess, willSkip } */
  preview: { type: Object, default: null },
  previewLoading: { type: Boolean, default: false },
  previewError: { type: String, default: '' },
  /** 生成方式 template | llm（只用于文案：这次是模板还是本地模型） */
  mode: { type: String, default: 'template' },
  /** 当前任务节点（null = 还没提交过） */
  job: { type: Object, default: null },
  /** 提交中（按钮 loading） */
  busy: { type: Boolean, default: false },
  /** 已发出停止请求（等最后一条生成完） */
  stopping: { type: Boolean, default: false },
  /** 撤销：本次批量真正写过的 id 数（没有记录时 0） */
  undoCount: { type: Number, default: 0 },
  /** 撤销的目标 id 文本（逗号 / 空格 / 换行分隔；后端任务丢失时由用户手贴） */
  undoIdsText: { type: String, default: '' },
  /** 撤销：dry-run 结果 { willClear, alreadyEmpty, missing } */
  undoPreview: { type: Object, default: null },
  undoBusy: { type: Boolean, default: false },
  undoDone: { type: Object, default: null },
  /** 任务是否记了旧值快照（true 才能「撤销本次批量」精确回滚，否则只能按 ids 清空） */
  canRollback: { type: Boolean, default: false }
})
const emit = defineEmits([
  'close',
  'start',
  'stop',
  'retry-preview',
  'undo-open',
  'undo-preview',
  'undo-confirm',
  'undo-rollback',
  'update:undoIdsText'
])

/** 两步确认的输入词：必须是这两个字（不是「确定」，避免手滑连点） */
const CONFIRM_WORD = '确认'

const confirmText = ref('')
const undoText = ref('')
/** 全库范围必须显式勾一下（默认不勾） */
const scopeAck = ref(false)
/** 包括已有内容 = overwrite=true（默认不勾） */
const includeExisting = ref(false)

const summary = computed(() => batchSummary(props.job))

const needScopeAck = computed(() => !(props.target && props.target.hasSelection))
const canStart = computed(() => {
  if (props.busy) return false
  if (confirmText.value.trim() !== CONFIRM_WORD) return false
  if (needScopeAck.value && !scopeAck.value) return false
  const willProcess = props.preview ? Number(props.preview.willProcess) || 0 : 0
  return willProcess > 0
})

const targetCount = computed(() => {
  if (props.preview && Number.isFinite(Number(props.preview.total))) return Number(props.preview.total)
  return Number(props.target && props.target.count) || 0
})

const withExisting = computed(() => (props.preview ? Number(props.preview.withExisting) || 0 : 0))
const willProcess = computed(() => (props.preview ? Number(props.preview.willProcess) || 0 : 0))
const willSkip = computed(() => (props.preview ? Number(props.preview.willSkip) || 0 : 0))

const modeText = computed(() => (props.mode === 'llm' ? '本地模型（内容梗概）' : '模板（客观信息）'))

const undoNeedConfirm = computed(() => undoText.value.trim() === CONFIRM_WORD)

const undoPlan = computed(() => {
  const p = props.undoPreview
  if (!p) return ''
  const willClear = Number(p.willClear) || 0
  const alreadyEmpty = Number(p.alreadyEmpty) || 0
  const missing = Number(p.missing) || 0
  return (
    '将清空 ' + willClear + ' 条' +
    (alreadyEmpty ? '（另有 ' + alreadyEmpty + ' 条本来就是空的，不用动）' : '') +
    (missing ? '（' + missing + ' 条视频已不存在）' : '')
  )
})

/** 每次打开都从「干净」开始：上一次勾的「包括已有内容」绝不能留到下一次 */
watch(
  () => props.open,
  (open) => {
    if (!open) return
    confirmText.value = ''
    undoText.value = ''
    scopeAck.value = false
    includeExisting.value = false
  }
)

watch(
  () => props.phase,
  (phase) => {
    if (phase === 'undo') undoText.value = ''
  }
)

function onStart() {
  if (!canStart.value) return
  emit('start', { overwrite: includeExisting.value })
}

function onKeydown(ev) {
  if (ev && ev.key === 'Escape' && props.open) emit('close')
}
if (typeof window !== 'undefined') window.addEventListener('keydown', onKeydown)
</script>

<template>
  <div v-if="open" class="sb-mask" data-role="syn-batch-dialog" @click.self="emit('close')">
    <div class="sb-panel" role="dialog" aria-modal="true" :aria-label="'批量生成简介'">
      <header class="sb-head">
        <strong class="sb-title">
          <template v-if="phase === 'confirm'">批量生成简介 · 两步确认</template>
          <template v-else-if="phase === 'run'">批量生成中</template>
          <template v-else-if="phase === 'undo'">撤销批量生成</template>
          <template v-else>{{ summary.title }}</template>
        </strong>
        <button class="sb-x" type="button" title="关闭" data-role="syn-batch-close" @click="emit('close')">✕</button>
      </header>

      <!-- ① 两步确认 -->
      <div v-if="phase === 'confirm'" class="sb-body" data-role="syn-batch-confirm">
        <p v-if="previewLoading" class="sb-state">正在统计影响范围…</p>
        <p v-else-if="previewError" class="sb-state sb-state-err">
          {{ previewError }}
          <button class="sb-btn sb-btn-sm" type="button" data-role="syn-batch-retry" @click="emit('retry-preview')">重试</button>
        </p>
        <template v-else>
          <p class="sb-lead" data-role="syn-batch-lead">
            将对 <b>{{ targetCount }}</b> 部片子生成简介（{{ modeText }}）；
            已有内容的 <b>{{ withExisting }}</b> 部将
            <b>{{ includeExisting ? '被覆盖' : '跳过' }}</b>：
            本次实际生成 <b data-role="syn-batch-willprocess">{{ willProcess }}</b> 条，
            跳过 <b>{{ willSkip }}</b> 条。
          </p>
          <p v-if="needScopeAck" class="sb-warn" data-role="syn-batch-scope-warn">
            当前没有选中项：这次是<b>全库</b>批量，范围最大、不可撤销时最难收拾。
          </p>

          <label class="sb-check" data-role="syn-batch-scope-ack">
            <input v-model="scopeAck" type="checkbox" :disabled="busy" />
            <span v-if="needScopeAck">我确认对<b>全库 {{ targetCount }} 部</b>片子批量生成</span>
            <span v-else>我确认对选中的 <b>{{ targetCount }} 部</b>片子批量生成</span>
          </label>

          <label class="sb-check" data-role="syn-batch-include-existing">
            <input v-model="includeExisting" type="checkbox" :disabled="busy" />
            <span>
              包括已有内容（<b>会覆盖</b>已写好的 {{ withExisting }} 条；默认不勾 = 只补空）
            </span>
          </label>

          <label class="sb-label" for="sb-confirm-input">在下面输入「{{ CONFIRM_WORD }}」才执行</label>
          <input
            id="sb-confirm-input"
            v-model="confirmText"
            class="sb-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :placeholder="'输入 ' + CONFIRM_WORD"
            data-role="syn-batch-confirm-input"
            @keyup.enter="onStart"
          />
          <p class="sb-hint">
            确认为两步：这里敲字 + 勾选范围。批量是不可逆的写库操作（有旧值快照时可撤销一次）。
          </p>
        </template>
      </div>

      <!-- ② 运行中：进度 + 停止 -->
      <div v-else-if="phase === 'run'" class="sb-body" data-role="syn-batch-run">
        <p class="sb-lead" data-role="syn-batch-progress-text">
          <template v-if="stopping">正在停止…（等本条生成完）</template>
          <template v-else>批量生成中</template>
          {{ Number(job && job.processed) || 0 }} / {{ Number(job && job.total) || 0 }} ·
          已生成 {{ Number(job && job.generated) || 0 }} ·
          跳过 {{ Number(job && job.skipped) || 0 }} ·
          失败 {{ Number(job && job.failed) || 0 }}
        </p>
        <p class="sb-hint">
          后端逐条处理，每完成一条立刻落库。点「停止」不会打断正在生成的那一条，之后的条目不再开始。
        </p>
      </div>

      <!-- ③ 成果汇总 -->
      <div v-else-if="phase === 'summary'" class="sb-body" data-role="syn-batch-summary">
        <p class="sb-lead" :data-role="'syn-batch-status-' + summary.status">
          {{ summary.title }}
          <template v-if="summary.status === 'stopped'">：已处理的部分已落库，剩余 {{ summary.remaining }} 条未处理</template>
          <template v-else-if="summary.status === 'failed'">：{{ (job && job.error) || '未知错误' }}</template>
        </p>
        <div class="sb-grid" data-role="syn-batch-counts">
          <div v-for="row in summary.rows" :key="row.key" class="sb-cell" :data-k="row.key">
            <span class="sb-cell-v">{{ row.value }}</span>
            <span class="sb-cell-l">{{ row.label }}</span>
          </div>
        </div>
        <ul v-if="summary.reasons.length" class="sb-reasons" data-role="syn-batch-reasons">
          <li v-for="r in summary.reasons" :key="r.key">{{ r.label }}：{{ r.value }}</li>
        </ul>
        <p v-if="canRollback" class="sb-hint" data-role="syn-batch-rollback-hint">
          本次批量记录了每一行的旧值，可以精确撤销（旧值为空 → 清空，非空 → 写回原文）。
        </p>
        <p v-else-if="undoCount" class="sb-hint">本次任务没有旧值快照，撤销只能按 ids 清空生成结果。</p>
      </div>

      <!-- ④ 撤销 -->
      <div v-else class="sb-body" data-role="syn-batch-undo">
        <p class="sb-lead">
          <template v-if="canRollback">
            撤销本次批量：<b>{{ undoCount }}</b> 行会恢复到落库前的原文。
          </template>
          <template v-else>
            按 ids 清空：<b>{{ undoCount }}</b> 个视频的简介会被清空（任务没有旧值快照，恢复不了原文）。
          </template>
        </p>
        <label class="sb-label" for="sb-undo-ids">目标视频 id（逗号 / 空格 / 换行分隔）</label>
        <textarea
          id="sb-undo-ids"
          class="sb-input sb-textarea"
          rows="3"
          spellcheck="false"
          data-role="syn-batch-undo-ids"
          :value="undoIdsText"
          @input="emit('update:undoIdsText', $event.target.value)"
        ></textarea>
        <button class="sb-btn sb-btn-sm sb-btn-block" type="button" :disabled="undoBusy" data-role="syn-batch-undo-dryrun" @click="emit('undo-preview')">
          先统计会清空几条（不写库）
        </button>
        <p v-if="undoPlan" class="sb-lead sb-lead-2" data-role="syn-batch-undo-plan">{{ undoPlan }}</p>
        <p v-if="undoDone" class="sb-ok" data-role="syn-batch-undo-done">
          {{ undoDone.text }}
        </p>
        <label class="sb-label" for="sb-undo-input">在下面输入「{{ CONFIRM_WORD }}」才执行</label>
        <input
          id="sb-undo-input"
          v-model="undoText"
          class="sb-input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :placeholder="'输入 ' + CONFIRM_WORD"
          data-role="syn-batch-undo-input"
        />
        <p class="sb-hint">
          <template v-if="canRollback">撤销是写库操作：旧值会原样写回，回滚后的手改不会被再次覆盖。</template>
          <template v-else>清空只影响简介字段，不删视频、不动标签人物。</template>
        </p>
      </div>

      <footer class="sb-foot">
        <!-- confirm -->
        <template v-if="phase === 'confirm'">
          <span class="sb-spacer"></span>
          <button class="sb-btn" type="button" :disabled="busy" @click="emit('close')">取消</button>
          <button
            class="sb-btn sb-btn-primary"
            type="button"
            :disabled="!canStart"
            data-role="syn-batch-start"
            @click="onStart"
          >
            {{ busy ? '提交中…' : '开始批量生成' }}
          </button>
        </template>
        <!-- run -->
        <template v-else-if="phase === 'run'">
          <span class="sb-spacer"></span>
          <button class="sb-btn" type="button" @click="emit('close')">后台运行</button>
          <button
            class="sb-btn sb-btn-danger"
            type="button"
            :disabled="stopping"
            data-role="syn-batch-stop"
            @click="emit('stop')"
          >
            {{ stopping ? '正在停止…' : '停止' }}
          </button>
        </template>
        <!-- summary -->
        <template v-else-if="phase === 'summary'">
          <button
            v-if="canRollback || undoCount"
            class="sb-btn sb-btn-danger"
            type="button"
            data-role="syn-batch-undo-open"
            @click="emit('undo-open')"
          >
            撤销本次批量
          </button>
          <span class="sb-spacer"></span>
          <button class="sb-btn" type="button" data-role="syn-batch-summary-close" @click="emit('close')">关闭</button>
        </template>
        <!-- undo -->
        <template v-else>
          <span class="sb-spacer"></span>
          <button class="sb-btn" type="button" :disabled="undoBusy" @click="emit('close')">取消</button>
          <button
            v-if="canRollback"
            class="sb-btn sb-btn-danger"
            type="button"
            :disabled="undoBusy || !undoNeedConfirm"
            data-role="syn-batch-undo-rollback"
            @click="emit('undo-rollback')"
          >
            {{ undoBusy ? '撤销中…' : '确认撤销（恢复旧值）' }}
          </button>
          <button
            v-else
            class="sb-btn sb-btn-danger"
            type="button"
            :disabled="undoBusy || !undoNeedConfirm"
            data-role="syn-batch-undo-clear"
            @click="emit('undo-confirm')"
          >
            {{ undoBusy ? '清空中…' : '确认清空（不可恢复）' }}
          </button>
        </template>
      </footer>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.sb-mask {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.45);
}

.sb-panel {
  width: min(560px, 100%);
  max-height: min(82vh, 640px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--radius, 10px);
  background: var(--bg-2);
  color: var(--fg);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}

.sb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}

.sb-title {
  font-size: 14.5px;
  font-weight: 600;
}

.sb-x {
  width: 26px;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.sb-body {
  flex: 1 1 auto;
  padding: 12px 14px;
  overflow: auto;
}

.sb-lead {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.6;
}

.sb-lead-2 {
  color: var(--fg-dim);
}

.sb-warn {
  margin: 0 0 10px;
  padding: 8px 10px;
  border: 1px solid var(--danger, #c0392b);
  border-radius: var(--radius, 8px);
  font-size: 12.5px;
  color: var(--danger);
}

.sb-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 8px;
  font-size: 12.5px;
  line-height: 1.5;
  cursor: pointer;
}

.sb-check input {
  margin-top: 2px;
}

.sb-label {
  display: block;
  margin: 12px 0 6px;
  font-size: 12.5px;
  color: var(--fg-dim);
}

.sb-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius, 8px);
  background: var(--bg-3);
  color: var(--fg);
  font-size: 13px;
  outline: none;
}

.sb-input:focus {
  border-color: var(--accent);
}

.sb-textarea {
  font-family: inherit;
  line-height: 1.4;
  resize: vertical;
}

.sb-btn-block {
  display: block;
  width: 100%;
  margin-top: 8px;
}

.sb-hint {
  margin: 8px 0 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--fg-dim);
}

.sb-state {
  margin: 8px 0;
  padding: 12px;
  border: 1px dashed var(--line);
  border-radius: var(--radius, 10px);
  text-align: center;
  font-size: 12.5px;
  color: var(--fg-dim);
}

.sb-state-err {
  border-style: solid;
  border-color: var(--danger);
}

.sb-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  margin: 10px 0;
}

.sb-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius, 8px);
  background: var(--bg-3);
}

.sb-cell-v {
  font-size: 18px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.sb-cell-l {
  font-size: 11px;
  color: var(--fg-dim);
}

.sb-reasons {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--fg-dim);
}

.sb-ok {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: var(--accent);
}

.sb-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--line);
}

.sb-spacer {
  flex: 1 1 auto;
}

.sb-btn {
  padding: 6px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 12.5px;
  cursor: pointer;
}

.sb-btn-sm {
  padding: 3px 9px;
  margin-left: 8px;
  font-size: 11.5px;
}

.sb-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.sb-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.sb-btn-primary {
  border-color: transparent;
  background: var(--accent-btn, var(--accent));
  color: var(--accent-on, #fff);
}

.sb-btn-danger {
  border-color: var(--danger, #c0392b);
  color: var(--danger, #c0392b);
}

.sb-btn-primary:hover:not(:disabled) {
  border-color: transparent;
  color: var(--accent-on, #fff);
  filter: brightness(1.06);
}

@media (max-width: 560px) {
  .sb-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
