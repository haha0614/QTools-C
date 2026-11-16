<!--
  WatermarkTool.vue —— 抖音去水印 / 无水印直链提取工具页
  路由：/tool/watermark
  原理：后端 qtools-tool 的 WatermarkController 调 Node 侧车（doc/watermark/douyin-parse.mjs），
        侧车用 playwright-core 驱动本机 Chrome 打开作品页，旁听浏览器自己发的 aweme/detail 响应，
        只取 video.play_addr（播放流，平台不加水印），绝不取 download_addr（下载流，带 logo+抖音号）。
  画质：侧车返回该作品的全部档位（按码率降序），本页默认选中第一档 = 最高画质。
-->
<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import ToolLayout from '@/layouts/ToolLayout.vue'
import { CopyDocument, Download } from '@element-plus/icons-vue'
import { parseWatermark, reportToolVisit } from '@/api/tool.js'

/** 粘贴区内容（支持整段分享文案） */
const input = ref('')
/** 解析中 */
const loading = ref(false)
/** 解析结果 */
const result = ref(null)
/** 错误信息 */
const errorText = ref('')
/** 当前选中的视频档位 url（默认第一档 = 最高画质） */
const selectedVideoUrl = ref('')

onMounted(() => {
  reportToolVisit('/tool/watermark')
})

/** 视频档位（侧车已按码率降序返回，第一个即最高画质） */
const videoOptions = computed(() => {
  const items = result.value?.items || []
  return items.filter(item => item.type === 'video')
})

/** 图片条目（图文笔记） */
const imageItems = computed(() => {
  const items = result.value?.items || []
  return items.filter(item => item.type === 'image')
})

/** 当前选中的档位对象 */
const selectedVideo = computed(() => {
  const list = videoOptions.value
  if (!list.length) return null
  return list.find(item => item.url === selectedVideoUrl.value) || list[0]
})

async function doParse() {
  const raw = String(input.value || '').trim()
  if (!raw) {
    ElMessage.warning('先粘贴抖音分享链接或整段分享文案')
    return
  }
  loading.value = true
  errorText.value = ''
  result.value = null
  selectedVideoUrl.value = ''
  try {
    // request.js 返回的是整个 { code, msg, data }，业务数据在 .data 里
    const res = await parseWatermark(raw)
    const data = (res && res.data) ? res.data : res
    result.value = data
    const first = (data?.items || []).find(item => item.type === 'video')
    selectedVideoUrl.value = first ? first.url : ''
    ElMessage.success('解析成功，默认已选最高画质')
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : ''
    if (/timeout/i.test(msg)) {
      errorText.value = '解析超时：首次解析要拉起浏览器（约 10~15 秒），请稍等几秒再点一次。'
    } else {
      errorText.value = msg || '解析失败'
    }
  } finally {
    loading.value = false
  }
}

/** 一键粘贴（需要浏览器授权剪贴板） */
async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText()
    if (text) {
      input.value = text
      ElMessage.success('已粘贴')
    } else {
      ElMessage.warning('剪贴板是空的')
    }
  } catch (e) {
    ElMessage.warning('浏览器不允许读取剪贴板，请手动 Ctrl+V')
  }
}

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url)
    ElMessage.success('直链已复制')
  } catch (e) {
    ElMessage.warning('复制失败，请手动选中复制')
  }
}

/** CDN 有防盗链，浏览器直连会 403，所以走后端代理 */
function download(item) {
  if (!item || !item.url) return
  const name = String(result.value?.title || 'douyin').replace(/\.(mp4|jpg)$/i, '')
  const target = '/api/tool/watermark/download?url=' + encodeURIComponent(item.url)
    + '&name=' + encodeURIComponent(name)
  const a = document.createElement('a')
  a.href = target
  // 显式 download 属性：同源请求下浏览器会强制下载，
  // 不再依赖 Content-Disposition（某些浏览器对 video/mp4 会直接内联播放）
  a.download = name + (item.type === 'image' ? '.jpg' : '.mp4')
  // 不再开新标签：download 属性 + 服务端 attachment 已保证直接保存，
  // 保留 target=_blank 只会多留一个 about:blank 空标签。
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  ElMessage.info('已开始下载，大文件请稍候')
}

function clearAll() {
  input.value = ''
  result.value = null
  errorText.value = ''
  selectedVideoUrl.value = ''
}
</script>

<template>
  <ToolLayout title="去水印" desc="粘贴抖音分享链接，取回无水印原片直链" :local-only="false">
    <div class="wm-card">
      <el-input
        v-model="input"
        type="textarea"
        :rows="4"
        resize="none"
        placeholder="把抖音分享内容整段粘进来，例如：&#10;7.89 复制打开抖音... https://v.douyin.com/xxxxxxx/ 复制此链接，打开Dou音搜索，直接观看视频！"
      />

      <div class="wm-actions">
        <el-button @click="pasteFromClipboard">粘贴</el-button>
        <el-button @click="clearAll">清空</el-button>
        <el-button type="primary" :loading="loading" @click="doParse">
          {{ loading ? '解析中（首次约 10 秒）' : '解析无水印' }}
        </el-button>
      </div>

      <el-alert v-if="errorText" :title="errorText" type="error" :closable="false" show-icon />

      <div v-if="result" class="wm-result">
        <div class="wm-meta">
          <img v-if="result.cover" :src="result.cover" class="wm-cover" alt="封面" referrerpolicy="no-referrer" />
          <div class="wm-info">
            <div class="wm-title">{{ result.title || '（无标题）' }}</div>
            <div class="wm-sub">
              <span>{{ result.platform }}</span>
              <span v-if="result.author">· {{ result.author }}</span>
              <span v-if="result.duration">· {{ result.duration }} 秒</span>
              <span v-if="result.width">· {{ result.width }}×{{ result.height }}</span>
            </div>
          </div>
        </div>

        <!-- 视频：画质选择 + 下载 -->
        <div v-if="videoOptions.length" class="wm-video">
          <div class="wm-row">
            <span class="wm-row-label">画质</span>
            <el-select
              v-if="videoOptions.length > 1"
              v-model="selectedVideoUrl"
              class="wm-select"
              placeholder="选择画质"
            >
              <el-option
                v-for="(item, i) in videoOptions"
                :key="i"
                :label="item.label + (i === 0 ? '（最高）' : '')"
                :value="item.url"
              />
            </el-select>
            <el-tag v-else size="small" type="info">{{ videoOptions[0].label }}</el-tag>

            <div class="wm-row-actions">
              <el-button size="small" type="primary" :icon="Download" @click="download(selectedVideo)">下载</el-button>
              <el-button size="small" :icon="CopyDocument" @click="copyLink(selectedVideo.url)">复制直链</el-button>
            </div>
          </div>
          <p v-if="videoOptions.length > 1" class="wm-hint">
            共 {{ videoOptions.length }} 档，默认已选最高画质（{{ videoOptions[0].label }}）。
            同分辨率下码率更高的那档画面信息量更大；H.265 档同画质文件更小但需本地播放器解码。
          </p>
        </div>

        <!-- 图文：逐张原图 -->
        <div v-for="(item, i) in imageItems" :key="'img' + i" class="wm-row wm-row-image">
          <el-tag size="small" type="success">图片 {{ i + 1 }}</el-tag>
          <div class="wm-row-actions">
            <el-button size="small" type="primary" :icon="Download" @click="download(item)">下载</el-button>
            <el-button size="small" :icon="CopyDocument" @click="copyLink(item.url)">复制直链</el-button>
          </div>
        </div>

        <el-alert type="warning" :closable="false" title="直链带签名，通常几小时内失效，请及时保存。" />
      </div>

      <p class="wm-note">
        取的是平台播放流（原片，无水印）。若原作者把水印烧进了视频本身，则任何去水印工具都无法还原——
        这不是平台的下载水印。请仅用于个人学习与备份，勿用于二次发布或商用；内容版权归原作者所有。
      </p>
    </div>
  </ToolLayout>
</template>

<style scoped>
.wm-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.wm-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  flex-wrap: wrap;
}
.wm-result {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 10px;
}
.wm-meta {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}
.wm-cover {
  width: 84px;
  height: 112px;
  object-fit: cover;
  border-radius: 8px;
  flex: none;
  background: var(--el-fill-color-light);
}
.wm-info {
  min-width: 0;
}
.wm-title {
  font-weight: 600;
  line-height: 1.5;
  word-break: break-word;
}
.wm-sub {
  margin-top: 6px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.wm-video {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
}
.wm-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.wm-row-image {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
}
.wm-row-label {
  font-size: 13px;
  color: var(--el-text-color-regular);
  flex: none;
}
.wm-select {
  width: 300px;
  max-width: 100%;
}
.wm-row-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}
.wm-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}
.wm-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}
</style>
