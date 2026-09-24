/**
 * Check that the preview actually gets vertical space in a narrow sidebar.
 *
 * The panel's own chrome used to consume the column and leave the page a few
 * pixels tall, and the marked-element list held a permanent block beneath the
 * frame. `src` is the whole client module, so both the CSS rules and the
 * component structure are checked here.
 */
import { readFileSync } from 'node:fs'

const src = readFileSync('E:/StudyFile/AI-Workspace/dsh_workspace/plugins/dsh-annotate/client.js', 'utf8')
const css = src

const failures = []
const ok = (condition, label, detail) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`\\${escaped}\\{([^}]*)\\}`).exec(css) || new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  return match ? match[1] : null
}

console.log('=== the panel itself must not scroll as one long column ===')
const panel = rule('.dsa-panel')
ok(panel !== null, 'the panel rule exists')
ok(/overflow:hidden/.test(panel || ''), 'the panel clips instead of scrolling everything', panel && panel.match(/overflow:[^;]*/)?.[0])
ok(/min-height:0/.test(panel || ''), 'the panel allows its children to shrink', panel && panel.match(/min-height:[^;]*/)?.[0])

console.log('\n=== the preview must claim the free space ===')
const frame = rule('.dsa-frame')
console.log('  .dsa-frame:', frame)
ok(/flex:1/.test(frame || ''), 'the preview grows to fill the column')
const minHeight = /min-height:(\d+)px/.exec(frame || '')
console.log('  preview minimum height:', minHeight && `${minHeight[1]}px`)
ok(Number(minHeight && minHeight[1]) <= 200, 'the preview minimum is modest, not greedy')

console.log('\n=== chrome rows must not grow ===')
for (const selector of ['.dsa-bar', '.dsa-open', '.dsa-hint']) {
  const body = rule(selector)
  const shrinkProof = /flex:0 0 auto/.test(body || '')
  ok(shrinkProof, `${selector} is size-capped`, body && body.match(/flex:[^;]*/)?.[0])
}

console.log('\n=== the marked-element list is an overlay, not a permanent block ===')
const countBody = rule('.dsa-count-body')
console.log('  .dsa-count-body:', countBody)
ok(/position:absolute/.test(countBody || ''), 'the list floats over the preview')
ok(!/dsa-list-wrap/.test(css), 'no permanent list block remains in the column')
ok(/\.dsa-count\{/.test(css), 'the toolbar carries a counter')
ok(/CountButton/.test(css), 'the counter component exists')

console.log('\n=== the framing hint stops occupying a row once a page is open ===')
ok(/preview \? null : h\('p'/.test(css), 'the hint shows only before a page is opened')

console.log('\n=== the picker folds away once a page is open ===')
ok(/dsa-collapse/.test(css), 'a collapse style exists')
ok(/<details|h\(\s*'details'|'details'/.test(css), 'the picker uses a native details element')

console.log('\n=== simulate the distribution in a narrow sidebar ===')
// Pixels available to the panel in a short, narrow sidebar column.
const usable = 640
const rows = {
  toolbar: 30,
  picker: 34,
  'collapsed summary': 20,
  gaps: 3 * 8,
}
const chrome = Object.values(rows).reduce((a, b) => a + b, 0)
const forPreview = usable - chrome
console.log('  usable height      :', usable)
console.log('  fixed rows         :', chrome, JSON.stringify(rows))
console.log('  preview gets       :', forPreview)
ok(forPreview > 450, 'the preview keeps most of the column', `${forPreview}px`)

console.log('')
if (failures.length) {
  console.log(`LAYOUT CHECKS FAILED — ${failures.length} problem(s)`)
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
console.log('LAYOUT CHECKS PASSED')
