/**
 * useMediaApi.js —— 媒体站接口与资源 URL 统一封装
 * 用途：把 /api/media/* 与图片/视频资源地址收口到一处，供 Vue 版媒体站页面复用；
 *      与 public/media 手写页共用同一套后端契约（见文件末尾的 URL 规则出处）。
 * 约定：
 *   1. 全部走 src/utils/request.js（baseURL = VITE_API_BASE_URL || '/api'，code !== 200 视为失败）。
 *   2. request.js 返回的是完整响应体；本文件统一解包 AjaxResult：存在数值 code 时，
 *      code === 200 取 data，其它直接抛错（拦截器已 reject，这里只是兜底）；媒体接口返回裸对象时原样返回。
 *   3. 身份走 X-Ms-Owner 请求头（与 profile.js 一致）；响应体里的 ownerKey 首次下发送回写
 *      localStorage['ms.owner']，保证与手写页是同一个 owner。
 *   4. 读接口默认 silent（失败不弹全局提示，页面自行容错，与手写页的 fetch 行为一致）；
 *      写接口默认非 silent（收藏/浏览记录失败要有反馈），可按调用点覆盖。
 *   5. 不引入任何新的 npm 依赖。
 */
import request from '@/utils/request'

/** 接口前缀：与 request.js 的 baseURL 同源，默认 '/api' */
const API_BASE = (import.meta.env && import.meta.env.VITE_API_BASE_URL) || '/api'
const MEDIA_PREFIX = '/media'
/** 设备标识键，与 profile.js / useMediaTrack.js 共用 */
const OWNER_STORE_KEY = 'ms.owner'

/* ------------------------------------------------------------ owner 与解包 */

function readOwner() {
  try {
    return localStorage.getItem(OWNER_STORE_KEY) || ''
  } catch {
    return ''
  }
}

function writeOwner(v) {
  if (!v || typeof v !== 'string' || readOwner() === v) return
  try {
    localStorage.setItem(OWNER_STORE_KEY, v)
  } catch {
    /* 隐私模式下忽略 */
  }
}

/** 组装请求头：始终带 accept，有 owner 时带 X-Ms-Owner（等价于 profile.js 的 userHeaders） */
function mediaHeaders(extra) {
  const headers = Object.assign({}, extra || {})
  const owner = readOwner()
  if (owner) headers['X-Ms-Owner'] = owner
  return headers
}

/** 解包 AjaxResult：存在数值 code 时成功取 data；媒体接口的裸对象/裸数组原样返回 */
function unwrap(body) {
  if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.code === 'number') {
    return body.code === 200 ? body.data : body
  }
  return body
}

/**
 * 统一请求出口：自动带 owner 头、自动解包、自动回写服务端下发的 ownerKey
 * @param {{url:string, method?:string, data?:any, params?:any, silent?:boolean, headers?:object}} config
 */
async function mediaRequest(config) {
  const res = await request({
    url: MEDIA_PREFIX + config.url,
    method: config.method || 'get',
    data: config.data,
    params: config.params,
    silent: config.silent !== false,
    headers: mediaHeaders(config.headers),
    // P5.47：本地模型单次生成可能超过 request.js 默认的 10s，按调用点放宽
    ...(config.timeout ? { timeout: config.timeout } : {})
  })
  // 服务端首次下发的 owner 落盘（裸对象与 AjaxResult 两种形态都兼容）
  const body = unwrap(res)
  const ownerFromBody =
    (body && typeof body === 'object' && typeof body.ownerKey === 'string' && body.ownerKey) ||
    (res && typeof res === 'object' && typeof res.ownerKey === 'string' && res.ownerKey) ||
    (res && typeof res === 'object' && res.data && typeof res.data.ownerKey === 'string' && res.data.ownerKey)
  if (ownerFromBody) writeOwner(ownerFromBody)
  return body
}

/* ------------------------------------------------------------------ 数据层 */

/**
 * 聚合索引（videos / albums / people / stats）
 * 后端：GET /api/media/index —— 带 ETag，命中 304 时 axios 仍按 200 走缓存体
 * @param {{silent?:boolean}} [options]
 */
export function getIndex(options) {
  const opt = options || {}
  return mediaRequest({ url: '/index', silent: opt.silent !== false })
}

/** 完整用户对象（profile / favorites / recent） 后端：GET /api/media/user */
export function getUser(options) {
  const opt = options || {}
  return mediaRequest({ url: '/user', silent: opt.silent !== false })
}

/**
 * 合并式更新用户数据 后端：POST /api/media/user
 * body 支持 { profile, favorites, recentVideos, recentPhotos }
 * @param {object} data
 * @param {{silent?:boolean}} [options]
 */
export function saveUser(data, options) {
  const opt = options || {}
  return mediaRequest({ url: '/user', method: 'post', data: data || {}, silent: opt.silent === true })
}

/**
 * 新增一条收藏（幂等） 后端：POST /api/media/fav
 * @param {{kind:'video'|'photo', id?:string, album?:string, seq?:number}} payload
 * @param {{silent?:boolean}} [options]
 */
export function addFav(payload, options) {
  const opt = options || {}
  return mediaRequest({ url: '/fav', method: 'post', data: payload || {}, silent: opt.silent === true })
}

/**
 * 取消收藏（幂等） 后端：DELETE /api/media/fav?kind=&id=&album=&seq=
 * 后端从 query 参数取键，因此这里用 params 而不是 body
 * @param {{kind:'video'|'photo', id?:string, album?:string, seq?:number}} payload
 * @param {{silent?:boolean}} [options]
 */
export function delFav(payload, options) {
  const opt = options || {}
  const p = payload || {}
  return mediaRequest({
    url: '/fav',
    method: 'delete',
    params: { kind: p.kind, id: p.id, album: p.album, seq: p.seq },
    silent: opt.silent === true
  })
}

/** 收藏列表 后端：GET /api/media/fav/list（裸数组） */
export function listFav(options) {
  const opt = options || {}
  return mediaRequest({ url: '/fav/list', silent: opt.silent !== false })
}

/**
 * 记录一次浏览 后端：POST /api/media/recent
 * @param {{kind:'video'|'photo', id?:string, album?:string, seq?:number, pos?:number, dur?:number}} payload
 * @param {{silent?:boolean}} [options]
 */
export function addRecent(payload, options) {
  const opt = options || {}
  return mediaRequest({ url: '/recent', method: 'post', data: payload || {}, silent: opt.silent === true })
}

/**
 * 最近浏览（视频 / 图片各最多 50） 后端：GET /api/media/recent/list?kind=video|photo
 * @param {{kind?:'video'|'photo', silent?:boolean}} [options]
 */
export function listRecent(options) {
  const opt = options || {}
  return mediaRequest({
    url: '/recent/list',
    params: opt.kind ? { kind: opt.kind } : undefined,
    silent: opt.silent !== false
  })
}

/** 身份 + 各类计数 后端：GET /api/media/me */
export function getMe(options) {
  const opt = options || {}
  return mediaRequest({ url: '/me', silent: opt.silent !== false })
}

/** 单片详情（含 tags / actors） 后端：GET /api/media/video/{id} */
export function getVideo(id, options) {
  const opt = options || {}
  return mediaRequest({ url: '/video/' + encodeURIComponent(String(id == null ? '' : id)), silent: opt.silent !== false })
}

/** 单册详情（含 photos，seq 升序） 后端：GET /api/media/album/{id} */
export function getAlbum(id, options) {
  const opt = options || {}
  return mediaRequest({ url: '/album/' + encodeURIComponent(String(id == null ? '' : id)), silent: opt.silent !== false })
}

/* ------------------------------------ 媒体库组织（M3：三档编辑策略 + 标签 / 评分 / 标记） */
/* 契约来源：M3-C 后端接口（站端匿名读、写受编辑策略管控）。所有写接口一律 silent
   （失败由调用方 toast 兜底），页面侧只提示不阻塞播放；后端尚未就绪时这里只会
   reject，不会抛出未捕获异常。
   路径约定：站端用 /tags、/video/{id}/meta、/videos/batch-meta（无 admin 前缀），
            管理端用 /admin/**；GET 元信息保留 legacy 回退（旧后端只有 admin 路径）。 */

/** 编辑策略 后端：GET /api/media/edit-policy → { level: 'off' | 'local' | 'full' }（匿名） */
export function getEditPolicy(options) {
  const opt = options || {}
  return mediaRequest({ url: '/edit-policy', silent: opt.silent !== false })
}

/** 标签库 后端：GET /api/media/tags → [{id,name,color,useCount}]（匿名只读） */
export function listTags(options) {
  const opt = options || {}
  return mediaRequest({ url: '/tags', silent: opt.silent !== false })
}

/**
 * 新建标签 后端：POST /api/media/tags（仅 full 档可写）body { name, color? }
 * @param {{name:string, color?:string}} payload
 * @param {{silent?:boolean}} [options]
 */
export function createTag(payload, options) {
  const opt = options || {}
  return mediaRequest({ url: '/tags', method: 'post', data: payload || {}, silent: opt.silent !== false })
}

/**
 * 单条元信息 后端：GET /api/media/video/{id}/meta → { rating, tags:[{id,name,color}], markers:[{id,pos,label,color}] }
 * 旧后端（仅 /admin/video/{id}/meta）时自动回退一次，站端 private 部署仍能读到标记。
 */
export async function getVideoMeta(id, options) {
  const opt = options || {}
  const path = '/video/' + encodeURIComponent(String(id == null ? '' : id)) + '/meta'
  try {
    return await mediaRequest({ url: path, silent: opt.silent !== false })
  } catch (err) {
    return mediaRequest({ url: '/admin' + path, silent: opt.silent !== false })
  }
}

/**
 * 单条更新 后端：PUT /api/media/video/{id}/meta（仅 full 档）
 * body 支持 { rating, addTagIds, removeTagIds, markers }
 * @param {string} id
 * @param {{rating?:number, addTagIds?:string[], removeTagIds?:string[], markers?:object[]}} payload
 * @param {{silent?:boolean}} [options]
 */
export function saveVideoMeta(id, payload, options) {
  const opt = options || {}
  return mediaRequest({
    url: '/video/' + encodeURIComponent(String(id == null ? '' : id)) + '/meta',
    method: 'put',
    data: payload || {},
    silent: opt.silent !== false
  })
}

/**
 * 作品简介 / 剧情梗概（P5.38）
 * 后端：GET /api/media/video/{id}/synopsis → { id, synopsis }（synopsis 为 null = 暂无）
 * 读接口不受编辑策略影响（off 档站端也要能看到已有简介）；换行原样返回。
 * 与 getVideoMeta 一样：站端 404/405 时自动回退到 /admin 一路（private 部署的旧后端）。
 */
export async function getVideoSynopsis(id, options) {
  const opt = options || {}
  const path = '/video/' + encodeURIComponent(String(id == null ? '' : id)) + '/synopsis'
  try {
    return await mediaRequest({ url: path, silent: opt.silent !== false })
  } catch (err) {
    return mediaRequest({ url: '/admin' + path, silent: opt.silent !== false })
  }
}

/**
 * 写作品简介 后端：PUT /api/media/video/{id}/synopsis（仅 full 档）
 * body { synopsis }（null / 空串 = 清空）→ { id, synopsis }（已 trim、纯空白归一化成 null）
 * @param {string} id
 * @param {{synopsis:string|null}} payload
 * @param {{silent?:boolean}} [options]
 */
export function saveVideoSynopsis(id, payload, options) {
  const opt = options || {}
  return mediaRequest({
    url: '/video/' + encodeURIComponent(String(id == null ? '' : id)) + '/synopsis',
    method: 'put',
    data: payload || {},
    silent: opt.silent !== false
  })
}

/* ------------------------------------------------------------ 作品简介自动生成（P5.47） */

/**
 * 本地模型单次生成的前端超时：后端默认 qtools.media.llm.timeoutMs=20000，
 * 前端留 10s 余量（多出来的是排队 + 网络 + 后端拼素材的时间）。
 * 超过它前端按「超时」处理并自动回退模板，与后端 503 是同一条用户体验。
 */
const SYNOPSIS_LLM_TIMEOUT = 30000

/**
 * 生成能力 后端：GET /api/media/synopsis/capabilities
 * → { template:{maxChars}, llm:{enabled,provider,model} }
 * 读接口，「⚡ 自动生成」据 llm.enabled 决定默认走本地模型还是模板。
 * @param {{silent?:boolean}} [options]
 */
export function getSynopsisCapabilities(options) {
  const opt = options || {}
  return mediaRequest({ url: '/synopsis/capabilities', silent: opt.silent !== false })
}

/**
 * 模板生成（预览，不落库）后端：POST /api/media/video/{id}/synopsis/template
 * → { id, synopsis, chars, mode:'template' }
 * 落库仍走 saveVideoSynopsis（用户改完再保存）。
 * @param {string} id
 * @param {{silent?:boolean}} [options]
 */
export function generateSynopsisTemplate(id, options) {
  const opt = options || {}
  return mediaRequest({
    url: '/video/' + encodeURIComponent(String(id == null ? '' : id)) + '/synopsis/template',
    method: 'post',
    silent: opt.silent !== false
  })
}

/**
 * 本地模型生成（预览，不落库）后端：POST /api/media/video/{id}/synopsis/llm
 * → { id, synopsis, chars, mode:'llm', model, provider, ms }
 * 未启用 / Ollama 未启动 / 超时 → 503（error 体带明确文案），调用方据此回退模板。
 * @param {string} id
 * @param {{silent?:boolean, timeout?:number}} [options]
 */
export function generateSynopsisLlm(id, options) {
  const opt = options || {}
  return mediaRequest({
    url: '/video/' + encodeURIComponent(String(id == null ? '' : id)) + '/synopsis/llm',
    method: 'post',
    silent: opt.silent !== false,
    timeout: opt.timeout || SYNOPSIS_LLM_TIMEOUT
  })
}

/**
 * 批量生成 后端：POST /api/media/synopsis/generate（仅 full 档）
 * body { videoIds?:string[], all?:boolean, mode?:'template'|'llm', overwrite?:boolean } → 任务节点
 * 后端逐个处理、每完成一个立刻落库；进度用 getSynopsisJob 轮询。
 * @param {{videoIds?:string[], all?:boolean, mode?:string, overwrite?:boolean}} payload
 * @param {{silent?:boolean}} [options]
 */
export function generateSynopsisBatch(payload, options) {
  const opt = options || {}
  return mediaRequest({
    url: '/synopsis/generate',
    method: 'post',
    data: payload || {},
    silent: opt.silent !== false
  })
}

/**
 * 批量任务进度 后端：GET /api/media/synopsis/jobs/{jobId}
 * → { jobId, mode, status, total, processed, generated, skipped, failed, items:[{videoId,title,status,chars,ms,message}] }
 * @param {string} jobId
 * @param {{silent?:boolean}} [options]
 */
export function getSynopsisJob(jobId, options) {
  const opt = options || {}
  return mediaRequest({
    url: '/synopsis/jobs/' + encodeURIComponent(String(jobId == null ? '' : jobId)),
    silent: opt.silent !== false
  })
}

/**
 * 批量更新 后端：POST /api/media/videos/batch-meta（仅 full 档）
 * body { ids, addTagIds?, removeTagIds?, rating? } → { updated }
 * 一次请求覆盖全部选中项（页面侧合并成单次调用，不做逐条循环）
 * @param {{ids:string[], addTagIds?:string[], removeTagIds?:string[], rating?:number}} payload
 * @param {{silent?:boolean}} [options]
 */
export function batchVideoMeta(payload, options) {
  const opt = options || {}
  return mediaRequest({
    url: '/videos/batch-meta',
    method: 'post',
    data: payload || {},
    silent: opt.silent !== false
  })
}

/* ------------------------------------------------------- 保存筛选（P2-B） */
/* 契约：GET /api/media/filters → [{id,name,params}]（站端匿名读）
        POST /api/media/filters {name,params}（同名覆盖）
        DELETE /api/media/filters/{id}
   后端尚未部署（P2-A）时这里只会 reject：调用方一律 silent + catch，只 toast 不阻塞筛选。 */

/** 保存的筛选列表 后端：GET /api/media/filters → [{id,name,params}] */
export function listFilters(options) {
  const opt = options || {}
  return mediaRequest({ url: '/filters', silent: opt.silent !== false })
}

/**
 * 保存筛选（同名覆盖，后端按 name 去重） 后端：POST /api/media/filters
 * @param {{name:string, params:object}} payload
 * @param {{silent?:boolean}} [options]
 */
export function saveFilter(payload, options) {
  const opt = options || {}
  const p = payload || {}
  return mediaRequest({ url: '/filters', method: 'post', data: { name: p.name, params: p.params || {} }, silent: opt.silent !== false })
}

/** 删除筛选 后端：DELETE /api/media/filters/{id} */
export function deleteFilter(id, options) {
  const opt = options || {}
  return mediaRequest({
    url: '/filters/' + encodeURIComponent(String(id == null ? '' : id)),
    method: 'delete',
    silent: opt.silent !== false
  })
}

/* --------------------------------------------------------------- 人物（P3-B） */
/* 契约：GET /api/media/persons → [{id,name,avatar?,videoCount,albumCount}]（站端匿名读）
        GET /api/media/person/{id} → {id,name,...}
        GET /api/media/person/{id}/videos|albums?page=&size= → { rows|list, total }（分页）
   后端未部署人物接口时这几条统一 404：调用方一律 catch + 三态渲染，
   不抛未捕获异常、不弹全局错误（与 /filters 等未就绪接口一致）。 */

/** 人物列表（人物墙 / 筛选抽屉的人物分组） 后端：GET /api/media/persons */
export function listPersons(options) {
  const opt = options || {}
  return mediaRequest({ url: '/persons', silent: opt.silent !== false })
}

/** 单个人物 后端：GET /api/media/person/{id} */
export function getPerson(id, options) {
  const opt = options || {}
  return mediaRequest({ url: '/person/' + encodeURIComponent(String(id == null ? '' : id)), silent: opt.silent !== false })
}

/** 某人物名下的视频（分页） 后端：GET /api/media/person/{id}/videos?page=&size= */
export function listPersonVideos(id, params, options) {
  const opt = options || {}
  return mediaRequest({
    url: '/person/' + encodeURIComponent(String(id == null ? '' : id)) + '/videos',
    params: params || {},
    silent: opt.silent !== false
  })
}

/** 某人物名下的相册（分页） 后端：GET /api/media/person/{id}/albums?page=&size= */
export function listPersonAlbums(id, params, options) {
  const opt = options || {}
  return mediaRequest({
    url: '/person/' + encodeURIComponent(String(id == null ? '' : id)) + '/albums',
    params: params || {},
    silent: opt.silent !== false
  })
}

/* ------------------------------------------------------------- 工作室（P5-A） */
/* 契约：站端 GET /api/media/studios → [{id,name,videoCount}]（匿名只读）、
        GET /api/media/studio/{id} → {id,name,...}、
        GET /api/media/studio/{id}/videos?page=&size= → { rows|list, total }；
        索引侧 videos[].studios:[name] 是 Studio 名称数组（P5-A 在 /media/index 里补的字段）。
   后端未部署 P5-A 时这几条统一 404：调用方一律 silent + catch，抽屉分组收起或就地提示，
   与 /filters / /persons 的处理方式一致 —— 不抛未捕获异常、不弹全局错误。 */

/** 工作室列表（筛选抽屉的工作室分组） 后端：GET /api/media/studios */
export function listStudios(options) {
  const opt = options || {}
  return mediaRequest({ url: '/studios', silent: opt.silent !== false })
}

/** 单个工作室 后端：GET /api/media/studio/{id} */
export function getStudio(id, options) {
  const opt = options || {}
  return mediaRequest({ url: '/studio/' + encodeURIComponent(String(id == null ? '' : id)), silent: opt.silent !== false })
}

/** 某工作室名下的视频（分页） 后端：GET /api/media/studio/{id}/videos?page=&size= */
export function listStudioVideos(id, params, options) {
  const opt = options || {}
  return mediaRequest({
    url: '/studio/' + encodeURIComponent(String(id == null ? '' : id)) + '/videos',
    params: params || {},
    silent: opt.silent !== false
  })
}

/* ----------------------------------------------------------- 播放列表（P5-B） */
/* 契约（与 /filters、/persons 同一套站端 REST 风格；顺序即播放顺序）：
     GET    /api/media/playlists                        → [{id,name,count,videoIds?}]
     POST   /api/media/playlists  {name}                → {id,name,count}（视频另走追加）
     GET    /api/media/playlist/{id}                    → {id,name,videos:[…]} 或 {id,name,videoIds:[…]}
     PUT    /api/media/playlist/{id} {name?, videoIds?} → 改名 / 排序 / 增删（每次提交完整有序集合）
     DELETE /api/media/playlist/{id}
     POST   /api/media/playlist/{id}/videos {videoIds}  → 追加（后端按 id 幂等去重；只认 videoId 的老版本见 addPlaylistVideos）
   写接口受编辑策略闸门（页面在 off 档直接禁用入口，不发请求）；
   后端未就绪时全部 silent + catch，页面显示「接口未就绪」，不抛未捕获异常。 */

/** 播放列表清单 后端：GET /api/media/playlists */
export function listPlaylists(options) {
  const opt = options || {}
  return mediaRequest({ url: '/playlists', silent: opt.silent !== false })
}

/**
 * 新建播放列表 后端：POST /api/media/playlists  body **只有 name**
 *
 * <p>P5.41：后端 create 从来不读 videoIds（只认 name），旧实现把 videoIds 一起发过来是「发了但没人收」，
 * 于是「新建并加入」新建出来的列表永远是空的。现在新建只管新建，视频由调用方随后追加（追加是幂等的）。</p>
 * @param {{name:string}} payload
 * @param {{silent?:boolean}} [options]
 */
export function createPlaylist(payload, options) {
  const opt = options || {}
  const p = payload || {}
  return mediaRequest({
    url: '/playlists',
    method: 'post',
    data: { name: p.name },
    silent: opt.silent !== false
  })
}

/** 单个播放列表（含有序条目） 后端：GET /api/media/playlist/{id} */
export function getPlaylist(id, options) {
  const opt = options || {}
  return mediaRequest({ url: '/playlist/' + encodeURIComponent(String(id == null ? '' : id)), silent: opt.silent !== false })
}

/**
 * 更新播放列表（改名 / 改顺序 / 增删一次提交） 后端：PUT /api/media/playlist/{id}
 * @param {string} id
 * @param {{name?:string, videoIds?:string[]}} payload
 * @param {{silent?:boolean}} [options]
 */
export function updatePlaylist(id, payload, options) {
  const opt = options || {}
  return mediaRequest({
    url: '/playlist/' + encodeURIComponent(String(id == null ? '' : id)),
    method: 'put',
    data: payload || {},
    silent: opt.silent !== false
  })
}

/** 删除播放列表 后端：DELETE /api/media/playlist/{id} */
export function deletePlaylist(id, options) {
  const opt = options || {}
  return mediaRequest({
    url: '/playlist/' + encodeURIComponent(String(id == null ? '' : id)),
    method: 'delete',
    silent: opt.silent !== false
  })
}

/**
 * 追加视频到播放列表（幂等） 后端：POST /api/media/playlist/{id}/videos
 *
 * <p><b>双键发</b>（P5.41）：后端历史上只读 {@code videoId}（单条），一次请求加一个；
 * 只发 {@code videoIds} 会被判成 400「videoId 不能为空」——正是「加入播放列表失败」的真因。
 * 现在两个键都发：认识 {@code videoIds} 的后端一次加完，只认识 {@code videoId} 的老后端至少加进第一个，
 * 剩下的由调用方（usePlaylistAdd）按响应里的真实条目逐个补齐 —— 行为与后端版本无关。</p>
 * @param {string} id
 * @param {string[]} videoIds
 * @param {{silent?:boolean}} [options]
 */
export function addPlaylistVideos(id, videoIds, options) {
  const opt = options || {}
  const ids = (Array.isArray(videoIds) ? videoIds : [videoIds]).map((v) => String(v == null ? '' : v)).filter(Boolean)
  return mediaRequest({
    url: '/playlist/' + encodeURIComponent(String(id == null ? '' : id)) + '/videos',
    method: 'post',
    data: { videoId: ids[0], videoIds: ids },
    silent: opt.silent !== false
  })
}

/** 从播放列表移除一条 后端：DELETE /api/media/playlist/{id}/videos/{videoId} */
export function removePlaylistVideo(id, videoId, options) {
  const opt = options || {}
  return mediaRequest({
    url:
      '/playlist/' +
      encodeURIComponent(String(id == null ? '' : id)) +
      '/videos/' +
      encodeURIComponent(String(videoId == null ? '' : videoId)),
    method: 'delete',
    silent: opt.silent !== false
  })
}

/* ------------------------------------------------------------- 资源 URL 构造 */
/* 全部返回绝对路径（不含 origin），可直接给 <img src> / <video src> 使用。
   规则出处：app.js:862/978/1036/1037/1169，photo.js:99/101/102/103，profile.js:82-84。 */

/** 相册内序号补零到 4 位：photo.js:99 pad4 */
function pad4(n) {
  return String(n == null ? '' : n).padStart(4, '0')
}

/** 视频缩略图：app.js:862 `${API}/thumb/v/${v.id}`（profile.js:84 同规则） */
export function videoThumbUrl(id) {
  return API_BASE + '/media/thumb/v/' + encodeURIComponent(String(id == null ? '' : id))
}

/** 图片缩略图：photo.js:101 `MEDIA + '/thumb/p/' + albumId + '/' + pad4(i)` */
export function photoThumbUrl(albumId, i) {
  return API_BASE + '/media/thumb/p/' + encodeURIComponent(String(albumId == null ? '' : albumId)) + '/' + pad4(i)
}

/**
 * 视频精灵图：20 列 × 20 行（400 格），每格 160×90，成品 3200×1800（thumbs/s/<content_hash>.jpg）
 * 后端：GET /api/media/sprite/{id}，产物不存在即 404 —— 调用方先用 hasSprite 判断
 */
export function spriteUrl(id) {
  return API_BASE + '/media/sprite/' + encodeURIComponent(String(id == null ? '' : id))
}

/**
 * 视频预览视频：静音 320×180 4fps 5~8 秒（thumbs/pv2/<content_hash>.mp4｜.webm）
 * 后端：GET /api/media/preview/{id}，支持 Range；产物不存在即 404 —— 先用 hasPreview 判断
 */
export function previewUrl(id) {
  // 片段内容寻址：产物名是 content_hash，但对外 URL 用 videoId（不变），
  // 而服务端该 URL 带 immutable 缓存 —— 换了取帧算法后浏览器会一直用旧片段。
  // 加算法版本号做 cache buster：算法再变更时同步 +1 即可。
  const algo = 'v2'
  return API_BASE + '/media/preview/' + encodeURIComponent(String(id == null ? '' : id)) + '?algo=' + algo
}

/**
 * 实时取帧（P5.15）：`GET /media/frame/{id}?t=<整秒>` → 该时刻 480 宽 jpeg 一帧
 *
 * 后端按整秒落盘永久缓存（thumbs/frames/<content_hash>/<秒>.jpg），响应带 immutable：
 * 同一 URL 的字节永不变化，所以这里可以和 previewUrl 一样挂算法版本号做 cache buster ——
 * 换取帧参数（宽度 / 质量）时 +1，浏览器才会重新取图。
 *
 * @param {string} id  视频 id
 * @param {number} sec 整秒（调用方用 framePicker.frameSecond 取整，跨同一秒复用同一张图）
 */
export function frameUrl(id, sec) {
  const algo = 'f1'
  return (
    API_BASE +
    '/media/frame/' +
    encodeURIComponent(String(id == null ? '' : id)) +
    '?t=' +
    Math.max(0, Math.floor(Number(sec) || 0)) +
    '&algo=' +
    algo
  )
}

/**
 * 精确取帧（P5.18）：`GET /media/frame/{id}?t=<毫秒级秒数>` → 该**确切时刻**的一帧
 *
 * <p>与 {@link frameUrl} 的区别只在缓存语义：整秒取帧按 <秒>.jpg 永久落盘（hover 用，同一秒
 * 复用一张图），而这里的目标是「换流前把**目标位置的画面**盖上去」—— 向下取整会让用户先看到
 * 整秒那一帧、再看到真正落点（用户反馈的「先跳到整秒位置再跳到点击位置」）。所以这一路把小数
 * 原样发给后端，后端不落缓存（每个落点都不同，落了就是无上限的磁盘增长）。</p>
 *
 * <p>精度到毫秒：3.4 → `t=3.4`；6.266666666666667 → `t=6.267`（半帧 1/60 = 16.7ms，
 * 毫秒级远小于半帧，落点仍在同一帧上）。</p>
 *
 * @param {string} id  视频 id
 * @param {number} sec 目标时刻（秒，可含小数）
 */
export function frameExactUrl(id, sec) {
  const n = Number(sec)
  const t = !isFinite(n) || n <= 0 ? '0' : String(Math.round(n * 1000) / 1000)
  return (
    API_BASE +
    '/media/frame/' +
    encodeURIComponent(String(id == null ? '' : id)) +
    '?t=' +
    t +
    '&algo=f1e'
  )
}

/** 图片预览图：photo.js:102 `MEDIA + '/preview/p/' + albumId + '/' + pad4(i)` */
export function photoPreviewUrl(albumId, i) {
  return API_BASE + '/media/preview/p/' + encodeURIComponent(String(albumId == null ? '' : albumId)) + '/' + pad4(i)
}

/**
 * 由 thumbs/ 相对路径构造缩略图：profile.js:82 / me.js:29
 * `thumbs/xxx.jpg` → `${API_BASE}/media/thumb/xxx`
 * @param {string} rel
 */
export function thumbUrlFromRel(rel) {
  const s = String(rel == null ? '' : rel)
  if (s.indexOf('thumbs/') === 0) return API_BASE + '/media/thumb/' + s.slice(7).replace(/\.jpg$/i, '')
  return mediaFileUrl(s)
}

/** 原始文件：photo.js:103 `MEDIA + '/file?p=' + encodeURIComponent(rel)`（app.js:1036 同规则） */
export function mediaFileUrl(rel) {
  return API_BASE + '/media/file?p=' + encodeURIComponent(String(rel == null ? '' : rel))
}

/**
 * 秒值 → URL 里的 {@code t} 参数（P5.17）：保留到微秒，去掉浮点尾巴。
 * 6.266666666666667 @30fps → '6.266667'（误差 3.3e-7 秒）；3.4 → '3.4'；3 → '3'（与旧整数形态逐字一致）。
 * @param {number} sec
 */
export function streamStartParam(sec) {
  const n = Number(sec)
  if (!isFinite(n) || n <= 0) return '0'
  return String(Math.round(n * 1e6) / 1e6)
}

/**
 * 转码流：app.js:1037-1038 `MEDIA + '/stream?p=' + encodeURIComponent(v.rel) + '&q=' + q + '&t=' + floor(start)`
 *
 * P5.17：`t` 不再向下取整。转码流在浏览器里不可 seek（实测 `video.seekable` 恒为 `[0, 0]`，
 * 写 currentTime 会被夹回 0），所以帧级落点唯一的实现方式就是让服务端从**目标秒**出流；
 * 后端 `MediaStreamServiceImpl.parseStartSec` 接受小数、ffmpeg 用 `-ss <精确秒>`（accurate_seek）。
 * 向后兼容：整数 `t=3` 与改动前逐字相同，老后端（会 floor）拿到小数只是退化成旧的整秒行为。
 *
 * @param {string} rel 相对路径
 * @param {{q?:string|number, startSec?:number}} [options] q 为清晰度档位（默认 '1080'），startSec 为内容起点秒（可含小数）
 */
export function streamUrl(rel, options) {
  const opt = options || {}
  const q = opt.q == null || opt.q === '' ? '1080' : String(opt.q)
  const t = streamStartParam(opt.startSec)
  return API_BASE + '/media/stream?p=' + encodeURIComponent(String(rel == null ? '' : rel)) + '&q=' + q + '&t=' + t
}

/** 字幕文件：app.js:1169 `MEDIA + '/sub?p=' + encodeURIComponent(subRel)` */
export function subUrl(rel) {
  return API_BASE + '/media/sub?p=' + encodeURIComponent(String(rel == null ? '' : rel))
}

/**
 * 由收藏/最近浏览项算出缩略图地址（photo.js:448 契约：photo 项 thumb 是 thumbs/p/… 相对路径）
 * @param {{kind?:string, album?:string, i?:number, id?:string, thumb?:string}} item
 */
export function itemThumbUrl(item) {
  if (!item) return ''
  if (item.thumb && typeof item.thumb === 'string') return thumbUrlFromRel(item.thumb)
  if (item.kind === 'photo') return photoThumbUrl(item.album || '', item.i)
  if (item.id) return videoThumbUrl(item.id)
  return ''
}

const mediaApi = {
  // 数据层
  getIndex,
  getUser,
  saveUser,
  addFav,
  delFav,
  listFav,
  addRecent,
  listRecent,
  getMe,
  getVideo,
  getAlbum,
  // 媒体库组织（M3）
  getEditPolicy,
  listTags,
  createTag,
  getVideoMeta,
  saveVideoMeta,
  batchVideoMeta,
  // 作品简介（P5.38）
  getVideoSynopsis,
  saveVideoSynopsis,
  // 作品简介自动生成（P5.47）
  getSynopsisCapabilities,
  generateSynopsisTemplate,
  generateSynopsisLlm,
  generateSynopsisBatch,
  getSynopsisJob,
  // 保存筛选（P2-B）
  listFilters,
  saveFilter,
  deleteFilter,
  // 人物（P3-B）
  listPersons,
  getPerson,
  listPersonVideos,
  listPersonAlbums,
  // 工作室（P5-A）
  listStudios,
  getStudio,
  listStudioVideos,
  // 播放列表（P5-B）
  listPlaylists,
  createPlaylist,
  getPlaylist,
  updatePlaylist,
  deletePlaylist,
  addPlaylistVideos,
  removePlaylistVideo,
  // URL 构造
  videoThumbUrl,
  spriteUrl,
  previewUrl,
  frameUrl,
  frameExactUrl,
  photoThumbUrl,
  photoPreviewUrl,
  thumbUrlFromRel,
  mediaFileUrl,
  streamUrl,
  streamStartParam,
  subUrl,
  itemThumbUrl
}

export function useMediaApi() {
  return mediaApi
}

export default mediaApi
