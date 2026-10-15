/**
 * constants.js —— 全局常量
 * 用途：集中维护站点信息（应用名称等）与后端工具表对应的路由兜底映射。
 */

/**
 * 站点信息（全站唯一来源）
 * 改站点名称只需改 APP_INFO.name：浏览器标签页、页头 Logo、页脚版权、关于弹窗、路由标题
 * 全部从这里取值；index.html 的静态 <title> 会在应用启动时被覆盖（仅作首屏兜底）。
 */
export const APP_INFO = {
  /** 站点名称 */
  name: '青兔在线工具箱',
  /** 首页副标题 */
  slogan: '打开即用，无需注册',
  /** 页脚版权信息（跟在站点名之后） */
  copyright: '©2026 | 工具数据由后台管理维护'
}

/** 关于本站弹窗的项目简介（由 APP_INFO.name 拼出，改名字自动同步） */
export const APP_INTRO = `${APP_INFO.name}是一个纯前端运算的在线工具集合，打开即用、无需注册。`

// 当 /toolInfo/list 接口不可用或匹配不到工具时使用的兜底 id 映射
// key: 前端工具路由；value: 后端工具表 id
export const FALLBACK_TOOL_IDS = {
  '/tool/json': 1,
  '/tool/text-count': 2,
  '/tool/pwd-gen': 3
}