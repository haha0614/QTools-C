<!--
  VideoMetaPanel.vue —— 单条视频的「信息」抽屉（评分 / 标签 / 标记）
  职责：编辑策略 full 档按 id 拉 /video/{id}/meta，编辑后 PUT 回写；
        写成功把最新 {rating,tags} 通过 updated 事件交还页面刷新卡片。
  三档（编辑策略 level）：
    off   —— 全部编辑控件禁用，只展示评分 / 标签 / 标记，并提示「仅私有部署可编辑…」；
    local —— 只读写 localStorage（ms.org.<ownerKey>.<videoId>），不发任何请求，标题旁显示「本地」；
    full  —— 走接口（PUT /api/media/video/{id}/meta）。
  约定：不碰播放链路——所有请求 silent + try/catch，失败只 toast 提示，绝不阻塞播放；
        标记新增用「手填 mm:ss + 说明 + 颜色」的最小实现；P4.5 起打开抽屉就按当前内容时间
        自动回填起点（区间再加 1 秒；接近片尾则整段贴到片尾），规则集中在 markFill.js。
-->
<template>
  <!-- 浮层态才有遮罩；停靠态（P5.23 右侧常驻列）由播放器自己管宽度与折叠 -->
  <div v-if="!dock" class="vp-back" @click="emit('close')"></div>
  <aside
    class="vp"
    :class="{ 'is-dock': dock }"
    :role="dock ? 'region' : 'dialog'"
    :aria-modal="dock ? null : 'true'"
    aria-label="视频信息"
    @keydown.esc.stop="emit('close')"
  >
    <header class="vp-head">
      <h2 class="vp-title" :title="video.title">{{ video.title }}</h2>
      <span v-if="isLocal" class="vp-local" title="本地编辑：仅保存在本浏览器，清除缓存即消失">本地</span>
      <!-- P5.24：停靠态不再有「› 收起」按钮 —— 收藏 / 展开的入口只剩播放器贴左边缘那一个
           chevron 开关（两个入口的图标 / 状态天然会走形，故合并为一个）。浮层态保留 × 关闭。 -->
      <button
        v-if="!dock"
        class="vp-x"
        type="button"
        aria-label="关闭信息"
        title="关闭信息"
        @click="emit('close')"
      >
        ×
      </button>
    </header>

    <div class="vp-body">
      <!-- 编辑策略提示：off 只读 / local 只写本机 -->
      <p v-if="readOnly" class="vp-hint vp-policy">{{ HINT_OFF }}</p>
      <p v-else-if="isLocal" class="vp-hint vp-policy">{{ HINT_LOCAL }}</p>

      <div v-if="loading" class="vp-hint">加载中…</div>
      <p v-if="readNote" class="vp-hint vp-note">{{ readNote }}</p>

      <!-- 人物 / 演员（P3-B 只读 → P5.3-B 可编辑）：
           「素人」是**真实人物**（后端把没有真演员的视频都绑给它），按普通人物 chip 渲染，
           形状与真实人物一致、只把主色降为次级色；persons 与 actors 都为空时才用同一个 chip 兜底。
           编辑：与标签同构 —— chips + 「＋ 加演员」打开 PersonPicker，写 PUT /video/{id}/persons。
           P5.4 决定：**抽屉里的 chip 不做跳转**（卡片上的 chip 才跳人物页）。理由：抽屉是编辑面 ——
           评分输入、标记表单（mm:ss + 说明）都可能停在「已输入未保存」的状态，chip 一跳就把整个抽屉
           卸载、未保存输入直接丢；而人物页只隔一次点击（关抽屉 → 点卡片 chip），可发现性不用靠这里补。 -->
      <section class="vp-sec">
        <h3 class="vp-h3">
          人物<span class="vp-h3n">{{ persons.length }}</span>
          <!-- local 档：区块标题旁标「本地」（与标题右侧徽标同义，编辑控件只在本地生效） -->
          <span v-if="isLocal" class="vp-h3-local" :title="HINT_LOCAL">本地</span>
        </h3>
        <div class="vp-persons">
          <span
            v-for="pp in persons"
            :key="pp.id || pp.name"
            class="vp-person"
            :class="{ 'is-auto': isAmateurName(pp.name) }"
            :title="pp.name + (pp.role ? ' · ' + pp.role : '')"
          >
            {{ pp.name }}<i v-if="pp.role" class="vp-person-role">{{ pp.role }}</i>
            <button class="vp-person-x" type="button" :disabled="locked" :aria-label="'移除演员 ' + pp.name" @click="removePerson(pp)">
              ×
            </button>
          </span>
          <!-- 兜底 A：persons 为空但旧 actors 有值 → 先显示真实演员名（只读，来源是旧 facet） -->
          <span
            v-for="a in orphanActorNames"
            :key="'a-' + a"
            class="vp-person is-auto"
            :title="'演员索引（旧字段）· 只读 · ' + a"
            >{{ a }}</span
          >
          <!-- 兜底 B：persons 与 actors 都为空 → 素人（后端就绪后这条只会命中旧索引缓存） -->
          <span v-if="amateurFallback" class="vp-person is-auto" title="未收录演员：默认归类为「素人」">素人</span>
          <button class="vp-add" type="button" :disabled="locked" @click="togglePersonPicker">＋ 加演员</button>
        </div>
        <div v-if="personPickerOpen && !readOnly" class="vp-picker">
          <PersonPicker
            :all-persons="allPersons"
            :selected="persons"
            :loading="personsLoading"
            :level="level"
            :unavailable="personsUnavailable || personNotReady"
            @confirm="applyPersons"
            @close="personPickerOpen = false"
            @created="(p) => emit('person-created', p)"
            @notify="(m) => emit('notify', m)"
          />
        </div>
        <!-- 演员接口未就绪（PUT 404/405/501）：只提示，不抛异常 -->
        <p v-if="personNotReady" class="vp-hint">{{ PERSON_NOT_READY }}</p>
      </section>

      <!-- 工作室（P5-A）：只读，取索引 videos[].studios（名称数组），
           接口未就绪时该字段为空 → 整段不渲染，抽屉其余部分不受影响 -->
      <section v-if="studioNames.length" class="vp-sec">
        <h3 class="vp-h3">
          工作室<span class="vp-h3n">{{ studioNames.length }}</span>
        </h3>
        <div class="vp-studios">
          <span v-for="s in studioNames" :key="s" class="vp-studio" :title="s">{{ s }}</span>
        </div>
      </section>

      <!-- 评分：0–100（P5-C 起值域由 10 扩到 100，0 仍表示未评分）。
           10 颗星每颗 10 分（点第 n 颗 = n×10），滑条 0–100 步进 5：整十用星、精细值用滑条。 -->
      <section class="vp-sec">
        <h3 class="vp-h3">评分</h3>
        <div class="vp-rate">
          <div class="vp-stars" role="group" aria-label="评分（满分 100）">
            <button
              v-for="n in 10"
              :key="n"
              class="vp-star"
              :class="{ on: n * 10 <= rating }"
              type="button"
              :disabled="locked"
              :aria-label="'评分 ' + n * 10 + ' 分（满分 100）'"
              :title="n * 10 + ' 分'"
              @click="setRating(n * 10)"
            >
              ★
            </button>
          </div>
          <span class="vp-rate-val">{{ rating > 0 ? rating + ' 分 / 100' : '未评分' }}</span>
        </div>
        <div class="vp-rate-row">
          <input
            class="vp-slider"
            type="range"
            min="0"
            max="100"
            step="5"
            :value="rating"
            :disabled="locked"
            aria-label="评分滑条（0–100，步进 5）"
            @input="ratingDraft = clampRating($event.target.value)"
            @change="setRating(ratingDraft)"
          />
          <button class="vp-mini" type="button" :disabled="locked || rating === 0" @click="setRating(0)">清除</button>
        </div>
      </section>

      <!-- 标签：chips + 加标签入口 -->
      <section class="vp-sec">
        <h3 class="vp-h3">
          标签<span class="vp-h3n">{{ tags.length }}</span>
        </h3>
        <div class="vp-tags">
          <span v-for="t in tags" :key="t.id || t.name" class="vp-tag" :style="t.color ? { borderColor: t.color } : null">
            <i class="vp-dot" :style="{ background: t.color || 'transparent' }"></i>
            <span class="vp-tag-n" :title="t.name">{{ t.name }}</span>
            <button class="vp-tag-x" type="button" :disabled="locked" :aria-label="'移除标签 ' + t.name" @click="removeTag(t)">
              ×
            </button>
          </span>
          <button class="vp-add" type="button" :disabled="locked" @click="pickerOpen = !pickerOpen">＋ 加标签</button>
        </div>
        <div v-if="pickerOpen && !readOnly" class="vp-picker">
          <TagPicker
            :all-tags="allTags"
            :selected="EMPTY"
            :loading="tagsLoading"
            :level="level"
            @confirm="addTags"
            @close="pickerOpen = false"
            @created="(t) => emit('tag-created', t)"
            @notify="(m) => emit('notify', m)"
          />
        </div>
      </section>

      <!-- 标记：展示 + 删除 + 新增（新增用「mm:ss + 说明 + 颜色」的最小实现） -->
      <section class="vp-sec">
        <h3 class="vp-h3">
          标记<span class="vp-h3n">{{ markers.length }}</span>
        </h3>
        <ul v-if="markers.length" class="vp-marks">
          <li v-for="m in markers" :key="m.id" class="vp-mark">
            <i class="vp-dot" :style="{ background: m.color || 'transparent' }"></i>
            <!-- 标记预览帧：用精灵图按 pos/dur 取格（几何见 spriteCell.js），无精灵图时是占位块 -->
            <SpriteThumb
              :src="spriteSrc"
              :time="Number(m.pos) || 0"
              :dur="markerDur"
              :label="markerRangeText(m, fmtPos) + (m.label ? ' · ' + m.label : '')"
            />
            <!-- P4-B：区间标记显示 pos–endPos，单点仍然只显示 pos（markerRangeText 两种合一） -->
            <span class="vp-mark-pos" :class="{ 'is-range': markerSpan(m).end != null }">{{ markerRangeText(m, fmtPos) }}</span>
            <span class="vp-mark-lab" :title="m.label">{{ m.label || '（无描述）' }}</span>
            <button class="vp-tag-x" type="button" :disabled="locked" aria-label="删除标记" @click="removeMarker(m)">
              ×
            </button>
          </li>
        </ul>
        <div v-else class="vp-hint">暂无标记</div>

        <!-- P5.25（用户反馈 5「标记区域布局应当优化」）：一行七件的横排拆成三行分组 ——
             1) 类型分段控件（单点 / 区间）+ 右侧「＋ 加标记」
             2) 起点 [输入] + 「以当前位置为起点」；区间态再加 终点 [输入] + 「以当前位置为终点」
             3) 颜色 + 标记说明（可空）
             每行 flex + gap 8，容器窄了就整行换行（不会横向溢出）；输入框统一 28px 高。
             行内静态小标题「起点 / 终点」解决「填完值之后两个框长得一样」的分组不清问题。 -->
        <div v-if="!readOnly" class="vp-mark-add">
          <div class="vp-mark-row vp-mark-row-top">
            <!-- P4-B：单点 / 区间二选一 -->
            <span class="vp-mark-mode" role="group" aria-label="标记类型">
              <button
                class="vp-mini"
                type="button"
                :class="{ on: markMode === 'point' }"
                :disabled="locked"
                @click="markMode = 'point'"
              >
                单点
              </button>
              <button
                class="vp-mini"
                type="button"
                :class="{ on: markMode === 'range' }"
                :disabled="locked"
                title="设一段区间：起点 + 终点（都按 mm:ss）"
                @click="markMode = 'range'"
              >
                区间
              </button>
            </span>
            <button class="vp-mini vp-mini-ok vp-mark-addbtn" type="button" :disabled="locked" @click="addMarker">
              ＋ 加标记
            </button>
          </div>

          <div class="vp-mark-row">
            <span class="vp-mark-io">起点</span>
            <input
              v-model="markAt"
              class="vp-mark-mmss"
              type="text"
              inputmode="numeric"
              :placeholder="markMode === 'range' ? '起点 mm:ss' : '当前位置 mm:ss'"
              :disabled="locked"
              :aria-label="markMode === 'range' ? '标记起点 mm:ss' : '标记位置 mm:ss'"
              @input="atTouched = true"
            />
            <button
              class="vp-mini"
              type="button"
              :disabled="locked"
              :title="'把起点设成此刻的播放位置（打开时 ' + atText + '）'"
              @click="fillStartCurrent"
            >
              {{ markMode === 'range' ? '以当前位置为起点' : '取当前时间' }}
            </button>
            <template v-if="markMode === 'range'">
              <span class="vp-mark-io vp-mark-io-end">终点</span>
              <input
                v-model="markEnd"
                class="vp-mark-mmss"
                type="text"
                inputmode="numeric"
                placeholder="终点 mm:ss"
                :disabled="locked"
                aria-label="标记区间终点 mm:ss"
                @input="endTouched = true"
              />
              <button class="vp-mini" type="button" :disabled="locked" title="把终点设成此刻的播放位置" @click="fillEndCurrent">
                以当前位置为终点
              </button>
            </template>
          </div>

          <div class="vp-mark-row">
            <input v-model="markColor" class="vp-mark-color" type="color" :disabled="locked" aria-label="标记颜色" />
            <input
              v-model="markLabel"
              class="vp-mark-label"
              type="text"
              placeholder="标记说明（可空）"
              maxlength="32"
              :disabled="locked"
              aria-label="标记说明"
            />
          </div>
        </div>
      </section>

      <div v-if="saving" class="vp-hint">保存中…</div>
    </div>
  </aside>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useMediaApi } from '@/composables/useMediaApi'
import { HINT_OFF, HINT_LOCAL } from '@/composables/useMediaEditPolicy'
import { readLocalMeta, writeLocalMeta } from '@/composables/useMediaLocalOrg'
import TagPicker from './TagPicker.vue'
// P5.3-B：演员选择器（与 TagPicker 同构：搜索 + 多选 + 现场新建；另带每人角色）
import PersonPicker from './PersonPicker.vue'
// P5.3-B：人物规则（素人 / 真人互斥、提交体组装、兜底判定）—— 唯一实现在 personRules.js
import {
  buildPersonsPayload,
  isAmateur,
  isAmateurName,
  normalizePersons,
  normalizeSelection,
  orphanActors,
  samePersons
} from './personRules'
// P5.3-B：local 档的演员覆盖（ms.orgpersons.<owner>.<videoId>）
import { readLocalPersons, writeLocalPersons } from './personLocal'
// P5.3-B：站端演员接口（PUT /video/{id}/persons、POST /persons）；未就绪只提示
import { PERSON_NOT_READY, errorText, isNotReady, saveVideoPersons } from './personApi'
// P5-C：标记预览帧（精灵图按时间取格，几何唯一实现在 spriteCell.js）
import SpriteThumb from './SpriteThumb.vue'
// P4-B：标记区间（pos–endPos）的归一化与展示文本，与播放器进度条刻度共用同一份逻辑
import { markerRangeText, markerSpan } from './playerExtras'
// P4.5：抽屉打开 / 切换标记类型时「自动回填标记时间」的纯函数（单测见 markFill.js 头部说明）
import { markFillAt } from './markFill'

const props = defineProps({
  /** 当前播放的视频（只需要 id / title，评分与标签兜底取索引里的值） */
  video: { type: Object, required: true },
  /** 标签库 */
  allTags: { type: Array, default: () => [] },
  /** 标签库是否加载中 */
  tagsLoading: { type: Boolean, default: false },
  /** 编辑策略档位：off 只读 / local 只写本地 / full 走接口 */
  level: { type: String, default: 'full' },
  /** 打开抽屉那一刻的播放位置（秒）：「在当前时间加标记」的起点 */
  atSec: { type: Number, default: 0 },
  /** 人物（索引 / 本地覆盖 / 服务端写回 = [{id,name,role}]），含真实「素人」人物 */
  persons: { type: Array, default: () => [] },
  /** 旧「演员」facet 名称数组（索引 videos[].actors）：persons 为空时兜底展示 */
  actors: { type: Array, default: () => [] },
  /** 人物库 [{id,name,alias?,useCount?}]（GET /api/media/persons）：PersonPicker 候选 + 素人 id 来源 */
  allPersons: { type: Array, default: () => [] },
  /** 人物库是否加载中 */
  personsLoading: { type: Boolean, default: false },
  /** 人物库接口未就绪（404/405）：演员区只读并提示 */
  personsUnavailable: { type: Boolean, default: false },
  /** 工作室（索引 videos[].studios = [name]）：只读展示，接口未就绪时为空数组 */
  studios: { type: Array, default: () => [] },
  /** P4-B：取「此刻」的播放位置（页面传 playerRef.getCurrentTime）；缺省回落到 atSec */
  getCurrentSec: { type: Function, default: null },
  /** P4.5：取内容总时长（页面传 playerRef.getDuration）；缺省回落到索引里的 video.dur，都没有即 0 = 未知 */
  getDurSec: { type: Function, default: null },
  /**
   * P5.23：停靠态 —— 内容作为播放页右侧常驻列的内嵌块（不再是 fixed 浮层抽屉）。
   * 只换容器定位与滚动归属，抽屉内部结构（标题 / 元信息 / 评分 / 标签 / 人物 / 工作室 / 标记 / 播放列表）一字不动。
   */
  dock: { type: Boolean, default: false }
})

const emit = defineEmits(['close', 'updated', 'tag-created', 'person-created', 'notify', 'markers'])

const api = useMediaApi()

/** 稳定引用：避免每次渲染新建 [] 触发 TagPicker 的 selected 侦听器 */
const EMPTY = []

const readOnly = computed(() => props.level === 'off')
const isLocal = computed(() => props.level === 'local')
const isFull = computed(() => props.level === 'full')

const loading = ref(true)
const saving = ref(false)
/** 站端只有写接口（GET /video/{id}/meta 仅存在于 /admin/**，匿名访客 401）：读不到就只提示，不阻塞编辑 */
const readNote = ref('')
const pickerOpen = ref(false)
/** 演员选择器开关（P5.3-B；与标签选择器并列，互不影响） */
const personPickerOpen = ref(false)
/** 演员接口未就绪：PUT 返回 404/405/501 后置位 → 只显示「暂只能查看」，不抛异常 */
const personNotReady = ref(false)

/**
 * 人物状态（P5.3-B）：local 档先看本机覆盖（ms.orgpersons.<owner>.<videoId>），
 * 其余用页面传下来的 persons（索引 / 服务端写回）。「素人」是真实人物，不做特殊剔除 ——
 * 素人与真人的互斥由 normalizeSelection（选择器 / 移除 / 保存三处）统一负责。
 */
const personsSeed = isLocal.value ? readLocalPersons(props.video.id) : null
const persons = ref(normalizePersons((personsSeed && personsSeed.persons) || props.persons))

/** 兜底 A：persons 为空但旧 actors 有值 → 先显示真实演员名（只读，来源是旧 facet 字段） */
const orphanActorNames = computed(() => (persons.value.length ? [] : orphanActors([], props.actors)))
/** 兜底 B：persons 与 actors 都为空 → 素人 chip（后端就绪后这条只会命中旧索引缓存） */
const amateurFallback = computed(() => !persons.value.length && isAmateur([], props.actors))

/** 工作室归一化：索引给名称数组，详情接口可能给 [{id,name}]，两种都收并去重 */
const studioNames = computed(() =>
  (props.studios || [])
    .map((s) => (typeof s === 'string' ? s : (s && s.name) || ''))
    .filter((s) => s)
    .filter((s, i, arr) => arr.indexOf(s) === i)
)

/**
 * 标记缩略图数据源：只有索引明确给了 hasSprite 才拼 URL（后端 /media/index 的派生资源标记），
 * 否则传空串 —— SpriteThumb 走占位分支，不发一次必然 404 的请求。
 */
const spriteSrc = computed(() => (props.video && props.video.hasSprite ? api.spriteUrl(props.video.id) : ''))

/** 标记取格用的时长（秒）：优先播放器实时时长 → 索引 dur → 0（未知则固定首帧） */
const markerDur = computed(() => currentDur())

/** off 档不发请求也不允许任何写入：控件统一用 locked 置灰 */
const locked = computed(() => readOnly.value || saving.value)

/* 初始值：local 档先看本地覆盖，其余用索引兜底（接口未就绪时面板仍可展示） */
const seed = isLocal.value ? readLocalMeta(props.video.id) : null
const seedRating = seed && typeof seed.rating === 'number' ? seed.rating : Number(props.video.rating) || 0
const rating = ref(seedRating)
const ratingDraft = ref(seedRating)
const tags = ref(normalizeTags(seed && Array.isArray(seed.tags) ? seed.tags : props.video.tags))
const markers = ref(seed && Array.isArray(seed.markers) ? seed.markers.filter((m) => m && m.id != null) : [])
/**
 * P4.3：当前这份 markers 是否「权威」（可以写进前端按 videoId 的标记缓存）。
 *   - local 档：markers 来自本机 localStorage 组织覆盖，本身就是权威值 → 初始 true；
 *   - full/off 档：初始 false —— 站端没有匿名读元信息的接口，读失败时 markers 只是空种子，
 *     若把这种「读不到」当成「没有标记」写进缓存，就会把播放器已有的刻度擦掉。
 *     只有 applyMeta（读接口成功 / 写接口回读成功）与 saveLocal 之后才置 true。
 */
const markersTrusted = ref(isLocal.value)

/** 新增标记的最小表单：mm:ss + 说明 + 颜色 */
const markAt = ref('')
const markLabel = ref('')
const markColor = ref('#4f9cf9')
/** P4-B：point = 单点（只写 pos）；range = 区间（pos + endPos） */
const markMode = ref('point')
const markEnd = ref('')
/** P4.5：本次打开内用户手改过起点 / 终点就不再自动覆盖（切换标记类型时清零重填） */
const atTouched = ref(false)
const endTouched = ref(false)

const atText = computed(() => fmtPos(props.atSec))

/** 索引里是名称 / [facet, name] 成对数组，接口与本地覆盖里是 {id,name,color}：统一形态 */
function normalizeTags(list) {
  return (list || [])
    .map((t) => {
      if (typeof t === 'string') return { name: t, color: '' }
      if (Array.isArray(t)) return { name: t[1] || t[0], color: '' }
      return { id: t && t.id, name: t && t.name, color: (t && t.color) || '' }
    })
    .filter((t) => t.name)
}

/** 秒 → mm:ss（标记位置） */
function fmtPos(pos) {
  const t = Math.max(0, Math.round(Number(pos) || 0))
  const m = Math.floor(t / 60)
  const s = t % 60
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
}

/**
 * P4.5：秒 → 输入框文本。整秒仍然是 mm:ss（与原格式一致）；
 * 自动回填带小数时补 .t / .tt，避免「底层秒数」在显示时被舍掉（与 DECIMAL(10,2) 对齐）。
 */
function fmtInput(pos) {
  const cs = Math.round(Math.max(0, Number(pos) || 0) * 100)
  const m = Math.floor(cs / 6000)
  const rem = cs - m * 6000
  const ss = Math.floor(rem / 100)
  const hun = rem - ss * 100
  let fs = ''
  if (hun) fs = '.' + (hun < 10 ? '0' + hun : String(hun)).replace(/0$/, '')
  return (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss + fs
}

/** mm:ss → 秒；接受 mm:ss / m:ss / 纯秒数，非法返回 null（P4.5：保留 2 位小数，整数输入结果不变） */
function parsePos(text) {
  const s = String(text == null ? '' : text).trim()
  if (!s) return null
  const r2 = (v) => Math.round(v * 100) / 100
  const parts = s.split(':')
  if (parts.length === 1) {
    const n = Number(parts[0])
    return isFinite(n) && n >= 0 ? r2(n) : null
  }
  if (parts.length !== 2) return null
  const m = Number(parts[0])
  const sec = Number(parts[1])
  if (!isFinite(m) || !isFinite(sec) || m < 0 || sec < 0 || sec >= 60) return null
  return r2(m * 60 + sec)
}

/** 应用（服务端）元信息到本地状态，并把展示所需的最小信息交还页面 */
function applyMeta(body, quiet) {
  if (!body || typeof body !== 'object') return
  rating.value = Number(body.rating) || 0
  ratingDraft.value = rating.value
  tags.value = normalizeTags(body.tags)
  markers.value = Array.isArray(body.markers) ? body.markers.filter((m) => m && m.id != null) : []
  markersTrusted.value = true
  if (!quiet) readNote.value = ''
  emit('updated', { id: props.video.id, rating: rating.value, tags: tags.value })
}

/**
 * 只有 full 档读接口：off 档禁写、local 档不碰网络（本地覆盖已经是最新值）。
 * 读失败（站端没有匿名 GET 元信息接口）时保留索引兜底值，只提示标记不可见。
 */
async function load() {
  loading.value = true
  try {
    const body = await api.getVideoMeta(props.video.id, { silent: true })
    applyMeta(body)
    readNote.value = ''
  } catch {
    readNote.value = '标记需要管理员身份读取，站端暂不展示；评分与标签按索引显示，仍可直接编辑'
  } finally {
    loading.value = false
  }
}

/**
 * full 档写入出口：PUT /api/media/video/{id}/meta
 * 后端返回补丁后的完整元数据（rating / tags / markers），直接当权威值用，不再多打一次读接口。
 */
async function saveServer(patch, optimistic, okMsg) {
  if (saving.value) return
  saving.value = true
  try {
    const body = await api.saveVideoMeta(props.video.id, patch, { silent: true })
    if (optimistic) optimistic()
    if (body && typeof body === 'object' && (body.rating != null || Array.isArray(body.tags))) {
      applyMeta(body)
      readNote.value = ''
    } else {
      emit('updated', { id: props.video.id, rating: rating.value, tags: tags.value })
    }
    emit('notify', okMsg)
  } catch {
    emit('notify', '保存失败：接口未就绪或网络异常')
  } finally {
    saving.value = false
  }
}

/** local 档写入出口：只写 localStorage，不发任何请求 */
function saveLocal(patch, optimistic, okMsg) {
  const merged = writeLocalMeta(props.video.id, patch || {})
  if (optimistic) optimistic()
  rating.value = Number(merged.rating) || 0
  ratingDraft.value = rating.value
  if (Array.isArray(merged.tags)) tags.value = normalizeTags(merged.tags)
  if (Array.isArray(merged.markers)) markers.value = merged.markers
  markersTrusted.value = true
  emit('updated', { id: props.video.id, rating: rating.value, tags: tags.value })
  emit('notify', (okMsg || '已保存') + '（仅本机）')
}

/**
 * 统一写入出口：按档位分流
 * @param {object} patch 服务端 body
 * @param {Function|null} optimistic 本地乐观更新
 * @param {string} okMsg 成功提示
 * @param {object} [localPatch] local 档要落的字段（缺省用 patch）
 */
function save(patch, optimistic, okMsg, localPatch) {
  if (readOnly.value || saving.value) return
  if (isLocal.value) {
    saveLocal(localPatch || patch || {}, optimistic, okMsg)
    return
  }
  saveServer(patch, optimistic, okMsg)
}

/** 评分夹取：值域 0–100（P5-C），顺手吃掉 NaN / 字符串 */
function clampRating(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(100, Math.round(v)))
}

function setRating(n) {
  const v = clampRating(n)
  if (v === rating.value) {
    ratingDraft.value = v
    return
  }
  save(
    { rating: v },
    () => {
      rating.value = v
      ratingDraft.value = v
    },
    v > 0 ? '评分已设为 ' + v + ' 分（满分 100）' : '评分已清除',
    { rating: v }
  )
}

function addTags(ids) {
  if (!ids || !ids.length) return
  pickerOpen.value = false
  const tagById = new Map((props.allTags || []).map((t) => [t.id, t]))
  const added = ids.map((id) => tagById.get(id) || { id, name: String(id), color: '' })
  const next = tags.value.concat(added.filter((t) => !tags.value.some((x) => x.name === t.name)))
  save(
    { addTagIds: ids.slice() },
    () => {
      tags.value = next
    },
    '已加 ' + ids.length + ' 个标签',
    { tags: next }
  )
}

function removeTag(t) {
  if (!t) return
  const rest = tags.value.filter((x) => x !== t && x.name !== t.name)
  if (isLocal.value) {
    save(
      {},
      () => {
        tags.value = rest
      },
      '已移除标签「' + t.name + '」',
      { tags: rest }
    )
    return
  }
  if (!t.id) {
    emit('notify', '该标签来自索引快照，暂无法移除（缺少标签 id）')
    return
  }
  save(
    { removeTagIds: [t.id] },
    () => {
      tags.value = rest
    },
    '已移除标签「' + t.name + '」'
  )
}

/** 服务端 markers 只带它认识的字段；本机临时 id（m- 前缀）不带，交给后端分配 */
function serverMarkers(list) {
  return (list || []).map((m) => {
    const out = { pos: Number(m.pos) || 0, label: m.label || '', color: m.color || '' }
    if (m.id != null && String(m.id).indexOf('m-') !== 0) out.id = m.id
    // P4-B：区间标记才带 endPos（后端的 markers[] 会原样回写；单点标记 body 与旧版完全一致）
    const span = markerSpan(m)
    if (span.end != null) out.endPos = span.end
    return out
  })
}

/** 此刻的播放位置：优先用页面给的实时取值（播放器还在播），拿不到就回落到打开抽屉时的位置 */
function currentSec() {
  try {
    if (typeof props.getCurrentSec === 'function') {
      const v = Number(props.getCurrentSec())
      if (isFinite(v) && v >= 0) return v
    }
  } catch {
    /* 忽略：页面取值方法异常不影响手填 */
  }
  return Number(props.atSec) || 0
}

/** P4.5：内容总时长（秒）；0 = 未知（不做片尾判定，也不夹取） */
function currentDur() {
  try {
    if (typeof props.getDurSec === 'function') {
      const d = Number(props.getDurSec())
      if (isFinite(d) && d >= 0) return d
    }
  } catch {
    /* 忽略：页面取值方法异常时按「时长未知」处理 */
  }
  const fallback = Number(props.video && props.video.dur)
  return isFinite(fallback) && fallback > 0 ? fallback : 0
}

/**
 * P4.5：打开信息抽屉 / 切换标记类型时自动回填标记时间。
 * force=true 无视用户手改（切换「单点 ↔ 区间」走这条）；force=false 只补还没被改过的字段
 * （onMounted 兜一次「元数据晚到才有 duration」的情况）。坐标口径见 markFill.js 头部。
 */
function fillTimeline(force) {
  if (readOnly.value) return
  if (!force && atTouched.value && endTouched.value) return
  const fill = markFillAt(currentSec(), currentDur(), markMode.value)
  if (force || !atTouched.value) {
    markAt.value = fmtInput(fill.pos)
    atTouched.value = false
  }
  if (force || !endTouched.value) {
    markEnd.value = fill.endPos == null ? '' : fmtInput(fill.endPos)
    endTouched.value = false
  }
}

/* 切换「单点 ↔ 区间」→ 按新类型重新回填（sync：保证「先切类型、再精确填」的按钮顺序确定） */
watch(markMode, () => fillTimeline(true), { flush: 'sync' })

/** P4-B：区间标记的「以当前位置为终点」 */
function fillEndCurrent() {
  markMode.value = 'range'
  markEnd.value = fmtInput(currentSec())
  endTouched.value = true
}

/** P4.5：区间标记的「以当前位置为起点」 */
function fillStartCurrent() {
  markAt.value = fmtInput(currentSec())
  atTouched.value = true
}

function addMarker() {
  const pos = parsePos(markAt.value)
  if (pos == null) {
    emit('notify', '标记位置请填 mm:ss')
    return
  }
  // P4-B：区间模式必须先拿到合法终点（严格晚于起点，与播放器 A/B 的判定同源）
  let endPos = null
  if (markMode.value === 'range') {
    const end = parsePos(markEnd.value)
    if (end == null) {
      emit('notify', '区间终点请填 mm:ss，或点「以当前位置为终点」')
      return
    }
    if (markerSpan({ pos, endPos: end }).end == null) {
      emit('notify', '区间终点必须晚于起点')
      return
    }
    endPos = end
  }
  const marker = {
    id: 'm-' + Date.now().toString(36),
    pos,
    label: String(markLabel.value || '').trim().slice(0, 32),
    color: markColor.value || ''
  }
  if (endPos != null) marker.endPos = endPos
  const next = markers.value.concat([marker])
  save(
    { markers: serverMarkers(next) },
    () => {
      markers.value = next
    },
    '已加标记 ' + markerRangeText(marker, fmtPos),
    { markers: next }
  )
  markAt.value = ''
  markLabel.value = ''
  markEnd.value = ''
}

function removeMarker(m) {
  const rest = markers.value.filter((x) => x.id !== m.id)
  save(
    { markers: serverMarkers(rest) },
    () => {
      markers.value = rest
    },
    '已删除标记',
    { markers: rest }
  )
}

/* ------------------------------------------------- 演员编辑（P5.3-B，与标签编辑同构） */

/** 「＋ 加演员」：开 / 关选择器（off 档按钮已 disabled，这里再兜一层） */
function togglePersonPicker() {
  if (readOnly.value) return
  personPickerOpen.value = !personPickerOpen.value
}

/** 交还页面的最小快照：卡片要同时刷新评分 / 标签 / 人物 */
function panelSnapshot() {
  return { id: props.video.id, rating: rating.value, tags: tags.value, persons: persons.value }
}

/**
 * 选择器确认：整份人物集合 + 各自角色。
 * 素人 / 真人互斥在勾选时已做过（PersonPicker），这里再规整一次防御，然后走统一保存出口。
 */
function applyPersons(list) {
  personPickerOpen.value = false
  const norm = normalizeSelection(list, props.allPersons)
  if (norm.removedAmateur) emit('notify', '已自动移除「素人」')
  const n = norm.persons.length
  savePersons(norm.persons, n > 1 ? '已保存演员：' + n + ' 人' : '已保存演员')
}

/** 逐个移除：把最后一位真人也移除时自动回到「素人」（normalizeSelection 补回库里那位素人） */
function removePerson(pp) {
  if (!pp || locked.value) return
  const rest = persons.value.filter((x) => (pp.id != null ? String(x.id) !== String(pp.id) : x.name !== pp.name))
  const norm = normalizeSelection(rest, props.allPersons)
  const backToAmateur = !norm.persons.some((x) => !isAmateurName(x.name))
  savePersons(norm.persons, '已移除「' + pp.name + '」' + (backToAmateur ? '，已回到「素人」' : ''))
}

/**
 * 演员保存出口（提交时机与标签一致：改完立即提交）：
 *   local 档 —— 只写 localStorage（ms.orgpersons.<owner>.<videoId>），不发任何请求；
 *   full 档  —— PUT /api/media/video/{id}/persons body {personIds, roles}；
 *               失败 toast 后端原文并回滚；404/405/501 → 「演员接口未就绪，暂只能查看」。
 */
async function savePersons(next, okMsg) {
  if (readOnly.value || saving.value) return
  const prev = persons.value
  const normalized = normalizePersons(next)
  if (samePersons(prev, normalized)) {
    personPickerOpen.value = false
    return
  }
  if (isLocal.value) {
    writeLocalPersons(props.video.id, normalized)
    persons.value = normalized
    emit('updated', panelSnapshot())
    emit('notify', (okMsg || '已保存演员') + '（仅本机）')
    return
  }
  // full 档：没有可提交的 id（人物库未就绪、还不知道「素人」是谁）就不写，避免把绑定整体清空
  if (!normalized.length) {
    emit('notify', '人物库未就绪（缺少「素人」人物 id），暂不写入')
    return
  }
  saving.value = true
  persons.value = normalized // 乐观更新，失败回滚
  try {
    const body = await saveVideoPersons(props.video.id, buildPersonsPayload(normalized))
    personNotReady.value = false
    // 后端回 {persons:[{personId,name,role}]} 时以它为准（角色可能被后端裁剪）
    const echoed = body && Array.isArray(body.persons) ? normalizePersons(body.persons) : []
    if (echoed.length) persons.value = echoed
    emit('updated', panelSnapshot())
    emit('notify', okMsg || '已保存演员')
  } catch (err) {
    persons.value = prev // 回滚到提交前
    if (isNotReady(err)) {
      personNotReady.value = true
      emit('notify', PERSON_NOT_READY)
    } else {
      emit('notify', '保存演员失败：' + errorText(err))
    }
  } finally {
    saving.value = false
  }
}

/** 页面侧人物被别处改动（服务端写回 / 切换视频）：同值不同步，避免与乐观更新互相覆盖 */
watch(
  () => props.persons,
  (v) => {
    if (saving.value) return
    const next = normalizePersons(v)
    if (samePersons(next, persons.value)) return
    persons.value = next
  }
)

/* P4-B：标记列表的任何变动（读接口 / 本地档 / 增删）都同步给页面，供播放器画进度条刻度；
   immediate 让打开抽屉时就能把已加载的标记推上去，不需要等用户操作。 */
watch(
  markers,
  (list) => {
    // P4.3：第二个参数是「这份列表是否权威」——页面据此决定要不要更新该 videoId 的标记缓存
    emit('markers', Array.isArray(list) ? list.slice() : [], markersTrusted.value)
  },
  { immediate: true }
)

/* P4.5：setup 期先按 props 回填一次（SSR / 首帧就能看到预填值） */
fillTimeline(true)

onMounted(() => {
  // 元数据晚到：duration 打开抽屉时可能还是 0，挂载后按真实时长补/夹一次
  fillTimeline(false)
  if (!isFull.value) {
    loading.value = false
    return
  }
  load()
})
</script>

<style lang="scss" scoped>
.vp-back {
  position: fixed;
  inset: 0;
  /* 播放器是 z-index:100 的全屏层，抽屉与遮罩必须压在其上 */
  z-index: 300;
  background: rgba(0, 0, 0, 0.45);
}

.vp {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 301;
  display: flex;
  flex-direction: column;
  width: 360px;
  max-width: 100%;
  background: var(--bg-2);
  border-left: 1px solid var(--line);
  color: var(--fg);
  font-size: 13px;
}

/* P5.23 停靠态：容器交给播放页右栏（.p-side 负责宽度、边框与纵向滚动），
   这里只把自己从 fixed 浮层降级成普通文档块 —— 内部结构一个字节都不改：
   - position:static → 跟着右栏一起滚，不再自己吸在视口右侧；
   - height:auto + min-height:100% → 内容不足一屏也铺满右栏；
   - 滚动交给右栏（.p-side overflow-y:auto），自身不再造第二个滚动条；
   - 头部 sticky 吸顶：滚到中间时标题与「收起」按钮仍在。 */
.vp.is-dock {
  position: static;
  width: 100%;
  max-width: none;
  height: auto;
  min-height: 100%;
  border-left: 0;
  background: transparent;
  z-index: auto;
}

.vp.is-dock .vp-head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg-2);
}

.vp.is-dock .vp-body {
  overflow: visible;
}

.vp-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}

.vp-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 14.5px;
  font-weight: 600;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.vp-x {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

.vp-x:hover {
  color: var(--fg);
  border-color: var(--line-2);
}

/* P5.24 美化：内容区留白固定为 12px，区组之间统一 10px —— 与下面的卡片式分组配合，
   整栏是「一列等距卡片」，不再是疏密不一的裸段落。 */
.vp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 12px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 浮层态自己滚动 → 同样 6px 细滚动条、默认半透明、hover 加深（停靠态由 .p-side 负责）。
   标准属性只在没有 ::-webkit-scrollbar 的浏览器里生效 —— Chromium 写了它就会忽略 6px 宽度。 */
@supports not selector(::-webkit-scrollbar) {
  .vp-body {
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--fg) 16%, transparent) transparent;
  }

  .vp-body:hover {
    scrollbar-color: color-mix(in srgb, var(--fg) 34%, transparent) transparent;
  }
}

.vp-body::-webkit-scrollbar {
  width: 6px;
}

.vp-body::-webkit-scrollbar-track {
  background: transparent;
}

.vp-body::-webkit-scrollbar-thumb {
  border-radius: 3px;
  background: color-mix(in srgb, var(--fg) 16%, transparent);
}

.vp-body:hover::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--fg) 34%, transparent);
}

/* 卡片式分组：每组一块浅底（--bg，比面板底 --bg-2 更浅/更深，亮暗都成立）+ 圆角 + 内边距 */
.vp-sec {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 11px 11px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg);
}

/* 分区标题（人物 / 工作室 / 评分 / 标签 / 标记）统一：12px / 600 / 行高 1.4，
   与组内内容固定 8px（.vp-sec 的 gap），上下间距由卡片 padding 统一。 */
.vp-h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--fg-dim);
  letter-spacing: 0.03em;
}

/* 计数是胶囊徽标，等宽数字 —— 与标题同一基线与字号档位 */
.vp-h3n {
  flex: 0 0 auto;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--bg-3);
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  text-align: center;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}

.vp-hint {
  font-size: 12.5px;
  color: var(--fg-dim);
}

.vp-err {
  padding: 7px 9px;
  border: 1px solid var(--warn);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--warn) 14%, transparent);
  color: var(--warn);
  font-size: 12.5px;
}

/* 评分：星星靠左、数字右对齐（flex + margin-left:auto + 等宽数字），
   窄栏放不下时整体换行而不是溢出（不产生横向滚动条）。 */
.vp-rate {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}

.vp-stars {
  display: flex;
  gap: 0;
}

.vp-star {
  width: 19px;
  height: 22px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--line-2);
  font-size: 15px;
  line-height: 22px;
  cursor: pointer;
  transition: color 0.15s ease, transform 0.15s ease;
}

.vp-star:hover:not(:disabled) {
  transform: scale(1.12);
}

.vp-star.on {
  color: var(--warn);
}

.vp-star:disabled {
  cursor: default;
  opacity: 0.6;
}

/* 分数贴右：margin-left:auto + 右对齐 + 等宽数字，值变化时宽度不抖 */
.vp-rate-val {
  margin-left: auto;
  text-align: right;
  white-space: nowrap;
  font-size: 12px;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}

/* 滑条与星星同一列宽、同一 28px 控件高，「清除」按钮与滑条垂直居中对齐 */
.vp-rate-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.vp-slider {
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}

/* 按钮统一：高 28px、圆角 8px、hover 提亮边框与文字（填充色只用变量，亮暗都成立） */
.vp-mini {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
}

.vp-mini:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.vp-mini:disabled {
  opacity: 0.45;
  cursor: default;
}

.vp-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.vp-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 2px 4px 2px 7px;
  border: 1px solid var(--line-2);
  border-radius: 999px;
  background: var(--bg-3);
  font-size: 12px;
}

.vp-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border: 1px solid var(--line-2);
  border-radius: 50%;
}

.vp-tag-n {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vp-tag-x {
  flex: 0 0 auto;
  width: 17px;
  height: 17px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--fg-dim);
  font-size: 13px;
  line-height: 17px;
  cursor: pointer;
}

.vp-tag-x:hover {
  color: var(--danger);
}

.vp-tag-x:disabled {
  opacity: 0.4;
  cursor: default;
}

/* 「＋ 加演员 / ＋ 加标签」：与 .vp-mini 同高 28px，保持虚线胶囊的语言 */
.vp-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  padding: 0 10px;
  border: 1px dashed var(--line-2);
  border-radius: 999px;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.vp-add:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.vp-add:disabled {
  opacity: 0.5;
  cursor: default;
}

.vp-picker {
  position: relative;
}

.vp-picker > :deep(.tp) {
  width: 100%;
}

.vp-marks {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

/* 标记条目现在是「卡片里的卡片」：底色上提一档（--bg-3），圆角 8px */
.vp-mark {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 7px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-3);
  transition: border-color 0.15s ease;
}

.vp-mark:hover {
  border-color: var(--line-2);
}

.vp-mark-pos {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--accent);
}

.vp-mark-lab {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 工作室 chips：只读展示，与标签同一套视觉语言但不可移除（没有 × 按钮） */
.vp-studios {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.vp-studio {
  max-width: 100%;
  padding: 1px 8px;
  border: 1px solid var(--line-2);
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 768px) {
  .vp {
    width: 100%;
    border-left: 0;
  }
}
/* local 档徽标：与卡片/BatchBar 同一套虚线主色描边 */
.vp-local {
  flex: 0 0 auto;
  align-self: center;
  padding: 0 6px;
  border: 1px dashed var(--accent);
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--accent);
}

/* 策略提示行：off / local 各一句，紧跟标题下方 */
.vp-policy {
  padding: 6px 9px;
  border: 1px dashed var(--line-2);
  border-radius: var(--radius);
  background: var(--bg-3);
}

/* 站端读不到元信息（没有匿名 GET）时的中性提示 */
.vp-note {
  color: var(--warn);
}

/* 新增标记（P5.25 用户反馈 5）：三行分组 —— 类型+加标记 / 起终点 / 颜色+说明。
   每一行自己 flex-wrap：容器窄了整行换行，横向永不溢出（抽屉 420px 与窄屏浮层都成立）。 */
.vp-mark-add {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 4px;
}

.vp-mark-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* 第一行：分段控件在左、「＋ 加标记」靠右（margin-left:auto 在换行后仍然贴右） */
.vp-mark-row-top {
  justify-content: flex-start;
}

.vp-mark-addbtn {
  margin-left: auto;
}

/* 行内静态小标题（起点 / 终点）：填完值之后两个输入框长得一样，靠它分组 */
.vp-mark-io {
  flex: 0 0 auto;
  color: var(--fg-dim);
  font-size: 11.5px;
  line-height: 1;
  white-space: nowrap;
}

.vp-mark-io-end {
  margin-left: 2px;
}

/* 新增标记的输入框与按钮同一 28px 控件高（一行里不再有 24/26/28 三种高度） */
.vp-mark-mmss {
  width: 68px;
  height: 28px;
  padding: 0 6px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-3);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.vp-mark-label {
  flex: 1 1 90px;
  min-width: 0;
  height: 28px;
  padding: 0 6px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-3);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
}

.vp-mark-color {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-3);
  cursor: pointer;
}

.vp-mark-mmss:focus,
.vp-mark-label:focus {
  outline: none;
  border-color: var(--accent);
}

.vp-mini-ok {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.vp-mark-add :disabled {
  opacity: 0.45;
  cursor: default;
}

/* 人物 chips（P3-B）：与标签 chips 同一套语言，但只读（人物关系在媒体库里维护） */
.vp-persons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.vp-person {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 2px 4px 2px 9px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: var(--accent-soft);
  font-size: 12px;
  color: var(--accent);
}

/* 素人 / 旧演员兜底 chip：与真实人物 chip 同形，只把主色降为次级色（不是空占位视觉） */
.vp-person.is-auto {
  border-color: var(--line-2);
  background: transparent;
  color: var(--fg-dim);
}

.vp-person-role {
  font-style: normal;
  margin-left: 4px;
  opacity: 0.75;
}

/* 移除演员的 ×：与标签 × 同一套尺寸 / hover 语义 */
.vp-person-x {
  flex: 0 0 auto;
  width: 17px;
  height: 17px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font-size: 13px;
  line-height: 17px;
  opacity: 0.75;
  cursor: pointer;
}

.vp-person-x:hover {
  color: var(--danger);
  opacity: 1;
}

.vp-person-x:disabled {
  opacity: 0.4;
  cursor: default;
}

/* 区块标题旁的「本地」标记（local 档）：间距由 .vp-h3 的 gap 统一给 */
.vp-h3-local {
  padding: 0 5px;
  border: 1px dashed var(--accent);
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 400;
  line-height: 1.6;
  color: var(--accent);
}

/* ============================ P4-B 标记区间（单点 / 区间切换） ============================
   P5.25 修复（用户反馈 4「选中区间时按钮左边框消失」）：
   旧实现用 `border-left: none` 去重相邻描边 —— 那条边是**删掉**的，第二个按钮一旦选中就不再有左边框，
   同时它的 border-color 变强调色、与第一个按钮的右描边错位，看起来就是「边框塌陷」。
   改法：两条边都保留，第二个按钮 `margin-left: -1px` 与第一个的右描边重叠（去重靠重叠，不靠删边），
   选中态再盖一层 inset 环形描边 + z-index: 1 —— 四个边（含左右两条）在任何状态下都完整可见。 */
.vp-mark-mode {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 0;
}

/* 两个紧邻按钮拼成一组：左圆右角，中间描边重叠 1px */
.vp-mark-mode .vp-mini:first-child {
  border-radius: 999px 0 0 999px;
}

.vp-mark-mode .vp-mini:last-child {
  margin-left: -1px;
  border-radius: 0 999px 999px 0;
}

/* 选中态：颜色 + inset 环 + 抬到兄弟之上（边框不会被相邻按钮的描边遮住） */
.vp-mark-mode .vp-mini.on {
  position: relative;
  z-index: 1;
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px var(--accent);
}

/* 三态之二：未选中 hover（.vp-mini:hover 的全局规则会铺满底色，这里只提亮描边与文字） */
.vp-mark-mode .vp-mini:hover:not(:disabled):not(.on) {
  background: transparent;
  border-color: color-mix(in srgb, var(--accent) 60%, var(--line));
  color: var(--accent);
}

/* 三态之三：禁用（.vp-mini:disabled 已给 opacity，这里补上「不变的描边」以免看起来还是可点的强调色） */
.vp-mark-mode .vp-mini:disabled {
  border-color: var(--line);
  color: var(--fg-dim);
}

.vp-mark-mode .vp-mini:focus-visible {
  position: relative;
  z-index: 2;
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

/* P5.25：区间输入框左侧加一档内缩，与「终点」小标题同一行的呼吸感 */
.vp-mark-row .vp-mark-mmss,
.vp-mark-row .vp-mark-label {
  min-width: 0;
}

/* 区间标记的位置文案比单点宽（01:20–02:10），用等宽数字撑住对齐 */
.vp-mark-pos.is-range {
  min-width: 92px;
  font-variant-numeric: tabular-nums;
}

</style>
