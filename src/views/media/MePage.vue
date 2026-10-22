<!--
  MePage.vue —— 媒体站「我的」页（Vue 版）
  路由：/me，meta.title = '我的 · 媒体站'
  说明：新页面走顶层路径而不是 /media/me —— /media/** 在部署层被静态目录占用
        （nginx location /media/ + Spring SpaEntryController 都硬编码指向旧静态页），
        走 /me 零基础设施改动、可随时回滚，旧页 /media/me.html 保持原样可用。

  来源：等价改写 public/media/me.html + me.js 的渲染逻辑，功能语义对照 public/media/profile.js。
        旧页 /media/me.html 保持可用，本页只新增，不改动 public/media/**。

  内容（对照旧页 me.js / profile.js 实现）：
    1. 顶部导航：视频库(/video) / 图片站(/photos) / 回到工具站(/)
    2. 昵称 + 头像：头像支持「8 套内置渐变」与「上传图片（裁剪 128×128 webp）」，均可保存
    3. 最近浏览：视频 / 图片分组，视频显示观看进度条，按时间倒序（服务端顺序，前端不再排序）
    4. 收藏：视频 / 图片分组，可点星标取消收藏（乐观更新，列表即时变化）

  数据（全部走共用层，不自建通道）：
    - 昵称 / 头像   GET  /api/media/user        ← useMediaApi().getUser
    - 收藏列表      GET  /api/media/fav/list    ← useMediaApi().listFav
    - 最近浏览      GET  /api/media/recent/list ← useMediaApi().listRecent（返回 { videos, photos }）
    - 取消收藏      DELETE /api/media/fav       ← useMediaApi().delFav
    - 保存昵称头像  POST /api/media/user        ← useMediaApi().saveUser({ profile })
    身份走 X-Ms-Owner（ms.owner），与 C 端 useAppAuth 的 app.token 是两套体系，本页不涉及登录态。
    三个读接口相互独立：任一失败只影响对应区块并给出重试入口，全部失败才整页报错。

  埋点：useMediaTrack().pageView('/me') —— 上报 page_view（targetType 'page' / targetKey '/me'）
        与工具级访问各一次，并在 pagehide / visibilitychange 时自动结算停留时长。

  主题：样式取自 src/views/media/mediaTheme.scss（局部模式，只在本页 .media-scope 容器内生效，
        不污染全局短名 --bg / --fg），亮暗自动跟随 html.dark。本页不写任何主题判断。
-->
<!--
  说明：本项目未接入 unplugin-auto-import（package.json 无该依赖、vite.config.js 未配 AutoImport，
        其余视图 Home.vue / TextCount.vue 也都是显式 import），因此这里显式引入，
        否则运行期会报 'ref is not defined'。
-->
<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  getUser,
  listFav,
  listRecent,
  delFav,
  saveUser,
  itemThumbUrl
} from '@/composables/useMediaApi'
import { useMediaTrack } from '@/composables/useMediaTrack'

/** 本页在埋点里的 pageKey，与将来 page_view 的 path 保持一致 */
const PAGE_KEY = '/me'
/** 内置渐变头像套数，与旧页 profile.js 的 GRADS 一致 */
const GRAD_COUNT = 8
/** 头像渐变选择的 localStorage 键：与旧页共用，保证新旧页显示同一个头像 */
const GRAD_KEY = 'ms.avatar.grad'
/** 取消收藏失败等提示的显示时长，与旧页 toast 的 2.4s 一致 */
const NOTICE_MS = 2400

const tk = useMediaTrack()

// ========== 页面数据态 ==========
const profile = ref({ nick: '我', avatar: null })
const favorites = ref([])
const recentVideos = ref([])
const recentPhotos = ref([])

const loading = ref(false)
/** 整页失败（三个接口全都挂了）才置为文案，此时只给一块重试入口 */
const error = ref('')
/** 分区块失败标记：各自独立降级，不影响其它区块 */
const profileError = ref(false)
const favError = ref(false)
const recentError = ref(false)
/** 操作类临时提示（取消收藏未保存等），到点自动消失 */
const notice = ref('')

const favVideos = computed(() => favorites.value.filter((f) => f.kind !== 'photo'))
const favPhotos = computed(() => favorites.value.filter((f) => f.kind === 'photo'))

// ========== 头像 ==========
/** 头像是否为上传的图片（data:image/*），否则回退到内置渐变色块 + 昵称首字 */
const avatarIsImage = computed(() => /^data:image\//.test(profile.value.avatar || ''))
/** 昵称首字，取不到时用「我」（与旧页 firstChar 一致） */
const avatarChar = computed(() => String(profile.value.nick || '我').trim().slice(0, 1) || '我')

/**
 * 读取本机保存过的渐变序号；0 表示没存过，交给昵称哈希决定
 * localStorage 在隐私模式下可能抛错，一律当没存过
 */
function readSavedGrad() {
  try {
    const g = parseInt(localStorage.getItem(GRAD_KEY), 10)
    if (g >= 1 && g <= GRAD_COUNT) return g
  } catch {
    /* 忽略 */
  }
  return 0
}

/** 没存过渐变时按昵称哈希取一个稳定的色号（与旧页 gradIndex 的算法一致） */
function hashGrad(nick) {
  const s = String(nick || '我')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return (Math.abs(h) % GRAD_COUNT) + 1
}

// 用 ref 承接「已保存的渐变」，保存后赋值即可驱动 computed 重算（localStorage 本身不是响应式的）
const savedGrad = ref(readSavedGrad())
const gradIndex = computed(() => savedGrad.value || hashGrad(profile.value.nick))
const avatarGradClass = computed(() => (avatarIsImage.value ? '' : 'mm-g' + gradIndex.value))

// ========== 列表分组 ==========
/**
 * 收藏项 / 最近浏览项的唯一键，用于 v-for 的 key 与取消收藏定位
 * 图片：photo:相册#序号（后端同时给 i 与 seq，取到哪个用哪个）  视频：video:id
 */
function favKey(item) {
  if (!item) return ''
  if (item.kind === 'photo') {
    const seq = parseInt(item.i != null ? item.i : item.seq, 10) || 0
    return 'photo:' + (item.album || '') + '#' + seq
  }
  return 'video:' + (item.id || '')
}

/**
 * 列表项的落地页地址
 * 迁移期指向旧的静态页（带 hash 参数，旧页 index.js / photo.js 靠 hash 定位播放与相册）；
 * 等 /video 与 /photos 迁完后，这里改成站内路由即可，其余代码不用动。
 */
function itemHref(item) {
  if (item && item.kind === 'photo') {
    const seq = parseInt(item.i != null ? item.i : item.seq, 10) || 0
    return '/media/photos.html#album=' + encodeURIComponent(item.album || '') + '&i=' + seq
  }
  return '/media/index.html#play=' + encodeURIComponent((item && item.id) || '')
}

/**
 * 两个大区块的分组结构统一成一份数据，模板只循环一次
 * 顺序与旧页 me.html 一致：先「最近浏览」再「收藏」
 */
const sections = computed(() => [
  {
    key: 'recent',
    title: '最近浏览',
    mode: 'recent',
    empty: '还没有浏览记录',
    errorText: recentError.value ? '最近浏览加载失败，请重试。' : '',
    total: recentVideos.value.length + recentPhotos.value.length,
    groups: [
      { label: '视频', items: recentVideos.value },
      { label: '图片', items: recentPhotos.value }
    ]
  },
  {
    key: 'fav',
    title: '收藏',
    mode: 'fav',
    empty: '还没有收藏',
    errorText: favError.value ? '收藏加载失败，请重试。' : '',
    total: favVideos.value.length + favPhotos.value.length,
    groups: [
      { label: '视频', items: favVideos.value },
      { label: '图片', items: favPhotos.value }
    ]
  }
])

/**
 * 观看进度百分比（只有「最近浏览」里的视频才显示）
 * pos / dur 任一不为正数时返回 0，模板据此不渲染进度条
 */
function progressOf(item) {
  const pos = +item.pos || 0
  const dur = +item.dur || 0
  if (pos <= 0 || dur <= 0) return 0
  return Math.min(100, +((pos / dur) * 100).toFixed(1))
}

// ========== 提示 ==========
let noticeTimer = 0

/** 顶部临时提示（对应旧页的 toast），到点自动消失 */
function showNotice(text) {
  notice.value = text
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = ''
  }, NOTICE_MS)
}

// ========== 加载 ==========
/**
 * 拉取「我的」数据：三个接口并行且互不影响
 * 单个失败 → 只让对应区块显示错误与重试入口；三个全挂 → 整页错误块
 */
async function load() {
  loading.value = true
  error.value = ''
  profileError.value = false
  favError.value = false
  recentError.value = false

  const [meRes, favRes, recRes] = await Promise.allSettled([
    getUser(),
    listFav(),
    listRecent()
  ])

  // 昵称 / 头像
  const me = meRes.status === 'fulfilled' ? meRes.value : null
  if (me && me.profile) {
    profile.value = {
      nick: me.profile.nick || '我',
      avatar: typeof me.profile.avatar === 'string' ? me.profile.avatar : null
    }
  } else {
    profileError.value = true
  }

  // 收藏（后端返回裸数组；只保留 video / photo 两种 kind，与旧页 normalize 一致）
  if (favRes.status === 'fulfilled' && Array.isArray(favRes.value)) {
    favorites.value = favRes.value.filter((f) => f && (f.kind === 'video' || f.kind === 'photo'))
  } else {
    favError.value = true
  }

  // 最近浏览（后端返回 { videos, photos }，各自已是倒序且每类最多 50 条）
  const rec = recRes.status === 'fulfilled' ? recRes.value : null
  if (rec && (Array.isArray(rec.videos) || Array.isArray(rec.photos))) {
    recentVideos.value = Array.isArray(rec.videos) ? rec.videos.filter((r) => r && r.id) : []
    recentPhotos.value = Array.isArray(rec.photos)
      ? rec.photos.filter((r) => r && r.album != null)
      : []
  } else {
    recentError.value = true
  }

  // 三个接口全挂才算整页失败：此时分区提示已无意义，收敛成一块重试入口
  if (profileError.value && favError.value && recentError.value) {
    error.value = '「我的」数据加载失败：请检查网络，或确认后端 /api/media 服务可用。'
  }

  loading.value = false
}

// ========== 取消收藏 ==========
/**
 * 取消收藏
 * 先乐观地把条目从列表里摘掉（旧页也是立即响应，不等服务端），再以服务端返回的
 * 完整用户对象里的 favorites 为准对齐；DELETE /api/media/fav 是幂等接口。
 */
async function removeFav(item) {
  const key = favKey(item)
  const seq = parseInt(item.i != null ? item.i : item.seq, 10) || 0
  favorites.value = favorites.value.filter((f) => favKey(f) !== key)
  try {
    const res = await delFav(
      { kind: item.kind, id: item.id, album: item.album, seq: item.kind === 'photo' ? seq : undefined },
      // 静默：失败文案由本页内联提示，避免再叠一条全局消息
      { silent: true }
    )
    // 服务端返回的是完整用户对象，favorites 已是权威结果
    if (res && Array.isArray(res.favorites)) {
      favorites.value = res.favorites.filter((f) => f && (f.kind === 'video' || f.kind === 'photo'))
    }
  } catch (err) {
    // 与旧页一致：不回滚乐观结果，只明确告知未保存
    showNotice('取消收藏未保存（服务端不可用）')
  }
}

// ========== 编辑资料 ==========
const editing = ref(false)
const saving = ref(false)
const edMsg = ref('')
const form = ref({ nick: '我', avatar: null, grad: 1 })
const nickInput = ref(null)
const fileInput = ref(null)

/** 打开编辑弹窗：用当前资料初始化表单 */
function openEditor() {
  form.value = {
    nick: profile.value.nick || '我',
    avatar: avatarIsImage.value ? profile.value.avatar : null,
    grad: savedGrad.value || gradIndex.value
  }
  edMsg.value = ''
  editing.value = true
  // 等弹窗渲染完再聚焦并全选昵称（30ms 足以跨过 Vue 的一次渲染）
  setTimeout(() => {
    const el = nickInput.value
    if (el) {
      el.focus()
      el.select()
    }
  }, 30)
}

function closeEditor() {
  editing.value = false
}

/** 选内置渐变：同时放弃已选的上传图（与旧页一致） */
function pickGrad(g) {
  form.value = { ...form.value, grad: g, avatar: null }
}

function pickFile() {
  if (fileInput.value) fileInput.value.click()
}

/**
 * 处理头像上传：居中裁剪成 128×128 webp，失败时降级 png
 * 逻辑照抄旧页 onFile，只是把结果写进表单而不是旧页的模块级变量
 */
function onFile(event) {
  const file = event.target.files && event.target.files[0]
  if (!file) return
  // 清空选择值，保证再次选同一张也能触发 change
  event.target.value = ''
  if (!/^image\//.test(file.type)) {
    edMsg.value = '请选择图片文件'
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 128
        canvas.height = 128
        const ctx = canvas.getContext('2d')
        const side = Math.min(img.width, img.height) || 1
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 128, 128)
        let out = canvas.toDataURL('image/webp', 0.85)
        if (out.indexOf('data:image/') !== 0) out = canvas.toDataURL('image/png')
        form.value = { ...form.value, avatar: out }
        edMsg.value = ''
      } catch (err) {
        edMsg.value = '图片处理失败，请换一张'
      }
    }
    img.onerror = () => {
      edMsg.value = '图片无法解析'
    }
    img.src = String(reader.result || '')
  }
  reader.onerror = () => {
    edMsg.value = '读取文件失败'
  }
  reader.readAsDataURL(file)
}

/**
 * 保存昵称 / 头像
 * 校验规则与旧页一致：非空、最多 24 字；成功后把渐变选择写回 localStorage
 */
async function saveEditor() {
  const nick = String(form.value.nick || '').trim()
  if (!nick) {
    edMsg.value = '昵称不能为空（1–24 字）'
    return
  }
  if (nick.length > 24) {
    edMsg.value = '昵称最多 24 字'
    return
  }
  const avatar = form.value.avatar || null
  saving.value = true
  edMsg.value = ''
  try {
    const res = await saveUser({ profile: { nick, avatar } }, { silent: true })
    const saved = res && res.profile ? res.profile : { nick, avatar }
    profile.value = {
      nick: saved.nick || nick,
      avatar: typeof saved.avatar === 'string' ? saved.avatar : avatar
    }
    profileError.value = false
    // 上传了图片就不再需要渐变；否则记住用户选的色号，下次进入仍是同一套
    savedGrad.value = avatar ? 0 : form.value.grad
    try {
      localStorage.setItem(GRAD_KEY, String(savedGrad.value))
    } catch (err) {
      /* 隐私模式：忽略，本次会话内的显示不受影响 */
    }
    closeEditor()
  } catch (err) {
    // 与旧页不同的唯一一处：保存失败时保留弹窗，让用户能直接重试（旧页是关窗 + toast）
    edMsg.value = '保存失败，服务端暂不可用，请稍后重试'
  } finally {
    saving.value = false
  }
}

// ========== 生命周期 ==========
/** Esc 关闭弹窗（旧页在 document 上监听，这里用同样方式以覆盖点击遮罩之外的场景） */
function onKeydown(event) {
  if (event.key === 'Escape' && editing.value) closeEditor()
}

onMounted(() => {
  // 埋点：page_view（targetType 'page' / targetKey '/me'）与工具访问各一次，
  // 之后的停留时长由 useMediaTrack 在 pagehide / visibilitychange 时自动结算
  tk.pageView(PAGE_KEY)
  load()
  document.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  // useMediaTrack 在 setup 内调用时会自行 onBeforeUnmount(dispose)，这里只管本页自己的监听
  document.removeEventListener('keydown', onKeydown)
  clearTimeout(noticeTimer)
})
</script>

<template>
  <!-- media-scope：mediaTheme.scss 局部模式的容器类，--bg / --fg 等短名只在此容器内生效 -->
  <div class="media-scope media-me">
    <!-- 顶部导航：站点内三条路由；视频库 / 图片站目前是「迁移中」占位页，
         内容里给出了旧页 /media/index.html 与 /media/photos.html 的入口 -->
    <nav class="mm-nav" aria-label="站点导航">
      <router-link class="mm-nav-a" to="/video">视频库</router-link>
      <router-link class="mm-nav-a" to="/photos">图片站</router-link>
      <router-link class="mm-nav-a" to="/">回到工具站</router-link>
    </nav>

    <!-- 昵称 / 头像 -->
    <header class="mm-head">
      <span class="mm-av" :class="avatarGradClass">
        <img v-if="avatarIsImage" :src="profile.avatar" alt="" />
        <template v-else>{{ avatarChar }}</template>
      </span>
      <div class="mm-id">
        <h1 class="mm-nick">{{ profile.nick || '我' }}</h1>
        <button class="mm-edit" type="button" @click="openEditor">编辑</button>
      </div>
    </header>

    <!-- 昵称头像单独失败：其余区块照常可用 -->
    <p v-if="profileError && !error" class="mm-empty mm-empty--err">
      昵称 / 头像加载失败，当前显示默认值。
    </p>

    <!-- 操作类临时提示（取消收藏未保存等），到点自动消失 -->
    <p v-if="notice" class="mm-empty mm-empty--err" role="status">{{ notice }}</p>

    <!-- 首屏加载中 -->
    <p v-if="loading" class="mm-empty">正在加载…</p>

    <!-- 三个接口全挂：整页重试 -->
    <p v-else-if="error" class="mm-empty mm-empty--err">
      <span>{{ error }}</span>
      <button class="mm-retry" type="button" @click="load">重试</button>
    </p>

    <!-- 两个大区块：最近浏览 / 收藏 -->
    <template v-else>
      <section v-for="sec in sections" :key="sec.key" class="mm-sec">
        <h2 class="mm-sec-h">{{ sec.title }}</h2>

        <!-- 该区块接口失败：给出可读提示与重试，而不是伪装成空态 -->
        <p v-if="sec.errorText" class="mm-empty mm-empty--err">
          <span>{{ sec.errorText }}</span>
          <button class="mm-retry" type="button" @click="load">重试</button>
        </p>

        <template v-else>
          <!-- 视频 / 图片分组：哪组为空就不渲染，两组都空时走下面的空态 -->
          <template v-for="group in sec.groups" :key="group.label">
            <div v-if="group.items.length" class="mm-g">
              <h3 class="mm-g-h">
                {{ group.label }}<em>{{ group.items.length }}</em>
              </h3>
              <ul class="mm-list">
                <li v-for="item in group.items" :key="favKey(item)" class="mm-item">
                  <!-- 链接指向旧页对应位置（#play / #album），迁移完成后改为站内路由 -->
                  <a class="mm-link" :href="itemHref(item)" :title="item.title || ''">
                    <span class="mm-th">
                      <img
                        v-if="itemThumbUrl(item)"
                        :src="itemThumbUrl(item)"
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                      <i
                        v-if="sec.mode === 'recent' && progressOf(item) > 0"
                        class="mm-prog"
                        :style="{ width: progressOf(item) + '%' }"
                      ></i>
                    </span>
                    <span class="mm-t">{{
                      item.title || (item.kind === 'photo' ? '图片' : '视频')
                    }}</span>
                  </a>
                  <!-- 星标只在收藏分组出现：取消收藏 -->
                  <button
                    v-if="sec.mode === 'fav'"
                    class="mm-star"
                    type="button"
                    aria-label="取消收藏"
                    title="取消收藏"
                    @click="removeFav(item)"
                  >
                    ★
                  </button>
                </li>
              </ul>
            </div>
          </template>

          <p v-if="!sec.total" class="mm-empty">{{ sec.empty }}</p>
        </template>
      </section>
    </template>

    <!-- 编辑资料弹窗 -->
    <div v-if="editing" class="mm-modal" @click.self="closeEditor">
      <div class="mm-modal-card" role="dialog" aria-modal="true" aria-label="编辑资料">
        <h3 class="mm-modal-h">编辑资料</h3>

        <label class="mm-field">
          <span class="mm-field-t">昵称（1–24 字）</span>
          <input
            ref="nickInput"
            v-model="form.nick"
            class="mm-input"
            type="text"
            maxlength="24"
            autocomplete="off"
            placeholder="1–24 字"
            @keydown.enter.prevent="saveEditor"
          />
        </label>

        <div class="mm-field">
          <span class="mm-field-t">头像</span>
          <div class="mm-grads">
            <button
              v-for="g in GRAD_COUNT"
              :key="g"
              class="mm-grad"
              :class="['mm-g' + g, { 'mm-grad--on': !form.avatar && form.grad === g }]"
              type="button"
              :aria-label="'内置头像 ' + g"
              @click="pickGrad(g)"
            ></button>
          </div>
        </div>

        <div class="mm-field">
          <button class="mm-upload" type="button" @click="pickFile">
            {{ form.avatar ? '更换图片（已选）' : '上传图片' }}
          </button>
          <input ref="fileInput" type="file" accept="image/*" hidden @change="onFile" />
          <span class="mm-hint">自动裁成 128×128 webp</span>
        </div>

        <p v-if="edMsg" class="mm-msg">{{ edMsg }}</p>

        <div class="mm-modal-actions">
          <button class="mm-btn" type="button" @click="closeEditor">取消</button>
          <button
            class="mm-btn mm-btn--primary"
            type="button"
            :disabled="saving"
            @click="saveEditor"
          >
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
/* 媒体站变量映射层，局部模式：只在 .media-scope 容器内输出 --bg / --fg / --line / --accent 等，
   不污染全局短名。亮暗由 mediaTheme.scss 的 :root / html.dark 两套映射自动跟随。 */
@use './mediaTheme.scss' with ($global: false);

/* ========== 本页私有令牌 ==========
   标准主题色（--bg / --bg-2 / --bg-3 / --fg / --fg-dim / --line / --accent / --danger / --radius）
   全部直接用 mediaTheme.scss 的变量；这里只保留主题层没有提供、且必须由本页决定的取值，
   集中一处方便后续替换。 */
.media-me {
  /* 强调色之上（按钮、渐变头像）的文字 */
  --mt-on-accent: #fff;
  /* 星标压在封面图上，属于「图像上层」配色，不随主题变化 */
  --mt-star-bg: rgba(0, 0, 0, 0.58);
  --mt-star-bg-hover: rgba(255, 93, 93, 0.82);
  --mt-star-fg: #ffc977;
  /* 弹窗遮罩 */
  --mt-veil: rgba(0, 0, 0, 0.45);
  /* 头像 8 套内置渐变：沿用旧页 profile.css 的配色 */
  --mt-av-1: linear-gradient(135deg, #4c8dff, #8f6cff);
  --mt-av-2: linear-gradient(135deg, #ff7a7a, #ff9f45);
  --mt-av-3: linear-gradient(135deg, #21c9a5, #4c8dff);
  --mt-av-4: linear-gradient(135deg, #ffb547, #ff6f91);
  --mt-av-5: linear-gradient(135deg, #8f6cff, #ff6f91);
  --mt-av-6: linear-gradient(135deg, #3ddc97, #c1e64a);
  --mt-av-7: linear-gradient(135deg, #ff5d5d, #8f6cff);
  --mt-av-8: linear-gradient(135deg, #4c8dff, #21c9a5);

  // 版心宽度与内边距对齐旧页 .me-wrap
  max-width: 860px;
  margin: 0 auto;
  padding: 0 16px calc(24px + env(safe-area-inset-bottom, 0px));
  font-size: 14px;
  line-height: 1.6;
}

/* ---------- 顶部导航 ---------- */
/* 前缀 .media-me 是为了压过 mediaTheme.scss 里 .media-scope a 的强调色规则 */
.mm-nav {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 14px 0 10px;
  border-bottom: 1px solid var(--line);
}

.media-me .mm-nav-a {
  font-size: 13px;
  color: var(--fg-dim);
  text-decoration: none;
  transition: color 0.16s;
}

.media-me .mm-nav-a:hover {
  color: var(--fg);
}

/* ---------- 昵称 / 头像 ---------- */
.mm-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 0 16px;
  border-bottom: 1px solid var(--line);
}

.mm-av {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  overflow: hidden;
  font-size: 26px;
  font-weight: 600;
  color: var(--mt-on-accent);
  user-select: none;
}

.mm-av img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.mm-id {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.mm-nick {
  margin: 0;
  font-size: 19px;
  font-weight: 600;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mm-edit {
  flex: 0 0 auto;
  height: 26px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: transparent;
  color: var(--fg-dim);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.16s, border-color 0.16s;
}

.mm-edit:hover {
  color: var(--fg);
  border-color: var(--accent);
}

/* ---------- 区块 ---------- */
.mm-sec {
  padding: 16px 0 4px;
}

.mm-sec-h {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--fg-dim);
}

.mm-g {
  margin-bottom: 14px;
}

.mm-g-h {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-dim);
}

/* 分组标题后的数量 */
.mm-g-h em {
  margin-left: 4px;
  font-style: normal;
  font-size: 11px;
  font-weight: 400;
  color: var(--fg-dim);
}

/* ---------- 卡片列表 ---------- */
.mm-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.mm-item {
  position: relative;
  min-width: 0;
}

.mm-link {
  display: block;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg-2);
  color: inherit;
  text-decoration: none;
  transition: border-color 0.16s;
}

.mm-link:hover {
  border-color: var(--accent);
}

.mm-th {
  position: relative;
  display: block;
  aspect-ratio: 16 / 10;
  overflow: hidden;
  background: var(--bg-3);
}

.mm-th img {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* 观看进度条 */
.mm-prog {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 3px;
  background: var(--accent);
}

.mm-t {
  display: block;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 取消收藏星标 */
.mm-star {
  position: absolute;
  right: 4px;
  top: 4px;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--mt-star-bg);
  color: var(--mt-star-fg);
  font-size: 13px;
  line-height: 22px;
  cursor: pointer;
  transition: background-color 0.16s, color 0.16s;
}

.mm-star:hover {
  background: var(--mt-star-bg-hover);
  color: var(--mt-on-accent);
}

/* ---------- 空态 / 提示 ---------- */
.mm-empty {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 14px;
  padding: 10px 12px;
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  font-size: 12.5px;
  color: var(--fg-dim);
}

/* 错误提示用危险色描边，与普通空态区分 */
.mm-empty--err {
  border-color: var(--danger);
  color: var(--danger);
}

.mm-retry {
  flex: 0 0 auto;
  height: 24px;
  padding: 0 10px;
  border: 1px solid currentColor;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

/* ---------- 编辑弹窗 ---------- */
.mm-modal {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: var(--mt-veil);
}

.mm-modal-card {
  width: 100%;
  max-width: 360px;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--bg-2);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
}

.mm-modal-h {
  margin: 0 0 14px;
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
}

.mm-field {
  display: block;
  margin-bottom: 14px;
}

.mm-field-t {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--fg-dim);
}

.mm-input {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
  font-family: inherit;
}

.mm-input:focus {
  outline: none;
  border-color: var(--accent);
}

/* 内置渐变选择 */
.mm-grads {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.mm-grad {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 50%;
  cursor: pointer;
}

.mm-grad--on {
  border-color: var(--fg);
}

.mm-upload {
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: transparent;
  color: var(--fg);
  font-size: 12.5px;
  cursor: pointer;
}

.mm-upload:hover {
  border-color: var(--accent);
}

.mm-hint {
  margin-left: 10px;
  font-size: 11.5px;
  color: var(--fg-dim);
}

.mm-msg {
  margin: 0 0 12px;
  font-size: 12.5px;
  color: var(--danger);
}

.mm-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.mm-btn {
  height: 32px;
  padding: 0 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: transparent;
  color: var(--fg);
  font-size: 13px;
  cursor: pointer;
}

.mm-btn:hover {
  border-color: var(--accent);
}

.mm-btn--primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--mt-on-accent);
}

.mm-btn--primary:disabled {
  opacity: 0.6;
  cursor: default;
}

/* ---------- 头像 / 选择器共用的 8 套渐变 ---------- */
.mm-g1 {
  background: var(--mt-av-1);
}
.mm-g2 {
  background: var(--mt-av-2);
}
.mm-g3 {
  background: var(--mt-av-3);
}
.mm-g4 {
  background: var(--mt-av-4);
}
.mm-g5 {
  background: var(--mt-av-5);
}
.mm-g6 {
  background: var(--mt-av-6);
}
.mm-g7 {
  background: var(--mt-av-7);
}
.mm-g8 {
  background: var(--mt-av-8);
}

/* ---------- 窄屏 ---------- */
@media (max-width: 768px) {
  .media-me {
    padding-left: 12px;
    padding-right: 12px;
  }

  .mm-list {
    grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
    gap: 8px;
  }

  .mm-av {
    width: 56px;
    height: 56px;
    font-size: 22px;
  }
}
</style>
