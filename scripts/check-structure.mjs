/**
 * The client bundle must be structurally whole.
 *
 * A splice script once matched the wrong closing brace and replaced the first ~600
 * lines of `client.js` with a replacement table. The file still parsed as far as a
 * casual look went, still contained every component, and still had a valid
 * `STACK_MARKS` table — but the module wrapper, the stylesheet and every i18n string
 * were gone. Nothing caught it. Twelve of the fourteen checks that touch this file
 * went on passing, because they each look for a specific string that happened to
 * survive.
 *
 * So this asserts the SHAPE of the file rather than any one string in it: the parts
 * that must exist, in the order they must exist, and a size floor that a truncated
 * file cannot clear.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

let failures = 0
const ok = (pass, label, detail) => {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures += 1
}

const check = (file, required, opts = {}) => {
  const src = readFileSync(`${root}${file}`, 'utf8')
  const lines = src.split('\n')

  console.log(`\n=== ${file} ===`)
  console.log(`  ${lines.length} lines, ${(Buffer.byteLength(src) / 1024).toFixed(0)} KB`)

  // A size floor is crude but it is the one check a truncation cannot fake. The
  // numbers are well below the real size, so ordinary edits never trip them.
  if (opts.minLines) {
    ok(lines.length >= opts.minLines, 'has not been truncated', `${lines.length} lines (floor ${opts.minLines})`)
  }

  // Order is asserted only where it is a real invariant, not for every marker.
  //
  // An earlier version required all of them to be in list order, which failed on code
  // that is perfectly correct: `apply` legitimately comes after the helpers it calls,
  // and the annotation renderer is defined inside `apply`. Asserting an order that the
  // design does not require would make this check cry wolf, and a check that cries wolf
  // gets ignored — which is the failure mode this file exists to prevent.
  //
  // What IS invariant is that the wrapper opens before it closes, and that the whole
  // file's head comes before its tail. Both are what a bad splice breaks.
  const positions = required.map(([label, pattern]) => [label, src.search(pattern)])
  for (const [label, index] of positions) {
    ok(index !== -1, `contains ${label}`, index === -1 ? 'MISSING' : undefined)
  }
  if (opts.before) {
    for (const [a, b] of opts.before) {
      const ia = src.search(a)
      const ib = src.search(b)
      if (ia !== -1 && ib !== -1) {
        ok(ia < ib, `${a} comes before ${b}`)
      }
    }
  }

  // The wrapper must open and close exactly once. A splice that duplicates the head
  // would still contain every marker and still be broken.
  if (opts.wrapperOpen) {
    const opens = src.split(opts.wrapperOpen).length - 1
    ok(opens === 1, 'the module wrapper opens exactly once', `${opens} occurrence(s)`)
  }
  if (opts.wrapperClose) {
    const closes = src.split(opts.wrapperClose).length - 1
    ok(closes === 1, 'and closes exactly once', `${closes} occurrence(s)`)
  }

  // Braces must balance. This is the check that would have caught the bad splice
  // immediately, since it dropped a brace pair and kept another.
  const open = (src.match(/\{/g) || []).length
  const close = (src.match(/\}/g) || []).length
  ok(open === close, 'braces balance', `${open} open vs ${close} close`)
}

// --- the client bundle --------------------------------------------------------
check('client.js', [
  ['the file header', /dsh-annotate — sidebar half/],
  ['the module wrapper', /__ModuleLoader__/],
  ['the stylesheet', /:root\s*\{[^}]*--dsa-h/],
  ['the English strings', /'panel\.refresh':/],
  ['the Chinese strings', /'panel\.reload': '[^']*重新加载/],
  ['the accent presets', /const ACCENTS = \[/],
  ['the stack marks', /const STACK_MARKS = \{/],
  ['the icon set', /function Icon\(props\)/],
  ['the open bar', /function OpenBar\(props\)/],
  ['the panel menu', /function PanelMenu\(props\)/],
  ['the tab itself', /const AnnotateTab = \(props\)/],
  ['the export', /return module\.exports/],
], {
  minLines: 1500,
  wrapperOpen: 'window.__ModuleLoader__.load(',
  wrapperClose: 'return module.exports',
  before: [
    // The bundle must open before it closes: a truncated head leaves the closing
    // sequence present with no opener.
    [/__ModuleLoader__/, /return module\.exports/],
    // The stylesheet belongs near the top, not appended after the components. A
    // splice that moved a section to the end would still contain every string.
    [/:root\s*\{[^}]*--dsa-h/, /const ACCENTS = \[/],
  ],
})

// --- the host half ------------------------------------------------------------
check('lib/index.js', [
  ['the version', /const VERSION = '/],
  ['the route', /const ROUTE = '/],
  ['the port list', /const COMMON_PORTS = \[/],
  ['the stack detector', /function detectStack\(/],
  ['the probe', /function probe\(/],
  ['the plugin name', /export const name = 'dsh-annotate'/],
  ['the apply function', /export function apply\(ctx, config\)/],
  ['the annotation renderer', /const renderAnnotations = \(sessionId/],
], { minLines: 1200 })

// --- the injected overlay -----------------------------------------------------
check('lib/overlay.js', [
  ['the live map', /var live = /],
  ['the selector builder', /function selectorOf/],
  ['the pin renderer', /function renderPins/],
  ['the element resolver', /function elementFor/],
  ['the post channel', /function post\(/],
  ['the unplaced report', /post\('unplaced'/],
], { minLines: 700 })

console.log('')
if (failures) {
  console.log(`STRUCTURE CHECKS FAILED — ${failures} problem(s)`)
  console.log('')
  console.log('A file that is missing its head is not a small problem: it still parses and')
  console.log('still contains the pieces other checks look for. Restore it from git before')
  console.log('editing further.')
  process.exit(1)
}
console.log('STRUCTURE CHECKS PASSED')
