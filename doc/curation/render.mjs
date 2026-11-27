// 生成「隐秘在场」片单（主表 + 候选取）
// 用法：node QTools-C/doc/curation/render.mjs
// 输出：
//   doc/curation/隐秘在场-片单.md / .html          主表（离线）
//   doc/curation/候选-片单.md / .html              候选取（离线）
//   public/curation/index.html                     站内主表 → /curation/
//   public/curation/candidates.html                站内候选取 → /curation/candidates.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const siteDir = path.join(root, 'QTools-C', 'public', 'curation');
const BASE = 'http://127.0.0.1';

const main = JSON.parse(fs.readFileSync(path.join(here, 'data.json'), 'utf8'));
const candPath = path.join(here, 'data.candidates.json');
const cand = fs.existsSync(candPath) ? JSON.parse(fs.readFileSync(candPath, 'utf8')) : { generated: '', groups: [] };

// 全量索引页（build-index.mjs 产出）的条数，用于页头入口；没生成过就藏入口
let fullTotal = 0;
try { fullTotal = JSON.parse(fs.readFileSync(path.join(siteDir, 'full-data.json'), 'utf8')).total || 0; } catch { }

const count = (d) => d.groups.reduce((s, g) => s + g.items.length, 0);
const kindsOf = (d) => [...new Set(d.groups.flatMap((g) => g.items).map((i) => i.k))];

// ---------- markdown ----------
function buildMd(data, opt) {
  const total = count(data);
  const md = [];
  md.push('# ' + opt.mdTitle);
  md.push('');
  md.push('> ' + opt.mdNote);
  md.push('> 生成：' + data.generated + ' · 未改库。');
  md.push('');
  md.push('| 组 | 条数 | 一句话 |');
  md.push('|---|---|---|');
  data.groups.forEach((g) => md.push('| ' + g.title + ' | ' + g.items.length + ' | ' + g.lead.split('。')[0] + ' |'));
  md.push('');
  data.groups.forEach((g, gi) => {
    md.push('## ' + (gi + 1) + '. ' + g.title + '（' + g.items.length + '）');
    md.push('');
    md.push(g.lead);
    md.push('');
    g.items.forEach((it) => {
      md.push('- [' + it.id + '](' + (it.u || BASE + '/tool/mrds/post/' + it.id) + ') **' + it.n + '** — ' + it.w + (it.u ? '（源站）' : ''));
    });
    md.push('');
  });
  md.push(opt.mdFoot || '');
  md.push('');
  return md.join('\n');
}

fs.writeFileSync(path.join(here, '隐秘在场-片单.md'), buildMd(main, {
  mdTitle: '「隐秘在场」片单',
  mdNote: '口径：源站目录 `tool_web_post` 共 58,821 条（52,609 条有片），按标题正则初筛 972 条有片，人工复核后保留 ' + count(main) + ' 条；全部 `has_video=1`。站内条目链接格式 `' + BASE + '/tool/mrds/post/{id}`，换成你平时访问的域名即可；带「（源站）」的是站外直链。',
  mdFoot: [
    '## 缺口（找不到的部分）',
    '',
    '- **盲女被偷偷喂东西**：主表里没有完全对得上的，只有 63211 一部沾边。',
    '- **恶作剧 / 整蛊型**：主表 12 条命中全是综艺整蛊，没有“她以为在正常吃饭，其实被安排了”这种。',
    '- 候选取里这两类各有 30 条自动分桶结果，还没人工筛：见 `候选-片单.md`。',
  ].join('\n'),
}), 'utf8');

fs.writeFileSync(path.join(here, '候选-片单.md'), buildMd(cand, {
  mdTitle: '「隐秘在场」候选取',
  mdNote: '这些是外部站检索命中的候选，按关键词自动分桶，**没有人工复核**；看中哪条把编号发我，我挪进主表。',
  mdFoot: '主表见 `隐秘在场-片单.md`。',
}), 'utf8');

// ---------- html ----------
function buildHtml(data, opt) {
  const total = count(data);
  const kinds = kindsOf(data);
  const back = opt.links.map((l) => `<a class="back" href="${l.href}">${l.label}</a>`).join('\n    ');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${opt.title}</title>
<style>
  :root{
    --bg:#0f1115; --panel:#161a21; --line:#262c36; --fg:#e7e9ee; --dim:#8b93a3;
    --accent:#e0577f; --chip:#1d232c; --ok:#4ea8de; --ai:#c084fc; --anime:#5eead4; --show:#fbbf24; --mix:#94a3b8;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  header{position:sticky;top:0;z-index:9;background:rgba(15,17,21,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:14px 20px 10px}
  .head-top{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
  h1{font-size:18px;margin:0;letter-spacing:.5px}
  .back{font-size:12.5px;color:var(--dim);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:2px 10px;white-space:nowrap}
  .back:hover{color:var(--fg);border-color:var(--accent)}
  .meta{color:var(--dim);font-size:12px}
  .tools{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
  input{background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:7px 10px;font:inherit;font-size:13px;outline:none}
  input:focus{border-color:var(--accent)}
  #q{flex:1;min-width:220px}
  #base{width:210px;color:var(--dim)}
  .nav{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
  .nav a{font-size:12px;color:var(--dim);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:3px 10px}
  .nav a:hover{color:var(--fg);border-color:var(--accent)}
  .kinds{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap}
  .kb{font:inherit;font-size:12px;background:transparent;border:1px solid var(--line);color:var(--dim);border-radius:6px;padding:2px 9px;cursor:pointer}
  .kb:hover{color:var(--fg);border-color:#3a4353}
  .kb.on{background:var(--fg);color:#0f1115;border-color:var(--fg);font-weight:600}
  main{padding:22px 20px 80px;max-width:1000px;margin:0 auto}
  section{margin:0 0 34px}
  .sec-h{display:flex;align-items:baseline;gap:10px;margin:0 0 4px}
  h2{font-size:16px;margin:0}
  .cnt{color:var(--dim);font-size:12px}
  .lead{color:var(--dim);font-size:13px;margin:0 0 14px;padding-left:2px}
  ul{list-style:none;margin:0;padding:0}
  li{border:1px solid var(--line);border-radius:10px;margin-bottom:8px;background:var(--panel);transition:border-color .12s,background .12s}
  li:hover{border-color:#3a4353;background:#191e26}
  li.hide{display:none}
  .hit{display:flex;gap:12px;padding:10px 12px;align-items:flex-start;color:inherit;text-decoration:none;cursor:pointer}
  .hit:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:10px}
  .id{font-variant-numeric:tabular-nums;font-size:12px;color:#0f1115;background:var(--dim);border-radius:6px;padding:1px 7px;flex:none;margin-top:2px;font-weight:600}
  .hit:hover .id{background:var(--accent);color:#fff}
  .body{flex:1;min-width:0;display:block}
  .name{font-weight:600;display:block}
  .hit:hover .name{color:var(--accent)}
  .why{color:var(--dim);font-size:13px;margin-top:2px;display:block}
  .src{font-size:11px;border-radius:5px;padding:0 6px;margin-left:8px;border:1px solid var(--dim);color:var(--dim);white-space:nowrap}
  .k{font-size:11px;border-radius:5px;padding:0 6px;margin-left:8px;border:1px solid currentColor;white-space:nowrap}
  .k-实拍{color:var(--ok)} .k-AI剧{color:var(--ai)} .k-动画{color:var(--anime)} .k-综艺{color:var(--show)} .k-混剪{color:var(--mix)}
  .empty{color:var(--dim);font-size:13px;padding:8px 2px}
  .foot{color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
  .foot code{color:#c9d1e0}
  @media (max-width:640px){
    header{position:static;padding:10px 14px 8px}
    .head-top{gap:8px}
    h1{font-size:16px}
    .back{font-size:11.5px;padding:2px 8px}
    .meta{font-size:11.5px;flex:1 1 100%}
    .tools{margin-top:8px}
    #q{min-width:0;width:100%}
    #base{display:none}
    .kinds{margin-top:8px;gap:5px}
    .nav{margin-top:8px;flex-wrap:nowrap;overflow-x:auto;padding-bottom:2px;scrollbar-width:none;-webkit-overflow-scrolling:touch;mask-image:linear-gradient(90deg,#000 calc(100% - 26px),transparent)}
    .nav::-webkit-scrollbar{display:none}
    .nav a{flex:none}
    main{padding:14px 14px 60px}
    section{margin-bottom:26px}
    h2{font-size:15px}
    .lead{font-size:12.5px;margin-bottom:10px}
    li{margin-bottom:6px}
    .hit{gap:8px;padding:9px 10px}
    .id{font-size:11px;padding:1px 6px;margin-top:1px}
    .name{font-size:14px;line-height:1.45}
    .why{font-size:12px;line-height:1.5;margin-top:3px}
    .k,.src{font-size:10.5px;margin-left:6px;padding:0 5px}
    .foot{font-size:11.5px}
  }
</style>
</head>
<body>
<header>
  <div class="head-top">
    ${back}
    <h1>${opt.heading}</h1>
    <span class="meta" id="meta">${total} 条 · ${data.groups.length} 组 · ${opt.metaTail} · ${data.generated}</span>
  </div>
  <div class="tools">
    <input id="q" placeholder="搜片名 / 编号 / 关键词（按 / 聚焦）">
    <input id="base" value="${BASE}" title="站点地址：站内条目按它拼链接（默认取当前域名，站外条目不受影响）">
  </div>
  <div class="kinds">
    <button class="kb on" data-k="">全部</button>
    ${kinds.map((k) => `<button class="kb k-${k}" data-k="${k}">${k}</button>`).join('\n    ')}
  </div>
  <nav class="nav">
    ${data.groups.map((g, i) => `<a href="#g${i}">${g.title.replace(/ /g, '')} ${g.items.length}</a>`).join('\n    ')}
  </nav>
</header>
<main>
${data.groups.map((g, i) => `  <section id="g${i}">
    <div class="sec-h"><h2>${i + 1}. ${g.title}</h2><span class="cnt">${g.items.length} 条</span></div>
    <p class="lead">${g.lead}</p>
    <ul>
${g.items.map((it) => `      <li data-k="${it.k}" data-s="${(it.n + ' ' + it.w + ' ' + it.id + ' ' + it.k).toLowerCase()}"><a class="hit" data-path="/tool/mrds/post/${it.id}"${it.u ? ` data-ext="${it.u}"` : ''} href="${it.u || '/tool/mrds/post/' + it.id}" target="_blank" rel="noreferrer"><span class="id">${it.id}</span><span class="body"><span class="name">${it.n}<span class="k k-${it.k}">${it.k}</span>${it.u ? '<span class="src">源站</span>' : ''}</span><span class="why">${it.w}</span></span></a></li>`).join('\n')}
    </ul>
  </section>`).join('\n')}
  <div class="foot">
    ${opt.foot}
  </div>
</main>
<script>
  const TOTAL = ${total}, GROUPS = ${data.groups.length};
  const base = document.getElementById('base');
  const q = document.getElementById('q');
  // 站内条目按“当前打开本页的域名”拼链接：同一份静态页放到 127.0.0.1、局域网 IP、正式域名下都跳对
  const DEF_BASE = location.protocol === 'file:' ? '${BASE}' : location.origin;
  base.value = DEF_BASE;
  function applyBase(){
    const b = (base.value || DEF_BASE).replace(/\\/+$/, '');
    document.querySelectorAll('a.hit').forEach(a => {
      if (a.dataset.ext) return;   // 站外条目固定走源站，不受这里影响
      a.href = b + a.dataset.path;
    });
  }
  applyBase();
  base.addEventListener('change', applyBase);
  base.addEventListener('keydown', e => { if (e.key === 'Enter') applyBase(); });
  q.addEventListener('input', filter);
  let kind = '';
  document.querySelectorAll('.kb').forEach(b => b.addEventListener('click', () => {
    kind = b.dataset.k;
    document.querySelectorAll('.kb').forEach(x => x.classList.toggle('on', x === b));
    filter();
  }));
  function filter(){
    const v = q.value.trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll('main section').forEach(sec => {
      let n = 0;
      sec.querySelectorAll('li').forEach(li => {
        const hit = (!v || li.dataset.s.includes(v)) && (!kind || li.dataset.k === kind);
        li.classList.toggle('hide', !hit);
        if (hit) n++;
      });
      sec.style.display = n ? '' : 'none';
      shown += n;
      const c = sec.querySelector('.cnt');
      if (c) c.textContent = (v || kind) ? (n + ' / ' + sec.querySelectorAll('li').length + ' 条') : (sec.querySelectorAll('li').length + ' 条');
    });
    document.getElementById('meta').textContent = (v || kind)
      ? (shown + ' / ' + TOTAL + ' 条 · ${data.generated}')
      : (TOTAL + ' 条 · ' + GROUPS + ' 组 · ${opt.metaTail} · ${data.generated}');
  }
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
  });
</script>
</body>
</html>
`;
}

const candTotal = count(cand);

const FOOT_MAIN = '口径：<code>tool_web_post</code> 共 58,821 条，标题正则初筛 972 条后人工复核，全部 <code>has_video=1</code>。未改库；本页是 <code>public/curation/</code> 静态页。整行可点：站内条目跳 <code>/tool/mrds/post/{id}</code>，只有源站链接的条目跳源站。<br>缺口：盲女被偷喂（仅 63211 沾边）、温柔恶作剧（12 条全是整蛊综艺）、墙头有杏第7集（354291 无片源）。候选另见 <code>/curation/candidates.html</code>。';
const FOOT_CAND = '这些是外部站检索命中的候选，按关键词自动分桶，<b>没有人工复核</b>——里面会有“眼罩当盲人”“综艺整蛊”这类噪声。看中哪条把编号发我，我挪进主表。<br>生成：<code>node QTools-C/doc/curation/render.mjs</code>。';

const mainSite = buildHtml(main, {
  title: '隐秘在场 · 片单',
  heading: '「隐秘在场」片单',
  metaTail: '全部有片',
  links: [
    { href: '/tool/mrds', label: '← 每日大赛' },
    ...(candTotal ? [{ href: '/curation/candidates.html', label: `候选取 ${candTotal} ↗` }] : []),
    ...(fullTotal ? [{ href: '/curation/full.html', label: `全量索引 ${fullTotal.toLocaleString()} ↗` }] : []),
  ],
  foot: FOOT_MAIN,
});

const candSite = buildHtml(cand, {
  title: '隐秘在场 · 候选取',
  heading: '「隐秘在场」候选取',
  metaTail: '自动分桶 · 未复核',
  links: [
    { href: '/tool/mrds', label: '← 每日大赛' },
    { href: '/curation/', label: '← 回片单' },
    ...(fullTotal ? [{ href: '/curation/full.html', label: `全量索引 ${fullTotal.toLocaleString()} ↗` }] : []),
  ],
  foot: FOOT_CAND,
});

fs.writeFileSync(path.join(here, '隐秘在场-片单.html'), buildHtml(main, {
  title: '隐秘在场 · 片单', heading: '「隐秘在场」片单', metaTail: '全部有片', links: [], foot: FOOT_MAIN,
}), 'utf8');

fs.writeFileSync(path.join(here, '候选-片单.html'), buildHtml(cand, {
  title: '隐秘在场 · 候选取', heading: '「隐秘在场」候选取', metaTail: '自动分桶 · 未复核', links: [], foot: FOOT_CAND,
}), 'utf8');

fs.mkdirSync(siteDir, { recursive: true });
fs.writeFileSync(path.join(siteDir, 'index.html'), mainSite, 'utf8');
fs.writeFileSync(path.join(siteDir, 'candidates.html'), candSite, 'utf8');

console.log('md    ' + fs.statSync(path.join(here, '隐秘在场-片单.md')).size + ' / ' + fs.statSync(path.join(here, '候选-片单.md')).size + ' bytes');
console.log('html  ' + fs.statSync(path.join(here, '隐秘在场-片单.html')).size + ' / ' + fs.statSync(path.join(here, '候选-片单.html')).size + ' bytes');
console.log('site  ' + fs.statSync(path.join(siteDir, 'index.html')).size + ' / ' + fs.statSync(path.join(siteDir, 'candidates.html')).size + ' bytes');
console.log('items ' + count(main) + ' / ' + count(cand));
