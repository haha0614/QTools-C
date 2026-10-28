/**
 * contentRating.js 单测（P5.99）：分级筛选条的显示规则与命中规则
 *
 * 跑法：node --test QTools-C/src/views/media/contentRating.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ratingOf, showRatingFilter, matchesRating, ratingLabel } from './contentRating.js'

const OPTIONS3 = [
  { value: 'general', label: '大众级', count: 429 },
  { value: 'guidance', label: '家长指导级', count: 1 },
  { value: 'restricted', label: '限制级', count: 2 }
]

test('ratingOf：缺键 / 空值 / 大小写都归一到 general 口径', () => {
  assert.equal(ratingOf({ contentRating: 'restricted' }), 'restricted')
  assert.equal(ratingOf({ contentRating: 'GUIDANCE ' }), 'guidance')
  assert.equal(ratingOf({}), 'general')
  assert.equal(ratingOf({ contentRating: '' }), 'general')
  assert.equal(ratingOf(null), 'general')
})

test('showRatingFilter：只有 ≥2 档可见时才渲染筛选条', () => {
  assert.equal(showRatingFilter([]), false)
  assert.equal(showRatingFilter(null), false)
  assert.equal(showRatingFilter([OPTIONS3[0]]), false)
  assert.equal(showRatingFilter([OPTIONS3[0], OPTIONS3[1]]), true)
  assert.equal(showRatingFilter(OPTIONS3), true)
})

test('matchesRating：空选择 = 不筛；否则按值命中', () => {
  assert.equal(matchesRating({ contentRating: 'general' }, []), true)
  assert.equal(matchesRating({ contentRating: 'general' }, undefined), true)
  assert.equal(matchesRating({ contentRating: 'restricted' }, ['restricted']), true)
  assert.equal(matchesRating({ contentRating: 'restricted' }, ['general']), false)
  // 老数据没有 contentRating：只有选中「大众级」才命中（与后端默认值一致）
  assert.equal(matchesRating({}, ['general']), true)
  assert.equal(matchesRating({}, ['restricted']), false)
  // 多选 = 组内「或」
  assert.equal(matchesRating({ contentRating: 'guidance' }, ['general', 'guidance']), true)
})

test('ratingLabel：取索引里的中文名，未知值原样返回', () => {
  assert.equal(ratingLabel(OPTIONS3, 'restricted'), '限制级')
  assert.equal(ratingLabel(OPTIONS3, 'xxx'), 'xxx')
  assert.equal(ratingLabel(null, 'general'), 'general')
})
