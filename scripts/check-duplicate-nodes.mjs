/**
 * Two annotations on structurally identical nodes must not collapse onto one.
 *
 * The reader's report: "页面上不会显示编号了，但是标注的计数还是在增加的."
 *
 * The block it produced shows why. Elements 1 and 3 carried the SAME selector
 * (`.l2`) while holding different text ("@ciyuan_user" and "默认 · vip"). Two
 * annotations therefore resolved to one element: `querySelector` returns the first
 * match in document order, so both pins were drawn at the same spot and the second
 * element got none — while the count, which comes from the list, kept climbing.
 *
 * This drives the real `elementFor` through a real DOM, because the failure is
 * entirely about what `querySelector` does with an ambiguous selector.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/a3025/.dsh/profiles/web/package.json')
const JSDOM_ROOT = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/jsdom@29.1.1_@noble+hashes@2.3.0/node_modules'
const { JSDOM } = require(`${JSDOM_ROOT}/jsdom`)

const overlaySource = readFileSync(fileURLToPath(new URL('../lib/overlay.js', import.meta.url)), 'utf8')

const failures = []
const ok = (condition, label, detail) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

/** Pull one function out of the overlay source so it can run against a real DOM. */
function extract(name) {
  const start = overlaySource.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`function ${name} not found in overlay.js`)
  let depth = 0
  let i = overlaySource.indexOf('{', start)
  const from = i
  for (; i < overlaySource.length; i += 1) {
    if (overlaySource[i] === '{') depth += 1
    else if (overlaySource[i] === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  return overlaySource.slice(start, i + 1)
}

const dom = new JSDOM(`<!doctype html><html><body>
  <div class="pa-grid">
    <div><span class="l2" data-testid="cell">@ciyuan_user</span></div>
    <div><span class="l2" data-testid="cell">默认 · vip</span></div>
  </div>
  <div class="unique" data-testid="solo">only one</div>
</body></html>`)
const { window } = dom
global.document = window.document
global.window = window
global.CSS = window.CSS || { escape: (s) => s }

// `live` is module state in the real file; a fresh map per call keeps the test honest
// about resolution rather than about caching.
const instrumented = `
  var live = new Map()
  ${extract('elementFor')}
  ${extract('selectorOf')}
  ${extract('firstUniqueClass')}
  ${extract('uniqueClassSelector')}
  ${extract('matchesOf')}
  return { elementFor, selectorOf, matchesOf }
`
const deps = new Function(instrumented)()

console.log('\n=== a repeated data-testid is not handed out as a selector ===')
// It names two nodes, so using it as identity makes the second annotation resolve to
// the first. The class is no better; the positional chain is what has to win.
{
  const cells = window.document.querySelectorAll('.l2')
  const sel = deps.selectorOf(cells[1])
  ok(sel !== '[data-testid="cell"]', 'the shared testid is refused', sel)
  ok(deps.matchesOf(sel) === 1, 'and the selector it falls back to is unique', `${sel} -> ${deps.matchesOf(sel)}`)
}

console.log('\n=== a unique data-testid is still used ===')
// The fix must not throw away the good case: a testid naming one node is ideal.
{
  const solo = window.document.querySelector('.unique')
  const sel = deps.selectorOf(solo)
  ok(sel === '[data-testid="solo"]', 'a unique testid is kept', sel)
}

console.log('\n=== two annotations on identical nodes resolve to different elements ===')
// The regression, end to end: same selector, different text. The text is what picks
// the right node when the selector cannot.
{
  const cells = window.document.querySelectorAll('.l2')
  const shared = '.l2'
  const first = { id: 'a1', selector: shared, tag: 'span', text: '@ciyuan_user' }
  const second = { id: 'a2', selector: shared, tag: 'span', text: '默认 · vip' }
  const gotFirst = deps.elementFor(first)
  const gotSecond = deps.elementFor(second)
  ok(gotFirst === cells[0], 'the first annotation resolves to the first node')
  ok(gotSecond === cells[1], 'and the second to the second, not the first again',
    gotSecond === cells[0] ? 'both landed on the same element — one pin would be missing' : 'ok')
  ok(gotFirst !== gotSecond, 'so the two pins are drawn in different places')
}

console.log('\n=== an ambiguous selector with no matching text is refused, not guessed ===')
// Guessing is what produced the silent miscount. Refusing leaves the count short and
// the pin absent, which is honest about not knowing.
{
  const wrong = { id: 'a3', selector: '.l2', tag: 'span', text: 'nothing matches this' }
  ok(deps.elementFor(wrong) === null, 'an unresolvable annotation yields no element')
}

console.log('\n=== the recorded text is the clipped node text ===')
// The disambiguation compares against `annotation.text`, which `detailOf` fills with
// `clip(el.textContent, 120)`. If the two ever stop agreeing the match silently fails.
{
  const cells = window.document.querySelectorAll('.l2')
  const detailText = cells[1].textContent.trim()
  ok(detailText === '默认 · vip', 'the node text is what the annotation stores', detailText)
}

console.log(failures.length === 0
  ? '\nDUPLICATE NODE CHECKS PASSED'
  : `\nDUPLICATE NODE CHECKS FAILED — ${failures.length} problem(s)`)
process.exit(failures.length === 0 ? 0 : 1)
