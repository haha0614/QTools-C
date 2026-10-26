/**
 * synopsisGenerate.js —— 作品简介「⚡ 自动生成」的**纯规则**（P5.47）
 *
 * 交互契约（用户定稿）：
 *   1. 只有一个按钮：有内容「⚡ 重新生成」、没内容「⚡ 自动生成」；
 *   2. 点下去：本地模型可用（capabilities.llm.enabled）就默认走本地模型，否则走模板；
 *   3. 生成结果进**可编辑预览态**，不自动落库（保存仍走 PUT .../synopsis）；
 *   4. 本地模型 503 / 超时 → 提示「本地模型未就绪（Ollama 未启动？）」并**自动回退模板生成**，
 *      不让用户空手（回退时带一句 notice，让用户知道这次不是模型写的）。
 *
 * 这里不碰 Vue / DOM / axios：组件只做「调规则 + 渲染」，单测直接跑本文件
 * （见 synopsisGenerate.test.mjs）；网络由调用方以 api 对象注入，便于用桩验证回退分支。
 */

/** 无内容时的按钮文案 */
export const GENERATE_LABEL = '⚡ 自动生成'
/** 已有内容时的按钮文案 */
export const REGENERATE_LABEL = '⚡ 重新生成'
/** 模板来源提示：让用户知道这行字是怎么来的（模板只写客观信息，不写剧情） */
export const SOURCE_TEMPLATE_HINT = '按现有信息生成（模板）'

/** 素材来源 → 提示前缀（P5.53：简介必须有内容素材，来源要说清楚） */
export const SOURCE_PREFIX = {
  subtitle: '由字幕内容生成',
  vision: '由画面内容生成',
  audio: '由音频转写生成',
  llm: '由本地模型生成'
}

/** 素材不足（后端 insufficient:true）时的默认提示 */
export const INSUFFICIENT_TEXT = '该片缺少可概括的内容素材（无字幕 / 无可识别画面），无法生成内容梗概'

/** 素材不足时提供的退路按钮文案（模板只写客观信息） */
export const TEMPLATE_FALLBACK_LABEL = '用模板生成客观信息'
/** 本地模型不可用时的统一文案（与后端 503 文案同义） */
export const MODEL_NOT_READY_TEXT = '本地模型未就绪（Ollama 未启动？）'

/** 按钮文案：有内容 = 重新生成 */
export function generateLabel(hasContent) {
  return hasContent ? REGENERATE_LABEL : GENERATE_LABEL
}

/**
 * 默认走哪条路：能力里 llm.enabled=true → 'llm'，否则 'template'
 * @param {{llm?:{enabled?:boolean}}|null} capabilities
 * @returns {'llm'|'template'}
 */
export function resolveMode(capabilities) {
  const llm = capabilities && capabilities.llm
  return llm && llm.enabled ? 'llm' : 'template'
}

/**
 * 预览态旁边的来源提示
 * @param {{kind?:string, model?:string}|null} source
 * @returns {string} subtitle / vision / audio / llm → 「由X生成 · {model}」；template → 「按现有信息生成（模板）」
 */
export function sourceHint(source) {
  if (!source || typeof source !== 'object') return ''
  if (source.kind === 'template' || source.kind === 'none') return SOURCE_TEMPLATE_HINT
  const prefix = SOURCE_PREFIX[source.kind] || SOURCE_PREFIX.llm
  const model = source.model ? String(source.model) : ''
  return model ? prefix + ' · ' + model : prefix
}

/** 从 axios / 业务错误里取 HTTP 状态（request.js 会把业务码挂在 error.status 上） */
function statusOf(err) {
  if (!err) return null
  if (err.status != null && Number.isFinite(Number(err.status))) return Number(err.status)
  const response = err.response
  if (response && response.status != null) return Number(response.status)
  if (err.body && Number.isFinite(Number(err.body.code))) return Number(err.body.code)
  return null
}

/**
 * 是否属于「本地模型没就绪」：503，或前端/网络超时
 * @param {*} err
 */
export function isModelNotReady(err) {
  if (!err) return false
  if (statusOf(err) === 503) return true
  const code = String(err.code || '')
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'ECONNREFUSED') return true
  const msg = String(err.message || '')
  return msg.indexOf('timeout') >= 0 || msg.indexOf('超时') >= 0
}

/**
 * 失败提示文案：503 / 超时 → 「本地模型未就绪（Ollama 未启动？）」，其余用后端 error 文案
 */
export function errorText(err) {
  if (isModelNotReady(err)) return MODEL_NOT_READY_TEXT
  const body = err && err.body
  if (body && typeof body.error === 'string' && body.error) return body.error
  const msg = String((err && err.message) || '')
  if (msg && msg.indexOf('Network Error') < 0) return msg
  return '生成失败：接口未就绪或网络异常'
}

/** 统一解包：{synopsis:string} → string（拿不到就是 ''） */
export function replyText(body) {
  if (!body || typeof body !== 'object') return ''
  return typeof body.synopsis === 'string' ? body.synopsis : ''
}

/**
 * 回包是不是「素材不足」（后端 P5.53 契约：HTTP 200 + insufficient:true + reason）
 * @param {*} body
 */
export function isInsufficient(body) {
  return !!body && typeof body === 'object' && body.insufficient === true
}

/**
 * 素材不足时给用户看的那句话（后端 reason 优先，其次本地默认文案）
 * @param {*} body
 */
export function insufficientText(body) {
  const reason = body && typeof body.reason === 'string' ? body.reason.trim() : ''
  return reason || INSUFFICIENT_TEXT
}

/**
 * 回包的素材来源
 * @param {*} body
 * @returns {{kind:string, model?:string}} subtitle / vision / audio / llm
 */
export function sourceOf(body) {
  const kind = body && typeof body.source === 'string' ? body.source : ''
  const model = body && body.model ? String(body.model) : ''
  if (kind === 'subtitle' || kind === 'vision' || kind === 'audio') return { kind, model }
  return { kind: 'llm', model }
}

/**
 * 模板生成（素材不足时的退路按钮）：只写客观信息，结果标注为「按现有信息生成（模板）」
 * @param {{generateSynopsisTemplate:Function}} api
 * @param {string} videoId
 * @returns {Promise<{text:string, source:{kind:string}, notice:string, insufficient:boolean}>}
 */
export async function generateTemplateSynopsis(api, videoId) {
  const body = await api.generateSynopsisTemplate(videoId)
  const text = replyText(body)
  if (!text) {
    const err = new Error('模板生成结果为空')
    err.status = 400
    throw err
  }
  return { text, source: { kind: 'template' }, notice: '', insufficient: false }
}

/**
 * 生成一次简介（预览，不落库）
 *
 * @param {{generateSynopsisLlm:Function, generateSynopsisTemplate:Function}} api 注入的接口
 * @param {string} videoId
 * @param {{llm?:{enabled?:boolean}}|null} capabilities
 * @returns {Promise<{text:string, source:{kind:string, model?:string}, notice:string, fallback?:boolean, insufficient?:boolean}>}
 *   素材不足时 text 恒为空串、insufficient=true、notice 是给用户看的原因（P5.53）
 * @throws 模板也失败时抛最后一个错误（前端据此 toast + 保持原状）
 */
export async function generateSynopsis(api, videoId, capabilities) {
  const mode = resolveMode(capabilities)
  if (mode === 'llm') {
    try {
      const body = await api.generateSynopsisLlm(videoId)
      // 素材不足（P5.53）：不是错误，是结论 —— 不塞空串、不静默回退模板，
      // 由界面显示 reason + 「用模板生成客观信息」按钮，把选择权交回用户。
      if (isInsufficient(body)) {
        return {
          text: '',
          source: { kind: 'none' },
          notice: insufficientText(body),
          insufficient: true,
          reason: String((body && body.reason) || '')
        }
      }
      const text = replyText(body)
      if (text) {
        return { text, source: sourceOf(body), notice: '', insufficient: false }
      }
      const empty = new Error('本地模型返回空内容')
      empty.status = 503
      throw empty
    } catch (err) {
      // 回退模板：先看还能不能拿到模板结果，拿不到就把原始错误抛出去（不要掩盖真因）
      let fallbackText = ''
      try {
        fallbackText = replyText(await api.generateSynopsisTemplate(videoId))
      } catch (fallbackErr) {
        throw isModelNotReady(err) ? fallbackErr : err
      }
      if (!fallbackText) throw err
      return {
        text: fallbackText,
        source: { kind: 'template' },
        notice: errorText(err) + '，已改用模板生成',
        fallback: true
      }
    }
  }
  const body = await api.generateSynopsisTemplate(videoId)
  const text = replyText(body)
  if (!text) {
    const err = new Error('模板生成结果为空')
    err.status = 400
    throw err
  }
  return { text, source: { kind: 'template' }, notice: '', insufficient: false }
}

/** 批量任务进度文案（工具栏一行，处理中途也能看出「已完成几条」） */
export function batchProgressText(job) {
  if (!job || typeof job !== 'object') return ''
  const total = Number(job.total) || 0
  const processed = Number(job.processed) || 0
  const generated = Number(job.generated) || 0
  const skipped = Number(job.skipped) || 0
  const failed = Number(job.failed) || 0
  const tail = '已生成 ' + generated + ' · 跳过 ' + skipped + (failed ? ' · 失败 ' + failed : '')
  if (job.status === 'failed') return '批量生成失败：' + (job.error || '未知错误')
  if (job.status === 'done') return '批量生成完成 ' + processed + '/' + total + '（' + tail + '）'
  return '批量生成中 ' + processed + '/' + total + '（' + tail + '）'
}

/** 任务是否已结束（完成或失败）——轮询到这里就停 */
export function batchFinished(job) {
  return !!job && (job.status === 'done' || job.status === 'failed')
}

export default {
  GENERATE_LABEL,
  REGENERATE_LABEL,
  SOURCE_TEMPLATE_HINT,
  SOURCE_PREFIX,
  INSUFFICIENT_TEXT,
  TEMPLATE_FALLBACK_LABEL,
  MODEL_NOT_READY_TEXT,
  generateLabel,
  resolveMode,
  sourceHint,
  isModelNotReady,
  errorText,
  replyText,
  isInsufficient,
  insufficientText,
  sourceOf,
  generateTemplateSynopsis,
  generateSynopsis,
  batchProgressText,
  batchFinished
}
