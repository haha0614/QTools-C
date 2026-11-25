// 生成「隐秘在场」片单
// 用法：node QTools-C/doc/curation/render.mjs
// 输出三份：doc/curation/隐秘在场-片单.md、doc/curation/隐秘在场-片单.html（离线看）、
//          public/curation/index.html（站内，构建后即 http://<域名>/curation/）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const dataPath = path.join(here, 'data.json');
const outDir = here;
const siteDir = path.join(root, 'QTools-C', 'public', 'curation');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const BASE = 'http://127.0.0.1';

const all = data.groups.flatMap((g) => g.items);
const total = all.length;
const kinds = [...new Set(all.map((i) => i.k))];

// ---------- markdown ----------
const md = [];
md.push('# 「隐秘在场」片单');
md.push('');
md.push('> 口径：源站目录 `tool_web_post` 共 58,821 条（52,609 条有片），按标题正则初筛 972 条有片，人工复核后保留 ' + total + ' 条。');
md.push('> 全部 `has_video=1`。链接格式 `' + BASE + '/tool/mrds/post/{id}`，换成你平时访问的域名即可。');
md.push('> 生成：' + data.generated + ' · 未改库；本站入口在每日大赛工具栏右上角，地址 `/curation/`。');
md.push('');
md.push('## 怎么用');
md.push('');
md.push('- 分组按「屏障」从硬到软：**墙洞 → 门缝 → 家具 → 人 → 信号 → 无意识**。想看哪一种，直接跳那一节。');
md.push('- 编号就是详情页路径末段，点编号能跳。');
md.push('- 系列剧集按集序列出，按顺序看；标「AI剧」的多为 AI 生成的短剧，标「动画」的是 2D/里番，其余是实拍。');
md.push('');
md.push('| 组 | 条数 | 一句话 |');
md.push('|---|---|---|');
data.groups.forEach((g) => {
  md.push('| ' + g.title + ' | ' + g.items.length + ' | ' + g.lead.split('。')[0] + ' |');
});
md.push('');
data.groups.forEach((g, gi) => {
  md.push('## ' + (gi + 1) + '. ' + g.title + '（' + g.items.length + '）');
  md.push('');
  md.push(g.lead);
  md.push('');
  g.items.forEach((it) => {
    md.push('- [' + it.id + '](' + BASE + '/tool/mrds/post/' + it.id + ') **' + it.n + '** — ' + it.w);
  });
  md.push('');
});
md.push('## 缺口（找不到的部分）');
md.push('');
md.push('- **盲女被偷偷喂东西**：全库只有 `63211` 一部《盲女的惊喜》沾边，而且不是“喂食”这个动作。这条路上源站基本是空的。');
md.push('- **恶作剧 / 整蛊型的温柔欺骗**：标题命中 12 条，全是综艺整蛊，没有一条是“她以为在正常吃饭，其实被安排了”。');
md.push('- **墙头有杏 第7集**（`354291`）没有片源，只有标题，所以没列进来。');
md.push('- 另有 8 条是 3D/PMV 二次创作（`16867` `21207` `28198` `44752` `46163` `56158` `57275` `58754`），机制对，但不是实拍，没混进主表。');
md.push('');
md.push('## 想自己再捞时用这些词');
md.push('');
md.push('`墙洞` `隔墙` `墙头` `一墙之隔` `门缝` `门后` `门外` `帘子` `隔间` `桌下` `桌底` `衣柜` `床底` `夫前` `夫目` `当着老公` `当着丈夫` `当着男友` `旁边` `打电话` `查岗` `视频通话` `睡着` `熟睡` `蒙眼` `眼罩` `盲` `差点撞破` `撞见` `隔壁` `邻居` `对面楼` `偷窥`');
md.push('');
md.push('搜索框是**标题 + 标签**同时命中；标签多选是“包含任一”，点一个就够，点多了反而变宽。');
md.push('');

fs.writeFileSync(path.join(outDir, '隐秘在场-片单.md'), md.join('\n'), 'utf8');

// ---------- html ----------
// site=true 时额外塞一个「返回每日大赛」的入口；离线版不需要（从哪来回哪去没有意义）
function buildHtml(site) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>隐秘在场 · 片单</title>
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
  li{display:flex;gap:12px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;background:var(--panel);align-items:flex-start}
  li:hover{border-color:#3a4353}
  li.hide{display:none}
  .id{font-variant-numeric:tabular-nums;font-size:12px;color:#0f1115;background:var(--dim);border-radius:6px;padding:1px 7px;text-decoration:none;flex:none;margin-top:2px;font-weight:600}
  .id:hover{background:var(--accent);color:#fff}
  .body{flex:1;min-width:0}
  .name{font-weight:600}
  .why{color:var(--dim);font-size:13px;margin-top:2px}
  .k{font-size:11px;border-radius:5px;padding:0 6px;margin-left:8px;border:1px solid currentColor;white-space:nowrap}
  .k-实拍{color:var(--ok)} .k-AI剧{color:var(--ai)} .k-动画{color:var(--anime)} .k-综艺{color:var(--show)} .k-混剪{color:var(--mix)}
  .empty{color:var(--dim);font-size:13px;padding:8px 2px}
  .foot{color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
  .foot code{color:#c9d1e0}
</style>
</head>
<body>
<header>
  <div class="head-top">
    ${site ? '<a class="back" href="/tool/mrds">← 每日大赛</a>' : ''}
    <h1>「隐秘在场」片单</h1>
    <span class="meta" id="meta">${total} 条 · ${data.groups.length} 组 · 全部有片 · ${data.generated}</span>
  </div>
  <div class="tools">
    <input id="q" placeholder="搜片名 / 编号 / 关键词（按 / 聚焦）">
    <input id="base" value="${BASE}" title="站点地址，改这里所有链接跟着变">
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
${g.items.map((it) => `      <li data-k="${it.k}" data-s="${(it.n + ' ' + it.w + ' ' + it.id + ' ' + it.k).toLowerCase()}"><a class="id" href="${BASE}/tool/mrds/post/${it.id}" target="_blank" rel="noreferrer">${it.id}</a><div class="body"><div class="name">${it.n}<span class="k k-${it.k}">${it.k}</span></div><div class="why">${it.w}</div></div></li>`).join('\n')}
    </ul>
  </section>`).join('\n')}
  <div class="foot">
    口径：<code>tool_web_post</code> 共 58,821 条，标题正则初筛 972 条后人工复核，全部 <code>has_video=1</code>。未改库；本页是 <code>public/curation/</code> 静态页。<br>
    缺口：盲女被偷喂（仅 63211 沾边）、温柔恶作剧（12 条全是整蛊综艺）、墙头有杏第7集（354291 无片源）。
  </div>
</main>
<script>
  const base = document.getElementById('base');
  const q = document.getElementById('q');
  function applyBase(){
    const b = (base.value || '').replace(/\\/+$/, '');
    document.querySelectorAll('a.id').forEach(a => { a.href = b + '/tool/mrds/post/' + a.textContent.trim(); });
  }
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
      ? (shown + ' / ${total} 条 · ${data.generated}')
      : ('${total} 条 · ${data.groups.length} 组 · 全部有片 · ${data.generated}');
  }
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
  });
</script>
</body>
</html>
`;
}

fs.writeFileSync(path.join(outDir, '隐秘在场-片单.html'), buildHtml(false), 'utf8');
fs.mkdirSync(siteDir, { recursive: true });
fs.writeFileSync(path.join(siteDir, 'index.html'), buildHtml(true), 'utf8');
console.log('md   ' + fs.statSync(path.join(outDir, '隐秘在场-片单.md')).size + ' bytes');
console.log('html ' + fs.statSync(path.join(outDir, '隐秘在场-片单.html')).size + ' bytes');
console.log('site ' + fs.statSync(path.join(siteDir, 'index.html')).size + ' bytes');
console.log('items ' + total + ' / groups ' + data.groups.length + ' / kinds ' + kinds.join(','));
