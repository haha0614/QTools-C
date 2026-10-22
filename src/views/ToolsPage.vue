<!--
  ToolsPage.vue —— 「全部工具」独立页面（/tools）
  结构：页面标题行 → sticky 筛选条（筛选开关 + 分类 chips + 排序 + 搜索）→ 工具卡片网格 → 状态区
  外壳：全站导航与内容区留白由 AppShell 承载，本页不再套 .qt-container（否则留白叠加）。
  数据：onMounted 调用 @/api/tool.js 的 getToolList()（GET /toolInfo/list）；失败时提示并回退 FALLBACK_TOOLS。
  主题：颜色一律取自全局 CSS 变量（--qt-*），暗色模式由 html.dark 覆盖变量自动生效。
-->
<script setup>
// ========== 依赖引入 ==========
import { ref, computed, onMounted } from 'vue'
import { Filter, Search } from '@element-plus/icons-vue' // QTools-C 未装自动导入，图标显式引入
import { getToolList } from '@/api/tool.js' // GET /toolInfo/list，返回工具数组
import ToolCard from '@/components/ToolCard.vue'

// ========== 常量 ==========
// 分类 chips：key 与 normalizeTool 计算出的 category 对应
const CATEGORIES = [
  { key: 'all', label: '全部' },
  { key: 'text', label: '文本' },
  { key: 'encode', label: '编码' },
  { key: 'generate', label: '生成' },
  { key: 'security', label: '安全' },
  { key: 'media', label: '媒体' }
]

// 排序选项：默认「最近添加」（后端自增主键近似添加时间），可切到按名称
const SORT_OPTIONS = [
  { key: 'recent', label: '最近添加' },
  { key: 'name', label: '名称' }
]

// 后端 tool_info 暂无分类字段，与首页保持同一口径：先按工具 id 硬编码映射
//（1/2 → 文本、3 → 安全、4 → 媒体）；后端补上 category 字段后改为直接读 item.category 即可删掉本表。
const CATEGORY_BY_ID = { 1: 'text', 2: 'text', 3: 'security', 4: 'media' }

// 内置兜底数据：接口不可用时使用，id 与后端 tool_info 对齐以便沿用 id → 分类映射
const FALLBACK_TOOLS = [
  {
    id: 1,
    toolName: 'JSON格式化工具',
    toolDesc: 'JSON格式化、压缩、语法校验',
    toolRoute: '/tool/json',
    icon: 'Document',
    sort: 1
  },
  {
    id: 2,
    toolName: '文本字数统计',
    toolDesc: '统计汉字、字符、行数，可清除空格',
    toolRoute: '/tool/text-count',
    icon: 'EditPen',
    sort: 2
  },
  {
    id: 3,
    toolName: '随机密码生成',
    toolDesc: '自定义长度，支持大小写、数字、符号',
    toolRoute: '/tool/pwd-gen',
    icon: 'Key',
    sort: 3
  },
  {
    // 媒体站是 /media 下的独立页面（静态页与 SPA 都可直达），标记 external 后整页跳转
    id: 4,
    toolName: '媒体站',
    toolDesc: '视频与图片库：卡片墙、相册分组、收藏与断点续播',
    toolRoute: '/media',
    icon: 'VideoCamera',
    sort: 100,
    external: true
  }
]

// ========== 响应式状态 ==========
const toolList = ref([]) // 归一化后的列表：{ id, name, desc, route, icon, sort, external, category }
const loading = ref(true) // 加载中：渲染骨架占位
const loadError = ref(false) // 加载失败：渲染提示条
const keyword = ref('') // 搜索关键词
const category = ref('all') // 当前分类
const sortBy = ref('recent') // 当前排序
const chipsOpen = ref(false) // 窄屏下分类行是否展开（筛选按钮控制）

// ========== 字段映射 ==========
// 非 Vue Router 管理的地址（外站 URL 或 *.html 静态页）需要整页跳转
const isStaticRoute = (route) => !!route && (/^https?:\/\//i.test(route) || /\.html?(?:$|[?#])/i.test(route))

// 分类来源：优先用后端字段；否则按 id 映射；媒体站路由再兜底一次，避免后端 id 变动时归错类
const resolveCategory = (item) => {
  if (item.category) return item.category
  const byId = CATEGORY_BY_ID[item.id]
  if (byId) return byId
  if (typeof item.toolRoute === 'string' && item.toolRoute.startsWith('/media')) return 'media'
  return 'other'
}

// 把后台字段映射成视图字段，模板里不再直接依赖接口字段名
const normalizeTool = (item) => ({
  id: item.id,
  name: item.toolName,
  desc: item.toolDesc,
  route: item.toolRoute,
  icon: item.icon,
  sort: item.sort,
  external: !!item.external || isStaticRoute(item.toolRoute),
  category: resolveCategory(item)
})

const normalizeList = (list) => list.map(normalizeTool).sort((a, b) => (a.sort || 0) - (b.sort || 0))

// ========== 数据加载 ==========
const fetchTools = async () => {
  loading.value = true
  loadError.value = false
  try {
    const raw = await getToolList()
    // 兼容若依 AjaxResult 包装体（{ code, msg, data: [...] }）与后端直接返回裸数组两种形态
    const data = Array.isArray(raw) ? raw : raw && Array.isArray(raw.data) ? raw.data : null
    if (!data) throw new Error('接口返回格式不是数组')
    toolList.value = normalizeList(data)
  } catch (err) {
    // 失败路径：记录错误 → 展示提示条 → 回退内置兜底数据，页面保持可用
    console.error('[ToolsPage] 工具列表加载失败：', err)
    loadError.value = true
    toolList.value = normalizeList(FALLBACK_TOOLS)
  } finally {
    loading.value = false
  }
}

// ========== 过滤与排序 ==========
const isFiltering = computed(() => category.value !== 'all' || keyword.value.trim() !== '')

const filteredTools = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  // filter 已返回新数组，排序可原地进行
  const list = toolList.value.filter((tool) => {
    if (category.value !== 'all' && tool.category !== category.value) return false
    if (!kw) return true
    return [tool.name, tool.desc, tool.route].some(
      (field) => typeof field === 'string' && field.toLowerCase().includes(kw)
    )
  })

  return list.sort((a, b) =>
    sortBy.value === 'name'
      ? String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')
      : (b.id || 0) - (a.id || 0)
  )
})

// 有筛选时显示「命中数 / 总数」，否则只显示总数
const countText = computed(() =>
  isFiltering.value
    ? `${filteredTools.value.length} / ${toolList.value.length} 个工具`
    : `共 ${toolList.value.length} 个工具`
)

const resetFilters = () => {
  keyword.value = ''
  category.value = 'all'
}

onMounted(fetchTools)
</script>

<template>
  <div class="tools-page">
    <!-- ===== 1. 标题行 ===== -->
    <div class="page-head">
      <h1 class="page-head__title">全部工具</h1>
      <span class="page-head__count">{{ countText }}</span>
    </div>

    <!-- ===== 2. sticky 筛选条：左筛选开关 / 中分类 chips / 右排序 + 搜索 ===== -->
    <div class="filter-bar">
      <button
        type="button"
        class="filter-bar__toggle"
        :aria-expanded="chipsOpen"
        aria-controls="tools-chips"
        @click="chipsOpen = !chipsOpen"
      >
        <el-icon class="filter-bar__toggle-icon"><Filter /></el-icon>
        <span>筛选</span>
      </button>

      <!-- 分类 chips：宽屏常驻；窄屏由上面的开关控制展开 -->
      <div id="tools-chips" class="filter-bar__chips" :class="{ 'is-open': chipsOpen }" role="group" aria-label="工具分类">
        <button
          v-for="item in CATEGORIES"
          :key="item.key"
          type="button"
          class="chip"
          :class="{ 'chip--active': category === item.key }"
          :aria-pressed="category === item.key"
          @click="category = item.key"
        >
          {{ item.label }}
        </button>
      </div>

      <div class="filter-bar__actions">
        <label class="sort">
          <span class="sort__label">排序</span>
          <select v-model="sortBy" class="sort__select" aria-label="排序方式">
            <option v-for="item in SORT_OPTIONS" :key="item.key" :value="item.key">{{ item.label }}</option>
          </select>
        </label>

        <div class="search">
          <el-icon class="search__icon"><Search /></el-icon>
          <input
            v-model="keyword"
            class="search__input"
            type="search"
            placeholder="搜索工具…"
            aria-label="搜索工具名称或用途"
          />
        </div>
      </div>
    </div>

    <!-- 接口失败提示：下方仍渲染兜底数据 -->
    <el-alert
      v-if="loadError"
      class="tools-page__alert"
      type="warning"
      title="工具加载失败，已展示默认入口"
      :closable="false"
      show-icon
    />

    <!-- ===== 3. 加载骨架 ===== -->
    <div v-if="loading" class="tool-grid">
      <el-skeleton v-for="n in 4" :key="n" class="tool-skeleton" :rows="2" animated />
    </div>

    <!-- ===== 4. 卡片网格 ===== -->
    <div v-else-if="filteredTools.length" class="tool-grid">
      <ToolCard v-for="tool in filteredTools" :key="tool.id" :tool="tool" />
    </div>

    <!-- ===== 5. 空态 ===== -->
    <div v-else class="state">
      <p class="state__text">没有匹配的工具，换个关键词或分类试试</p>
      <button type="button" class="state__btn" @click="resetFilters">清除筛选</button>
    </div>
  </div>
</template>

<style scoped lang="scss">
/* 页面容器：左右留白由 AppShell 的 --qt-shell-pad 提供 */
.tools-page {
  padding-top: 8px;
  padding-bottom: 48px;
  color: var(--qt-text-primary);
}

/* ---------- 1. 标题行 ---------- */
.page-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;

  &__title {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    color: var(--qt-text-primary);
  }

  &__count {
    font-size: 12px;
    color: var(--qt-text-secondary);
  }
}

/* ---------- 2. sticky 筛选条 ---------- */
/* 左右用负外边距抵消 AppShell 的内容留白，让模糊底铺满内容区边缘 */
.filter-bar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--qt-space-3, 12px);
  margin: 0 calc(-1 * var(--qt-shell-pad, 28px));
  padding: 10px var(--qt-shell-pad, 28px);
  border-bottom: 1px solid var(--qt-border);
  /* 半透明底：先给不透明兜底，再叠 color-mix 半透明（旧浏览器忽略第二条声明） */
  background-color: var(--qt-bg-page);
  background-color: color-mix(in srgb, var(--qt-bg-page) 84%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);

  /* 筛选开关：当前只负责窄屏展开/收起分类行 */
  &__toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
    padding: 6px 12px;
    border: 1px solid var(--qt-border);
    border-radius: 999px;
    background-color: var(--qt-bg-card);
    font-size: 13px;
    color: var(--qt-text-secondary);
    cursor: pointer;
    transition: color 0.2s, border-color 0.2s, background-color 0.2s;

    &:hover,
    &[aria-expanded='true'] {
      border-color: var(--qt-primary);
      color: var(--qt-primary);
    }

    &:focus-visible {
      outline: 2px solid var(--qt-primary);
      outline-offset: 2px;
    }
  }

  &__toggle-icon {
    font-size: 14px;
  }

  &__chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    min-width: 0;
  }

  &__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-left: auto;
  }
}

/* 分类 chip：选中态浅底 + 主色文字（默认选中「全部」） */
.chip {
  padding: 6px 14px;
  border: 1px solid var(--qt-border);
  border-radius: 999px;
  background-color: var(--qt-bg-card);
  font-size: 13px;
  color: var(--qt-text-secondary);
  cursor: pointer;
  transition: color 0.2s, border-color 0.2s, background-color 0.2s;

  &:hover {
    background-color: var(--qt-bg-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--qt-primary);
    outline-offset: 2px;
  }

  &--active {
    border-color: var(--qt-primary);
    background-color: var(--qt-bg-hover);
    color: var(--qt-primary);
  }
}

/* 排序：原生 select，外观靠 CSS 收敛到 pill */
.sort {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--qt-border);
  border-radius: 999px;
  background-color: var(--qt-bg-card);
  font-size: 13px;
  color: var(--qt-text-secondary);
  cursor: pointer;

  &__label {
    flex: none;
  }

  &__select {
    min-width: 84px;
    border: 0;
    background-color: transparent;
    font-size: 13px;
    color: var(--qt-text-primary);
    cursor: pointer;
    outline: none;
  }

  &:hover {
    border-color: var(--qt-border-strong, var(--qt-border));
  }

  &:focus-within {
    border-color: var(--qt-primary);
  }
}

/* 搜索：圆角 pill，宽度固定在 180–220px 区间 */
.search {
  position: relative;
  display: flex;
  align-items: center;

  &__icon {
    position: absolute;
    left: 12px;
    font-size: 14px;
    color: var(--qt-text-tertiary, var(--qt-text-secondary));
    pointer-events: none;
  }

  &__input {
    width: 200px;
    max-width: 100%;
    height: 34px;
    padding: 0 14px 0 32px;
    box-sizing: border-box;
    border: 1px solid var(--qt-border);
    border-radius: 999px;
    background-color: var(--qt-bg-card);
    font-size: 13px;
    color: var(--qt-text-primary);
    outline: none;
    appearance: none;
    -webkit-appearance: none;
    transition: border-color 0.2s;

    &::placeholder {
      color: var(--qt-text-tertiary, var(--qt-text-secondary));
    }

    &:focus {
      border-color: var(--qt-primary);
    }
  }
}

/* 失败提示 */
.tools-page__alert {
  margin-top: 16px;
}

/* ---------- 3/4. 卡片网格：≥1400 四列，随宽度降级 3 / 2 / 1 列 ---------- */
.tool-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--qt-space-4, 16px);
  margin-top: var(--qt-space-4, 16px);
}

/* 骨架占位：尺寸贴近卡片，避免加载完成时布局跳动 */
.tool-skeleton {
  padding: 16px;
  border: 1px solid var(--qt-border);
  border-radius: var(--qt-radius-lg, 12px);
  background-color: var(--qt-bg-card);
}

/* ---------- 5. 空态 ---------- */
.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  margin-top: var(--qt-space-4, 16px);
  padding: 48px 16px;
  border: 1px dashed var(--qt-border);
  border-radius: var(--qt-radius-lg, 12px);

  &__text {
    margin: 0;
    font-size: 13px;
    color: var(--qt-text-secondary);
  }

  &__btn {
    padding: 6px 14px;
    border: 1px solid var(--qt-primary);
    border-radius: 999px;
    background-color: transparent;
    font-size: 13px;
    color: var(--qt-primary);
    cursor: pointer;
    transition: background-color 0.2s;

    &:hover {
      background-color: var(--qt-bg-hover);
    }

    &:focus-visible {
      outline: 2px solid var(--qt-primary);
      outline-offset: 2px;
    }
  }
}

/* ---------- 响应式断点 ---------- */
@media (max-width: 1399px) {
  .tool-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 899px) {
  .tool-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 639px) {
  .tool-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* 窄屏：分类行默认收起，点击筛选按钮展开；操作区独占一行 */
@media (max-width: 767px) {
  .filter-bar__chips {
    display: none;
    width: 100%;
    order: 3;

    &.is-open {
      display: flex;
    }
  }

  .filter-bar__actions {
    order: 2;
    width: 100%;
    margin-left: 0;
  }

  .search {
    flex: 1 1 160px;
  }

  .search__input {
    width: 100%;
  }
}
</style>
