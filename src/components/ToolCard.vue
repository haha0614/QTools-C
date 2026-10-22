<!--
  ToolCard.vue —— 工具卡片（独立可复用组件）
  用途：/tools 全部工具页的网格单元。实现复制自 views/Home.vue 的卡片，刻意不 import Home，
       避免与首页耦合（后续是否合并由维护者统一决定）。
  点击：external 或静态页 / 外站地址整页跳转，其余走 vue-router；
       卡片本身是 <a :href> + @click.prevent，保留键盘可达与中键新标签打开。
  图标：Element Plus 图标组件 → 内联 <svg> → 名称首字，三级降级。
  主题：颜色一律取 --qt-* 变量，禁止硬编码颜色。
-->
<script setup>
import { useRouter } from 'vue-router'
import * as ElementPlusIcons from '@element-plus/icons-vue'

// tool: { id, name, desc, route, icon, category, external }
const props = defineProps({
  tool: {
    type: Object,
    required: true
  }
})

const router = useRouter()

// 非 Vue Router 管理的地址（外站 URL 或 *.html 静态页，如 /media/index.html）需要整页跳转
const isStaticRoute = (route) => !!route && (/^https?:\/\//i.test(route) || /\.html?(?:$|[?#])/i.test(route))

// 同名图标组件存在时才返回组件对象，否则返回 null（模板中配合 v-if，避免渲染空白占位）
const iconComp = (name) => (name && ElementPlusIcons[name]) || null

// 后端也可能下发一段内联 SVG：仅接受以 <svg 开头的字符串，其余一律走文字兜底
const isSvgIcon = (icon) => typeof icon === 'string' && /^\s*<svg[\s>]/i.test(icon)

// 文字兜底：取工具名首字
const initialOf = (name) => (typeof name === 'string' && name.trim() ? name.trim().slice(0, 1) : '•')

// 最近使用：与首页共用同一个 localStorage 键与数据结构，任一页点击都会更新首页的「最近使用」
const RECENT_KEY = 'qtools:recent-tools'
const RECENT_MAX = 6

const rememberTool = () => {
  const { id, name, route } = props.tool
  if (!route) return
  try {
    const prev = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    const list = Array.isArray(prev) ? prev : []
    // 按路由去重、最新在前、最多 6 条
    const next = [{ id, toolName: name, toolRoute: route }]
      .concat(list.filter((item) => item && item.toolRoute !== route))
      .slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch (err) {
    // 隐私模式或存储被禁：静默失败，不影响跳转
  }
}

// 整卡点击：静态页 / 外站整页跳转，其余交给 vue-router
const go = () => {
  const { route, external } = props.tool
  if (!route) return
  rememberTool()
  if (external || isStaticRoute(route)) window.location.href = route
  else router.push(route)
}
</script>

<template>
  <a
    class="tool-card"
    :href="tool.route || '#'"
    @click.prevent="go"
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
</template>

<style scoped lang="scss">
/* 工具卡片：整卡可点（<a>），hover 仅抬 1px + 描边转主色 */
.tool-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  border: 1px solid var(--qt-border);
  border-radius: var(--qt-radius-lg, 12px);
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
</style>
