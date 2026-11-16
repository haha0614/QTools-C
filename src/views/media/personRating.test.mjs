/**
 * personRating.js 单测（P6.09）：人物 → 分级维度的两种数据源与放行规则
 *
 * 跑法：node --test QTools-C/src/views/media/personRating.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPersonRatings,
  countPersonsByRating,
  matchesPersonRating,
  personRatingBucket,
  personRatingCount
} from './personRating.js'

/**
 * 后端 P6.99 的形态：people[].byRating 只含 > 0 的档位，每档是
 * {@code {videos, albums, photos}}（人物页分页 total 的同一份来源）
 */
const INDEX_BACKEND = {
  ratings: [
    { value: 'general', label: '大众级', count: 3 },
    { value: 'guidance', label: '家长指导级', count: 1 }
  ],
  people: [
    { name: '念念', count: 2, videos: 1, byRating: { general: { albums: 2, videos: 0, photos: 58 }, guidance: { albums: 1, videos: 0, photos: 30 } } },
    { name: '小林', count: 1, videos: 0, byRating: { general: { albums: 1, videos: 0, photos: 5 } } }
  ],
  albums: [{ id: 'a1', person: '念念', contentRating: 'general' }],
  videos: [{ id: 'v1', persons: [{ id: 1, name: '念念' }], contentRating: 'guidance' }]
}

/** 老索引：没有 byRating，只剩 albums / videos 可推 */
const INDEX_LEGACY = {
  people: [{ name: '念念', count: 1 }, { name: '小林', count: 1 }],
  albums: [
    { id: 'a1', person: '念念', contentRating: 'general' },
    { id: 'a2', persons: ['小林'], contentRating: 'restricted' }
  ],
  videos: [{ id: 'v1', persons: [{ id: 1, name: '念念' }], contentRating: 'guidance' }]
}

test('buildPersonRatings：后端 byRating 优先（口径直接采用，不再二次推导）', () => {
  const map = buildPersonRatings(INDEX_BACKEND)
  assert.deepEqual({ ...map.get('念念') }, {
    general: { videos: 0, albums: 2, photos: 58 },
    guidance: { videos: 0, albums: 1, photos: 30 }
  })
  assert.deepEqual({ ...map.get('小林') }, { general: { videos: 0, albums: 1, photos: 5 } })
  // 相册 / 视频里那一份**不参与**（否则念念会变成 general 3 / guidance 2）
  assert.equal(personRatingCount(map, '念念', 'general'), 2)
  assert.equal(personRatingCount(map, '念念', 'guidance'), 1)
  assert.equal(personRatingCount(map, '念念', 'restricted'), 0)
})

test('personRatingBucket：卡片上要显示的三个数与人物页分页 total 同源', () => {
  const map = buildPersonRatings(INDEX_BACKEND)
  assert.deepEqual(personRatingBucket(map, '念念', 'general'), { videos: 0, albums: 2, photos: 58 })
  assert.deepEqual(personRatingBucket(map, '小林', 'general'), { videos: 0, albums: 1, photos: 5 })
  // 该档下没有作品 → null（调用方据此显示 0，而不是拿完整口径硬凑）
  assert.equal(personRatingBucket(map, '念念', 'restricted'), null)
  assert.equal(personRatingBucket(map, '不存在的人', 'general'), null)
})

test('buildPersonRatings：旧后端只给数字也认（按「册」折算，只用于有没有作品的判定）', () => {
  const legacyNumeric = { people: [{ name: '念念', byRating: { general: 2 } }] }
  const map = buildPersonRatings(legacyNumeric)
  assert.equal(personRatingCount(map, '念念', 'general'), 2)
  assert.deepEqual(personRatingBucket(map, '念念', 'general'), { videos: 0, albums: 2, photos: 0 })
})

test('buildPersonRatings：老索引没有 byRating → 从可见相册 / 视频反推', () => {
  const map = buildPersonRatings(INDEX_LEGACY)
  assert.equal(personRatingCount(map, '念念', 'general'), 1)
  assert.equal(personRatingCount(map, '念念', 'guidance'), 1)
  assert.equal(personRatingCount(map, '念念', 'restricted'), 0)
  assert.equal(personRatingCount(map, '小林', 'restricted'), 1)
  assert.equal(personRatingCount(map, '小林', 'general'), 0)
})

test('buildPersonRatings：空 / 坏输入不抛，返回空表', () => {
  assert.equal(buildPersonRatings(null).size, 0)
  assert.equal(buildPersonRatings({}).size, 0)
  assert.equal(buildPersonRatings({ people: [{}, null] }).size, 0)
})

test('matchesPersonRating：all 恒真；该档下没作品 → false', () => {
  const map = buildPersonRatings(INDEX_BACKEND)
  assert.equal(matchesPersonRating(map, '念念', 'all'), true)
  assert.equal(matchesPersonRating(map, '念念', ''), true)
  assert.equal(matchesPersonRating(map, '念念', 'general'), true)
  assert.equal(matchesPersonRating(map, '念念', 'restricted'), false)
  assert.equal(matchesPersonRating(map, '小林', 'guidance'), false)
  assert.equal(matchesPersonRating(map, '不存在的人', 'general'), false)
})

test('matchesPersonRating：缺数据一律放行（先显示全部，不是先显示空白）', () => {
  const empty = new Map()
  assert.equal(matchesPersonRating(empty, '念念', 'restricted'), true)
  assert.equal(matchesPersonRating(null, '念念', 'restricted'), true)
  // 没有名字 = 关联不上索引，也放行
  assert.equal(matchesPersonRating(buildPersonRatings(INDEX_BACKEND), '', 'restricted'), true)
})

test('countPersonsByRating：计的是「该档下有作品的人物数」，不是作品数', () => {
  const map = buildPersonRatings(INDEX_BACKEND)
  const people = [{ name: '念念' }, { name: '小林' }, { name: '' }]
  assert.deepEqual(countPersonsByRating(people, map, ['general', 'guidance', 'restricted']), {
    general: 2,
    guidance: 1,
    restricted: 0
  })
  // 空入参不炸，档位键仍然齐全（chip 上显示 0 而不是 undefined）
  assert.deepEqual(countPersonsByRating(null, null, ['general']), { general: 0 })
})
