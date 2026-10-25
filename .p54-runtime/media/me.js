'use strict';
/* 「我的」页面：只读渲染。数据与写操作全部走 MSProfile（用户接口只由组件访问） */
(function () {
  // 后端媒体接口前缀：旧 /thumb 收敛到这一处
  var MEDIA = '/api/media';
  var elAvatar, elNick, elRecent, elFav;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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

  function thumbUrl(it) {
    var th = it && it.thumb ? String(it.thumb) : '';
    if (/^(data:|\/|https?:)/.test(th)) return th;
    if (th.indexOf('thumbs/') === 0) return MEDIA + '/thumb/' + th.slice(7).replace(/\.jpg$/i, '');
    if (it && it.kind === 'photo') return MEDIA + '/thumb/p/' + encodeURIComponent(it.album || '') + '/' + pad4(it.i);
    if (it && it.id) return MEDIA + '/thumb/v/' + encodeURIComponent(it.id);
    return '';
  }

  function itemHtml(it, mode) {
    var kind = it.kind === 'photo' ? 'photo' : 'video';
    var th = thumbUrl(it);
    var prog = '';
    if (mode === 'recent' && kind === 'video') {
      var pos = +it.pos || 0, dur = +it.dur || 0;
      if (pos > 0 && dur > 0) {
        prog = '<i class="pf-prog" style="width:' + Math.min(100, pos / dur * 100).toFixed(1) + '%"></i>';
      }
    }
    var star = mode === 'fav'
      ? '<button class="me-star" type="button" data-fav="' + esc(kind === 'photo'
        ? 'photo:' + (it.album || '') + '#' + (parseInt(it.i, 10) || 0)
        : 'video:' + (it.id || '')) + '" aria-label="取消收藏" title="取消收藏">★</button>'
      : '';
    return '<div class="me-item">'
      + '<a class="me-link" href="' + esc(itemHref(it)) + '" title="' + esc(it.title || '') + '">'
      + '<span class="me-th">' + (th ? '<img src="' + esc(th) + '" alt="" loading="lazy" decoding="async">' : '') + prog + '</span>'
      + '<span class="me-t">' + esc(it.title || (kind === 'photo' ? '图片' : '视频')) + '</span></a>'
      + star + '</div>';
  }

  function groupHtml(label, list, mode) {
    if (!list || !list.length) return '';
    return '<div class="me-g"><h3>' + esc(label) + '<em> ' + list.length + '</em></h3>'
      + '<div class="me-list">' + list.map(function (it) { return itemHtml(it, mode); }).join('') + '</div></div>';
  }

  function renderGroups(host, videos, photos, mode, emptyText) {
    var html = groupHtml('视频', videos, mode) + groupHtml('图片', photos, mode);
    host.innerHTML = html || '<p class="me-empty">' + esc(emptyText) + '</p>';
  }

  function render() {
    var P = window.MSProfile;
    if (!P) return;
    var s = P.get();
    var p = s.profile || {};
    elNick.textContent = p.nick || '我';
    elAvatar.innerHTML = P.avatarHtml(p, 'pf-av-64');
    renderGroups(elRecent, s.recent.videos, s.recent.photos, 'recent', '还没有浏览记录');
    renderGroups(elFav,
      s.favorites.filter(function (f) { return f.kind !== 'photo'; }),
      s.favorites.filter(function (f) { return f.kind === 'photo'; }),
      'fav', '还没有收藏');
  }

  function favByKey(key) {
    var s = window.MSProfile.get();
    for (var i = 0; i < s.favorites.length; i++) {
      var f = s.favorites[i];
      var k = f.kind === 'photo'
        ? 'photo:' + (f.album || '') + '#' + (parseInt(f.i, 10) || 0)
        : 'video:' + (f.id || '');
      if (k === key) return f;
    }
    return null;
  }

  function boot() {
    elAvatar = document.getElementById('meAvatar');
    elNick = document.getElementById('meNick');
    elRecent = document.getElementById('recentGroups');
    elFav = document.getElementById('favGroups');
    var P = window.MSProfile;
    if (!P) {
      elRecent.innerHTML = '<p class="me-empty">个人组件未加载</p>';
      return;
    }

    render();
    P.on('change', render);
    P.refresh();

    document.getElementById('meEdit').addEventListener('click', function () {
      P.openEditor();
    });

    document.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.me-star') : null;
      if (!b) return;
      e.preventDefault();
      var it = favByKey(b.getAttribute('data-fav'));
      if (it) P.toggleFav(it);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
