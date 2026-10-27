# P5.70 —— 登录改为全局悬浮窗（含「弹窗内注册」追加需求）实现与实测报告

范围：只改前端 `QTools-C`，未跑 git。新增 3 个文件 + 改造 7 个文件 + 新增 1 套真浏览器实测脚本。
验收脚本：`devtools/p570-ui/run.mjs`（headless Chrome + CDP，零第三方依赖）→ **101 passed, 0 failed**。

---

## 1. 实现方式

### 1.1 新增文件

| 文件 | 职责 |
|---|---|
| `src/composables/useAuthDialog.js` | 全局开关单例 `{ open, reason }` + `openAuthDialog()` / `closeAuthDialog()`。任何组件 import 就能唤起同一个弹窗，不必层层传 props、不必跳路由 |
| `src/components/AuthLoginForm.vue` | **登录表单本体**：用户名 / 密码 / 显示密码 / 提交按钮 / 未开放入口 / 「用邀请码注册」切换。校验规则、`errorTextOf` 文案映射、`doLogin` 调用都在这里 |
| `src/components/AuthRegisterForm.vue` | **注册表单本体**（邀请码模式）：邀请码 / 用户名 / 密码 / 确认密码 / `doRegister` 调用 / 后端原文错误展示 |
| `src/components/AuthLoginDialog.vue` | 模态外壳：遮罩、`role=dialog`、aria、焦点、滚动锁、登录 ⇄ 注册切换 |

### 1.2 一份表单、两处宿主（复用做法）

```
AuthLoginForm.vue ──┬── views/auth/Login.vue      （深链 /login 页面宿主：成功后按 redirect 跳走）
                    └── AuthLoginDialog.vue        （全局悬浮窗宿主：成功后原地关窗，不跳页）
AuthRegisterForm.vue ─┬── views/auth/Register.vue （深链 /register 页面宿主：成功后回首页）
                      └── AuthLoginDialog.vue      （弹窗内切换过来的注册表单）
```

- 表单组件**不做任何路由动作**，只 `emit('success')`；「跳不跳页」由宿主决定 —— 这是两处能共用一份实现的唯一分歧点。
- 样式只有一份真源：`views/auth/auth-card.scss` 同时被两个表单页与两个表单组件 `@use`（值完全相同，代价只是这几十行 CSS 输出两次）。
- 校验与接口**没有第二份**：登录走 `useAppAuth().doLogin`、注册走 `doRegister`，与改造前完全同一路径。

### 1.3 弹窗外壳的关键行为（`AuthLoginDialog.vue`）

- `<Teleport to="body">` + `position: fixed; inset: 0; z-index: 300`（高于外壳 60/70/80 与移动抽屉），任何页面都能压住；`<body>` 下**只挂一个实例**（`AppShell.vue` 里挂一次）。
- 关闭：右上 × / Esc / 点遮罩（`event.target === currentTarget`，点面板内部不关）/ 提交成功。
- 打开：记录 `document.activeElement` → 锁 `body.style.overflow='hidden'` → `nextTick` 后焦点进**当前表单的第一个输入框**；关闭：还原 overflow → 焦点还给那个触发按钮（元素还在文档里才还）。
- Esc 用**捕获阶段 + stopPropagation**：移动抽屉也有 window 级 Esc 监听，一次 Esc 只关弹窗、不连带关抽屉。
- Tab 在弹窗内循环（首尾折返）；打开时若焦点跑到面板外，Tab 会拉回面板内。

### 1.4 弹窗内「注册」（追加需求）

- 点「还没有账号？用邀请码注册」→ `switchMode('register')`：**同一层换表单**，弹窗不关、URL 不变，焦点进邀请码输入框；注册表单里「已有账号？去登录」切回来。
- 字段：邀请码 / 用户名 / 密码 / 确认密码（昵称不再填 —— 后端 `nickname` 留空自动用用户名兜底，昵称在个人中心 /me 可改；这是本轮**有意**的字段精简）。
- 注册接口：`POST /api/app/auth/register` body `{ username, password, inviteCode }`（不传 nickname），成功回 `200 { user }`（**无 token**）→ `doRegister` 随后自动登录一次。
  - 自动登录成功 → 关弹窗，侧栏立即出现用户名；
  - 自动登录失败（账号已建好）→ `useAppAuth.doRegister` 在错误上标 `registerSucceeded=true`，表单据此**切回登录表单并用成功样式提示「注册成功，请登录」**，不再把登录失败误报成注册失败。
- 失败文案**用后端 `{error}` 原文**（`api/appAuth.js` 已把 body.error 放进 `err.message`）：
  - 邀请码无效 / 已用尽 → `邀请码无效或已用尽`（400）
  - 用户名重复 → `用户名已存在`（409）
  - 两次密码不一致 → 前端 `el-form` 字段校验 `两次输入的密码不一致`（不发请求）
- 邀请码真值（`QINGTUYWM`）**没有写进前端**：占位文案只提示「由站长提供」。

---

## 2. 入口改造清单（站内不再跳 /login）

| 位置 | 改造前 | 改造后 |
|---|---|---|
| 侧栏底部（桌面 + 移动抽屉）`AppShell.vue` | `RouterLink to="/login"` | `<button data-testid="rail-login">` → `openLogin()` = 先收抽屉再开弹窗 |
| 移动端顶栏「登录」`AppShell.vue` | `goLogin()` → `router.push('/login')` | `openLogin()`（同按钮，`data-testid="topbar-login"`） |
| 已登录侧栏条目 | 「个人中心」链接 | 保留，并在右侧补一枚**用户名**（`.qt-rail__user`，收起态随 `.qt-rail__label` 一起隐藏；主标签 `flex:0 0 auto` 不被挤掉） |
| 个人中心身份卡「登录」`MePage.vue` | `router-link to="/login?redirect=/me"` | `<button data-testid="me-login">` → `openAuthDialog({ reason: '登录后可跨设备同步收藏与浏览记录' })`（弹窗内一句原因） |
| 注册页「已有账号？去登录」`Register.vue` | `<a href="/login">`（会离开注册页） | 原生 `<a href="/login" @click.prevent="openAuthDialog()">`：当前页开弹窗，href 保留（中键/新标签仍可开独立页） |
| 登录页「用邀请码注册」`Login.vue` | `router-link to="/register"` | 页面宿主传 `switch-href="/register"` → 真链接跳独立注册页；**弹窗宿主**留空 → 就地切表单 |
| 独立页 `/login`、`/register` | 站内入口目标 | **保留**（深链 / 直接访问仍可用），但站内不再指过去 |

未发现其它「需要登录才能操作」的前端入口（收藏、上传、认领都在 /me 内部或登录态才出现）；移动抽屉里的「登录」也已覆盖（先收抽屉再开弹窗，避免弹窗关掉后还留着一个开着的抽屉）。

---

## 3. 验收证据（真浏览器，`node devtools/p570-ui/run.mjs`）

被测对象是 **vite build 产物 dist**（自建静态托管 + `/api` 代理到真后端 127.0.0.1:8080）。
只有「登录成功」那一组用 CDP Fetch 打桩（本机没有可用测试账号），注册全部走真后端。

```
===== 结果：101 passed, 0 failed =====
页面异常：无
```

| 组 | 断言数 | 关键证据 |
|---|---|---|
| A URL 不变 | 12 | 首页 / 视频库 / 图片站 / 人物页各点一次侧栏「登录」 |
| C 焦点 + 无障碍 | 8 | role/aria-modal/aria-labelledby、锁滚动、焦点进输入框、Tab 循环、点面板不关 |
| B 三种关闭 | 6 | ×、遮罩、Esc，且全程 URL 不变、焦点回触发按钮、滚动锁撤掉 |
| D 真 401 | 4 | 错密码 → 弹窗内行内「用户名或密码错误」，弹窗不关、URL 不变、请求体仍 `{identifier,password}` |
| E 登录成功（打桩） | 8 | 弹窗关、侧栏出用户名、token 落 `app.token`、页面**没有重载**（JS 上下文存活）、额外拉了一次 /me |
| F 窄屏 375 | 13 | 登录/注册表单都全宽（panel 宽 375、left 0）、无横向溢出、面板 667→420 时可内部滚（scrollTop 13）、抽屉里点登录先收抽屉 |
| G 深链 | 10 | /login、/register 仍可直达且复用同一份表单；/login 页点侧栏登录也只开弹窗 |
| I 个人中心 | 3 | /me 上开弹窗 + 一句原因，URL 仍 /me；主动点登录不残留原因 |
| **J 弹窗内注册（真后端）** | **24** | 切表单不关窗不跳页、4 字段、错误邀请码 400 原文、QINGTUYWM 真注册 200 + 自动登录、同名 409、注册态 Esc 可关、375 宽注册表单、J6「注册成功但自动登录失败」→ 切回登录 + 提示 + 手动登录成功 |
| H 亮 / 暗 | 4 | 标题/面板对比度 13.0:1（亮 值 255,255,255；暗 值 35,35,36） |

**URL 不变（贴 pathname 前后）**

| 页面 | 点击前 | 点「登录」后 | 关闭后 |
|---|---|---|---|
| 首页 | `/` | `/` | `/` |
| 视频库 | `/media#sort=dur-desc` | `/media#sort=dur-desc` | 同左 |
| 图片站 | `/media/photos#s=photos-asc&p=name-desc` | 同左（滚动 400 → 400） | 同左 |
| 人物页 | `/media/persons` | `/media/persons` | `/media/persons` |
| 个人中心 | `/me` | `/me` | — |
| 登录页 | `/login` | `/login` | — |

**注册真相（真后端原始往返，脚本代理层记账）**

```
错误邀请码  POST /api/app/auth/register  {"username":"p570mismatch","password":"Passw0rd123","inviteCode":"WRONG-INVITE-2026"}
        → 400 {"error":"邀请码无效或已用尽"}                 （弹窗表单内显示同一句）

同名注册    POST /api/app/auth/register  {"username":"p570reg69846609","password":"Passw0rd123","inviteCode":"QINGTUYWM"}
        → 409 {"error":"用户名已存在"}                        （弹窗表单内显示同一句）

注册成功    POST /api/app/auth/register  → 200 {"user":{"id":16,"username":"p570reg69846609","nickname":"p570reg69846609",…}}
        随后    POST /api/app/auth/login → 200 {"token":"eyJ…","expiresIn":604800,"user":{…}}
```

J6（注册成功但自动登录失败，用一次性 401 桩制造）：弹窗保持打开 → 标题变「登录」→ 提示 `注册成功，请登录` → 焦点在用户名 → 随后用同一组账密**真登录成功**、侧栏出现该用户名（证明账号确实建好了）。

---

## 4. 构建与测试

| 项 | 结果 |
|---|---|
| `vite build` | **0 error**（`✓ built in ~5s`） |
| 既有单测（13 个 `*.test.mjs`） | 全部 exit 0：ctrl-autohide 78/78、playlist-count 43/43、playlist-filter 17/17、personBgBlur 38/38、personWall 136、personRules 43、playbackContext 83、playerExtras 175、playerProgress 111、subtitleStyle 50、synopsisAudio 7、synopsisRules 47 |
| 既有 harness `devtools/p540-ui/run.mjs`（真 AppShell 左栏 / 首页 hero / toast） | **18 passed, 0 failures** |
| 新 harness `devtools/p570-ui/run.mjs` | **101 passed, 0 failed**（产物：`devtools/p570-ui/out/after/*.png` + `report.json`） |

### 调整的旧断言

- **既有单测 / 既有 harness：0 处调整**（上表全部原样通过）。
- 本轮**需求变更作废**的断言（都在我本轮新建的 `p570-ui` 脚本里，不是历史遗留）：
  1. 「弹窗里的『用邀请码注册』跳到 `/register`」→ 改为「**就地切换注册表单，URL 仍是 /login**」（追加需求的直接结果）。
  2. `/register` 页「去登录」的选择器从 `a[href="/login"]` 改为 `.qt-auth-linkbtn`（现在是按钮，因为它开的是弹窗而非跳页）。
  3. 媒体页会把自己的排序状态写进 hash，J 组的 URL 比较改为 **path + search**（hash 由媒体页维护，与弹窗无关）。

---

## 5. 测试数据清理（已执行）

```sql
-- 本轮反复实测共真注册出 7 个测试账号（p570reg*/p570late*），测完全部删除，并复位邀请码计数：
DELETE FROM qtools.app_user_identity WHERE user_id IN (SELECT id FROM qtools.app_user WHERE username LIKE 'p570%');
DELETE FROM qtools.app_user           WHERE username LIKE 'p570%';
UPDATE qtools.app_invite_code SET used_count = 0 WHERE code = 'QINGTUYWM';   -- 实测前就是 0，复位回 0
```

复查：`app_user` 中 `p570%` 残留 **0 行**、`app_user_identity` 中 `p570%` 残留 **0 行**、`app_user` 总数 **0**（本轮之前库里就没有用户），
`QINGTUYWM.used_count = 0 / max_uses = 10`（与实测前完全一致）。

---

## 6. 已知限制 / 需要知道的点

1. **昵称字段**：注册表单从「用户名 + 昵称 + 密码 + 确认密码 + 邀请码」精简为追加需求指定的 4 项；昵称由后端用用户名兜底，注册后可在 /me 修改。
2. **自动填充**：用户名 `autocomplete="username"`、登录密码 `current-password`、注册密码 `new-password`。这只是把字段语义告诉浏览器 —— **不阻止**自动填充；是否填充、是否记住密码由用户浏览器 / 密码管理器决定。
3. **深层页的「切换」**：/login 页的「用邀请码注册」仍是带 `href` 的链接（可中键新开）；/register 页的「去登录」是按钮（它开的是弹窗），因此不能中键新开标签。
4. **邀请码先扣后查重**：后端 `register` 先 `increaseUsedCount` 再查重名，同名注册会消耗一次邀请码次数（真后端行为，不是前端问题；失败事务会回滚，实测 409 未扣次数）。
5. **媒体页 `.fatal` 错误条会盖住左栏底部账号入口**：`PhotosPage` 的致命错误条是 `position: fixed; bottom: 16px; z-index: 200`，比左栏（60）高，媒体页加载失败时它会压住「登录」。这是改造前就存在的行为，本轮**未改**（不在范围内），但实测脚本会检测它并重载页面，避免把环境问题误判成弹窗问题。
6. **本机后端不稳**：实测期间后端 JVM 掉过几次（MySQL/Redis 一直在），已用项目自带脚本 `启动站点.bat` 重启并保持在跑；每次掉线都会让媒体页出 `.fatal`，脚本对此做了重载重试。
7. `router.beforeEach` 里 `requiresAuth` 的跳转分支保留未动（当前没有任何路由声明 `requiresAuth`，属既有兜底逻辑）。

---

## P5.79 追加：审核制带来的断言调整（本轮已改，2026-10）

P5.79 起注册进入**审核制**：`POST /api/app/auth/register` 成功回
`200 { user, pending:true, message:"注册成功，等待站长审核" }`，**不再下发 token**；账号 `status=pending`
必须由管理端审核通过后才能登录（pending 登录回 403「账号待审核，请联系站长」，rejected 回 403
「注册未通过审核：<原因>」）。因此本目录 run.mjs 的 J 组做了如下调整：

| 旧断言 | 新断言 |
| --- | --- |
| 真后端注册成功（200 + user） | 200 + `pending:true` |
| 注册成功并自动登录：侧栏「登录」消失 | **不再自动登录**：token 没落 localStorage、侧栏仍是「登录」 |
| 侧栏出现新注册的用户名 | 删除（未登录，本来就不该出现） |
| 注册自动登录后 token 已落 localStorage | 删除 |
| 提示「注册成功，请登录」 | 提示「注册成功，等待站长审核后可登录」 |
| J6「注册成功但自动登录失败 -> 切回登录 + 手动登录成功」 | J6「待审核账号真登录 -> 403 + 表单内后端原文」 |

其余分组不受影响。本轮实测（前端 dist + 临时后端 :18090 + 克隆库 qtools_p579）：

    cd QTools-C && QT_BACKEND=http://127.0.0.1:18090 node devtools/p570-ui/run.mjs p579
    ===== 结果：99 passed, 0 failed =====

证据目录：E:/111/project/QTools/p579-evidence（probe.log / m-out / c-out / REPORT.md）。
