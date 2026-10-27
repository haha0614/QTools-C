/**
 * serviceCatalog.js —— 「离线工具 / 在线服务」的唯一判定来源
 *
 * 判定口径（前端白名单，按路由）：
 *   - 路由命中 OFFLINE_TOOL_ROUTES → 离线工具：纯浏览器运算，后端挂掉也能用，可以承诺「数据不上传」；
 *   - 其余（含 /media 媒体站）→ 在线服务：需要后端在线才能用（列表里单独成区，不逐卡标注）；
 *   - 未登记的新工具一律按在线处理 —— 对未知工具不能做「数据不上传」的承诺。
 *
 * 为什么是前端白名单而不是后端 tool_info 加列：
 *   查过库表结构（QTools/sql/qtools/tool_init.sql）与接口实返（GET /api/toolInfo/list）：
 *   tool_info 只有 id / tool_name / tool_desc / tool_route / icon / sort / status / create_time / update_time，
 *   没有 offline 之类的字段。加列要么改后端实体 + 建表脚本 + 后台管理页，要么塞进 remark 之类的自由字段，
 *   两者都比「前端一张 3 行的路由白名单」代价高。本阶段只改前端，故取白名单；
 *   代价：新增离线工具时要在本文件补一行（+ 首页/全部工具页的兜底数据里补 offline 标记）；
 *   收益：后端零改动、判定是纯函数、能被单测覆盖，后续后端真加了字段只需要改本文件一个函数。
 */

/** 纯前端运算的工具路由（离线工具白名单） */
export const OFFLINE_TOOL_ROUTES = Object.freeze(['/tool/json', '/tool/text-count', '/tool/pwd-gen'])

/** 兜底：后端下发的路由带尾斜杠 / 查询串时也能命中 */
export function normalizeRoute(route) {
  if (typeof route !== 'string') return ''
  const path = route.split('#')[0].split('?')[0].replace(/\/+$/, '')
  return path === '' ? '/' : path
}

/** 路由是否属于离线工具 */
export function isOfflineRoute(route) {
  const path = normalizeRoute(route)
  return !!path && OFFLINE_TOOL_ROUTES.includes(path)
}

/**
 * 工具条目分类
 * @param {{route?:string, toolRoute?:string}} tool 归一化后的工具（route）或接口原始条目（toolRoute）
 * @returns {'offline'|'online'}
 */
export function classifyTool(tool) {
  if (!tool || typeof tool !== 'object') return 'online'
  return isOfflineRoute(tool.route || tool.toolRoute) ? 'offline' : 'online'
}

/** 工具是否离线可用的布尔快捷方式（数据模型里的 offline 字段就取这个值） */
export function isOfflineTool(tool) {
  return classifyTool(tool) === 'offline'
}

/**
 * 工具列表的两个固定分区（首页与全部工具页共用同一套文案与顺序）
 *   offline 在前 —— 纯浏览器运算，后端挂了也能用，可以承诺数据不上传；
 *   online  在后 —— 需要后端在线，掉线时卡片禁用。
 * 不再提供「全部 / 离线 / 在线」三档筛选：分区本身就是筛选结果，离线永远先出现。
 */
export const TOOL_SECTIONS = Object.freeze([
  {
    key: 'offline',
    title: '🟢 离线工具 · 数据不上传',
    subtitle: '纯浏览器运算，后端不可用时也能用'
  },
  {
    key: 'online',
    title: '在线服务',
    subtitle: '需要后端在线才能使用'
  }
])

/**
 * 把一批工具按 offline 拆成两个分区，顺序固定（离线在前），空区直接丢掉（调用方据此不渲染该区）。
 * @param {Array<{offline?:boolean}>} tools 已按分类 / 关键词过滤过的工具
 * @returns {Array<{key:string,title:string,subtitle:string,tools:Array}>}
 */
export function splitToolsBySection(tools) {
  const list = Array.isArray(tools) ? tools : []
  return TOOL_SECTIONS.map((section) => ({
    ...section,
    tools: list.filter((tool) =>
      section.key === 'offline' ? Boolean(tool && tool.offline) : !(tool && tool.offline)
    )
  })).filter((section) => section.tools.length > 0)
}

/**
 * 卡片徽标文案：
 *   离线工具 → 「离线 · 数据不上传」（用户要的价值承诺，保留）；
 *   在线工具 → 不再标「需后端」（分区标题已经说明），只有后端不可用时才给状态说明「暂不可用」。
 * @param {object} tool 工具条目
 * @param {boolean} locked 当前是否禁用（在线服务 + 后端 offline）
 * @returns {string} 空字符串表示不渲染徽标
 */
export function toolBadgeText(tool, locked) {
  if (isOfflineTool(tool)) return '离线 · 数据不上传'
  return locked ? '暂不可用' : ''
}
