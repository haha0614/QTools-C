
import { parse } from '@vue/compiler-sfc'
import { readFileSync } from 'node:fs'
const src = readFileSync('src/views/media/PersonsPage.vue', 'utf8')
const { descriptor, errors } = parse(src)
console.log('errors', errors.map(e => e.message + ' @' + (e.loc && e.loc.start.line)))
const ast = descriptor.template.ast
function walk(n, d) {
  if (!n || d > 40) return
  if (n.type === 1) console.log(' '.repeat(d) + n.tag + ' @' + n.loc.start.line + '-' + n.loc.end.line)
  for (const c of n.children || []) walk(c, d + 1)
}
walk(ast, 0)
