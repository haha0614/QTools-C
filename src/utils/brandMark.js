/**
 * P5.33 品牌图形：Lucide `rabbit`（ISC，v3/icons/lucide/rabbit.svg 原件，路径未改一字）的唯一数据源。
 *
 * 为什么单独抽成模块：正式资产（src/assets/brand/final/*.svg 由 devtools/p533-brand/build.mjs 生成）
 * 与站内组件（components/BrandMark.vue 内联 currentColor）必须是同一份路径 —— 否则「文件里的图标」
 * 和「页面里的图标」会各改各的，慢慢长成两个 logo。
 *
 * 尺寸规则（v3 REPORT 实测）：16px 只放图标；22px 图标 +「青兔」；≥32px 图标 +「青兔工具箱」。
 */
export const ICON_24 = {
  viewBox: '0 0 24 24',
  strokeWidth: 2,
  // 原样取自 Lucide v3 icons/rabbit.svg（顺序、数值均未改）
  paths: [
    'M13 16a3 3 0 0 1 2.24 5',
    'M18 12h.01',
    'M18 21h-8a4 4 0 0 1-4-4 7 7 0 0 1 7-7h.2L9.6 6.4a1 1 0 1 1 2.8-2.8L15.8 7h.2c3.3 0 6 2.7 6 6v1a2 2 0 0 1-2 2h-1a3 3 0 0 0-3 3',
    'M20 8.54V4a2 2 0 1 0-4 0v3',
    'M7.612 12.524a3 3 0 1 0-1.6 4.3',
  ],
}

export const BRAND = {
  name: '青兔工具箱',
  short: '青兔',
  iconAlt: '青兔工具箱',
}
