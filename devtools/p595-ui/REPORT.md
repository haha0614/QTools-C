# P5.95 站端兜底提示 —— 实测报告（QTools-C）

真浏览器实测（Chrome headless + CDP，零第三方依赖）。跑法：

```bash
node QTools-C/devtools/p595-ui/run.mjs     # 默认被测实例 http://127.0.0.1:18091
```

结果：**PASS 28/28**（`out/report.json` 存了每次探针的原始字段）。截图在 `out/*.png`。

## 1. 被测环境怎么来的（生产库一次都没改）

| 项 | 值 |
|---|---|
| 临时实例 | `:18091`，用当前源码的 `target/classes` 直接起（`java -cp`），**不是**生产 jar |
| 库 | 克隆库 `qtools_p595_tmp`（`mysqldump qtools` → 导入，只改克隆库） |
| 生产库 `qtools` | 全程只读；结束时 `select ... from media_root where guest_visible <> 1` = **0 行** |
| 登录 | 站端 `Qing`、管理端 `admin`（密码哈希只在克隆库里被重置，生产库不动） |

场景切换走管理端真接口 `PUT /api/media/admin/roots/{id} {"guestVisible":false|true}`
（缓存由服务端自己失效，不用等 60 s TTL）。

临时实例的启动命令（新代码 + 克隆库，与生产 jar / 生产库完全隔离）：

```bash
# 1) 克隆库
mysql -h127.0.0.1 -P3307 -uroot -p qtools -e 'create database qtools_p595_tmp'
mysqldump -h127.0.0.1 -P3307 -uroot -p --single-transaction qtools | mysql -h127.0.0.1 -P3307 -uroot -p qtools_p595_tmp
# 2) 类路径 = 各模块 target/classes + 第三方依赖（不打包、不覆盖生产 jar）
mvn -o -pl qtools-admin dependency:build-classpath -Dmdep.outputFile=tmp/cp-admin.txt
# 3) 起实例
java -cp "<各模块 target/classes>;<cp-admin.txt>" -Dqtools.home=E:/111/project/QTools \
  com.qtools.QToolsApplication --server.port=18091 \
  --spring.config.additional-location=file:E:/111/project/QTools/config/ \
  --spring.datasource.druid.master.url="jdbc:mysql://localhost:3307/qtools_p595_tmp?useUnicode=true&characterEncoding=utf8"
```

## 2. 断言与截图

### A. 未登录 + `guest_visible=0`（游客索引 stats = `{videos:0,albums:1,photos:0,posters:0,people:0}`）

| 页面 | 断言 | 截图 |
|---|---|---|
| `/media` | 出现 `[data-role=guest-hidden-empty]`、文案逐字一致、按钮 = 登录 / 刷新 | `out/site-media-guest-hidden.png` |
| `/media/photos` | 同上 | `out/site-photos-guest-hidden.png` |
| `/media/persons` | 同上 | `out/site-persons-guest-hidden.png` |
| `/media` | 点「登录」→ 打开全站唯一登录悬浮窗 `[data-testid=auth-dialog]`，原因 = 「登录后可查看站长设为「仅登录可见」的内容」 | `out/site-media-login-dialog.png` |

### B. 登录后同一 URL

| 页面 | 断言 | 截图 |
|---|---|---|
| `/media` | 专门空态消失，看得到内容（48 张卡） | `out/site-media-logged-in.png` |
| `/media/photos` | 专门空态消失，25 个相册格 | `out/site-photos-logged-in.png` |
| `/media/persons` | 专门空态消失，13 张人物卡 | `out/site-persons-logged-in.png` |
| `/media/persons` + 搜索 `zzzz-no-such-person` | 普通空态「没有匹配的人物，换个关键词试试」，**没有**专门文案 | `out/site-persons-logged-in-empty.png` |

### C. `guest_visible=1`

游客索引 stats = `{videos:239,albums:193,photos:9913,posters:239,people:13}`，三页都没有专门空态、
内容正常：`out/site-media-gv1.png`、`out/site-photos-gv1.png`、`out/site-persons-gv1.png`。

## 3. 判定口径（与需求的一处**有意偏差**，请复核）

需求写的是「索引 stats 全为 0」。实测定到本库有一个**空壳相册**
`media_album.id=a308`（`photo_count=9017`，`media_photo` 里 0 行）：
所有根都 `guest_visible=0` 时它不属于任何隐根的图片，于是留在索引里，把 `stats.albums` 顶成 **1**。

后果：若严格按「5 个 stats 全 0」判定，**这条提示在本库永远不会出现** —— 正是它要防的那次事故。
因此实际判定用「内容条目」口径：

```js
未登录 && 接口 200 && stats.videos === 0 && stats.photos === 0 && stats.posters === 0 && stats.people === 0
```

`albums` 不参与。严格口径 `statsAllZero()` 仍保留在 `guestHidden.js` 里并有单测，两者都在
`src/views/media/guestHidden.test.mjs` 里被断言覆盖（34/34 PASS）。

## 4. 已知限制

1. 「内容为空」判定依赖索引 `stats`：索引接口若因别的原因返回空数组但 stats 仍在，不会误报（stats 非 0 就不提示）；
2. 人物页在「人物接口仍有行、但索引一条内容都没有」时给的是**置顶提示**（不是替换整页），因为那时卡片虽然渲染，
   头像 / 背景全是 404 —— 正是事故里的形态；
3. 图片站上方的筛选 chip（`全部 1 / 念念 1`）仍会显示相册计数，它来自 `albums` 长度，未隐藏；
4. 三个页面都会在 `app.token` 变化时重取数据：登录后内容立刻出现，退出后回到专门空态。
