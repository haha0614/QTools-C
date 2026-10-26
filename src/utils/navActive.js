/**
 * navActive.js —— 侧栏选中态的唯一判定（P4.3）
 *
 * 为什么单独成文件：AppShell.vue 里的 isActive 是一段纯计算，写在 SFC 的 <script setup> 里
 * 没法直接单测。抽出来后「/media、/media/photos、/media/persons、/media/person/:id、/tools、/」
 * 六条路径的高亮对照表可以用 node 直跑断言（见 p43-evidence/test-nav-active.mjs）。
 *
 * 规则（P4.3 修掉「/media 吞掉 /media/photos」的旧问题）：
 *   - item.action    **动作项**，永远不高亮（P5.46：侧栏「播放列表」不再是页面，而是
 *                   「跳到视频库并打开播放列表筛选」的动作；它 to 指向 /media，
 *                   若参与匹配就会和「视频库」双亮）；
 *   - '/'(首页)      只认路径恰为 '/'；
 *   - item.exact    只认路径恰为 item.to（视频库 /media 用它，否则 /media/photos 会同时点亮它）；
 *   - item.also     额外认这些前缀的子路径（人物 /media/persons 追加 /media/person，
 *                   于是 /media/person/111 由「人物」高亮，而不是「视频库」）；
 *   - 其余默认「自身或子路径」匹配（/tools、/media/photos、/media/persons …）。
 * 全部判据都是「等于」或「前缀 + '/'」，因此 /media/person 不会误吞 /media/persons。
 */

/** 路径归一化：去掉查询串 / hash / 结尾多余斜杠（/media/ → /media），根路径保持 '/' */
export function normalizeNavPath(path) {
  const raw = path == null ? '' : String(path)
  const cut = raw.split('#')[0].split('?')[0]
  const trimmed = cut.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * 单个侧栏项在当前路径下是否高亮。
 * @param {{to:string, exact?:boolean, also?:string[], action?:string}} item 侧栏项（to 必填）
 * @param {string} path 当前路径（通常传 route.path）
 */
export function isNavActive(item, path) {
  if (!item) return false
  // 动作项（item.action）不是「位置」，没有自己的路径：任何路径下都不高亮
  if (item.action) return false
  const cur = normalizeNavPath(path)
  const to = normalizeNavPath(item.to)
  if (!to) return false
  if (to === '/') return cur === '/'
  if (item.exact) return cur === to
  const bases = [to]
  if (Array.isArray(item.also)) {
    for (const extra of item.also) {
      const base = normalizeNavPath(extra)
      if (base && base !== '/') bases.push(base)
    }
  }
  for (const base of bases) {
    if (cur === base || cur.startsWith(base + '/')) return true
  }
  return false
}

/**
 * 当前路径下全部高亮的侧栏项（按传入顺序）。AppShell 的渲染只用 isNavActive；
 * 这个聚合函数是给「对照表」类自查/单测用的，避免测试自己拼一遍判定逻辑。
 */
export function activeNavTos(items, path) {
  return (Array.isArray(items) ? items : []).filter((it) => isNavActive(it, path)).map((it) => it.to)
}
