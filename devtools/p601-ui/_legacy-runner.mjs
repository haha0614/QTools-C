import { spawn } from 'node:child_process'
import { writeFileSync, appendFileSync } from 'node:fs'

const NODE = process.execPath
const API = 'http://127.0.0.1:8080/api/media/persons'
const LOG = 'devtools/p601-ui/legacy-harness.log'
writeFileSync(LOG, '')
const log = (s) => { appendFileSync(LOG, s + '\n'); console.log(s) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function visible() {
  try {
    const r = await fetch(API, { signal: AbortSignal.timeout(4000) })
    const t = await r.text()
    return t.trim() !== '[]' && t.trim().length > 2
  } catch (e) { return false }
}
async function waitVisible(maxMs) {
  const end = Date.now() + maxMs
  while (Date.now() < end) { if (await visible()) return true; await sleep(4000) }
  return false
}
function run(cmd, args) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => { out += String(d) })
    p.stderr.on('data', (d) => { out += String(d) })
    p.on('exit', (code) => res({ code, out }))
  })
}

for (const h of ['p590', 'p593', 'p594', 'p598']) {
  let doneOk = false
  for (let attempt = 1; attempt <= 4 && !doneOk; attempt++) {
    const up = await waitVisible(240000)
    if (!up) { log('[' + h + '] attempt ' + attempt + ': 等不到 /api/media/persons 有数据（guest_visible=0），跳过'); continue }
    log('[' + h + '] attempt ' + attempt + ': 数据可见，开跑 ' + new Date().toISOString())
    const r = await run(NODE, ['devtools/' + h + '-ui/run.mjs'])
    const tail = r.out.split('\n').filter((l) => /PASS |FAIL /.test(l)).slice(-6).join('\n')
    log('[' + h + '] attempt ' + attempt + ' exit=' + r.code + '\n' + tail)
    writeFileSync('devtools/' + h + '-ui/run-p601.log', r.out)
    if (r.code === 0) doneOk = true
  }
  log('[' + h + '] => ' + (doneOk ? 'OK' : 'FAILED'))
}
log('ALL DONE')
