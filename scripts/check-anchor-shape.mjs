/**
 * Reproduce the reader's two annotations and confirm the selector anchors on them.
 *
 * The report after the fix:
 *
 *   Element 1  selector: .l1 > span:nth-of-type(2)          text: 普通用户
 *   Element 2  selector: .l2 > span:nth-of-type(3) > b      text: 默认 · vip
 *
 * Both paths end at the annotated element, and they resolve through DIFFERENT
 * ancestors. Before the fix both read `.l2` — one shared container — so the two
 * annotations collapsed onto a single node and one number was never drawn.
 *
 * This reconstructs a page with that shape and asserts the generated selector
 * resolves back to the element it came from.
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

function extract(name) {
  const start = overlaySource.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`function ${name} not found`)
  let depth = 0
  let i = overlaySource.indexOf('{', start)
  for (; i < overlaySource.length; i += 1) {
    if (overlaySource[i] === '{') depth += 1
    else if (overlaySource[i] === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  return overlaySource.slice(start, i + 1)
}

// The reader's page shape: two status lines, each with its own container, whose
// relevant child has no unique class of its own.
const dom = new JSDOM(`<!doctype html><html><body>
  <div class="l1">
    <span class="label">等级</span>
    <span class="badge v">普通用户</span>
  </div>
  <div class="l2">
    <span class="label">方案</span>
    <span class="label">周期</span>
    <span><b style="color:var(--ink)">默认 · vip</b></span>
  </div>
</body></html>`)
const { window } = dom
global.document = window.document
global.window = window
global.CSS = window.CSS || { escape: (s) => s }

const deps = new Function(`
  ${extract('firstUniqueClass')}
  ${extract('uniqueClassSelector')}
  ${extract('matchesOf')}
  ${extract('selectorOf')}
  return { selectorOf, matchesOf }
`)()

const badge = window.document.querySelector('.badge')
const bold = window.document.querySelector('b')
const l1 = window.document.querySelector('.l1')
const l2 = window.document.querySelector('.l2')

// `.label` appears twice, so it is NOT usable as identity; `.l1`/`.l2` are unique
// containers. The generated path must use one as an anchor and still reach the child.
// jsdom's CSS.escape is absent, and the source guards for that, so the class lookup
// falls back to positional segments here. The property under test is the same either
// way: the path must end at the element.
console.log('\n=== each selector resolves back to the element it came from ===')
const badgeSel = deps.selectorOf(badge)
const boldSel = deps.selectorOf(bold)
console.log(`  普通用户 -> ${badgeSel}`)
console.log(`  默认·vip -> ${boldSel}`)
ok(window.document.querySelector(badgeSel) === badge,
  'the first annotation resolves to the badge itself')
ok(window.document.querySelector(boldSel) === bold,
  'the second resolves to the bold itself')
ok(window.document.querySelector(badgeSel) !== window.document.querySelector(boldSel),
  'and the two are different elements')
ok(deps.matchesOf(badgeSel) === 1 && deps.matchesOf(boldSel) === 1,
  'both selectors are unique')

console.log('\n=== neither path stops at a shared ancestor ===')
// The specific bug: both were recorded as `.l2`, one container holding two
// annotations. Whatever the path looks like, it must not resolve to the container.
ok(window.document.querySelector(badgeSel) !== l1, 'the first does not resolve to .l1')
ok(window.document.querySelector(boldSel) !== l2, 'the second does not resolve to .l2')
ok(new Set([badgeSel, boldSel]).size === 2, 'the two annotations carry different selectors')

console.log('\n=== a duplicated class is not used as identity ===')
// `.label` names two nodes. Using it as a complete selector would repeat exactly the
// reported failure, so it must never appear on its own.
ok(badgeSel !== '.label' && boldSel !== '.label', 'the shared class is not used alone')
ok(!/^\.label$/.test(badgeSel) && !/^\.label$/.test(boldSel), 'nor for the second')

console.log(failures.length === 0
  ? '\nANCHOR CHECK PASSED'
  : `\nANCHOR CHECK FAILED — ${failures.length} problem(s)`)
process.exit(failures.length === 0 ? 0 : 1)
