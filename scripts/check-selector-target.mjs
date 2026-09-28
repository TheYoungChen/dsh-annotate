/**
 * The selector must END at the annotated element, not at one of its ancestors.
 *
 * The reader's F12 output was the whole diagnosis:
 *
 *   批注1  <span class="badge v">普通用户</span>
 *   批注2  <b style="color:var(--ink)">默认 · vip</b>
 *
 * Two obviously different nodes. The block recorded BOTH as `.l2` — a class neither
 * of them has. `.l2` is a shared ancestor, so `uniqueClassSelector` walked up to it
 * and returned it, and the generated path stopped at the parent. Both annotations
 * therefore resolved to the same ancestor: one pin, drawn at the parent's position,
 * and the count climbing while a number never appeared.
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

// Modelled on the reader's page: a status row whose children carry their own identity,
// and one child with no class at all.
const dom = new JSDOM(`<!doctype html><html><body>
  <div class="l2">
    <span class="badge v">普通用户</span>
  </div>
  <div class="l2">
    <b style="color:var(--ink)">默认 · vip</b>
  </div>
  <div class="row"><i>only</i></div>
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
  return { firstUniqueClass, uniqueClassSelector, matchesOf, selectorOf }
`)()

const badge = window.document.querySelector('.badge')
const bold = window.document.querySelector('b')

console.log('\n=== the selector names the annotated element, not its parent ===')
{
  const badgeSel = deps.selectorOf(badge)
  const boldSel = deps.selectorOf(bold)
  console.log(`  badge -> ${badgeSel}`)
  console.log(`  bold  -> ${boldSel}`)
  ok(badgeSel !== '.l2', 'the badge does not resolve through its parent class', badgeSel)
  ok(boldSel !== '.l2', 'and neither does the bold element', boldSel)
  ok(badgeSel !== boldSel, 'the two get different selectors', `${badgeSel} vs ${boldSel}`)
}

console.log('\n=== each selector resolves to the element it names ===')
{
  ok(deps.matchesOf(deps.selectorOf(badge)) === 1, 'the badge selector is unique')
  ok(deps.matchesOf(deps.selectorOf(bold)) === 1, 'the bold selector is unique')
  // The real question: does the selector point AT the element, not merely somewhere
  // unique? A unique ancestor still passes a uniqueness check while being wrong.
  ok(window.document.querySelector(deps.selectorOf(badge)) === badge,
    'the badge selector resolves back to the badge itself')
  ok(window.document.querySelector(deps.selectorOf(bold)) === bold,
    'the bold selector resolves back to the bold itself')
}

console.log('\n=== an element with no class still gets a path ending at itself ===')
{
  const only = window.document.querySelector('.row > i')
  const sel = deps.selectorOf(only)
  ok(window.document.querySelector(sel) === only,
    'the selector lands on the element even when only an ancestor can be named', sel)
}

console.log('\n=== the element\'s own class beats an ancestor\'s ===')
{
  // Directly on the helper: given an element whose own class is unique, that class
  // must be what comes back, never a parent's.
  const own = deps.uniqueClassSelector(badge, 0)
  ok(own === '.badge' || own === '.v', 'the element\'s own unique class is used', own)
}

console.log('\n=== an unplaceable annotation is announced, not dropped ===')
// The reader's report read as a counting bug because nothing said otherwise: the count
// came from the list and kept climbing while the pin was simply absent. The page has
// to say when it cannot draw one.
{
  const render = overlaySource.slice(
    overlaySource.indexOf('function renderPins('),
    overlaySource.indexOf('// -------------------------------------------------------------- note card'),
  )
  ok(/unplaced\.push\(/.test(render), 'an unplaceable annotation is collected')
  ok(/post\('unplaced'/.test(render), 'and reported to the panel')
  ok(/total: state\.annotations\.length/.test(render),
    'the report carries the total, so the two numbers can be reconciled')
  ok(!/if \(!anchor\) return\b/.test(render),
    'it is no longer a silent early return')
}

console.log(failures.length === 0
  ? '\nSELECTOR TARGET CHECKS PASSED'
  : `\nSELECTOR TARGET CHECKS FAILED — ${failures.length} problem(s)`)
process.exit(failures.length === 0 ? 0 : 1)
