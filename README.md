# QTools 前台用户站（QTools-C）

> 「青兔工具箱」的用户访问站点：纯前端本地运算工具 + 手写媒体站静态页 + 用户端账号，一个 Vite 工程打成一个 `dist/`。

## 简介

QTools-C 是 QTools 项目里**面向普通用户**的前端站点，与若依管理后台（QTools-M，端口 `80`）完全分离，由后端（QTools，`8080` 单端口）或 nginx 直接托管构建产物。站点由三块组成：

1. **本地工具（Vue 页面）**——JSON 格式化、文本字数统计、随机密码生成。**全部计算都在浏览器内完成，输入内容不上传任何服务器**：你粘贴的 JSON / 文本、生成的密码只在当前页面内存中处理；工具页向后端只发一次「某工具被访问过」的计数上报（仅上报工具 id，不含任何输入内容）。
2. **媒体站（`public/media/` 手写静态页）**——视频库、图片相册、我的（收藏/最近播放）三个页面，纯 HTML + 原生 JS，不经 Vue Router 管理，整页跳转访问；数据来自后端 `/api/media/**` 媒体接口。
3. **用户端账号（Vue 页面）**——注册（后端默认邀请码模式）、用户名密码登录、我的账号（含「认领本设备的匿名媒体数据」）。账号体系与若依后台**完全隔离**：独立 JWT（不同密钥 / issuer）、独立接口前缀 `/api/app/**`、独立 token 存储键 `app.token`。

其他特性：明暗主题跟随系统 `prefers-color-scheme` 并记住选择；全站中文；手机 / 平板 / 桌面 4 档响应式栅格。

## 相关仓库

| 仓库 | 地址 | 说明 |
| --- | --- | --- |
| 后端 QTools | https://github.com/haha0614/QTools | Spring Boot 3.5.x + 若依 3.9.x，默认端口 `8080`；同时提供工具列表/埋点接口、`/api/media/**` 媒体接口、`/api/app/**` 用户端账号接口，并托管本仓库的 `dist/` |
| 前台用户站 QTools-C | https://github.com/haha0614/QTools-C | **本项目**：Vue 3 + Vite，用户访问的工具站 + 媒体站静态页 |
| 管理后台 QTools-M | https://github.com/haha0614/QTools-M | 若依 Vue3 前端，默认端口 `80`，提供系统管理/监控等后台功能 |

## 功能与路由一览

### Vue 路由（共 7 条，全部懒加载，`src/router/index.js`）

| 路径 | 组件 | 标题（`meta.title`） | 说明 |
| --- | --- | --- | --- |
| `/` | `views/Home.vue` | `APP_INFO.name` | 首页：动态拉取后端工具列表渲染卡片（PC 4 列 / 中等屏 3 列 / 平板 2 列 / 手机 1 列）；「媒体站」入口已由 `tool_info` 下发（可在管理端「工具维护」上下架与排序），`tool_route` 为 `/media/index.html`，点击整页跳转；接口失败时显示「工具加载失败」并回退内置 4 条兜底卡片（含媒体站） |
| `/tool/json` | `views/tool/JsonFormat.vue` | JSON格式化工具 | 格式化（2 空格缩进）/ 压缩 / 校验 / 清空 / 复制；解析错误在输入框下方红色行内提示，不弹窗、不清空输入 |
| `/tool/text-count` | `views/tool/TextCount.vue` | 文本字数统计 | 输入即算五项：总字符数（含空格）/ 纯文字字符 / 汉字数量 / 英文单词数 / 总行数；另支持清空、复制、一键去除所有空格与换行 |
| `/tool/pwd-gen` | `views/tool/PwdGen.vue` | 随机密码生成器 | 长度 4~64（默认 16），大写/小写/数字/符号四类开关；用 `crypto.getRandomValues` + 拒绝采样消除取模偏差 |
| `/login` | `views/auth/Login.vue` | 登录 | 用户名 + 密码登录；成功跳回 `?redirect=` 指向的站内路径（缺省回首页）；401 凭证错误 / 429 频率限制给行内固定文案 |
| `/register` | `views/auth/Register.vue` | 注册 | 邀请码注册（用户名 / 昵称 / 密码 / 确认密码 / 邀请码），成功后自动登录并跳首页 |
| `/account` | `views/auth/Account.vue` | 我的账号 | `meta.requiresAuth: true`；展示昵称、用户名、注册时间、最近登录与已绑定身份，提供「认领本设备的媒体数据」与「退出登录」 |

守卫与标题：`router.beforeEach` 在首次导航时用 `useAppAuth()` 单例调一次 `fetchMe()` 恢复登录态（无 token 访问 `requiresAuth` 页 → `/login?redirect=<fullPath>`）；`router.afterEach` 用 `meta.title` 设置浏览器标题，缺省回退 `APP_INFO.name`。

未开放能力统一置灰并标注「未开放」，点击不发请求：邮箱/手机号登录、邮箱/手机号注册与验证码、绑定邮箱/手机号。

### 媒体站静态页（`public/media/`，10 个手写文件，非 Vue 组件）

| 页面 | HTML | 脚本 | 样式 | 说明 |
| --- | --- | --- | --- | --- |
| 视频库 | `index.html` | `app.js`（53 KB） | `app.css`（20 KB） | 卡片墙、筛选与时长/分辨率档位统计、断点续播 |
| 图片站 | `photos.html` | `photo.js`（67 KB） | `photo.css`（17 KB） | 相册分组、册内网格分批插入、缩放与预览 |
| 我的 | `me.html` | `me.js` | `app.css` | 只读渲染最近播放与收藏，数据与写操作都走共享组件 |
| 共享个人组件 | —— | `profile.js`（24 KB） | `profile.css`（10 KB） | 三个页面都引入（`<script defer>`）；右上入口 + 浮层/抽屉 + 编辑，是唯一访问 `/api/user` 的前端模块 |

- 媒体站不参与打包：`public/` 下的文件在构建时**原样复制**到 `dist/media/`，由后端（`8080` 单端口，`/media/` 路径）或 nginx 直接托管。
- 三个页面都通过 `/api/media/**`（`app.js` / `photo.js` / `profile.js` / `me.js` 各自顶部的 `API` / `MEDIA` 常量）调后端媒体接口；身份靠请求头 `X-Ms-Owner`（取 `localStorage['ms.owner']`），跨端口 Cookie 不可靠。
  P5.74 起 `profile.js` 的 `userHeaders()` 在存在 `localStorage['app.token']` 时还会带 `Authorization: Bearer …`，
  后端据此把该请求归到账号（`u:<appUserId>`）；没有 token 时就是原来的设备态，行为不变。
- 这三个页面同样不含任何 Vue 运行时依赖，属于「能独立打开就独立可用」的静态资产。

## 媒体站功能文档（在总仓 `docs/` 下）

以下五篇写的是**用户端可见**的媒体站能力，涉及前后端两侧，统一放在总仓 `docs/`：

| 文档 | 与本仓相关的部分 |
| --- | --- |
| `docs/本地AI-模型与转写.md` | 简介「自动生成 / 音频转写重生成」按钮背后的本机模型，503 时前端如何回退模板 |
| `docs/作品简介与内容梗概.md` | `VideoMetaPanel.vue` / `SynopsisBatchDialog.vue` 的素材来源提示、两步确认、停止与撤销 |
| `docs/人物-资料与头像.md` | 人物墙 `personWall.js`（四级头像回退、chip）、`PersonAvatarDialog.vue`（三种 ref + 裁剪） |
| `docs/播放列表与播放上下文.md` | `PlaylistFilter.vue` / `PlaylistManageDialog.vue` / `playbackContext.js` 的契约与来源优先级 |
| `docs/运维脚本与故障处理.md` | 站点起停与 502 排查（本仓 build 产物由 nginx / 后端单端口托管） |

改这几块前先读对应文档的「已知限制」；数字（耗时、请求数、对比度）都是实测值，改代码后请复跑文末的自检命令。

## 技术栈

| 依赖 | `package.json` 声明 | 本地实测 | 用途 |
| --- | --- | --- | --- |
| Vue | `^3.4.0` | 3.5.44 | 视图框架，全部 `<script setup>` |
| Vue Router | `^4.3.0` | 4.6.4 | 7 条懒加载路由 + `scrollBehavior` 回顶 |
| Vite | `^5.4.0` | 5.4.21 | 开发服务器与构建 |
| Element Plus | `^2.7.0` | 2.14.7 | UI 组件库（`main.js` 中全量注册） |
| @element-plus/icons-vue | `^2.3.1` | 2.3.2 | 图标，`main.js` 全量注册，首页按名字动态取组件 |
| axios | `^1.7.0` | 1.20.0 | HTTP 请求（工具/埋点走 `utils/request.js`，账号走 `api/appAuth.js` 自带实例） |
| sass | `^1.77.0` | 1.105.1 | 样式预处理（`scss.api = 'modern'`） |

> 实测版本取自本地 `node_modules`；`package.json` 用的是 caret 范围。**未安装** pinia / vuex —— 登录态与主题都用模块级 `reactive` 单例实现。

## 目录结构

```
QTools-C/
├── index.html                     # HTML 入口（lang=zh-CN；静态 <title> 仅首屏兜底；data: favicon）
├── package.json                   # 依赖与脚本 dev / build / preview
├── package-lock.json              # npm 锁定（随仓库提交）
├── vite.config.js                 # @ 别名、5173 端口、/api 代理、sass modern、构建期规避项
├── .env.development               # VITE_API_BASE_URL=/api、VITE_PROXY_TARGET=http://localhost:8080
├── LICENSE                        # MIT
├── public/
│   └── media/                     # 媒体站手写静态页（构建时原样进 dist/media/）
│       ├── index.html  app.js  app.css        # 视频库
│       ├── photos.html photo.js photo.css     # 图片站
│       ├── me.html     me.js                  # 我的（复用 app.css）
│       └── profile.js  profile.css            # 共享个人组件（三页共用）
└── src/
    ├── main.js                    # 入口：Element Plus + 图标全量注册、样式、initTheme()、document.title
    ├── App.vue                    # 根组件（<router-view />）
    ├── api/
    │   ├── appAuth.js             # 用户端账号接口（自建 axios 实例，/app/auth/**）
    │   └── tool.js                # getToolList / addToolVisit / reportToolVisit（含按路由埋点与兜底）
    ├── components/                # AppHeader（含账号区）/ AppFooter / ToolHeader / ThemeToggle / AboutDialog
    ├── composables/
    │   ├── useAppAuth.js          # 登录态 reactive 单例：token/user + doLogin/doRegister/fetchMe/doLogout/claimDevice
    │   └── useTheme.js            # 主题单例（useTheme / initTheme）
    ├── router/
    │   └── index.js               # 7 条懒加载路由 + 登录守卫 + 标题设置 + scrollBehavior
    ├── styles/                    # index.scss（reset、.qt-container）、variables.scss（--qt-* 主题变量）
    ├── utils/
    │   ├── request.js             # 工具/埋点用 axios 实例：baseURL、code!==200 失败、silent 静默开关
    │   └── constants.js           # APP_INFO / APP_INTRO / FALLBACK_TOOL_IDS
    └── views/
        ├── Home.vue               # 首页工具卡片网格（含本地静态「媒体站」卡片）
        ├── auth/
        │   ├── auth-card.scss     # 登录/注册/账号三页共用的卡片样式
        │   ├── Login.vue
        │   ├── Register.vue
        │   └── Account.vue
        └── tool/
            ├── JsonFormat.vue
            ├── TextCount.vue
            └── PwdGen.vue
```

## 快速开始

**前置条件**：Node.js 18+（本地实测 Node 24 / npm 11）。后端可选——不启动也能用全部工具页，只影响首页卡片数据、埋点上报、媒体站数据与账号功能。

```bash
npm install       # 安装依赖
npm run dev       # 开发服务器 http://localhost:5173
npm run build     # 生产构建，产物在 dist/
npm run preview   # 本地预览构建产物（Vite 默认 4173）
```

**如何逐页验证**

1. `http://localhost:5173/` —— 应看到工具卡片。卡片数据来自 `GET /api/toolInfo/list`（经 Vite 代理转发到后端）；后端未启动时卡片区显示「工具加载失败」，下方仍渲染 3 条兜底卡片 + 「媒体站」卡片。
2. `/tool/json`、`/tool/text-count`、`/tool/pwd-gen` —— 直接访问都能打开（前端路由，无需后端）。打开任一工具页会在后端 `tool_visit` 表写入一条访问记录。
3. `/media/index.html`、`/media/photos.html`、`/media/me.html` —— 媒体站三页，需要后端媒体接口有数据才有内容。
4. `/login`、`/register` —— 表单可渲染、可做前端校验；真正提交需要后端 `/api/app/auth/**` 可用。
5. 未登录直接访问 `/account` —— 应被重定向到 `/login?redirect=/account`；登录成功后再回到 `/account`。

**生产构建方式**

- 统一由**后端仓库**的 `QTools\bin\build-web.bat` 驱动：分别构建 QTools-C（`npm run build`）与 QTools-M（`npm run build:prod`），然后校验 `QTools-C\dist\index.html`、`dist\media\{index.html,app.js,app.css,photos.html,photo.js}` 是否存在（缺文件会打 `[WARN]`，提示先把媒体站文件放到 `QTools-C\public\media`）。
- 产物 `dist/` 由后端 `qtools.web.userDist` 指向并以 `8080` 单端口托管（`/` 出用户端 SPA、`/media/` 出静态页）；也可以交给 nginx 直接托管静态文件。
- SPA 使用 `createWebHistory()`，托管侧需把未命中的前端路由回退到 `index.html`。

## 登录态与接口约定

### 登录态：`src/composables/useAppAuth.js`（模块级 reactive 单例）

```js
const { state, doLogin, doRegister, fetchMe, doLogout, claimDevice, clearAuth } = useAppAuth()
// state = { token, user, loading, restored }
```

- `state.token` 唯一真源是 `localStorage['app.token']`，`state.user` 缓存于 `localStorage['app.user']`（隐私模式下写入失败会被忽略，内存态照常工作）。
- `fetchMe()`：刷新后恢复登录态。**静默恢复**——不抛异常、不弹提示；401 触发 `clearAuth()` 清 token 与 user，其它错误保留 token 以便重试。成功后写回用户缓存（含 `identities`）。
- `doLogin` / `doRegister`：注册接口只保证返回 `{ user }`，若没带 token 会拿刚填的账号再登录一次；`state.loading` 用于按钮防重复提交。
- `doLogout()`：先调后端撤销会话，失败也只 `console.warn` 然后清本地，保证按钮永远有效。
- 401 由 api 层通过 `setUnauthorizedHandler(clearAuth)` 钩子广播到单例（用钩子而非直接 import，避免循环依赖），页面层只决定是否跳登录页。
- 路由守卫：`beforeEach` 中只在「有 token 且 `state.restored` 为 false」时 `await fetchMe()`，即**每次页面加载最多校验一次**；`meta.requiresAuth && !state.token` → `/login?redirect=<fullPath>`。

### 两套接口风格并存

| 用途 | axios 实例 | 前缀 | 成功形态 | 失败形态 |
| --- | --- | --- | --- | --- |
| 工具列表、访问埋点 | `src/utils/request.js`（超时 10s） | `baseURL = VITE_API_BASE_URL \|\| '/api'`，调用 `/toolInfo/list`、`/toolVisit/add` | 若依 `AjaxResult`：`{ code, msg, data }`，`code === 200` 视为成功，拦截器直接解包为 `data` | `code !== 200` 视为业务失败；非静默请求弹 `msg` 并 reject，静默请求只 reject 不提示；网络类错误按 `silent` 决定是否提示 |
| 用户端账号 | `src/api/appAuth.js` 自建实例（超时 15s） | `/api/app/auth/**`：`register` / `login` / `logout` / `me` / `claim` | 后端直接返回业务对象（`{ token, expiresIn, user }`、`{ user }`、`{ ok:true }`），拦截器直接给 `data` | 后端返回 4xx/5xx + `{ error }`，拦截器抛「带 `status` 的 Error」交给页面做行内文案；401 额外广播清登录态 |

`appAuth.js` 还兼容一种历史形态：被安全过滤器拦下时的「HTTP 200 + `{ code, msg }`」包装体——响应体里出现数值 `code` 就按失败处理（正常业务成功体不含数值 `code`）。

**后端不可用时的表现**（逐条都是设计行为，不是 bug）：

- 首页：`el-alert` 显示「工具加载失败」，并回退渲染内置 4 条兜底卡片（含媒体站），首页始终可用。
- 工具页：计算全在前端，**完全不受影响**；埋点 `reportToolVisit` 全程 `silent`，失败只留一条 `console.warn`（先查列表反查 `toolId`，查不到就用 `FALLBACK_TOOL_IDS`：`/tool/json`→1、`/tool/text-count`→2、`/tool/pwd-gen`→3；都没命中则不发请求）。
- 账号页：有 token 但 `/me` 失败时显示加载失败提示，不清 token；接口 401 才会清登录态并跳 `/login?redirect=/account`。
- 媒体站：请求失败只影响内容渲染，页面本身照常打开。

## 构建注意事项

`vite.config.js` 有四处必须保留的配置，改之前请先读这一节：

1. **构建期关闭 esbuild 与压缩（`command === 'build'` 时设 `esbuild: false` + `build.minify: false`）**
   Windows + Node 24 下，esbuild 0.21 在构建结束清理临时目录时会报 `EPERM: Access is denied`（`remove <TEMP>\esbuild-xxx`），导致 `vite build` 在 rendering chunks 之后失败、`dist/` 无产物。规避办法就是构建时不用 esbuild 转译/压缩。
   **代价：产物未压缩**（`dist` 里主 JS chunk 约 2.7 MB，含 Element Plus 全量组件）。这在本项目可接受：压缩交给服务端实时 gzip —— 后端 `application.yml` 的 `server.compression`（`enabled: true`，mime-types 覆盖 js/css/json/html/svg 等，`min-response-size: 2048`）按 `Accept-Encoding` 压缩响应；若改用 nginx 托管，需要在 nginx 侧开启 `gzip`。`dev` 模式不受此配置影响。
2. **`server.watch.ignored`（`**/.*.tmpdir/**`、`**/*.tmp`、`**/node_modules/**`、`**/dist/**`）**
   否则 Windows 上编辑器/工具写文件时产生的临时目录会让 dev server 因 `EBUSY` 直接崩溃（Node 24 + Vite 5/6 实测会整个杀掉进程）。
3. **`/api` 代理到 `VITE_PROXY_TARGET`（默认 `http://localhost:8080`）且不做 rewrite**
   后端接口本身就是 `/api/...`，加 rewrite 会把前缀吃掉导致 404。另外 `css.preprocessorOptions.scss.api = 'modern'` 用于消除 Dart Sass 的 `legacy-js-api is deprecated` 告警（项目只装了 `sass`，未装 `sass-embedded`，所以用 `'modern'` 而非 `'modern-compiler'`）。
4. **`index.html` 用 `<link rel="icon" href="data:,">`**
   内联空 favicon，避免浏览器请求 `/favicon.ico` 得到 404（开发者工具 Network 面板一直飘红）。媒体站的三个 HTML 也各自带了同样的声明。

## 自定义站点信息

站点名、副标题与版权有且只有一个来源：`src/utils/constants.js` 的 `APP_INFO`（`name` / `slogan` / `copyright`，第 11-18 行）。页头 Logo、页脚、关于本站弹窗、浏览器标签页标题都从它取值；`APP_INTRO`（第 21 行）也已用它拼好，改一处即全站生效。

- `index.html` 的静态 `<title>` 只是首屏兜底，应用启动后会被 `APP_INFO.name` 覆盖（`src/router/index.js:87-89`）。
- 媒体站是**手写静态页**（`public/media/` 下 10 个文件，不经 Vue 构建）：`index.html` / `photos.html` / `me.html` 各自的 `<title>`、文案与样式都要单独改，不归 `APP_INFO` 管。
- 改完 `public/media/` 里的 JS/CSS 记得递增 HTML 中的 `?v=` 版本号（当前 `20261022b`），否则浏览器可能仍在用缓存里的旧文件。
- 品牌色改 `src/styles/variables.scss` 的 `--qt-*` 全局变量（`:root` 在第 7 行、`--qt-primary` 在第 14 行），组件内一律通过 `var(--qt-*)` 取值。

端到端的改造顺序（工具列表、媒体内容、部署）见 **[自定义与迁移指南](../QTools/doc/自定义与迁移指南.md)**。

## 常见问题

- **后端没启动，首页显示「工具加载失败」、只有 3 张卡片？** 正常行为：列表请求失败后回退内置兜底数据，首页保持可用。开发环境下确认后端已起在 `8080`，或检查 `.env.development` 里 `VITE_PROXY_TARGET` 是否指向正确的后端地址。
- **`npm run dev` 跑一会儿就崩，报 `EBUSY`？** Windows 上编辑器/同步盘/杀软写临时目录触发了文件监听。已在 `vite.config.js` 的 `server.watch.ignored` 忽略 `*.tmp`、`.*.tmpdir` 等路径；如果仍复现，把项目移出同步盘目录，或把出问题的目录追加进该忽略列表。
- **`vite build` 在 rendering chunks 之后报 `EPERM: Access is denied`？** 就是上文第 1 条的 esbuild 0.21 临时目录清理问题，配置里已经规避；请不要"顺手"把 `esbuild: false` / `minify: false` 删掉，否则构建会重新失败。
- **浏览器标签页图标报 404？** 已用 `<link rel="icon" href="data:,">` 规避；若要换成真实图标，请放一个静态文件并改成正常 `href`，不要留空 `href`。
- **构建产物偏大（主 chunk 约 2.7 MB）？** 两个原因叠加：`build.minify: false`（见上）与 `main.js` 里 Element Plus **全量引入** + 图标全量注册。当前由服务端 gzip 兜住传输体积；后续可做的优化（记为 M6 优化项）：按需引入 Element Plus（`unplugin-vue-components` / `unplugin-auto-import` 或手工按组件注册）、图标改为按需注册（首页已支持按名字动态取组件，改白名单即可）、路由级已天然分块，无需额外处理。
- **控制台出现 Dart Sass 的 `legacy-js-api is deprecated` 告警？** 已通过 `scss.api = 'modern'` 消除。升级到 Vite 6/7 后新版默认使用现代化 API，届时可移除该选项。
- **`npm install` 打印依赖安装脚本未执行的 warning？** npm 11+ 默认不执行依赖的 install-scripts，退出码仍为 0，开发与构建都不受影响。确需放行可执行 `npm install-scripts approve esbuild`；`@parcel/watcher` 的脚本会走 node-gyp 编译，缺 C++ 构建工具时反而失败，一般不必放行。
- **5173 端口被占用？** 配置里没有 `strictPort`，Vite 会自动改用下一个可用端口，请以终端打印的地址为准。
- **媒体站页面 404？** 构建后确认 `dist/media/` 存在（`build-web.bat` 会做这项校验）；直接跑 `npm run dev` 时访问 `/media/index.html` 由 Vite 从 `public/` 直出，不受影响。

## 许可与致谢

- **许可**：本项目以 **MIT License** 分发，见仓库根目录 `LICENSE`（Copyright © 2026 haha0614）。
- **致谢**：感谢 [Vue](https://github.com/vuejs/core)、[Vite](https://github.com/vitejs/vite)、[Element Plus](https://github.com/element-plus/element-plus) 与 [若依 RuoYi](https://github.com/yangzongzhuan/RuoYi-Vue) 提供的框架与组件生态。
