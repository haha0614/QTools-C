<!--
  VideoPage.vue —— 媒体站「视频库」页面（Vue 3 重写）
  来源：public/media/index.html + app.js（1731 行）+ app.css 的行为等价实现；路由由 router/index.js 统一接线。
  分层：本文件持有筛选 / 排序 / URL hash / 收藏 / 最近观看 / 埋点与播放器会话边界；
        播放层在 video/MediaPlayer.vue，筛选抽屉内容（分类 + facet 组）、快捷筛选、卡片、最近观看拆成 video/*.vue 子组件。
  布局：外壳（src/layouts/AppShell.vue）给媒体路由 meta.bleed（取消左右 padding），本页贴边全宽流式；
        筛选不再占用常驻左栏，改为右侧 320px 抽屉（桌面与移动共用），不再与外壳左导航争位。
  复用：src/composables/useMediaApi.js（接口 + 资源 URL）、useMediaTrack.js（埋点单例）、
        src/views/media/mediaTheme.scss（--bg/--fg/… → --qt-*，亮暗自动跟随）。
-->
<template>
  <div class="ms-page">
    <div class="app">
      <header class="toolbar">
        <div class="tb-row tb-top">
          <input
            ref="searchEl"
            class="search"
            type="search"
            placeholder="搜索标题 / 标签 / 演员…"
            autocomplete="off"
            spellcheck="false"
            :value="searchInput"
            @input="onSearchInput"
            @compositionstart="onCompositionStart"
            @compositionend="onCompositionEnd"
            @keydown="onSearchKeydown"
          />
          <span class="count">{{ countText }}</span>
          <select class="select" aria-label="排序" :value="state.sort" @change="onSortChange">
            <option v-for="s in SORTS" :key="s.key" :value="s.key">{{ s.label }}</option>
          </select>
          <button class="btn-ghost" type="button" @click="clearAll">清空</button>
          <!-- 播放列表（P5-B）：把「正在播放的这一部」或「已选中的若干部」加入某个播放列表 -->
          <button
            class="icon-btn pl-add-btn"
            type="button"
            :disabled="readOnlyEdit"
            :title="playlistAddTitle"
            @click="openPlaylistPicker"
          >
            加入播放列表
          </button>
          <!-- P5.55 批量生成简介：点一下**只打开两步确认弹窗**，不在这一步动任何数据。
               两步确认里再选「包括已有内容」（默认不勾 = 只补空）并敲「确认」。 -->
          <button
            class="icon-btn syn-batch-btn"
            type="button"
            data-syn-batch
            :disabled="readOnlyEdit"
            :title="synopsisBatchTitle"
            @click="openSynopsisBatch"
          >
            {{ synopsisRunning ? '生成中…' : '⚡ 批量生成简介' }}
          </button>
          <!-- P5.55 撤销入口：常驻。后端任务是内存态（重启即丢），所以这里既能精确回滚，
               也能退化成「按 ids 清空简介」——两条路都在同一个弹窗里二次确认。 -->
          <button
            class="icon-btn syn-undo-btn"
            type="button"
            data-syn-undo
            :disabled="readOnlyEdit"
            title="撤销上一次批量生成（有旧值快照则精确回滚，否则按 ids 清空）"
            @click="openSynopsisUndo"
          >
            撤销上次批量
          </button>
          <button
            class="icon-btn sel-btn"
            type="button"
            :aria-pressed="selectMode ? 'true' : 'false'"
            :disabled="!canEdit"
            :title="selectTitle"
            @click="toggleSelectMode"
          >
            {{ selectMode ? '完成' : '选择' }}
          </button>
          <!-- 编辑策略常驻提示：off 档说清「为什么不能编辑」，local 档说清「只在本浏览器」 -->
          <span v-if="readOnlyEdit" class="policy-hint" :title="HINT_OFF">{{ HINT_OFF }}</span>
          <span v-else-if="isLocal" class="policy-hint policy-hint-local" :title="HINT_LOCAL">本地编辑（清缓存即丢）</span>
          <button
            ref="filterBtnEl"
            class="icon-btn filter-toggle"
            type="button"
            aria-haspopup="dialog"
            :aria-expanded="drawerOpen ? 'true' : 'false'"
            @click="onFilterToggle"
          >
            筛选<span class="ft-caret" aria-hidden="true">▾</span><b v-if="filterBadgeCount">{{ filterBadgeCount }}</b>
          </button>
          <button
            class="icon-btn cols-btn"
            type="button"
            :aria-pressed="cols3 ? 'true' : 'false'"
            :title="cols3 ? '切换到 2 列' : '切换到 3 列'"
            @click="toggleCols"
          >
            ▦
          </button>
        </div>

        <!-- 选择模式：已选计数 + 批量操作条（吸顶在工具栏内，滚动时始终可见） -->
        <div v-if="selectMode" class="tb-row tb-batch">
          <BatchBar
            :count="selectedIds.length"
            :all-tags="allTags"
            :tags-loading="tagsLoading"
            :busy="batchBusy"
            :level="editLevel"
            :local-count="localEditedCount"
            @select-all="selectAllVisible"
            @clear="clearSelection"
            @exit="exitSelectMode"
            @clear-local="onClearLocal"
            @add-tags="(ids) => applyBatchMeta({ addTagIds: ids }, '已加标签')"
            @remove-tags="(ids) => applyBatchMeta({ removeTagIds: ids }, '已移除标签')"
            @rating="(n) => applyBatchMeta({ rating: n }, n > 0 ? '评分已设为 ' + n + ' 分（满分 100）' : '评分已清除')"
            @created="onTagCreated"
            @notify="showToast"
          />
        </div>

        <!-- 筛选维度（P5.46）：播放列表与时长 / 分辨率 / 体积同一行（同一「筛选条」区域） -->
        <!-- 批量简介任务进度：处理中途也能看到「已处理 N/共 M」，完成后可关闭 -->
        <div v-if="synopsisBatchText" class="tb-row tb-syn-batch">
          <span class="syn-batch-progress" data-syn-batch-progress>{{ synopsisBatchText }}</span>
          <!-- P5.55：运行中给「停止」；已结束给「成果」回看 -->
          <button
            v-if="!synopsisBatchFinished"
            class="chip syn-batch-stop"
            type="button"
            data-syn-batch-stop-inline
            :disabled="synopsisStopping"
            :title="synopsisStopping ? '正在停止：等当前这条生成完' : '停止批量生成（正在生成的这条会跑完）'"
            @click="stopSynopsisBatch"
          >
            {{ synopsisStopping ? '正在停止…' : '停止' }}
          </button>
          <button v-else class="chip" type="button" data-syn-batch-summary-inline @click="openSynopsisSummary">
            成果
          </button>
          <button v-if="synopsisBatchFinished" class="chip chip-x" type="button" @click="clearSynopsisBatch">
            关闭<span class="x">×</span>
          </button>
        </div>

        <div v-if="!isMobile" class="tb-row tb-filters">
          <PlaylistFilter
            ref="plFilterRef"
            :lists="plList"
            :current="String(state.pl || '')"
            :loading="plListLoading"
            :unavailable="plListUnavailable"
            :total="videos.length"
            @select="applyPlaylistFilter"
            @manage="openPlaylistManage"
            @create="openPlaylistCreate"
          />
          <span
            v-if="plFilterOn"
            class="pl-order-note"
            title="已按播放列表筛选：网格顺序 = 列表顺序，排序下拉此时不生效"
            >按列表顺序</span
          >
          <QuickFilters
            :groups="quickGroups"
            :selected="state"
            :unsafe="state.unsafe"
            @toggle="onToggleQuick"
            @toggle-unsafe="state.unsafe = !state.unsafe"
          />
          <!-- P5.99：内容分级筛选。只有 ≥2 个可见分级时才出现（后端 ratings[] 已按访客筛过） -->
          <RatingFilter
            v-if="showRatingFilter"
            :options="ratingOptions"
            :selected="state.ratings"
            @toggle="onToggleRating"
          />
        </div>

        <div v-if="activeEntries.length" class="chips chips-sm active-chips">
          <button
            v-for="(x, i) in activeEntries"
            :key="i"
            class="chip chip-x"
            type="button"
            @click="removeActive(x)"
          >
            {{ x.label }}<span class="x">×</span>
          </button>
        </div>

        <!-- 播放列表上下文：URL 带 ?playlist=<id> 时，播放器的上一个/下一个按该列表顺序走 -->
        <div v-if="playlistCtx && !plFilterOn" class="chips chips-sm playlist-mode">
          <span class="pl-tag" :title="playlistCtx.name">
            播放列表：{{ playlistCtx.name }}（{{ playlistCtx.ids.length }} 个 · 按列表顺序）
          </span>
          <button class="chip chip-x" type="button" @click="exitPlaylistMode">退出<span class="x">×</span></button>
        </div>
      </header>

      <main class="main">
        <RecentStrip
          v-if="recentItems.length && !recentClosed"
          :items="recentItems"
          @open="openFromGrid"
          @close="closeRecent"
        />

        <div class="grid" :class="{ 'cols-3': cols3 }">
          <VideoCard
            v-for="v in visibleVideos"
            :key="v.id"
            :video="v"
            :pos="posMap[v.id] || 0"
            :fav="isFavVideo(v.id)"
            :select-mode="selectMode"
            :selected="selectedSet.has(v.id)"
            :rating="cardMeta(v).rating"
            :tags="cardMeta(v).tags"
            :local="!!cardMeta(v).local"
            :persons="cardPersons(v)"
            :actors="v.actors || EMPTY_LIST"
            :studios="v.studios || []"
            :playlist-btn="true"
            :level="editLevel"
            @open="openFromGrid"
            @person="openPerson"
            @toggle-fav="toggleFav"
            @select="onCardSelect"
            @added="onPlaylistAdded"
            @notify="showToast"
          />
          <div ref="sentinelEl" class="grid-sentinel"></div>
        </div>

        <!-- P5.95：未登录访客的库被「仅登录可见」清空时，给专门空态（文案 + 登录 + 刷新），
             而不是「没有符合条件的视频」这种会让人以为数据没了的普通空态 -->
        <GuestHiddenEmpty v-if="!view.length && guestHidden" @refresh="reloadForAuth" />
        <div v-else-if="!view.length" class="empty">{{ emptyText }}</div>
      </main>
    </div>

    <!-- 右侧筛选抽屉：桌面与移动共用一套（≤768px 占满全宽） -->
    <div class="drawer-backdrop" :class="{ show: drawerOpen }" aria-hidden="true" @click="closeDrawer"></div>
    <aside
      ref="drawerEl"
      class="filter-drawer"
      :class="{ open: drawerOpen }"
      role="dialog"
      aria-modal="true"
      aria-label="筛选"
      :aria-hidden="drawerOpen ? 'false' : 'true'"
      @keydown="onDrawerKeydown"
    >
      <header class="drawer-head">
        <h2>筛选</h2>
        <button class="drawer-close" type="button" aria-label="关闭筛选" @click="closeDrawer">×</button>
      </header>

      <FilterSidebar
        ref="sidebarRef"
        :cat-names="catNames"
        :cat-counts="catCounts"
        :groups="facetGroupsView"
        :selected-cats="state.cats"
        :selected-facets="state.facets"
        :studios="studioItems"
        :selected-studios="state.studios"
        :studios-hint="studiosHint"
        @toggle-cat="onToggleCat"
        @toggle-facet="onFacetToggle"
        @toggle-studio="onStudioToggle"
      >
        <template #quick>
          <div v-if="isMobile" class="quick-head">
            <h2>快捷筛选</h2>
          </div>
          <div v-if="isMobile" class="quick-body">
            <!-- 移动端：快捷筛选在抽屉里，播放列表维度同区（与桌面同一条筛选条的口径） -->
            <PlaylistFilter
              ref="plFilterDrawerRef"
              :lists="plList"
              :current="String(state.pl || '')"
              :loading="plListLoading"
              :unavailable="plListUnavailable"
              :total="videos.length"
              @select="applyPlaylistFilter"
              @manage="openPlaylistManage"
              @create="openPlaylistCreate"
            />
            <span
              v-if="plFilterOn"
              class="pl-order-note"
              title="已按播放列表筛选：网格顺序 = 列表顺序，排序下拉此时不生效"
              >按列表顺序</span
            >
            <QuickFilters
              :groups="quickGroups"
              :selected="state"
              :unsafe="state.unsafe"
              @toggle="onToggleQuick"
              @toggle-unsafe="state.unsafe = !state.unsafe"
            />
            <!-- P5.99：移动端同一份分级筛选（与桌面同一条筛选条的口径） -->
            <RatingFilter
              v-if="showRatingFilter"
              :options="ratingOptions"
              :selected="state.ratings"
              @toggle="onToggleRating"
            />
          </div>
        </template>
      </FilterSidebar>

      <SavedFilters
        :items="savedFilters"
        :loading="savedLoading"
        :error="savedUnavailable"
        :suggest-name="suggestSavedName"
        @apply="onApplySavedFilter"
        @save="onSaveFilter"
        @remove="onDeleteSavedFilter"
      />

      <footer class="drawer-foot">
        <button class="btn-ghost" type="button" @click="clearAll">清空全部筛选</button>
        <button class="btn-primary" type="button" @click="closeDrawer">查看 {{ view.length }} 个结果</button>
      </footer>
    </aside>

    <MediaPlayer
      v-if="curVideo"
      ref="playerRef"
      :video="curVideo"
      :start-pos="startPos"
      :open-seq="openSeq"
      :has-prev="navState.hasPrev"
      :has-next="navState.hasNext"
      :quality="quality"
      :tracker="tracker"
      :markers="playerMarkers"
      @close="closePlayer"
      @prev="step(-1)"
      @next="step(1)"
      @update:quality="onQualityChange"
      @save-pos="onSavePos"
      @clear-pos="onClearPos"
      @push-recent="onPushRecent"
      @open-meta="openMeta"
    >
      <!-- P5.23：信息抽屉改为播放页右侧**常驻**列（原抽屉内容与事件一字不动，只换容器）。
           桌面与视频同一行 flex（不覆盖视频）；<1200px 由播放器切成浮层。
           展开 / 折叠由播放器持有（含 localStorage），这里只在「展开」时预热标签 / 人物库。 -->
      <template #side>
        <VideoMetaPanel
          :key="curVideo.id + '#' + openSeq"
          :video="curVideo"
          dock
          :fav="curFav"
          @toggle-fav="toggleFav(curVideo)"
          :all-tags="allTags"
          :tags-loading="tagsLoading"
          :level="editLevel"
          :at-sec="metaAtSec"
          :get-current-sec="currentPlaySec"
          :get-dur-sec="currentPlayDur"
          :persons="(curVideo && cardPersons(curVideo)) || EMPTY_LIST"
          :actors="(curVideo && curVideo.actors) || EMPTY_LIST"
          :studios="(curVideo && curVideo.studios) || []"
          :all-persons="personList || EMPTY_LIST"
          :persons-loading="personsLoading"
          :persons-unavailable="personsUnavailable"
          :context="ctxView"
          @pick="playFromContext"
          @close="closeMeta"
          @updated="onMetaUpdated"
          @markers="onMetaMarkers"
          @tag-created="onTagCreated"
          @person-created="onPersonCreated"
          @notify="showToast"
        />
      </template>
    </MediaPlayer>

    <!-- 加入播放列表（P5-B）：选择已有列表或新建，写入失败只提示，不影响库与播放 -->
    <PlaylistPicker
      :open="playlistPickerOpen"
      :video-ids="playlistTargetIds"
      :level="editLevel"
      @close="playlistPickerOpen = false"
      @added="onPlaylistAdded"
      @notify="showToast"
    />

    <!-- 管理播放列表（P5.46）：改名 / 删除 / 拖拽排序 / 复制列表名 —— 原独占页的能力搬进弹层 -->
    <PlaylistManageDialog
      :open="plManageOpen"
      :lists="plList"
      :videos="videos"
      :initial-id="String(state.pl || '')"
      :create-mode="plManageCreate"
      :level="editLevel"
      @close="plManageOpen = false"
      @select="applyPlaylistFilter"
      @changed="onPlaylistDataChanged"
      @notify="showToast"
    />

    <!-- P5.55 批量生成简介：两步确认 / 进度+停止 / 成果汇总 / 撤销 -->
    <SynopsisBatchDialog
      :open="synopsisDialogOpen"
      :phase="synopsisPhase"
      :target="synopsisTarget"
      :preview="synopsisPreview"
      :preview-loading="synopsisPreviewLoading"
      :preview-error="synopsisPreviewError"
      :mode="synopsisMode"
      :job="synopsisBatchJob"
      :busy="synopsisBatchBusy"
      :stopping="synopsisStopping"
      :undo-count="synopsisUndoCount"
      :undo-ids-text="synopsisUndoIds"
      :undo-preview="synopsisUndoPreview"
      :undo-busy="synopsisUndoBusy"
      :undo-done="synopsisUndoDone"
      :can-rollback="synopsisCanRollback"
      @close="closeSynopsisDialog"
      @start="startSynopsisBatch"
      @stop="stopSynopsisBatch"
      @retry-preview="loadSynopsisPreview"
      @undo-open="openSynopsisUndo"
      @undo-ids="(v) => (synopsisUndoIds = v)"
      @undo-preview="previewSynopsisUndo"
      @undo-rollback="rollbackSynopsisBatch"
      @undo-confirm="clearSynopsisBatchIds"
    />

    <!-- 页面级轻提示：批量结果 / 接口未就绪都在这里反馈（与播放列表页同一套组件） -->
    <PageToast :toasts="toasts" />
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMediaApi } from '@/composables/useMediaApi'
import { useMediaTrack } from '@/composables/useMediaTrack'
import { useAppAuth } from '@/composables/useAppAuth'
// P5.95：未登录 + 索引里一条内容都没有 → 专门的「可能被站长关了未登录可见」空态（判定纯函数在 guestHidden.js）
import GuestHiddenEmpty from './GuestHiddenEmpty.vue'
import { isGuestHiddenEmpty } from './guestHidden.js'
import { useMediaEditPolicy, LEVEL_OFF, HINT_OFF, HINT_LOCAL } from '@/composables/useMediaEditPolicy'
import {
  localOrgVersion,
  readLocalMeta,
  listLocalIds,
  readLocalTags,
  writeLocalMeta,
  clearLocalOrg,
  mergeCardMeta
} from '@/composables/useMediaLocalOrg'
// P5.3-B：local 档的演员覆盖（卡片人物行 / 「清除本地修改」共用）
import { clearAllLocalPersons, readLocalPersons } from './video/personLocal'
/* P5.38：local 档的「作品简介」本机覆盖（ms.orgsynopsis.*），与上面两族本地键一起清 */
import { clearAllLocalSynopsis } from './video/synopsisLocal'
// P4.3：标记按 videoId 的前端缓存（站端没有匿名读 meta 的接口时的替代方案）
import { readMarkerCache, writeMarkerCache } from '@/composables/useMarkerCache'
import FilterSidebar from './video/FilterSidebar.vue'
import RatingFilter from './RatingFilter.vue'
import { matchesRating, showRatingFilter as showRatingFilterOf, ratingLabel as ratingLabelOf } from './contentRating.js'
import SavedFilters from './video/SavedFilters.vue'
import QuickFilters from './video/QuickFilters.vue'
import VideoCard from './video/VideoCard.vue'
import RecentStrip from './video/RecentStrip.vue'
import MediaPlayer from './video/MediaPlayer.vue'
import BatchBar from './video/BatchBar.vue'
import {
  batchActive,
  batchFinished,
  batchProgressText,
  batchSummary,
  clearLastBatch,
  errorText,
  readLastBatch,
  resolveMode,
  rollbackText,
  saveLastBatch
} from './video/synopsisGenerate'
// P5.55：批量生成的安全壳（两步确认 / 停止 / 成果汇总 / 撤销）
import SynopsisBatchDialog from './video/SynopsisBatchDialog.vue'
import VideoMetaPanel from './video/VideoMetaPanel.vue'
// P5-B：加入播放列表弹层 + 播放列表顺序纯逻辑（归一化 / 保序重排 / 上一部下一部）
import PlaylistPicker from './video/PlaylistPicker.vue'
// P5.46：播放列表降级成「筛选维度」—— 筛选条下拉 + 管理弹层（原独占页取消）
import PlaylistFilter from './video/PlaylistFilter.vue'
import PlaylistManageDialog from './video/PlaylistManageDialog.vue'
import PageToast from './PageToast.vue'
import { usePageToast } from './usePageToast.js'
import { normalizePlaylistDetail, normalizePlaylistList, orderByPlaylistIds } from './video/playlistOrder'
// P5.32：播放上下文（从哪个列表点进来就按那个顺序上/下一部 + 信息栏置顶分区）
// P5.35：来源驱动 —— 多了 person / tag 两档来源，标题与顺序都由来源页给
import {
  CTX_BROWSE,
  CTX_LIBRARY,
  CTX_PERSON,
  CTX_PLAYLIST,
  CTX_RECENT,
  CTX_TAG,
  contextLabel,
  contextRows,
  filterSourceName,
  makePlaybackContext,
  navFromContext,
  pickPlaybackContext,
  readContextSnapshot,
  stepContextId
} from './video/playbackContext'

const api = useMediaApi()
const tk = useMediaTrack()
/** 站级登录态（P5.95）：专门空态只在「未登录」时出现，登录后立刻退回普通空态 */
const auth = useAppAuth()
/** 索引 stats（P5.95）：唯一的用途是判断「库对这个访客是不是真的空」 */
const indexStats = ref(null)
/** 索引接口这次是否成功（P5.95）：失败走既有错误文案，绝不用「站长关了可见」解释一次请求失败 */
const indexOk = ref(false)

/* =========================================================================
   常量与纯函数区（逐条对齐 app.js，Node 下可直接单测）
   ========================================================================= */

const MB = 1048576
const GB = 1073741824

const DUR_BUCKETS = [
  { key: 'lt1', label: '<1 分', max: 60 },
  { key: '1-5', label: '1-5 分', max: 300 },
  { key: '5-15', label: '5-15 分', max: 900 },
  { key: '15-60', label: '15-60 分', max: 3600 },
  { key: 'gt60', label: '>60 分', max: Infinity }
]

/** 互斥档位：≥4K / 2K / 1080p / 720p / 更低（按 w 判定，五档之和 = 全库） */
const RES_TIERS = [
  { key: '4k', label: '≥4K', min: 3840 },
  { key: '2k', label: '2K', min: 2560 },
  { key: '1080', label: '1080p', min: 1920 },
  { key: '720', label: '720p', min: 1280 },
  { key: 'low', label: '更低', min: 0 }
]

const SIZE_BUCKETS = [
  { key: 'lt100m', label: '<100MB', max: 100 * MB },
  { key: '100m-1g', label: '100MB-1GB', max: GB },
  { key: 'gt1g', label: '>1GB', max: Infinity }
]

const SORTS = [
  { key: 'added', label: '添加序（默认）' },
  { key: 'name', label: '名称 A→Z' },
  { key: 'name-desc', label: '标题 Z→A' },
  { key: 'dur-desc', label: '时长 ↓' },
  { key: 'dur-asc', label: '时长 ↑' },
  { key: 'size-desc', label: '体积 ↓' },
  { key: 'size-asc', label: '体积 ↑' },
  { key: 'res-desc', label: '分辨率 高→低' },
  { key: 'res-asc', label: '分辨率 低→高' },
  { key: 'recent', label: '最近观看' },
  { key: 'progress', label: '有进度优先' },
  { key: 'random', label: '🎲 随机排序' }
]
const SORT_RANDOM = 'random'
/** 刷新时随机挑排序的候选：随机本身排除（否则无法「刷新后保持」） */
const SORT_POOL = SORTS.filter((s) => s.key !== SORT_RANDOM).map((s) => s.key)

const KEY_POS = 'ms.pos.'
const KEY_RECENT = 'ms.recent'
const KEY_RECENT_CLOSED = 'ms.recentClosed'
const KEY_COLS = 'ms.cols'
const KEY_SCROLL = 'ms.scroll'
const KEY_Q = 'ms.q'

/** 分块渲染步长：176 张卡片一次全渲染会拖慢首屏（原页全量渲染，这里改分块 + 懒加载封面） */
const CHUNK = 48

function durBucketOf(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return null
  for (const b of DUR_BUCKETS) if (sec < b.max) return b.key
  return 'gt60'
}

function resTierOf(w) {
  if (w == null || !isFinite(w) || w <= 0) return null
  for (const t of RES_TIERS) if (w >= t.min) return t.key
  return 'low'
}

function sizeBucketOf(bytes) {
  if (bytes == null || !isFinite(bytes) || bytes < 0) return null
  for (const b of SIZE_BUCKETS) if (bytes < b.max) return b.key
  return 'gt1g'
}

function resBadge(w) {
  if (!w) return ''
  if (w >= 3840) return '4K'
  if (w >= 2560) return '2K'
  if (w >= 1920) return '1080p'
  if (w >= 1280) return '720p'
  return w + 'w'
}

function matchesSearch(v, q) {
  const needle = String(q == null ? '' : q).trim().toLowerCase()
  if (!needle) return true
  if (v.title && String(v.title).toLowerCase().indexOf(needle) >= 0) return true
  for (const t of v.tags || []) {
    if (t && t[1] != null && String(t[1]).toLowerCase().indexOf(needle) >= 0) return true
  }
  for (const a of v.actors || []) {
    if (a != null && String(a).toLowerCase().indexOf(needle) >= 0) return true
  }
  return false
}

/** 同 facet 内多值为「或」，跨 facet 为「与」 */
function matchesFacets(v, facets) {
  const keys = Object.keys(facets || {})
  for (const f of keys) {
    const names = facets[f]
    if (!names || !names.length) continue
    if (f === '演员') {
      const own = v.actors || []
      let hit = false
      for (const a of own) {
        if (names.indexOf(a) >= 0) {
          hit = true
          break
        }
      }
      if (!hit) return false
    } else if (f === '人物') {
      // 人物（P3-B）：优先匹配索引里的 persons（[{id,name,role}]）；
      // 索引尚未产出该字段时（后端 P3-A 未就绪）回落到旧的 tags facet，筛选行为与改动前一致。
      let hit = false
      for (const p of v.persons || []) {
        const nm = typeof p === 'string' ? p : p && p.name
        if (nm != null && names.indexOf(String(nm)) >= 0) {
          hit = true
          break
        }
      }
      if (!hit) {
        for (const t of v.tags || []) {
          if (t && t[0] === '人物' && names.indexOf(t[1]) >= 0) {
            hit = true
            break
          }
        }
      }
      if (!hit) return false
    } else {
      let hit = false
      for (const t of v.tags || []) {
        if (t && t[0] === f && names.indexOf(t[1]) >= 0) {
          hit = true
          break
        }
      }
      if (!hit) return false
    }
  }
  return true
}

/** 其余筛选（分类 / 时长 / 清晰度 / 体积 / 搜索）同为「与」 */
function filterVideos(videos, st) {
  const s = st || {}
  const cats = s.cats && s.cats.length ? s.cats : null
  const durs = s.durs && s.durs.length ? s.durs : null
  const ress = s.ress && s.ress.length ? s.ress : null
  const sizes = s.sizes && s.sizes.length ? s.sizes : null
  const studios = s.studios && s.studios.length ? s.studios : null
  // 内容分级（P5.99）：同组内「或」，与其它条件「与」；条目没有 contentRating 时按 general 兜底
  const ratings = s.ratings && s.ratings.length ? s.ratings : null
  const out = []
  for (const v of videos) {
    if (cats && cats.indexOf(v.folder) < 0) continue
    if (!matchesRating(v, ratings)) continue
    // 工作室（P5-A）：索引 videos[].studios 是名称数组，命中任意一个即可（同 facet 的「或」，组间「与」）
    if (studios) {
      const own = videoStudioNames(v)
      let hit = false
      for (const n of own) {
        if (studios.indexOf(n) >= 0) {
          hit = true
          break
        }
      }
      if (!hit) continue
    }
    if (durs && durs.indexOf(durBucketOf(v.dur)) < 0) continue
    if (ress && ress.indexOf(resTierOf(v.w)) < 0) continue
    if (sizes && sizes.indexOf(sizeBucketOf(v.size)) < 0) continue
    if (s.unsafe && v.browserOk !== false) continue
    if (!matchesSearch(v, s.q)) continue
    if (!matchesFacets(v, s.facets)) continue
    out.push(v)
  }
  return out
}

/** 分辨率权重用像素总量 w*h，未探测到（null）返回 null 以便排序时置尾 */
function resPixels(v) {
  const w = v && v.w
  const h = v && v.h
  return w > 0 && h > 0 ? w * h : null
}

/** 续播百分比：无记录返回 -1，便于「有进度优先」把未看过的排后面 */
function progressPct(v, pos) {
  if (!v || !pos) return -1
  const p = pos[v.id]
  if (!(p > 0)) return -1
  const d = v.dur
  return d > 0 ? Math.min(1, p / d) : 0
}

function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = a[i]
    a[i] = a[j]
    a[j] = t
  }
  return a
}

function sortVideos(list, mode, ctx) {
  const a = list.slice()
  const c = ctx || {}
  const byName = (x, y) => String(x.title || '').localeCompare(String(y.title || ''), 'zh-Hans-CN')
  const byNum = (x, y, f, dir) => {
    const vx = x[f] == null ? -Infinity : x[f]
    const vy = y[f] == null ? -Infinity : y[f]
    return dir * (vx - vy) || byName(x, y)
  }
  const byRank = (rank) => (x, y) => {
    const rx = rank.has(x.id) ? rank.get(x.id) : Infinity
    const ry = rank.has(y.id) ? rank.get(y.id) : Infinity
    return rx < ry ? -1 : rx > ry ? 1 : 0
  }
  switch (mode) {
    case 'name':
      a.sort(byName)
      break
    case 'name-desc':
      a.sort((x, y) => byName(y, x))
      break
    case 'dur-desc':
      a.sort((x, y) => byNum(x, y, 'dur', -1))
      break
    case 'dur-asc':
      a.sort((x, y) => byNum(x, y, 'dur', 1))
      break
    case 'size-desc':
      a.sort((x, y) => byNum(x, y, 'size', -1))
      break
    case 'size-asc':
      a.sort((x, y) => byNum(x, y, 'size', 1))
      break
    case 'res-desc':
    case 'res-asc': {
      const dir = mode === 'res-desc' ? -1 : 1
      a.sort((x, y) => {
        const px = resPixels(x)
        const py = resPixels(y)
        if (px == null && py == null) return byNum(x, y, 'dur', -1)
        if (px == null) return 1 // 未探测到分辨率的一律排末尾
        if (py == null) return -1
        return dir * (px - py) || byNum(x, y, 'dur', -1)
      })
      break
    }
    case 'recent': {
      const rank = new Map()
      for (const id of c.recent || []) if (!rank.has(id)) rank.set(id, rank.size)
      a.sort(byRank(rank)) // 未在最近列表里的都是 Infinity，稳定排序保添加序
      break
    }
    case 'progress': {
      const pos = c.pos || {}
      a.sort((x, y) => {
        const px = progressPct(x, pos)
        const py = progressPct(y, pos)
        if (px < 0 && py < 0) return 0
        if (px < 0) return 1
        if (py < 0) return -1
        return py - px
      })
      break
    }
    case 'random': {
      // 会话内固定：用一次性洗好的 id → 名次表，切筛选不重洗
      if (c.randomRank && typeof c.randomRank.has === 'function') a.sort(byRank(c.randomRank))
      else shuffleInPlace(a)
      break
    }
    default:
      break // added = 索引原序
  }
  return a
}

function queryVideos(videos, st, ctx) {
  const s = st || {}
  return sortVideos(filterVideos(videos, s), s.sort, ctx)
}

function defaultState() {
  return {
    q: '',
    cats: [],
    facets: {},
    durs: [],
    ress: [],
    sizes: [],
    // 工作室筛选（P5-A）：名称数组，与分类 / facet 同为「与」关系
    studios: [],
    // 内容分级筛选（P5.99）：分级值数组，同为「与」关系；空 = 不筛
    ratings: [],
    unsafe: false,
    sort: 'added',
    sortPinned: false,
    play: '',
    // 播放列表筛选维度（P5.46）：'' = 全部；非空 = 该列表 id（网格按列表顺序）
    pl: ''
  }
}

function readJsonList(v) {
  if (!v) return []
  try {
    const a = JSON.parse(v)
    if (Array.isArray(a)) return a.map(String)
  } catch {
    /* 忽略损坏的 hash */
  }
  return []
}

function readCsv(v, allowed) {
  if (!v) return []
  const out = []
  for (const k of String(v).split(',')) {
    if (k && (!allowed || allowed.indexOf(k) >= 0) && out.indexOf(k) < 0) out.push(k)
  }
  return out
}

function parseHash(hash) {
  const st = defaultState()
  const raw = String(hash == null ? '' : hash).replace(/^#/, '')
  if (!raw) return st
  const p = new URLSearchParams(raw)
  const q = p.get('q')
  if (q) st.q = q
  st.cats = readJsonList(p.get('cat'))
  st.durs = readCsv(
    p.get('dur'),
    DUR_BUCKETS.map((b) => b.key)
  )
  st.ress = readCsv(
    p.get('res'),
    RES_TIERS.map((b) => b.key)
  )
  st.sizes = readCsv(
    p.get('size'),
    SIZE_BUCKETS.map((b) => b.key)
  )
  // 工作室（P5-A）：hash 段名 studio，JSON 名称数组
  st.studios = readJsonList(p.get('studio'))
  // 内容分级（P5.99）：hash 段名 rating，逗号分隔的分级值
  st.ratings = readCsv(p.get('rating'), null)
  if (p.get('unsafe') === '1') st.unsafe = true
  const play = p.get('play')
  if (play) st.play = play // 播放深链 /#play=<videoId>
  // 播放列表筛选（P5.46）：hash 段名 pl，写的是列表 id
  const pl = p.get('pl')
  if (pl) st.pl = pl
  const sort = p.get('sort')
  if (sort && SORTS.some((s) => s.key === sort)) {
    st.sort = sort
    st.sortPinned = true
  }
  const f = p.get('f')
  if (f) {
    try {
      const o = JSON.parse(f)
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        for (const k of Object.keys(o)) if (Array.isArray(o[k]) && o[k].length) st.facets[k] = o[k].map(String)
      }
    } catch {
      /* 忽略 */
    }
  }
  return st
}

function buildHash(st) {
  const s = st || defaultState()
  const p = new URLSearchParams()
  if (s.q) p.set('q', s.q)
  if (s.cats && s.cats.length) p.set('cat', JSON.stringify(s.cats))
  const fk = Object.keys(s.facets || {}).filter((k) => (s.facets[k] || []).length)
  if (fk.length) {
    const o = {}
    for (const k of fk) o[k] = s.facets[k]
    p.set('f', JSON.stringify(o))
  }
  if (s.studios && s.studios.length) p.set('studio', JSON.stringify(s.studios))
  if (s.ratings && s.ratings.length) p.set('rating', s.ratings.join(','))
  if (s.durs && s.durs.length) p.set('dur', s.durs.join(','))
  if (s.ress && s.ress.length) p.set('res', s.ress.join(','))
  if (s.sizes && s.sizes.length) p.set('size', s.sizes.join(','))
  if (s.unsafe) p.set('unsafe', '1')
  if (s.pl) p.set('pl', s.pl)
  if (s.play) p.set('play', s.play)
  // 只有「用户/首屏随机结果固定下来的」排序才写进 hash；清空后不带 sort，刷新重新随机
  if (s.sort && s.sortPinned) p.set('sort', s.sort)
  const qs = p.toString()
  return qs ? '#' + qs : ''
}

/** 侧栏 facet → { facet: [[值, 计数], …] }；分类恒等 folder，演员只取 actors[] */
function facetValues(videos, facetOrder) {
  const counts = {}
  const bump = (f, n) => {
    const g = counts[f] || (counts[f] = {})
    g[n] = (g[n] || 0) + 1
  }
  for (const v of videos) {
    for (const t of v.tags || []) {
      if (!t || t[0] === '分类' || t[0] === '演员') continue
      bump(t[0], t[1])
    }
    for (const a of v.actors || []) bump('演员', a)
  }
  const order = []
  for (const f of facetOrder || []) if (counts[f] && order.indexOf(f) < 0) order.push(f)
  for (const f of Object.keys(counts)) if (order.indexOf(f) < 0) order.push(f)
  const out = {}
  for (const f of order) {
    out[f] = Object.keys(counts[f])
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
      .map((n) => [n, counts[f][n]])
  }
  return out
}

function folderCounts(videos) {
  const m = {}
  for (const v of videos) m[v.folder] = (m[v.folder] || 0) + 1
  return m
}

/**
 * 视频的工作室名称数组（P5-A：索引 videos[].studios = [name]）
 * 兼容两种形态：名称字符串数组 / [{id,name}]（详情接口形态），空值与重复项丢掉。
 */
function videoStudioNames(v) {
  const arr = (v && v.studios) || []
  if (!Array.isArray(arr)) return []
  const out = []
  for (const s of arr) {
    const n = typeof s === 'string' ? s : (s && s.name) || ''
    if (n && out.indexOf(n) < 0) out.push(n)
  }
  return out
}

/* =========================================================================
   本地存储（键名与 app.js 完全一致，保证与手写页共用同一份进度 / 最近观看）
   ========================================================================= */

function lsGet(k) {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
function lsSet(k, v) {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* 隐私模式忽略 */
  }
}
function lsDel(k) {
  try {
    localStorage.removeItem(k)
  } catch {
    /* 忽略 */
  }
}

/* =========================================================================
   状态
   ========================================================================= */

const state = reactive(parseHash(window.location.hash))

const videos = ref([])
const facetOrder = ref([])
const loading = ref(true)
const errorMsg = ref('')

const byId = computed(() => new Map(videos.value.map((v) => [v.id, v])))

const catCounts = computed(() => folderCounts(videos.value))
const catNames = computed(() => Object.keys(catCounts.value).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')))
const facetGroups = computed(() => facetValues(videos.value, facetOrder.value))

/* ---------------------------------------------------------------- 人物 facet（P3-B） */
/* 人物分组的数据源：以前由索引里的 tags / actors 现推（旧数据），现在优先用 GET /api/media/persons
   的条目 + 服务端计数。接口未就绪（404 / 连不上）时 personList 保持 null，抽屉完全回落到旧推导，
   筛选、计数、折叠、搜索框行为都不变 —— 只是「人物」这一组的来源换成了服务端。 */
const PERSON_FACET = '人物'
const personList = ref(null)
/** 人物库加载中 / 未就绪：演员选择器（PersonPicker）的三态数据源，null 列表 = 未就绪 */
const personsLoading = ref(false)
const personsUnavailable = computed(() => !personsLoading.value && personList.value == null)

const personFacetItems = computed(() => {
  if (!personList.value) return null
  const items = personList.value
    .filter((p) => p && p.name)
    .map((p) => [String(p.name), Number(p.videoCount != null ? p.videoCount : p.video_count) || 0])
  items.sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'zh-Hans-CN'))
  return items
})

/** 抽屉实际用的分组：接口就绪时用服务端「人物」，否则原样返回旧推导结果 */
const facetGroupsView = computed(() => {
  const items = personFacetItems.value
  if (!items || !items.length) return facetGroups.value
  const out = Object.assign({}, facetGroups.value)
  out[PERSON_FACET] = items
  return out
})

/* ------------------------------------------------------------- 工作室（P5-A） */
/* 数据源：GET /api/media/studios（服务端计数，匿名只读）。
   降级：接口未就绪（404 / 连不上）时 studioList = null，分组回落到按索引 videos[].studios 现推，
        并在分组底部写明「接口未就绪」；两者都没有时分组只剩这句提示，筛选与列表不受影响。 */
const studioList = ref(null)
const studiosUnavailable = ref('')

const studioItems = computed(() => {
  const server = studioList.value
  if (server && server.length) {
    const items = server
      .filter((s) => s && s.name)
      .map((s) => [String(s.name), Number(s.videoCount != null ? s.videoCount : s.count) || 0])
    items.sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'zh-Hans-CN'))
    return items
  }
  const counts = {}
  for (const v of videos.value) for (const n of videoStudioNames(v)) counts[n] = (counts[n] || 0) + 1
  return Object.keys(counts)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .map((n) => [n, counts[n]])
})

const studiosHint = computed(() => studiosUnavailable.value)

/** 工作室勾选：与 facet 同理，组内或、组间与；切到「选中」才上报 tag_click */
function onStudioToggle(name) {
  const arr = state.studios || (state.studios = [])
  toggleIn(arr, name)
  if (arr.indexOf(name) >= 0) tk.track('tag_click', 'tag', ('工作室:' + name).slice(0, 64), 0, 0)
}

/* --------------------------------------------------------- 播放列表（P5-B） */

const route = useRoute()
const router = useRouter()

/** 弹层开关 + 目标视频：正在播放的那一部优先，否则用多选集合 */
const playlistPickerOpen = ref(false)
const playlistTargetIds = computed(() => (curVideo.value ? [curVideo.value.id] : selectedIds.value.slice()))
const playlistAddTitle = computed(() => {
  if (readOnlyEdit.value) return HINT_OFF
  const n = playlistTargetIds.value.length
  if (!n) return '加入播放列表：先打开一部片，或用「选择」多选后再点'
  return '加入播放列表（' + n + ' 个视频）'
})

/** URL ?playlist=<id>：播放器上下文来自某个播放列表时，上一部/下一部按该列表顺序走 */
const playlistId = computed(() => {
  const q = route && route.query ? route.query.playlist : ''
  const v = Array.isArray(q) ? q[0] : q
  return v == null ? '' : String(v)
})
/** { id, name, ids } —— ids 是服务端给的有序集合（顺序即播放顺序） */
const playlistCtx = ref(null)

function openPlaylistPicker() {
  if (readOnlyEdit.value) {
    showToast(HINT_OFF)
    return
  }
  if (!playlistTargetIds.value.length) {
    showToast('请先打开一部片，或用「选择」多选视频')
    return
  }
  playlistPickerOpen.value = true
}

function onPlaylistAdded(msg) {
  showToast(msg || '已加入播放列表')
  // 已经在看这个播放列表：拉一次最新顺序，免得「下一个」还是旧的
  if (playlistCtx.value && playlistId.value) loadPlaylistContext()
}

/** 退出播放列表上下文：只去掉 URL 上的 ?playlist，不影响筛选 hash 与当前播放位置 */
function exitPlaylistMode() {
  // 上下文回落由下面的 watch(playlistCtx) 统一负责（清空 → 当前上下文来自播放列表时重新定位），
  // 这里只改 URL：单一实现，避免两处各算一次
  playlistCtx.value = null
  const q = Object.assign({}, route.query)
  delete q.playlist
  router.replace({ path: route.path, query: q, hash: window.location.hash || undefined }).catch(() => {})
}

/* ------------------------------------------- 播放列表 = 筛选维度（P5.46） */
/* 用户决定：播放列表形态用 C —— 不再独占一个大页面，而是视频库筛选条上的一个维度
   （与时长 / 分辨率 / 体积并列）。state.pl 存选中的列表 id，'' = 全部：
     · 网格：只显示该列表的片子，顺序 = 列表顺序（覆盖排序下拉，见上面的 view）；
     · 播放：点击卡片进播放器时上下文就是该列表（标题 = 列表名、顺序 = 列表顺序）；
     · 管理：重命名 / 删除 / 拖拽排序 / 复制列表名都收进 PlaylistManageDialog 弹层。
   数据只有两份：plList（清单，下拉 + 弹层共用）与 plView（选中列表的有序条目）。 */

/** 桌面筛选条 / 移动抽屉里的两个下拉实例（同一条筛选条的两处渲染，与 QuickFilters 同构） */
const plFilterRef = ref(null)
const plFilterDrawerRef = ref(null)
/** 清单：[{ id, name, count }]（GET /api/media/playlists 归一化） */
const plList = ref([])
const plListLoading = ref(false)
/** 非空 = 清单接口未就绪的可读提示（只在下拉与弹层里显示，不影响库） */
const plListUnavailable = ref('')
/** 选中列表的有序条目：{ id, name, ids }；null = 未选 / 未加载完成 */
const plView = ref(null)
const plLoading = ref(false)
const plUnavailable = ref('')
/** 管理弹层开关 + 「新建」聚焦标记（下拉开「新建播放列表…」时把光标送进名称输入框） */
const plManageOpen = ref(false)
const plManageCreate = ref(false)

function openPlaylistManage() {
  plManageCreate.value = false
  plManageOpen.value = true
}

function openPlaylistCreate() {
  plManageCreate.value = true
  plManageOpen.value = true
}

/** 是否正在按播放列表筛选（网格顺序因此被列表顺序覆盖） */
const plFilterOn = computed(() => !!state.pl)

/** 选中列表的显示名：详情没到时退化成清单里的名字，再退化成 #id */
const plFilterName = computed(() => {
  const id = String(state.pl || '')
  if (!id) return ''
  const v = plView.value
  if (v && String(v.id) === id && v.name) return v.name
  const hit = plList.value.find((p) => String(p.id) === id)
  return hit ? hit.name : '#' + id
})

async function loadPlaylistList() {
  plListLoading.value = true
  plListUnavailable.value = ''
  try {
    const res = await api.listPlaylists({ silent: true })
    plList.value = normalizePlaylistList(res)
  } catch {
    plList.value = []
    plListUnavailable.value = '播放列表接口未就绪（GET /api/media/playlists）'
  } finally {
    plListLoading.value = false
  }
}

async function loadPlaylistView() {
  const id = String(state.pl || '')
  if (!id) {
    plView.value = null
    plUnavailable.value = ''
    plLoading.value = false
    return
  }
  plLoading.value = true
  plUnavailable.value = ''
  try {
    const res = await api.getPlaylist(id, { silent: true })
    const d = normalizePlaylistDetail(res)
    if (String(state.pl) !== id) return // 期间又换了列表：丢弃旧响应
    plView.value = { id, name: d.name || '#' + id, ids: d.ids }
  } catch {
    plView.value = null
    plUnavailable.value = '播放列表详情接口未就绪（GET /api/media/playlist/{id}）：暂时无法按列表筛选'
  } finally {
    plLoading.value = false
  }
}

// 选中的列表变了就重拉有序条目（下拉选择、清空筛选、手改 hash 都走这里）
watch(() => state.pl, () => loadPlaylistView(), { immediate: true })

/** 下拉 / 侧栏 / 弹层共用的唯一入口：设置筛选（'' = 回到全库） */
function applyPlaylistFilter(id) {
  const next = id ? String(id) : ''
  plManageOpen.value = false
  if (next === String(state.pl || '')) return
  state.pl = next
}

/**
 * 管理弹层的写操作回执：清单总是重拉；
 * 被改的正好是当前筛选的列表时，条目也要重拉（重命名改标题、拖拽排序改网格顺序）。
 */
function onPlaylistDataChanged(payload) {
  const p = payload || {}
  loadPlaylistList()
  if (p.kind === 'delete' && String(state.pl) === String(p.id)) {
    state.pl = ''
    return
  }
  if (String(state.pl) === String(p.id)) loadPlaylistView()
}

/**
 * 侧栏「播放列表」入口（P5.46）：不再跳独立页，而是「跳视频库 + 打开播放列表下拉」。
 * 信号走一次性查询参数 ?plf=<token>（token 每次点击都不同，重复点击也能再次触发）；
 * 消费后立刻从地址栏抹掉，刷新不会又弹一次。
 */
const plfToken = computed(() => {
  const q = (route && route.query) || {}
  const v = Array.isArray(q.plf) ? q.plf[0] : q.plf
  return v == null ? '' : String(v)
})

function consumePlaylistFocus() {
  if (!plfToken.value) return
  const q = Object.assign({}, route.query)
  delete q.plf
  router.replace({ path: route.path, query: q, hash: window.location.hash || undefined }).catch(() => {})
  nextTick(() => {
    // 桌面与移动是两处渲染（互斥），哪个在就开哪个
    for (const c of [plFilterRef.value, plFilterDrawerRef.value]) {
      if (c && typeof c.open === 'function') c.open()
    }
  })
}

watch(plfToken, () => consumePlaylistFocus())

const quickGroups = [
  { field: 'durs', items: DUR_BUCKETS },
  { field: 'ress', items: RES_TIERS },
  { field: 'sizes', items: SIZE_BUCKETS }
]

/**
 * 内容分级（P5.99）：{@code [{value,label,count}]}，来自索引的 {@code ratings[]}。
 *
 * 后端已经按「当前访客可见 + 该档确实有条目」筛过一遍：
 * 未登录不可见的那一档根本不在数组里，所以前端不需要、也<b>不应该</b>自己再查策略表。
 */
const ratingOptions = ref([])
/** 只有一个可见分级时不渲染筛选条（规则在 contentRating.js：与图片站共用同一份） */
const showRatingFilter = computed(() => showRatingFilterOf(ratingOptions.value))

function onToggleRating(value) {
  toggleIn(state.ratings || (state.ratings = []), value)
}

/** id → 续播秒数 */
const posMap = ref({})
/** localStorage['ms.recent']：服务端最近观看主库的离线兜底 */
const recentLocal = ref([])
const recentClosed = ref(lsGet(KEY_RECENT_CLOSED) === '1')

/** 服务端用户数据（/api/media/user）：收藏 + 最近观看，等价 profile.js 的 state */
const userState = reactive({
  profile: { nick: '我', avatar: null },
  favorites: [],
  recent: { videos: [], photos: [] }
})
const userReady = ref(false)

const drawerOpen = ref(false)
const cols3 = ref(lsGet(KEY_COLS) === '3')
const quality = ref(loadQ())

const curVideo = ref(null)
/**
 * P5.32：本次播放的上下文快照（{ ids, index, source, name, playlistId, hasPrev, hasNext }）。
 * openPlayer 时按 playlist > browse > recent > library 定一次，之后换片只换 index；
 * 播放中改筛选**不重算**（快照语义：从哪个列表点进来就按那个顺序走）。
 * null = 上下文缺失（上/下一部禁用，信息栏分区只显示一句说明）。
 */
const pbCtx = ref(null)
const openSeq = ref(0)
const startPos = ref(0)
const playerRef = ref(null)
const sidebarRef = ref(null)
const drawerEl = ref(null)
const filterBtnEl = ref(null)
const searchEl = ref(null)
const sentinelEl = ref(null)

const searchInput = ref(state.q)
const visibleLimit = ref(CHUNK)

/* ---- 媒体库组织（M3）：选择模式 / 批量写入 / 标签库 / 单条信息抽屉 ---- */

/** 单次批量上限：超过只提示不提交（后端 batch-meta 一次请求） */
const MAX_BATCH = 500
const selectMode = ref(false)
/** 已选视频 id（顺序即选择顺序，用于展示与提交 body.ids） */
const selectedIds = ref([])
const selectedSet = computed(() => new Set(selectedIds.value))
/** Shift 连选的锚点：上一次点过的卡片在 visibleVideos 里的下标 */
const selectAnchor = ref(-1)
/** 标签库缓存（进入选择模式 / 打开信息抽屉时按需拉取） */
const allTags = ref([])
const tagsLoading = ref(false)
const batchBusy = ref(false)
/** 本地覆盖层：id → { rating, tags }，批量/单条写入后立即反映到卡片，无需重拉整份索引 */
const metaOverrides = reactive({})

/* ---- 三档编辑策略：off 禁写 / local 只写 localStorage / full 走接口 ---- */
const { level: editLevel, canEdit, readOnly: readOnlyEdit, isLocal, loadEditPolicy } = useMediaEditPolicy()
/** 选择按钮 title：off 档统一提示「仅私有部署可编辑…」 */
const selectTitle = computed(() => {
  if (editLevel.value === LEVEL_OFF) return HINT_OFF
  return selectMode.value ? '退出选择模式' : '多选：批量加标签 / 移除标签 / 评分'
})
/** 有本地覆盖的视频数：批量条「清除本地修改」与卡片「本地」徽标共用同一份数据 */
const localEditedCount = computed(() => {
  if (!isLocal.value) return 0
  // 依赖版本号：localStorage 写入后重新计算（否则 computed 不会重算）
  void localOrgVersion.value
  return listLocalIds().length
})
/** 信息抽屉「在当前时间加标记」用的起手位置：打开抽屉那一刻从播放器取 */
const metaAtSec = ref(0)
/** P4-B：抽屉里当前这部片的标记（抽屉 emit 上来），只给播放器画进度条刻度用 */
const playerMarkers = ref([])

/**
 * P4.3 标记缓存策略（取舍见 composables/useMarkerCache.js 头注释）：
 *   站端没有匿名读元信息的接口（MediaEditController 只有 PUT /video/{id}/meta，
 *   管理端 GET /api/media/admin/video/{id}/meta 带 @PreAuthorize，匿名 401），
 *   而本轮不许改后端 —— 所以抽屉仍是唯一真实数据源，但抽屉拿到的标记按 videoId 落到
 *   localStorage，下次打开播放器（同一浏览器、同一视频）直接从缓存画刻度，不必先开抽屉。
 *   代价：换浏览器 / 清缓存 / 从没开过抽屉的访客第一次仍然没有刻度；抽屉每次读成功后
 *   都会用权威值覆盖缓存，删光标记时缓存被清空，所以最多短暂过期。
 */
function markerStorage() {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

/**
 * 信息抽屉的标记变动 → 进度条刻度；不参与筛选/排序，也不写服务端。
 * P4.3：trusted=true（抽屉读到/写回权威值、或本地档的本机覆盖）时才更新该 videoId 的缓存，
 * 读失败时的空列表绝不清缓存（否则会把播放器已经画出来的刻度擦掉）。
 */
function onMetaMarkers(list, trusted) {
  const next = Array.isArray(list) ? list.slice() : []
  if (!trusted) {
    // 读接口失败（站端匿名 401）时抽屉只会 emit 一个空列表：不能拿它擦掉缓存画出来的刻度，
    // 否则「打开抽屉 → 刻度消失」会比原来更糟。非空但不可信的数据照常显示，只是不写缓存。
    if (!next.length) return
    playerMarkers.value = next
    return
  }
  playerMarkers.value = next
  const id = curVideo.value && curVideo.value.id
  if (id) writeMarkerCache(markerStorage(), id, next)
}

/** P4-B：抽屉「以当前位置为终点」取的是此刻（播放器仍在播放），而不是打开抽屉时的位置 */
function currentPlaySec() {
  const pl = playerRef.value
  return pl && typeof pl.getCurrentTime === 'function' ? pl.getCurrentTime() : metaAtSec.value
}

/** P4.5：内容总时长（秒），供抽屉做片尾判定与终点夹取；播放器没暴露时回落到索引里的 dur */
function currentPlayDur() {
  const pl = playerRef.value
  if (pl && typeof pl.getDuration === 'function') {
    const d = Number(pl.getDuration())
    if (isFinite(d) && d >= 0) return d
  }
  const d = Number(curVideo.value && curVideo.value.dur)
  return isFinite(d) && d > 0 ? d : 0
}
/* 提示统一走 usePageToast（与播放列表页同一套组件 PageToast） */
const { toasts, push: showToast } = usePageToast()

/* ---------------------------------------------------------- 批量生成简介（P5.47 / P5.55 安全化） */

/*
 * P5.55 的形状：**点按钮只开弹窗**，弹窗里两步确认之后才真的发请求。
 * 状态机也在这里（弹窗是纯展示 + emit）：
 *   confirm → run → summary；undo 是独立入口（上一次批量 / 手贴 ids）。
 */

/** 当前批量任务节点（null = 没有任务在跑/没跑过） */
const synopsisBatchJob = ref(null)
/** 提交中（按钮 loading） */
const synopsisBatchBusy = ref(false)
/** 弹窗开关与阶段 */
const synopsisDialogOpen = ref(false)
const synopsisPhase = ref('confirm')
/** 影响面预览（两步确认第一段读它） */
const synopsisPreview = ref(null)
const synopsisPreviewLoading = ref(false)
const synopsisPreviewError = ref('')
/** 本次将用哪种生成方式（tmpl / llm）：点开弹窗时定一次，提交时复用 */
const synopsisMode = ref('template')
/** 已发出停止请求（等当前那条生成完） */
const synopsisStoppingLocal = ref(false)
/** 撤销：dry-run 结果 / 进行中 / 已完成 */
const synopsisUndoPreview = ref(null)
const synopsisUndoBusy = ref(false)
const synopsisUndoDone = ref(null)
/** 撤销的目标 id 文本（逗号 / 空格 / 换行分隔），默认取上一次批量记录 */
const synopsisUndoIds = ref('')
/** 上一次批量记录（localStorage，后端内存任务丢失后撤销只能靠它） */
const lastBatch = ref(readLastBatch())
let synopsisBatchTimer = null

const synopsisBatchText = computed(() => batchProgressText(synopsisBatchJob.value))
const synopsisBatchFinished = computed(() => batchFinished(synopsisBatchJob.value))
const synopsisRunning = computed(() => batchActive(synopsisBatchJob.value))
const synopsisStopping = computed(
  () => synopsisStoppingLocal.value || !!(synopsisBatchJob.value && synopsisBatchJob.value.cancelRequested)
)
const synopsisBatchTitle = computed(() =>
  synopsisRunning.value
    ? '批量生成进行中…（点开可看进度 / 停止）'
    : '为视频批量生成简介：先弹两步确认（默认只补空、不覆盖已有内容）'
)
const synopsisTarget = computed(() => ({
  hasSelection: !!(selectMode.value && selectedIds.value.length),
  count: synopsisPreview.value ? Number(synopsisPreview.value.total) || 0 : selectedIds.value.length
}))
const synopsisCanRollback = computed(() => !!(synopsisBatchJob.value && synopsisBatchJob.value.canRollback))
const synopsisUndoCount = computed(() => parseIdList(synopsisUndoIds.value).length)

/** id 文本 → 数组（逗号 / 空格 / 换行都算分隔符，去空去重） */
function parseIdList(text) {
  const out = []
  const seen = {}
  String(text || '')
    .split(/[\s,，;；]+/)
    .forEach((raw) => {
      const id = raw.trim()
      if (!id || seen[id]) return
      seen[id] = 1
      out.push(id)
    })
  return out
}

function stopSynopsisBatchPoll() {
  if (synopsisBatchTimer) {
    clearInterval(synopsisBatchTimer)
    synopsisBatchTimer = null
  }
}

/** 任务结束后：把「这次到底写了哪些 id」记进本机记录，撤销入口才有的放矢 */
function rememberBatchIds(job) {
  if (!job || !Array.isArray(job.items)) return
  const ids = job.items.filter((it) => it && it.status === 'generated' && it.videoId).map((it) => it.videoId)
  if (!ids.length) return
  const prev = lastBatch.value || {}
  lastBatch.value = { ...prev, ids, jobId: job.jobId || prev.jobId, finishedAt: Date.now() }
  saveLastBatch(lastBatch.value)
}

/** 轮询任务进度：1.5s 一次，结束后停表并弹成果汇总 */
function pollSynopsisBatch(jobId) {
  stopSynopsisBatchPoll()
  synopsisBatchTimer = setInterval(async () => {
    try {
      const job = await api.getSynopsisJob(jobId, { silent: true })
      synopsisBatchJob.value = job
      if (batchFinished(job)) {
        stopSynopsisBatchPoll()
        synopsisBatchBusy.value = false
        synopsisStoppingLocal.value = false
        rememberBatchIds(job)
        synopsisPhase.value = 'summary'
        synopsisDialogOpen.value = true
        showToast(batchProgressText(job))
      }
    } catch {
      stopSynopsisBatchPoll()
      synopsisBatchBusy.value = false
      synopsisStoppingLocal.value = false
      synopsisPreviewError.value = ''
      // 404 = 后端重启过，内存任务丢了：明确说出来，别让用户以为「跑完了」
      showToast('批量生成任务已丢失（后端重启），进度查询 404；成果无从汇总，可点「撤销上次批量」按 ids 清空')
    }
  }, 1500)
}

/** 打开两步确认弹窗（只读预览，不动任何数据） */
async function openSynopsisBatch() {
  if (readOnlyEdit.value) return
  synopsisDialogOpen.value = true
  if (synopsisRunning.value) {
    synopsisPhase.value = 'run'
    return
  }
  synopsisPhase.value = 'confirm'
  await loadSynopsisPreview()
}

/** 影响面预览：确认弹窗里那句「将对 N 部…已有内容的 M 部将跳过」的唯一来源 */
async function loadSynopsisPreview() {
  if (synopsisPreviewLoading.value) return
  synopsisPreviewLoading.value = true
  synopsisPreviewError.value = ''
  try {
    let capabilities = null
    try {
      capabilities = await api.getSynopsisCapabilities({ silent: true })
    } catch {
      capabilities = null
    }
    synopsisMode.value = resolveMode(capabilities)
    const picked = selectMode.value && selectedIds.value.length ? selectedIds.value.slice() : null
    const payload = picked ? { videoIds: picked, overwrite: false } : { all: true, overwrite: false }
    synopsisPreview.value = await api.previewSynopsisBatch(payload, { silent: true })
  } catch (err) {
    synopsisPreview.value = null
    synopsisPreviewError.value = '影响范围统计失败：' + errorText(err)
  } finally {
    synopsisPreviewLoading.value = false
  }
}

/**
 * 提交批量生成（两步确认的第二段：勾选 + 敲字都过了才会走到这里）
 *   选中项非空 → 只处理这些 id；否则 → all:true（全库）
 *   overwrite 由弹窗的「包括已有内容」决定，**默认 false**
 */
async function startSynopsisBatch(payload) {
  if (synopsisBatchBusy.value || readOnlyEdit.value) return
  const overwrite = !!(payload && payload.overwrite)
  synopsisBatchBusy.value = true
  try {
    const picked = selectMode.value && selectedIds.value.length ? selectedIds.value.slice() : null
    const body = picked
      ? { videoIds: picked, mode: synopsisMode.value, overwrite }
      : { all: true, mode: synopsisMode.value, overwrite }
    const job = await api.generateSynopsisBatch(body)
    synopsisBatchJob.value = job
    synopsisStoppingLocal.value = false
    lastBatch.value = {
      jobId: job.jobId || '',
      ids: picked || [],
      all: !picked,
      overwrite,
      mode: synopsisMode.value,
      startedAt: Date.now()
    }
    saveLastBatch(lastBatch.value)
    synopsisPhase.value = 'run'
    showToast(
      '批量生成已开始：' +
        (job.total || 0) +
        ' 条（' +
        (synopsisMode.value === 'llm' ? '本地模型' : '模板') +
        (overwrite ? '，覆盖已有内容' : '，已有内容跳过') +
        '）'
    )
    pollSynopsisBatch(job.jobId)
  } catch (err) {
    showToast('批量生成失败：' + errorText(err))
  } finally {
    synopsisBatchBusy.value = false
  }
}

/**
 * 停止批量（P5.55）：先问后端有没有在跑的
 *   有 → cancel（协作式：当前这条跑完才停），按钮变「正在停止…」
 *   没有 → 直接本地标记停止（后端本来就没有活儿）
 */
async function stopSynopsisBatch() {
  if (synopsisStoppingLocal.value) return
  synopsisStoppingLocal.value = true
  try {
    let running = []
    try {
      const active = await api.listActiveSynopsisJobs({ silent: true })
      running = active && Array.isArray(active.jobs) ? active.jobs : []
    } catch {
      running = []
    }
    const mine = running.find((j) => j && j.jobId === (synopsisBatchJob.value && synopsisBatchJob.value.jobId))
    const target = mine || running[0] || null
    if (!target) {
      // 后端没有在跑的任务：本地标记停止（不假装成功，也不报错）
      stopSynopsisBatchPoll()
      if (synopsisBatchJob.value) {
        const done = batchFinished(synopsisBatchJob.value)
        synopsisBatchJob.value = done
          ? synopsisBatchJob.value
          : { ...synopsisBatchJob.value, status: 'stopped', cancelRequested: true }
        synopsisPhase.value = 'summary'
      }
      synopsisStoppingLocal.value = false
      showToast('后端没有正在跑的任务，已标记停止')
      return
    }
    const job = await api.cancelSynopsisJob(target.jobId, { silent: true })
    synopsisBatchJob.value = job
    showToast('已请求停止：正在生成的这一条会跑完，之后的条目不再开始')
    pollSynopsisBatch(job.jobId)
  } catch (err) {
    synopsisStoppingLocal.value = false
    showToast('停止失败：' + errorText(err))
  }
}

/** 从进度行「成果」按钮回看汇总 */
function openSynopsisSummary() {
  if (!synopsisBatchJob.value) return
  synopsisDialogOpen.value = true
  synopsisPhase.value = 'summary'
}

/** 打开撤销段：默认填上次批量真正写过的 id；任务有旧值快照就优先精确回滚 */
function openSynopsisUndo() {
  const record = lastBatch.value || {}
  const ids = Array.isArray(record.ids) && record.ids.length ? record.ids : []
  synopsisUndoIds.value = ids.join(' ')
  synopsisUndoPreview.value = null
  synopsisUndoDone.value = null
  synopsisDialogOpen.value = true
  synopsisPhase.value = 'undo'
}

function closeSynopsisDialog() {
  synopsisDialogOpen.value = false
}

/** 撤销一条路：任务记了旧值 → 精确回滚（旧值空则清空） */
async function rollbackSynopsisBatch() {
  const jobId = (lastBatch.value && lastBatch.value.jobId) || (synopsisBatchJob.value && synopsisBatchJob.value.jobId)
  if (!jobId) {
    showToast('没有可回滚的任务 id（后端任务已丢失），只能按 ids 清空')
    return
  }
  synopsisUndoBusy.value = true
  try {
    const res = await api.rollbackSynopsisJob(jobId, { silent: true })
    synopsisUndoDone.value = { text: rollbackText(res) + '（恢复 ' + (Number(res.restored) || 0) + ' / 清空 ' + (Number(res.cleared) || 0) + '）' }
    showToast(rollbackText(res))
    // 回滚成功后本机记录清掉：同一个任务不重复撤销
    clearLastBatch()
    lastBatch.value = null
    synopsisBatchJob.value = null
  } catch (err) {
    showToast('撤销失败：' + errorText(err))
  } finally {
    synopsisUndoBusy.value = false
  }
}

/** 撤销另一条路：任务没有旧值快照 → 按 ids 清空（先 dry-run 报数，再二次确认执行） */
async function clearSynopsisBatchIds() {
  const ids = parseIdList(synopsisUndoIds.value)
  if (!ids.length) {
    showToast('请先填要清空的视频 id')
    return
  }
  synopsisUndoBusy.value = true
  try {
    const res = await api.clearSynopsisByIds({ videoIds: ids, dryRun: false }, { silent: true })
    synopsisUndoDone.value = { text: rollbackText(res) }
    showToast(rollbackText(res))
    clearLastBatch()
    lastBatch.value = null
    synopsisBatchJob.value = null
  } catch (err) {
    showToast('清空失败：' + errorText(err))
  } finally {
    synopsisUndoBusy.value = false
  }
}

/** 撤销前的统计（dry-run）：让用户在确认前看到「到底会清掉几条」 */
async function previewSynopsisUndo() {
  const ids = parseIdList(synopsisUndoIds.value)
  if (!ids.length) {
    showToast('请先填要清空的视频 id')
    return
  }
  synopsisUndoBusy.value = true
  try {
    synopsisUndoPreview.value = await api.clearSynopsisByIds({ videoIds: ids, dryRun: true }, { silent: true })
    showToast(rollbackText(synopsisUndoPreview.value))
  } catch (err) {
    showToast('统计失败：' + errorText(err))
  } finally {
    synopsisUndoBusy.value = false
  }
}

/** 关闭进度条（任务本身已在后端跑完，这里只清 UI） */
function clearSynopsisBatch() {
  synopsisBatchJob.value = null
}

onBeforeUnmount(stopSynopsisBatchPoll)
/** 播放层只借用播放会话相关的三个方法（不能让它自己调 useMediaTrack，否则卸载时会 dispose 页面级监听） */
const tracker = {
  openPlaySession: tk.openPlaySession,
  trackPlayStart: tk.trackPlayStart,
  trackPlayEnd: tk.trackPlayEnd
}
/** IME 组合期：不触发搜索埋点 */
const composing = ref(false)
let searchTimer = 0
let tkSearchTimer = 0
let tkSearchLast = ''
let randRank = null
let recentMigrated = false

const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 768px)') : null
const isMobile = ref(mq ? mq.matches : false)

/** 「筛选」按钮角标：抽屉里所有已选项之和（分类 + facet + 快捷 + 异常码），搜索词不算 */
const filterBadgeCount = computed(() => {
  let n = state.cats.length + state.durs.length + state.ress.length + state.sizes.length
    + (state.studios || []).length + (state.ratings || []).length
  if (state.unsafe) n += 1
  for (const f of Object.keys(state.facets || {})) n += (state.facets[f] || []).length
  return n
})

const countText = computed(() => {
  if (loading.value) return '—'
  if (errorMsg.value) return '索引加载失败'
  return '显示 ' + view.value.length + ' / ' + videos.value.length
})

const emptyText = computed(() => {
  if (errorMsg.value) return errorMsg.value
  // 播放列表维度（P5.46）：把「加载中 / 未就绪 / 空列表 / 被其它筛选挡掉」四种空态说清楚
  if (state.pl) {
    if (plUnavailable.value) return plUnavailable.value
    if (plLoading.value || !plView.value) return '正在加载播放列表…'
    return plView.value.ids.length ? '这个播放列表里的视频都被当前筛选挡掉了' : '这个播放列表还没有视频'
  }
  return '没有符合条件的视频'
})

/**
 * P5.95：站端兜底提示 —— 未登录 && 索引成功 && stats 全 0 时，把「普通空态」换成
 * 「可能是站长关闭了未登录可见」。接口失败（errorMsg 非空）一律不算：那是另一种事故。
 */
const guestHidden = computed(() => {
  if (errorMsg.value) return false
  return isGuestHiddenEmpty({ loggedIn: !!auth.state.token, ok: indexOk.value, stats: indexStats.value })
})

/** 排序上下文：最近观看顺序 / 续播位置 / 本次会话固定的随机名次 */
const sortCtx = computed(() => {
  const ctx = { recent: recentLocal.value.map((r) => r.id), pos: posMap.value }
  if (state.sort === SORT_RANDOM) ctx.randomRank = randomRank()
  return ctx
})

/**
 * 网格结果。P5.46：选中播放列表时，先按其它筛选（分类 / 时长 / 搜索 …）出候选，
 * 再交给 orderByPlaylistIds 做「只留列表内 + 严格按列表顺序」——排序下拉此时不生效。
 * 列表还没加载完时返回空数组：宁可短暂空网格，也不让「已筛选却看到全库」误导。
 */
const view = computed(() => {
  const base = queryVideos(videos.value, state, sortCtx.value)
  if (!state.pl) return base
  const d = plView.value
  if (!d || String(d.id) !== String(state.pl)) return []
  return orderByPlaylistIds(base, d.ids)
})
const visibleVideos = computed(() => view.value.slice(0, visibleLimit.value))

const activeEntries = computed(() => {
  const out = []
  // 播放列表维度排在最前：它决定了整张网格的顺序（「按列表顺序」写在 chip 上）
  if (state.pl) out.push({ kind: 'pl', key: String(state.pl), label: '播放列表：' + plFilterName.value + '（按列表顺序）' })
  if (state.q) out.push({ kind: 'q', key: '', label: '搜索：' + state.q })
  for (const c of state.cats) out.push({ kind: 'cat', key: c, label: c })
  for (const r of state.ratings || []) {
    out.push({ kind: 'rating', key: r, label: '分级：' + ratingLabelOf(ratingOptions.value, r) })
  }
  for (const f of Object.keys(state.facets)) {
    const names = state.facets[f] || []
    for (const n of names) out.push({ kind: 'facet', facet: f, name: n, key: '', label: f + '：' + n })
  }
  const lab = (arr, k) => {
    const x = arr.find((a) => a.key === k)
    return x ? x.label : k
  }
  for (const n of state.studios || []) out.push({ kind: 'studio', name: n, key: '', label: '工作室：' + n })
  for (const k of state.durs) out.push({ kind: 'dur', key: k, label: '时长 ' + lab(DUR_BUCKETS, k) })
  for (const k of state.ress) out.push({ kind: 'res', key: k, label: lab(RES_TIERS, k) })
  for (const k of state.sizes) out.push({ kind: 'size', key: k, label: '体积 ' + lab(SIZE_BUCKETS, k) })
  if (state.unsafe) out.push({ kind: 'unsafe', key: '', label: '⚠ 可能无法播放' })
  return out
})

/** 最近观看：服务端 recent.videos 为主，localStorage['ms.recent'] 兜底（app.js:949-964） */
const recentItems = computed(() => {
  const out = []
  const seen = new Set()
  const map = byId.value
  const add = (id, pos, dur) => {
    if (!id || seen.has(id)) return
    const v = map.get(id)
    if (!v) return
    seen.add(id)
    out.push({ id, title: v.title, pos: pos || 0, dur: dur || v.dur || 0 })
  }
  for (const r of userState.recent.videos || []) add(r.id, r.pos, r.dur)
  for (const r of recentLocal.value) add(r.id, r.pos, r.dur)
  return out
})

/* =========================================================================
   P5.32：播放上下文（信息栏置顶「播放列表」+ 上/下一部 + 快捷键 P/N）
   ========================================================================= */

/**
 * P5.35：**来源页**带来的上下文参数 —— ?from=person&pname=<人物名>（也认 from/src + sname）。
 * 只有「来源类型 + 来源名」进 URL（可读、可刷新、可分享），有序 id 走 sessionStorage 快照
 * （人物名下可能几十条，塞进 URL 会把深链撑成几千字符，还会被各种转发截断）。
 */
const routeSource = computed(() => {
  const q = (route && route.query) || {}
  const one = (k) => {
    const v = q[k]
    const s = Array.isArray(v) ? v[0] : v
    return s == null ? '' : String(s)
  }
  const source = one('from') || one('src')
  const name = one('sname') || one('pname')
  return source ? { source, name } : null
})

/** sessionStorage 取用（隐私模式 / 非浏览器环境取不到 → null，按「没有快照」处理） */
function contextStore() {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null
  } catch {
    return null
  }
}

/**
 * 来源页留下的有序快照（P5.35）：对不上来源 / 来源名 / 有效期就返回 null。
 * null 时**整档来源都不参与**，标题与顺序一起回落到下一档 ——
 * 绝不出现「标题是人物名、顺序是全库」这种半吊子状态（刷新回退口径见 playbackContext 头部说明）。
 */
function sourceSnapshot() {
  const s = routeSource.value
  if (!s || s.source !== CTX_PERSON) return null
  const store = contextStore()
  return store ? readContextSnapshot(store, s.source, s.name) : null
}

/** 当前筛选 + 排序结果的完整有序 id（网格的完整顺序；visibleLimit 只是渲染分块，不影响顺序） */
const viewIds = computed(() => view.value.map((v) => v.id))
/** 全库索引序：深链进来、不在当前筛选里的片子仍能照旧上/下一部（既有行为，收成一档「其它」来源） */
const libraryIds = computed(() => videos.value.map((v) => v.id))
/** 「最近观看」条的顺序（网格之外唯一能点进播放器的入口） */
const recentIds = computed(() => recentItems.value.map((r) => r.id))

/**
 * 播放列表档的来源（P5.46）：**筛选维度优先**（它代表「用户此刻正在看的这个列表」），
 * 其次是 URL ?playlist=<id>（旧深链 / 其它页面带进来的上下文）。
 * 两档都要求列表里有当前片才算命中（由 pickPlaybackContext 统一判定，顺序与标题同进同出）。
 * @returns {{source:string, ids:string[], name:string, playlistId:string}|null}
 */
function playlistContextSource() {
  const d = plView.value
  if (state.pl && d && String(d.id) === String(state.pl) && Array.isArray(d.ids) && d.ids.length) {
    return { source: CTX_PLAYLIST, ids: d.ids, name: d.name, playlistId: d.id }
  }
  const pl = playlistCtx.value
  if (pl && Array.isArray(pl.ids) && pl.ids.length) {
    return { source: CTX_PLAYLIST, ids: pl.ids, name: pl.name, playlistId: pl.id }
  }
  return null
}

/**
 * 为某个 id 定上下文快照，来源优先级（P5.35：来源驱动，从哪里进来就按哪里的顺序与名字）：
 *   playlist > person > tag > browse > recent > library。
 * 每一档都必须「确实包含这部片」才算命中 —— 从播放列表点进来时永远先按该列表顺序走；
 * 从人物页点进来时按人物页的展示顺序走；按标签筛过就按该筛选结果走；
 * 都没有时的默认口径就是 browse（= 播放前页面的视频排序）。
 * 顺序与标题同进同出：某一档没命中（例如人物快照不在了）就连标题一起退，不留混搭。
 */
function contextFor(id, ignoreSource) {
  const sources = []
  const plc = playlistContextSource()
  if (plc) sources.push(plc)
  const snap = ignoreSource ? null : sourceSnapshot()
  if (snap) sources.push({ source: CTX_PERSON, ids: snap.ids, name: snap.name })
  // 标签档：只有「恰好一个筛选条件」才有名字可用（组合筛选 → 无名可用，回落到 browse）
  const tagName = filterSourceName(state)
  if (tagName) sources.push({ source: CTX_TAG, ids: viewIds.value, name: tagName })
  sources.push({ source: CTX_BROWSE, ids: viewIds.value })
  sources.push({ source: CTX_RECENT, ids: recentIds.value })
  sources.push({ source: CTX_LIBRARY, ids: libraryIds.value })
  return pickPlaybackContext(sources, id)
}

/** 分区标题行的悬停说明：这个顺序是怎么来的（标题本身只写来源名，不重复类型） */
function ctxSourceNote(source) {
  if (source === CTX_PLAYLIST) return '来自播放列表：顺序 = 该列表的自定义顺序'
  if (source === CTX_PERSON) return '来自人物页：顺序 = 该人物页展示的视频顺序'
  if (source === CTX_TAG) return '来自标签筛选：顺序 = 该筛选结果的顺序'
  if (source === CTX_RECENT) return '来自最近观看：顺序 = 最近观看顺序'
  if (source === CTX_LIBRARY) return '来自全库索引：顺序 = 索引顺序'
  return '顺序 = 播放前页面的视频排序'
}

/**
 * 信息栏置顶分区的数据模型：一行来源文案 + 行（序号用上下文真实下标，当前项高亮）。
 * P5.35：行里额外带时长（dur，索引里的原值）与缩略图 URL —— 缩略图复用 VideoCard 封面那一份
 * 构造（api.videoThumbUrl = /media/thumb/v/<id>，内容寻址），面板只负责 <img :src>。
 */
const ctxView = computed(() => {
  const c = pbCtx.value
  if (!c || c.index < 0) return null
  const map = byId.value
  const label = contextLabel(c)
  return {
    label: label,
    title: label + ' · ' + ctxSourceNote(c.source),
    source: c.source,
    name: c.name,
    total: c.total,
    index: c.index,
    rows: contextRows(c, (id) => {
      const v = map.get(id)
      if (!v) return null
      return { title: v.title || '#' + id, dur: v.dur, thumb: api.videoThumbUrl(id) }
    })
  }
})

/**
 * 上一部 / 下一部可用性：完全由上下文决定（越界即禁用，绝不跳到无关视频）。
 * 上下文缺失（索引没加载出来 / 来源列表为空）时两个方向都禁用。
 */
const navState = computed(() => (curVideo.value ? navFromContext(pbCtx.value) : navFromContext(null)))

/** 筛选/排序变化才算「换了一批卡片」：play 段不参与比较，避免看片回来丢位置（app.js:1661-1663） */
const filterSig = computed(() => buildHash(Object.assign({}, state, { play: '' })))

/* =========================================================================
   进度记忆
   ========================================================================= */

function loadPosMap() {
  const out = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || k.indexOf(KEY_POS) !== 0) continue
      const n = parseFloat(localStorage.getItem(k))
      if (isFinite(n) && n > 0) out[k.slice(KEY_POS.length)] = n
    }
  } catch {
    /* 忽略 */
  }
  posMap.value = out
}

function readPos(id) {
  const n = parseFloat(lsGet(KEY_POS + id))
  return isFinite(n) && n > 0 ? n : 0
}

function writePos(id, sec) {
  const v = Math.max(0, Math.round(sec))
  lsSet(KEY_POS + id, String(v))
  posMap.value = Object.assign({}, posMap.value, { [id]: v })
}

function clearPos(id) {
  lsDel(KEY_POS + id)
  const next = Object.assign({}, posMap.value)
  delete next[id]
  posMap.value = next
}

function loadRecent() {
  const raw = lsGet(KEY_RECENT)
  if (!raw) return []
  try {
    const a = JSON.parse(raw)
    if (!Array.isArray(a)) return []
    return a.filter((r) => r && typeof r.id === 'string')
  } catch {
    return []
  }
}

/** app.js:573-578：置顶 + 去重 + 最多 50 条 */
function pushRecentLocal(id, pos, dur) {
  const list = recentLocal.value.filter((r) => r.id !== id)
  list.unshift({ id, t: Date.now(), pos: Math.round(pos * 10) / 10, dur: Math.round(dur * 10) / 10 })
  recentLocal.value = list.slice(0, 50)
  lsSet(KEY_RECENT, JSON.stringify(recentLocal.value))
}

/* =========================================================================
   收藏 / 最近观看（服务端，等价 profile.js 的 fav 与 recent）
   ========================================================================= */

function normalizeUser(o) {
  const out = { profile: { nick: '我', avatar: null }, favorites: [], recent: { videos: [], photos: [] } }
  if (o && typeof o === 'object') {
    if (o.profile && typeof o.profile === 'object') {
      out.profile.nick = typeof o.profile.nick === 'string' && o.profile.nick.trim() ? o.profile.nick : '我'
      out.profile.avatar = typeof o.profile.avatar === 'string' ? o.profile.avatar : null
    }
    if (Array.isArray(o.favorites)) {
      out.favorites = o.favorites.filter((f) => f && (f.kind === 'video' || f.kind === 'photo'))
    }
    if (o.recent && typeof o.recent === 'object') {
      if (Array.isArray(o.recent.videos)) out.recent.videos = o.recent.videos.filter((r) => r && r.id)
      if (Array.isArray(o.recent.photos)) out.recent.photos = o.recent.photos.filter((r) => r && r.album != null)
    }
  }
  return out
}

async function loadUser() {
  try {
    const body = await api.getUser({ silent: true })
    const next = normalizeUser(body)
    userState.profile = next.profile
    userState.favorites = next.favorites
    userState.recent = next.recent
    userReady.value = true
  } catch {
    userReady.value = false
  }
}

function isFavVideo(id) {
  return (userState.favorites || []).some((f) => f && f.kind !== 'photo' && f.id === id)
}

const videosFavId = (f) => (f && f.kind !== 'photo' ? f.id : null)

/** 播放器收藏按钮态：随收藏列表与当前视频自动更新 */
const curFav = computed(() => !!(curVideo.value && isFavVideo(curVideo.value.id)))

/**
 * 收藏：乐观更新（星星立即响应）+ 服务端单条形态 {fav:{…,add}}，与 profile.js 报文一致。
 * P5.34：入口从播放器头部搬进信息栏之后补上**失败回滚 + toast** ——
 * 星星先亮后暗而没有任何提示，等于让用户以为收藏成功了（列表卡片的 ☆ 也吃这一条）。
 */
function toggleFav(v) {
  if (!v) return
  const entry = { kind: 'video', id: v.id, title: v.title, thumb: 'thumbs/v/' + v.id + '.jpg', t: Date.now() }
  const add = !isFavVideo(v.id)
  const before = userState.favorites || []
  const rest = before.filter((f) => videosFavId(f) !== v.id)
  userState.favorites = add ? [entry].concat(rest).slice(0, 2000) : rest
  if (!userReady.value) loadUser()
  api.saveUser({ fav: Object.assign({}, entry, { add }) }, { silent: true }).catch(() => {
    // 回滚到点击前的那一份（before 是不可变数组，直接赋回即可）
    userState.favorites = before
    showToast(add ? '收藏保存失败，已撤销' : '取消收藏失败，已撤销')
  })
}

/** 服务端最近观看（app.js:985-998 的 pushRecentServer；force 用于播完写 pos=0） */
function onPushRecent(payload) {
  const v = byId.value.get(payload.id)
  if (!v) return
  if (!payload.force && !(payload.pos > 0.5)) return
  const entry = {
    kind: 'video',
    id: v.id,
    title: v.title,
    thumb: 'thumbs/v/' + v.id + '.jpg',
    t: Date.now(),
    pos: Math.round((payload.pos || 0) * 10) / 10,
    dur: Math.round((payload.dur || 0) * 10) / 10
  }
  userState.recent.videos = [entry]
    .concat((userState.recent.videos || []).filter((r) => !(r && r.id === v.id)))
    .slice(0, 50)
  api.saveUser({ recent: entry }, { silent: true }).catch(() => {
    /* 失败静默 */
  })
}

function onSavePos(payload) {
  writePos(payload.id, payload.pos)
  pushRecentLocal(payload.id, payload.pos, payload.dur)
}

function onClearPos(id) {
  clearPos(id)
}

/** 首次加载：服务端 recent 为空且本地有旧记录 → 一次性迁移（最多 20 条）后清掉本地键（app.js:825-847） */
function maybeMigrateRecent() {
  if (recentMigrated || !userReady.value || !byId.value.size) return
  const local = loadRecent()
  if (!local.length) {
    recentMigrated = true
    return
  }
  const srv = userState.recent.videos || []
  if (srv.length) {
    recentMigrated = true
    return
  }
  recentMigrated = true
  local.slice(0, 20).forEach((r, i) => {
    const v = byId.value.get(r.id)
    if (!v) return
    setTimeout(() => {
      onPushRecent({ id: v.id, pos: r.pos || 0, dur: r.dur || v.dur || 0, force: true })
    }, i * 120)
  })
  recentLocal.value = []
  lsDel(KEY_RECENT)
}

/* =========================================================================
   hash 同步（筛选 / 排序 / 播放深链）
   ========================================================================= */

function writeHash() {
  const h = buildHash(state)
  if (window.location.hash === h) return
  try {
    // P5.46：state 必须原样带回 —— 传 null 会让 vue-router 的 history 状态丢失
    // （控制台会 warn「history.state seems to have been manually replaced」），
    // 前进 / 后退时的路由状态也不再可靠。只改 URL，不动 state。
    history.replaceState(history.state, '', window.location.pathname + window.location.search + h)
  } catch {
    window.location.hash = h // history API 不可用时的兜底
  }
}

watch([filterSig, () => state.play], writeHash)

function onHashChange() {
  // 只在外部（手改地址栏 / 前进后退）改动时同步，避免与 writeHash 互相触发
  const next = parseHash(window.location.hash)
  if (buildHash(next) === buildHash(state)) return
  const wantPlay = next.play || ''
  const playChanged = wantPlay !== (state.play || '')
  Object.assign(state, next)
  if (!playChanged) return
  if (!wantPlay) closePlayer()
  else if (byId.value.has(wantPlay)) openPlayer(wantPlay)
  else {
    state.play = ''
    writeHash()
  }
}

function openFromHash() {
  const id = state.play
  if (!id) return
  if (!byId.value.has(id)) {
    state.play = ''
    writeHash()
    return
  }
  openPlayer(id)
}

/* =========================================================================
   交互
   ========================================================================= */

function toggleIn(arr, k) {
  const i = arr.indexOf(k)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(k)
  return arr
}

/** 刷新时随机一种排序（随机项本身除外）并固定进 hash：后续刷新保持、不再随机 */
function pickRandomSort() {
  const k = SORT_POOL[Math.floor(Math.random() * SORT_POOL.length)] || 'added'
  state.sort = k
  state.sortPinned = true
}

function randomRank() {
  if (randRank && randRank.size === videos.value.length) return randRank
  const ids = shuffleInPlace(videos.value.map((v) => v.id))
  randRank = new Map()
  ids.forEach((id, i) => randRank.set(id, i))
  return randRank
}

function onSortChange(e) {
  state.sort = e.target.value
  state.sortPinned = true // 手动选过就写进 hash，刷新保持
}

function onToggleQuick(field, key) {
  toggleIn(state[field], key)
}

function onToggleCat(c) {
  toggleIn(state.cats, c)
  // 移动端：选完分类即收起抽屉（与原手写页一致）；桌面端不关，便于继续调其它筛选
  if (isMobile.value) closeDrawer()
}

/** facet 勾选：切到「选中」才上报 tag_click（facet:值），取消勾选不上报（app.js:1361-1374） */
function onFacetToggle(facet, name) {
  const arr = state.facets[facet] || (state.facets[facet] = [])
  toggleIn(arr, name)
  if (arr.indexOf(name) >= 0) tk.track('tag_click', 'tag', (facet + ':' + name).slice(0, 64), 0, 0)
  if (!arr.length) delete state.facets[facet]
}

function removeActive(x) {
  if (x.kind === 'pl') {
    applyPlaylistFilter('')
    return
  }
  if (x.kind === 'q') {
    state.q = ''
    searchInput.value = ''
  } else if (x.kind === 'cat') toggleIn(state.cats, x.key)
  else if (x.kind === 'facet') {
    const arr = state.facets[x.facet] || []
    toggleIn(arr, x.name)
    if (!arr.length) delete state.facets[x.facet]
  } else if (x.kind === 'studio') {
    const arr = state.studios || (state.studios = [])
    toggleIn(arr, x.name)
  } else if (x.kind === 'rating') toggleIn(state.ratings || (state.ratings = []), x.key)
  else if (x.kind === 'dur') toggleIn(state.durs, x.key)
  else if (x.kind === 'res') toggleIn(state.ress, x.key)
  else if (x.kind === 'size') toggleIn(state.sizes, x.key)
  else if (x.kind === 'unsafe') state.unsafe = false
}

function clearAll() {
  const play = state.play // 清空筛选不打断正在播放的深链
  Object.assign(state, defaultState())
  state.play = play || ''
  searchInput.value = ''
}

/* =========================================================================
   保存的筛选（P2-B）：GET / POST / DELETE /api/media/filters
   降级约定：接口未就绪（后端 P2-A 未部署）时列表区只显示一句提示，
   保存 / 删除失败仅 toast；筛选状态与列表本身完全不受影响。
   ========================================================================= */

const savedFilters = ref([])
const savedLoading = ref(false)
/** 非空时抽屉列表区显示该提示（读取失败 / 后端未就绪） */
const savedUnavailable = ref('')

/** 归一化服务端返回：裸数组或 { list | items }，条目只保留 id / name / params */
function normalizeFilters(res) {
  const list = Array.isArray(res) ? res : (res && (res.list || res.items)) || []
  const out = []
  for (const it of list) {
    if (!it || it.id == null || !it.name) continue
    const params = it.params && typeof it.params === 'object' && !Array.isArray(it.params) ? it.params : {}
    out.push({ id: String(it.id), name: String(it.name), params })
  }
  return out
}

function loadSavedFilters() {
  savedLoading.value = true
  return api
    .listFilters({ silent: true })
    .then((res) => {
      savedFilters.value = normalizeFilters(res)
      savedUnavailable.value = ''
    })
    .catch(() => {
      savedFilters.value = []
      savedUnavailable.value = '保存筛选暂不可用'
    })
    .finally(() => {
      savedLoading.value = false
    })
}

/** 当前筛选状态 → 可存储的 params（字段与 URL hash 一一对应） */
function currentFilterParams() {
  const out = {}
  if (state.q) out.q = state.q
  if (state.cats.length) out.cats = state.cats.slice()
  const facets = {}
  for (const f of Object.keys(state.facets || {})) {
    if ((state.facets[f] || []).length) facets[f] = state.facets[f].slice()
  }
  if (Object.keys(facets).length) out.facets = facets
  if (state.durs.length) out.durs = state.durs.slice()
  if (state.ress.length) out.ress = state.ress.slice()
  if (state.sizes.length) out.sizes = state.sizes.slice()
  // 工作室（P5-A）：与其它筛选一样进「保存筛选」的 params
  if ((state.studios || []).length) out.studios = state.studios.slice()
  if ((state.ratings || []).length) out.ratings = state.ratings.slice()
  if (state.unsafe) out.unsafe = true
  if (state.sort) out.sort = state.sort
  return out
}

/** 快捷筛选 key → 中文标签（与 QuickFilters 渲染的一致） */
function bucketLabel(buckets, key) {
  const hit = buckets.find((b) => b.key === key)
  return hit ? hit.label : key
}

/** 默认名称：按当前条件自动拼，如「1080p · ASMR · 有进度优先」 */
const suggestSavedName = computed(() => {
  const parts = []
  if (state.q) parts.push(state.q)
  for (const c of state.cats) parts.push(c)
  for (const k of state.ress) parts.push(bucketLabel(RES_TIERS, k))
  for (const k of state.durs) parts.push(bucketLabel(DUR_BUCKETS, k))
  for (const k of state.sizes) parts.push(bucketLabel(SIZE_BUCKETS, k))
  for (const n of state.studios || []) parts.push(n)
  for (const r of state.ratings || []) parts.push(ratingLabelOf(ratingOptions.value, r))
  for (const f of Object.keys(state.facets || {})) for (const n of state.facets[f] || []) parts.push(n)
  if (state.unsafe) parts.push('可能无法播放')
  if (state.sort && state.sortPinned) {
    const s = SORTS.find((x) => x.key === state.sort)
    if (s) parts.push(s.label)
  }
  if (!parts.length) return '全部视频'
  const name = parts.join(' · ')
  return name.length > 60 ? name.slice(0, 59) + '…' : name
})

/** 应用：把 params 还原到筛选状态。hash 改由既有的 watch(filterSig) → writeHash 完成，
    列表重算 / 分块与滚动记忆重置也由既有 watch(filterSig) 负责，这里不重复实现。 */
function onApplySavedFilter(item) {
  if (!item) return
  const p = item.params || {}
  const play = state.play // 应用筛选不打断正在播放的深链
  const next = defaultState()
  if (typeof p.q === 'string') next.q = p.q
  next.cats = Array.isArray(p.cats) ? p.cats.map(String) : []
  const facets = {}
  if (p.facets && typeof p.facets === 'object' && !Array.isArray(p.facets)) {
    for (const k of Object.keys(p.facets)) {
      const arr = Array.isArray(p.facets[k]) ? p.facets[k].map(String) : []
      if (arr.length) facets[k] = arr
    }
  }
  next.facets = facets
  const pickKeys = (arr, buckets) => {
    const allowed = buckets.map((b) => b.key)
    return Array.isArray(arr) ? arr.map(String).filter((k) => allowed.indexOf(k) >= 0) : []
  }
  next.durs = pickKeys(p.durs, DUR_BUCKETS)
  next.ress = pickKeys(p.ress, RES_TIERS)
  next.sizes = pickKeys(p.sizes, SIZE_BUCKETS)
  next.studios = Array.isArray(p.studios) ? p.studios.map(String) : []
  next.ratings = Array.isArray(p.ratings) ? p.ratings.map(String) : []
  next.unsafe = !!p.unsafe
  if (p.sort && SORTS.some((s) => s.key === p.sort)) {
    next.sort = p.sort
    next.sortPinned = true // 存下来的排序即用户选定，恢复后写进 hash
  }
  Object.assign(state, next)
  state.play = play || ''
  searchInput.value = state.q
  showToast('已应用筛选「' + item.name + '」')
  if (isMobile.value) closeDrawer()
}

/** 保存：同名覆盖时明确提示（后端按 name 去重） */
function onSaveFilter(name) {
  const text = String(name || '').trim()
  if (!text) {
    showToast('请填写筛选名称')
    return
  }
  const existed = savedFilters.value.some((it) => it.name === text)
  api
    .saveFilter({ name: text, params: currentFilterParams() }, { silent: true })
    .then(() => {
      showToast(existed ? '已覆盖同名筛选「' + text + '」' : '已保存筛选「' + text + '」')
      savedUnavailable.value = ''
      loadSavedFilters()
    })
    .catch(() => {
      showToast('保存筛选失败：' + (savedUnavailable.value || '请稍后重试'))
    })
}

function onDeleteSavedFilter(item) {
  if (!item || item.id == null) return
  api
    .deleteFilter(item.id, { silent: true })
    .then(() => {
      showToast('已删除筛选「' + item.name + '」')
      loadSavedFilters()
    })
    .catch(() => {
      showToast('删除筛选失败：' + (savedUnavailable.value || '请稍后重试'))
    })
}

/* =========================================================================
   筛选抽屉（桌面与移动共用）
   滚动锁由下方 [curVideo, drawerOpen] 的 watch 统一处理；
   这里只管开关、焦点进出与 Tab 循环。
   ========================================================================= */

/** 抽屉内可聚焦元素（跳过不可见 / 禁用项） */
function drawerFocusables() {
  const box = drawerEl.value
  if (!box) return []
  const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  return Array.prototype.filter.call(box.querySelectorAll(sel), (el) => el.offsetParent !== null || el === document.activeElement)
}

function openDrawer() {
  if (drawerOpen.value) return
  // 播放器浮层（fixed inset:0、z-index 100）独占视口：此时不打开抽屉，
  // 避免抽屉遮罩(200)压在全屏播放器之上、把播放器内部交互挡死
  if (curVideo.value) return
  drawerOpen.value = true
  loadSavedFilters()
  nextTick(() => {
    const list = drawerFocusables()
    if (list.length) list[0].focus()
    else if (drawerEl.value) drawerEl.value.focus()
    // 移动端：抽屉里才有的「快捷筛选」默认不在视口内，滚动到它
    if (isMobile.value && sidebarRef.value) sidebarRef.value.scrollToQuick()
  })
}

function closeDrawer() {
  if (!drawerOpen.value) return
  drawerOpen.value = false
  // 焦点回到触发按钮（触发按钮可能已不可见，focus 会被浏览器忽略，属预期）
  if (filterBtnEl.value) filterBtnEl.value.focus()
}

function onFilterToggle() {
  if (drawerOpen.value) closeDrawer()
  else openDrawer()
}

/** Tab / Shift+Tab 在抽屉内循环，避免焦点漏到被遮罩的页面上 */
function onDrawerKeydown(e) {
  if (e.key !== 'Tab') return
  const list = drawerFocusables()
  if (!list.length) return
  const first = list[0]
  const last = list[list.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || !drawerEl.value.contains(active))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (active === last || !drawerEl.value.contains(active))) {
    e.preventDefault()
    first.focus()
  }
}

function toggleCols() {
  cols3.value = !cols3.value
  lsSet(KEY_COLS, cols3.value ? '3' : '2')
}

function closeRecent() {
  lsSet(KEY_RECENT_CLOSED, '1')
  recentClosed.value = true
}

/* =========================================================================
   搜索（筛选防抖 80ms；埋点单独去抖 700ms，IME 组合期不上报，同词只报一次）
   ========================================================================= */

function onSearchInput(e) {
  const val = e.target.value
  searchInput.value = val
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    state.q = val.trim()
  }, 80)
  scheduleSearchTrack()
}

function onCompositionStart() {
  composing.value = true
}

function onCompositionEnd(e) {
  composing.value = false
  searchInput.value = e.target.value
  scheduleSearchTrack()
}

function reportSearch() {
  tkSearchTimer = 0
  const q = String(searchInput.value == null ? '' : searchInput.value)
    .trim()
    .slice(0, 64)
  if (!q || q === tkSearchLast) return
  tkSearchLast = q
  tk.track('search', 'keyword', q, 0, 0)
}

function scheduleSearchTrack() {
  if (composing.value) return
  clearTimeout(tkSearchTimer)
  tkSearchTimer = setTimeout(reportSearch, 700)
}

function onSearchKeydown(e) {
  if (e.key === 'Enter') {
    if (composing.value) return
    clearTimeout(tkSearchTimer)
    reportSearch()
    return
  }
  if (e.key === 'Escape') {
    searchInput.value = ''
    state.q = ''
  }
}

watch(
  () => state.q,
  (q) => {
    if (q !== searchInput.value) searchInput.value = q
  }
)

/* =========================================================================
   播放器
   ========================================================================= */

/** P5.4：卡片上的人物 chip（含素人）点了 → 该人物详情页（/media/person/:id 路由 P3 已有） */
function openPerson(id) {
  if (id == null || String(id) === '') return
  router.push('/media/person/' + encodeURIComponent(String(id)))
}

/**
 * 打开播放器。
 * @param {string} id 目标视频 id
 * @param {object} [reuseCtx] 在**同一上下文内**换片时把上一份快照传回来（面板点击 / 上/下一部）；
 *   缺省按来源优先级重新定一份（网格卡片 / 最近观看 / 深链都走这条）
 * @param {{ignoreSource?:boolean}} [opts] P5.35：忽略 URL 上的来源参数（网格卡片点开时用，见 openFromGrid）
 */
function openPlayer(id, reuseCtx, opts) {
  const v = byId.value.get(id)
  if (!v) return
  // P5.23：右栏常驻 → 打开播放器即预热信息栏所需的两份数据（标签库 / 人物库）
  ensureMetaData()
  startPos.value = readPos(v.id)
  // P5.23：信息栏常驻 → 抽屉在播放器打开时就挂载（:key 换片重建），
  // 「在当前时间加标记」的起手位置因此取这一部的起始位置，而不是等用户点「信息」。
  metaAtSec.value = startPos.value || 0
  // P4.3：换片先取该 videoId 的标记缓存（抽屉曾经读到过的标记），有缓存就能立刻画刻度；
  // 没缓存就是空数组（不画刻度），等抽屉读到后再回填 —— 绝不显示上一部片的刻度。
  playerMarkers.value = readMarkerCache(markerStorage(), v.id)
  curVideo.value = v
  openSeq.value += 1
  // 上下文快照：同一上下文内换片沿用原 ids（只重算 index），否则按优先级重新定
  const base = reuseCtx && Array.isArray(reuseCtx.ids) ? reuseCtx : null
  pbCtx.value = base
    ? makePlaybackContext(base.ids, v.id, {
        source: base.source,
        name: base.name,
        playlistId: base.playlistId
      })
    : contextFor(v.id, !!(opts && opts.ignoreSource))
  state.play = v.id
  writeHash()
}

/**
 * 网格 / 最近观看里点开一部片（P5.35）：用户此刻是从列表页选的片，
 * 人物页带来的来源参数（?from=person&pname=…）就不再代表「这次是从哪里进来的」——
 * 本次上下文忽略它，并把参数从地址栏去掉（刷新 / 后退都不会复活）。
 * 深链开播（openFromHash）不走这里：那时 from 参数就是真实的来源。
 */
function openFromGrid(id) {
  openPlayer(id, null, { ignoreSource: true })
  if (routeSource.value) {
    const q = Object.assign({}, route.query)
    delete q.from
    delete q.src
    delete q.pname
    delete q.sname
    router.replace({ path: route.path, query: q, hash: window.location.hash || undefined }).catch(() => {})
  }
}

function closePlayer() {
  curVideo.value = null
  pbCtx.value = null
  if (state.play) {
    state.play = ''
    writeHash()
  }
}

/**
 * 上/下一部（控制条 ⏮⏭ 与快捷键 P/N 共用）：只走当前上下文顺序，越界直接不动。
 * 上下文里个别 id 在索引中缺失（视频下架 / 索引未加载完）时顺着同一方向跳过它们，
 * 但绝不跳到上下文之外的视频。
 */
function step(dir) {
  if (!curVideo.value) return
  const map = byId.value
  let cur = pbCtx.value
  while (cur && cur.index >= 0) {
    const next = stepContextId(cur, dir)
    if (!next) return // 越界：按钮已禁用，这里也不动
    if (map.has(next)) {
      openPlayer(next, pbCtx.value)
      return
    }
    // 目标 id 不在索引里（下架 / 索引未加载完）：把游标推到它上面，继续同方向找
    cur = Object.assign({}, cur, { index: cur.ids.indexOf(next) })
  }
}

/** 信息栏置顶分区点了某一条：切到该片，上下文保持（只换 index） */
function playFromContext(id) {
  if (!id) return
  if (curVideo.value && curVideo.value.id === id) return
  openPlayer(id, pbCtx.value)
}

function loadQ() {
  const v = lsGet(KEY_Q)
  return ['orig', '720', '480', '360'].indexOf(v) >= 0 ? v : 'orig'
}

function onQualityChange(q) {
  quality.value = q
  lsSet(KEY_Q, q)
}

/* =========================================================================
   分块渲染（176 张卡片：先渲染 CHUNK 张，滚动到哨兵时再追加）
   ========================================================================= */

let io = null

function loadMore() {
  if (visibleLimit.value >= view.value.length) return
  visibleLimit.value = Math.min(view.value.length, visibleLimit.value + CHUNK)
  nextTick(() => {
    const el = sentinelEl.value
    if (el && el.getBoundingClientRect().top < window.innerHeight + 600) loadMore()
  })
}

watch(sentinelEl, (el) => {
  if (io) {
    io.disconnect()
    io = null
  }
  if (!el || typeof IntersectionObserver === 'undefined') return
  io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore()
    },
    { rootMargin: '600px 0px' }
  )
  io.observe(el)
})

/** 上一次的筛选签名：首帧不比较（app.js:888-890 用 lastSig !== null 达成同一效果） */
let lastSig = null

watch(filterSig, (sig) => {
  if (lastSig !== null && sig !== lastSig) {
    visibleLimit.value = CHUNK
    clearScrollMem()
    nextTick(loadMore)
  }
  lastSig = sig
})

/* =========================================================================
   滚动位置记忆（同 hash 才恢复，app.js:1641-1663）
   ========================================================================= */

let scrollWriteT = 0
let scrollTailT = 0

function saveScroll() {
  lsSet(KEY_SCROLL, JSON.stringify({ hash: window.location.hash, y: Math.round(window.scrollY) }))
}

function onScroll() {
  const now = Date.now()
  if (now - scrollWriteT >= 200) {
    scrollWriteT = now
    saveScroll()
    return
  }
  clearTimeout(scrollTailT)
  scrollTailT = setTimeout(() => {
    scrollWriteT = Date.now()
    saveScroll()
  }, 200)
}

function clearScrollMem() {
  clearTimeout(scrollTailT)
  lsDel(KEY_SCROLL)
}

function restoreScroll() {
  const raw = lsGet(KEY_SCROLL)
  if (!raw) return
  let o = null
  try {
    o = JSON.parse(raw)
  } catch {
    return
  }
  if (!o || typeof o.y !== 'number' || !isFinite(o.y) || o.hash !== window.location.hash) return
  const y = Math.max(0, o.y)
  // 分块渲染下先铺满，否则恢复位置会被截断
  visibleLimit.value = view.value.length
  requestAnimationFrame(() => {
    setTimeout(() => window.scrollTo(0, y), 0)
  })
}

/* =========================================================================
   媒体库组织（M3）：卡片多选 + 批量写入 + 单条信息抽屉
   约定：不走播放链路——所有写接口 silent + try/catch，失败只 toast 提示；
        写入成功后先在 metaOverrides 上做乐观更新（卡片立刻变），再让受影响项各自以服务端值为准。
   ========================================================================= */

const EMPTY_META = { rating: 0, tags: [] }
/** 稳定空数组引用：人物 / 演员缺省时复用同一个，避免每帧给卡片新建 props */
const EMPTY_LIST = []

/**
 * 卡片展示用的组织信息：本地覆盖层优先，其次索引里带的 rating / tags。
 * 按 id 预计算成表（只在索引或覆盖层变化时重算），避免每次页面渲染都给每张卡片新建对象，
 * 否则 176 张卡片的 props 全部变化，滚动/输入时会整体重渲染。
 */
const cardMetaMap = computed(() => {
  const out = {}
  const localMode = isLocal.value
  // 依赖版本号：本地覆盖写入后卡片要跟着变
  if (localMode) void localOrgVersion.value
  for (const v of videos.value) {
    // 合并顺序：索引 → 本地覆盖 → 渲染（local 档）；full 档沿用服务端写回/乐观覆盖
    out[v.id] = localMode
      ? mergeCardMeta(v, readLocalMeta(v.id))
      : metaOverrides[v.id] || { rating: Number(v.rating) || 0, tags: v.tags || [] }
  }
  // 覆盖层里可能出现不在当前索引/筛选结果中的 id（批量后切换筛选、抽屉里改完再回列表）：
  // 一并算进来，保证索引为空时也能响应覆盖层变化
  for (const id of Object.keys(metaOverrides)) {
    if (!out[id]) out[id] = metaOverrides[id]
  }
  return out
})

function cardMeta(v) {
  const m = cardMetaMap.value[v.id] || EMPTY_META
  if (!m.tags || !m.tags.length) {
    const names = Array.isArray(v.dictTags) ? v.dictTags : []
    if (names.length) return Object.assign({}, m, { tags: names.map((x) => ({ name: x, color: '' })) })
  }
  return m
}

/* ------------------------------------------------------------ 卡片人物（P5.3-B） */
/* 优先级：local 覆盖（ms.orgpersons.*）→ 抽屉写回的覆盖（personsOverrides）→ 索引 videos[].persons。
   「素人」是真实人物，不做特殊处理；索引里 persons 为空时卡片按 personRules.isAmateur 兜底。 */
const personsOverrides = reactive({})

const cardPersonsMap = computed(() => {
  const out = {}
  const localMode = isLocal.value
  // 依赖版本号：本地演员覆盖写入后卡片要跟着变
  if (localMode) void localOrgVersion.value
  for (const v of videos.value) {
    const localRec = localMode ? readLocalPersons(v.id) : null
    out[v.id] = (localRec && localRec.persons) || personsOverrides[v.id] || v.persons || EMPTY_LIST
  }
  // 覆盖层里可能有不在当前筛选结果里的 id（抽屉改完再切筛选）：保证卡片照样拿到最新值
  for (const id of Object.keys(personsOverrides)) {
    if (!out[id]) out[id] = personsOverrides[id]
  }
  return out
})

function cardPersons(v) {
  return cardPersonsMap.value[v.id] || EMPTY_LIST
}

/**
 * 标签库：GET /api/media/tags（匿名只读）
 * 接口未就绪时只把列表清空（选择器显示「无匹配标签」），announce 为真时才弹提示，
 * 避免页面首屏就出现一次失败提示。local 档额外并入本机新建的标签。
 */
async function loadTags(announce) {
  if (tagsLoading.value) return
  tagsLoading.value = true
  try {
    const body = await api.listTags({ silent: true })
    const list = Array.isArray(body) ? body : body && Array.isArray(body.tags) ? body.tags : []
    const server = list.filter((t) => t && t.id != null && t.name)
    allTags.value = isLocal.value ? server.concat(readLocalTags()) : server
  } catch {
    allTags.value = isLocal.value ? readLocalTags() : []
    if (announce) showToast('标签库加载失败：接口未就绪')
  } finally {
    tagsLoading.value = false
  }
}

function onTagCreated(tag) {
  if (!tag || tag.id == null) return
  if (!allTags.value.some((t) => t.id === tag.id)) allTags.value = allTags.value.concat([tag])
}

function toggleSelectMode() {
  if (readOnlyEdit.value) return
  if (selectMode.value) {
    exitSelectMode()
    return
  }
  selectMode.value = true
  selectAnchor.value = -1
  if (!allTags.value.length) loadTags(true)
}

function exitSelectMode() {
  selectMode.value = false
  clearSelection()
}

function clearSelection() {
  selectedIds.value = []
  selectAnchor.value = -1
}

/**
 * 卡片点击（选择模式）：Shift 连选按当前可见顺序取区间，其余为单项切换。
 * 总数受 MAX_BATCH 约束，超出的新增忽略并提示。
 */
function onCardSelect(id, shift) {
  const list = visibleVideos.value
  const idx = list.findIndex((v) => v.id === id)
  // 只接受当前可见卡片的选择（未知 id / 已不在结果里的卡片直接忽略）
  if (idx < 0) return

  if (shift && selectAnchor.value >= 0 && idx >= 0) {
    const a = Math.min(selectAnchor.value, idx)
    const b = Math.max(selectAnchor.value, idx)
    const cur = new Set(selectedIds.value)
    const add = []
    for (let i = a; i <= b; i++) {
      const vid = list[i].id
      if (!cur.has(vid) && add.indexOf(vid) < 0) add.push(vid)
    }
    if (cur.size + add.length > MAX_BATCH) {
      showToast('最多选择 ' + MAX_BATCH + ' 项')
      selectAnchor.value = idx
      return
    }
    selectedIds.value = selectedIds.value.concat(add)
    selectAnchor.value = idx
    return
  }

  if (selectedIds.value.indexOf(id) >= 0) {
    selectedIds.value = selectedIds.value.filter((x) => x !== id)
  } else {
    if (selectedIds.value.length >= MAX_BATCH) {
      showToast('最多选择 ' + MAX_BATCH + ' 项')
      return
    }
    selectedIds.value = selectedIds.value.concat([id])
  }
  selectAnchor.value = idx
}

/** 全选：当前筛选结果（不是全库），同样受 MAX_BATCH 限制 */
function selectAllVisible() {
  const ids = view.value.slice(0, MAX_BATCH).map((v) => v.id)
  selectedIds.value = ids
  selectAnchor.value = -1
  if (view.value.length > MAX_BATCH) showToast('已选前 ' + MAX_BATCH + ' 项（单次上限）')
}

/** 索引里的标签是 [facet, name] 成对数组（也可能是名称字符串）：统一成 {id?,name,color} */
function indexTagsToObjects(list) {
  const out = []
  for (const t of list || []) {
    if (typeof t === 'string') out.push({ name: t, color: '' })
    else if (Array.isArray(t)) out.push({ name: t[1] || t[0], color: '' })
    else if (t && t.name) out.push({ id: t.id, name: t.name, color: t.color || '' })
  }
  return out
}

/**
 * 一次批量写入后的 { rating, tags }（纯计算）
 * full 档的乐观覆盖与 local 档的落盘共用同一套标签合并规则。
 */
function computeBatchMeta(cur, patch, tagById) {
  // 索引里的标签是名称字符串，元信息接口给的是 {id,name,color}：取值键两种都兼容
  const keyOf = (x) => (typeof x === 'string' ? x : x && x.id != null ? x.id : x && x.name)
  const nameOf = (x) => (typeof x === 'string' ? x : x && x.name)
  const removedIds = Array.isArray(patch.removeTagIds) ? patch.removeTagIds : []
  const removedNames = new Set(removedIds.map((tid) => (tagById.get(tid) ? tagById.get(tid).name : null)).filter(Boolean))
  let tags = Array.isArray(cur.tags) ? cur.tags.slice() : []

  if (Array.isArray(patch.addTagIds)) {
    for (const tid of patch.addTagIds) {
      const t = tagById.get(tid) || { id: tid, name: String(tid) }
      const dup = tags.some((x) => keyOf(x) === t.id || (t.name && nameOf(x) === t.name))
      if (!dup) tags.push(t)
    }
  }
  if (removedIds.length) {
    tags = tags.filter((x) => {
      const k = keyOf(x)
      if (k != null && removedIds.indexOf(k) >= 0) return false
      return !removedNames.has(nameOf(x))
    })
  }

  const rating = Object.prototype.hasOwnProperty.call(patch, 'rating') ? Number(patch.rating) || 0 : Number(cur.rating) || 0
  return { rating, tags }
}

/** full 档乐观更新：把一次批量写入的结果落到 metaOverrides 上 */
function applyLocalBatch(ids, patch) {
  const tagById = new Map(allTags.value.map((t) => [t.id, t]))
  for (const id of ids) {
    const v = byId.value.get(id)
    const cur = metaOverrides[id] || { rating: Number(v && v.rating) || 0, tags: indexTagsToObjects(v && v.tags) }
    metaOverrides[id] = computeBatchMeta(cur, patch, tagById)
  }
}

/** local 档写入：只落 localStorage（ms.org.<ownerKey>.<videoId>），不发任何请求 */
function applyLocalBatchStore(ids, patch) {
  const tagById = new Map(allTags.value.map((t) => [t.id, t]))
  for (const id of ids) {
    const v = byId.value.get(id)
    const cur = readLocalMeta(id) || { rating: Number(v && v.rating) || 0, tags: indexTagsToObjects(v && v.tags) }
    const next = computeBatchMeta(cur, patch, tagById)
    // 只落这次真正改动的字段：没动评分就不把索引里的评分「钉死」进本地覆盖
    const localPatch = { tags: next.tags }
    if (Object.prototype.hasOwnProperty.call(patch, 'rating')) localPatch.rating = next.rating
    writeLocalMeta(id, localPatch)
  }
}

/** 「清除本地修改」：清掉本机全部 ms.org.* 与本地标签 */
function onClearLocal() {
  // P5.3-B：本机演员覆盖（ms.orgpersons.*）与 ms.org.* / 本地标签一起清
  // P5.38：本机简介覆盖（ms.orgsynopsis.*）同理
  const n = clearLocalOrg() + clearAllLocalPersons() + clearAllLocalSynopsis()
  for (const id of Object.keys(metaOverrides)) delete metaOverrides[id]
  for (const id of Object.keys(personsOverrides)) delete personsOverrides[id]
  showToast(n ? '已清除本地修改（' + n + ' 项）' : '没有本地修改')
}

/**
 * 批量写入：
 *   local 档 —— 只写 localStorage，不调用任何写接口；
 *   full 档  —— 一次请求覆盖全部选中项：POST /api/media/videos/batch-meta
 *               body { ids, addTagIds?, removeTagIds?, rating? } → { updated }
 */
async function applyBatchMeta(patch, okText) {
  if (batchBusy.value || readOnlyEdit.value) return
  const ids = selectedIds.value.slice()
  if (!ids.length) {
    showToast('请先选择视频')
    return
  }
  if (ids.length > MAX_BATCH) {
    showToast('最多选择 ' + MAX_BATCH + ' 项')
    return
  }
  if (isLocal.value) {
    applyLocalBatchStore(ids, patch)
    showToast((okText || '批量更新') + '：' + ids.length + ' 项已本地保存（仅本浏览器）')
    return
  }
  batchBusy.value = true
  try {
    const body = await api.batchVideoMeta(Object.assign({ ids }, patch), { silent: true })
    const n = body && typeof body.updated === 'number' ? body.updated : ids.length
    applyLocalBatch(ids, patch)
    showToast((okText || '批量更新') + '：' + n + ' 项已更新')
  } catch {
    // 接口未就绪 / 网络异常：只提示，不动卡片状态，也不影响播放
    showToast('批量更新失败：接口未就绪或网络异常')
  } finally {
    batchBusy.value = false
  }
}

/**
 * P5.23：信息栏常驻右侧 —— 标签库 / 人物库在「播放器打开」时就预热，
 * 面板内容始终挂载，展开只是把右栏宽度从 0 拉回来（状态在 MediaPlayer 里）。
 * 标签库 / 人物库都是按需拉一次（已有缓存 / 加载中不重复拉）。
 */
function ensureMetaData() {
  if (!allTags.value.length) loadTags(false)
  if (!personList.value && !personsLoading.value) loadPersonsFacet()
}

/** 播放器头部「信息」按钮 → 展开右栏（并刷新「在当前时间加标记」的起手位置） */
function openMeta() {
  // 「在当前时间加标记」的起手位置：播放器暴露 getCurrentTime（见 MediaPlayer defineExpose）
  const pl = playerRef.value
  metaAtSec.value = pl && typeof pl.getCurrentTime === 'function' ? pl.getCurrentTime() : 0
  ensureMetaData()
  if (pl && typeof pl.openSide === 'function') pl.openSide()
}

/** 面板头部按钮（停靠态显示为「› 收起」）→ 折叠右栏，视频随即整宽 */
function closeMeta() {
  const pl = playerRef.value
  if (pl && typeof pl.closeSide === 'function') pl.closeSide()
}

/**
 * 单条抽屉写成功：
 *   local 档 —— 抽屉已写入 localStorage，这里只需让卡片按本地覆盖重算；
 *   full 档  —— 用服务端权威值刷新该卡片。
 */
function onMetaUpdated(meta) {
  if (!meta || !meta.id) return
  // P5.3-B：抽屉里改完演员，卡片人物行立即跟着变（full 档写回的服务端值 / local 档的本机值都走这里）
  if (Array.isArray(meta.persons)) personsOverrides[meta.id] = meta.persons
  if (isLocal.value) {
    void localOrgVersion.value
    return
  }
  metaOverrides[meta.id] = { rating: Number(meta.rating) || 0, tags: meta.tags || [] }
}

/** 选择器里现场新建的人物 → 并入人物库缓存，下次打开选择器就能搜到（local 档的 lp- 条目不并进来） */
function onPersonCreated(person) {
  if (!person || !person.name || isLocal.value) return
  const list = Array.isArray(personList.value) ? personList.value : []
  const hit = list.some(
    (x) => String(x.name) === String(person.name) || (x.id != null && person.id != null && String(x.id) === String(person.id))
  )
  if (!hit) personList.value = list.concat([person])
}

/* =========================================================================
   数据加载
   ========================================================================= */

async function loadIndex() {
  loading.value = true
  try {
    const idx = await api.getIndex({ silent: true })
    videos.value = (idx && idx.videos) || []
    facetOrder.value = (idx && idx.facetOrder) || []
    ratingOptions.value = (idx && Array.isArray(idx.ratings)) ? idx.ratings : []
    indexStats.value = (idx && idx.stats) || null
    indexOk.value = true
    loading.value = false
    await nextTick()
    restoreScroll()
    maybeMigrateRecent()
    openFromHash()
  } catch (err) {
    loading.value = false
    indexOk.value = false
    errorMsg.value = '索引加载失败：' + (err && err.message ? err.message : err)
  }
}

/**
 * P5.95：登录 / 退出后按新的可见性重取索引，并重画列表。
 *
 * <p>与 {@link loadIndex} 的差别就是「不碰播放器与滚动位置」：用户可能正在看片，登录只是让他
 * 多看到几个根下的内容，不该把正在播的视频重开一遍（loadIndex 里的 openFromHash 会开播）。
 * 失败保持当前画面：拿不到新数据时旧的列表比空网格更有用。</p>
 *
 * <p>「刷新」按钮也走这里：同一个动作，不该有两套实现。</p>
 */
async function reloadForAuth() {
  try {
    const idx = await api.getIndex({ silent: true })
    videos.value = (idx && idx.videos) || []
    facetOrder.value = (idx && idx.facetOrder) || []
    ratingOptions.value = (idx && Array.isArray(idx.ratings)) ? idx.ratings : []
    indexStats.value = (idx && idx.stats) || null
    indexOk.value = true
    errorMsg.value = ''
  } catch (err) {
    /* 静默：见上 */
  }
}

// 登录态一变（登录 / 退出 / 401 清 token）就重取：专门空态与内容都靠它实时跟着走
watch(() => auth.state.token, () => {
  reloadForAuth()
})

/**
 * 人物列表（P3-B）：给筛选抽屉的「人物」分组取服务端数据。
 * 失败一律静默（silent + catch）：后端未部署时保持旧推导，用户不会看到任何报错。
 */
async function loadPersonsFacet() {
  if (personsLoading.value) return
  personsLoading.value = true
  try {
    const res = await api.listPersons({ silent: true })
    const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
    const list = Array.isArray(body) ? body : (body && (body.rows || body.list || body.items)) || []
    personList.value = Array.isArray(list) ? list : []
  } catch (err) {
    // 未就绪：personList=null → personsUnavailable=true → 演员选择器整块只读并提示
    personList.value = null
  } finally {
    personsLoading.value = false
  }
}

/**
 * 工作室（P5-A）：GET /api/media/studios —— 抽屉「工作室」分组的服务端计数。
 * 失败一律静默（silent + catch）：后端未部署时 studioList=null，分组回落到索引推导并写明提示。
 */
async function loadStudios() {
  try {
    const res = await api.listStudios({ silent: true })
    const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
    const list = Array.isArray(body) ? body : (body && (body.rows || body.list || body.items || body.studios)) || []
    studioList.value = Array.isArray(list) ? list.filter((s) => s && s.name) : []
    studiosUnavailable.value = ''
  } catch {
    studioList.value = null
    studiosUnavailable.value = '工作室接口未就绪（/api/media/studios）：分组按索引 videos[].studios 推导'
  }
}

/**
 * 播放列表上下文（P5-B）：GET /api/media/playlist/{id} 取有序集合。
 * 失败只提示并退出上下文（播放与筛选完全不受影响，播放器仍按筛选结果走上一部/下一部）。
 */
async function loadPlaylistContext() {
  const id = playlistId.value
  if (!id) {
    playlistCtx.value = null
    return
  }
  try {
    const res = await api.getPlaylist(id, { silent: true })
    const detail = normalizePlaylistDetail(res)
    playlistCtx.value = {
      id: id,
      name: detail.name || '#' + id,
      ids: detail.ids
    }
  } catch {
    playlistCtx.value = null
    showToast('播放列表接口未就绪：无法按列表顺序播放')
  }
}

watch(playlistId, () => loadPlaylistContext())

/**
 * P5.32：播放列表上下文是异步到的，而深链 #play=<id> 在索引一到就开播 —— 首帧可能只有浏览顺序。
 *   - 到了且确实包含当前片 → 升级成播放列表顺序（优先级最高）；
 *   - 被清空 / 换成别的列表且当前上下文正来自播放列表 → 回落重新定位（退出播放列表模式、
 *     浏览器前进后退、手改地址栏都走这里）。
 * 播放中改筛选 / 收藏等**不**触发重算：快照语义，从哪个列表点进来就按那个顺序。
 */
watch([playlistCtx, plView, () => state.pl], () => {
  const id = curVideo.value ? curVideo.value.id : ''
  if (!id) return
  const src = playlistContextSource()
  if (src) {
    const up = makePlaybackContext(src.ids, id, { source: 'playlist', name: src.name, playlistId: src.playlistId })
    if (up.index >= 0) {
      pbCtx.value = up
      return
    }
  }
  if (pbCtx.value && pbCtx.value.source === 'playlist') pbCtx.value = contextFor(id)
})

/* =========================================================================
   键盘
   ========================================================================= */

function onKey(e) {
  const t = e.target
  const tag = t && t.tagName ? t.tagName.toLowerCase() : ''
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)

  if (e.key === 'Escape') {
    // P4-B：帮助浮层开着时 Esc 只关浮层，不顺手把播放器一起关掉
    if (playerRef.value && typeof playerRef.value.closeHelp === 'function' && playerRef.value.closeHelp()) {
      e.preventDefault()
      return
    }
    if (curVideo.value) {
      e.preventDefault()
      closePlayer()
      return
    }
    if (drawerOpen.value) {
      closeDrawer()
      return
    }
    if (selectMode.value) {
      exitSelectMode()
      return
    }
    if (typing && t.blur) t.blur()
    return
  }
  if (e.key === '/' && !typing && !curVideo.value) {
    e.preventDefault()
    if (searchEl.value) searchEl.value.focus()
    return
  }
  if (!curVideo.value || !playerRef.value) return

  switch (e.key) {
    case ' ':
    case 'Spacebar':
      e.preventDefault()
      playerRef.value.togglePlay()
      break
    case 'ArrowLeft':
      e.preventDefault()
      // P4-B：Shift+方向 = 单帧步进（不带 Shift 的 5 秒跳转保持不变）
      if (e.shiftKey) playerRef.value.stepFrame(-1)
      else playerRef.value.seekRel(-5)
      break
    case 'ArrowRight':
      e.preventDefault()
      if (e.shiftKey) playerRef.value.stepFrame(1)
      else playerRef.value.seekRel(5)
      break
    case 'ArrowUp':
      e.preventDefault()
      playerRef.value.adjustVolume(0.1)
      break
    case 'ArrowDown':
      e.preventDefault()
      playerRef.value.adjustVolume(-0.1)
      break
    case 'f':
    case 'F':
      e.preventDefault()
      playerRef.value.toggleFullscreen()
      break
    case 'n':
    case 'N':
      e.preventDefault()
      step(1)
      break
    case 'p':
    case 'P':
      e.preventDefault()
      step(-1)
      break
    /* ---------------- P4-B 新增：AB 循环 / 单帧 / 帮助（输入框聚焦时不抢键） ---------------- */
    case 'a':
    case 'A':
      if (typing) break
      e.preventDefault()
      playerRef.value.setAbPoint('a')
      break
    case 'b':
    case 'B':
      if (typing) break
      e.preventDefault()
      playerRef.value.setAbPoint('b')
      break
    case ',':
      if (typing) break
      e.preventDefault()
      playerRef.value.stepFrame(-1)
      break
    case '.':
      if (typing) break
      e.preventDefault()
      playerRef.value.stepFrame(1)
      break
    /* ---------------- P4.1 新增：视频倍速 [ / ]（增益不再绑快捷键） ---------------- */
    case '[':
      if (typing) break
      e.preventDefault()
      playerRef.value.changeSpeed(-1)
      break
    case ']':
      if (typing) break
      e.preventDefault()
      playerRef.value.changeSpeed(1)
      break
    case '?':
      if (typing) break
      e.preventDefault()
      playerRef.value.toggleHelp()
      break
    default:
      break
  }
}

/* =========================================================================
   生命周期
   ========================================================================= */

/** 页面隐藏 / 离开先结算播放段（带进度百分比）；本监听注册早于 useMediaTrack 的自动 flush，故先跑 */
function onDocHide() {
  if (playerRef.value) playerRef.value.settle()
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') onDocHide()
}

function onMqChange() {
  // 抽屉两端共用同一套：跨断点只切宽度（320px ↔ 100%），不再强制关闭，
  // 否则用户正在抽屉里勾选时改窗口尺寸会被打断
  isMobile.value = mq ? mq.matches : false
}

/* 首屏同步初始化，顺序与 app.js boot() 一致：hash 已解析 → 随机排序 → 进度表 → 本地最近观看 */
if (!state.sortPinned) pickRandomSort()
loadPosMap()
recentLocal.value = loadRecent()
lastSig = filterSig.value

onMounted(() => {
  // 先注册自己的结算监听，再调 pageView()（后者内部 bindAutoFlush 后注册、后执行）
  window.addEventListener('pagehide', onDocHide)
  document.addEventListener('visibilitychange', onVisibilityChange)
  tk.pageView()
  writeHash()
  window.addEventListener('hashchange', onHashChange)
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('keydown', onKey)
  if (mq && mq.addEventListener) mq.addEventListener('change', onMqChange)
  loadUser()
  loadIndex()
  // 启动时取一次编辑策略：失败回退 full 并在控制台 warn（旧后端行为不变）
  loadEditPolicy()
  loadTags(false)
  // 人物（P3-B）：与首屏并行，失败不影响任何既有加载
  loadPersonsFacet()
  // 工作室（P5-A）与播放列表上下文（P5-B）：同样并行，失败只降级不阻塞
  loadStudios()
  loadPlaylistContext()
  // P5.46：播放列表筛选维度 —— 清单（下拉 / 管理弹层共用）+ 侧栏入口带来的聚焦信号
  loadPlaylistList()
  consumePlaylistFocus()
})

/** 策略晚于首屏到达（full → off/local）时补拉一次标签库：local 档要并入本机标签 */
watch(editLevel, () => {
  loadTags(false)
})

onBeforeUnmount(() => {
  window.removeEventListener('pagehide', onDocHide)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('hashchange', onHashChange)
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('keydown', onKey)
  if (mq && mq.removeEventListener) mq.removeEventListener('change', onMqChange)
  if (io) {
    io.disconnect()
    io = null
  }
  clearTimeout(searchTimer)
  clearTimeout(tkSearchTimer)
  tk.flushAll()
  document.body.style.overflow = ''
})

watch(
  [curVideo, drawerOpen],
  () => {
    document.body.style.overflow = curVideo.value || drawerOpen.value ? 'hidden' : ''
  },
  { immediate: true }
)
</script>

<style lang="scss">
/* 媒体站变量映射：--bg / --fg / --line / --accent … → --qt-*，亮暗自动跟随 */
@use '@/views/media/mediaTheme.scss';
</style>

<style lang="scss" scoped>
/* 页面级横向留白令牌：工具栏 / 最近观看条 / 卡片网格共用同一个值，
   保证三者在同一左边界上（16px，落在设计要求的 16–24px 区间内） */
.ms-page {
  --ms-gutter: 16px;
  /* 本页顶部是吸顶工具栏（搜索框 + 排序 + 一排按钮）：页面提示整体下移到工具栏之下，
     避免 2.4s 内盖住用户下一步要点的控件（数值 = 工具栏实测高度，见 devtools/p540-ui） */
  --ms-toast-top: 96px;
  min-height: 100vh;
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.45 'Segoe UI', 'Microsoft YaHei', system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* 内容区全宽流式：左右留白由 AppShell（媒体路由 meta.bleed 已取消外壳 padding）与
   本页 --ms-gutter 自负；不再有 fixed 左栏，也不需要为它让位的 margin-left */
.app {
  min-height: 100vh;
}

.toolbar {
  position: sticky;
  /* 让开外壳顶栏/导航（AppShell 在移动端提供 --media-sticky-top）；
     桌面端无二级导航，该量为 0，本偏移自动为 0 */
  top: var(--media-sticky-top, 0px);
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px var(--ms-gutter);
  background: var(--bg-2);
  border-bottom: 1px solid var(--line);
}

.tb-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tb-filters {
  flex-wrap: wrap;
  gap: 12px;
}

.search {
  flex: 1;
  min-width: 120px;
  padding: 7px 11px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--fg);
  outline: none;
}

.search:focus {
  border-color: var(--accent);
}

.count {
  font-size: 13px;
  color: var(--fg-dim);
  white-space: nowrap;
}

.select {
  padding: 7px 9px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--fg);
  outline: none;
  cursor: pointer;
}

.btn-ghost,
.icon-btn {
  padding: 7px 11px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-3);
  color: var(--fg);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, border-color 0.12s;
}

.btn-ghost {
  background: transparent;
  color: var(--fg-dim);
}

.btn-ghost:hover,
.icon-btn:hover {
  background: var(--bg-3);
  border-color: var(--line-2);
  color: var(--fg);
}

.icon-btn {
  padding: 4px 9px;
  line-height: 1;
  font-size: 15px;
}

/* 「筛选」按钮两端都显示（抽屉是桌面与移动共用的唯一入口），角标显示抽屉内已选总数 */
.filter-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.filter-toggle .ft-caret {
  font-size: 9px;
  opacity: 0.6;
}

.filter-toggle b {
  font-style: normal;
  font-weight: 600;
  font-size: 10.5px;
  line-height: 1;
  min-width: 15px;
  padding: 2px 4px;
  border-radius: 8px;
  /* 实心底上的白字：用 --accent-btn / --accent-on 才有 4.5:1 对比度 */
  background: var(--accent-btn);
  color: var(--accent-on);
  text-align: center;
}

/* 「选择」按钮：进入多选批量模式时高亮（aria-pressed 是唯一状态源） */
.sel-btn[aria-pressed='true'] {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

/* 编辑策略 off 档：选择按钮禁用 + 工具栏常驻一句说明（title 与空态共用同一文案） */
.sel-btn:disabled {
  opacity: 0.45;
  cursor: default;
  border-style: dashed;
}

.policy-hint-local {
  border-color: var(--accent);
  color: var(--accent);
}

.policy-hint {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  line-height: 1.3;
  color: var(--fg-dim);
  border: 1px dashed var(--line-2);
  border-radius: 999px;
  padding: 3px 8px;
}

/* 批量操作条行：跟随工具栏吸顶，移动端由 BatchBar 自身换行 */
.tb-batch {
  align-items: flex-start;
}

.tb-batch > * {
  flex: 1;
  min-width: 0;
}

/* P5.47 批量生成简介：进度行与工具栏其它行同宽，弱色不加粗（它是状态不是操作） */
.tb-syn-batch {
  align-items: center;
  gap: 8px;
}

.syn-batch-progress {
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}

/* 生成中时按钮保持可见（防止用户以为没点上）；禁用态由 :disabled 统一处理 */
.syn-batch-btn:disabled {
  opacity: 0.6;
  cursor: progress;
}

.cols-btn {
  display: none;
}

.cols-btn[aria-pressed='true'] {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

/* 激活筛选：逐项撤销 */
.active-chips {
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 2px;
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
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1.2;
  cursor: pointer;
  white-space: nowrap;
}

.chip-x {
  background: var(--bg-2);
  border-color: var(--line-2);
  color: var(--fg);
}

.chip-x:hover {
  border-color: var(--danger);
  color: var(--danger);
}

.chip-x .x {
  font-size: 13px;
  opacity: 0.7;
}

/* 播放列表维度（P5.46）：顺序被列表顺序覆盖时的一行说明（与 chip 同区、同字号） */
.pl-order-note {
  flex: 0 0 auto;
  padding: 2px 7px;
  border: 1px dashed var(--accent);
  border-radius: 999px;
  color: var(--accent);
  font-size: 11.5px;
  line-height: 1.4;
  white-space: nowrap;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
  gap: 12px;
  padding: 14px var(--ms-gutter) 48px;
}

.grid-sentinel {
  height: 1px;
}

.empty {
  padding: 48px var(--ms-gutter);
  text-align: center;
  color: var(--fg-dim);
}

.drawer-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  /* 必须高于 AppShell 左栏(桌面 60 / 移动 80)、移动顶栏(50) 与移动导航遮罩(70)；
     仍远低于 Element Plus 的 message/modal 层（1000+），不会压过全局提示 */
  z-index: 200;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.22s ease;
}

.drawer-backdrop.show {
  opacity: 1;
  pointer-events: auto;
}

/* 页面级轻提示已统一到 PageToast.vue（顶部居中、可堆叠），本页不再持有 toast 样式 */

/* ---------------------------------------------------------------- 筛选抽屉 */
/* 右侧固定抽屉：桌面 320px、≤768px 占满全宽；transform 从 100% 滑入 0，
   关闭时用 visibility 延迟 0.22s 隐身，保证滑出动画看得见且关闭后不进 Tab 序列 */
.filter-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  /* 与遮罩同一层叠上下文里高一级；必须高于 AppShell 左栏(60/80)与顶栏(50)。
     播放器浮层是 fixed inset:0 的 z-index:100 全屏不透明层，会盖住筛选按钮，
     且 openDrawer() 在播放器打开时直接返回，故两者不会同时出现，无需比较层级 */
  z-index: 201;
  display: flex;
  flex-direction: column;
  width: 320px;
  max-width: 100%;
  background: var(--bg-2);
  border-left: 1px solid var(--line);
  transform: translateX(100%);
  visibility: hidden;
  transition: transform 0.22s ease, visibility 0s linear 0.22s;
  outline: none;
}

.filter-drawer.open {
  transform: translateX(0);
  visibility: visible;
  transition: transform 0.22s ease, visibility 0s linear 0s;
}

.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}

.drawer-head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
}

.drawer-close {
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius, 10px);
  background: transparent;
  color: var(--fg-dim);
  font-size: 18px;
  line-height: 1.2;
  cursor: pointer;
}

.drawer-close:hover {
  background: var(--bg-3);
  border-color: var(--line-2);
  color: var(--fg);
}

.drawer-close:focus-visible,
.btn-primary:focus-visible,
.icon-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

/* 底部操作条常驻抽屉底部：左侧清空、右侧「查看 N 个结果」并关闭 */
.drawer-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--line);
  background: var(--bg-2);
}

.drawer-foot .btn-ghost {
  flex: 0 0 auto;
  border-radius: var(--radius, 10px);
}

.btn-primary {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--accent-btn);
  border-radius: var(--radius, 10px);
  /* 实心按钮：--accent-btn / --accent-on 才有 4.5:1 对比度 */
  background: var(--accent-btn);
  color: var(--accent-on);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.btn-primary:hover {
  border-color: var(--accent);
}

.quick-head {
  padding: 2px 4px 7px;
}

.quick-head h2 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--fg-dim);
}

.quick-body {
  margin-bottom: 12px;
}

@media (max-width: 768px) {
  /* 移动端：抽屉占满全宽；横向留白收窄到 10px，与 RecentStrip 的移动端内边距保持一致 */
  .ms-page {
    --ms-gutter: 10px;
  /* 窄屏工具栏换行更高：提示条同样下移到它之下（实测值） */
  --ms-toast-top: 168px;
  }

  .filter-drawer {
    width: 100%;
    border-left: 0;
  }

  .cols-btn {
    display: inline-flex;
  }

  .toolbar {
    padding: 5px var(--ms-gutter);
    gap: 6px;
  }

  /* 两行栅格：① 筛选 + 搜索(占满) + 账户　② 排序(占满) + 清空 + 列数 + 计数 */
  .tb-top {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto auto auto;
    gap: 6px 8px;
    align-items: center;
  }

  .tb-top > .filter-toggle {
    grid-area: 1 / 1 / 2 / 2;
    justify-self: start;
  }

  .tb-top > .search {
    grid-area: 1 / 2 / 2 / 6;
    min-width: 0;
    padding: 4px 9px;
    font-size: 13.5px;
  }

  .tb-top > .select {
    grid-area: 2 / 1 / 3 / 3;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    font-size: 12.5px;
    padding: 4px 8px;
  }

  .tb-top > .btn-ghost {
    grid-area: 2 / 3 / 3 / 4;
    padding: 4px 9px;
    font-size: 13px;
  }

  .tb-top > .cols-btn {
    grid-area: 2 / 4 / 3 / 5;
  }

  .tb-top > .count {
    grid-area: 2 / 5 / 3 / 7;
    justify-self: end;
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }

  .active-chips {
    padding: 0;
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .active-chips::-webkit-scrollbar {
    display: none;
  }

  .chip {
    font-size: 11.5px;
    padding: 3px 8px;
  }

  /* P5.46 实测：repeat(2, 1fr) 的 1fr 最小值是 auto（= 卡片内容的 max-content），
     窄屏下只要某张卡有不可断行的内容（长标题 / 人物行），整条轨道就会被撑到几百 px，
     页面因此横向滚动。minmax(0, 1fr) 把最小值钉成 0，卡片才真的等分两列，
     卡内长文本由既有的 text-overflow: ellipsis 截断。 */
  .grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    padding: 10px var(--ms-gutter) calc(12px + env(safe-area-inset-bottom, 0px));
  }

  .grid.cols-3 {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
  }
}
</style>
