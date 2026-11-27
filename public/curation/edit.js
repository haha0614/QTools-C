/* 「隐秘在场」三页共用的编辑逻辑：条目上的「改 / 移出」→ 调本地小服务（server.mjs）写回仓库 JSON。
   服务地址默认 http://127.0.0.1:8787，可用 localStorage['curation.api'] 或 ?api= 覆盖。 */
(function () {
  'use strict';
  if (window.__curationEdit) return;
  window.__curationEdit = true;

  var qs = new URLSearchParams(location.search);
  var API = qs.get('api') || localStorage.getItem('curation.api') || 'http://127.0.0.1:8787';
  var GROUPS = null;
  var online = null;

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  var toastEl, mask, card, selPage, selGroup, nameEl, okBtn;

  function toast(msg, isErr, ms) {
    if (!toastEl) {
      toastEl = h('div');
      toastEl.id = 'ed-toast';
      toastEl.hidden = true;
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.className = isErr ? 'err' : '';
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.hidden = true; }, ms || 4200);
  }

  function buildModal() {
    mask = h('div', 'ed-mask');
    mask.hidden = true;
    card = h('div', 'ed-card');
    card.innerHTML =
      '<h3>修改条目</h3>' +
      '<p class="ed-sub" data-role="name"></p>' +
      '<div class="ed-field"><label>归属（放回哪一页）</label><select data-role="page"></select></div>' +
      '<div class="ed-field"><label>分类（分组）</label><select data-role="group"></select></div>' +
      '<p class="ed-note">改「归属」等于搬家：主页 / 候选之间互搬会保留片名与说明；搬到「全量（移出）」后只在全量索引的「已移出」里看得到，以后还能从那里改回来。</p>' +
      '<div class="ed-actions"><button class="ed-btn" data-role="cancel">取消</button><button class="ed-btn primary" data-role="ok">保存</button></div>';
    mask.appendChild(card);
    document.body.appendChild(mask);

    nameEl = card.querySelector('[data-role=name]');
    selPage = card.querySelector('[data-role=page]');
    selGroup = card.querySelector('[data-role=group]');
    okBtn = card.querySelector('[data-role=ok]');

    selPage.addEventListener('change', syncGroupOptions);
    card.querySelector('[data-role=cancel]').addEventListener('click', close);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    okBtn.addEventListener('click', save);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && mask && !mask.hidden) close();
    });
  }

  function pageLabel(p) {
    return p === 'main' ? '主页（片单）' : p === 'cand' ? '候选页' : p === 'full' ? '全量（移出）' : p;
  }

  function syncGroupOptions() {
    var target = selPage.value;
    selGroup.innerHTML = '';
    if (target === 'full') {
      var o = h('option', null, '（全量索引里统一进「已移出」，可再改回）');
      o.value = '';
      selGroup.appendChild(o);
      selGroup.disabled = true;
      return;
    }
    selGroup.disabled = false;
    var list = (GROUPS && GROUPS[target]) || [];
    list.forEach(function (g) {
      var o = h('option', null, g.t + '（' + g.n + '）');
      o.value = g.k;
      selGroup.appendChild(o);
    });
  }

  function open(row) {
    if (online === false) {
      toast('编辑服务没启动：在项目根目录跑 node QTools-C/doc/curation/server.mjs，再刷新本页', true, 8000);
      return;
    }
    if (!mask) buildModal();
    var title = row.dataset.t || '(无标题)';
    nameEl.textContent = title;
    mask.dataset.gid = row.dataset.gid || '';
    mask.dataset.u = row.dataset.u || '';
    mask.dataset.g = row.dataset.g || '';
    mask.dataset.t = title;
    mask.dataset.page = row.dataset.page || '';

    if (!GROUPS) {
      fetch(API + '/api/groups').then(function (r) { return r.json(); }).then(function (g) {
        GROUPS = g;
        selPage.innerHTML = '';
        ['main', 'cand', 'full'].forEach(function (p) {
          if ((p === 'full') && (row.dataset.page === 'full' || row.dataset.page === 'pool')) return; // 已在全量，不用“留在全量”
          var o = h('option', null, p === 'full' ? '全量（移出）' : pageLabel(p));
          o.value = p;
          selPage.appendChild(o);
        });
        selPage.value = row.dataset.page === 'full' || row.dataset.page === 'pool'
          ? (selPage.options[0] && selPage.options[0].value)
          : row.dataset.page;
        syncGroupOptions();
        if (selGroup.value !== row.dataset.g && !selGroup.disabled) {
          for (var i = 0; i < selGroup.options.length; i++) {
            if (selGroup.options[i].value === row.dataset.g) selGroup.value = row.dataset.g;
          }
        }
        mask.hidden = false;
      }).catch(function () {
        toast('连不上编辑服务（' + API + '）', true, 8000);
      });
      return;
    }

    selPage.value = row.dataset.page === 'full' || row.dataset.page === 'pool' ? selPage.options[0].value : row.dataset.page;
    syncGroupOptions();
    if (selGroup.options.length) {
      for (var i = 0; i < selGroup.options.length; i++) {
        if (selGroup.options[i].value === row.dataset.g) selGroup.value = row.dataset.g;
      }
    }
    mask.hidden = false;
  }

  function close() {
    if (mask) mask.hidden = true;
  }

  function save() {
    var payload = {
      from: { page: mask.dataset.page, id: mask.dataset.gid, u: mask.dataset.u, g: mask.dataset.g, t: mask.dataset.t },
      to: { page: selPage.value, group: selGroup.value },
    };
    var same = payload.from.page === payload.to.page;
    if (same && (payload.to.page === 'full' || payload.to.group === payload.from.g)) {
      close();
      toast('归属和分类都没变');
      return;
    }
    okBtn.disabled = true;
    okBtn.textContent = '保存中…';
    fetch(API + '/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); }).then(function (res) {
      okBtn.disabled = false;
      okBtn.textContent = '保存';
      if (!res.ok) throw new Error(res.error || '保存失败');
      close();
      toast('已修改，正在刷新…');
      setTimeout(function () { location.reload(); }, 550);
    }).catch(function (e) {
      okBtn.disabled = false;
      okBtn.textContent = '保存';
      toast('失败：' + e.message, true, 7000);
    });
  }

  function removeRow(row) {
    var title = row.dataset.t || '(无标题)';
    if (!confirm('把「' + title + '」移出？\n它会从本页消失，只留在全量索引的「已移出」里（以后还能改回来）。')) return;
    fetch(API + '/api/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: { page: row.dataset.page, id: row.dataset.gid, u: row.dataset.u, g: row.dataset.g } }),
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (!res.ok) throw new Error(res.error || '移出失败');
      toast('已移出，正在刷新…');
      setTimeout(function () { location.reload(); }, 550);
    }).catch(function (e) {
      toast('失败：' + e.message + (e.message.indexOf('Failed to fetch') >= 0 ? '（服务没启动？）' : ''), true, 7000);
    });
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    var row = btn.closest('[data-page]');
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    if (btn.dataset.act === 'edit') open(row);
    else if (btn.dataset.act === 'remove') removeRow(row);
  }, true);

  // 不主动探活：本页是公开页，服务没起时不该在每个访客脸上报错、也不该在控制台留连接失败。
  // 点「改 / 移出」时自然走 /api/groups 或 /api/move，失败的那条链路会给出提示。

  // 供页面脚本（全量索引是动态渲染）在插入行之后登记按钮
  window.curationEdit = { onReady: function () { } };
})();
