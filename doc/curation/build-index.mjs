// 生成「全量索引」页：站 A 的 142,819 条标题里，命中 15 个主题的 18,000+ 条。
// 输入优先用 doc/curation/full-titles.json（入仓、换机可用），否则回落到 tmp/a-titles.jsonl（本机爬取结果）。
// 输出：doc/curation/full-titles.json、public/curation/full-data.json、public/curation/full.html
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(here, '..', '..');          // QTools-C
const SITE = path.join(ROOT, 'public', 'curation');
const SRC_JSON = path.join(here, 'full-titles.json');
const SRC_TMP = 'E:/111/project/QTools/tmp/a-titles.jsonl';
const BASE = 'https://tv.guochanjqw.com';

const THEMES = {
  wall:     ['墙与洞',      /墙洞|隔墙|墙头|一墙|墙里|壁穴|洞裏|洞里|墙上有/],
  door:     ['门缝 / 帘',   /门缝|门外|门后|隔门|帘子|隔帘/],
  table:    ['桌下',        /桌下|桌底|桌边偷/],
  closet:   ['衣柜 / 床底', /衣柜|床底|床下|壁橱/],
  husband:  ['夫目前',      /夫前|夫目|当着老公|老公在旁|老公旁边|老公面前|绿帽|淫妻|献妻|寢取|寝取|NTR/i],
  phone:    ['电话 / 屏幕', /打电话|通话中|视频中|语音中|直播中|电话里|连线/],
  unaware:  ['不知情 / 睡着', /不知情|不知道|没发现|熟睡|睡着|昏迷|蒙眼|眼罩|偷偷/],
  neighbor: ['隔壁 / 对面', /隔壁|邻居|对面楼|楼上|楼下|合租|室友/],
  daily:    ['日常入侵',    /办公|开会|会议|打游戏|游戏|做饭|厨房|炒菜|直播|工作/],
  cleaner:  ['保洁 / 上门', /保洁|家政|阿姨|保姆|钟点工|上门|维修|外卖|快递/],
  stuck:    ['卡困',        /卡在|卡住|卡进|夹住|动弹不得|被困|拔不出|洗衣机|墙里/],
  yoga:     ['体式侵入',    /瑜伽|拉伸|劈叉|一字马|深蹲|健身|私教|教练|体操|舞蹈|普拉提|跑步机/],
  mouth:    ['口部入口',    /喂|含住|含着|嘴里|口内|张嘴|吞|咽|灌|迷药|feed|mouth/i],
  blind:    ['盲 / 看不见', /盲女|盲人|失明|看不见|目隠し|蒙眼|眼罩/],
  prank:    ['恶作剧 / 欺骗', /恶作剧|整蛊|捉弄|欺骗|假装|冒充/],
};

let rows;
if (fs.existsSync(SRC_JSON)) {
  rows = JSON.parse(fs.readFileSync(SRC_JSON, 'utf8'));
  console.log(`读入已过滤数据集 ${rows.length} 条（${path.relative(ROOT, SRC_JSON)}）`);
} else {
  const raw = fs.readFileSync(SRC_TMP, 'utf8').split('\n').filter(Boolean);
  const total = raw.length;
  rows = [];
  const seenT = new Set();
  for (const line of raw) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    const key = (o.t || '').trim();
    if (seenT.has(key)) continue;          // 同名不同地址的重复投稿只留第一条
    const ks = Object.entries(THEMES).filter(([, [, re]]) => re.test(key)).map(([k]) => k);
    if (!ks.length) continue;
    seenT.add(key);
    rows.push({ u: o.u, t: o.t, k: ks });
  }
  fs.writeFileSync(SRC_JSON, JSON.stringify(rows));
  console.log(`从 ${total} 条原始标题筛出 ${rows.length} 条命中主题的（同名已去重），已写 ${path.relative(ROOT, SRC_JSON)}`);
}

const counts = Object.fromEntries(Object.keys(THEMES).map((k) => [k, 0]));
for (const r of rows) for (const k of r.k) counts[k]++;

// 「已移出」池：主页 / 候选页用「移出」按钮丢出来的条目，仍要在全量索引里看得到（也可能再搬回去）
const POOL = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'data.removed.json');
let poolItems = [];
try {
  const pool = JSON.parse(fs.readFileSync(POOL, 'utf8'));
  poolItems = pool.groups.flatMap((g) => g.items.map((it) => ({ u: it.u || '', t: it.n || '(无标题)', k: ['removed'], page: 'pool', id: String(it.id || '') })));
} catch { poolItems = []; }
counts.removed = poolItems.length;
const THEME_LABELS = Object.fromEntries(Object.entries(THEMES).map(([k, [label]]) => [k, label]));
THEME_LABELS.removed = '已移出 / 不想要';

fs.mkdirSync(SITE, { recursive: true });
fs.writeFileSync(path.join(SITE, 'themes.json'), JSON.stringify(THEME_LABELS));
fs.writeFileSync(path.join(SITE, 'full-data.json'), JSON.stringify({
  base: BASE,
  total: rows.length + poolItems.length,
  counts,
  items: rows.map((r) => [r.u, r.t, r.k]).concat(poolItems.map((p) => [p.u, p.t, p.k, p.page, p.id])),
}), 'utf8');

const themesJs = JSON.stringify(THEME_LABELS);

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>隐秘在场 · 全量索引</title>
<link rel="stylesheet" href="edit.css">
<style>
  :root{--bg:#0f1115;--panel:#151a21;--line:#232a35;--fg:#e6e9ef;--dim:#8b94a5;--accent:#e05a6d;--ok:#63c08a;--ai:#a78bfa;--anime:#5ec8d8;--show:#e0b05a;--mix:#8aa0c0}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  header{position:sticky;top:0;z-index:9;background:rgba(15,17,21,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:12px 20px 10px}
  .head-top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
  h1{font-size:17px;margin:0}
  .meta{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}
  .back{font-size:12.5px;color:var(--dim);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:2px 10px;white-space:nowrap}
  .back:hover{color:var(--fg);border-color:var(--accent)}
  .tools{display:flex;gap:8px;margin-top:9px;flex-wrap:wrap}
  input{background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:7px 10px;font:inherit;font-size:13px;outline:none;flex:1;min-width:220px}
  input:focus{border-color:var(--accent)}
  .chips{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap}
  .kb{font:inherit;font-size:12px;background:transparent;border:1px solid var(--line);color:var(--dim);border-radius:6px;padding:2px 9px;cursor:pointer}
  .kb:hover{color:var(--fg);border-color:#3a4353}
  .kb.on{background:var(--fg);color:#0f1115;border-color:var(--fg);font-weight:600}
  .kb .n{opacity:.6;margin-left:4px;font-variant-numeric:tabular-nums}
  main{padding:16px 20px 80px;max-width:1080px;margin:0 auto}
  .bar{color:var(--dim);font-size:12.5px;margin:2px 0 10px;display:flex;gap:10px;flex-wrap:wrap}
  ul{list-style:none;margin:0;padding:0}
  li{margin:0 0 6px}
  .row{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--line);border-radius:9px;padding:8px 11px;background:var(--panel);color:inherit;text-decoration:none}
  .row:hover{border-color:#3a4353;background:#191e26}
  .row:hover .t{color:var(--accent)}
  .t{flex:1;min-width:0;font-weight:500}
  .tg{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;flex:none;max-width:46%}
  .tag{font-size:11px;border-radius:5px;padding:0 6px;border:1px solid currentColor;color:var(--dim);white-space:nowrap}
  .src{font-size:11px;border-radius:5px;padding:0 6px;border:1px solid var(--dim);color:var(--dim);white-space:nowrap;flex:none}
  .more{display:block;margin:14px auto;padding:8px 16px;font:inherit;font-size:13px;background:transparent;border:1px solid var(--line);color:var(--dim);border-radius:8px;cursor:pointer}
  .more:hover{color:var(--fg);border-color:var(--accent)}
  .foot{color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:14px;margin-top:20px}
  .foot code{color:#c9d1e0}
  .empty{color:var(--dim);font-size:13px;padding:14px 2px}
  @media (max-width:640px){
    header{position:static;padding:10px 14px 8px}
    .head-top{gap:8px}
    h1{font-size:15px}
    .back{font-size:11.5px;padding:2px 8px}
    .meta{font-size:11.5px;flex:1 1 100%}
    input{min-width:0;width:100%;font-size:13px}
    .chips{flex-wrap:nowrap;overflow-x:auto;padding-bottom:2px;scrollbar-width:none;-webkit-overflow-scrolling:touch;mask-image:linear-gradient(90deg,#000 calc(100% - 26px),transparent)}
    .chips::-webkit-scrollbar{display:none}
    .kb{flex:none}
    main{padding:14px 14px 70px}
    .bar{font-size:11.5px}
    .row{flex-wrap:wrap;gap:6px;padding:8px 10px}
    .t{flex:1 1 100%;font-size:13.5px;line-height:1.45}
    .tg{max-width:100%;justify-content:flex-start;order:2}
    .src{order:3;font-size:10.5px}
    .tag{font-size:10.5px}
    .more{width:100%}
    .foot{font-size:11.5px}
  }
</style>
</head>
<body>
<header>
  <div class="head-top">
    <a class="back" href="/tool/mrds">← 每日大赛</a>
    <a class="back" href="/curation/">← 片单</a>
    <h1>「隐秘在场」全量索引</h1>
    <span class="meta" id="meta">载入中…</span>
  </div>
  <div class="tools">
    <input id="q" placeholder="搜标题关键词（按 / 聚焦）—— 如 隔墙、桌下、瑜伽、保洁、夫前">
  </div>
  <div class="chips" id="chips"></div>
</header>
<main>
  <div class="bar"><span id="count">—</span><span>整行可点跳详情页；行尾「改」可改分类或搬到主页、候选（需本地编辑服务在跑）。这里只索引标题，不做人工复核。</span></div>
  <ul id="list"></ul>
  <button class="more" id="more" hidden>加载更多</button>
  <div class="foot">
    数据：站 A 的 sitemap 共 142,902 个详情页，抓到 142,819 条标题（99.94%）；本页是其中命中 15 个主题的条目，<b>未人工复核</b>，可能混进同名系列、综艺整蛊、普通口交。<br>
    生成：<code>node QTools-C/doc/curation/build-index.mjs</code>；口径与爬取过程见 HANDOFF §30.5。
  </div>
</main>
<script>
const THEMES = ${themesJs};
const PAGE = 200;
let data = null, items = [], active = '', q = '', shown = 0;

const el = (s) => document.querySelector(s);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function apply() {
  const ql = q.trim().toLowerCase();
  items = data.items.filter(([u, t, ks]) => {
    if (active && !ks.includes(active)) return false;
    if (ql && !t.toLowerCase().includes(ql)) return false;
    return true;
  });
  shown = 0;
  el('#list').innerHTML = '';
  el('#count').textContent = (ql || active ? '筛出 ' : '共 ') + items.length.toLocaleString() + ' 条' + (ql || active ? ' / ' + data.total.toLocaleString() : '');
  paint();
}

function paint() {
  const slice = items.slice(shown, shown + PAGE);
  const frag = document.createDocumentFragment();
  for (const [u, t, ks, pg, id] of slice) {
    const page = pg || 'full';
    const li = document.createElement('li');
    li.className = 'has-acts';
    li.dataset.page = page;
    li.dataset.gid = id || '';
    li.dataset.u = u || '';
    li.dataset.g = (ks && ks[0]) || '';
    li.dataset.t = t;

    const a = document.createElement('a');
    a.className = 'row';
    a.href = u || ('/tool/mrds/post/' + id);
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.innerHTML = '<span class="t">' + esc(t) + '</span>' +
      '<span class="tg">' + ks.map((k) => '<span class="tag">' + (THEMES[k] || k) + '</span>').join('') + '</span>' +
      '<span class="src">' + (page === 'pool' ? '已移出' : u ? '源站' : '站内') + '</span>';

    const acts = document.createElement('span');
    acts.className = 'acts';
    acts.innerHTML = '<button class="act" data-act="edit" title="改分类或搬到主页 / 候选">改</button>';

    li.appendChild(a);
    li.appendChild(acts);
    frag.appendChild(li);
  }
  el('#list').appendChild(frag);
  shown += slice.length;
  el('#more').hidden = shown >= items.length;
  if (!items.length) el('#list').innerHTML = '<li class="empty">没有命中，换个词试试。</li>';
}

el('#more').addEventListener('click', paint);
if ('IntersectionObserver' in window) {
  new IntersectionObserver((es) => {
    if (es.some((e) => e.isIntersecting) && shown < items.length) paint();
  }, { rootMargin: '800px' }).observe(el('#more'));
}
el('#q').addEventListener('input', (e) => { q = e.target.value; apply(); });
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== el('#q')) { e.preventDefault(); el('#q').focus(); }
  if (e.key === 'Escape') { el('#q').blur(); }
});

fetch('full-data.json? v=1'.replace(' ', ''))
  .then((r) => r.json())
  .then((d) => {
    data = d;
    el('#meta').textContent = d.total.toLocaleString() + ' 条命中 · 15 个主题 · 全部有片';
    const chips = document.createElement('div');
    chips.className = 'chips';
    const mk = (k, label, n) => {
      const b = document.createElement('button');
      b.className = 'kb' + (k === '' ? ' on' : '');
      b.innerHTML = label + (n != null ? '<span class="n">' + n.toLocaleString() + '</span>' : '');
      b.onclick = () => {
        active = k;
        document.querySelectorAll('.kb').forEach((x) => x.classList.toggle('on', x === b));
        apply();
      };
      return b;
    };
    el('#chips').appendChild(mk('', '全部', d.total));
    for (const [k, label] of Object.entries(THEMES)) {
      if (k === 'removed' && !d.counts[k]) continue;
      el('#chips').appendChild(mk(k, label, d.counts[k]));
    }
    apply();
  })
  .catch(() => { el('#meta').textContent = '数据加载失败'; el('#list').innerHTML = '<li class="empty">full-data.json 没加载到。</li>'; });
</script>
<script src="edit.js"></script>
</body>
</html>
`;

fs.writeFileSync(path.join(SITE, 'full.html'), html);
console.log(`写入 ${path.relative(ROOT, path.join(SITE, 'full.html'))}（${(html.length / 1024).toFixed(0)} KB）`);
console.log(`写入 ${path.relative(ROOT, path.join(SITE, 'full-data.json'))}（${(fs.statSync(path.join(SITE, 'full-data.json')).size / 1024 / 1024).toFixed(2)} MB）`);
console.log('主题计数 ' + JSON.stringify(counts));
