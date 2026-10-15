<!--
  PwdGen.vue —— 随机密码生成器（路由 /tool/pwd-gen）

  用途：
    纯前端生成随机密码。所有随机数均来自浏览器 Web Crypto API 的
    crypto.getRandomValues()，密码只在本地浏览器内存中生成与展示，
    不会上传服务器。

  依赖契约（签名由并行搭建的其他子代理固定，本页只做消费，不修改）：
    @/components/ToolHeader.vue  props: { title: String } —— 左侧面包屑 + 右侧主题切换
    @/components/AppFooter.vue   无 props —— 页脚
    @/api/tool.js                reportToolVisit(toolRoute)：内部自行完成 toolId 反查与埋点
                                 上报，且内部已 try/catch，不会抛错
  全局环境：
    Element Plus 已 app.use 全量注册；@element-plus/icons-vue 图标组件已全部全局注册。
    全局样式变量 --qt-*（bg-page / bg-card / bg-hover / text-primary / text-secondary /
    border / primary / shadow / danger）与全局类 .qt-container 由全局样式提供，
    本页一律使用变量取色，禁止硬编码颜色。
-->
<template>
  <div class="pwd-gen">
    <!-- 顶部：左侧面包屑「首页 > 随机密码生成器」 + 右侧主题切换 -->
    <ToolHeader title="随机密码生成器" />

    <main class="qt-container pwd-gen__main">
      <!-- ===================== 配置区域 ===================== -->
      <section class="pwd-gen__card">
        <h2 class="pwd-gen__card-title">生成配置</h2>

        <!-- 密码长度：el-slider 与 el-input-number 双向联动（二者绑定同一个 length ref） -->
        <div class="pwd-gen__row">
          <span class="pwd-gen__label">密码长度</span>
          <div class="pwd-gen__length">
            <el-slider v-model="length" :min="4" :max="64" class="pwd-gen__slider" />
            <el-input-number v-model="length" :min="4" :max="64" controls-position="right" />
          </div>
        </div>

        <!-- 字符类型：4 个复选框，默认全部勾选 -->
        <div class="pwd-gen__row pwd-gen__row--types">
          <span class="pwd-gen__label">字符类型</span>
          <div class="pwd-gen__checks">
            <el-checkbox v-model="useUpper">包含大写字母</el-checkbox>
            <el-checkbox v-model="useLower">包含小写字母</el-checkbox>
            <el-checkbox v-model="useNumber">包含数字</el-checkbox>
            <el-checkbox v-model="useSymbol">包含特殊符号</el-checkbox>
          </div>
        </div>

        <!-- 生成入口 -->
        <el-button type="primary" :icon="Refresh" @click="generate">生成密码</el-button>
      </section>

      <!-- ===================== 结果展示区域 ===================== -->
      <section class="pwd-gen__card">
        <!-- 一行内：左侧只读结果框 + 右侧复制按钮 -->
        <div class="pwd-gen__result">
          <el-input
            v-model="password"
            :readonly="true"
            class="pwd-gen__output"
            placeholder="点击生成密码"
          />
          <el-button :icon="CopyDocument" @click="copy">复制密码</el-button>
        </div>

        <!-- 安全提示（次文字色） -->
        <p class="pwd-gen__hint">本密码在本地浏览器生成，不会上传服务器</p>
      </section>
    </main>

    <AppFooter />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Refresh, CopyDocument } from '@element-plus/icons-vue'
import ToolHeader from '@/components/ToolHeader.vue'
import AppFooter from '@/components/AppFooter.vue'
import { reportToolVisit } from '@/api/tool.js'

/** 当前路由：仅用于 onMounted 中把路由路径交给埋点函数 */
const route = useRoute()

/** 密码长度：滑块与数字输入框双向联动的唯一数据源，默认 16 */
const length = ref(16)

/** 4 类字符的启用开关，默认全部勾选 */
const useUpper = ref(true)
const useLower = ref(true)
const useNumber = ref(true)
const useSymbol = ref(true)

/** 生成结果：只读展示；为空串时 el-input 自动显示占位提示「点击生成密码」 */
const password = ref('')

/** 字符池常量：提取成模块级常量，避免每次生成时重复创建字符串 */
const CHARSET_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const CHARSET_LOWER = 'abcdefghijklmnopqrstuvwxyz'
const CHARSET_NUMBER = '0123456789'
// 特殊符号池：注意池中最后一个字符是反引号。
// 这里用普通单引号字符串书写，反引号在单引号字符串里无需转义、也不会被当作模板字符串。
const CHARSET_SYMBOL = '!@#$%^&*()-_=+[]{};:,.<>?`'

/**
 * 从字符池中等概率随机取一个字符（拒绝采样 / rejection sampling）。
 *
 * 为什么不能直接写 value % pool.length？
 *   crypto.getRandomValues 给出的 32 位无符号随机数取值空间是 0 ~ 2^32-1（共 2^32 个）。
 *   当 pool.length 不能整除 2^32 时，取模之后靠前的字符会被更多原始值映射到，
 *   于是部分字符出现概率偏高，这就是「取模偏差」(modulo bias)。
 *   对密码生成器而言这属于安全性缺陷，必须消除。
 *
 * 消除办法（拒绝采样）：
 *   只在 [0, limit) 区间内取值，limit 是不超过 0xFFFFFFFF 的最大的 pool.length 整数倍：
 *       limit = Math.floor(0xFFFFFFFF / pool.length) * pool.length
 *   [0, limit) 内每个原始值对 pool.length 取模后都均匀落到每一个池下标；
 *   落在尾巴区域 [limit, 0xFFFFFFFF] 的随机值一律丢弃并重新取数，
 *   因此被接受的每个池下标严格等概率。
 *
 * @param {string} pool 非空字符池
 * @returns {string} 池中随机的一个字符
 */
function randomChar(pool) {
  // 可被 pool.length 整除的随机数上界；等于或超过它的随机值会带来取模偏差
  const limit = Math.floor(0xFFFFFFFF / pool.length) * pool.length
  // 拒绝采样循环：绝大多数情况下第一轮即命中（丢弃概率极小），期望循环次数 < 2
  for (;;) {
    // 取一个 32 位无符号随机整数（密码学安全随机源）
    const value = crypto.getRandomValues(new Uint32Array(1))[0]
    // 落在尾巴区域：丢弃重取，保证均匀性
    if (value >= limit) continue
    // 落在有效区间：取模得到均匀分布的池下标
    return pool[value % pool.length]
  }
}

/**
 * 生成密码：
 *   1) 按勾选顺序把各字符池拼成 pool；
 *   2) 一个类型都没勾选（pool 为空）时提示并中止；
 *   3) 逐位调用 randomChar 取字符。
 * 长度大于池大小时允许字符重复——不做去重，否则会削弱随机性且可能凑不满长度。
 */
function generate() {
  let pool = ''
  if (useUpper.value) pool += CHARSET_UPPER
  if (useLower.value) pool += CHARSET_LOWER
  if (useNumber.value) pool += CHARSET_NUMBER
  if (useSymbol.value) pool += CHARSET_SYMBOL

  // 兜底：一种字符类型都没选，池为空无法取样
  if (!pool) {
    ElMessage.warning('请至少选择一种字符类型')
    return
  }

  let result = ''
  for (let i = 0; i < length.value; i += 1) {
    result += randomChar(pool)
  }
  password.value = result
}

/**
 * 复制结果到剪贴板：
 *   优先 navigator.clipboard.writeText（异步、需要安全上下文），
 *   失败（非 https / 无权限 / 旧浏览器）时回退到 textarea + document.execCommand('copy')。
 */
async function copy() {
  // 结果为空时先提示，不进入复制流程
  if (!password.value) {
    ElMessage.warning('请先生成密码')
    return
  }

  let copied = false

  // 方案一：异步剪贴板 API
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(password.value)
      copied = true
    }
  } catch (e) {
    // 权限被拒或非安全上下文：忽略异常，走下面的回退方案
    copied = false
  }

  // 方案二（回退）：临时 textarea 选中 + execCommand('copy')
  if (!copied) {
    const textarea = document.createElement('textarea')
    textarea.value = password.value
    // 移出视口，避免页面抖动；只读避免移动端唤起键盘
    textarea.style.position = 'fixed'
    textarea.style.top = '-9999px'
    textarea.setAttribute('readonly', 'readonly')
    document.body.appendChild(textarea)
    textarea.select()
    try {
      copied = document.execCommand('copy')
    } catch (e) {
      copied = false
    }
    document.body.removeChild(textarea)
  }

  if (copied) {
    ElMessage.success('复制成功')
  } else {
    // 两种方案都失败时的最后兜底提示（用户可在结果框中手动选中复制）
    ElMessage.error('复制失败，请手动选择复制')
  }
}

// 页面挂载后上报访问埋点：reportToolVisit 内部自行反查 toolId 且已 try/catch，不会抛错
onMounted(() => {
  reportToolVisit(route.path)
})
</script>

<style scoped lang="scss">
.pwd-gen {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: var(--qt-bg-page);
  color: var(--qt-text-primary);
}

.pwd-gen__main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px 0 48px;
}

.pwd-gen__card {
  padding: 20px 24px;
  background: var(--qt-bg-card);
  border: 1px solid var(--qt-border);
  border-radius: 8px;
  box-shadow: var(--qt-shadow);
}

.pwd-gen__card-title {
  margin: 0 0 16px;
  font-size: 16px;
  font-weight: 600;
  color: var(--qt-text-primary);
}

.pwd-gen__row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}

.pwd-gen__row--types {
  align-items: flex-start;
}

.pwd-gen__label {
  flex: 0 0 72px;
  font-size: 14px;
  color: var(--qt-text-secondary);
}

.pwd-gen__length {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 16px;
}

.pwd-gen__slider {
  flex: 1;
  min-width: 160px;
}

.pwd-gen__checks {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: 8px 20px;
}

.pwd-gen__result {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pwd-gen__output {
  flex: 1;
}

/* 结果使用等宽字体，便于逐位核对密码 */
.pwd-gen__output :deep(.el-input__inner) {
  font-family: 'JetBrains Mono', 'Cascadia Mono', Consolas, Menlo, monospace;
  letter-spacing: 0.5px;
}

.pwd-gen__hint {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--qt-text-secondary);
}
</style>
