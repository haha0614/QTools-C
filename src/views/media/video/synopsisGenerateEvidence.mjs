/**
 * synopsisGenerateEvidence.mjs —— P5.47「⚡ 自动生成」证据（无浏览器；纯规则 + 真 .vue SSR）
 *
 * 跑法：cd QTools-C && node src/views/media/video/synopsisGenerateEvidence.mjs
 * 只读：不发网络请求、不写文件。
 *
 * 覆盖：
 *   A. 纯规则：按钮文案 / 默认走哪条路 / 来源提示 / 503 与超时的识别与文案 / 批量进度文案
 *   B. 生成流程：模型成功、模型 503 → 回退模板、模型超时 → 回退模板、模板模式、模板也失败 → 抛出
 *   C. SSR：信息栏「作品简介」区真的有「⚡ 自动生成」/「⚡ 重新生成」，off 档没有这个按钮
 *   D. 视频库工具栏的批量入口（源码契约）：按钮、handler、all/videoIds 两种投递方式、轮询间隔
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createServer } from 'vite'
import {
  GENERATE_LABEL,
  MODEL_NOT_READY_TEXT,
  REGENERATE_LABEL,
  SOURCE_TEMPLATE_HINT,
  batchFinished,
  batchProgressText,
  errorText,
  generateLabel,
  generateSynopsis,
  isModelNotReady,
  replyText,
  resolveMode,
  sourceHint
} from './synopsisGenerate.js'

let passed = 0
const failures = []
function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  ✓ ' + name)
    return
  }
  failures.push(name + (extra ? ' → ' + extra : ''))
  console.log('  ✗ ' + name + (extra ? ' → ' + extra : ''))
}
const eq = (actual, expected, name) => ok(actual === expected, name, '实际 ' + JSON.stringify(actual))

/* local 档要读 localStorage：SSR 环境没有，先塞一个最小实现 */
const store = {}
globalThis.localStorage = {
  get length() {
    return Object.keys(store).length
  },
  key: (i) => Object.keys(store)[i] || null,
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => {
    store[k] = String(v)
  },
  removeItem: (k) => {
    delete store[k]
  }
}

console.log('\n[A] 纯规则')
eq(GENERATE_LABEL, '⚡ 自动生成', 'A1 无内容文案是「⚡ 自动生成」')
eq(REGENERATE_LABEL, '⚡ 重新生成', 'A2 有内容文案是「⚡ 重新生成」')
eq(generateLabel(false), GENERATE_LABEL, 'A3 generateLabel(false) → 自动生成')
eq(generateLabel(true), REGENERATE_LABEL, 'A4 generateLabel(true) → 重新生成')
eq(resolveMode({ llm: { enabled: true } }), 'llm', 'A5 本地模型已配置 → 默认 llm')
eq(resolveMode({ llm: { enabled: false } }), 'template', 'A6 未配置 → template')
eq(resolveMode(null), 'template', 'A7 能力探测失败 → template（不让用户卡住）')
eq(sourceHint({ kind: 'llm', model: 'qwen2.5:1.5b' }), '由本地模型生成 · qwen2.5:1.5b', 'A8 模型来源提示带模型名')
eq(sourceHint({ kind: 'template' }), SOURCE_TEMPLATE_HINT, 'A9 模板来源提示「按现有信息生成」')
eq(sourceHint(null), '', 'A10 非预览态没有来源提示')
eq(MODEL_NOT_READY_TEXT, '本地模型未就绪（Ollama 未启动？）', 'A11 503 统一文案')

const e503 = Object.assign(new Error('req failed'), { status: 503 })
const eTimeout = Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' })
const e400 = Object.assign(new Error('mode 非法'), { status: 400 })
ok(isModelNotReady(e503), 'A12 503 判定为「模型未就绪」')
ok(isModelNotReady(eTimeout), 'A13 axios 超时判定为「模型未就绪」')
ok(!isModelNotReady(e400), 'A14 400 不算模型未就绪')
eq(errorText(e503), MODEL_NOT_READY_TEXT, 'A15 503 文案 = 本地模型未就绪（Ollama 未启动？）')
eq(errorText({ status: 400, body: { error: 'mode 只能是 llm 或 template' } }), 'mode 只能是 llm 或 template', 'A16 其它错误用后端原文')
eq(replyText({ synopsis: '一段简介' }), '一段简介', 'A17 解包 {synopsis}')
eq(replyText(null), '', 'A18 空回包不炸')
eq(batchProgressText({ status: 'running', total: 10, processed: 4, generated: 3, skipped: 1, failed: 0 }), '批量生成中 4/10（已生成 3 · 跳过 1）', 'A19 批量进行中文案')
eq(batchProgressText({ status: 'done', total: 3, processed: 3, generated: 2, skipped: 1, failed: 0 }), '批量生成完成 3/3（已生成 2 · 跳过 1）', 'A20 批量完成文案')
ok(batchFinished({ status: 'done' }) && !batchFinished({ status: 'running' }), 'A21 轮询终止条件')

console.log('\n[B] 生成流程（注入桩接口，不联网）')
const stubApi = (llmBody, templateBody) => {
  const calls = []
  return {
    calls,
    generateSynopsisLlm: async (id) => {
      calls.push('llm:' + id)
      if (llmBody instanceof Error) throw llmBody
      return llmBody
    },
    generateSynopsisTemplate: async (id) => {
      calls.push('template:' + id)
      if (templateBody instanceof Error) throw templateBody
      return templateBody
    }
  }
}

const capsLlm = { llm: { enabled: true, model: 'qwen2.5:1.5b' } }
const capsTpl = { llm: { enabled: false } }

{
  const api = stubApi({ synopsis: '模型写的简介。', model: 'qwen2.5:1.5b' }, { synopsis: '模板写的简介。' })
  const r = await generateSynopsis(api, 'v1', capsLlm)
  eq(r.text, '模型写的简介。', 'B1 模型成功 → 用模型结果')
  eq(r.source.kind, 'llm', 'B2 来源标记 llm')
  eq(r.notice, '', 'B3 模型成功时没有回退提示')
  eq(api.calls.join(','), 'llm:v1', 'B4 模型成功时不发模板请求')
}
{
  const api = stubApi(e503, { synopsis: '模板写的简介。' })
  const r = await generateSynopsis(api, 'v2', capsLlm)
  eq(r.text, '模板写的简介。', 'B5 模型 503 → 自动回退模板（用户不空手）')
  eq(r.source.kind, 'template', 'B6 回退后来源标记 template')
  ok(r.notice.indexOf(MODEL_NOT_READY_TEXT) === 0, 'B7 回退提示以「本地模型未就绪（Ollama 未启动？）」开头', r.notice)
  ok(r.fallback === true, 'B8 fallback 标记为 true')
  eq(api.calls.join(','), 'llm:v2,template:v2', 'B9 两条路径都试过')
}
{
  const api = stubApi(eTimeout, { synopsis: '模板写的简介。' })
  const r = await generateSynopsis(api, 'v3', capsLlm)
  eq(r.source.kind, 'template', 'B10 前端超时也回退模板')
  ok(r.notice.indexOf(MODEL_NOT_READY_TEXT) === 0, 'B11 超时的提示与 503 同一句')
}
{
  const api = stubApi(null, { synopsis: '模板写的简介。' })
  const r = await generateSynopsis(api, 'v4', capsTpl)
  eq(r.text, '模板写的简介。', 'B12 未配置模型 → 直接模板')
  eq(r.source.kind, 'template', 'B13 来源 template')
  eq(api.calls.join(','), 'template:v4', 'B14 未配置模型时不打模型接口')
}
{
  const api = stubApi(e503, Object.assign(new Error('模板也挂了'), { status: 400 }))
  let thrown = null
  try {
    await generateSynopsis(api, 'v5', capsLlm)
  } catch (err) {
    thrown = err
  }
  ok(thrown && thrown.message === '模板也挂了', 'B15 两条路都失败时抛模板错误（不掩盖真因）')
}

console.log('\n[C] SSR：信息栏「作品简介」区的按钮')
const server = await createServer({
  root: process.cwd(),
  configFile: false,
  plugins: [(await import('@vitejs/plugin-vue')).default()],
  resolve: { alias: { '@': process.cwd() + '/src' } },
  css: { preprocessorOptions: { scss: { api: 'modern' } } },
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error'
})
const panel = (await server.ssrLoadModule('/src/views/media/video/VideoMetaPanel.vue')).default
async function render(props) {
  return renderToString(createSSRApp({ render: () => h(panel, props) }))
}
const baseProps = (extra) => ({
  video: { id: 'p547probe01', title: 'P5.47 演示片', dur: 300 },
  level: 'full',
  dock: true,
  allTags: [],
  persons: [],
  actors: [],
  allPersons: [],
  studios: [],
  context: null,
  ...extra
})

/** SSR 会保留模板里的注释：断言前先剥掉，否则注释里的文案会造成假阳性 */
const strip = (html) => String(html).replace(/<!--[\s\S]*?-->/g, '')
/** 取「生成按钮」的可见文案（没有按钮 → ''） */
const genButtonText = (html) => {
  const m = strip(html).match(/<button[^>]*data-vp-syn-generate[^>]*>([^<]*)<\/button>/)
  return m ? m[1].trim() : ''
}

const hEmpty = await render(baseProps({ video: { id: 'p547-empty', title: '空简介', dur: 300 } }))
ok(hEmpty.includes('data-vp-syn-generate'), 'C1 空简介时「作品简介」区有生成按钮锚点')
eq(genButtonText(hEmpty), '⚡ 自动生成', 'C2 空简介 → 按钮文案「⚡ 自动生成」')
ok(hEmpty.includes('暂无简介'), 'C3 空简介仍显示占位（按钮与占位并存）')
ok(hEmpty.includes('＋ 写简介'), 'C4 手写入口没被生成按钮顶掉')

const hHas = await render(baseProps({ video: { id: 'p547-has', title: '有简介', dur: 300, synopsis: '旧的一段简介。' } }))
eq(genButtonText(hHas), '⚡ 重新生成', 'C5 已有内容 → 按钮文案「⚡ 重新生成」')
ok(hHas.includes('data-vp-syn-generate'), 'C6 已有内容时按钮仍在（重新生成不是新入口）')

const hOff = await render(baseProps({ level: 'off', video: { id: 'p547-off', title: 'off 档', dur: 300 } }))
ok(!hOff.includes('data-vp-syn-generate'), 'C7 off 档没有生成按钮（与其它编辑入口同档）')
eq(genButtonText(hOff), '', 'C8 off 档连按钮文案都渲染不出来')

console.log('\n[D] 视频库工具栏的批量入口（源码契约）')
const videoPage = readFileSync(fileURLToPath(new URL('../VideoPage.vue', import.meta.url)), 'utf8')
ok(videoPage.includes('data-syn-batch'), 'D1 工具栏有批量按钮锚点 data-syn-batch')
ok(videoPage.includes('⚡ 批量生成简介'), 'D2 按钮文案「⚡ 批量生成简介」')
ok(videoPage.includes('startSynopsisBatch'), 'D3 点击绑定 startSynopsisBatch')
ok(videoPage.includes('generateSynopsisBatch(payload)'), 'D4 真的调用批量接口')
ok(videoPage.includes('{ all: true, mode, overwrite: false }'), 'D5 无选中项时 all:true + overwrite:false')
ok(videoPage.includes('{ videoIds: picked, mode, overwrite: false }'), 'D6 有选中项时只处理选中项')
ok(videoPage.includes('api.getSynopsisJob(jobId'), 'D7 轮询任务进度')
ok(videoPage.includes('1500'), 'D8 轮询间隔 1.5s')
ok(videoPage.includes('data-syn-batch-progress'), 'D9 工具栏有进度行锚点')
ok(videoPage.includes('batchProgressText(synopsisBatchJob.value)'), 'D10 进度文案走纯规则')

console.log('')
if (failures.length) {
  console.log('P5.47 生成流程证据：' + passed + ' 通过 / ' + failures.length + ' 失败')
  failures.forEach((f) => console.log('  - ' + f))
  await server.close()
  process.exit(1)
}
console.log('P5.47 生成流程证据：' + passed + ' 通过 / 0 失败')
await server.close()

function here(name) {
  return fileURLToPath(new URL(name, import.meta.url))
}
