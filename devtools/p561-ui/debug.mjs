
import { createServer as createNetServer } from 'node:net'
import { createServer, request } from 'node:http'
import { createReadStream, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DIST = join(ROOT, 'dist')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.json':'application/json' }
const srv = createServer((req,res)=>{const url=req.url||'/'
  if(url.startsWith('/api/')){const up=request({host:'127.0.0.1',port:8080,method:req.method,path:url,headers:{...req.headers,host:'127.0.0.1:8080'}},u=>{res.writeHead(u.statusCode||502,u.headers);u.pipe(res)});up.on('error',()=>{res.writeHead(502);res.end('x')});req.pipe(up);return}
  const clean=decodeURIComponent(url.split('?')[0]);let f=join(DIST,clean);if(!existsSync(f)||statSync(f).isDirectory())f=join(DIST,'index.html');if(!existsSync(f)){res.writeHead(404);res.end('nf');return}
  res.writeHead(200,{'content-type':MIME[extname(f).toLowerCase()]||'application/octet-stream'});createReadStream(f).pipe(res)})
await new Promise(r=>srv.listen(0,'127.0.0.1',r))
const ORIGIN='http://127.0.0.1:'+srv.address().port
const cdpPort = await new Promise(r=>{const s=createNetServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})})
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--remote-debugging-port='+cdpPort,'--remote-allow-origins=*','--user-data-dir='+join(tmpdir(),'qt-dbg-profile-'+Date.now()),'--no-first-run','--window-size=1500,1000','about:blank'],{stdio:'ignore'})
let target=null
for(let i=0;i<200&&!target;i++){await new Promise(r=>setTimeout(r,250));try{const l=await (await fetch('http://127.0.0.1:'+cdpPort+'/json/list')).json();target=l.find(t=>t.type==='page')||null}catch{}}
const ws=new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',()=>rej(new Error('ws')))})
let seq=0;const pending=new Map();const logs=[]
ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(!m.id){if(m.method==='Runtime.exceptionThrown')logs.push('[exc] '+(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text));return}const j=pending.get(m.id);if(!j)return;pending.delete(m.id);m.error?j.reject(new Error(m.error.message)):j.resolve(m.result)})
const send=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params:params||{}}))})
const evaluate=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});return r.result.value}
await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate',{url:ORIGIN+'/media'})
await new Promise(r=>setTimeout(r,4000))
const info = await evaluate("(function(){return {path:location.pathname,cards:document.querySelectorAll('.pw-card').length,text:(document.body.innerText||'').slice(0,300)} })()")
console.log(JSON.stringify(info,null,1))
console.log('logs:', logs.slice(0,4).join(' | '))
const r2 = await (await fetch('http://127.0.0.1:8080/api/media/persons?limit=3')).text()
console.log('api persons:', r2.slice(0,300))
const r3 = await (await fetch('http://127.0.0.1:8080/api/media/edit-policy')).text()
console.log('edit-policy:', r3.slice(0,200))
chrome.kill();srv.close();process.exit(0)
