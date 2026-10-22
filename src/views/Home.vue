<!--
  Home.vue —— 首页「在线实用工具箱」导航页
  用途：展示站点标题、分类标题与工具卡片网格，点击卡片跳转到对应工具页。
  数据：onMounted 调用 @/api/tool.js 的 getToolList() 动态获取；按 sort 升序排列。
        媒体站等静态页入口也来自这张表（tool_info），可在管理端「工具管理」里上下架与排序。
  容错：接口异常时给出 el-alert 错误提示，并回退渲染内置的 4 条兜底数据，保证首页始终可用。
  主题：所有颜色均取自全局 CSS 变量（--qt-*），暗色模式由全局 <html class="dark"> 自动生效，本页不含主题逻辑。
-->
<script setup>
// ========== 依赖引入 ==========
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue' // 顶部导航（Logo + 主题切换 + 关于本站弹窗），无 props
import AppFooter from '@/components/AppFooter.vue' // 页脚，无 props
import { getToolList } from '@/api/tool.js' // GET /toolInfo/list，返回工具数组
import { APP_INFO } from '@/utils/constants' // 站点信息常量（名称、副标题等）
import * as ElementPlusIcons from '@element-plus/icons-vue' // 全局已注册图标，这里按名字动态取组件

// ========== 内置兜底数据 ==========
// 接口不可用时使用；顺序与 sort 一致，字段与后台返回保持一致（toolName / toolDesc / toolRoute / icon / sort）
const FALLBACK_TOOLS = [
  {
    id: 'fallback-1',
    toolName: 'JSON格式化工具',
    toolDesc: 'JSON格式化、压缩、语法校验',
    toolRoute: '/tool/json',
    icon: 'Document',
    sort: 1
  },
  {
    id: 'fallback-2',
    toolName: '文本字数统计',
    toolDesc: '统计汉字、字符、行数，可清除空格',
    toolRoute: '/tool/text-count',
    icon: 'EditPen',
    sort: 2
  },
  {
    id: 'fallback-3',
    toolName: '随机密码生成',
    toolDesc: '自定义长度，支持大小写、数字、符号',
    toolRoute: '/tool/pwd-gen',
    icon: 'Key',
    sort: 3
  },
  {
    // 媒体站是 public/media 下的独立静态页，不经 Vue Router，标记 external 后整页跳转
    id: 'fallback-4',
    toolName: '媒体站',
    toolDesc: '视频与图片库：卡片墙、相册分组、收藏与断点续播',
    toolRoute: '/media/index.html',
    icon: 'VideoCamera',
    sort: 100,
    external: true
  }
]

// 说明：媒体站等静态页入口不再硬编码合并，而是作为 tool_info 的一条记录由后台下发，
// 这样可在「工具管理」里上下架与排序；上面 FALLBACK_TOOLS 里的同名项只在接口不可用时生效。

// ========== 响应式状态 ==========
const router = useRouter()
const toolList = ref([]) // 归一化后的卡片列表：{ id, name, desc, route, icon, sort }
const loading = ref(true) // 加载中：渲染 el-skeleton 占位
const loadError = ref(false) // 加载失败：渲染 el-alert 错误提示

// ========== 字段映射 ==========
// 非 Vue Router 管理的地址（外站 URL 或 *.html 静态页，如 /media/index.html）需要整页跳转
const isStaticRoute = (route) => !!route && (/^https?:\/\//i.test(route) || /\.html?(?:$|[?#])/i.test(route))

// 把后台字段映射成视图字段，模板里不再直接依赖接口字段名
const normalizeTool = (item) => ({
  id: item.id,
  name: item.toolName,
  desc: item.toolDesc,
  route: item.toolRoute,
  icon: item.icon,
  sort: item.sort,
  // 后台显式标了 external，或 route 本身就是静态页/外站地址
  external: !!item.external || isStaticRoute(item.toolRoute)
})

// 接口数据即完整列表（按 sort 升序），媒体站等静态页也由后台下发，前端不再额外拼接
const normalizeList = (list) => list.map(normalizeTool).sort((a, b) => (a.sort || 0) - (b.sort || 0))

// ========== 图标解析 ==========
// 同名图标组件存在时才返回组件对象，否则返回 null（模板中配合 v-if 使用，避免渲染出空白占位）
const iconComp = (name) => (name && ElementPlusIcons[name]) || null

// ========== 数据加载 ==========
const fetchTools = async () => {
  loading.value = true
  loadError.value = false
  try {
    const raw = await getToolList()
    // 兼容若依 AjaxResult 包装体（{ code, msg, data: [...] }）与后端直接返回裸数组两种形态
    const data = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data) ? raw.data : null)
    if (!data) throw new Error('接口返回格式不是数组')
    // 按 sort 升序排列（sort 缺失时按 0 处理）
    toolList.value = normalizeList(data)
  } catch (err) {
    // 失败路径：记录错误 → 展示 el-alert → 回退内置兜底数据
    console.error('[Home] 工具列表加载失败：', err)
    loadError.value = true
    toolList.value = normalizeList(FALLBACK_TOOLS)
  } finally {
    loading.value = false
  }
}

// ========== 交互 ==========
// 点击卡片跳转到工具页；路由缺失时不做跳转，避免跳到空地址
const goTool = (tool) => {
  if (!tool.route) return
  // external 是 Vue Router 之外的真实静态页，必须整页跳转
  if (tool.external) window.location.href = tool.route
  else router.push(tool.route)
}

// 首次挂载时拉取工具列表
onMounted(fetchTools)
</script>

<template>
  <!-- 纵向 flex 布局：header 贴顶、main 撑开、footer 在内容不足时也贴底 -->
  <el-container class="home-layout" direction="vertical">
    <!-- 顶部导航：AppHeader 自带 position: sticky，直接作为 flex 子项即可固定在顶部 -->
    <AppHeader />

    <el-main class="home-main">
      <!-- 内层容器：全局 .qt-container 负责居中与最大宽 1200px，这里补上内边距 -->
      <div class="qt-container home-container">
        <!-- 页面标题区 -->
        <div class="home-hero">
          <h1 class="home-hero__title">在线实用工具箱</h1>
          <p class="home-hero__subtitle">{{ APP_INFO.slogan }}</p>
        </div>

        <!-- 分类标题 -->
        <h2 class="home-section-title">文本与编码工具</h2>

        <!-- 接口失败提示（同时下方仍会渲染兜底数据，首页保持可用） -->
        <el-alert v-if="loadError" class="home-alert" type="error" title="工具加载失败" show-icon />

        <!-- 加载中：骨架屏占位 -->
        <el-row v-if="loading" :gutter="20">
          <el-col v-for="n in 4" :key="n" :xs="24" :sm="12" :md="8" :lg="6">
            <el-skeleton class="home-skeleton" :rows="3" animated />
          </el-col>
        </el-row>

        <!-- 工具卡片网格：手机 1 列 / 平板 2 列 / 中等屏 3 列 / 大屏 4 列 -->
        <el-row v-else :gutter="20">
          <el-col v-for="item in toolList" :key="item.id" :xs="24" :sm="12" :md="8" :lg="6">
            <div class="tool-card" @click="goTool(item)">
              <div class="tool-card__icon">
                <component :is="iconComp(item.icon)" v-if="iconComp(item.icon)" />
              </div>
              <h3 class="tool-card__name">{{ item.name }}</h3>
              <p class="tool-card__desc">{{ item.desc }}</p>
            </div>
          </el-col>
        </el-row>
      </div>
    </el-main>

    <!-- 页脚：AppFooter 自带 margin-top: auto，作为 flex 子项在内容不足时也贴底 -->
    <AppFooter />
  </el-container>
</template>

<style scoped lang="scss">
/* 整页纵向布局：最小高度铺满视口，使内容不足时页脚仍贴底 */
.home-layout {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background-color: var(--qt-bg-page);
}

/* 主体撑满剩余空间，内边距交给内部容器 */
.home-main {
  flex: 1;
  padding: 0;
  background-color: var(--qt-bg-page);
}

/* 仅补上下内边距：左右 16px 已由全局 .qt-container 提供，避免叠加 */
.home-container {
  padding: 24px 0 8px;
}

/* 标题区：居中 */
.home-hero {
  text-align: center;
  margin-bottom: 32px;

  &__title {
    margin: 0 0 8px;
    font-size: 28px;
    font-weight: 600;
    color: var(--qt-text-primary);
  }

  &__subtitle {
    margin: 0;
    font-size: 14px;
    color: var(--qt-text-secondary);
  }
}

/* 分类标题 */
.home-section-title {
  margin: 0 0 16px;
  font-size: 18px;
  font-weight: 600;
  color: var(--qt-text-primary);
}

.home-alert {
  margin-bottom: 16px;
}

/* 骨架屏：尺寸接近卡片，避免加载完成时布局跳动 */
.home-skeleton {
  margin-bottom: 20px;
  padding: 20px;
  border: 1px solid var(--qt-border);
  border-radius: 8px;
  background-color: var(--qt-bg-card);
  box-sizing: border-box;
}

/* 工具卡片 */
.tool-card {
  margin-bottom: 20px; /* 配合 el-row 的 gutter 补足纵向间距 */
  padding: 20px;
  border: 1px solid var(--qt-border);
  border-radius: 8px;
  background-color: var(--qt-bg-card);
  cursor: pointer;
  transition: 0.2s;
  box-sizing: border-box;

  &:hover {
    background-color: var(--qt-bg-hover);
    transform: translateY(-4px);
    box-shadow: 0 6px 18px var(--qt-shadow);
  }

  &__icon {
    margin-bottom: 12px;
    color: var(--qt-primary);
    line-height: 1;

    :deep(svg) {
      width: 28px;
      height: 28px;
    }
  }

  &__name {
    margin: 0 0 8px;
    font-size: 16px;
    font-weight: 600;
    color: var(--qt-text-primary);
  }

  &__desc {
    margin: 0;
    font-size: 13px;
    line-height: 1.6;
    color: var(--qt-text-secondary);
  }
}

/*
 * 卡片网格断点说明（Element Plus 栅格断点，由 el-row / el-col 响应式属性实现）：
 *   xs  < 768px   手机   → :xs="24" 每行 1 张
 *   sm  >= 768px  平板   → :sm="12" 每行 2 张
 *   md  >= 992px  中等屏 → :md="8"  每行 3 张
 *   lg  >= 1200px 桌面   → :lg="6"  每行 4 张
 */
</style>