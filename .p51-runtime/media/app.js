'use strict';

/* 后端媒体接口前缀：旧 Node 版的 /api、/media、/thumb 全部收敛到这一处，改后端只需改这里 */
const API = '/api/media';

/* =========================================================================
   事件上报（埋点）：只上报，不参与任何渲染/播放决策；内部异常一律吞掉，
   保证埋点出问题也不影响页面。接口匿名，前端不处理响应。
   POST /api/media/track  —— 行为事件
   POST /api/toolVisit/add —— 工具级访问计数（媒体站在 tool_info 里的 id 是 4）
   ========================================================================= */

const TOOL_ID = 4;
const TRACK_URL = API + '/track';
const TOOL_VISIT_URL = '/api/toolVisit/add';
const OWNER_STORE_KEY = 'ms.owner';   // 与 profile.js 共用的身份键

// 设备标识：优先 localStorage['ms.owner']（profile.js 的落盘位置），退回同名 cookie；取不到传空
function trackOwner() {
  try {
    const v = window.localStorage.getItem(OWNER_STORE_KEY);
    if (v) return v;
  } catch (e) { /* 无痕模式可能抛错 */ }
  try {
    const m = /(?:^|;\s*)ms\.owner=([^;]*)/.exec(document.cookie || '');
    if (m) return decodeURIComponent(m[1]);
  } catch (e) { /* 忽略 */ }
  return '';
}

// 非阻塞 JSON POST：sendBeacon 优先（页面卸载时也能送达），否则 fetch keepalive；失败静默
function postJson(url, payload) {
  try {
    const body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(url, blob)) return;
    }
    fetch(url, {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json' }, body: body,
    }).catch(() => { /* 失败静默 */ });
  } catch (e) { /* 上报失败不影响页面 */ }
}

// 统一的事件上报入口；progress 为可选的 0–100 整数百分比（仅 play_end 使用，其它事件传 0 或不传）
function track(eventType, targetType, targetKey, valueNum, progress) {
  try {
    postJson(TRACK_URL, {
      eventType: eventType,
      targetType: targetType,
      targetKey: String(targetKey == null ? '' : targetKey),
      ownerKey: trackOwner(),
      valueNum: Math.max(0, Math.round(Number(valueNum) || 0)),
      progress: Math.min(100, Math.max(0, Math.round(Number(progress) || 0))),
    });
  } catch (e) { /* 忽略 */ }
}

const tkPage = { loaded: false, visStart: 0, visMs: 0 };        // 页面级：page_view 只报一次 + 可见毫秒
// 播放级：id/sessId/sessKey 标识「播放器会话」，reported 标记本会话是否已报过 play，ms 为累计毫秒
const tkPlay = { id: '', sessId: '', sessKey: '', reported: false, ms: 0, clockAt: 0, running: false };
let tkPlaySessNo = 0;   // 播放器会话序号，仅在 openPlayer 里自增

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
  const ms = tkPage.visMs;
  tkPage.visMs = 0;
  if (ms > 0) track('dwell', 'page', location.pathname, ms);
}

// 观看计时起表（时间戳差累计，避免 timeupdate 的跳变误差）
function tkPlayClockStart() {
  if (tkPlay.running) return;
  tkPlay.clockAt = Date.now();
  tkPlay.running = true;
}

// 开一个新播放器会话：openPlayer 是「打开播放器」的唯一入口（点卡片、上一个/下一个、深链都走它），
// 换源/切清晰度只改 el.video.src，不会经过这里，因此同一会话内只可能报一次 play
function tkPlayOpenSession(id) {
  tkPlaySessNo += 1;
  tkPlay.sessId = id;
  tkPlay.sessKey = id + '#' + tkPlaySessNo;
  tkPlay.reported = false;
}

// 完播率百分比：absPos() 已处理转码 offset，contentDur() 已处理时长口径；取不到时长按 0
function tkPlayProgress() {
  try {
    const dur = contentDur(el.video);
    if (!(dur > 0)) return 0;
    const pct = absPos(el.video) / dur * 100;
    if (!isFinite(pct)) return 0;
    return Math.min(100, Math.max(0, Math.round(pct)));
  } catch (e) { return 0; }
}

// 结算本次观看：停表 → >0 才报 play_end（带进度百分比）→ 清空累计
function tkPlayEnd() {
  if (tkPlay.running) { tkPlay.ms += Math.max(0, Date.now() - tkPlay.clockAt); tkPlay.running = false; }
  try {
    if (tkPlay.ms > 0 && tkPlay.id) track('play_end', 'video', tkPlay.id, tkPlay.ms, tkPlayProgress());
  } catch (e) { /* 忽略 */ }
  tkPlay.ms = 0;
  tkPlay.id = '';
}

// 视频开始播放：play 只在本会话首次消费时上报（暂停恢复、换源重播一律不新增），随后起表
function tkPlayStart() {
  const id = curVideo ? curVideo.id : '';
  if (!id) return;
  if (tkPlay.id !== id) {
    tkPlayEnd();                                       // 结算上一段（正常已由 pause 结算，这里兜底换源/切片的空档）
    tkPlay.id = id;
    if (tkPlay.sessId !== id) tkPlayOpenSession(id);    // 兜底：没有会话时补一个（异常/深链路径）
  }
  if (!tkPlay.reported) { tkPlay.reported = true; track('play', 'video', id, 0, 0); }
  tkPlayClockStart();
}

// 离开/隐藏：先结算观看时长再结算停留时长（pagehide 与 visibilitychange 都会到，第二次因计数清零而跳过）
function tkPageHide() {
  tkPlayEnd();
  tkDwellFlush();
}

// 页面加载后调用一次：注册卸载/可见性监听并上报打开事件
function initTracking() {
  window.addEventListener('pagehide', tkPageHide);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { tkPageHide(); return; }
    if (!tkPage.visStart) tkPage.visStart = Date.now();   // 重新可见：接着累计
  });
  tkPageOpen();
}

/* =========================================================================
   纯函数区：无 DOM 依赖，Node 下可直接 require 做逻辑自测
   （文件末尾有 module.exports）
   ========================================================================= */

const MB = 1048576, GB = 1073741824;

const DUR_BUCKETS = [
  { key: 'lt1', label: '<1 分', max: 60 },
  { key: '1-5', label: '1-5 分', max: 300 },
  { key: '5-15', label: '5-15 分', max: 900 },
  { key: '15-60', label: '15-60 分', max: 3600 },
  { key: 'gt60', label: '>60 分', max: Infinity },
];

// 互斥档位：≥4K / 2K / 1080p / 720p / 更低（按 w 判定，五档之和 = 全库）
const RES_TIERS = [
  { key: '4k', label: '≥4K', min: 3840 },
  { key: '2k', label: '2K', min: 2560 },
  { key: '1080', label: '1080p', min: 1920 },
  { key: '720', label: '720p', min: 1280 },
  { key: 'low', label: '更低', min: 0 },
];

const SIZE_BUCKETS = [
  { key: 'lt100m', label: '<100MB', max: 100 * MB },
  { key: '100m-1g', label: '100MB-1GB', max: GB },
  { key: 'gt1g', label: '>1GB', max: Infinity },
];

const SORTS = [
  { key: 'added', label: '添加序（默认）' },
  { key: 'name', label: '名称 A→Z' },
  { key: 'name-desc', label: '标题 Z→A' },
  { key: 'dur-desc', label: '时长 ↓' },
  { key: 'dur-asc', label: '时长 ↑' },
  { key: 'size-desc', label: '体积 ↓' },
  { key: 'size-asc', label: '体积 ↑' },
  { key: 'res-desc', label: '分辨率 高→低' },
  { key: 'res-asc', label: '分辨率 低→高' },
  { key: 'recent', label: '最近观看' },
  { key: 'progress', label: '有进度优先' },
  { key: 'random', label: '🎲 随机排序' },
];
const SORT_RANDOM = 'random';
// 刷新时随机挑排序的候选：随机本身排除（否则无法「刷新后保持」）
const SORT_POOL = SORTS.filter(s => s.key !== SORT_RANDOM).map(s => s.key);

const KEY_POS = 'ms.pos.';
const KEY_RECENT = 'ms.recent';
const KEY_RECENT_CLOSED = 'ms.recentClosed';
const KEY_COLS = 'ms.cols';
const KEY_SCROLL = 'ms.scroll';
const KEY_Q = 'ms.q';

function durBucketOf(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return null;
  for (const b of DUR_BUCKETS) if (sec < b.max) return b.key;
  return 'gt60';
}

function resTierOf(w) {
  if (w == null || !isFinite(w) || w <= 0) return null;
  for (const t of RES_TIERS) if (w >= t.min) return t.key;
  return 'low';
}

function sizeBucketOf(bytes) {
  if (bytes == null || !isFinite(bytes) || bytes < 0) return null;
  for (const b of SIZE_BUCKETS) if (bytes < b.max) return b.key;
  return 'gt1g';
}

function resBadge(w) {
  if (!w) return '';
  if (w >= 3840) return '4K';
  if (w >= 2560) return '2K';
  if (w >= 1920) return '1080p';
  if (w >= 1280) return '720p';
  return w + 'w';
}

function fmtDur(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return '--:--';
  const t = Math.round(sec), m = Math.floor(t / 60), s = t % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function fmtSize(bytes) {
  if (bytes == null || !isFinite(bytes)) return '—';
  if (bytes >= GB) return (bytes / GB).toFixed(2) + ' GB';
  if (bytes >= MB) return (bytes / MB).toFixed(1) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

function matchesSearch(v, q) {
  const needle = String(q == null ? '' : q).trim().toLowerCase();
  if (!needle) return true;
  if (v.title && String(v.title).toLowerCase().indexOf(needle) >= 0) return true;
  for (const t of v.tags || []) {
    if (t && t[1] != null && String(t[1]).toLowerCase().indexOf(needle) >= 0) return true;
  }
  for (const a of v.actors || []) {
    if (a != null && String(a).toLowerCase().indexOf(needle) >= 0) return true;
  }
  return false;
}

function matchesFacets(v, facets) {
  const keys = Object.keys(facets || {});
  for (const f of keys) {
    const names = facets[f];
    if (!names || !names.length) continue;
    if (f === '演员') {
      const own = v.actors || [];
      let hit = false;
      for (const a of own) if (names.indexOf(a) >= 0) { hit = true; break; }
      if (!hit) return false;
    } else {
      let hit = false;
      for (const t of v.tags || []) {
        if (t && t[0] === f && names.indexOf(t[1]) >= 0) { hit = true; break; }
      }
      if (!hit) return false;
    }
  }
  return true;
}

// 同 facet 内多值为「或」，跨 facet 为「与」；其余筛选（分类/时长/清晰度/体积/搜索）同为「与」
function filterVideos(videos, st) {
  const s = st || {};
  const cats = s.cats && s.cats.length ? s.cats : null;
  const durs = s.durs && s.durs.length ? s.durs : null;
  const ress = s.ress && s.ress.length ? s.ress : null;
  const sizes = s.sizes && s.sizes.length ? s.sizes : null;
  const out = [];
  for (const v of videos) {
    if (cats && cats.indexOf(v.folder) < 0) continue;
    if (durs && durs.indexOf(durBucketOf(v.dur)) < 0) continue;
    if (ress && ress.indexOf(resTierOf(v.w)) < 0) continue;
    if (sizes && sizes.indexOf(sizeBucketOf(v.size)) < 0) continue;
    if (s.unsafe && v.browserOk !== false) continue;
    if (!matchesSearch(v, s.q)) continue;
    if (!matchesFacets(v, s.facets)) continue;
    out.push(v);
  }
  return out;
}

// 分辨率权重用像素总量 w*h，未探测到（null）返回 null 以便排序时置尾
function resPixels(v) {
  const w = v && v.w, h = v && v.h;
  return (w > 0 && h > 0) ? w * h : null;
}

// 续播百分比：无记录返回 -1，便于「有进度优先」把未看过的排后面
function progressPct(v, pos) {
  if (!v || !pos) return -1;
  const p = pos[v.id];
  if (!(p > 0)) return -1;
  const d = v.dur;
  return d > 0 ? Math.min(1, p / d) : 0;
}

function sortVideos(list, mode, ctx) {
  const a = list.slice();
  const c = ctx || {};
  const byName = (x, y) => String(x.title || '').localeCompare(String(y.title || ''), 'zh-Hans-CN');
  const byNum = (x, y, f, dir) => {
    const vx = x[f] == null ? -Infinity : x[f];
    const vy = y[f] == null ? -Infinity : y[f];
    return dir * (vx - vy) || byName(x, y);
  };
  const byRank = (rank) => (x, y) => {
    const rx = rank.has(x.id) ? rank.get(x.id) : Infinity;
    const ry = rank.has(y.id) ? rank.get(y.id) : Infinity;
    return rx < ry ? -1 : rx > ry ? 1 : 0;
  };
  switch (mode) {
    case 'name': a.sort(byName); break;
    case 'name-desc': a.sort((x, y) => byName(y, x)); break;
    case 'dur-desc': a.sort((x, y) => byNum(x, y, 'dur', -1)); break;
    case 'dur-asc': a.sort((x, y) => byNum(x, y, 'dur', 1)); break;
    case 'size-desc': a.sort((x, y) => byNum(x, y, 'size', -1)); break;
    case 'size-asc': a.sort((x, y) => byNum(x, y, 'size', 1)); break;
    case 'res-desc':
    case 'res-asc': {
      const dir = mode === 'res-desc' ? -1 : 1;
      a.sort((x, y) => {
        const px = resPixels(x), py = resPixels(y);
        if (px == null && py == null) return byNum(x, y, 'dur', -1);
        if (px == null) return 1;            // 未探测到分辨率的一律排末尾
        if (py == null) return -1;
        return dir * (px - py) || byNum(x, y, 'dur', -1);
      });
      break;
    }
    case 'recent': {
      const rank = new Map();
      for (const id of c.recent || []) if (!rank.has(id)) rank.set(id, rank.size);
      a.sort(byRank(rank));                  // 未在最近列表里的都是 Infinity，稳定排序保添加序
      break;
    }
    case 'progress': {
      const pos = c.pos || {};
      a.sort((x, y) => {
        const px = progressPct(x, pos), py = progressPct(y, pos);
        if (px < 0 && py < 0) return 0;
        if (px < 0) return 1;
        if (py < 0) return -1;
        return py - px;
      });
      break;
    }
    case 'random': {
      // 会话内固定：用一次性洗好的 id → 名次表，切筛选不重洗
      if (c.randomRank && typeof c.randomRank.has === 'function') a.sort(byRank(c.randomRank));
      else shuffleInPlace(a);
      break;
    }
    default: break;           // added = 索引原序
  }
  return a;
}

function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function queryVideos(videos, st, ctx) {
  const s = st || {};
  return sortVideos(filterVideos(videos, s), s.sort, ctx);
}

function defaultState() {
  return {
    q: '', cats: [], facets: {}, durs: [], ress: [], sizes: [], unsafe: false,
    sort: 'added', sortPinned: false, play: '',
  };
}

function readJsonList(v) {
  if (!v) return [];
  try {
    const a = JSON.parse(v);
    if (Array.isArray(a)) return a.map(String);
  } catch (e) { /* 忽略损坏的 hash */ }
  return [];
}

function readCsv(v, allowed) {
  if (!v) return [];
  const out = [];
  for (const k of String(v).split(',')) if (k && (!allowed || allowed.indexOf(k) >= 0) && out.indexOf(k) < 0) out.push(k);
  return out;
}

function parseHash(hash) {
  const st = defaultState();
  const raw = String(hash == null ? '' : hash).replace(/^#/, '');
  if (!raw) return st;
  const p = new URLSearchParams(raw);
  const q = p.get('q');
  if (q) st.q = q;
  st.cats = readJsonList(p.get('cat'));
  st.durs = readCsv(p.get('dur'), DUR_BUCKETS.map(b => b.key));
  st.ress = readCsv(p.get('res'), RES_TIERS.map(b => b.key));
  st.sizes = readCsv(p.get('size'), SIZE_BUCKETS.map(b => b.key));
  if (p.get('unsafe') === '1') st.unsafe = true;
  const play = p.get('play');
  if (play) st.play = play;          // 播放深链 /#play=<videoId>
  const sort = p.get('sort');
  if (sort && SORTS.some(s => s.key === sort)) { st.sort = sort; st.sortPinned = true; }
  const f = p.get('f');
  if (f) {
    try {
      const o = JSON.parse(f);
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        for (const k of Object.keys(o)) if (Array.isArray(o[k]) && o[k].length) st.facets[k] = o[k].map(String);
      }
    } catch (e) { /* 忽略 */ }
  }
  return st;
}

function buildHash(st) {
  const s = st || defaultState();
  const p = new URLSearchParams();
  if (s.q) p.set('q', s.q);
  if (s.cats && s.cats.length) p.set('cat', JSON.stringify(s.cats));
  const fk = Object.keys(s.facets || {}).filter(k => (s.facets[k] || []).length);
  if (fk.length) {
    const o = {};
    for (const k of fk) o[k] = s.facets[k];
    p.set('f', JSON.stringify(o));
  }
  if (s.durs && s.durs.length) p.set('dur', s.durs.join(','));
  if (s.ress && s.ress.length) p.set('res', s.ress.join(','));
  if (s.sizes && s.sizes.length) p.set('size', s.sizes.join(','));
  if (s.unsafe) p.set('unsafe', '1');
  if (s.play) p.set('play', s.play);
  // 只有「用户/首屏随机结果固定下来的」排序才写进 hash；清空后不带 sort，刷新重新随机
  if (s.sort && s.sortPinned) p.set('sort', s.sort);
  const qs = p.toString();
  return qs ? '#' + qs : '';
}

// 侧栏 facet → [[值, 计数], …]；分类恒等 folder，演员只取 actors[]（契约 §2.4）
function facetValues(videos, facetOrder) {
  const counts = {};
  const bump = (f, n) => {
    const g = counts[f] || (counts[f] = {});
    g[n] = (g[n] || 0) + 1;
  };
  for (const v of videos) {
    for (const t of v.tags || []) {
      if (!t || t[0] === '分类' || t[0] === '演员') continue;
      bump(t[0], t[1]);
    }
    for (const a of v.actors || []) bump('演员', a);
  }
  const order = [];
  for (const f of facetOrder || []) if (counts[f] && order.indexOf(f) < 0) order.push(f);
  for (const f of Object.keys(counts)) if (order.indexOf(f) < 0) order.push(f);
  const out = {};
  for (const f of order) {
    out[f] = Object.keys(counts[f])
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
      .map(n => [n, counts[f][n]]);
  }
  return out;
}

function folderCounts(videos) {
  const m = {};
  for (const v of videos) m[v.folder] = (m[v.folder] || 0) + 1;
  return m;
}

/* =========================================================================
   浏览器端
   ========================================================================= */

let DATA = { videos: [] };
let FACETS = {};          // facet -> [[name, count], …]
let CATS = [];            // folder -> count
let STATE = null;
let VIEW = [];            // 当前筛选+排序结果
let BY_ID = new Map();
let POS = {};             // id -> 续播秒数
let RECENT = [];
let curId = null;
let curVideo = null;
let pendingSeek = 0;
let lastPosWrite = 0;
let curQ = 'orig';        // 当前清晰度：orig | 720 | 480 | 360
let qSeekDragging = false; // 自绘进度条拖动中，暂停自动跟随
let qFallback = false;     // 转码失败已回退原画，避免错误循环
let streamStart = 0;      // 当前转码流的内容起点（秒）；片内 currentTime 是相对它的偏移
let lastQSrcAt = 0;       // 换源的时刻，用于压掉连发的 seeking
let renderMs = 0;
let lastSig = null;       // 上一次渲染的筛选签名，用于作废旧滚动位置
let lastRecentPush = 0;   // 播放中每 5 秒上报一次最近浏览
let recentMigrated = false;

let el = {};

function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function lsGet(k) {
  try { return localStorage.getItem(k); } catch (e) { return null; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, v); } catch (e) { /* 隐私模式忽略 */ }
}
function lsDel(k) {
  try { localStorage.removeItem(k); } catch (e) { /* 忽略 */ }
}

function loadPosMap() {
  POS = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || k.indexOf(KEY_POS) !== 0) continue;
      const n = parseFloat(localStorage.getItem(k));
      if (isFinite(n) && n > 0) POS[k.slice(KEY_POS.length)] = n;
    }
  } catch (e) { /* 忽略 */ }
}

function readPos(id) {
  const n = parseFloat(lsGet(KEY_POS + id));
  return isFinite(n) && n > 0 ? n : 0;
}
function writePos(id, sec) {
  lsSet(KEY_POS + id, String(Math.max(0, Math.round(sec))));
  POS[id] = Math.max(0, Math.round(sec));
}
function clearPos(id) {
  lsDel(KEY_POS + id);
  delete POS[id];
}

function loadRecent() {
  const raw = lsGet(KEY_RECENT);
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    if (!Array.isArray(a)) return [];
    return a.filter(r => r && typeof r.id === 'string');
  } catch (e) { return []; }
}

function pushRecent(id, pos, dur) {
  const list = RECENT.filter(r => r.id !== id);
  list.unshift({ id: id, t: Date.now(), pos: Math.round(pos * 10) / 10, dur: Math.round(dur * 10) / 10 });
  RECENT = list.slice(0, 50);
  lsSet(KEY_RECENT, JSON.stringify(RECENT));
}

function boot() {
  el = {
    sidebar: $('sidebar'), backdrop: $('backdrop'), drawerBtn: $('drawerBtn'),
    search: $('search'), count: $('count'), sort: $('sort'), clearAll: $('clearAll'),
    durChips: $('durChips'), resChips: $('resChips'), sizeChips: $('sizeChips'),
    unsafeChip: $('unsafeChip'), activeChips: $('activeChips'),
    catChips: $('catChips'), catTotal: $('catTotal'), facetGroups: $('facetGroups'),
    clearSide: $('clearSide'),
    grid: $('grid'), empty: $('empty'),
    recentSec: $('recentSec'), recentStrip: $('recentStrip'), recentClose: $('recentClose'),
    player: $('player'), video: $('video'), pTitle: $('pTitle'), pMeta: $('pMeta'),
    pTags: $('pTags'), pWarn: $('pWarn'), pPrev: $('pPrev'), pNext: $('pNext'),
    pClose: $('pClose'), pRestart: $('pRestart'), pStage: $('pStage'), pTap: $('pTap'),
    pQ: $('pQ'), pQNow: $('pQNow'), pQHint: $('pQHint'),
    pSeekBar: $('pSeekBar'), pSeek: $('pSeek'), pSeekNow: $('pSeekNow'),
    filterToggle: $('filterToggle'), filterPanel: $('filterPanel'),
    quickHead: $('quickHead'), sideScroll: document.querySelector('.side-scroll'),
    colsBtn: $('colsBtn'), pFav: $('pFav'), profileSlot: $('profileSlot'),
  };

  STATE = parseHash(location.hash);
  curQ = loadQ();
  updateQNow();
  if (!STATE.sortPinned) pickRandomSort();   // hash 里没有 sort 段：首屏随机挑一种并固定
  loadPosMap();
  RECENT = loadRecent();

  renderFilterChips();
  renderSortOptions();
  bindEvents();
  placeFilterPanel();
  initCols();
  initProfile();
  renderRecent();
  initTracking();   // 埋点：page_view + toolVisit 各报一次，并挂载 pagehide/visibilitychange

  fetch(API + '/index', { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(idx => {
      DATA.videos = (idx && idx.videos) || [];
      FACETS = facetValues(DATA.videos, (idx && idx.facetOrder) || []);
      CATS = folderCounts(DATA.videos);
      BY_ID = new Map(DATA.videos.map(v => [v.id, v]));
      renderCats();
      renderFacetGroups();
      render();
      restoreScroll();
      renderRecent();
      maybeMigrateRecent();
      openFromHash();
    })
    .catch(err => {
      el.count.textContent = '索引加载失败';
      el.empty.hidden = false;
      el.empty.textContent = '索引加载失败：' + (err && err.message ? err.message : err);
    });
}

/* ---------- 工具栏静态部件 ---------- */

function renderFilterChips() {
  el.durChips.innerHTML = DUR_BUCKETS.map(b =>
    `<button class="chip" type="button" data-k="${b.key}" aria-pressed="false">${esc(b.label)}</button>`).join('');
  el.resChips.innerHTML = RES_TIERS.map(b =>
    `<button class="chip" type="button" data-k="${b.key}" aria-pressed="false">${esc(b.label)}</button>`).join('');
  el.sizeChips.innerHTML = SIZE_BUCKETS.map(b =>
    `<button class="chip" type="button" data-k="${b.key}" aria-pressed="false">${esc(b.label)}</button>`).join('');
}

function renderSortOptions() {
  el.sort.innerHTML = SORTS.map(s => `<option value="${s.key}">${esc(s.label)}</option>`).join('');
}

// 刷新时随机一种排序（随机项本身除外），并固定进 hash：后续刷新保持、不再随机
function pickRandomSort() {
  const k = SORT_POOL[Math.floor(Math.random() * SORT_POOL.length)] || 'added';
  STATE.sort = k;
  STATE.sortPinned = true;
}

/* ---------- 侧栏 ---------- */

function renderCats() {
  const names = Object.keys(CATS).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  el.catTotal.textContent = names.length + ' 个';
  el.catChips.innerHTML = names.map(c => {
    const on = STATE.cats.indexOf(c) >= 0;
    return `<button class="chip${on ? ' on' : ''}" type="button" data-cat="${esc(c)}" aria-pressed="${on}">`
      + `${esc(c)}<em>${CATS[c]}</em></button>`;
  }).join('');
}

function renderFacetGroups() {
  const html = [];
  for (const f of Object.keys(FACETS)) {
    const vals = FACETS[f];
    if (!vals || !vals.length) continue;
    const sel = STATE.facets[f] || [];
    const opts = vals.map(([name, n]) => {
      const on = sel.indexOf(name) >= 0;
      return `<label class="opt${on ? ' on' : ''}" data-name="${esc(name)}">`
        + `<input type="checkbox" value="${esc(name)}"${on ? ' checked' : ''}>`
        + `<span class="opt-t">${esc(name)}</span><em>${n}</em></label>`;
    }).join('');
    html.push(`<details class="fg" data-facet="${esc(f)}"${sel.length ? ' open' : ''}>`
      + `<summary><span class="fg-name">${esc(f)}</span>`
      + `<span class="fg-n" data-total="${vals.length}">${sel.length ? '已选 ' + sel.length + '/' + vals.length : vals.length}</span>`
      + `<span class="fg-caret"></span></summary>`
      + `<input class="fg-search" type="search" placeholder="搜索${esc(f)}…" autocomplete="off" spellcheck="false">`
      + `<div class="fg-list">${opts}</div><div class="fg-none" hidden>无匹配</div></details>`);
  }
  el.facetGroups.innerHTML = html.join('');
}

// 只同步勾选态，不重建 DOM（保住折叠/搜索框状态）
function syncFacetUI() {
  const groups = el.facetGroups.querySelectorAll('details.fg');
  for (const d of groups) {
    const f = d.dataset.facet;
    const sel = STATE.facets[f] || [];
    let n = 0;
    for (const lab of d.querySelectorAll('label.opt')) {
      const on = sel.indexOf(lab.dataset.name) >= 0;
      const cb = lab.querySelector('input');
      if (cb && cb.checked !== on) cb.checked = on;
      lab.classList.toggle('on', on);
      if (on) n++;
    }
    const cnt = d.querySelector('.fg-n');
    if (cnt) {
      const total = +cnt.dataset.total || 0;
      cnt.textContent = n ? '已选 ' + n + '/' + total : String(total);
    }
    if (n && !d.open) d.open = true;
  }
}

/* ---------- 顶部状态 ---------- */

function filterChipState(node, keys) {
  for (const b of node.children) {
    const on = keys.indexOf(b.dataset.k) >= 0;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

function syncToolbar() {
  el.search.value = STATE.q;
  el.sort.value = STATE.sort;
  filterChipState(el.durChips, STATE.durs);
  filterChipState(el.resChips, STATE.ress);
  filterChipState(el.sizeChips, STATE.sizes);
  el.unsafeChip.classList.toggle('on', STATE.unsafe);
  el.unsafeChip.setAttribute('aria-pressed', STATE.unsafe ? 'true' : 'false');
  for (const b of el.catChips.children) {
    const on = STATE.cats.indexOf(b.dataset.cat) >= 0;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

function activeEntries() {
  const out = [];
  if (STATE.q) out.push({ kind: 'q', key: '', label: '搜索：' + STATE.q });
  for (const c of STATE.cats) out.push({ kind: 'cat', key: c, label: c });
  for (const f of Object.keys(STATE.facets)) {
    for (const n of STATE.facets[f]) {
      if (!STATE.facets[f].length) continue;
      out.push({ kind: 'facet', facet: f, name: n, key: '', label: f + '：' + n });
    }
  }
  const lab = (arr, k) => { const x = arr.find(a => a.key === k); return x ? x.label : k; };
  for (const k of STATE.durs) out.push({ kind: 'dur', key: k, label: '时长 ' + lab(DUR_BUCKETS, k) });
  for (const k of STATE.ress) out.push({ kind: 'res', key: k, label: lab(RES_TIERS, k) });
  for (const k of STATE.sizes) out.push({ kind: 'size', key: k, label: '体积 ' + lab(SIZE_BUCKETS, k) });
  if (STATE.unsafe) out.push({ kind: 'unsafe', key: '', label: '⚠ 可能无法播放' });
  return out;
}

function renderActiveChips() {
  const list = activeEntries();
  if (!list.length) { el.activeChips.hidden = true; el.activeChips.innerHTML = ''; return; }
  el.activeChips.hidden = false;
  el.activeChips.innerHTML = list.map(x => {
    const attr = (x.kind === 'facet')
      ? ` data-facet="${esc(x.facet)}" data-name="${esc(x.name)}"`
      : ` data-key="${esc(x.key)}"`;
    return `<button class="chip chip-x" type="button" data-kind="${x.kind}"${attr}>`
      + `${esc(x.label)}<span class="x">×</span></button>`;
  }).join('');
}

/* ---------- 个人组件（收藏 / 最近浏览 / 资料） ---------- */

const FAV_VIDEO = v => ({ kind: 'video', id: v.id, title: v.title, thumb: 'thumbs/v/' + v.id + '.jpg' });

function msProfile() { return typeof window !== 'undefined' ? window.MSProfile : null; }

function isFavVideo(id) {
  const p = msProfile();
  return !!(p && p.isFav({ kind: 'video', id: id }));
}

function initProfile() {
  const p = msProfile();
  if (!p || !el.profileSlot) return;
  p.mount({ slot: el.profileSlot, site: 'video' });
  p.on('change', onProfileChange);
  syncPlayerFav();
}

function onProfileChange(reason) {
  if (reason !== 'recent') syncAllStars();
  if (reason === 'recent' || reason === 'load' || reason === 'fav') renderRecent();
  if (reason === 'load') maybeMigrateRecent();
}

function syncAllStars() {
  for (const card of el.grid.querySelectorAll('.card')) {
    const b = card.querySelector('.card-fav');
    if (!b) continue;
    const on = isFavVideo(card.dataset.id);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.textContent = on ? '★' : '☆';
  }
  syncPlayerFav();
}

function syncPlayerFav() {
  if (!el.pFav) return;
  const on = curVideo ? isFavVideo(curVideo.id) : false;
  el.pFav.classList.toggle('on', on);
  el.pFav.setAttribute('aria-pressed', on ? 'true' : 'false');
  el.pFav.textContent = on ? '★ 已收藏' : '☆ 收藏';
}

function toggleVideoFav(v) {
  const p = msProfile();
  if (!p || !v) return;
  p.toggleFav(FAV_VIDEO(v));
}

// 首次加载：服务端 recent 为空且本地有旧记录 → 一次性迁移（最多 20 条）后清掉本地键
function maybeMigrateRecent() {
  const p = msProfile();
  if (recentMigrated || !p || !p.isReady()) return;
  if (!BY_ID.size) return;          // 索引未就绪前不动手，否则迁移会丢条目
  const local = loadRecent();
  if (!local.length) { recentMigrated = true; return; }
  const srv = (p.get().recent.videos || []);
  if (srv.length) { recentMigrated = true; return; }
  recentMigrated = true;
  const list = local.slice(0, 20);
  list.forEach((r, i) => {
    const v = BY_ID.get(r.id);
    if (!v) return;
    setTimeout(() => {
      p.pushRecent({
        kind: 'video', id: v.id, title: v.title, thumb: 'thumbs/v/' + v.id + '.jpg',
        pos: r.pos || 0, dur: r.dur || v.dur || 0,
      });
    }, i * 120);
  });
  lsDel(KEY_RECENT);
  RECENT = [];
}

/* ---------- 主区渲染 ---------- */

function cardHtml(v) {
  const pos = POS[v.id] || 0;
  const dur = v.dur || 0;
  let prog = '';
  if (pos > 0 && dur > 0) {
    const pct = Math.min(100, pos / dur * 100);
    prog = `<div class="card-prog"><i style="width:${pct.toFixed(2)}%"></i></div>`;
  }
  const badge = resBadge(v.w);
  const fav = isFavVideo(v.id);
  return `<article class="card" data-id="${esc(v.id)}" data-dur="${dur || 0}" tabindex="0">`
    + `<div class="thumb"><img src="${API}/thumb/v/${esc(v.id)}" alt="" loading="lazy" decoding="async">`
    + `<span class="badge badge-dur">${fmtDur(v.dur)}</span>`
    + (badge ? `<span class="badge badge-res">${esc(badge)}</span>` : '')
    + (v.browserOk === false ? '<span class="badge badge-warn" title="HEVC/异常编码，浏览器可能无法播放">⚠</span>' : '')
    + '</div>'
    + `<button class="card-fav${fav ? ' on' : ''}" type="button" data-favid="${esc(v.id)}"`
    + ` aria-pressed="${fav ? 'true' : 'false'}" aria-label="收藏" title="收藏">${fav ? '★' : '☆'}</button>`
    + `<div class="card-body"><h3 title="${esc(v.title)}">${esc(v.title)}</h3>`
    + `<div class="card-sub">${esc(v.folder)} · ${fmtSize(v.size)}</div></div>`
    + prog
    + '</article>';
}

function render() {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  loadPosMap();               // 排序维度依赖续播/最近观看，每次渲染取最新
  RECENT = loadRecent();
  VIEW = queryVideos(DATA.videos, STATE, sortCtx());
  el.grid.innerHTML = VIEW.map(cardHtml).join('');
  el.count.textContent = `显示 ${VIEW.length} / ${DATA.videos.length}`;
  el.empty.hidden = VIEW.length > 0;
  if (el.empty.textContent.indexOf('加载失败') >= 0) el.empty.textContent = '没有符合条件的视频';
  renderActiveChips();
  syncFacetUI();
  syncToolbar();
  writeHash();
  const sig = filterSig();
  if (lastSig !== null && sig !== lastSig) clearScrollMem();
  lastSig = sig;
  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  renderMs = t1 - t0;
  if (typeof console !== 'undefined' && console.debug) {
    console.debug('[render] ' + VIEW.length + ' cards in ' + renderMs.toFixed(1) + 'ms');
  }
}

// 播放层关闭后只更新进度条，避免重建 176 张卡片丢掉懒加载与滚动位置
function refreshProgress() {
  loadPosMap();
  for (const card of el.grid.children) {
    const id = card.dataset.id;
    const pos = POS[id] || 0;
    const dur = +card.dataset.dur || 0;
    let bar = card.querySelector('.card-prog');
    if (pos > 0 && dur > 0) {
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'card-prog';
        bar.innerHTML = '<i></i>';
        card.appendChild(bar);
      }
      bar.firstChild.style.width = Math.min(100, pos / dur * 100).toFixed(2) + '%';
    } else if (bar) {
      bar.remove();
    }
  }
}

// 排序上下文：最近观看顺序 / 续播位置 / 本次会话固定的随机名次
function sortCtx() {
  const ctx = { recent: RECENT.map(r => r.id), pos: POS };
  if (STATE && STATE.sort === SORT_RANDOM) ctx.randomRank = randomRank();
  return ctx;
}

let RAND_RANK = null;
function randomRank() {
  if (RAND_RANK && RAND_RANK.size === DATA.videos.length) return RAND_RANK;
  const ids = shuffleInPlace(DATA.videos.map(v => v.id));
  RAND_RANK = new Map();
  ids.forEach((id, i) => RAND_RANK.set(id, i));
  return RAND_RANK;
}

function writeHash() {
  const h = buildHash(STATE);
  if (location.hash === h) return;
  try {
    history.replaceState(null, '', location.pathname + location.search + h);
  } catch (e) {
    location.hash = h;   // history API 不可用时的兜底
  }
}

/* ---------- 最近观看 ---------- */

// 服务端 recent.videos 为主，localStorage['ms.recent'] 只作离线兜底
function mergedRecent() {
  const out = [];
  const seen = new Set();
  const p = msProfile();
  const srv = (p && p.get().recent.videos) || [];
  const add = (id, pos, dur) => {
    if (!id || seen.has(id)) return;
    const v = BY_ID.get(id);
    if (!v) return;                       // 索引里没有的跳过
    seen.add(id);
    out.push({ id, pos: pos || 0, dur: dur || v.dur || 0 });
  };
  for (const r of srv) add(r.id, r.pos, r.dur);
  for (const r of RECENT) add(r.id, r.pos, r.dur);
  return out;
}

function renderRecent() {
  RECENT = loadRecent();
  const closed = lsGet(KEY_RECENT_CLOSED) === '1';
  const items = mergedRecent();
  if (closed || !items.length) { el.recentSec.hidden = true; return; }
  el.recentSec.hidden = false;
  el.recentStrip.innerHTML = items.map(r => {
    const v = BY_ID.get(r.id);
    const pos = POS[r.id] || r.pos || 0;
    const dur = r.dur || v.dur || 0;
    const pct = dur > 0 ? Math.min(100, pos / dur * 100) : 0;
    return `<button class="rcard" type="button" data-id="${esc(v.id)}" title="${esc(v.title)}">`
      + `<span class="rthumb"><img src="${API}/thumb/v/${esc(v.id)}" alt="" loading="lazy" decoding="async">`
      + `<i class="rprog" style="width:${pct.toFixed(2)}%"></i></span>`
      + `<span class="rtitle">${esc(v.title)}</span></button>`;
  }).join('');
}

// 播放中每 5 秒 / 暂停 / 关闭时把进度上报服务端（失败由组件静默处理）
function pushRecentServer() {
  const p = msProfile();
  if (!p || !curVideo) return;
  const video = el.video;
  const dur = (isFinite(video.duration) && video.duration > 0) ? video.duration : (curVideo.dur || 0);
  const pos = video.currentTime || 0;
  if (!(pos > 0.5)) return;
  lastRecentPush = Date.now();
  p.pushRecent({
    kind: 'video', id: curVideo.id, title: curVideo.title,
    thumb: 'thumbs/v/' + curVideo.id + '.jpg',
    pos: Math.round(pos * 10) / 10, dur: Math.round((dur || 0) * 10) / 10,
  });
}

/* ---------- 播放层 ---------- */

function navListFor(id) {
  const i = VIEW.findIndex(v => v.id === id);
  if (i >= 0) return { list: VIEW, i: i };
  const j = DATA.videos.findIndex(v => v.id === id);
  return { list: DATA.videos, i: j };
}

/* ---------- 清晰度（原画直连 / 实时转码） ---------- */

const Q_VALUES = ['orig', '720', '480', '360'];
const Q_LABELS = { orig: '原画', '720': '720p', '480': '480p', '360': '360p' };
let qHintTimer = 0;

function loadQ() {
  const v = lsGet(KEY_Q);
  return Q_VALUES.indexOf(v) >= 0 ? v : 'orig';
}
function isTranscode() { return curQ !== 'orig'; }
function qLabel(q) { return Q_LABELS[q] || '原画'; }

// 转码流时轴从 0 起（服务端 -ss 重置了 PTS），绝对内容位置 = 流起点 + 片内偏移
function absPos(video) {
  return (isTranscode() ? streamStart : 0) + (video.currentTime || 0);
}

function contentDur(video) {
  const d = video.duration;
  if (!isTranscode() && isFinite(d) && d > 0) return d;
  const v = curVideo || {};
  if (isFinite(v.dur) && v.dur > 0) return v.dur;
  return isFinite(d) && d > 0 ? d : 0;
}

function srcFor(v, startSec) {
  if (!isTranscode()) return API + '/file?p=' + encodeURIComponent(v.rel);
  return API + '/stream?p=' + encodeURIComponent(v.rel) + '&q=' + curQ +
    '&t=' + Math.max(0, Math.floor(startSec || 0));
}

function updateQNow() {
  if (el.pQ) el.pQ.value = curQ;
  if (el.pQNow) el.pQNow.textContent = qLabel(curQ);
  if (el.pSeekBar) el.pSeekBar.hidden = !isTranscode();
  updateQSeek();
}

// 转码流是分段流，seekable 恒为空，原生进度条拖不动：自绘进度条按目标时间重开流
function updateQSeek() {
  if (!el.pSeek || !el.pSeekBar || el.pSeekBar.hidden) return;
  const dur = contentDur(el.video) || 0;
  if (dur > 0) el.pSeek.max = String(Math.round(dur));
  if (!qSeekDragging) el.pSeek.value = String(Math.round(absPos(el.video)));
  if (el.pSeekNow) el.pSeekNow.textContent = fmtDur(absPos(el.video)) + ' / ' + fmtDur(dur);
}

// ←/→：原画走原生跳转；转码流只能从新时间点重开流
function seekRel(delta) {
  if (!curVideo) return;
  const video = el.video;
  if (isTranscode()) {
    const dur = contentDur(video) || 0;
    const target = Math.max(0, Math.min(dur > 0 ? dur : 1e9, absPos(video) + delta));
    const wasPlaying = !video.paused && !video.ended;
    applySource(curVideo, target, 0);
    if (wasPlaying) tryPlay();
    return;
  }
  const d = video.duration;
  const max = isFinite(d) && d > 0 ? d : 1e9;
  video.currentTime = Math.max(0, Math.min(max, (video.currentTime || 0) + delta));
}

function endQHint() {
  if (qHintTimer) { clearTimeout(qHintTimer); qHintTimer = 0; }
  if (el.pQHint) el.pQHint.hidden = true;
}

// 首字节超过 3 秒才提示「转码中…」，避免一闪而过
function beginQHint() {
  endQHint();
  if (!isTranscode() || !el.pQHint) return;
  qHintTimer = setTimeout(() => { el.pQHint.hidden = false; }, 3000);
}

// 换源：absStart 是转码流的内容起点，seekAbs 是加载后要落到的内容位置（0=不跳）
function applySource(v, absStart, seekAbs) {
  streamStart = isTranscode() ? Math.max(0, Math.floor(absStart || 0)) : 0;
  pendingSeek = seekAbs > 0.5 ? seekAbs : 0;
  lastQSrcAt = Date.now();
  el.video.src = srcFor(v, streamStart);
  el.video.load();
  beginQHint();
  updateQNow();
}

function openPlayer(id) {
  const v = BY_ID.get(id) || DATA.videos.find(x => x.id === id);
  if (!v) return;
  if (!el.player.hidden && curVideo && curVideo.id !== id) savePos();

  curId = id;
  curVideo = v;
  tkPlayOpenSession(id);   // 新播放器会话：本次打开内只报一次 play（换源/切清晰度不再重复计数）
  el.player.hidden = false;
  document.body.classList.add('lock');
  el.pTitle.textContent = v.title;
  el.pTitle.title = v.title;
  el.pMeta.innerHTML = [
    '目录 ' + esc(v.folder),
    '时长 ' + fmtDur(v.dur),
    '分辨率 ' + (v.w && v.h ? esc(v.w + '×' + v.h) : '未知') + ' ' + esc(resBadge(v.w)),
    '编码 ' + esc(v.vcodec || '未知'),
    '体积 ' + fmtSize(v.size),
    '字幕 ' + (v.sub ? '有' : '无'),
  ].map(t => `<span>${t}</span>`).join('·');
  el.pTags.innerHTML = tagsHtml(v);

  const pos = readPos(v.id);
  const total = v.dur || 0;
  const canResume = pos > 1 && (!total || pos < total - 15);
  el.pRestart.hidden = !canResume;

  el.pWarn.hidden = v.browserOk !== false;

  const video = el.video;
  for (const t of video.querySelectorAll('track')) t.remove();
  video.pause();
  video.removeAttribute('src');
  if (v.sub) video.appendChild(makeTrack(v.sub));   // 仅 sub 非空时注入字幕轨
  qFallback = false;
  applySource(v, canResume ? pos : 0, canResume ? pos : 0);   // pendingSeek 由常驻 loadedmetadata 消费
  lastPosWrite = Date.now();
  lastRecentPush = Date.now();
  syncPlayerFav();
  el.pTap.hidden = true;
  tryPlay();

  STATE.play = v.id;          // 播放深链同步：/#play=<id>
  writeHash();

  const nav = navListFor(v.id);
  el.pPrev.disabled = !(nav.i > 0);
  el.pNext.disabled = !(nav.i >= 0 && nav.i < nav.list.length - 1);
}

// 自动播放可能被浏览器拦截（无用户手势 + 有声音）：不报错，露出「点击播放」兜底
function tryPlay() {
  const p = el.video.play();
  if (p && p.catch) p.catch(() => { el.pTap.hidden = false; });
  return p;
}

// 深链 /#play=<videoId>：索引就绪后直接进播放层；无效 id 静默摘掉，不报错、不白屏
function openFromHash() {
  const id = STATE.play;
  if (!id) return;
  if (!BY_ID.has(id)) { STATE.play = ''; writeHash(); return; }
  openPlayer(id);
}

function makeTrack(subRel) {
  // 每次新建 track 元素：直接换 src 无法可靠触发浏览器重新挂载字幕轨
  const tr = document.createElement('track');
  tr.kind = 'subtitles';
  tr.label = '字幕';
  tr.srclang = 'zh';
  tr.default = true;
  if (subRel) tr.src = API + '/sub?p=' + encodeURIComponent(subRel);
  return tr;
}

function tagsHtml(v) {
  const out = [];
  for (const t of v.tags || []) out.push(`<span class="ptag"><b>${esc(t[0])}</b>${esc(t[1])}</span>`);
  for (const a of v.actors || []) out.push(`<span class="ptag ptag-actor"><b>演员</b>${esc(a)}</span>`);
  return out.length ? out.join('') : '<span class="ptag ptag-empty">无标签</span>';
}

function savePos() {
  const v = curVideo;
  if (!v) return;
  const video = el.video;
  const dur = contentDur(video);
  const pos = absPos(video);
  if (!dur || !isFinite(dur)) return;
  if (dur - pos <= 15) {
    clearPos(v.id);                 // 距结尾 15 秒内视为看完
    pushRecent(v.id, 0, dur);
  } else if (pos > 1) {
    writePos(v.id, pos);
    pushRecent(v.id, pos, dur);
  }
}

function closePlayer() {
  if (el.player.hidden) {
    if (STATE.play) { STATE.play = ''; writeHash(); }
    return;
  }
  savePos();
  pushRecentServer();
  const video = el.video;
  video.pause();
  for (const t of video.querySelectorAll('track')) t.remove();
  video.removeAttribute('src');
  video.load();
  endQHint();
  streamStart = 0;
  el.player.hidden = true;
  el.pTap.hidden = true;
  document.body.classList.remove('lock');
  curId = null;
  curVideo = null;
  STATE.play = '';        // 关闭播放层只摘掉 play 段，筛选段保留
  writeHash();
  refreshProgress();
  renderRecent();
}

function step(dir) {
  if (!curVideo) return;
  const nav = navListFor(curVideo.id);
  const j = nav.i + dir;
  if (nav.i >= 0 && j >= 0 && j < nav.list.length) openPlayer(nav.list[j].id);
}

function togglePlay() {
  const v = el.video;
  if (v.paused) tryPlay();
  else v.pause();
}

function toggleFullscreen() {
  const d = document;
  const exit = d.exitFullscreen || d.webkitExitFullscreen;
  if (d.fullscreenElement || d.webkitFullscreenElement) {
    if (exit) { const p = exit.call(d); if (p && p.catch) p.catch(() => {}); }
    return;
  }
  const stage = el.pStage;
  const req = stage.requestFullscreen || stage.webkitRequestFullscreen;
  if (req) {
    const p = req.call(stage);
    if (p && p.catch) p.catch(() => {});
  } else if (el.video.webkitEnterFullscreen) {
    el.video.webkitEnterFullscreen();   // iOS Safari 只支持视频元素全屏
  }
}

/* ---------- 事件 ---------- */

function setState(patch) {
  Object.assign(STATE, patch);
  render();
}

function toggleIn(arr, k) {
  const i = arr.indexOf(k);
  if (i >= 0) arr.splice(i, 1); else arr.push(k);
  return arr;
}

function removeActive(btn) {
  const kind = btn.dataset.kind, key = btn.dataset.key || '';
  if (kind === 'q') STATE.q = '';
  else if (kind === 'cat') toggleIn(STATE.cats, key);
  else if (kind === 'facet') {
    const f = btn.dataset.facet, n = btn.dataset.name;
    const arr = STATE.facets[f] || [];
    toggleIn(arr, n);
    if (!arr.length) delete STATE.facets[f];
  }
  else if (kind === 'dur') toggleIn(STATE.durs, key);
  else if (kind === 'res') toggleIn(STATE.ress, key);
  else if (kind === 'size') toggleIn(STATE.sizes, key);
  else if (kind === 'unsafe') STATE.unsafe = false;
  render();
}

function clearAll() {
  const play = STATE.play;      // 清空筛选不打断正在播放的深链
  STATE = defaultState();
  STATE.play = play || '';
  el.search.value = '';
  render();
}

function bindEvents() {
  let timer = 0;
  el.search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      STATE.q = el.search.value.trim();
      render();
    }, 80);   // 防抖仍低于 100ms 的筛选响应预算
  });
  el.search.addEventListener('keydown', e => {
    if (e.key === 'Escape') { el.search.value = ''; STATE.q = ''; render(); }
  });

  /* 搜索埋点：在既有 80ms 筛选防抖之外单独去抖 700ms，IME 组合期不上报，同一关键词只报一次 */
  let tkSearchT = 0;
  let tkSearchLast = '';
  let tkComposing = false;
  const reportSearch = () => {
    tkSearchT = 0;
    const q = String(el.search.value == null ? '' : el.search.value).trim().slice(0, 64);
    if (!q || q === tkSearchLast) return;
    tkSearchLast = q;
    track('search', 'keyword', q, 0, 0);
  };
  const scheduleSearch = () => {
    if (tkComposing) return;
    clearTimeout(tkSearchT);
    tkSearchT = setTimeout(reportSearch, 700);
  };
  el.search.addEventListener('input', scheduleSearch);
  el.search.addEventListener('compositionstart', () => { tkComposing = true; });
  el.search.addEventListener('compositionend', () => { tkComposing = false; scheduleSearch(); });
  el.search.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || tkComposing) return;
    clearTimeout(tkSearchT);
    reportSearch();
  });

  el.sort.addEventListener('change', () => {
    STATE.sort = el.sort.value;
    STATE.sortPinned = true;      // 手动选过就写进 hash，刷新保持
    render();
  });
  el.clearAll.addEventListener('click', clearAll);
  el.clearSide.addEventListener('click', clearAll);

  const chipToggle = (node, field) => node.addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (!b || !b.dataset.k) return;
    toggleIn(STATE[field], b.dataset.k);
    render();
  });
  chipToggle(el.durChips, 'durs');
  chipToggle(el.resChips, 'ress');
  chipToggle(el.sizeChips, 'sizes');

  el.unsafeChip.addEventListener('click', () => { STATE.unsafe = !STATE.unsafe; render(); });

  el.catChips.addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    toggleIn(STATE.cats, b.dataset.cat);
    render();
    if (isMobile()) toggleDrawer(false);
  });

  el.activeChips.addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (b) removeActive(b);
  });

  // facet 组：勾选 + 组内搜索（input 事件不重建 DOM，保住焦点）
  el.facetGroups.addEventListener('change', e => {
    const cb = e.target;
    if (!cb.matches('label.opt input')) return;
    const d = cb.closest('details.fg');
    if (!d) return;
    const f = d.dataset.facet;
    const name = cb.parentNode.dataset.name;
    const arr = STATE.facets[f] || (STATE.facets[f] = []);
    toggleIn(arr, name);
    // facet 值切到「选中」才上报（取消勾选不上报）；「演员」走同一入口，无需单独处理
    if (arr.indexOf(name) >= 0) track('tag_click', 'tag', (f + ':' + name).slice(0, 64), 0, 0);
    if (!arr.length) delete STATE.facets[f];
    render();
  });
  el.facetGroups.addEventListener('input', e => {
    const s = e.target;
    if (!s.classList || !s.classList.contains('fg-search')) return;
    const d = s.closest('details.fg');
    const q = s.value.trim().toLowerCase();
    let shown = 0;
    for (const lab of d.querySelectorAll('label.opt')) {
      const hit = !q || lab.dataset.name.toLowerCase().indexOf(q) >= 0;
      lab.hidden = !hit;
      if (hit) shown++;
    }
    const none = d.querySelector('.fg-none');
    if (none) none.hidden = shown > 0;
  });

  el.grid.addEventListener('click', e => {
    const star = e.target.closest('.card-fav');
    if (star) {
      e.preventDefault();
      e.stopPropagation();
      toggleVideoFav(BY_ID.get(star.dataset.favid));
      return;
    }
    const card = e.target.closest('.card');
    if (card) openPlayer(card.dataset.id);
  });
  el.grid.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const card = e.target.closest('.card');
    if (card) openPlayer(card.dataset.id);
  });

  // 封面缺失 → 占位块（capture 才能收到 img 的 error）
  document.addEventListener('error', e => {
    const t = e.target;
    if (!t || t.tagName !== 'IMG') return;
    const host = t.parentNode;
    if (host && (host.classList.contains('thumb') || host.classList.contains('rthumb'))) {
      t.remove();
      host.classList.add('noimg');
    }
  }, true);

  el.recentStrip.addEventListener('click', e => {
    const b = e.target.closest('.rcard');
    if (b) openPlayer(b.dataset.id);
  });
  el.recentClose.addEventListener('click', () => {
    lsSet(KEY_RECENT_CLOSED, '1');
    el.recentSec.hidden = true;
  });

  el.pClose.addEventListener('click', closePlayer);
  el.pFav.addEventListener('click', () => { if (curVideo) toggleVideoFav(curVideo); });
  el.pPrev.addEventListener('click', () => step(-1));
  el.pNext.addEventListener('click', () => step(1));
  el.pTap.addEventListener('click', () => { el.pTap.hidden = true; tryPlay(); });
  el.video.addEventListener('playing', () => { el.pTap.hidden = true; endQHint(); });
  el.video.addEventListener('loadeddata', endQHint);

  el.pQ.addEventListener('change', () => {
    const nq = el.pQ.value;
    if (Q_VALUES.indexOf(nq) < 0 || nq === curQ) return;
    qFallback = false;                                // 手动选档允许重试
    const abs = absPos(el.video);                    // 先按旧档取绝对位置
    const wasPlaying = !el.video.paused && !el.video.ended;
    curQ = nq;
    lsSet(KEY_Q, curQ);
    updateQNow();
    if (!curVideo) return;
    applySource(curVideo, abs, abs);
    if (wasPlaying) tryPlay();
  });

  el.pSeek.addEventListener('input', () => {
    qSeekDragging = true;
    if (el.pSeekNow) el.pSeekNow.textContent = fmtDur(Number(el.pSeek.value)) + ' / ' + fmtDur(contentDur(el.video) || 0);
  });
  el.pSeek.addEventListener('change', () => {
    qSeekDragging = false;
    if (!curVideo || !isTranscode()) return;
    applySource(curVideo, Number(el.pSeek.value) || 0, 0);
    tryPlay();
  });

  // 转码模式下拖动进度条：片内偏移超过 5 秒就从新时间点重开流（原画保持既有 Range 行为）
  el.video.addEventListener('seeking', () => {
    if (!curVideo || !isTranscode()) return;
    if (Date.now() - lastQSrcAt < 600) return;       // 换源刚发生，忽略随之而来的 seeking
    const rel = el.video.currentTime || 0;
    if (rel <= 5) return;
    const wasPlaying = !el.video.paused && !el.video.ended;
    applySource(curVideo, streamStart + rel, 0);
    if (wasPlaying) tryPlay();
  });
  el.pRestart.addEventListener('click', () => {
    if (isTranscode() && curVideo) applySource(curVideo, 0, 0);   // 转码流「从头」= 从 t=0 重开流
    else el.video.currentTime = 0;
    el.pRestart.hidden = true;
    tryPlay();
    if (curVideo) clearPos(curVideo.id);
  });

  el.video.addEventListener('loadedmetadata', () => {
    if (!pendingSeek) return;
    const abs = pendingSeek;
    pendingSeek = 0;
    const rel = isTranscode() ? Math.max(0, abs - streamStart) : abs;
    const d = el.video.duration;
    const target = (!isTranscode() && isFinite(d) && d > 0 && rel >= d - 2) ? 0 : rel;
    try { el.video.currentTime = target; } catch (e) { /* 忽略 */ }
  });
  el.video.addEventListener('timeupdate', () => {
    if (!curVideo) return;
    updateQSeek();
    const now = Date.now();
    if (now - lastPosWrite >= 3000) { lastPosWrite = now; savePos(); }
    if (now - lastRecentPush >= 5000) pushRecentServer();
  });
  el.video.addEventListener('pause', () => {
    if (!curVideo) return;
    savePos();
    pushRecentServer();
  });
  el.video.addEventListener('ended', () => {
    if (!curVideo) return;
    clearPos(curVideo.id);
    const dur = contentDur(el.video) || curVideo.dur || 0;
    pushRecent(curVideo.id, 0, dur);
    const p = msProfile();
    if (p) {
      p.pushRecent({
        kind: 'video', id: curVideo.id, title: curVideo.title,
        thumb: 'thumbs/v/' + curVideo.id + '.jpg', pos: 0, dur: Math.round(dur * 10) / 10,
      });
    }
    refreshProgress();
  });
  el.video.addEventListener('error', () => {
    el.pTap.hidden = true;
    endQHint();
    // 转码流取不到（接口未生效 404 / 转码忙 429 / ffmpeg 不可用 503）→ 回退原画，别让用户黑屏
    if (isTranscode() && curVideo && !qFallback) {
      qFallback = true;
      const abs = absPos(el.video);
      curQ = 'orig';
      lsSet(KEY_Q, curQ);
      updateQNow();
      applySource(curVideo, 0, abs);
      tryPlay();
      return;
    }
    if (curVideo && el.video.getAttribute('src')) el.pWarn.hidden = false;
  });

  /* 播放埋点：独立挂监听，不改动上面的既有处理；play 去重上报，pause/ended 结算观看时长 */
  el.video.addEventListener('play', tkPlayStart);
  el.video.addEventListener('pause', tkPlayEnd);
  el.video.addEventListener('ended', tkPlayEnd);

  el.drawerBtn.addEventListener('click', () => toggleDrawer());
  el.backdrop.addEventListener('click', () => toggleDrawer(false));

  // 手机上「筛选」是唯一筛选入口：开抽屉并滚到快捷筛选区；再点一次收起
  el.filterToggle.addEventListener('click', () => {
    if (!isMobile()) return;
    if (el.sidebar.classList.contains('open')) { toggleDrawer(false); return; }
    toggleDrawer(true);
    scrollDrawerToQuick();
  });

  if (mqMobile) {
    const onMq = () => placeFilterPanel();
    if (mqMobile.addEventListener) mqMobile.addEventListener('change', onMq);
    else if (mqMobile.addListener) mqMobile.addListener(onMq);
  }

  window.addEventListener('scroll', () => {
    const now = Date.now();
    if (now - scrollWriteT >= 200) { scrollWriteT = now; saveScroll(); return; }
    clearTimeout(scrollTailT);
    scrollTailT = setTimeout(() => { scrollWriteT = Date.now(); saveScroll(); }, 200);
  }, { passive: true });

  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', () => {
    // 只在外部（手改地址栏/前进后退）改动时同步，避免与 writeHash 互相触发
    const next = parseHash(location.hash);
    if (buildHash(next) === buildHash(STATE)) return;
    const wantPlay = next.play || '';
    const playChanged = wantPlay !== (STATE.play || '');
    STATE = next;
    render();
    if (!playChanged) return;
    if (!wantPlay) closePlayer();
    else if (BY_ID.has(wantPlay)) openPlayer(wantPlay);
    else { STATE.play = ''; writeHash(); }
  });
}

function isMobile() {
  return window.matchMedia('(max-width: 768px)').matches;
}

/* ---------- 移动端布局：快捷筛选在抽屉与工具栏之间双向迁移 ---------- */

let panelHome = null;      // 桌面原位：toolbar 内、activeChips 之前
const mqMobile = (typeof window !== 'undefined' && window.matchMedia)
  ? window.matchMedia('(max-width: 768px)') : null;

// 只移动同一个节点（appendChild/insertBefore），保住已绑在子节点上的监听
function placeFilterPanel() {
  const panel = el.filterPanel;
  if (!panel) return;
  if (!panelHome) panelHome = { parent: panel.parentNode, next: panel.nextElementSibling };
  const head = el.quickHead, host = el.sideScroll, anchor = el.facetGroups;
  if (isMobile()) {
    if (!host) return;
    if (head && head.parentNode !== host) host.insertBefore(head, anchor);
    if (panel.parentNode !== host) host.insertBefore(panel, anchor);
    if (head) head.hidden = false;
  } else {
    if (head) head.hidden = true;
    if (panel.parentNode !== panelHome.parent) panelHome.parent.insertBefore(panel, panelHome.next);
  }
}

function scrollDrawerToQuick() {
  const sc = el.sideScroll, head = el.quickHead;
  if (!sc) return;
  const move = () => {
    const target = head || el.filterPanel;
    if (!target) return;
    const dy = target.getBoundingClientRect().top - sc.getBoundingClientRect().top;
    sc.scrollTop = Math.max(0, sc.scrollTop + dy - 8);
  };
  move();
  setTimeout(move, 240);   // 抽屉位移过渡结束后再校正一次
}

/* ---------- 卡片密度（手机 2 / 3 列） ---------- */

function applyCols(mode) {
  if (!el.grid || !el.colsBtn) return;
  const three = mode === '3';
  el.grid.classList.toggle('cols-3', three);
  el.colsBtn.setAttribute('aria-pressed', three ? 'true' : 'false');
  el.colsBtn.title = three ? '切换到 2 列' : '切换到 3 列';
}

function initCols() {
  let mode = lsGet(KEY_COLS) === '3' ? '3' : '2';
  applyCols(mode);
  if (!el.colsBtn) return;
  el.colsBtn.addEventListener('click', () => {
    mode = mode === '3' ? '2' : '3';
    lsSet(KEY_COLS, mode);
    applyCols(mode);
  });
}

/* ---------- 记住滚动位置（同 hash 才恢复） ---------- */

let scrollWriteT = 0;
let scrollTailT = 0;

function saveScroll() {
  lsSet(KEY_SCROLL, JSON.stringify({ hash: location.hash, y: Math.round(window.scrollY) }));
}

function clearScrollMem() {
  clearTimeout(scrollTailT);
  lsDel(KEY_SCROLL);
}

function restoreScroll() {
  const raw = lsGet(KEY_SCROLL);
  if (!raw) return;
  let o = null;
  try { o = JSON.parse(raw); } catch (e) { return; }
  if (!o || typeof o.y !== 'number' || !isFinite(o.y) || o.hash !== location.hash) return;
  const y = Math.max(0, o.y);
  requestAnimationFrame(() => { setTimeout(() => window.scrollTo(0, y), 0); });
}

// 筛选/排序变化才算"换了一批卡片"：play 段不参与比较，避免看片回来丢位置
function filterSig() {
  return buildHash(Object.assign({}, STATE, { play: '' }));
}

function toggleDrawer(force) {
  const open = force === undefined ? !el.sidebar.classList.contains('open') : force;
  el.sidebar.classList.toggle('open', open);
  el.backdrop.hidden = !open;
  document.body.classList.toggle('lock', open || !el.player.hidden);
  if (!open) {
    // 抽屉与「筛选」按钮态保持同步（点遮罩关闭时也要复位）
    if (el.filterPanel) el.filterPanel.classList.remove('open');
    if (el.filterToggle) el.filterToggle.setAttribute('aria-expanded', 'false');
  }
}

function onKey(e) {
  const t = e.target;
  const tag = (t && t.tagName ? t.tagName : '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable);

  if (e.key === 'Escape') {
    if (!el.player.hidden) { e.preventDefault(); closePlayer(); return; }
    if (el.sidebar.classList.contains('open')) { toggleDrawer(false); return; }
    if (typing && t.blur) t.blur();
    return;
  }
  if (e.key === '/' && !typing && el.player.hidden) {
    e.preventDefault();
    el.search.focus();
    return;
  }
  if (el.player.hidden) return;

  switch (e.key) {
    case ' ':
    case 'Spacebar':
      e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft':
      e.preventDefault(); seekRel(-5); break;
    case 'ArrowRight': {
      e.preventDefault();
      seekRel(5);
      break;
    }
    case 'ArrowUp':
      e.preventDefault(); el.video.volume = Math.min(1, el.video.volume + 0.1); break;
    case 'ArrowDown':
      e.preventDefault(); el.video.volume = Math.max(0, el.video.volume - 0.1); break;
    case 'f': case 'F':
      e.preventDefault(); toggleFullscreen(); break;
    case 'n': case 'N':
      e.preventDefault(); step(1); break;
    case 'p': case 'P':
      e.preventDefault(); step(-1); break;
    default: break;
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') boot();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MB, GB,
    DUR_BUCKETS, RES_TIERS, SIZE_BUCKETS, SORTS, SORT_POOL, SORT_RANDOM,
    durBucketOf, resTierOf, sizeBucketOf, resBadge, fmtDur, fmtSize,
    resPixels, progressPct, shuffleInPlace,
    matchesSearch, matchesFacets, filterVideos, sortVideos, queryVideos,
    defaultState, parseHash, buildHash, facetValues, folderCounts,
  };
}
