<!--
  Home.vue —— 首页（工具索引 + 媒体站入口）
  结构：Hero 营销位 → 三步使用指引 → 工具索引（搜索 / 分类 / 最近使用 / 卡片网格）→ 页内页脚说明
  外壳：全站导航与页头由 AppShell 承载，本页不再引入 AppHeader / AppFooter，也不放全站导航。
  数据：onMounted 调用 @/api/tool.js 的 getToolList()（GET /toolInfo/list）；失败时提示并回退 FALLBACK_TOOLS。
  主题：颜色一律取自全局 CSS 变量（--qt-*），暗色模式由 html.dark 覆盖变量自动生效，本页无主题判断逻辑。
-->
<script setup>
// ========== 依赖引入 ==========
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getToolList } from '@/api/tool.js' // GET /toolInfo/list，返回工具数组
import { APP_INFO } from '@/utils/constants' // 站点信息常量（名称、版权等）
import * as ElementPlusIcons from '@element-plus/icons-vue' // 按名字动态取图标组件

// ========== 常量 ==========
// 最近使用的持久化键与上限
const RECENT_KEY = 'qtools:recent-tools'
const RECENT_MAX = 6

// 分类 chips：key 与 normalizeTool 计算出的 category 对应
const CATEGORIES = [
  { key: 'all', label: '全部' },
  { key: 'text', label: '文本' },
  { key: 'encode', label: '编码' },
  { key: 'generate', label: '生成' },
  { key: 'security', label: '安全' },
  { key: 'media', label: '媒体' }
]

// 三步使用指引（纯展示数据）
const GUIDE_STEPS = [
  { title: '选工具', desc: '从下面的索引里挑一个，或直接搜索名称与用途' },
  { title: '粘贴 / 上传内容', desc: '文本、图片、文件都只在浏览器内存里处理' },
  { title: '直接拿结果', desc: '结果即时生成，全程不经过服务器' }
]

// 后端 tool_info 暂无分类字段，先按工具 id 硬编码映射（1/2 → 文本、3 → 安全、4 → 媒体）；
// 后续后端补上 category 字段后改为直接读 item.category，删除这张映射表即可。
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
const router = useRouter()
const toolList = ref([]) // 归一化后的卡片列表：{ id, name, desc, route, icon, sort, external, category }
const loading = ref(true) // 加载中：渲染骨架占位
const loadError = ref(false) // 加载失败：渲染提示条
const keyword = ref('') // 搜索关键词
const category = ref('all') // 当前分类
const recentTools = ref([]) // 最近使用：{ id, name, route }
const toolsSection = ref(null) // 工具索引区，供 Hero 主按钮平滑滚动

// ========== 字段映射 ==========
// 非 Vue Router 管理的地址（外站 URL 或 *.html 静态页，如 /media/index.html）需要整页跳转
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
  // 后台显式标了 external，或 route 本身就是静态页 / 外站地址
  external: !!item.external || isStaticRoute(item.toolRoute),
  category: resolveCategory(item)
})

// 接口数据即完整列表（按 sort 升序），媒体站等静态页入口也由后台下发
const normalizeList = (list) => list.map(normalizeTool).sort((a, b) => (a.sort || 0) - (b.sort || 0))

// ========== 图标解析 ==========
// 同名图标组件存在时才返回组件对象，否则返回 null（模板中配合 v-if，避免渲染空白占位）
const iconComp = (name) => (name && ElementPlusIcons[name]) || null

// 后端也可能下发一段内联 SVG：仅接受以 <svg 开头的字符串，其余一律走文字兜底
const isSvgIcon = (icon) => typeof icon === 'string' && /^\s*<svg[\s>]/i.test(icon)

// 文字兜底：取工具名首字
const initialOf = (name) => (typeof name === 'string' && name.trim() ? name.trim().slice(0, 1) : '•')

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
    // 失败路径：记录错误 → 展示提示条 → 回退内置兜底数据，首页保持可用
    console.error('[Home] 工具列表加载失败：', err)
    loadError.value = true
    toolList.value = normalizeList(FALLBACK_TOOLS)
  } finally {
    loading.value = false
  }
}

// ========== 过滤 ==========
// 本地过滤：分类 + 关键词（匹配名称 / 描述 / 路由）
const filteredTools = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return toolList.value.filter((tool) => {
    if (category.value !== 'all' && tool.category !== category.value) return false
    if (!kw) return true
    return [tool.name, tool.desc, tool.route].some(
      (field) => typeof field === 'string' && field.toLowerCase().includes(kw)
    )
  })
})

// ========== 最近使用 ==========
// 读取：localStorage 里存的是接口风格字段 { id, toolName, toolRoute }，这里转成视图字段
const readRecent = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter((item) => item && item.toolRoute)
      .map((item) => ({ id: item.id, name: item.toolName || item.toolRoute, route: item.toolRoute }))
      .slice(0, RECENT_MAX)
  } catch (err) {
    // 隐私模式 / 脏数据都不应影响首页渲染
    console.warn('[Home] 最近使用读取失败：', err)
    return []
  }
}

// 写入：按路由去重、最新在前、最多 RECENT_MAX 条
const saveRecent = (list) => {
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify(list.map((tool) => ({ id: tool.id, toolName: tool.name, toolRoute: tool.route })))
    )
  } catch (err) {
    console.warn('[Home] 最近使用写入失败：', err)
  }
}

const rememberTool = (tool) => {
  const entry = { id: tool.id, name: tool.name, route: tool.route }
  const next = [entry, ...recentTools.value.filter((item) => item.route !== entry.route)].slice(0, RECENT_MAX)
  recentTools.value = next
  saveRecent(next)
}

// ========== 交互 ==========
// 点击卡片 / 最近使用项：external 或静态页整页跳转，其余走 vue-router
const goTool = (tool) => {
  if (!tool || !tool.route) return
  rememberTool(tool)
  if (tool.external || isStaticRoute(tool.route)) window.location.href = tool.route
  else router.push(tool.route)
}

// ========== 锚点滚动 ==========
// 顶栏让位高度：优先读 CSS 变量 --qt-topbar-h（AppShell 移动端为 48px），
// 其次读 .qt-topbar 实际高度（桌面 display:none 时为 0），都读不到才用 56 兜底。
const TOPBAR_FALLBACK = 56
const readTopbarHeight = (el) => {
  const fromVar = parseFloat(getComputedStyle(el).getPropertyValue('--qt-topbar-h'))
  if (Number.isFinite(fromVar) && fromVar > 0) return fromVar
  const bar = document.querySelector('.qt-topbar')
  if (bar) return Math.round(bar.getBoundingClientRect().height)
  return TOPBAR_FALLBACK
}

// 找真正的滚动容器：AppShell 的 .qt-shell__main 没有 overflow，滚动的是文档；
// 仍然逐级向上探测，避免将来外壳改成内部滚动时退化为"点不动"。
const getScrollParent = (el) => {
  let node = el ? el.parentElement : null
  while (node && node !== document.body && node !== document.documentElement) {
    const style = window.getComputedStyle(node)
    const canScroll = /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1
    if (canScroll) return node
    node = node.parentElement
  }
  return null
}

// Hero 主按钮：滚到工具索引区块标题稍上方（12px 呼吸 + 顶栏高度），不用 scrollIntoView
const scrollToTools = () => {
  const el = toolsSection.value
  if (!el) return
  const offset = readTopbarHeight(el) + 12
  const scroller = getScrollParent(el)
  if (scroller) {
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - offset
    scroller.scrollTo({ top, behavior: 'smooth' })
    return
  }
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - offset, behavior: 'smooth' })
}

// Hero 次按钮：进入媒体站
const goMedia = () => router.push('/media')

// 首次挂载：读最近使用 + 拉工具列表
onMounted(() => {
  recentTools.value = readRecent()
  fetchTools()
})
</script>

<template>
  <div class="home-page">
    <!-- ===== 1. Hero 营销位：浅底细线框，纯文字 ===== -->
    <section class="hero">
      <h1 class="hero__title">{{ APP_INFO.name }}</h1>
      <p class="hero__subtitle">在线工具 + 私有媒体库，打开即用，数据只留在你自己的浏览器里</p>

      <ul class="hero__badges">
        <li class="hero__badge">⚡ 纯本地运算</li>
        <li class="hero__badge">🔓 免注册即用</li>
        <li class="hero__badge">🚫 数据不上传</li>
      </ul>

      <div class="hero__actions">
        <el-button type="primary" class="hero__btn" @click="scrollToTools">开始使用 ↓</el-button>
        <el-button class="hero__btn" @click="goMedia">媒体站 →</el-button>
      </div>
    </section>

    <!-- ===== 2. 使用指引：横向三步，窄屏竖排 ===== -->
    <section class="guide">
      <h2 class="section-title">三步拿到结果</h2>
      <ol class="guide__steps">
        <li v-for="(step, index) in GUIDE_STEPS" :key="step.title" class="guide__step">
          <span class="guide__index">{{ index + 1 }}</span>
          <div class="guide__body">
            <h3 class="guide__name">{{ step.title }}</h3>
            <p class="guide__desc">{{ step.desc }}</p>
          </div>
        </li>
      </ol>
    </section>

    <!-- ===== 3. 工具索引 ===== -->
    <section id="tools" ref="toolsSection" class="tools">
      <div class="tools__head">
        <h2 class="section-title">工具索引</h2>
        <span class="tools__count">{{ filteredTools.length }} 个工具</span>
      </div>

      <!-- 搜索框：pill，本地过滤 -->
      <div class="search">
        <input
          v-model="keyword"
          class="search__input"
          type="search"
          placeholder="搜索工具名称或用途…"
          aria-label="搜索工具名称或用途"
        />
      </div>

      <!-- 分类 chips -->
      <div class="chips" role="group" aria-label="工具分类">
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

      <!-- 最近使用：无记录时整块隐藏 -->
      <div v-if="recentTools.length" class="recent">
        <h3 class="recent__title">最近使用</h3>
        <div class="recent__list">
          <button
            v-for="item in recentTools"
            :key="item.route"
            type="button"
            class="recent__item"
            @click="goTool(item)"
          >
            {{ item.name }}
          </button>
        </div>
      </div>

      <!-- 接口失败提示：下方仍渲染兜底数据 -->
      <el-alert
        v-if="loadError"
        class="tools__alert"
        type="warning"
        title="工具加载失败，已展示默认入口"
        :closable="false"
        show-icon
      />

      <!-- 加载中：骨架占位 -->
      <div v-if="loading" class="tool-grid">
        <el-skeleton v-for="n in 4" :key="n" class="tool-skeleton" :rows="2" animated />
      </div>

      <!-- 卡片网格：宽屏 4 列 / <1400 三列 / <900 两列 / <640 单列 -->
      <div v-else-if="filteredTools.length" class="tool-grid">
        <a
          v-for="tool in filteredTools"
          :key="tool.id"
          class="tool-card"
          :href="tool.route || '#'"
          @click.prevent="goTool(tool)"
        >
          <span class="tool-card__icon">
            <component :is="iconComp(tool.icon)" v-if="iconComp(tool.icon)" />
            <span v-else-if="isSvgIcon(tool.icon)" class="tool-card__svg" v-html="tool.icon"></span>
            <span v-else class="tool-card__initial">{{ initialOf(tool.name) }}</span>
          </span>
          <span class="tool-card__name">{{ tool.name }}</span>
          <span class="tool-card__desc">{{ tool.desc || '暂无描述' }}</span>
          <span class="tool-card__tag">本地运算</span>
        </a>
      </div>

      <!-- 无匹配：空态 -->
      <p v-else class="tools__empty">没有匹配的工具，换个关键词或分类试试</p>
    </section>

    <!-- ===== 4. 页内页脚说明 ===== -->
    <footer class="home-foot">
      <p class="home-foot__line">所有工具在浏览器本地运行，不上传任何数据</p>
      <p class="home-foot__meta">{{ APP_INFO.copyright }}</p>
    </footer>
  </div>
</template>

<style scoped lang="scss">
/* 页面容器：左右留白由 AppShell 的 --qt-shell-pad 提供（不要再用 .qt-container，否则留白叠加成 44px） */
.home-page {
  padding-top: 24px;
  /* 底部留白交给 AppShell 的 --qt-shell-pad（桌面 28px / 移动 16px），本页不再叠加 */
  padding-bottom: 0;
  color: var(--qt-text-primary);
}

/* 区块标题统一阶梯 */
.section-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--qt-text-primary);
}

/* ---------- 1. Hero ---------- */
.hero {
  /* 垂直内边距收紧到 24px：让工具索引标题在首屏下半部就能露出，锚点滚动才有意义 */
  padding: 24px 28px;
  border: 1px solid var(--qt-border);
  border-radius: 12px;
  background-color: var(--qt-bg-card);
  text-align: center;

  &__title {
    margin: 0 0 10px;
    font-size: 32px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--qt-text-primary);
  }

  &__subtitle {
    max-width: 560px;
    margin: 0 auto 16px;
    font-size: 14px;
    color: var(--qt-text-secondary);
  }

  &__badges {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin: 0 0 18px;
    padding: 0;
    list-style: none;
  }

  &__badge {
    padding: 4px 12px;
    border: 1px solid var(--qt-border);
    border-radius: 999px;
    background-color: var(--qt-bg-page);
    font-size: 12px;
    color: var(--qt-text-secondary);
  }

  &__actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 12px;
  }

  &__btn {
    min-width: 120px;
    border-radius: 10px;

    /* 间距交给 flex gap，抵消 Element Plus 相邻按钮的左边距 */
    & + & {
      margin-left: 0;
    }
  }
}

/* ---------- 2. 使用指引 ---------- */
.guide {
  margin-top: 24px;

  &__steps {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin: 14px 0 0;
    padding: 0;
    list-style: none;
  }

  &__step {
    display: flex;
    gap: 12px;
    padding: 14px 16px;
    border: 1px solid var(--qt-border);
    border-radius: 10px;
    background-color: var(--qt-bg-card);
  }

  &__index {
    flex: none;
    width: 22px;
    height: 22px;
    margin-top: 1px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--qt-primary);
    border-radius: 999px;
    font-size: 12px;
    color: var(--qt-primary);
  }

  &__body {
    min-width: 0;
  }

  &__name {
    margin: 0 0 2px;
    font-size: 14px;
    font-weight: 600;
    color: var(--qt-text-primary);
  }

  &__desc {
    margin: 0;
    font-size: 13px;
    line-height: 1.55;
    color: var(--qt-text-secondary);
  }
}

/* ---------- 3. 工具索引 ---------- */
.tools {
  margin-top: 30px;
  /* 退路：锚点 / scrollIntoView 场景下同样让开移动端 sticky 顶栏（--qt-topbar-h 由 AppShell 下发，桌面未定义即 0） */
  scroll-margin-top: calc(var(--qt-topbar-h, 0px) + 16px);

  &__head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  &__count {
    font-size: 12px;
    color: var(--qt-text-secondary);
  }

  &__alert {
    margin-top: 16px;
  }

  &__empty {
    margin: 24px 0 0;
    font-size: 13px;
    color: var(--qt-text-secondary);
    text-align: center;
  }
}

/* 搜索框：圆角 pill */
.search {
  margin-top: 14px;

  &__input {
    width: 100%;
    height: 40px;
    padding: 0 16px;
    border: 1px solid var(--qt-border);
    border-radius: 999px;
    background-color: var(--qt-bg-card);
    font-size: 14px;
    color: var(--qt-text-primary);
    outline: none;
    box-sizing: border-box;
    appearance: none;
    -webkit-appearance: none;
    transition: border-color 0.2s;

    &::placeholder {
      color: var(--qt-text-secondary);
    }

    &:focus {
      border-color: var(--qt-primary);
    }
  }
}

/* 分类 chips */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

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

  &--active {
    border-color: var(--qt-primary);
    background-color: var(--qt-bg-hover);
    color: var(--qt-primary);
  }
}

/* 最近使用 */
.recent {
  margin-top: 20px;

  &__title {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--qt-text-secondary);
  }

  &__list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  &__item {
    max-width: 220px;
    padding: 5px 12px;
    overflow: hidden;
    border: 1px solid var(--qt-border);
    border-radius: 8px;
    background-color: var(--qt-bg-card);
    font-size: 13px;
    color: var(--qt-text-primary);
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
    transition: color 0.2s, border-color 0.2s;

    &:hover {
      border-color: var(--qt-primary);
      color: var(--qt-primary);
    }
  }
}

/* 卡片网格：宽屏 4 列，随宽度降级到 3 / 2 / 1 列 */
.tool-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-top: 18px;
}

/* 骨架占位：尺寸贴近卡片，避免加载完成时布局跳动 */
.tool-skeleton {
  padding: 16px;
  border: 1px solid var(--qt-border);
  border-radius: 10px;
  background-color: var(--qt-bg-card);
}

/* 工具卡片：整卡可点（<a>），hover 仅抬 1px + 描边加深 */
.tool-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  border: 1px solid var(--qt-border);
  border-radius: 10px;
  background-color: var(--qt-bg-card);
  color: inherit;
  text-decoration: none;
  transition: transform 0.2s, border-color 0.2s;

  &:hover {
    border-color: var(--qt-primary);
    transform: translateY(-1px);
  }

  &:focus-visible {
    outline: 2px solid var(--qt-primary);
    outline-offset: 2px;
  }

  &__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: 8px;
    background-color: var(--qt-bg-hover);
    color: var(--qt-primary);
    font-size: 15px;
    line-height: 1;
  }

  /* 图标由 v-html 注入的 SVG，带不上 scoped 属性，需要 :deep */
  &__svg :deep(svg) {
    width: 20px;
    height: 20px;
  }

  &__initial {
    font-weight: 600;
  }

  &__name {
    font-size: 15px;
    font-weight: 600;
    color: var(--qt-text-primary);
  }

  /* 描述固定两行截断 */
  &__desc {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: 13px;
    line-height: 1.55;
    color: var(--qt-text-secondary);
  }

  &__tag {
    align-self: flex-start;
    margin-top: auto;
    padding: 2px 8px;
    border: 1px solid var(--qt-border);
    border-radius: 999px;
    font-size: 11px;
    color: var(--qt-text-secondary);
  }
}

/* ---------- 4. 页内页脚 ---------- */
/* 距卡片网格 20px + 8px 内边距 = 28px；下方留白全交给 AppShell 的内容区 padding */
.home-foot {
  margin-top: 20px;
  padding-top: 8px;
  border-top: 1px solid var(--qt-border);
  text-align: center;

  &__line {
    margin: 0;
    font-size: 13px;
    color: var(--qt-text-secondary);
  }

  &__meta {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--qt-text-secondary);
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

  /* 使用指引：三步改竖排 */
  .guide__steps {
    grid-template-columns: minmax(0, 1fr);
  }

  .hero {
    padding: 20px 18px;
  }

  .hero__title {
    font-size: 30px;
  }
}
</style>
