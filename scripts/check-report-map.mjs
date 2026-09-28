/**
 * Check the shape-mapping the panel runs before reporting to the host.
 *
 * The mapping runs inside an effect, so a throw there unmounts the tab and the
 * sidebar goes blank — which is the reported symptom. The entries come from a
 * framed page over postMessage, so the mapping must not assume anything about
 * them.
 *
 * The mapping is lifted from the bundle so this tests the shipped expression.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) {
    failures += 1
    if (detail !== undefined) console.log(`       ${detail}`)
  }
}

// Lift the mapper as written, from the `.map(` through its closing `}))`.
const marker = '.map((entry) => ({'
const start = src.indexOf(marker)
check(start !== -1, 'the mapping exists in the bundle')
if (start === -1) process.exit(1)
// The statement starts at the `const toReport =` that owns this `.map`.
const stmtStart = src.lastIndexOf('const toReport', start)
const end = src.indexOf('}))', start) + 3
const mapper = src.slice(stmtStart, end)

console.log('--- the shipped mapping ---')
console.log(mapper.split('\n').map((l) => `    ${l.trim()}`).join('\n'))

/**
 * Run the shipped mapping against a list of entries.
 *
 * `toReport` is a const arrow, so the slice is evaluated as a declaration and the
 * binding is what gets returned.
 */
const run = (annotations) => {
  // eslint-disable-next-line no-new-func
  return new Function('annotations', `${mapper}\n return toReport(annotations)`)(annotations)
}

console.log('')
console.log('=== a well-formed entry maps cleanly ===')
const good = [{
  selector: '.g-recharge',
  text: 'Recharge',
  note: '太小',
  selectorMatches: 1,
  doc: { x: 10, y: 276, w: 50, h: 16 },
}]
let goodOut = null
let goodThrew = null
try {
  goodOut = run(good)
} catch (error) {
  goodThrew = error
}
check(goodThrew === null, 'no throw', goodThrew && goodThrew.message)
check(goodOut && goodOut[0].selector === '.g-recharge', 'the selector survives')
check(goodOut && goodOut[0].at === '10,276 50×16', 'geometry is formatted', goodOut && goodOut[0].at)
check(goodOut && goodOut[0].matches === 1, 'the match count survives')

console.log('')
console.log('=== entries that never reach the panel, but could ===')
// Anything other than an object makes the mapping throw, and a throw inside the
// effect blanks the sidebar.
const hostile = [
  ['null entry', [null]],
  ['undefined entry', [undefined]],
  ['string entry', ['x']],
  ['number entry', [5]],
  ['array entry', [[]]],
  ['boolean entry', [true]],
]
for (const [label, list] of hostile) {
  let threw = null
  try {
    run(list)
  } catch (error) {
    threw = error
  }
  check(threw === null, `${label} does not throw`, threw && threw.message)
}

console.log('')
console.log('=== missing or odd fields are tolerated ===')
const tolerable = [
  ['no doc', [{ selector: '.a' }]],
  ['doc null', [{ selector: '.a', doc: null }]],
  ['doc missing a key', [{ selector: '.a', doc: { x: 1, y: 2 } }]],
  ['selectorMatches is a string', [{ selector: '.a', selectorMatches: '2' }]],
  ['fields are wrong types', [{ selector: 1, text: {}, note: [], doc: 'nope' }]],
]
for (const [label, list] of tolerable) {
  let threw = null
  try {
    run(list)
  } catch (error) {
    threw = error
  }
  check(threw === null, `${label} does not throw`, threw && threw.message)
}

console.log('')
console.log('=== the list renderer filters before reading ===')
// The list renders before any effect runs, so a null reaching it threw during
// render and blanked the sidebar. The guard has to be at the read site.
check(/function usable\(list\)/.test(src), 'a filter helper exists')
check(/entry !== null && typeof entry === 'object'/.test(src), 'it keeps only object entries')
check(/inReadingOrder\(usable\(annotations\)\)/.test(src), 'the list filters before ordering')
check(/usable\(annotations\)\.length/.test(src), 'the badge counts what the list shows')

console.log('')
console.log('=== the reading-order sort survives odd entries ===')
const orderSrc = src.slice(src.indexOf('function inReadingOrder(list)'))
const orderBody = orderSrc.slice(0, orderSrc.indexOf('\n    }') + 6)
const order = new Function(`${orderBody}\n return inReadingOrder`)()

const sortCases = [
  ['empty', []],
  ['null entries', [null, undefined]],
  ['no doc field', [{ id: 'a' }, { id: 'b' }]],
  ['doc is null', [{ id: 'a', doc: null }]],
  ['doc partial', [{ id: 'a', doc: { x: 1 } }]],
  ['mixed', [null, { id: 'a', doc: { x: 1, y: 2 } }, undefined]],
]
for (const [label, list] of sortCases) {
  let threw = null
  try {
    order(list)
  } catch (error) {
    threw = error
  }
  check(threw === null, `sorting ${label} does not throw`, threw && threw.message)
}

console.log('')
if (failures) {
  console.log(`REPORT MAPPING CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('REPORT MAPPING CHECKS PASSED')
