/**
 * P5.53 交付 4 的证据：前端「素材不足」与「来源提示」的**纯规则**断言
 *
 * 跑法（不需要浏览器）：
 *   cd QTools-C && node src/views/media/video/synopsisSourceEvidence.mjs
 */
import {
  INSUFFICIENT_TEXT,
  SOURCE_TEMPLATE_HINT,
  TEMPLATE_FALLBACK_LABEL,
  generateSynopsis,
  generateTemplateSynopsis,
  insufficientText,
  isInsufficient,
  sourceHint,
  sourceOf
} from './synopsisGenerate.js'

let passed = 0
const failed = []

function check(name, ok) {
  if (ok) {
    passed++
    console.log('  ✓ ' + name)
  } else {
    failed.push(name)
    console.log('  ✗ ' + name)
  }
}

function eq(actual, expected, name) {
  check(name + '（实际 ' + JSON.stringify(actual) + '）', actual === expected)
}

console.log('[A] 素材不足的契约（HTTP 200 + insufficient:true）')
eq(isInsufficient({ insufficient: true }), true, 'A1 insufficient:true 被识别')
eq(isInsufficient({ synopsis: 'x' }), false, 'A2 正常回包不算素材不足')
eq(isInsufficient(null), false, 'A3 空回包不算素材不足')
eq(insufficientText({ reason: '该片没有字幕' }), '该片没有字幕', 'A4 优先用后端 reason')
eq(insufficientText({}), INSUFFICIENT_TEXT, 'A5 没有 reason 用默认文案')
check('A6 默认文案提到「内容素材」', INSUFFICIENT_TEXT.indexOf('内容素材') >= 0)

console.log('[B] 来源提示（交付 4 要求区分四种来源）')
eq(sourceHint({ kind: 'subtitle', model: 'qwen2.5:1.5b' }), '由字幕内容生成 · qwen2.5:1.5b', 'B1 字幕来源')
eq(sourceHint({ kind: 'vision', model: 'qwen2.5:1.5b' }), '由画面内容生成 · qwen2.5:1.5b', 'B2 画面来源')
eq(sourceHint({ kind: 'audio', model: 'whisper' }), '由音频转写生成 · whisper', 'B3 转写来源')
eq(sourceHint({ kind: 'template' }), SOURCE_TEMPLATE_HINT, 'B4 模板来源标注为「按现有信息生成（模板）」')
check('B5 模板提示明确带「（模板）」', SOURCE_TEMPLATE_HINT.indexOf('（模板）') >= 0)
eq(sourceHint({ kind: 'llm', model: 'qwen2.5:1.5b' }), '由本地模型生成 · qwen2.5:1.5b', 'B6 旧回包（无 source）仍可用')
eq(sourceHint(null), '', 'B7 非预览态没有来源提示')
eq(TEMPLATE_FALLBACK_LABEL, '用模板生成客观信息', 'B8 退路按钮文案')

console.log('[C] 回包 → 来源映射')
eq(sourceOf({ source: 'subtitle', model: 'm' }).kind, 'subtitle', 'C1 source=subtitle')
eq(sourceOf({ source: 'none' }).kind, 'llm', 'C2 source=none 不回显素材来源')
eq(sourceOf({}).kind, 'llm', 'C3 缺 source 时按 llm 处理')

console.log('[D] 生成流程：素材不足不再静默回退模板')
const apiStub = (body) => ({
  generateSynopsisLlm: async () => body,
  generateSynopsisTemplate: async () => ({ synopsis: '模板结果' })
})

const caps = { llm: { enabled: true } }

const insufficient = await generateSynopsis(apiStub({ insufficient: true, reason: '该片没有字幕' }), 'v1', caps)
eq(insufficient.text, '', 'D1 素材不足时 text 是空串（不塞空内容进编辑框）')
eq(insufficient.insufficient, true, 'D2 insufficient 标记透传')
eq(insufficient.notice, '该片没有字幕', 'D3 notice 用后端 reason')
eq(insufficient.fallback, undefined, 'D4 不自动回退模板（退路由用户点按钮）')

const ok = await generateSynopsis(apiStub({ synopsis: '片中两人对坐饮茶。', source: 'subtitle', model: 'qwen2.5:1.5b' }), 'v1', caps)
eq(ok.text, '片中两人对坐饮茶。', 'D5 正常回包取正文')
eq(ok.source.kind, 'subtitle', 'D6 来源 subtitle 透传')
eq(ok.insufficient, false, 'D7 正常回包 insufficient=false')

const template = await generateTemplateSynopsis(apiStub({}), 'v1')
eq(template.text, '模板结果', 'D8 退路按钮走模板接口')
eq(template.source.kind, 'template', 'D9 退路结果来源标记 template')

const modelDown = await generateSynopsis(
  {
    generateSynopsisLlm: async () => {
      const err = new Error('本地模型未就绪')
      err.status = 503
      throw err
    },
    generateSynopsisTemplate: async () => ({ synopsis: '模板兜底' })
  },
  'v1',
  caps
)
eq(modelDown.text, '模板兜底', 'D10 503 仍回退模板（部署问题不等于素材不足）')
eq(modelDown.source.kind, 'template', 'D11 回退结果来源为 template')
check('D12 回退时提示「已改用模板生成」', String(modelDown.notice).indexOf('已改用模板生成') >= 0)

console.log('')
console.log('P5.53 来源/素材不足证据：' + passed + ' 通过 / ' + failed.length + ' 失败')
if (failed.length) {
  console.log('失败项：' + failed.join('；'))
  process.exit(1)
}
