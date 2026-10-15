/**
 * api/tool.js —— 工具信息与访问上报接口
 * 用途：封装工具列表查询、访问量上报，以及对页面完全透明的“按路由上报”兜底逻辑。
 * 约定：所有函数支持 silent 开关（默认 false）；开启后请求失败不弹任何提示，仅 console.warn。
 */
import request from '@/utils/request'
import { FALLBACK_TOOL_IDS } from '@/utils/constants'

/**
 * 查询全部工具
 * 后端：GET /api/toolInfo/list
 * 返回：工具数组，元素字段 { id, tool_name, tool_desc, tool_route, icon, sort }
 * @param {boolean} [silent=false] 为 true 时请求失败不弹提示
 */
export function getToolList(silent = false) {
  return request({
    url: '/toolInfo/list',
    method: 'get',
    silent
  })
}

/**
 * 新增一次工具访问记录
 * 后端：POST /api/toolVisit/add  body: { toolId }
 * @param {number|string} toolId 后端工具表主键
 * @param {boolean} [silent=false] 为 true 时请求失败不弹提示
 */
export function addToolVisit(toolId, silent = false) {
  return request({
    url: '/toolVisit/add',
    method: 'post',
    data: { toolId },
    silent
  })
}

/**
 * 按前端路由上报一次访问
 * 逻辑：先取工具列表，用 tool_route 匹配 id；匹配不到或接口失败时用 FALLBACK_TOOL_IDS 兜底。
 * 约定：整个过程不抛出异常、不弹错误提示、不阻断页面渲染 —— 两次请求均以 silent 方式发起。
 * @param {string} toolRoute 例如 '/tool/json'
 */
export async function reportToolVisit(toolRoute) {
  try {
    // 先按兜底表给出候选 id
    let toolId = FALLBACK_TOOL_IDS[toolRoute]

    // 尝试用真实接口数据覆盖兜底 id（静默请求，失败不弹提示）
    try {
      const raw = await getToolList(true)
      const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.data) ? raw.data : []
      const matched = list.find((item) => item && item.tool_route === toolRoute)
      if (matched && matched.id !== undefined && matched.id !== null) {
        toolId = matched.id
      }
    } catch (err) {
      // 列表接口失败：保留兜底 id，仅记录告警
      console.warn('[qtools] 获取工具列表失败，使用兜底 id：', err)
    }

    // 兜底表也未命中时静默退出
    if (toolId === undefined || toolId === null) return

    // 上报同样静默：失败只记录告警，不影响页面
    await addToolVisit(toolId, true)
  } catch (err) {
    // 任何意外都不向上抛，只打印告警
    console.warn('[qtools] 工具访问上报失败：', err)
  }
}