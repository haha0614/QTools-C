'use strict';
/* 共享个人组件：右上入口 + 浮层/底部抽屉 + 编辑，且是唯一访问 /api/user 的前端模块 */
(function (global) {
  if (global.MSProfile) return;

  var MEDIA = '/api/media';          // 后端媒体接口前缀（缩略图/预览图也走这里）
  var API = MEDIA + '/user';        // 唯一的用户接口；跨端口 Cookie 不可靠，靠 X-Ms-Owner 头识别身份
  var OWNER_KEY = 'ms.owner';       // localStorage 里的 owner 键，首次从响应体 ownerKey 取
  var MAX_FAV = 2000;
  var RECENT_MAX = 50;
  var KEY_GRAD = 'ms.avatar.grad';
  var GRADS = 8;

  var state = { profile: { nick: '我', avatar: null }, favorites: [], recent: { videos: [], photos: [] } };
  var ready = false;
  var inflight = null;
  var retryTimer = 0;
  var waiters = [];
  var listeners = [];
  var site = 'video';
  var slotEl = null;
  var entryEl = null;
  var popEl = null;
  var veilEl = null;
  var edEl = null;
  var edGrad = 0;
  var edAvatar = null;
  var panelOpen = false;
  var hoverTimer = 0;

  /* ---------- 基础工具 ---------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function firstChar(s) {
    var t = String(s == null ? '' : s).trim();
    return t ? t.slice(0, 1) : '我';
  }

  function shortNick(n) {
    var s = String(n == null ? '' : n).trim() || '我';
    return s.length > 8 ? s.slice(0, 8) + '…' : s;
  }

  function isMobile() {
    return !!(global.matchMedia && global.matchMedia('(max-width: 768px)').matches);
  }

  function readGrad() {
    try {
      var g = parseInt(global.localStorage.getItem(KEY_GRAD), 10);
      if (g >= 1 && g <= GRADS) return g;
    } catch (e) { /* 隐私模式 */ }
    return 0;
  }

  function gradIndex() {
    var g = readGrad();
    if (g) return g;
    var s = (state.profile && state.profile.nick) || '我';
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h) % GRADS + 1;
  }

  function avatarHtml(p, sizeCls) {
    p = p || {};
    var cls = 'pf-av ' + (sizeCls || 'pf-av-28');
    if (p.avatar && /^data:image\//.test(p.avatar)) {
      return '<span class="' + cls + ' pf-av-img"><img src="' + esc(p.avatar) + '" alt=""></span>';
    }
    return '<span class="' + cls + ' pf-g' + gradIndex() + '">' + esc(firstChar(p.nick || '我')) + '</span>';
  }

  function thumbUrl(it) {
    var th = it && it.thumb ? String(it.thumb) : '';
    if (/^(data:|\/|https?:)/.test(th)) return th;
    if (th.indexOf('thumbs/') === 0) return MEDIA + '/thumb/' + th.slice(7).replace(/\.jpg$/i, '');
    if (it && it.kind === 'photo') return MEDIA + '/thumb/p/' + encodeURIComponent(it.album || '') + '/' + pad4(it.i);
    if (it && it.id) return MEDIA + '/thumb/v/' + encodeURIComponent(it.id);
    return '';
  }

  function pad4(i) {
    var n = Math.max(0, parseInt(i, 10) || 0);
    return ('000' + n).slice(-4);
  }

  function itemHref(it) {
    if (it.kind === 'photo') {
      return 'photos.html#album=' + encodeURIComponent(it.album || '') + '&i=' + (parseInt(it.i, 10) || 0);
    }
    return 'index.html#play=' + encodeURIComponent(it.id || '');
  }

  function favKey(it) {
    if (!it) return '';
    if (it.kind === 'photo') return 'photo:' + (it.album || '') + '#' + (parseInt(it.i, 10) || 0);
    return 'video:' + (it.id || '');
  }

  function keyOf(it) { return favKey(it); }

  /* ---------- 身份（owner） ---------- */
  /* 站点由 8080 托管、接口同源；但开发态经 vite 代理、生产也可能换端口，跨端口 Cookie 不可靠，
     因此身份一律走 X-Ms-Owner 头。值存 localStorage['ms.owner']，首次由响应体的 ownerKey 下发。 */

  function readOwner() {
    try { return global.localStorage.getItem(OWNER_KEY) || ''; } catch (e) { return ''; }
  }

  function writeOwner(v) {
    if (!v || typeof v !== 'string' || readOwner() === v) return;
    try { global.localStorage.setItem(OWNER_KEY, v); } catch (e) { /* 忽略 */ }
  }

  // 组装请求头：始终带 accept，有 owner 时带 X-Ms-Owner
  function userHeaders(extra) {
    var h = extra || {};
    var o = readOwner();
    if (o) h['X-Ms-Owner'] = o;
    return h;
  }

  /* ---------- 数据层（唯一的 /api/media/user 访问点） ---------- */

  function normalize(o) {
    var out = { profile: { nick: '我', avatar: null }, favorites: [], recent: { videos: [], photos: [] } };
    if (o && typeof o === 'object') {
      if (o.profile && typeof o.profile === 'object') {
        out.profile.nick = (typeof o.profile.nick === 'string' && o.profile.nick.trim()) ? o.profile.nick : '我';
        out.profile.avatar = typeof o.profile.avatar === 'string' ? o.profile.avatar : null;
      }
      if (Object.prototype.toString.call(o.favorites) === '[object Array]') {
        out.favorites = o.favorites.filter(function (f) { return f && (f.kind === 'video' || f.kind === 'photo'); });
      }
      if (o.recent && typeof o.recent === 'object') {
        if (Object.prototype.toString.call(o.recent.videos) === '[object Array]') {
          out.recent.videos = o.recent.videos.filter(function (r) { return r && r.id; });
        }
        if (Object.prototype.toString.call(o.recent.photos) === '[object Array]') {
          out.recent.photos = o.recent.photos.filter(function (r) { return r && r.album != null; });
        }
      }
    }
    return out;
  }

  function emit(reason) {
    var r = reason || 'change';
    try { renderEntry(); } catch (e) { /* 渲染异常不得影响数据态（入口可能在重绘中） */ }
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](r); } catch (e2) { /* 回调异常不影响组件 */ }
    }
    if (panelOpen && r !== 'recent') {
      try { renderPanel(); } catch (e3) { /* 同上 */ }
    }
  }

  function flushWaiters() {
    var list = waiters;
    waiters = [];
    for (var i = 0; i < list.length; i++) { try { list[i](ready); } catch (e) { /* 忽略 */ } }
  }

  // 接口不就绪时 15 秒后重试一次，成功后停表
  function scheduleRetry() {
    if (retryTimer || ready) return;
    retryTimer = setTimeout(function () {
      retryTimer = 0;
      if (!ready) loadUser();
    }, 15000);
  }

  function loadUser() {
    if (inflight) return inflight;
    inflight = global.fetch(API, { cache: 'no-store', headers: userHeaders({ accept: 'application/json' }) })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (o) {
        writeOwner(o && o.ownerKey);   // 服务端下发的 owner 首次落盘，之后每次请求都带上
        state = normalize(o);
        ready = true;
        clearTimeout(retryTimer);
        retryTimer = 0;
        emit('load');
        flushWaiters();
        return state;
      })
      .catch(function () {
        ready = false;
        scheduleRetry();
        flushWaiters();
        return state;
      })
      .then(function (v) { inflight = null; return v; });
    return inflight;
  }

  function postUser(patch) {
    return global.fetch(API, {
      method: 'POST',
      headers: userHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(patch)
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (o) {
        writeOwner(o && o.ownerKey);
        state = normalize(o);
        ready = true;
        clearTimeout(retryTimer);
        retryTimer = 0;
        flushWaiters();
        return state;
      })
      .catch(function () {
        ready = false;
        scheduleRetry();
        throw new Error('offline');
      });
  }

  function toast(msg) {
    var t = document.querySelector('.pf-toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'pf-toast';
      document.body.appendChild(t);
    }
    t.textContent = String(msg);
    t.classList.add('on');
    clearTimeout(t.__h);
    t.__h = setTimeout(function () { t.classList.remove('on'); }, 2400);
  }

  /* ---------- 收藏 / 最近浏览 ---------- */

  function entryOf(item) {
    var now = Date.now();
    if (!item) return { kind: 'video', id: '', title: '', thumb: '', t: now };
    if (item.kind === 'photo') {
      return {
        kind: 'photo',
        album: String(item.album == null ? '' : item.album),
        i: Math.max(0, parseInt(item.i, 10) || 0),
        title: String(item.title == null ? '' : item.title).slice(0, 200),
        thumb: String(item.thumb == null ? '' : item.thumb).slice(0, 300),
        t: now
      };
    }
    var id = String(item.id == null ? '' : item.id);
    return {
      kind: 'video',
      id: id,
      title: String(item.title == null ? '' : item.title).slice(0, 200),
      thumb: String(item.thumb || ('thumbs/v/' + id + '.jpg')).slice(0, 300),
      t: now
    };
  }

  function isFav(item) {
    var k = favKey(entryOf(item));
    for (var i = 0; i < state.favorites.length; i++) if (favKey(state.favorites[i]) === k) return true;
    return false;
  }

  function toggleFav(item) {
    var e = entryOf(item);
    var k = favKey(e);
    var add = !isFav(e);
    if (add) {
      var rest = state.favorites.filter(function (f) { return favKey(f) !== k; });
      state.favorites = [e].concat(rest).slice(0, MAX_FAV);
    } else {
      state.favorites = state.favorites.filter(function (f) { return favKey(f) !== k; });
    }
    emit('fav');                          // 乐观更新：星星立即响应，不等服务端
    if (!ready) loadUser();               // 接口恢复后自动对齐
    var body = {};
    for (var k2 in e) if (Object.prototype.hasOwnProperty.call(e, k2)) body[k2] = e[k2];
    body.add = add;
    return postUser({ fav: body })
      .then(function () { emit('fav'); return add; })
      .catch(function () { toast('未保存（服务端不可用）'); return add; });
  }

  function pushRecent(item) {
    var e = entryOf(item);
    var list = e.kind === 'photo' ? 'photos' : 'videos';
    if (e.kind === 'video') {
      e.pos = Math.max(0, Math.round((+item.pos || 0) * 10) / 10);
      var d = +item.dur || 0;
      if (d > 0) e.dur = Math.round(d * 10) / 10;
    }
    var k = favKey(e);
    var arr = state.recent[list].filter(function (r) { return favKey(r) !== k; });
    arr.unshift(e);
    state.recent[list] = arr.slice(0, RECENT_MAX);
    emit('recent');
    if (!ready) { loadUser(); return Promise.resolve(false); }
    return postUser({ recent: e }).then(function () { return true; }).catch(function () { return false; });
  }

  /* ---------- 入口 ---------- */

  function renderEntry() {
    if (!entryEl) return;
    var p = state.profile || {};
    entryEl.innerHTML = avatarHtml(p, 'pf-av-28') + '<span class="pf-nick">' + esc(shortNick(p.nick)) + '</span>';
    entryEl.title = (p.nick || '我');
  }

  function bindEntry() {
    entryEl.addEventListener('click', function (e) {
      e.stopPropagation();
      if (panelOpen) close(); else open();
    });
    entryEl.addEventListener('mouseenter', function () {
      if (isMobile()) return;
      clearTimeout(hoverTimer);
      if (!panelOpen) open();
    });
    entryEl.addEventListener('mouseleave', function () {
      if (isMobile() || !panelOpen) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(close, 260);
    });
  }

  /* ---------- 浮层 ---------- */

  function buildPop() {
    if (popEl) return;
    veilEl = document.createElement('div');
    veilEl.className = 'pf-veil';
    veilEl.hidden = true;
    veilEl.addEventListener('click', close);
    document.body.appendChild(veilEl);

    popEl = document.createElement('div');
    popEl.className = 'pf-pop';
    popEl.hidden = true;
    popEl.setAttribute('role', 'dialog');
    popEl.setAttribute('aria-label', '我的');
    document.body.appendChild(popEl);

    popEl.addEventListener('mouseenter', function () { clearTimeout(hoverTimer); });
    popEl.addEventListener('mouseleave', function () {
      if (isMobile()) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(close, 260);
    });

    popEl.addEventListener('click', function (e) {
      var star = e.target.closest ? e.target.closest('.pf-star') : null;
      if (star) {
        e.preventDefault();
        e.stopPropagation();
        var k = star.getAttribute('data-fav');
        var it = findFav(k);
        if (it) toggleFav(it);
        return;
      }
      var edit = e.target.closest ? e.target.closest('.pf-edit') : null;
      if (edit) {
        e.preventDefault();
        close();
        openEditor();
        return;
      }
      var link = e.target.closest ? e.target.closest('.pf-link') : null;
      if (link) close();            // 交给浏览器默认跳转（/#play=… 触发 hashchange）
    });
  }

  function findFav(key) {
    for (var i = 0; i < state.favorites.length; i++) if (favKey(state.favorites[i]) === key) return state.favorites[i];
    return null;
  }

  function itemHtml(it, mode, kindLabel) {
    var kind = it.kind === 'photo' ? 'photo' : 'video';
    var href = itemHref(it);
    var th = thumbUrl(it);
    var inner = '';
    if (mode === 'recent' && kind === 'video') {
      var pos = +it.pos || 0, dur = +it.dur || 0;
      if (pos > 0 && dur > 0) inner = '<i class="pf-prog" style="width:' + Math.min(100, pos / dur * 100).toFixed(1) + '%"></i>';
    }
    var star = mode === 'fav'
      ? '<button class="pf-star on" type="button" data-fav="' + esc(favKey(it)) + '" aria-label="取消收藏" title="取消收藏">★</button>'
      : '';
    return '<div class="pf-item">'
      + '<a class="pf-link" href="' + esc(href) + '" data-kind="' + kind + '" title="' + esc(it.title || '') + '">'
      + '<span class="pf-th">' + (th ? '<img src="' + esc(th) + '" alt="" loading="lazy" decoding="async">' : '') + inner + '</span>'
      + '<span class="pf-it">' + esc(it.title || kindLabel) + '</span></a>'
      + star + '</div>';
  }

  function groupHtml(label, list, mode) {
    if (!list || !list.length) return '';
    return '<div class="pf-glabel">' + esc(label) + '</div>'
      + '<div class="pf-list">' + list.map(function (it) { return itemHtml(it, mode, label); }).join('') + '</div>';
  }

  function sectionHtml(title, groups, emptyText) {
    var body = groups.join('');
    return '<div class="pf-sec"><div class="pf-sec-h"><h4>' + esc(title) + '</h4></div>'
      + (body || '<p class="pf-empty">' + esc(emptyText) + '</p>') + '</div>';
  }

  function renderPanel() {
    if (!popEl) return;
    var p = state.profile || {};
    var favs = state.favorites || [];
    var rec = state.recent || { videos: [], photos: [] };
    var favV = favs.filter(function (f) { return f.kind !== 'photo'; }).slice(0, 8);
    var favP = favs.filter(function (f) { return f.kind === 'photo'; }).slice(0, 8);
    var recV = (rec.videos || []).slice(0, 8);
    var recP = (rec.photos || []).slice(0, 8);
    var order = site === 'photo' ? ['photo', 'video'] : ['video', 'photo'];
    var recGroups = order.map(function (k) {
      return k === 'photo' ? groupHtml('图片', recP, 'recent') : groupHtml('视频', recV, 'recent');
    });
    var favGroups = order.map(function (k) {
      return k === 'photo' ? groupHtml('图片', favP, 'fav') : groupHtml('视频', favV, 'fav');
    });
    popEl.innerHTML = '<div class="pf-head">' + avatarHtml(p, 'pf-av-36')
      + '<span class="pf-name">' + esc(p.nick || '我') + '</span>'
      + '<button class="pf-edit" type="button">编辑</button></div>'
      + '<div class="pf-body">'
      + sectionHtml('最近浏览', recGroups, '还没有最近浏览')
      + sectionHtml('收藏', favGroups, '还没有收藏')
      + '</div>'
      + '<a class="pf-foot" href="me.html">查看全部 ›</a>';
  }

  function position() {
    if (!entryEl || !popEl || isMobile()) return;
    var r = entryEl.getBoundingClientRect();
    var w = 320;
    var vw = global.innerWidth || document.documentElement.clientWidth;
    var left = Math.max(8, Math.min(r.right - w, vw - w - 8));
    var top = r.bottom + 8;
    popEl.style.left = Math.round(left) + 'px';
    popEl.style.top = Math.round(top) + 'px';
    popEl.style.right = 'auto';
    popEl.style.bottom = 'auto';
  }

  function open() {
    buildPop();
    renderPanel();
    panelOpen = true;
    popEl.hidden = false;
    popEl.classList.toggle('pf-sheet', isMobile());
    if (isMobile()) veilEl.hidden = false;
    position();
    requestAnimationFrame(function () {
      popEl.classList.add('pf-open');
      if (isMobile()) veilEl.classList.add('pf-on');
    });
    if (entryEl) entryEl.setAttribute('aria-expanded', 'true');
  }

  function close() {
    if (!popEl || !panelOpen) return;
    panelOpen = false;
    clearTimeout(hoverTimer);
    popEl.classList.remove('pf-open');
    if (veilEl) { veilEl.classList.remove('pf-on'); veilEl.hidden = true; }
    var el = popEl;
    setTimeout(function () { if (!panelOpen) el.hidden = true; }, 180);
    if (entryEl) entryEl.setAttribute('aria-expanded', 'false');
  }

  /* ---------- 编辑 ---------- */

  function buildEditor() {
    if (edEl) return;
    edEl = document.createElement('div');
    edEl.className = 'pf-modal';
    edEl.hidden = true;
    var grads = '';
    for (var i = 1; i <= GRADS; i++) {
      grads += '<button class="pf-grad pf-g' + i + '" type="button" data-g="' + i + '" aria-label="内置头像 ' + i + '"></button>';
    }
    edEl.innerHTML = '<div class="pf-modal-card" role="dialog" aria-modal="true" aria-label="编辑资料">'
      + '<h3 class="pf-modal-h">编辑资料</h3>'
      + '<label class="pf-field"><span class="pf-field-t">昵称（1–24 字）</span>'
      + '<input class="pf-input" type="text" maxlength="24" autocomplete="off" placeholder="1–24 字"></label>'
      + '<div class="pf-field"><span class="pf-field-t">头像</span><div class="pf-grads">' + grads + '</div></div>'
      + '<div class="pf-field"><button class="pf-upload" type="button">上传图片</button>'
      + '<input class="pf-file" type="file" accept="image/*" hidden><span class="pf-up-hint">自动裁成 128×128 webp</span></div>'
      + '<div class="pf-msg" hidden></div>'
      + '<div class="pf-modal-actions"><button class="pf-btn pf-cancel" type="button">取消</button>'
      + '<button class="pf-btn pf-btn-primary pf-save" type="button">保存</button></div>'
      + '</div>';
    document.body.appendChild(edEl);

    edEl.addEventListener('click', function (e) {
      if (e.target === edEl) closeEditor();
    });
    edEl.querySelector('.pf-cancel').addEventListener('click', closeEditor);
    edEl.querySelector('.pf-grads').addEventListener('click', function (e) {
      var b = e.target.closest('.pf-grad');
      if (!b) return;
      edGrad = parseInt(b.getAttribute('data-g'), 10) || 1;
      edAvatar = null;                       // 选了内置渐变就放弃上传图
      syncEditor();
    });
    edEl.querySelector('.pf-upload').addEventListener('click', function () {
      edEl.querySelector('.pf-file').click();
    });
    edEl.querySelector('.pf-file').addEventListener('change', onFile);
    edEl.querySelector('.pf-save').addEventListener('click', saveEditor);
    edEl.querySelector('.pf-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); saveEditor(); }
    });
  }

  function editorMsg(text) {
    var m = edEl.querySelector('.pf-msg');
    if (!m) return;
    m.textContent = text || '';
    m.hidden = !text;
  }

  function syncEditor() {
    var btns = edEl.querySelectorAll('.pf-grad');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', !edAvatar && +btns[i].getAttribute('data-g') === edGrad);
    }
    var up = edEl.querySelector('.pf-upload');
    if (up) up.textContent = edAvatar ? '更换图片（已选）' : '上传图片';
  }

  function openEditor() {
    buildEditor();
    var p = state.profile || {};
    edEl.querySelector('.pf-input').value = p.nick || '我';
    edAvatar = (p.avatar && /^data:image\//.test(p.avatar)) ? p.avatar : null;
    edGrad = readGrad() || gradIndex();
    editorMsg('');
    syncEditor();
    edEl.hidden = false;
    var input = edEl.querySelector('.pf-input');
    setTimeout(function () { try { input.focus(); input.select(); } catch (e) { /* 忽略 */ } }, 30);
  }

  function closeEditor() {
    if (edEl) edEl.hidden = true;
  }

  function onFile(e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    if (!/^image\//.test(f.type)) { editorMsg('请选择图片文件'); return; }
    var fr = new FileReader();
    fr.onload = function () {
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement('canvas');
          c.width = 128; c.height = 128;
          var ctx = c.getContext('2d');
          var s = Math.min(img.width, img.height) || 1;
          ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128);
          var out = c.toDataURL('image/webp', 0.85);
          if (out.indexOf('data:image/') !== 0) out = c.toDataURL('image/png');
          edAvatar = out;
          editorMsg('');
          syncEditor();
        } catch (err) {
          editorMsg('图片处理失败，请换一张');
        }
      };
      img.onerror = function () { editorMsg('图片无法解析'); };
      img.src = String(fr.result || '');
    };
    fr.onerror = function () { editorMsg('读取文件失败'); };
    fr.readAsDataURL(f);
  }

  function saveEditor() {
    var input = edEl.querySelector('.pf-input');
    var nick = String(input.value || '').trim();
    if (!nick) { editorMsg('昵称不能为空（1–24 字）'); return; }
    if (nick.length > 24) { editorMsg('昵称最多 24 字'); return; }
    try { global.localStorage.setItem(KEY_GRAD, String(edAvatar ? 0 : edGrad)); } catch (e) { /* 忽略 */ }
    var prof = { nick: nick, avatar: edAvatar || null };
    state.profile = { nick: nick, avatar: prof.avatar };
    renderEntry();
    emit('profile');
    closeEditor();
    postUser({ profile: prof })
      .then(function () { emit('profile'); })
      .catch(function () { toast('未保存（服务端不可用）'); });
  }

  /* ---------- 对外 API ---------- */

  function mount(opts) {
    opts = opts || {};
    site = opts.site === 'photo' ? 'photo' : 'video';
    var host = typeof opts.slot === 'string' ? document.querySelector(opts.slot) : opts.slot;
    if (!host) return null;
    slotEl = host;
    host.classList.add('pf-root');
    host.innerHTML = '';
    entryEl = document.createElement('button');
    entryEl.type = 'button';
    entryEl.className = 'pf-entry';
    entryEl.setAttribute('aria-haspopup', 'dialog');
    entryEl.setAttribute('aria-expanded', 'false');
    entryEl.setAttribute('aria-label', '我的');
    host.appendChild(entryEl);
    buildPop();
    renderEntry();
    bindEntry();
    loadUser();
    return entryEl;
  }

  function on(evt, fn) {
    if (evt !== 'change' || typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function get() {
    return {
      profile: { nick: state.profile.nick, avatar: state.profile.avatar },
      favorites: state.favorites.slice(),
      recent: { videos: state.recent.videos.slice(), photos: state.recent.photos.slice() }
    };
  }

  function refresh() { return loadUser(); }

  function isReady() { return ready; }

  function whenReady() {
    if (ready) return Promise.resolve(true);
    if (!inflight) loadUser();
    return new Promise(function (res) { waiters.push(res); });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (edEl && !edEl.hidden) { closeEditor(); return; }
    if (panelOpen) close();
  });

  document.addEventListener('click', function (e) {
    if (!panelOpen) return;
    if (popEl && popEl.contains(e.target)) return;
    if (entryEl && entryEl.contains(e.target)) return;
    close();
  });

  global.addEventListener('resize', function () { if (panelOpen) position(); });

  global.MSProfile = {
    mount: mount,
    toggleFav: toggleFav,
    isFav: isFav,
    on: on,
    open: open,
    close: close,
    pushRecent: pushRecent,
    openEditor: openEditor,
    get: get,
    refresh: refresh,
    isReady: isReady,
    whenReady: whenReady,
    avatarHtml: avatarHtml,
    thumbUrl: thumbUrl,
    itemHref: itemHref,
    keyOf: keyOf,
    toast: toast
  };
})(window);
