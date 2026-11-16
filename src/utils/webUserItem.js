import request from '@/utils/request'
import { ownerHeaders } from '@/utils/webOwner'

/** 收藏 / 看过 的 id 列表 */
export function fetchUserFlags() {
  return request({ url: '/tool/web/user-flags', method: 'get', silent: true, headers: ownerHeaders() })
}

/** 切换收藏 */
export function toggleFav(postId, on) {
  return request({ url: '/tool/web/fav', method: 'post', silent: true, headers: ownerHeaders(), params: { postId, on: on ? 1 : 0 } })
}

/** 我的收藏 / 浏览记录（kind: fav | seen） */
export function fetchUserItems(kind, page = 1, size = 24) {
  return request({ url: '/tool/web/user-items', method: 'get', silent: true, headers: ownerHeaders(), params: { kind, page, size } })
}

/** 标记看过 */
export function markSeen(postId) {
  return request({ url: '/tool/web/seen', method: 'post', silent: true, headers: ownerHeaders(), params: { postId } })
}
