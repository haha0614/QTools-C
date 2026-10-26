/**
 * P5.57 音频转写路径的单测：能力判定 / 回包映射 / 素材不足不静默回退
 *
 * 只测纯规则（synopsisGenerate.js），不碰 Vue / DOM / 网络 —— api 以对象注入，
 * 与 synopsisRules.test.mjs 同一套写法（node 直跑，无框架）。
 */
import assert from 'node:assert/strict'
import {
  AUDIO_OVERWRITE_CONFIRM,
  AUDIO_REGENERATE_LABEL,
  audioAvailable,
  generateAudioSynopsis
} from './synopsisGenerate.js'

let pass = 0
function ok(name, fn) {
  fn()
  pass += 1
  console.log('  ✓ ' + name)
}

console.log('P5.57 音频转写规则单测：')

ok('按钮文案与二次确认文案存在', () => {
  assert.equal(AUDIO_REGENERATE_LABEL, '🎧 用音频转写重新生成')
  assert.ok(AUDIO_OVERWRITE_CONFIRM.includes('覆盖'))
})

ok('capabilities 缺失 / 无 sources → 不可用', () => {
  assert.equal(audioAvailable(null), false)
  assert.equal(audioAvailable({}), false)
  assert.equal(audioAvailable({ sources: {} }), false)
  assert.equal(audioAvailable({ sources: { audio: {} } }), false)
})

ok('只有 available === true 才算可用（false 不算）', () => {
  assert.equal(audioAvailable({ sources: { audio: { available: false } } }), false)
  assert.equal(audioAvailable({ sources: { audio: { available: true } } }), true)
  // 字符串 'true' 不算：能力是布尔契约，宽松判定会让「按了就失败」回来
  assert.equal(audioAvailable({ sources: { audio: { available: 'true' } } }), false)
})

ok('成功回包 → source.kind=audio + material 透传', async () => {
  const api = {
    generateSynopsisAudio: async () => ({
      id: 'v1',
      synopsis: '女子在浴室里与人对话，气氛暧昧。',
      chars: 15,
      source: 'audio',
      model: 'qwen2.5:3b',
      material: { kind: 'audio', language: 'zh', segments: 12, audioSeconds: 360 }
    })
  }
  const result = await generateAudioSynopsis(api, 'v1')
  assert.equal(result.insufficient, false)
  assert.equal(result.text, '女子在浴室里与人对话，气氛暧昧。')
  assert.deepEqual(result.source, { kind: 'audio', model: 'qwen2.5:3b' })
  assert.equal(result.material.language, 'zh')
})

ok('insufficient:true → 空文本 + 用 audioReason 作为提示（不回退字幕 / 模板）', async () => {
  const api = {
    generateSynopsisAudio: async () => ({
      id: 'v2',
      synopsis: '',
      chars: 0,
      source: 'none',
      insufficient: true,
      reason: '该片没有可用字幕…',
      audioReason: 'whisper 转写超时（限时 120000ms）'
    })
  }
  const result = await generateAudioSynopsis(api, 'v2')
  assert.equal(result.insufficient, true)
  assert.equal(result.text, '')
  assert.equal(result.notice, 'whisper 转写超时（限时 120000ms）')
  assert.equal(result.source.kind, 'none')
})

ok('没有 audioReason 时退回 reason', async () => {
  const api = { generateSynopsisAudio: async () => ({ insufficient: true, reason: '音频转写不可用' }) }
  const result = await generateAudioSynopsis(api, 'v3')
  assert.equal(result.notice, '音频转写不可用')
})

ok('200 + 空文本（非 insufficient）→ 抛 503（由界面显示未就绪）', async () => {
  const api = { generateSynopsisAudio: async () => ({ id: 'v4', synopsis: '', insufficient: false }) }
  await assert.rejects(() => generateAudioSynopsis(api, 'v4'), (err) => err.status === 503)
})

console.log('P5.57 音频转写单测：' + pass + ' 组 / 0 失败')
