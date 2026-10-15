# 简易在线工具箱（qtools）

一个纯前端运算的在线工具集合：打开即用、无需注册，所有计算都在浏览器本地完成，数据不上传服务器。
工程基于 **Vue3 + Vite + Element Plus**，自带暗色模式，工具信息与访问量由后端接口维护。

## 目录结构

```
qtools/
├── index.html                     # HTML 入口（lang=zh-CN，挂载 #app）
├── package.json                   # 依赖与脚本
├── package-lock.json              # npm 依赖锁定（随仓库提交）
├── vite.config.js                 # Vite 配置：@ 别名、端口 5173、/api 代理
├── .env.development               # 开发环境变量
├── .gitignore
├── README.md
└── src/
    ├── main.js                    # 应用入口：Element Plus、图标、样式、主题初始化
    ├── App.vue                    # 根组件：仅 <router-view />
    ├── router/
    │   └── index.js               # 4 条懒加载路由 + scrollBehavior 回顶
    ├── api/
    │   └── tool.js                # 工具列表 / 访问上报接口
    ├── utils/
    │   ├── request.js             # axios 实例与统一拦截
    │   └── constants.js           # FALLBACK_TOOL_IDS 兜底映射
    ├── composables/
    │   └── useTheme.js            # 全局主题单例（useTheme / initTheme）
    ├── styles/
    │   ├── index.scss             # 全局样式：reset、容器类、响应式
    │   └── variables.scss         # 主题 CSS 变量（亮色 / 暗色）
    ├── components/
    │   ├── AppHeader.vue          # 首页顶部栏（Logo + 主题切换 + 关于本站）
    │   ├── AppFooter.vue          # 全站页脚
    │   ├── ToolHeader.vue         # 工具页顶部栏（面包屑 + 主题切换）
    │   ├── ThemeToggle.vue        # 主题切换按钮
    │   └── AboutDialog.vue        # 关于本站弹窗
    └── views/                     # 页面视图（首页与三个工具页）
        ├── Home.vue
        └── tool/
            ├── JsonFormat.vue
            ├── TextCount.vue
            └── PwdGen.vue
```

## 开发命令

```bash
npm install         # 安装依赖
npm run dev         # 启动开发服务器，默认 http://localhost:5173
npm run build       # 生产构建，产物在 dist/
npm run preview     # 本地预览构建产物
```

> 本工程以 **npm** 为准（`package-lock.json` 随仓库提交）。也可以用 pnpm / yarn，但请勿混用 lockfile。

开发环境变量（`.env.development`）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `/api` | 前端请求基础路径 |
| `VITE_PROXY_TARGET` | `http://localhost:8080` | 开发服务器 `/api` 代理目标 |

> 代理不做 rewrite：后端接口本身即 `/api/...`。

## 常见问题

- **`npm install` 警告依赖构建脚本未执行（`install-scripts`）**：npm 11.19+ 默认不执行依赖的安装脚本，会打印 warning，但退出码仍为 0，开发与构建都不受影响。需要显式放行时执行 `npm install-scripts approve esbuild`；`@parcel/watcher` 的安装脚本会走 node-gyp 编译，缺少 C++ 构建工具时反而会失败，一般不必放行。
- **改用 pnpm 时**：pnpm 默认同样不执行依赖构建脚本，需在 `pnpm-workspace.yaml` 中放行（pnpm 11+ 用 `allowBuilds: { esbuild: true, '@parcel/watcher': true }`，pnpm 9.5~10 用 `onlyBuiltDependencies` 列表），否则 install 会以 `ERR_PNPM_IGNORED_BUILDS` 结束。
- **pnpm 报 `ERR_PNPM_EISDIR`（符号链接创建失败）**：仅当工程位于 exFAT 等不支持符号链接/硬链接的卷上时出现，此类卷请改用 `pnpm install --node-linker=hoisted --config.package-import-method=copy`；NTFS 卷不需要该参数。
- 以上情况都只影响依赖安装阶段，不影响工程功能。

## 后端接口契约

### 1. 查询工具列表

```
GET /api/toolInfo/list
```

响应体直接为工具数组：

```json
[
  {
    "id": 1,
    "tool_name": "JSON格式化",
    "tool_desc": "在线格式化、压缩与校验 JSON",
    "tool_route": "/tool/json",
    "icon": "Document",
    "sort": 1
  }
]
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | number | 工具主键，访问上报时使用 |
| `tool_name` | string | 工具名称（列表卡片标题） |
| `tool_desc` | string | 工具一句描述 |
| `tool_route` | string | 前端路由，如 `/tool/json`，是前端匹配工具的唯一键 |
| `icon` | string | 图标名，对应 `@element-plus/icons-vue` 组件名 |
| `sort` | number | 排序值，越小越靠前 |

业务响应若形如 `{ code, msg, data }`，仅当 `code === 200` 视为成功，否则弹出 `msg` 并中断流程。

### 2. 上报一次工具访问

```
POST /api/toolVisit/add
Content-Type: application/json

{ "toolId": 1 }
```

前端调用链：`reportToolVisit(toolRoute)` → 先 `GET /toolInfo/list` 按 `tool_route` 匹配 `id` → 匹配不到或接口失败时使用本地兜底表 `FALLBACK_TOOL_IDS`（`/tool/json: 1`、`/tool/text-count: 2`、`/tool/pwd-gen: 3`）→ 再 `POST /api/toolVisit/add`。
整个过程内部 `try/catch` + `console.warn`，不抛异常、不阻断页面。

## 主题（暗色模式）

- 暗色通过 `<html class="dark">` 表达，配合 `element-plus/theme-chalk/dark/css-vars.css`，与 Element Plus 官方方案一致。
- localStorage 键名为 `qtools-theme`，取值 `'dark' | 'light'`；无存储值时跟随 `prefers-color-scheme`，并在系统主题变化时实时同步。
- 页面样式统一使用 `src/styles/variables.scss` 中的 CSS 变量（`--qt-bg-page`、`--qt-bg-card`、`--qt-bg-hover`、`--qt-text-primary`、`--qt-text-secondary`、`--qt-border`、`--qt-primary`、`--qt-shadow`、`--qt-danger`），禁止硬编码颜色。
- 业务代码中：

```js
import { useTheme, initTheme } from '@/composables/useTheme'

const { isDark, toggleTheme, setTheme } = useTheme() // 模块级单例，所有组件同步
initTheme() // 仅需在 main.js 挂载前调用一次
```

## 集成进若依前端 RuoYi-Vue3

若要把本工程作为子模块并入 RuoYi-Vue3（`ruoyi-ui`），按以下步骤操作：

1. **拷贝页面**：把 `src/views/Home.vue` 与 `src/views/tool/*.vue` 拷贝到宿主 `src/views/qtools/` 下，保持相对层级，例如：
   - `src/views/qtools/Home.vue`
   - `src/views/qtools/tool/JsonFormat.vue`
   - `src/views/qtools/tool/TextCount.vue`
   - `src/views/qtools/tool/PwdGen.vue`
2. **拷贝共享模块**：把 `src/api/tool.js`、`src/utils/request.js`、`src/composables/useTheme.js`、`src/styles/variables.scss` 与 `src/components/*` 一并拷入宿主工程。
   - 若宿主已有 `utils/request.js`，请重命名本工程的副本（如 `utils/qtoolsRequest.js`），并改写 `api/tool.js` 中的 import。
   - 若宿主已有同名组件，建议统一放到 `src/components/qtools/` 目录下。
3. **改写 import 前缀**：把 `@/xxx` 之类与本工程目录结构强绑定的路径改为宿主的实际位置，例如：
   - `import request from '@/utils/request'` → `import request from '@/utils/qtoolsRequest'`
   - `import ThemeToggle from './ThemeToggle.vue'` → `import ThemeToggle from '@/components/qtools/ThemeToggle.vue'`
   - 页面内的 `@/api/tool`、`@/composables/useTheme`、`@/styles/variables.scss` 同样按宿主目录调整。
   - 变量文件建议改为 `@use '@/assets/styles/qtools-variables.scss' as *;` 之类的绝对路径。
4. **路由改为若依后台菜单配置**：本工程的路由文件不再使用，改在「系统管理 → 菜单管理」中配置，参考：

   | 菜单名称 | 路由地址 | 组件路径 | 说明 |
   | --- | --- | --- | --- |
   | 简易在线工具箱 | `/` | 或独立顶级菜单 | 首页 |
   | JSON格式化 | `tool/json` | `qtools/tool/JsonFormat` | 注意组件路径不带 `views/` 前缀与 `.vue` 后缀 |
   | 文本字数统计 | `tool/text-count` | `qtools/tool/TextCount` | |
   | 随机密码生成器 | `tool/pwd-gen` | `qtools/tool/PwdGen` | |

   若希望路径保持 `/tool/json` 这种形式，将该菜单挂在顶级（父菜单为空）或使用外链式布局；`meta.title` 由菜单名称自动提供，页面内可自行调用 `reportToolVisit(route.path)` 上报访问。
5. **暗色模式与若依主题的兼容**：若依自带主题系统（`settings` store + `useDark`），本工程统一依赖 `<html class="dark">` 这一唯一信号，因此两种做法都可行：
   - 推荐：移除本工程的 `useTheme`，改用若依的暗色开关，但保证其同样在 `<html>` 上切换 `dark` 类；
   - 或者：保留本工程的 `ThemeToggle`，把它的 `setTheme` 与若依的 `toggleDark`/`useDark` 做一次双向同步。
   - 无论哪种方式，只要 `html.dark` 生效，`variables.scss` 中的暗色变量与 Element Plus 暗色变量就会同时生效，页面样式无需改动（不要为页面单独写 `prefers-color-scheme` 媒体查询）。