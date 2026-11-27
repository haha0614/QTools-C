// 「隐秘在场」三页的编辑服务：把条目在 主页 / 候选 / 全量（已移出）之间搬家，写回 doc/curation/*.json，
// 然后自动重跑 build-index.mjs + render.mjs 并把产物拷到 dist/curation/。
//
// 用法（项目根目录）：node QTools-C/doc/curation/server.mjs
//   端口默认 8787，可用 PORT 覆盖；只监听 127.0.0.1。
// 页面：http://127.0.0.1/curation/（nginx），按钮会 POST 到 http://127.0.0.1:8787
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');            // QTools-C
const PUB = path.join(ROOT, 'public', 'curation');
const DIST = path.join(ROOT, 'dist', 'curation');
const PORT = Number(process.env.PORT || 8787);

const FILES = {
  main: path.join(HERE, 'data.json'),
  cand: path.join(HERE, 'data.candidates.json'),
  pool: path.join(HERE, 'data.removed.json'),
};

const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};
const writeJson = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n', 'utf8');
const count = (d) => d.groups.reduce((s, g) => s + g.items.length, 0);

function ensurePool() {
  if (!fs.existsSync(FILES.pool)) {
    writeJson(FILES.pool, { generated: new Date().toISOString().slice(0, 10), groups: [{
      key: 'removed', title: '已移出 / 不想要',
      lead: '从主页或候选页移出来的条目。看着还行就点「改」搬回去，彻底不要就留着它。',
      items: [],
    }] });
  }
}

function load(page) {
  if (page === 'main') return readJson(FILES.main, null);
  if (page === 'cand') return readJson(FILES.cand, null);
  if (page === 'pool' || page === 'full') { ensurePool(); return readJson(FILES.pool, null); }
  return null;
}

function findItem(data, id, u) {
  for (const g of data.groups) {
    const i = g.items.findIndex((it) => (id && String(it.id) === String(id)) || (u && it.u === u));
    if (i >= 0) return { group: g, index: i, item: g.items[i] };
  }
  return null;
}

function groupList(page) {
  if (page === 'main' || page === 'cand') {
    const d = load(page);
    return d.groups.map((g) => ({ k: g.key, t: g.title, n: g.items.length }));
  }
  return [];
}

// 站 A 的主题列表由 build-index.mjs 写进 public/curation/themes.json；全量页的「分类」只是主题，不参与搬家
function themes() {
  return readJson(path.join(PUB, 'themes.json'), {});
}

function regen() {
  const run = (script) => {
    const r = spawnSync(process.execPath, [path.join(HERE, script)], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(script + ' 失败：' + (r.stderr || r.stdout || '').slice(0, 400));
  };
  run('build-index.mjs');
  run('render.mjs');
  fs.mkdirSync(DIST, { recursive: true });
  for (const f of ['index.html', 'candidates.html', 'full.html', 'full-data.json', 'themes.json', 'edit.js', 'edit.css']) {
    const src = path.join(PUB, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DIST, f));
  }
}

let busy = false;
const queue = [];

function serial(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    if (!busy) next();
  });
}

function next() {
  const job = queue.shift();
  if (!job) { busy = false; return; }
  busy = true;
  try { job.resolve(job.task()); } catch (e) { job.reject(e); } finally { setImmediate(next); }
}

function moveItem(body) {
  const from = body.from || {};
  const to = body.to || {};
  const srcPage = from.page;
  const dstPage = to.page;
  if (!['main', 'cand', 'pool', 'full'].includes(srcPage)) throw new Error('来源页无效：' + srcPage);
  if (!['main', 'cand', 'full'].includes(dstPage)) throw new Error('目标页无效：' + dstPage);

  // 全量索引里的条目不在任何 curated JSON 里，直接按页面传来的标题/链接新建一条
  if (srcPage === 'full') {
    if (dstPage === 'full') throw new Error('它已经在全量索引里了');
    const dstData = load(dstPage);
    const g = dstData.groups.find((x) => x.key === to.group) || dstData.groups[0];
    if (!g) throw new Error('目标页没有可用的分类');
    const nid = from.id || ('ext-' + String(from.u || Date.now()).replace(/[^a-z0-9]+/gi, '-').slice(-24));
    if (!g.items.some((x) => String(x.id) === String(nid))) {
      g.items.push({ id: nid, n: from.t || '(无标题)', w: '', k: '实拍', ...(from.u ? { u: from.u } : {}) });
    }
    writeJson(FILES[dstPage], dstData);
    return { moved: 1 };
  }

  const srcData = load(srcPage);
  if (!srcData) throw new Error('读不到来源数据');
  const hit = findItem(srcData, from.id, from.u);
  if (!hit) throw new Error('这条在来源页里找不到了，刷新一下再试');
  const item = hit.item;

  // 从 curated（main / cand / pool）搬出
  srcData.groups.forEach((g) => { g.items = g.items.filter((x) => x !== item); });

  if (dstPage === 'full') {
    const pool = load('pool');
    const g = pool.groups.find((x) => x.key === 'removed') || pool.groups[0];
    if (!g.items.some((x) => (item.id && String(x.id) === String(item.id)) || (item.u && x.u === item.u))) {
      g.items.push({ ...item, _from: srcPage, _at: new Date().toISOString().slice(0, 10) });
    }
    writeJson(FILES.pool, pool);
  } else if (dstPage === srcPage) {
    const g = srcData.groups.find((x) => x.key === to.group);
    if (!g) throw new Error('目标分类不存在：' + to.group);
    g.items.push(item);
  } else {
    const dstData = load(dstPage);
    const g = dstData.groups.find((x) => x.key === to.group) || dstData.groups[0];
    if (!g) throw new Error('目标页没有可用的分类');
    if (!g.items.some((x) => String(x.id) === String(item.id))) g.items.push(item);
    writeJson(FILES[dstPage], dstData);
  }

  writeJson(FILES[srcPage === 'pool' ? 'pool' : srcPage], srcData);
  return { moved: 1 };
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

// 只认本机页面：Origin 的 host 必须是 127.0.0.1 / localhost；命令行（无 Origin）照常可用。
function corsFor(req) {
  const o = req.headers.origin;
  if (!o) return {};
  try {
    if (LOCAL_HOSTS.has(new URL(o).hostname)) return { 'Access-Control-Allow-Origin': o, Vary: 'Origin' };
  } catch { }
  return null;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
    ...(res.__cors || {}),
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const cors = corsFor(req);
  if (!cors) return send(res, 403, { ok: false, error: '只接受本机页面的请求' });
  res.__cors = cors;
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, { ok: true, main: count(load('main')), cand: count(load('cand')), pool: count(load('pool')) });
  }
  if (req.method === 'GET' && url.pathname === '/api/groups') {
    return send(res, 200, { main: groupList('main'), cand: groupList('cand'), full: Object.entries(themes()).map(([k, t]) => ({ k, t })) });
  }
  if (req.method === 'POST' && (url.pathname === '/api/move' || url.pathname === '/api/remove')) {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const job = url.pathname === '/api/remove'
        ? () => moveItem({ from: body.from, to: { page: 'full' } })
        : () => moveItem(body);
      serial(job)
        .then(() => {
          regen();
          send(res, 200, { ok: true, main: count(load('main')), cand: count(load('cand')), pool: count(load('pool')) });
        })
        .catch((e) => send(res, 500, { ok: false, error: String(e && e.message || e) }));
    });
    return;
  }
  send(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('编辑服务已启动：http://127.0.0.1:' + PORT + '  （健康检查 /api/health）');
  console.log('页面：http://127.0.0.1/curation/  ·  Ctrl+C 停止');
});
