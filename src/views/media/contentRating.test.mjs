/**
 * contentRating.js 单测（P5.99 / P6.09）：分级筛选条的显示规则、命中规则、
 * 单值状态（全局）的校验 / 计数 / hash 读写
 *
 * 跑法：node --test QTools-C/src/views/media/contentRating.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RATING_ALL,
  countByRating,
  matchesFilterValue,
  matchesRating,
  normalizeRating,
  ratingLabel,
  ratingOf,
  readRatingHash,
  showRatingFilter,
  writeRatingHash
} from './contentRating.js'

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

/* ------------------------------------------------------------------ P6.09 单值 + 全局状态 */

test('normalizeRating：合法值保留，非法 / 空 / all → all', () => {
  assert.equal(normalizeRating('general', OPTIONS3), 'general')
  assert.equal(normalizeRating(' GUIDANCE ', OPTIONS3), 'guidance')
  assert.equal(normalizeRating('restricted', OPTIONS3), 'restricted')
  assert.equal(normalizeRating(RATING_ALL, OPTIONS3), 'all')
  assert.equal(normalizeRating('', OPTIONS3), 'all')
  assert.equal(normalizeRating(null, OPTIONS3), 'all')
  assert.equal(normalizeRating('nope', OPTIONS3), 'all')
})

test('normalizeRating：该档对当前访客不可见 → 回落 all（不显示空页）', () => {
  const visible = [OPTIONS3[0], OPTIONS3[1]] // 未登录：限制级被设为不可见
  assert.equal(normalizeRating('restricted', visible), 'all')
  assert.equal(normalizeRating('guidance', visible), 'guidance')
  // 可见列表还没到（空数组）：任何档位都不生效，先按全部显示
  assert.equal(normalizeRating('guidance', []), 'all')
  assert.equal(normalizeRating('guidance', null), 'all')
})

test('matchesFilterValue：all / 空 = 不筛；否则单值命中', () => {
  assert.equal(matchesFilterValue({ contentRating: 'restricted' }, RATING_ALL), true)
  assert.equal(matchesFilterValue({ contentRating: 'restricted' }, ''), true)
  assert.equal(matchesFilterValue({ contentRating: 'restricted' }, 'restricted'), true)
  assert.equal(matchesFilterValue({ contentRating: 'guidance' }, 'restricted'), false)
  // 老数据没有 contentRating = 大众级
  assert.equal(matchesFilterValue({}, 'general'), true)
  assert.equal(matchesFilterValue({}, 'guidance'), false)
})

test('countByRating：按条目自己的分级计数，缺键算大众级', () => {
  const items = [
    { contentRating: 'general' },
    { contentRating: 'general' },
    { contentRating: 'restricted' },
    {},
    { contentRating: 'GUIDANCE' }
  ]
  assert.deepEqual(countByRating(items), { general: 3, restricted: 1, guidance: 1 })
  assert.deepEqual(countByRating(null), {})
  assert.deepEqual(countByRating([]), {})
})

test('readRatingHash：读 #rating=xxx，认老版本多值写法', () => {
  assert.equal(readRatingHash('#rating=restricted'), 'restricted')
  assert.equal(readRatingHash('#q=x&rating=guidance&dur=s'), 'guidance')
  assert.equal(readRatingHash('rating=guidance'), 'guidance')
  // 老 hash：#rating=general,guidance → 取第一个
  assert.equal(readRatingHash('#rating=general,guidance'), 'general')
  // 只有 all / 空 → 空串（= 没筛）
  assert.equal(readRatingHash('#rating=all'), '')
  assert.equal(readRatingHash('#q=x'), '')
  assert.equal(readRatingHash(''), '')
  assert.equal(readRatingHash(null), '')
})

test('writeRatingHash：写进去、all 时删掉，其余段一字不动', () => {
  assert.equal(writeRatingHash('', 'guidance'), '#rating=guidance')
  assert.equal(writeRatingHash('#q=x&dur=s', 'restricted'), '#q=x&dur=s&rating=restricted')
  // 覆盖已有值：不会出现两段 rating
  assert.equal(writeRatingHash('#rating=general&q=x', 'guidance'), '#rating=guidance&q=x')
  // 全部 = 清除该段（其它段保留；没有其它段时 hash 整个空掉）
  assert.equal(writeRatingHash('#rating=general&q=x', RATING_ALL), '#q=x')
  assert.equal(writeRatingHash('#rating=general', RATING_ALL), '')
  assert.equal(writeRatingHash('', RATING_ALL), '')
})

test('hash 往返：写进去再读回来是同一个值；清除后读回空', () => {
  const h = writeRatingHash('#q=abc', 'restricted')
  assert.equal(readRatingHash(h), 'restricted')
  assert.equal(readRatingHash(writeRatingHash(h, RATING_ALL)), '')
})
