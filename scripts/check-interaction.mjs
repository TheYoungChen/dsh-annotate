/**
 * Guard the interaction rules that replaced the old attach step.
 *
 * The user's objection was blunt and correct: "I annotated it, what is the point
 * of me not sending it?" The panel used to make them press a button to move marks
 * into the composer, which was pure ceremony — the marks reach the host as they
 * are made. So the rules now are:
 *
 *   1. No hand-over action exists. There is nothing to press.
 *   2. Escape leaves marking mode from wherever the pointer is. The page's own
 *      handler only fires while the frame holds focus, and choosing "Select" in
 *      the panel leaves focus in the panel — so the key did nothing in exactly
 *      the situation a reader reaches for it.
 *   3. Marks accumulate. The page keeps them after they are reported, because an
 *      earlier version cleared them and every new batch then replaced the
 *      previous one.
 */
import { readFileSync } from 'node:fs'

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) {
    failures += 1
    if (detail !== undefined) console.log(`       ${detail}`)
  }
}

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const overlay = readFileSync(new URL('../lib/overlay.js', import.meta.url), 'utf8')

console.log('=== there is no hand-over action left ===')
check(!/const handOver/.test(src), 'the hand-over handler is gone')
check(!/const ship = async/.test(src), 'and so is its predecessor')
check(!/onAttach/.test(src), 'nothing passes an attach callback')
check(!/canCompose/.test(src), 'and nothing gates one')
check(!/panel\.attach'/.test(src), 'the attach label is out of both catalogs')
check(!/panel\.sendHint/.test(src), 'and so is its tooltip')
check(/onRemoveAll: \(\) => void clearAll\(\)/.test(src),
  'the only remaining action is clearing')

console.log('')
console.log('=== the page still handles Escape when it has focus ===')
check(/event\.key === 'Escape'/.test(overlay), 'the overlay listens for Escape')
check(/state\.mode === 'marking'/.test(overlay), 'and only while marking')

console.log('')
console.log('=== the panel handles Escape too, because it holds focus ===')
const escStart = src.indexOf('// Escape leaves marking from wherever the pointer is.')
check(escStart !== -1, 'the panel documents why it needs its own handler')
const escBody = src.slice(escStart, escStart + 900)
check(/window\.addEventListener\('keydown', onKey, true\)/.test(escBody),
  'it listens in the capture phase, so nothing can swallow the key')
check(/setPageMode\('idle'\)/.test(escBody), 'and it stands the page down')
check(/if \(mode !== 'marking'\) return undefined/.test(escBody),
  'it is only attached while marking, so it cannot interfere otherwise')

console.log('')
console.log('=== marks accumulate instead of replacing each other ===')
// The bug: the page wiped its list when the panel took the payload, so the next
// batch started from empty and the host was told the list had shrunk.
const keyCase = overlay.slice(overlay.indexOf("case 'key':"), overlay.indexOf("case 'purge':"))
check(!/state\.annotations = \[\]/.test(keyCase),
  'leaving marking mode does NOT wipe the page list',
  keyCase.split('\n').filter((l) => l.includes('state.annotations')).join(' | ') || '(no assignment)')
check(/setMode\('idle'\)/.test(keyCase), 'it only leaves marking mode')
const purgeAt = overlay.indexOf("case 'purge':")
const purgeCase = overlay.slice(purgeAt, purgeAt + 500)
check(/state\.annotations = \[\]/.test(purgeCase),
  'the explicit purge is what empties it')
check(/postToPage\(\{ type: 'purge' \}\)/.test(src),
  'and the panel sends purge, not key, when clearing')

console.log('')
console.log('=== an empty batch is reportable, so clearing reaches the host ===')
// This used to short-circuit on an empty payload, which meant "clear all" left
// the host still advertising annotations the reader had discarded.
const reportStart = src.indexOf('const reportAnnotations = async (list) => {')
const reportEnd = src.indexOf('\n        }', reportStart)
const reportBody = src.slice(reportStart, reportEnd === -1 ? reportStart + 2000 : reportEnd)
check(reportStart !== -1, 'the reporter exists')
check(!/if \(!payload\.length\) return null/.test(reportBody),
  'it does not refuse an empty payload',
  'an empty list is how the host is told to clear')
check(/reported\.current = JSON\.stringify\(payload\)/.test(reportBody),
  'it records the signature it sent, so the follow-up state change is not re-posted')

console.log('')
if (failures) {
  console.log(`INTERACTION CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('INTERACTION CHECKS PASSED')
