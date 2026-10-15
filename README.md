# QTools 前台用户站（QTools-C）

> 打开即用、**全部计算在浏览器本地完成**的在线工具集合前台站。

## 简介

QTools 前台用户站是「青兔在线工具箱」面向普通用户的访问站点，与后台管理端（QTools-M）分离部署。

- **纯前端运算**：JSON 格式化、文本字数统计、随机密码生成的全部计算都在浏览器内完成。
- **数据不上传服务器**：你粘贴的 JSON / 文本、生成的密码**不会发往任何服务端**，只在当前页面的内存中处理；页面只向后端做两件事——拉取首页的工具卡片列表，以及上报一次「某工具被访问过」的计数（仅上报工具 id，不含任何输入内容）。
- **明暗主题**：跟随系统 `prefers-color-scheme`，也可手动切换并记住选择。
- **打开即用、无需注册**：站点内没有任何登录、账号或上传入口。

## 相关仓库

| 仓库 | 地址 | 说明 |
| --- | --- | --- |
| 后端 QTools | https://github.com/haha0614/QTools | Spring Boot 3.5.16 + 若依 3.9.2，默认端口 `8080`，提供工具列表与访问上报接口 |
| 前台用户站 QTools-C | https://github.com/haha0614/QTools-C | **本项目**：Vue 3 + Vite，用户访问的工具站 |
| 管理后台 QTools-M | https://github.com/haha0614/QTools-M | 若依 Vue3 前端，默认端口 `80`，提供系统管理/监控等后台功能（工具列表与埋点数据暂无对应页面） |

## 功能一览

| 路由 | 页面 | 功能 | 亮点 |
| --- | --- | --- | --- |
| `/` | `src/views/Home.vue` | 工具箱导航首页 | 动态拉取后端工具列表渲染卡片；PC 4 列 / 中等屏 3 列 / 平板 2 列 / 手机 1 列自适应；接口失败时显示「工具加载失败」并回退渲染内置 3 条兜底数据，首页始终可用 |
| `/tool/json` | `src/views/tool/JsonFormat.vue` | JSON 格式化 / 压缩 / 校验 / 清空 / 复制 | 解析错误在输入框下方以红色文字提示（不弹窗、不清空输入） |
| `/tool/text-count` | `src/views/tool/TextCount.vue` | 实时统计总字符数（含空格）/ 纯文字字符数（剔除空白）/ 汉字数 / 英文单词数 / 总行数 | 输入即算；支持清空、复制、一键去除所有空格与换行 |
| `/tool/pwd-gen` | `src/views/tool/PwdGen.vue` | 随机密码生成 | 长度 4~64（默认 16）、大写 / 小写 / 数字 / 符号四类字符开关；使用 `crypto.getRandomValues` + 拒绝采样消除取模偏差 |

## 技术栈

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Vue | ^3.4.0（实测 3.5.44） | 视图框架，全部使用 `<script setup>` + 中文注释 |
| Vue Router | ^4.3.0（实测 4.6.4） | 4 条懒加载路由 + 切换回顶 |
| Vite | ^5.4.0（实测 5.4.21） | 开发服务器与构建 |
| Element Plus | ^2.7.0（实测 2.14.7） | UI 组件库 |
| @element-plus/icons-vue | ^2.3.1（实测 2.3.2） | 图标，`main.js` 中全量注册，首页按名字动态取组件 |
| axios | ^1.7.0（实测 1.20.0） | HTTP 请求（统一封装在 `src/utils/request.js`） |
| sass | ^1.77.0（实测 1.105.1） | 样式预处理 |

> 上表括号内的实测版本来自本地 `node_modules`；`package.json` 中使用的是 caret 范围。

## 目录结构

```
QTools-C/
├── index.html                       # HTML 入口（lang=zh-CN，挂载 #app；静态 <title> 仅作首屏兜底）
├── package.json                     # 依赖与脚本（dev / build / preview）
├── package-lock.json                # npm 依赖锁定（随仓库提交）
├── vite.config.js                   # Vite 配置：@ 别名、端口 5173、/api 代理、sass api: 'modern'
├── .env.development                 # 开发环境变量
└── src/
    ├── main.js                      # 应用入口：Element Plus、图标全量注册、样式、initTheme()、document.title
    ├── App.vue                      # 根组件
    ├── api/
    │   └── tool.js                  # getToolList / addToolVisit / reportToolVisit（含按路由埋点与兜底）
    ├── components/                  # AppHeader / AppFooter / ToolHeader / ThemeToggle / AboutDialog
    ├── composables/
    │   └── useTheme.js              # 主题单例（useTheme / initTheme）
    ├── router/
    │   └── index.js                 # 4 条懒加载路由 + scrollBehavior 回顶
    ├── styles/
    │   ├── index.scss               # 全局样式：reset、.qt-container 等
    │   └── variables.scss           # 主题 CSS 变量（:root 亮色 / html.dark 暗色）
    ├── utils/
    │   ├── request.js               # axios 实例与统一拦截（baseURL、code 校验、silent 静默开关）
    │   └── constants.js             # APP_INFO / APP_INTRO / FALLBACK_TOOL_IDS
    └── views/
        ├── Home.vue                 # 首页工具卡片网格
        └── tool/
            ├── JsonFormat.vue
            ├── TextCount.vue
            └── PwdGen.vue
```

## 快速开始

**前置条件**

- Node.js 18+（本地实测环境为 Node 24.21.0 / npm 11.19.0）。
- 后端 QTools **可选**：不启动也能正常使用全部工具，只影响首页卡片数据与访问埋点（见下方「常见问题」）。

```bash
npm install       # 安装依赖
npm run dev       # 启动开发服务器：http://localhost:5173
npm run build     # 生产构建，产物在 dist/
npm run preview   # 本地预览构建产物（Vite 默认 http://localhost:4173）
```

**如何验证跑起来了**

1. `npm run dev` 后打开 `http://localhost:5173/`，应看到工具卡片；点击卡片能进入对应工具页。
2. 直接访问 `/tool/json`、`/tool/text-count`、`/tool/pwd-gen` 都能正常打开（前端路由，无需后端）。
3. 断开后端再次刷新首页：卡片区显示「工具加载失败」提示，但下方仍渲染 3 条兜底卡片，工具页照常可用。
4. （可选）启动后端后刷新首页，卡片数据来自 `GET /api/toolInfo/list`；打开任意工具页会在后端 `tool_visit` 表写入一条记录。

## 配置说明

| 项目 | 位置 | 说明 |
| --- | --- | --- |
| 开发端口 | `vite.config.js` 的 `server.port` | `5173`；未配置 `strictPort`，端口被占用时 Vite 会自动切换到下一个可用端口 |
| `VITE_API_BASE_URL` | `.env.development`，由 `src/utils/request.js` 读取 | 默认 `/api`，即 axios 实例的 `baseURL`（缺省值也是 `/api`） |
| `VITE_PROXY_TARGET` | `.env.development`，由 `vite.config.js` 读取 | 默认 `http://localhost:8080`，开发服务器把 `/api` 代理到该地址 |
| 代理规则 | `vite.config.js` 的 `server.proxy['/api']` | **不做 rewrite**：后端接口本身即 `/api/...` |
| 主题存储键 | `src/composables/useTheme.js` 的 `STORAGE_KEY` | `qtools-theme`，取值 `dark` / `light` |
| 站点名称 / 副标题 / 版权 | `src/utils/constants.js` 的 `APP_INFO` | 全站唯一来源；改站点名只需改 `APP_INFO.name`，浏览器标签页标题、页头 Logo、页脚版权、关于弹窗、首页路由标题都会同步 |
| 项目简介文案 | `src/utils/constants.js` 的 `APP_INTRO` | 由 `APP_INFO.name` 拼出，改名字自动同步 |

> `index.html` 里的静态 `<title>` 只用于首屏兜底：应用启动后由 `src/main.js` 用 `APP_INFO.name` 覆盖。

主题相关约定：

- 暗色通过 `<html class="dark">` 这一个信号表达，配合 `element-plus/theme-chalk/dark/css-vars.css`（Element Plus 官方方案）。
- localStorage 无有效值时跟随系统 `prefers-color-scheme`，并在系统主题变化时实时同步；用户手动切换后写入 `qtools-theme`。
- 页面样式统一使用 `src/styles/variables.scss` 里的 9 个变量（`--qt-bg-page`、`--qt-bg-card`、`--qt-bg-hover`、`--qt-text-primary`、`--qt-text-secondary`、`--qt-border`、`--qt-primary`、`--qt-shadow`、`--qt-danger`），不要硬编码颜色。

```js
import { useTheme, initTheme } from '@/composables/useTheme'

initTheme()                                        // 仅需在 main.js 挂载前调用一次
const { isDark, toggleTheme, setTheme } = useTheme() // 模块级单例，所有组件同步
```

## 与后端的接口约定

前端只调用后端**两个**接口，都封装在 `src/api/tool.js`；请求经 `src/utils/request.js` 的 axios 实例发出，`baseURL = import.meta.env.VITE_API_BASE_URL || '/api'`。

**1）查询工具列表（首页卡片）**

```
GET /api/toolInfo/list
```

后端返回的是若依 `AjaxResult` 包装体，工具数组在 `data` 字段中：

```json
{
  "code": 200,
  "msg": "操作成功",
  "data": [
    {
      "id": 1,
      "tool_name": "JSON格式化",
      "tool_desc": "在线格式化、压缩与校验 JSON",
      "tool_route": "/tool/json",
      "icon": "Document",
      "sort": 1
    }
  ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | number | 工具主键，访问上报时使用 |
| `tool_name` | string | 卡片标题 |
| `tool_desc` | string | 卡片描述 |
| `tool_route` | string | 前端路由（如 `/tool/json`），是前端匹配工具的唯一键 |
| `icon` | string | 图标名，对应 `@element-plus/icons-vue` 的组件名 |
| `sort` | number | 排序值，越小越靠前 |

首页解包时**同时兼容**「`{ code, msg, data: [...] }` 包装体」与「后端直接返回裸数组」两种形态，并按 `sort` 升序排列；两者都不匹配则按失败处理。

**2）上报一次工具访问**

```
POST /api/toolVisit/add
Content-Type: application/json

{ "toolId": 1 }
```

三个工具页在 `onMounted` 时调用 `reportToolVisit(route.path)`，其内部流程为：

1. 先 `GET /api/toolInfo/list`，按 `tool_route` 反查真实 `id`；
2. 反查失败、未匹配或返回体形态不符时，回退到本地兜底表 `FALLBACK_TOOL_IDS`（`/tool/json` → `1`、`/tool/text-count` → `2`、`/tool/pwd-gen` → `3`）；
3. 兜底表也没命中则直接返回，不发请求；
4. 再以 `POST /api/toolVisit/add` 上报 `{ toolId }`。

**全程静默**：两次请求都以 `silent: true` 发起，失败只 `console.warn`，不弹任何错误提示、不抛异常、不阻断页面渲染。只有首页的列表请求是**非静默**的，失败时会显示错误提示并回退兜底数据。

`request.js` 的统一约定：响应体存在 `code` 字段且 `code !== 200` 时视为业务失败——非静默请求弹出 `msg` 并 `reject`，静默请求只 `reject` 不提示；axios 网络类错误（超时 10s、断网、5xx）同样按 `silent` 决定是否提示。

## 常见问题

- **后端没启动会怎样？** 首页列表请求失败，显示「工具加载失败」提示并渲染内置的 3 条兜底卡片；三个工具页完全不受影响（计算全在前端），只有访问埋点会静默失败、在控制台留下一条 `console.warn`。
- **控制台出现 Dart Sass 的 `legacy-js-api is deprecated` 告警？** 本工程已在 `vite.config.js` 中设置 `css.preprocessorOptions.scss.api = 'modern'` 消除该告警（项目只装了 `sass`，未装 `sass-embedded`，因此用 `'modern'` 而非 `'modern-compiler'`）。升级到 Vite 6/7 后新版默认使用现代化 API，届时可移除该选项。
- **`npm install` 提示依赖的安装脚本未执行（`install-scripts`）？** npm 11.19+ 默认不执行依赖的安装脚本，会打印 warning，但退出码仍为 0，开发与构建都不受影响。确需放行时可执行 `npm install-scripts approve esbuild`；`@parcel/watcher` 的安装脚本会走 node-gyp 编译，缺少 C++ 构建工具时反而会失败，一般不必放行。
- **5173 端口被占用？** 配置里没有 `strictPort`，Vite 会自动改用下一个可用端口，请以终端打印的地址为准。
- **页面能打开但卡片是兜底数据？** 说明 `/api/toolInfo/list` 没通。开发环境下确认后端已启动在 `8080`，或检查 `.env.development` 的 `VITE_PROXY_TARGET` 是否指向正确的后端地址。

## 已验证

- `npm run build` 通过，`dist/` 产出 15 个文件。
- `npm run dev` 后 `/`、`/tool/json`、`/src/main.js` 以及四个页面 SFC 均返回 200。
- 经 Vite 代理访问 `/api/toolInfo/list` 返回 `code=200` 与 3 条工具数据。
- 打开工具页后，后端 `tool_visit` 表写入访问记录。

## 许可与致谢

- **许可**：本项目以 **MIT License** 分发，见仓库根目录 `LICENSE`（Copyright © 2026 haha0614）。
- **致谢**：感谢 [Vue](https://github.com/vuejs/core)、[Vite](https://github.com/vitejs/vite)、[Element Plus](https://github.com/element-plus/element-plus) 与[若依 RuoYi](https://github.com/yangzongzhuan/RuoYi-Vue) 提供的框架与组件生态。
