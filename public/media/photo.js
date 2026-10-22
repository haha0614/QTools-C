/* 图片站前端。前半段是纯函数（无 DOM 依赖，可被 node require 做无浏览器自测），后半段才是 DOM 应用。 */
(function () {
  'use strict';

  var BATCH_SIZE = 120;      // 册内网格每批插入上限
  var FLAT_BATCH = 240;      // 全部图片视图每批插入上限
  var GROUP_PREVIEW = 6;     // 一行容量测量失败时的兜底列数
  var UNGROUPED = '未归类';
  var ZOOM_MIN = 0.2;
  var ZOOM_MAX = 5;

  // 后端媒体接口前缀：旧 /api、/media、/thumb、/preview 全部收敛到这一处
  var MEDIA = '/api/media';

  /* ---------------- 事件上报（埋点） ----------------
     只上报，不参与渲染/路由/交互决策；内部异常一律吞掉，保证埋点出问题也不影响页面。
     接口匿名，前端不处理响应：
       POST /api/media/track  —— 行为事件
       POST /api/toolVisit/add —— 工具级访问计数（媒体站在 tool_info 里的 id 是 4） */

  var TOOL_ID = 4;
  var TRACK_URL = MEDIA + '/track';
  var TOOL_VISIT_URL = '/api/toolVisit/add';
  var OWNER_STORE_KEY = 'ms.owner';   // 与 profile.js 共用的身份键

  // 设备标识：优先 localStorage['ms.owner']（profile.js 的落盘位置），退回同名 cookie；取不到传空
  function trackOwner() {
    try {
      var v = window.localStorage.getItem(OWNER_STORE_KEY);
      if (v) return v;
    } catch (e) { /* 无痕模式可能抛错 */ }
    try {
      var m = /(?:^|;\s*)ms\.owner=([^;]*)/.exec(document.cookie || '');
      if (m) return decodeURIComponent(m[1]);
    } catch (e) { /* 忽略 */ }
    return '';
  }

  // 非阻塞 JSON POST：sendBeacon 优先（页面卸载时也能送达），否则 fetch keepalive；失败静默
  function postJson(url, payload) {
    try {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(url, blob)) return;
      }
      fetch(url, {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: body
      }).catch(function () { /* 失败静默 */ });
    } catch (e) { /* 上报失败不影响页面 */ }
  }

  // 统一的事件上报入口；progress 为可选的 0–100 整数百分比（图片事件不传，保持接口与 app.js 一致）
  function track(eventType, targetType, targetKey, valueNum, progress) {
    try {
      postJson(TRACK_URL, {
        eventType: eventType,
        targetType: targetType,
        targetKey: String(targetKey == null ? '' : targetKey),
        ownerKey: trackOwner(),
        valueNum: Math.max(0, Math.round(Number(valueNum) || 0)),
        progress: Math.min(100, Math.max(0, Math.round(Number(progress) || 0)))
      });
    } catch (e) { /* 忽略 */ }
  }

  var tkPage = { loaded: false, visStart: 0, visMs: 0 };   // 页面级：page_view 只报一次 + 可见毫秒

  // 页面打开：page_view 与工具级访问各报一次，之后开始计可见时长
  function tkPageOpen() {
    if (tkPage.loaded) return;
    tkPage.loaded = true;
    track('page_view', 'page', location.pathname, 0);
    try { postJson(TOOL_VISIT_URL, { toolId: TOOL_ID }); } catch (e) { /* 忽略 */ }
    if (document.visibilityState !== 'hidden') tkPage.visStart = Date.now();
  }

  // 结算并上报本段页面可见毫秒（隐藏/离开时调用，报完清零；重新可见时再起表）
  function tkDwellFlush() {
    if (tkPage.visStart) { tkPage.visMs += Math.max(0, Date.now() - tkPage.visStart); tkPage.visStart = 0; }
    var ms = tkPage.visMs;
    tkPage.visMs = 0;
    if (ms > 0) track('dwell', 'page', location.pathname, ms);
  }

  // 页面加载后调用一次：注册卸载/可见性监听并上报打开事件
  function initTracking() {
    window.addEventListener('pagehide', tkDwellFlush);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { tkDwellFlush(); return; }
      if (!tkPage.visStart) tkPage.visStart = Date.now();   // 重新可见：接着累计
    });
    tkPageOpen();
  }

  // ---------------- 纯函数 ----------------

  function pad4(n) { return String(n).padStart(4, '0'); }

  function thumbUrl(albumId, i) { return MEDIA + '/thumb/p/' + albumId + '/' + pad4(i); }
  function previewUrl(albumId, i) { return MEDIA + '/preview/p/' + albumId + '/' + pad4(i); }
  function mediaUrl(rel) { return MEDIA + '/file?p=' + encodeURIComponent(String(rel == null ? '' : rel)); }

  function fileName(rel) {
    var s = String(rel == null ? '' : rel);
    var k = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return k >= 0 ? s.slice(k + 1) : s;
  }

  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return Math.round(n) + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var v = n / 1024;
    var k = 0;
    while (v >= 1024 && k < units.length - 1) { v /= 1024; k += 1; }
    return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + units[k];
  }

  function photosOf(album) {
    return (album && Array.isArray(album.photos)) ? album.photos : [];
  }

  function totalPhotos(albums) {
    return (albums || []).reduce(function (s, a) { return s + (Number(a && a.count) || 0); }, 0);
  }

  function totalBytes(albums) {
    return (albums || []).reduce(function (s, a) { return s + (Number(a && a.bytes) || 0); }, 0);
  }

  function titleCmp(a, b) {
    var t = String((a && a.title) || '').localeCompare(String((b && b.title) || ''), 'zh-Hans-CN');
    if (t) return t;
    var ia = String((a && a.id) || ''), ib = String((b && b.id) || '');
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  }

  function filterAlbums(albums, opts) {
    opts = opts || {};
    var q = String(opts.q == null ? '' : opts.q).trim().toLowerCase();
    var folder = String(opts.folder == null ? '' : opts.folder);
    return (albums || []).filter(function (a) {
      if (!a) return false;
      if (folder && a.folder !== folder) return false;
      if (!q) return true;
      return String(a.title || '').toLowerCase().indexOf(q) >= 0
        || String(a.person || '').toLowerCase().indexOf(q) >= 0;
    });
  }

  // ---------------- 排序 ----------------
  // 相册排序与人物排序都写进 hash（s= / p=），随机项的次序在一份页面里稳定、刷新后重洗。

  var SORT_ALBUMS = ['photos-desc', 'photos-asc', 'bytes-desc', 'bytes-asc', 'title-asc', 'title-desc', 'random'];
  var SORT_PEOPLE = ['albums-desc', 'albums-asc', 'name-asc', 'name-desc', 'random'];
  // 全部图片视图独立的单图级排序：与相册排序 s= 完全分离，走 fs=
  var SORT_FLAT = ['random', 'album', 'title-asc', 'title-desc', 'fav-first', 'recent-first'];
  var SORT_FLAT_DEF = 'random';
  var FLAT_NOMATCH = 9007199254740991;   // 非收藏/非最近：排在有序项之后
  var PICK_ALBUMS = SORT_ALBUMS.slice(0, SORT_ALBUMS.length - 1);   // 首次加载随机挑选时排除「随机」本身
  var PICK_PEOPLE = SORT_PEOPLE.slice(0, SORT_PEOPLE.length - 1);
  var SORT_ALIAS = { count: 'photos-desc', bytes: 'bytes-desc', title: 'title-asc' };   // 老 key 兼容
  var SORT_ALBUM_DEF = 'photos-desc';
  var SORT_PEOPLE_DEF = 'albums-desc';

  function normSort(key, list, def) {
    var k = SORT_ALIAS[key] || String(key == null ? '' : key);
    return list.indexOf(k) >= 0 ? k : def;
  }

  function normFlatSort(key) {
    var k = String(key == null ? '' : key);
    return SORT_FLAT.indexOf(k) >= 0 ? k : SORT_FLAT_DEF;
  }

  function flatKey(albumId, i) { return String(albumId) + '#' + Math.max(0, Math.trunc(Number(i) || 0)); }

  function pickOne(list, rnd) {
    var r = typeof rnd === 'function' ? rnd() : Math.random();
    r = Math.min(0.999999, Math.max(0, Number(r) || 0));
    return list[Math.floor(r * list.length)];
  }

  function nameCmp(a, b) {
    return String((a && a.name) || '').localeCompare(String((b && b.name) || ''), 'zh-Hans-CN');
  }

  function sortAlbums(albums, key, opts) {
    opts = opts || {};
    var rank = typeof opts.rank === 'function' ? opts.rank : function () { return Math.random(); };
    var k = normSort(key, SORT_ALBUMS, SORT_ALBUM_DEF);
    var num = function (v) { return Number(v) || 0; };
    var out = (albums || []).slice();
    var byCountDesc = function (a, b) { return num(b.count) - num(a.count) || titleCmp(a, b); };
    var byBytesDesc = function (a, b) { return num(b.bytes) - num(a.bytes) || titleCmp(a, b); };
    var cmp;
    if (k === 'photos-asc') cmp = function (a, b) { return num(a.count) - num(b.count) || titleCmp(a, b); };
    else if (k === 'bytes-desc') cmp = byBytesDesc;
    else if (k === 'bytes-asc') cmp = function (a, b) { return num(a.bytes) - num(b.bytes) || titleCmp(a, b); };
    else if (k === 'title-asc') cmp = titleCmp;
    else if (k === 'title-desc') cmp = function (a, b) { return titleCmp(b, a); };
    else if (k === 'random') cmp = function (a, b) { return rank('a:' + a.id) - rank('a:' + b.id); };
    else cmp = byCountDesc;
    out.sort(cmp);
    return out;
  }

  // 只影响人物分组（section）与 chips 的顺序，不影响组内相册
  function sortPeople(people, key, opts) {
    opts = opts || {};
    var rank = typeof opts.rank === 'function' ? opts.rank : function () { return Math.random(); };
    var k = normSort(key, SORT_PEOPLE, SORT_PEOPLE_DEF);
    var out = (people || []).slice();
    var cnt = function (g) { return Number(g && g.count) || 0; };
    var cmp;
    if (k === 'albums-asc') cmp = function (a, b) { return cnt(a) - cnt(b) || nameCmp(a, b); };
    else if (k === 'name-asc') cmp = nameCmp;
    else if (k === 'name-desc') cmp = function (a, b) { return nameCmp(b, a); };
    else if (k === 'random') cmp = function (a, b) { return rank('p:' + a.name) - rank('p:' + b.name); };
    else cmp = function (a, b) { return cnt(b) - cnt(a) || nameCmp(a, b); };
    out.sort(cmp);
    return out;
  }

  function sortQuery(sort, psort) {
    return 's=' + encodeURIComponent(String(sort || '')) + '&p=' + encodeURIComponent(String(psort || ''));
  }

  function wallHashOf(person, sort, psort, view, flatSort) {
    var q = [];
    if (person) q.push('person=' + encodeURIComponent(String(person)));
    if (sort && psort) q.push(sortQuery(sort, psort));
    if (view === 'flat') q.push('v=flat');
    if (view === 'flat') q.push('fs=' + encodeURIComponent(normFlatSort(flatSort)));
    return q.length ? '#' + q.join('&') : '#/';
  }

  function albumHashOf(albumId, index, sort, psort) {
    var h = routeHash(albumId, index);
    return (sort && psort) ? h + '&' + sortQuery(sort, psort) : h;
  }

  // ---------------- 人物维度（契约 §2.5） ----------------
  // 数据里有 person/people 时一律以数据为准；缺字段才按 §2.5 规则推导，作为兜底。

  var NAME_SEP = /\s+[-–—]\s+|\s*——\s*/;

  function cleanName(s) {
    return String(s == null ? '' : s).replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
  }

  function dirSegs(dir) {
    return String(dir == null ? '' : dir).replace(/\\/g, '/').split('/').filter(function (s) { return s; });
  }

  function derivePerson(album) {
    var segs = dirSegs(album && album.dir);
    if (!segs.length || segs[0] !== '写真') return UNGROUPED;   // 写真·散图 / 壁纸·… → 未归类
    if (segs.length < 2) return UNGROUPED;
    if (/^念念(\s|$)/.test(segs[1])) return '念念';
    var base = segs[segs.length - 1];
    var m = /^【(.+?)】/.exec(base);
    if (m) return cleanName(m[1]) || cleanName(base) || UNGROUPED;
    return cleanName(base.split(NAME_SEP)[0]) || cleanName(base) || UNGROUPED;
  }

  // people 条目里给出的统计值优先（字段存在时以数据为准，不用推导值覆盖）
  function groupMeta(g, entry) {
    if (entry) {
      if (Number(entry.count) > 0) g.count = Number(entry.count);
      if (Number(entry.photos) > 0) g.photos = Number(entry.photos);
      if (entry.cover) g.cover = String(entry.cover);
    }
    return g;
  }

  // → [{name,count,photos,cover,albums:[相册对象]}]，顺序 = people 数组顺序（其余按 count 降序追加）
  function resolvePeople(albums, peopleRaw) {
    var raw = Array.isArray(peopleRaw) ? peopleRaw.filter(function (p) { return p && cleanName(p.name); }) : [];
    var idToName = Object.create(null);
    raw.forEach(function (p) {
      var name = cleanName(p.name);
      (Array.isArray(p.albums) ? p.albums : []).forEach(function (id) {
        if (!idToName[id]) idToName[id] = name;
      });
    });
    var map = new Map();
    (albums || []).forEach(function (a) {
      if (!a) return;
      var name = cleanName(a.person) || idToName[a.id] || derivePerson(a) || UNGROUPED;
      var g = map.get(name);
      if (!g) { g = { name: name, count: 0, photos: 0, cover: '', albums: [] }; map.set(name, g); }
      g.albums.push(a);
      g.count += 1;
      g.photos += Number(a.count) || 0;
      if (!g.cover) g.cover = a.cover || '';
    });
    var out = [];
    var used = Object.create(null);
    raw.forEach(function (p) {
      var name = cleanName(p.name);
      var g = map.get(name);
      if (!g || used[name]) return;      // 数据里有但相册里没这个人的不渲染
      used[name] = true;
      map.delete(name);
      out.push(groupMeta(g, p));
    });
    Array.from(map.values())
      .sort(function (x, y) { return y.count - x.count || String(x.name).localeCompare(String(y.name), 'zh-Hans-CN'); })
      .forEach(function (g) { out.push(g); });
    return out;
  }

  function batchCount(total, size) {
    total = Math.max(0, Math.trunc(Number(total) || 0));
    size = Math.max(1, Math.trunc(Number(size) || BATCH_SIZE));
    return Math.ceil(total / size);
  }

  function batchRange(total, batchIndex, size) {
    total = Math.max(0, Math.trunc(Number(total) || 0));
    size = Math.max(1, Math.trunc(Number(size) || BATCH_SIZE));
    var b = Math.max(0, Math.trunc(Number(batchIndex) || 0));
    var start = Math.min(total, b * size);
    return { start: start, end: Math.min(total, start + size) };
  }

  function batchIndexOf(index, size) {
    size = Math.max(1, Math.trunc(Number(size) || BATCH_SIZE));
    return Math.floor(Math.max(0, Math.trunc(Number(index) || 0)) / size);
  }

  // 翻页与定位：越界夹紧，不循环
  function clampIndex(i, n) {
    n = Math.max(0, Math.trunc(Number(n) || 0));
    if (!n) return 0;
    i = Math.trunc(Number(i) || 0);
    if (i < 0) return 0;
    if (i > n - 1) return n - 1;
    return i;
  }

  function nextIndex(i, n) {
    var c = clampIndex(i, n);
    return clampIndex(c + 1, n);
  }

  function prevIndex(i, n) {
    var c = clampIndex(i, n);
    return clampIndex(c - 1, n);
  }

  // 「第 N 张」输入框（1 起）→ 0 起序号；非法返回 -1
  function parseJump(text, n) {
    var m = /^\s*(\d+)\s*$/.exec(String(text == null ? '' : text));
    if (!m) return -1;
    return clampIndex(parseInt(m[1], 10) - 1, n);
  }

  function photoAt(album, i) {
    var ps = photosOf(album);
    if (!ps.length) return null;
    return ps[clampIndex(i, ps.length)] || null;
  }

  // 展示用地址：big 走 2000px 预览档，其余直接原图（150~250KB 可接受）
  function photoUrl(album, i) {
    var p = photoAt(album, i);
    if (!p) return '';
    return p.big ? previewUrl(album.id, p.i) : mediaUrl(p.rel);
  }

  function originalUrl(album, i) {
    var p = photoAt(album, i);
    return p ? mediaUrl(p.rel) : '';
  }

  function clampZoom(z) {
    z = Number(z);
    if (!isFinite(z) || z <= 0) return 1;
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  }

  function zoomBy(z, factor) { return clampZoom((Number(z) || 1) * (Number(factor) || 1)); }

  function memoryKey(albumId) { return 'ms.album.' + albumId; }

  // localStorage 里的裸序号 → 合法 0 起序号；无记录/非法 → -1
  function parseStoredIndex(raw, n) {
    if (raw == null) return -1;
    var m = /^\s*(\d+)\s*$/.exec(String(raw));
    if (!m) return -1;
    return clampIndex(parseInt(m[1], 10), n);
  }

  // 深链：#album=<id> → 册内网格；#album=<id>&i=<0 基序号> → 直接开该张 lightbox
  function parseHashParams(h) {
    var out = {};
    String(h).split('&').forEach(function (kv) {
      if (!kv) return;
      var eq = kv.indexOf('=');
      var key = eq < 0 ? kv : kv.slice(0, eq);
      var val = eq < 0 ? '' : kv.slice(eq + 1);
      out[key] = val;
    });
    return out;
  }

  function parseRoute(hash) {
    var h = String(hash == null ? '' : hash).replace(/^#/, '').replace(/^\/+/, '');
    if (!h) return { view: 'wall', person: '' };
    var p = parseHashParams(h);
    if (p.album) {
      var id;
      try { id = decodeURIComponent(p.album); } catch (_) { id = p.album; }
      var index = null;
      if (/^\d+$/.test(p.i || '')) index = parseInt(p.i, 10);
      return { view: 'album', albumId: id, index: index };
    }
    if (p.person) {
      var who;
      try { who = decodeURIComponent(p.person); } catch (_) { who = p.person; }
      return { view: 'wall', person: who };
    }
    // 兼容早先的 #/album/<id>[/<i>] 形态
    var m = /^album\/([^\/?#]+)(?:\/(\d+))?$/.exec(h);
    if (!m) return { view: 'wall', person: '' };
    var lid;
    try { lid = decodeURIComponent(m[1]); } catch (_) { lid = m[1]; }
    return { view: 'album', albumId: lid, index: m[2] == null ? null : parseInt(m[2], 10) };
  }

  function routeHash(albumId, index) {
    var h = '#album=' + encodeURIComponent(String(albumId));
    if (index == null) return h;
    return h + '&i=' + Math.max(0, Math.trunc(Number(index) || 0));
  }

  function personHash(name) {
    var n = String(name == null ? '' : name);
    return n ? '#person=' + encodeURIComponent(n) : wallHash();
  }

  function wallHash() { return '#/'; }

  // 契约 §4.1 的 photo 收藏项（thumb 走 thumbs/p/… 相对路径，不是 /thumb/ 前缀）
  function favItemOf(album, i) {
    var a = album || {};
    var idx = Math.max(0, Math.trunc(Number(i) || 0));
    return {
      kind: 'photo', album: String(a.id == null ? '' : a.id), i: idx,
      title: String(a.title == null ? '' : a.title) + ' #' + (idx + 1),
      thumb: 'thumbs/p/' + a.id + '/' + pad4(idx) + '.jpg'
    };
  }

  // 全部图片视图的扁平序列（单图级排序）。flatSort：
  //  random 全局打乱（页面级 rankMap，过滤后仍是同一顺序的子序列）/ album 相册排序→册内序号 /
  //  title-asc|title-desc 相册名自然序（同类相册相邻）/ fav-first、recent-first：给定 key 序（新→旧）优先，其余随机
  function flatItems(albums, opts) {
    opts = opts || {};
    var mode = normFlatSort(opts.flatSort);
    var person = String(opts.person || '');
    var map = opts.personOf || Object.create(null);
    var rank = typeof opts.rank === 'function' ? opts.rank : Math.random;
    var list = filterAlbums((albums || []).filter(function (a) {
      if (!a) return false;
      return !person || map[a.id] === person;
    }), { q: opts.q });

    var out = [];
    var push = function (a) {
      var n = Math.max(0, Math.trunc(Number(a.count) || 0));
      for (var i = 0; i < n; i += 1) out.push({ a: a, i: i });
    };

    if (mode === 'album') {
      sortAlbums(list, opts.sort, { rank: rank }).forEach(push);
      return out;
    }
    if (mode === 'title-asc' || mode === 'title-desc') {
      var sign = mode === 'title-desc' ? -1 : 1;
      list.slice().sort(function (x, y) {
        var t = String(x.title || '').localeCompare(String(y.title || ''), 'zh-Hans-CN', { numeric: true });
        if (t) return t * sign;
        var ix = String(x.id || ''), iy = String(y.id || '');
        return (ix < iy ? -1 : ix > iy ? 1 : 0) * sign;
      }).forEach(push);
      return out;
    }

    list.forEach(push);
    var order = orderMap(mode === 'fav-first' ? opts.favKeys : mode === 'recent-first' ? opts.recentKeys : null);
    var rows = out.map(function (it) {
      var k = flatKey(it.a.id, it.i);
      return { it: it, p: order && order[k] != null ? order[k] : FLAT_NOMATCH, r: rank('f:' + k) };
    });
    rows.sort(function (x, y) { return (x.p - y.p) || (x.r - y.r); });
    return rows.map(function (row) { return row.it; });
  }

  // key 序（新→旧）→ 名次表；重复项取首次出现
  function orderMap(keys) {
    var m = null;
    (keys || []).forEach(function (k, idx) {
      if (!k) return;
      if (!m) m = Object.create(null);
      if (m[k] == null) m[k] = idx;
    });
    return m;
  }

  // hash 里的视图段：'flat' / 'group' / ''（未指定时沿用 localStorage 里的值）
  function routeView(hash) {
    var p = parseHashParams(String(hash == null ? '' : hash).replace(/^#/, '').replace(/^\/+/, ''));
    if (p.v === 'flat') return 'flat';
    if (p.v === 'group') return 'group';
    return '';
  }

  // hash 里的单图排序段：缺省返回 ''（沿用 localStorage）
  function routeFlatSort(hash) {
    var p = parseHashParams(String(hash == null ? '' : hash).replace(/^#/, '').replace(/^\/+/, ''));
    return Object.prototype.hasOwnProperty.call(p, 'fs') ? normFlatSort(p.fs) : '';
  }

  var PURE = {
    BATCH_SIZE: BATCH_SIZE, FLAT_BATCH: FLAT_BATCH, GROUP_PREVIEW: GROUP_PREVIEW, UNGROUPED: UNGROUPED,
    ZOOM_MIN: ZOOM_MIN, ZOOM_MAX: ZOOM_MAX,
    SORT_ALBUMS: SORT_ALBUMS, SORT_PEOPLE: SORT_PEOPLE, SORT_FLAT: SORT_FLAT,
    PICK_ALBUMS: PICK_ALBUMS, PICK_PEOPLE: PICK_PEOPLE,
    SORT_ALBUM_DEF: SORT_ALBUM_DEF, SORT_PEOPLE_DEF: SORT_PEOPLE_DEF, SORT_FLAT_DEF: SORT_FLAT_DEF,
    pad4: pad4, thumbUrl: thumbUrl, previewUrl: previewUrl, mediaUrl: mediaUrl,
    fileName: fileName, formatBytes: formatBytes, photosOf: photosOf,
    totalPhotos: totalPhotos, totalBytes: totalBytes,
    filterAlbums: filterAlbums, sortAlbums: sortAlbums, sortPeople: sortPeople,
    normSort: normSort, pickOne: pickOne, sortQuery: sortQuery,
    normFlatSort: normFlatSort, flatKey: flatKey,
    wallHashOf: wallHashOf, albumHashOf: albumHashOf,
    cleanName: cleanName, derivePerson: derivePerson, resolvePeople: resolvePeople,
    favItemOf: favItemOf, flatItems: flatItems, routeView: routeView, routeFlatSort: routeFlatSort,
    batchCount: batchCount, batchRange: batchRange, batchIndexOf: batchIndexOf,
    clampIndex: clampIndex, nextIndex: nextIndex, prevIndex: prevIndex, parseJump: parseJump,
    photoAt: photoAt, photoUrl: photoUrl, originalUrl: originalUrl,
    clampZoom: clampZoom, zoomBy: zoomBy,
    memoryKey: memoryKey, parseStoredIndex: parseStoredIndex,
    parseRoute: parseRoute, routeHash: routeHash, personHash: personHash, wallHash: wallHash
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PURE;
  if (typeof document === 'undefined') return;   // node 下自测到此为止

  // ---------------- DOM 应用 ----------------

  var BATCH = BATCH_SIZE;
  var OPEN_KEY = 'ms.open.';              // sessionStorage：每个用户的组折叠/展开状态
  var VIEW_KEY = 'ms.view';               // localStorage：group | flat
  var FLATSORT_KEY = 'ms.flatsort';       // localStorage：单图级排序（fs）
  // #sort 里两组选项：相册排序（分组视图）/ 单图排序（全部图片视图）
  var FLAT_OPTS = [
    { v: 'random', label: '🎲 随机（单图）' },
    { v: 'album', label: '按相册' },
    { v: 'title-asc', label: '标题 A→Z' },
    { v: 'title-desc', label: '标题 Z→A' },
    { v: 'fav-first', label: '★ 收藏优先' },
    { v: 'recent-first', label: '🕘 最近浏览优先' }
  ];
  var albumOpts = null;                   // 启动时从 HTML 抓下来的 7 项相册排序
  var els = {};
  var state = {
    albums: [], people: [], peopleBase: [], person: '', personOf: Object.create(null), q: '',
    sort: SORT_ALBUM_DEF, psort: SORT_PEOPLE_DEF,
    view: 'group', flatSort: SORT_FLAT_DEF, flatItems: [], flatBatch: 0, flatLoaded: 0, flatKeep: 0,
    prevOpen: Object.create(null), dataComplete: false, watchRounds: 0,
    album: null, batch: 0, loaded: 0,
    lbOpen: false, lbIndex: 0, zoom: 1, px: 0, py: 0,
    imgLoaded: false, spinTimer: 0, retryKind: 'image',
    wallScroll: 0, openToken: 0, scrollTimer: 0, viewW: 0, resizeTimer: 0
  };
  var profileBound = false;

  // 「随机」排序的次序：每份页面生成一次，同一次会话内稳定、刷新后重洗
  var rankMap = Object.create(null);
  function randRank(tag) {
    if (!(tag in rankMap)) rankMap[tag] = Math.random();
    return rankMap[tag];
  }

  var byId = function (id) { return document.getElementById(id); };
  function albumById(id) {
    for (var i = 0; i < state.albums.length; i += 1) if (state.albums[i].id === id) return state.albums[i];
    return null;
  }

  function createLimiter(max) {
    var active = 0, queue = [];
    function pump() {
      while (active < max && queue.length) {
        (function (job) {
          active += 1;
          var settled = false;
          var done = function () { if (settled) return; settled = true; active -= 1; pump(); };
          try { job(done); } catch (_) { done(); }
        })(queue.shift());
      }
    }
    return function (job) { queue.push(job); pump(); };
  }

  var coverLimit = createLimiter(6);   // 封面赋值并发上限
  var preloadLimit = createLimiter(4); // 相邻预加载并发上限
  var preloaded = new Set();

  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* 隐私模式忽略 */ } }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (_) { /* 隐私模式忽略 */ } }

  function fatal(msg) {
    var f = els.fatal;
    if (!f) return;
    f.textContent = msg;
    f.hidden = false;
  }

  // ---- 相册墙（按人物分组） ----

  function buildChips() {
    els.chips.textContent = '';
    var frag = document.createDocumentFragment();
    frag.appendChild(chipBtn('全部', state.albums.length, ''));
    state.people.forEach(function (g) { frag.appendChild(chipBtn(g.name, g.count, g.name)); });
    els.chips.appendChild(frag);
    syncChips();
  }

  function chipBtn(label, count, person) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('data-person', person);
    b.textContent = label + ' ' + count;
    b.addEventListener('click', function () { selectPerson(person); });
    return b;
  }

  function syncChips() {
    Array.prototype.forEach.call(els.chips.children, function (b) {
      b.classList.toggle('on', (b.getAttribute('data-person') || '') === state.person);
    });
  }

  function matchPerson(name) {
    var n = String(name == null ? '' : name);
    if (!n) return '';
    for (var i = 0; i < state.people.length; i += 1) if (state.people[i].name === n) return n;
    return '';
  }

  // 切人物：只改 UI 与 hash（replaceState），不产生历史条目
  function selectPerson(name) {
    state.person = matchPerson(name);
    // 埋点：选中真实人物才上报（「全部」是空串、占位组名 UNGROUPED 不报）
    if (state.person && state.person !== UNGROUPED) {
      track('person_click', 'person', String(state.person).slice(0, 64), 0, 0);
    }
    syncChips();
    renderWall();
    writeRoute();
  }

  // 两个排序 + 视图 + 单图排序都进 hash；replaceState 不产生历史条目
  function writeRoute() {
    var h = wallHashOf(state.person, state.sort, state.psort, state.view, state.flatSort);
    if (location.hash === h) return;
    try { history.replaceState(null, '', h); } catch (_) { location.hash = h; }
  }

  // ---- 视图切换（分组 / 全部图片） ----

  function syncSeg() {
    if (els.segGroup) { els.segGroup.classList.toggle('on', state.view === 'group'); els.segGroup.setAttribute('aria-pressed', state.view === 'group' ? 'true' : 'false'); }
    if (els.segFlat) { els.segFlat.classList.toggle('on', state.view === 'flat'); els.segFlat.setAttribute('aria-pressed', state.view === 'flat' ? 'true' : 'false'); }
  }

  // #sort 是同一控件两套语义：分组=相册排序（s=），全部图片=单图排序（fs=）
  function captureAlbumOpts() {
    albumOpts = Array.prototype.map.call(els.sort.options, function (o) { return { v: o.value, label: o.textContent }; });
  }

  function applySortOptions() {
    if (!els.sort || !albumOpts) return;
    var want = state.view === 'flat' ? FLAT_OPTS : albumOpts;
    els.sort.textContent = '';
    var frag = document.createDocumentFragment();
    want.forEach(function (o) {
      var op = document.createElement('option');
      op.value = o.v;
      op.textContent = o.label;
      frag.appendChild(op);
    });
    els.sort.appendChild(frag);
    els.sort.value = state.view === 'flat' ? normFlatSort(state.flatSort) : normSort(state.sort, SORT_ALBUMS, SORT_ALBUM_DEF);
  }

  function setView(v) {
    v = v === 'flat' ? 'flat' : 'group';
    if (v === state.view) return;
    state.view = v;
    lsSet(VIEW_KEY, v);
    syncSeg();
    applySortOptions();
    if (els.wallView.hidden) return;   // 册内视图下只记状态，回墙时按新视图渲染
    renderWall(true);                  // 保留已加载批数与滚动位置
    writeRoute();
  }

  function setFlatSort(v) {
    var next = normFlatSort(v);
    if (next === state.flatSort) return;
    state.flatSort = next;
    lsSet(FLATSORT_KEY, next);
    applySortOptions();
    if (els.wallView.hidden) return;
    renderWall(true);
    writeRoute();
  }

  // ---- 共享 profile 组件（收藏 / 最近浏览 / 右上角入口） ----

  function profileApi() {
    var P = window.MSProfile;
    return (P && typeof P === 'object') ? P : null;
  }

  function photoFav(item) {
    var P = profileApi();
    if (!P || typeof P.isFav !== 'function') return false;
    try { return !!P.isFav(item); } catch (_) { return false; }
  }

  function togglePhotoFav(item, star) {
    var P = profileApi();
    if (!item || !P || typeof P.toggleFav !== 'function') return;
    var paint = function (on) {
      if (star) star.classList.toggle('on', !!on);
      syncLbFav();
    };
    try {
      var r = P.toggleFav(item);
      if (r && typeof r.then === 'function') {
        r.then(function (on) { paint(typeof on === 'boolean' ? on : photoFav(item)); }, function () { paint(photoFav(item)); });
      } else {
        paint(photoFav(item));
      }
    } catch (_) { paint(photoFav(item)); }
  }

  function pushRecentPhoto() {
    var P = profileApi();
    if (!P || typeof P.pushRecent !== 'function' || !state.album) return;
    try {
      var r = P.pushRecent(favItemOf(state.album, state.lbIndex));
      if (r && typeof r.catch === 'function') r.catch(function () { /* 上报失败静默 */ });
    } catch (_) { /* 组件未就绪静默 */ }
  }

  // 收藏态变化后刷新所有可见的 ★
  function refreshFavs() {
    if (els.flat) {
      var cells = els.flat.querySelectorAll('.fcell');
      Array.prototype.forEach.call(cells, function (cell) {
        var star = cell.querySelector('.fav');
        if (!star) return;
        var a = albumById(cell.getAttribute('data-album'));
        if (!a) return;
        var on = photoFav(favItemOf(a, Number(cell.getAttribute('data-i')) || 0));
        star.classList.toggle('on', on);
      });
    }
    syncLbFav();
  }

  function bindProfileChange() {
    var P = profileApi();
    if (!P || typeof P.on !== 'function' || profileBound) return;
    profileBound = true;
    try { P.on('change', function () { onProfileChange(); }); } catch (_) { profileBound = false; }
  }

  // 收藏/最近浏览变化：刷新 ★；按收藏/最近排序时顺序也变了，保留批数重排
  function onProfileChange() {
    refreshFavs();
    var mode = normFlatSort(state.flatSort);
    if (!state.albums.length) return;                     // 数据还没到（组件先 emit('load')）时不动网格
    if (state.view === 'flat' && !els.wallView.hidden && (mode === 'fav-first' || mode === 'recent-first')) {
      renderFlat(true);
    }
  }

  function mountProfile() {
    var P = profileApi();
    var slot = els.profileSlot || byId('profileSlot');
    if (!P || typeof P.mount !== 'function' || !slot || slot.getAttribute('data-mounted') === '1') return;
    try { P.mount({ slot: '#profileSlot', site: 'photo' }); } catch (_) { return; }
    slot.setAttribute('data-mounted', '1');
    bindProfileChange();
  }

  // 组折叠状态：'off' 折叠 / 'preview' 默认只显示一行 / 'all' 全部展开
  function openState(name) {
    var v = ssGet(OPEN_KEY + name);
    if (v === '0') return 'off';
    if (v === 'all') return 'all';
    return 'preview';
  }

  function setOpenState(name, v) {
    ssSet(OPEN_KEY + name, v === 'off' ? '0' : v === 'all' ? 'all' : '1');
  }

  function rerender() {
    var y = window.scrollY || 0;
    renderWall();
    window.scrollTo(0, y);
  }

  function collapseGroup(name, collapse) {
    var cur = openState(name);
    if (collapse) {
      if (cur !== 'off') state.prevOpen[name] = cur;
      setOpenState(name, 'off');
    } else {
      setOpenState(name, state.prevOpen[name] === 'all' ? 'all' : 'preview');
    }
    rerender();
  }

  function expandGroup(name) {
    setOpenState(name, openState(name) === 'all' ? 'preview' : 'all');
    rerender();
  }

  function makeCard(a, person, sectionKey) {
    var card = document.createElement('a');
    card.className = 'card';
    card.href = routeHash(a.id);
    card.setAttribute('data-id', a.id);
    card.setAttribute('data-person', person);
    card.setAttribute('data-section', sectionKey || person);
    card.title = a.title + '\n' + (a.dir || '') + '\n' + a.count + ' 张 · ' + formatBytes(a.bytes) + ' · ' + person;

    var cover = document.createElement('div');
    cover.className = 'cover';
    var img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = a.title;
    img.dataset.src = thumbUrl(a.id, 0);
    img.addEventListener('load', function () { img.classList.add('loaded'); });
    img.addEventListener('error', function () {
      cover.classList.add('broken');
      var s = document.createElement('span');
      s.className = 'noimg';
      s.textContent = '缺少缩略图';
      cover.appendChild(s);
    });
    cover.appendChild(img);

    var stored = parseStoredIndex(lsGet(memoryKey(a.id)), a.count);
    if (stored >= 0) {
      var badge = document.createElement('span');
      badge.className = 'mem';
      badge.textContent = '上次看到 ' + (stored + 1);
      cover.appendChild(badge);
    }

    var body = document.createElement('div');
    body.className = 'cardBody';
    var t = document.createElement('div');
    t.className = 'cardTitle';
    t.textContent = a.title;
    var m = document.createElement('div');
    m.className = 'cardMeta';
    m.textContent = a.count + ' 张 · ' + formatBytes(a.bytes) + ' · ' + (person || UNGROUPED);
    body.appendChild(t);
    body.appendChild(m);

    card.appendChild(cover);
    card.appendChild(body);
    return card;
  }

  // ---- 分节：大人物各自成节，≤2 套的人物并成一节「其他」 ----

  var OTHER_KEY = '__other__';   // 合并节的折叠状态键：ms.open.__other__
  var OTHER_NAME = '其他';
  var SECTION_MIN = 3;           // 相册数 ≥ 3 的人物各自成节

  function singleSection(g) {
    var count = Number(g.count) || 0;
    var photos = Number(g.photos) || 0;
    return {
      key: g.name, name: g.name, title: g.name, meta: count + ' 套 · ' + photos + ' 张',
      members: [g], albums: g.albums, count: count, photos: photos, merged: false
    };
  }

  function otherSection(members) {
    var albums = [], count = 0, photos = 0;
    members.forEach(function (g) {
      albums = albums.concat(g.albums);
      count += Number(g.count) || 0;
      photos += Number(g.photos) || 0;
    });
    return {
      key: OTHER_KEY, name: OTHER_NAME, title: OTHER_NAME + ' ' + members.length + ' 位 · ' + count + ' 套',
      meta: '共 ' + photos + ' 张', members: members, albums: albums,
      count: count, photos: photos, merged: true
    };
  }

  // 人物排序决定节的顺序：合并节作为一项（套数合计 / 名字「其他」）参与排序
  function planSections(people, key, rank) {
    var own = [], small = [];
    (people || []).forEach(function (g) {
      if (!g) return;
      if (g.name === UNGROUPED || (Number(g.count) || 0) >= SECTION_MIN) own.push(g);
      else small.push(g);                     // 保持人物排序次序
    });
    var items = own.map(singleSection);
    if (small.length) items.push(otherSection(small));
    return sortPeople(items, key, { rank: rank });
  }

  function personByName(name) {
    for (var i = 0; i < state.people.length; i += 1) if (state.people[i].name === name) return state.people[i];
    return null;
  }

  // 单人视图（点 chip）就是一个节，标题用该人物名
  function wallSections() {
    if (state.person) {
      var g = personByName(state.person);
      return g ? [singleSection(g)] : [];
    }
    return planSections(state.people, state.psort, randRank);
  }

  // 人物标题条：占满整行、滚动时压住卡片；人物之间自然接续，没有独立包围盒
  function makeHead(sec, opts) {
    var head = document.createElement('div');
    head.className = 'phead';
    head.setAttribute('data-person', sec.key);                               // 节键：人物名 或 __other__
    head.setAttribute('data-open', opts.searching ? 'search' : opts.open);    // 搜索时强制展开，折叠态不隐藏命中结果
    if (sec.merged) head.setAttribute('data-merged', '1');

    var name = document.createElement('h3');
    name.className = 'pname';
    name.textContent = sec.title;

    var meta = document.createElement('span');
    meta.className = 'pmeta';
    meta.textContent = sec.meta;

    var act = document.createElement('div');
    act.className = 'pact';

    if (opts.canMore) {
      var more = document.createElement('button');
      more.type = 'button';
      more.className = 'pmore';
      more.setAttribute('data-person', sec.key);
      more.textContent = (!opts.searching && opts.open === 'all') ? '收起' : '展开全部 ' + sec.count + ' 套';
      act.appendChild(more);
    }

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ptoggle';
    toggle.setAttribute('data-person', sec.key);
    toggle.textContent = opts.open === 'off' ? '展开' : '折叠';
    act.appendChild(toggle);

    head.appendChild(name);
    head.appendChild(meta);
    head.appendChild(act);
    return head;
  }

  // 墙网格的实际列数（auto-fill/minmax 由浏览器解析成像素轨道列表）
  function wallCols() {
    var tpl = String(window.getComputedStyle(els.wall).gridTemplateColumns || '').trim();
    if (!tpl || tpl === 'none') return 0;
    return tpl.split(/\s+/).length;
  }

  function renderWall(keep) {
    if (state.view === 'flat') { renderFlat(keep); return; }
    els.flat.hidden = true;
    els.flatSentinel.hidden = true;
    els.flat.textContent = '';
    els.wall.hidden = false;
    var q = String(state.q || '').trim();
    var ql = q.toLowerCase();
    var searching = !!q;
    if (coverIO) coverIO.disconnect();
    els.wall.textContent = '';

    var cols = Math.max(1, wallCols() || GROUP_PREVIEW);   // 每节默认只铺一整行
    var frag = document.createDocumentFragment();
    var sections = 0, cards = 0, photos = 0;

    wallSections().forEach(function (sec) {
      // 命中人物名的整节保留；否则按标题过滤，同一人物的卡片保持相邻
      var hit = searching && sec.members.some(function (g) { return String(g.name).toLowerCase().indexOf(ql) >= 0; });
      var list = [];
      sec.members.forEach(function (g) {
        sortAlbums(hit ? g.albums.slice() : filterAlbums(g.albums, { q: q }), state.sort, { rank: randRank })
          .forEach(function (a) { list.push({ a: a, who: g.name }); });
      });
      if (!list.length) return;                       // 搜索无命中的节不渲染
      var open = openState(sec.key);
      var all = searching || open === 'all';
      var hidden = open === 'off' && !searching;
      var visible = hidden ? [] : (all ? list : list.slice(0, cols));
      frag.appendChild(makeHead(sec, { open: open, searching: searching, canMore: all || list.length > cols }));
      visible.forEach(function (it) { frag.appendChild(makeCard(it.a, it.who, sec.key)); });
      sections += 1;
      cards += visible.length;
      visible.forEach(function (it) { photos += Number(it.a.count) || 0; });
    });

    els.wall.appendChild(frag);
    els.wallEmpty.hidden = sections > 0;
    els.wallStat.textContent = '共 ' + state.albums.length + ' 本相册 / ' + totalPhotos(state.albums) + ' 张 · 当前 ' +
      sections + ' 节 ' + cards + ' 本 · ' + photos + ' 张';
    observeCovers();
  }

  var coverIO = null;
  function observeCovers() {
    var imgs = els.wall.querySelectorAll('img[data-src]');
    if (!('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(imgs, scheduleCover);
      return;
    }
    if (!coverIO) {
      coverIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          coverIO.unobserve(en.target);
          scheduleCover(en.target);
        });
      }, { rootMargin: '0px', threshold: 0.01 });
    }
    Array.prototype.forEach.call(imgs, function (img) { coverIO.observe(img); });
  }

  // 只在实际进入视口时才赋值 src，并受并发上限约束
  function scheduleCover(img) {
    var url = img.dataset.src;
    if (!url) return;
    delete img.dataset.src;
    coverLimit(function (done) {
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
      img.src = url;
    });
  }

  // ---- 全部图片视图（单图级平铺，分批插入） ----

  function buildPersonOf() {
    var map = Object.create(null);
    state.peopleBase.forEach(function (g) {
      (g.albums || []).forEach(function (a) { map[a.id] = g.name; });
    });
    state.personOf = map;
  }

  // 组件里的收藏/最近浏览（新→旧）→ flatItems 需要的 key 序；组件未就绪返回空，等于「其余随机」
  function flatOrderKeys(mode) {
    var P = profileApi();
    if (!P || typeof P.get !== 'function') return [];
    var data;
    try { data = P.get(); } catch (_) { return []; }
    if (!data || typeof data !== 'object') return [];
    var list = mode === 'fav-first' ? data.favorites : ((data.recent || {}).photos || []);
    var keys = [];
    (Array.isArray(list) ? list : []).forEach(function (it) {
      if (!it || it.kind !== 'photo' || it.album == null) return;
      keys.push(flatKey(it.album, it.i));
    });
    return keys;
  }

  function flatSource() {
    var mode = normFlatSort(state.flatSort);
    var ordered = (mode === 'fav-first' || mode === 'recent-first');
    return flatItems(state.albums, {
      person: state.person, personOf: state.personOf, q: state.q, sort: state.sort,
      flatSort: mode, rank: randRank,
      favKeys: ordered && mode === 'fav-first' ? flatOrderKeys(mode) : [],
      recentKeys: ordered && mode === 'recent-first' ? flatOrderKeys(mode) : []
    });
  }

  function updateFlatStat() {
    var total = state.flatItems.length;
    var who = state.person ? state.person : '全部图片';
    var q = String(state.q || '').trim();
    els.wallStat.textContent = '共 ' + total + ' 张 · ' + who + (q ? ' · 搜索「' + q + '」' : '') +
      ' · ' + flatSortLabel(state.flatSort) + ' · 已渲染 ' + state.flatLoaded + ' 张';
  }

  function flatSortLabel(v) {
    var k = normFlatSort(v);
    for (var i = 0; i < FLAT_OPTS.length; i += 1) if (FLAT_OPTS[i].v === k) return FLAT_OPTS[i].label;
    return k;
  }

  function makeFlatCell(it) {
    var a = it.a, i = it.i;
    var cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'fcell';
    cell.setAttribute('data-album', a.id);
    cell.setAttribute('data-i', String(i));
    cell.title = a.title + ' #' + (i + 1) + '\n' + a.title + ' · ' + (i + 1) + ' / ' + (Number(a.count) || 0);

    var img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.addEventListener('error', function () { cell.classList.add('broken'); }, { once: true });
    img.src = thumbUrl(a.id, i);
    cell.appendChild(img);

    var star = document.createElement('span');
    star.className = 'fav';
    star.setAttribute('role', 'button');
    star.setAttribute('aria-label', '收藏');
    star.textContent = '★';
    var item = favItemOf(a, i);
    if (photoFav(item)) star.classList.add('on');
    star.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      togglePhotoFav(item, star);
    });
    cell.appendChild(star);

    cell.addEventListener('click', function () {
      openAlbum(a.id, i);   // 复用现有 lightbox：上下文是该图所在相册
    });
    return cell;
  }

  function appendFlat() {
    var total = state.flatItems.length;
    if (!total || state.flatLoaded >= total) return 0;
    var r = batchRange(total, state.flatBatch, FLAT_BATCH);
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    var frag = document.createDocumentFragment();
    for (var k = r.start; k < r.end; k += 1) frag.appendChild(makeFlatCell(state.flatItems[k]));
    els.flat.appendChild(frag);
    state.flatBatch += 1;
    state.flatLoaded = r.end;
    state.flatKeep = r.end;      // 记住已渲染张数：切视图/改排序/回墙时按它补回
    var dt = ((window.performance && performance.now) ? performance.now() : Date.now()) - t0;
    updateFlatStat();
    console.debug('[flat] batch ' + state.flatBatch + ' +' + (r.end - r.start) + ' cells → ' +
      state.flatLoaded + '/' + total + ' · ' + dt.toFixed(1) + 'ms');
    return r.end - r.start;
  }

  // keep=true：保留已加载批数并回到原滚动位置（切视图/改单图排序/从册内返回时用）
  function renderFlat(keep) {
    if (coverIO) coverIO.disconnect();
    var y = window.scrollY || 0;
    var want = keep ? Math.max(0, state.flatKeep || 0) : 0;
    els.wall.textContent = '';
    els.wall.hidden = true;
    els.flat.hidden = false;
    els.flatSentinel.hidden = false;
    els.flat.textContent = '';
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    state.flatItems = flatSource();
    state.flatBatch = 0;
    state.flatLoaded = 0;
    state.flatKeep = 0;
    appendFlat();
    var guard = 0;
    while (state.flatLoaded < want && state.flatLoaded < state.flatItems.length && guard < 200) { appendFlat(); guard += 1; }
    var dt = ((window.performance && performance.now) ? performance.now() : Date.now()) - t0;
    updateFlatStat();
    els.wallEmpty.hidden = state.flatItems.length > 0;
    console.debug('[flat] render ' + state.flatItems.length + ' items, ' + state.flatLoaded + ' cells in ' +
      dt.toFixed(1) + 'ms · fs=' + state.flatSort);
    if (keep) requestAnimationFrame(function () { window.scrollTo(0, y); });
  }

  // ---- 册内网格 ----

  function updateCounter() {
    var n = photosOf(state.album).length;
    els.albumCounter.textContent = '已载入 ' + state.loaded + ' / ' + n;
    if (state.loaded >= n) els.gridStat.textContent = '已全部载入 ' + n + ' 张';
    else els.gridStat.textContent = '已载入 ' + state.loaded + ' / ' + n + ' 张，继续滚动自动追加';
  }

  function makeCell(album, p) {
    var cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell';
    cell.setAttribute('data-i', String(p.i));
    cell.title = '第 ' + (p.i + 1) + ' 张 · ' + fileName(p.rel);
    var img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = fileName(p.rel);
    img.addEventListener('error', function () { cell.classList.add('broken'); }, { once: true });
    img.src = thumbUrl(album.id, p.i);
    cell.appendChild(img);
    if (p.big) {
      var b = document.createElement('span');
      b.className = 'cellBig';
      b.textContent = '大图';
      cell.appendChild(b);
    }
    cell.addEventListener('click', function () { openLightbox(p.i); });
    return cell;
  }

  function appendBatch() {
    var alb = state.album;
    var ps = photosOf(alb);
    var n = ps.length;
    if (!n || state.loaded >= n) return;
    var r = batchRange(n, state.batch, BATCH);
    var frag = document.createDocumentFragment();
    for (var i = r.start; i < r.end; i += 1) frag.appendChild(makeCell(alb, ps[i]));
    els.grid.appendChild(frag);
    state.batch += 1;
    state.loaded = r.end;
    updateCounter();
  }

  function ensureLoaded(idx) {
    var n = photosOf(state.album).length;
    var guard = 0;
    while (state.loaded <= idx && state.loaded < n && guard < 200) { appendBatch(); guard += 1; }
  }

  function focusCell(idx) {
    var cell = els.grid.querySelector('[data-i="' + idx + '"]');
    if (!cell) return;
    cell.scrollIntoView({ block: 'center' });
    cell.classList.add('located');
    setTimeout(function () { cell.classList.remove('located'); }, 2200);
    updateMemory(idx);
  }

  function topVisibleIndex() {
    var cells = els.grid.children;
    if (!cells.length) return -1;
    var bar = els.albumBar.getBoundingClientRect().bottom + 4;
    var lo = 0, hi = cells.length - 1, ans = cells.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (cells[mid].getBoundingClientRect().bottom > bar) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return Number(cells[ans].getAttribute('data-i'));
  }

  function updateMemory(i) {
    if (!state.album || i == null || i < 0) return;
    lsSet(memoryKey(state.album.id), String(i));
  }

  function onGridScroll() {
    clearTimeout(state.scrollTimer);
    state.scrollTimer = setTimeout(function () {
      if (!state.album || state.lbOpen) return;
      var i = topVisibleIndex();
      if (i >= 0) updateMemory(i);
    }, 180);
  }

  // ---- 路由 ----

  // hash 与 UI 状态单向同步；用 replaceState，翻页不会把浏览历史刷爆
  function syncHash(index) {
    if (!state.album) return;
    var h = (index == null) ? routeHash(state.album.id) : routeHash(state.album.id, index);
    if (location.hash === h) return;
    try { history.replaceState(null, '', h); }
    catch (_) { location.hash = h; }
  }

  function openAlbum(id, startIndex) {
    var token = ++state.openToken;
    var card = state.albums.find(function (a) { return a.id === id; });
    if (!card) { fatal('相册不存在：' + id); location.hash = wallHash(); return; }
    if (els.albumView.hidden) state.wallScroll = window.scrollY || 0;  // 只在离开相册墙时记录滚动位置

    var go = function (album) {
      if (token !== state.openToken) return;
      state.album = album;
      els.wallView.hidden = true;
      els.albumView.hidden = false;
      els.albumTitle.textContent = album.title;
      els.albumCrumb.textContent = (album.folder || '') + (album.dir ? ' · ' + album.dir : '');
      els.jumpInput.value = '';
      els.grid.textContent = '';
      state.batch = 0;
      state.loaded = 0;
      var n = photosOf(album).length;
      updateCounter();
      appendBatch();
      document.title = album.title + ' · 图片站';
      track('album_view', 'album', album.id, 0);   // 埋点：进入册视图（深链进入同样计一次）
      window.scrollTo(0, 0);
      if (startIndex != null) {
        // 深链 #album=<id>&i=<n>：直接定位并打开第 n 张的 lightbox
        var lbIndex = clampIndex(startIndex, n);
        ensureLoaded(lbIndex);
        requestAnimationFrame(function () { openLightbox(lbIndex); });
        return;
      }
      var mem = parseStoredIndex(lsGet(memoryKey(album.id)), n);
      if (mem >= 0) {
        ensureLoaded(mem);
        requestAnimationFrame(function () { focusCell(mem); });
      }
    };

    if (Array.isArray(card.photos) && card.photos.length === card.count) { go(card); return; }
    fetch(MEDIA + '/album/' + encodeURIComponent(id), { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(go)
      .catch(function (e) { fatal('相册数据加载失败：' + e.message); });
  }

  function backToWall(refresh) {
    state.openToken += 1;
    state.album = null;                    // 先清册，closeLightbox 才不会把 hash 写回 #album=
    if (state.lbOpen) closeLightbox();
    els.albumView.hidden = true;
    els.grid.textContent = '';
    els.wallView.hidden = false;
    document.title = '图片站 · 相册';
    if (refresh !== false) renderWall(true);   // 全部图片视图下按 flatKeep 补回批次
    requestAnimationFrame(function () { window.scrollTo(0, state.wallScroll || 0); });
  }

  function onRoute() {
    var r = parseRoute(location.hash);
    if (r.view !== 'album') {
      var want = matchPerson(r.person);
      var changed = want !== state.person;
      state.person = want;
      var v = routeView(location.hash);       // hash 显式带 v= 时以 hash 为准（分享链接）
      var viewChanged = false;
      if (v && v !== state.view) {
        state.view = v;
        lsSet(VIEW_KEY, v);
        syncSeg();
        applySortOptions();
        viewChanged = true;
      }
      var fs = routeFlatSort(location.hash);  // 同理：hash 里的 fs= 优先
      var fsChanged = false;
      if (fs && fs !== state.flatSort) {
        state.flatSort = fs;
        lsSet(FLATSORT_KEY, fs);
        applySortOptions();
        fsChanged = true;
      }
      syncChips();
      if (!els.albumView.hidden) backToWall(true);
      else if (changed || viewChanged || fsChanged) renderWall(viewChanged || fsChanged);
      writeRoute();   // 墙面 hash 始终带上两个排序段、视图与单图排序
      return;
    }
    // 已在该册：只切换 lightbox，不重建网格（否则自身改写的 hash 会打断深链）
    if (state.album && state.album.id === r.albumId && !els.albumView.hidden) {
      if (r.index != null) {
        var idx = clampIndex(r.index, photosOf(state.album).length);
        ensureLoaded(idx);
        openLightbox(idx);
      } else if (state.lbOpen) {
        closeLightbox();
      }
      return;
    }
    openAlbum(r.albumId, r.index);
  }

  // ---- lightbox ----

  function applyTransform() {
    els.lbImg.style.transform = 'translate3d(' + state.px + 'px,' + state.py + 'px,0) scale(' + state.zoom + ')';
    els.zoomInfo.textContent = Math.round(state.zoom * 100) + '%';
  }

  function resetTransform() {
    state.zoom = 1; state.px = 0; state.py = 0;
    applyTransform();
  }

  function showError(msg, kind) {
    state.retryKind = kind || 'image';
    els.lbErrMsg.textContent = msg;
    els.lbError.hidden = false;
    els.lbLoading.hidden = true;
  }

  function loadImage(url) {
    state.imgLoaded = false;
    els.lbError.hidden = true;
    els.lbLoading.hidden = true;
    clearTimeout(state.spinTimer);
    state.spinTimer = setTimeout(function () {
      if (!state.imgLoaded) { els.lbLoadMsg.textContent = '加载中…'; els.lbLoading.hidden = false; }
    }, 250);
    els.lbImg.src = url;
  }

  function setOrigButton(p) {
    els.origBtn.hidden = !p.big;
    els.origBtn.disabled = false;
    els.origBtn.textContent = '原图';
    els.origBtn.classList.remove('done');
  }

  function loadOriginal() {
    var p = photoAt(state.album, state.lbIndex);
    if (!p || !p.big) return;
    var url = mediaUrl(p.rel);
    els.origBtn.disabled = true;
    els.origBtn.textContent = '加载中…';
    els.lbLoadMsg.textContent = '正在加载原图（大文件，请稍候）…';
    els.lbLoading.hidden = false;
    els.lbError.hidden = true;
    var probe = new Image();
    var finished = false;
    var finish = function (ok) {
      if (finished) return;
      finished = true;
      els.lbLoading.hidden = true;
      els.origBtn.disabled = false;
      if (ok) {
        state.imgLoaded = true;
        els.lbImg.src = url;   // 已进缓存，直接切换
        resetTransform();
        els.origBtn.textContent = '原图已载入';
        els.origBtn.classList.add('done');
        els.origBtn.disabled = true;
      } else {
        els.origBtn.textContent = '重试原图';
        showError('原图加载失败（文件可能损坏或过大）', 'orig');
      }
    };
    probe.onload = function () {
      probe.onload = null; probe.onerror = null;
      try { probe.src = ''; } catch (_) { /* ignore */ }
      finish(true);
    };
    probe.onerror = function () { probe.onerror = null; finish(false); };
    probe.src = url;
  }

  function preloadAround(i) {
    var n = photosOf(state.album).length;
    if (preloaded.size > 240) preloaded.clear();
    [1, 2, -1, -2].forEach(function (d) {
      var j = i + d;
      if (j < 0 || j >= n) return;
      var url = photoUrl(state.album, j);
      if (!url || preloaded.has(url)) return;
      preloaded.add(url);
      preloadLimit(function (done) {
        var im = new Image();
        im.onload = done;
        im.onerror = done;
        im.src = url;
      });
    });
  }

  function syncLbFav() {
    if (!els.lbFav) return;
    var it = state.album ? favItemOf(state.album, state.lbIndex) : null;
    els.lbFav.classList.toggle('on', it ? photoFav(it) : false);
  }

  function showPhoto(i) {
    var alb = state.album;
    var ps = photosOf(alb);
    var n = ps.length;
    if (!n) return;
    i = clampIndex(i, n);
    state.lbIndex = i;
    resetTransform();
    var p = ps[i];
    els.lbCount.textContent = (i + 1) + ' / ' + n;
    track('photo_click', 'photo', alb.id + ':' + i, 0);   // 埋点：大图显示某张图（翻页/深链同样计一次，序号 0 基）
    els.lbName.textContent = fileName(p.rel);
    setOrigButton(p);
    els.lbPrev.classList.toggle('off', i === 0);
    els.lbNext.classList.toggle('off', i === n - 1);
    loadImage(photoUrl(alb, i));
    updateMemory(i);
    syncLbFav();
    if (state.lbOpen) syncHash(i);   // 翻页同步深链 #album=<id>&i=<i>
    preloadAround(i);
  }

  function step(delta) {
    var n = photosOf(state.album).length;
    showPhoto(delta > 0 ? nextIndex(state.lbIndex, n) : prevIndex(state.lbIndex, n));
  }

  function openLightbox(i) {
    if (!state.album) return;
    state.lbOpen = true;
    els.lb.hidden = false;
    document.body.classList.add('lb-open');
    showPhoto(i);
    pushRecentPhoto();   // 打开即上报最近浏览（组件未就绪时静默）
    els.lbClose.focus();
  }

  function closeLightbox() {
    state.lbOpen = false;
    els.lb.hidden = true;
    document.body.classList.remove('lb-open');
    clearTimeout(state.spinTimer);
    els.lbImg.removeAttribute('src');
    els.lbLoading.hidden = true;
    els.lbError.hidden = true;
    resetTransform();
    syncHash(null);   // Esc/关闭 → 退回 #album=<id>
  }

  function toggleZoom() {
    if (!els.lbImg.naturalWidth) return;
    if (state.zoom > 1.05) { resetTransform(); return; }
    var rendered = els.lbImg.clientWidth || 1;
    state.zoom = clampZoom(els.lbImg.naturalWidth / rendered);
    state.px = 0; state.py = 0;
    applyTransform();
  }

  // ---- 启动 ----

  function boot() {
    els = {
      wallView: byId('wallView'), albumView: byId('albumView'),
      q: byId('q'), sort: byId('sort'), psort: byId('psort'), chips: byId('chips'),
      wallStat: byId('wallStat'), wall: byId('wall'), wallEmpty: byId('wallEmpty'),
      albumBar: byId('albumBar'), albumTitle: byId('albumTitle'), albumCrumb: byId('albumCrumb'),
      albumCounter: byId('albumCounter'), jumpInput: byId('jumpInput'), jumpBtn: byId('jumpBtn'),
      grid: byId('grid'), sentinel: byId('sentinel'), gridStat: byId('gridStat'),
      flat: byId('flat'), flatSentinel: byId('flatSentinel'),
      segGroup: byId('segGroup'), segFlat: byId('segFlat'), profileSlot: byId('profileSlot'),
      lbFav: byId('lbFav'),
      lb: byId('lb'), lbCount: byId('lbCount'), lbName: byId('lbName'), lbClose: byId('lbClose'),
      lbStage: byId('lbStage'), lbImg: byId('lbImg'), lbLoading: byId('lbLoading'),
      lbLoadMsg: byId('lbLoadMsg'), lbError: byId('lbError'), lbErrMsg: byId('lbErrMsg'),
      lbRetry: byId('lbRetry'), lbPrev: byId('lbPrev'), lbNext: byId('lbNext'),
      origBtn: byId('origBtn'), zoomInfo: byId('zoomInfo'), fatal: byId('fatal')
    };

    var qTimer = 0;
    captureAlbumOpts();
    els.segGroup.addEventListener('click', function () { setView('group'); });
    els.segFlat.addEventListener('click', function () { setView('flat'); });
    els.lbFav.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!state.album) return;
      togglePhotoFav(favItemOf(state.album, state.lbIndex), els.lbFav);
    });
    els.q.addEventListener('input', function () {
      clearTimeout(qTimer);
      qTimer = setTimeout(function () { state.q = els.q.value; renderWall(false); }, 140);
    });
    els.sort.addEventListener('change', function () {
      if (state.view === 'flat') { setFlatSort(els.sort.value); return; }
      state.sort = normSort(els.sort.value, SORT_ALBUMS, SORT_ALBUM_DEF);
      els.sort.value = state.sort;
      renderWall();
      writeRoute();
    });
    els.psort.addEventListener('change', function () {
      state.psort = normSort(els.psort.value, SORT_PEOPLE, SORT_PEOPLE_DEF);
      els.psort.value = state.psort;
      applyPeopleSort();
      buildChips();
      renderWall(false);
      writeRoute();
    });

    // 列数变了才重排（手机地址栏伸缩只改高度，不触发）；全部图片视图靠 CSS 网格自动重排，不必重建
    state.viewW = window.innerWidth;
    window.addEventListener('resize', function () {
      clearTimeout(state.resizeTimer);
      state.resizeTimer = setTimeout(function () {
        if (window.innerWidth === state.viewW) return;
        state.viewW = window.innerWidth;
        if (!els.wallView.hidden && state.view !== 'flat') renderWall();
      }, 220);
    });

    els.jumpBtn.addEventListener('click', doJump);
    els.jumpInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doJump(); }
    });

    els.grid.addEventListener('scroll', onGridScroll, true);
    window.addEventListener('scroll', onGridScroll, { passive: true });

    if ('IntersectionObserver' in window) {
      var sentinelIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting || !state.album) return;
          if (state.loaded < photosOf(state.album).length) appendBatch();
        });
      }, { rootMargin: '600px 0px', threshold: 0 });
      sentinelIO.observe(els.sentinel);

      var flatIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          if (state.view !== 'flat' || els.wallView.hidden) return;
          if (state.flatLoaded < state.flatItems.length) appendFlat();
        });
      }, { rootMargin: '600px 0px', threshold: 0 });
      flatIO.observe(els.flatSentinel);
    } else {
      window.addEventListener('scroll', function () {
        if (state.album) {
          if (window.innerHeight + window.scrollY > document.body.scrollHeight - 800) appendBatch();
          return;
        }
        if (state.view === 'flat' && state.flatLoaded < state.flatItems.length &&
            window.innerHeight + window.scrollY > document.body.scrollHeight - 800) appendFlat();
      }, { passive: true });
    }

    els.lbClose.addEventListener('click', closeLightbox);
    els.lbPrev.addEventListener('click', function (e) { e.stopPropagation(); step(-1); });
    els.lbNext.addEventListener('click', function (e) { e.stopPropagation(); step(1); });
    els.lbRetry.addEventListener('click', function () {
      if (state.retryKind === 'orig') loadOriginal();
      else showPhoto(state.lbIndex);
    });
    els.origBtn.addEventListener('click', loadOriginal);

    els.lbImg.addEventListener('load', function () {
      state.imgLoaded = true;
      clearTimeout(state.spinTimer);
      els.lbLoading.hidden = true;
      els.lbError.hidden = true;
    });
    els.lbImg.addEventListener('error', function () {
      if (!els.lbImg.getAttribute('src')) return;
      clearTimeout(state.spinTimer);
      var p = photoAt(state.album, state.lbIndex);
      showError('图片加载失败：' + (p ? fileName(p.rel) : '') + '（缩略图/原图可能缺失）', 'image');
    });

    els.lbStage.addEventListener('wheel', function (e) {
      if (!state.lbOpen) return;
      e.preventDefault();
      var rect = els.lbStage.getBoundingClientRect();
      var cx = e.clientX - rect.left - rect.width / 2;
      var cy = e.clientY - rect.top - rect.height / 2;
      var old = state.zoom;
      var nz = clampZoom(old * Math.exp(-e.deltaY * 0.0015));
      if (nz === old) return;
      var k = nz / old;
      state.px = cx - (cx - state.px) * k;
      state.py = cy - (cy - state.py) * k;
      state.zoom = nz;
      applyTransform();
    }, { passive: false });

    els.lbStage.addEventListener('dblclick', function () { toggleZoom(); });

    var drag = null;
    els.lbStage.addEventListener('pointerdown', function (e) {
      if (!state.lbOpen || e.button > 0) return;
      drag = { x: e.clientX, y: e.clientY, px: state.px, py: state.py, moved: false, id: e.pointerId };
      try { els.lbStage.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    });
    els.lbStage.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (state.zoom <= 1.05) return;   // 适应窗口档位上不做平移，横向位移留给滑动翻页
      state.px = drag.px + dx;
      state.py = drag.py + dy;
      applyTransform();
    });
    var endDrag = function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      var wasMoved = drag.moved;
      drag = null;
      // 缩放档下拖动是平移；适应窗口时横向滑动翻页
      if (state.zoom <= 1.05 && wasMoved && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        resetTransform();
        step(dx < 0 ? 1 : -1);
      }
    };
    els.lbStage.addEventListener('pointerup', endDrag);
    els.lbStage.addEventListener('pointercancel', function () { drag = null; });

    document.addEventListener('keydown', function (e) {
      if (state.lbOpen) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
        else if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
        return;
      }
      if (e.key === 'Escape' && !els.albumView.hidden) { location.hash = wallHash(); }
    });

    els.wall.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button.pmore, button.ptoggle') : null;
      if (!b) return;
      var name = b.getAttribute('data-person') || '';
      if (!name) return;
      if (b.classList.contains('pmore')) expandGroup(name);
      else collapseGroup(name, openState(name) !== 'off');
    });

    window.addEventListener('hashchange', onRoute);

    var hv = routeView(location.hash);
    state.view = hv || (lsGet(VIEW_KEY) === 'flat' ? 'flat' : 'group');
    state.flatSort = routeFlatSort(location.hash) || normFlatSort(lsGet(FLATSORT_KEY));
    lsSet(VIEW_KEY, state.view);            // hash 里带来的视图/单图排序同样落到本地，下次无 hash 也能保持
    lsSet(FLATSORT_KEY, state.flatSort);
    syncSeg();
    if (!mountProfile()) {
      document.addEventListener('DOMContentLoaded', mountProfile);
      window.addEventListener('load', mountProfile);
      [200, 800, 2500].forEach(function (t) { setTimeout(mountProfile, t); });
    }

    initSorts();
    applySortOptions();   // 视图决定 #sort 显示哪 6/7 项，并选中当前值
    initTracking();       // 埋点：page_view + toolVisit 各报一次，并挂载 pagehide/visibilitychange
    loadIndex(true);
  }

  // 自测用只读探针（CDP 里读渲染状态，不写任何数据）
  window.__msPhoto = function () {
    return {
      view: state.view, persons: state.person, q: state.q, flatSort: state.flatSort,
      albumSort: state.sort, psort: state.psort,
      total: state.flatItems.length, loaded: state.flatLoaded, batch: state.flatBatch,
      cells: els.flat ? els.flat.children.length : 0,
      album: state.album ? state.album.id : null, lbOpen: state.lbOpen, lbIndex: state.lbIndex
    };
  };

  function hasPeopleData(data) {
    if (!data) return false;
    if (Array.isArray(data.people) && data.people.length) return true;
    return Array.isArray(data.albums) && data.albums.some(function (a) {
      return a && typeof a.person === 'string' && a.person.trim() !== '';
    });
  }

  function applyIndex(data) {
    state.albums = (data && Array.isArray(data.albums)) ? data.albums : [];
    state.peopleBase = resolvePeople(state.albums, data && data.people);
    state.dataComplete = hasPeopleData(data);
    buildPersonOf();
    applyPeopleSort();
  }

  function applyPeopleSort() {
    state.people = sortPeople(state.peopleBase, state.psort, { rank: randRank });
  }

  // hash 里没有排序段时，从非随机候选里各随机挑一个（首次访问换口味），并写回 hash
  function initSorts() {
    var h = String(location.hash || '').replace(/^#/, '').replace(/^\/+/, '');
    var p = parseHashParams(h);
    var hasS = Object.prototype.hasOwnProperty.call(p, 's');
    var hasP = Object.prototype.hasOwnProperty.call(p, 'p');
    var s = normSort(p.s, SORT_ALBUMS, SORT_ALBUM_DEF);
    var ps = normSort(p.p, SORT_PEOPLE, SORT_PEOPLE_DEF);
    if (!hasS && !hasP) {
      s = pickOne(PICK_ALBUMS);
      ps = pickOne(PICK_PEOPLE);
    }
    state.sort = s;
    state.psort = ps;
    if (els.sort) els.sort.value = s;
    if (els.psort) els.psort.value = ps;
  }

  function loadIndex(first) {
    fetch(MEDIA + '/index' + (first ? '' : '?t=' + Date.now()), {
      headers: { Accept: 'application/json' }, cache: 'no-store'
    })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        applyIndex(data);
        if (!state.albums.length) { fatal('data/index.json 里没有相册'); return; }
        buildChips();
        renderWall();
        onRoute();
        if (!state.dataComplete) watchPeople();
      })
      .catch(function (e) { if (first) fatal('无法加载 /api/media/index：' + e.message); });
  }

  // index.json 可能稍后才补上 people/person：每 20 秒探一次，最多 12 分钟；出现后整墙切到真数据
  var PEOPLE_WATCH_ROUNDS = 36;
  function watchPeople() {
    if (state.watchRounds >= PEOPLE_WATCH_ROUNDS) return;
    state.watchRounds += 1;
    setTimeout(function () {
      fetch(MEDIA + '/index?t=' + Date.now(), { headers: { Accept: 'application/json' }, cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (data) {
          if (!hasPeopleData(data)) { watchPeople(); return; }
          applyIndex(data);
          buildChips();
          renderWall();
          onRoute();
        })
        .catch(function () { watchPeople(); });
    }, 20000);
  }

  function doJump() {
    if (!state.album) return;
    var n = photosOf(state.album).length;
    var idx = parseJump(els.jumpInput.value, n);
    if (idx < 0) {
      els.jumpInput.classList.add('bad');
      setTimeout(function () { els.jumpInput.classList.remove('bad'); }, 900);
      return;
    }
    ensureLoaded(idx);
    focusCell(idx);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
