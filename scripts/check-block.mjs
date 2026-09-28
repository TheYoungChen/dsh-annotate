/**
 * Render the block the model will receive, from the same entries used earlier.
 *
 * The payload moved from the client to the host, so this prints the host's real
 * output rather than a copy of it: the function is driven directly, so what is
 * shown here is what the model gets.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')

// Lift renderAnnotations out of the module and drive it, so the printed block is
// produced by the shipped code path with the same clip helper it uses.
/**
 * Lift one arrow-function declaration out of the host module by matching braces.
 *
 * Slicing to a remembered end-marker breaks every time the body is edited, and a
 * broken slice reports a missing function rather than a real regression. Walking
 * the braces keeps this working across refactors.
 * @param source - the module text.
 * @param marker - the declaration's opening text, e.g. `const f = (x) => {`.
 * @returns the declaration's full text.
 */
function extractFunction(source, marker) {
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`declaration not found: ${marker}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after: ${marker}`)
}

const clipSrc = extractFunction(src, 'const clip = (value, max) =>')
// Anchored on the declaration name alone: the renderer grew a second parameter,
// and an anchor that names the whole signature turns every such change into a
// crash rather than a test result.
const renderSrc = extractFunction(src, 'const renderAnnotations = (sessionId')

const ENTRIES = [
  {
    selector: '.g-recharge',
    text: 'Recharge',
    note: '汇率太小，改成 20px',
    matches: 1,
    at: '679,276 50×16',
  },
  {
    selector: 'body > div:nth-of-type(2) > div:nth-of-type(5)',
    text: '复制邀请码',
    note: '',
    matches: 3,
    at: '612,1005 118×33',
  },
]

// The renderer also consults the module-level `delivered` map, which holds the
// text rendered for the current turn so every assembly reads identically. It is
// supplied empty here: this check is about the text the model receives on the
// turn that delivers it.
const build = new Function(
  'pending',
  'delivered',
  `${clipSrc}
   ${renderSrc}
   return renderAnnotations`,
)

const pending = new Map([['demo-session', ENTRIES]])
const render = build(pending, new Map())
const block = render('demo-session')

console.log('=== what the model receives ===')
console.log(block)
console.log('=== end ===')

console.log('')
console.log('=== what the reader sees in their own message ===')
console.log('(nothing — their text is untouched)')

let failures = 0
const check = (ok, label) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failures += 1
}

console.log('')
console.log('=== payload checks ===')
check(block.startsWith('# Web page elements'), 'opens with the section heading')
check(!/🎯/.test(block), 'no decorative marker')
check(block.includes('## Element 1') && block.includes('## Element 2'), 'one section per element')
check(/note: 汇率太小/.test(block), 'a note is included when present')
check(!/note: \n/.test(block), 'no empty note line for a mark without one')
// Geometry appears only for the ambiguous selector.
check(/at: 612,1005/.test(block), 'geometry is emitted for the ambiguous selector')
check(!/at: 679,276/.test(block), 'geometry is omitted for the unique one')
check(!/matches:/.test(block), 'no raw match count leaks into the block')

// Empty state must contribute exactly nothing, so the runtime drops the section.
pending.delete('demo-session')
check(render('demo-session') === '', 'an empty session renders the empty string')
check(render('unknown-session') === '', 'an unknown session renders the empty string')

// The input crosses an HTTP boundary, so the renderer must assume nothing about
// its shape. Junk becomes an empty contribution rather than a block of empty
// headings, which would cost tokens and tell the model nothing.
console.log('')
console.log('=== malformed entries contribute nothing ===')
const junkCases = [
  ['non-object entries', [1, 'two', null, undefined, []]],
  ['entries with no readable field', [{}, { selector: null }, { note: 42 }]],
  ['fields of the wrong type', [{ selector: 123, text: {}, note: [], matches: 'x' }]],
  ['only whitespace', [{ selector: '   ', text: '\n', note: '\t' }]],
]
for (const [label, list] of junkCases) {
  pending.set('junk', list)
  const out = render('junk')
  check(out === '', `${label} → nothing`, out ? JSON.stringify(out.slice(0, 60)) : undefined)
}

console.log('')
console.log('=== a bad entry does not disturb its neighbours ===')
pending.set('mixed', [{ selector: '.a' }, null, {}, { selector: '.b' }])
const mixed = render('mixed')
check(mixed.includes('selector: .a') && mixed.includes('selector: .b'), 'the good entries survive')
check(!/## Element 3/.test(mixed), 'no empty section is left behind', mixed)
// Numbering must be contiguous: a dropped entry should not leave a gap.
check(/## Element 1[\s\S]*## Element 2(?![\s\S]*## Element 3)/.test(mixed), 'sections are renumbered without a gap', mixed)

const chars = block.length
console.log('')
console.log(`  block size: ${chars} characters for 2 elements`)
console.log('')
if (failures) {
  console.log(`BLOCK CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('BLOCK CHECKS PASSED')
