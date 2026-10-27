# 媒体站共用基础层（Vue 版）

把 `public/media/**` 手写页里重复实现的东西收敛成三层，供后续把媒体站页面改写成 Vue 页面时直接复用（手写页一行未改）。

## 三层职责

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 埋点 | `src/composables/useMediaTrack.js` | 单例：`page_view` / `dwell` / `play` / `play_end` 上报，`page_view` + `toolVisit` 自动上报，`pagehide`/`visibilitychange` 自动结算 |
| 数据 | `src/composables/useMediaApi.js` | `/api/media/*` 接口封装 + 资源 URL 构造（缩略图 / 预览图 / 原文件 / 转码流 / 字幕） |
| 样式 | `src/views/media/mediaTheme.scss` | 把媒体站变量名（`--bg/--fg/--line/--accent` …）映射到 `--qt-*`，亮暗自动跟随 |

## 新页面如何接入

```vue
<script setup>
import { onMounted } from 'vue'
import { useMediaTrack } from '@/composables/useMediaTrack'
import { useMediaApi } from '@/composables/useMediaApi'

const tk = useMediaTrack()      // 单例，多处调用返回同一份状态
const api = useMediaApi()

onMounted(async () => {
  tk.pageView('/media/index.html')                  // page_view + toolVisit 各一次，并开始计可见时长
  const idx = await api.getIndex({ silent: true })  // 失败不弹全局提示
  // <img :src="api.videoThumbUrl(v.id)"> / <video :src="api.streamUrl(v.rel, { q: '1080', startSec: 0 })">
})
// 组件卸载时 useMediaTrack 已自动 removeEventListener；
// 播放器：打开播放器调 tk.openPlaySession(id)，video 的 play 调 tk.trackPlayStart(id)，
// pause/ended/切视频 调 tk.trackPlayEnd(id, watchedMs, progressPercent)
</script>

<style lang="scss">
@use '@/views/media/mediaTheme.scss';   // 一次即可；只想局部生效用 with ($global: false) + .media-scope 容器
</style>
```

其它事件（`photo_click` / `album_view` / `search` / `tag_click` / `person_click`）直接调
`tk.track('photo_click', 'photo', albumId + '#' + seq, 0)`，不要自己再写一份上报通道。

## 与手写页的等价性约束（破坏任一条都会导致统计断档）

1. **事件名**：`page_view` / `dwell` / `play` / `play_end` / `photo_click` / `album_view` / `search` / `tag_click` / `person_click`，大小写与下划线必须一字不差。
2. **报文**：`POST {API}/media/track`，键固定为 `eventType / targetType / targetKey / ownerKey / valueNum / progress`；
   `valueNum` 取整并归零，`progress` 夹在 0–100；`targetKey` 一律字符串。工具访问是另一个接口
   `POST {API}/toolVisit/add`，body `{ toolId: 4 }`（媒体站在 tool_info 里的 id）。
3. **ownerKey**：`localStorage['ms.owner']` → 同名 cookie → `''`。数据接口另外用 `X-Ms-Owner` 请求头识别身份，
   响应体下发的 `ownerKey` 要回写 localStorage（`useMediaApi` 已自动做）。
   **P5.74**：`useMediaApi` 的 `mediaHeaders()` 在已登录（`localStorage['app.token']` 有值）时还会带
   `Authorization: Bearer <token>`，后端据此把数据归到账号（`u:<appUserId>`）；设备键照旧每次都发，
   登出即回到设备态。登录成功后 `AuthLoginForm` 会自动调 `POST /api/media/user/sync` 做一次幂等合并。
4. **page_view 去重**：同一 `pageKey` 在本次文档会话内只报一次（手写页是整页加载一次）；`targetKey` 取页面路径。
5. **play 按播放器会话去重**：`openPlaySession` 开会话，`trackPlayStart` 只报本会话第一次 `play`；
   换源 / 切清晰度不经过会话，不会重复计数。
6. **play_end 按段结算**：`watchedMs > 0` 才报，报完清零；暂停恢复算新的一段，重复调用同一段不会重复上报。
7. **URL 规则**：`/media/thumb/v/{id}`、`/media/thumb/p/{album}/{pad4(i)}`、`/media/preview/p/{album}/{pad4(i)}`、
   `/media/file?p=`、`/media/stream?p=&q=&t=`（`t` 为内容起点秒，向下取整、不为负），序号一律 4 位补零。

## 注意

- 手写页写死 `<meta name="color-scheme" content="dark">`；Vue 页面不要复制，亮暗由 `html.dark` 决定。
- 两个 composable 都显式 `import … from 'vue'`（本项目**没有**配置 `unplugin-auto-import`）；埋点走 `sendBeacon`/`fetch`，与 axios 数据请求分开，避免 401 钩子或全局提示干扰统计。
