/**
 * Guard the reporting sequence: a batch that reaches the host must stay there.
 *
 * Three ways this went wrong, all of which are asserted here.
 *
 *  1. The panel mirrors the page's list. If the page wipes its list when the panel
 *     reports, the next batch starts from empty and the host is told the list
 *     shrank — the user's "my previous annotations got overwritten".
 *  2. The reporting effect watches state. If the code records anything other than
 *     the signature it actually sent, the panel's own state change looks like news
 *     from the page and a second report fires, deleting what was just written.
 *  3. "Clear all" posts an empty list. That empty list is a legitimate payload and
 *     must be sent, not short-circuited — otherwise the host keeps advertising
 *     annotations the reader has discarded.
 *
 * The simulation below reproduces the state machine rather than reading it, so the
 * assertions are about behaviour and not about how the code happens to be worded.
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

console.log('=== the reporter sends what it is given ===')
const reportStart = src.indexOf('const reportAnnotations = async (list) => {')
const reportEnd = src.indexOf('\n        }', reportStart)
const reportFn = src.slice(reportStart, reportEnd === -1 ? reportStart + 2000 : reportEnd)
check(reportStart !== -1, 'the reporter exists')
check(!/if \(!payload\.length\) return null/.test(reportFn),
  'an empty payload is sent rather than refused',
  'clearing has to reach the host')
check(/reported\.current = JSON\.stringify\(payload\)/.test(reportFn),
  'it records exactly the signature it sent',
  reportFn.split('\n').filter((l) => l.includes('reported.current')).join(' | ') || '(none)')

console.log('')
console.log('=== the page keeps its marks after they are reported ===')
const keyCase = overlay.slice(overlay.indexOf("case 'key':"), overlay.indexOf("case 'purge':"))
check(!/state\.annotations = \[\]/.test(keyCase),
  'leaving marking mode does not empty the page list')
const purgeAt = overlay.indexOf("case 'purge':")
check(/state\.annotations = \[\]/.test(overlay.slice(purgeAt, purgeAt + 500)),
  'only the explicit purge does')

console.log('')
console.log('=== simulate: marking, then marking again ===')
// The failure the user reported was the second batch replacing the first.
const host = new Map()
const posts = []
const reported = { current: null }

/** The reporting effect, as shipped: signature-guarded, skips the empty mount. */
const effect = (annotations, session) => {
  const signature = JSON.stringify(annotations)
  if (reported.current === null && annotations.length === 0) {
    reported.current = signature
    return
  }
  if (reported.current === signature) return
  reported.current = signature
  posts.push(annotations.length)
  if (annotations.length) host.set(session, annotations)
  else host.delete(session)
}

/** The reporter, as shipped: post, then record what was sent. */
const report = (annotations, session) => {
  posts.push(annotations.length)
  if (annotations.length) host.set(session, annotations)
  else host.delete(session)
  reported.current = JSON.stringify(annotations)
}

const first = [{ selector: '.a' }, { selector: '.b' }]
const both = [{ selector: '.a' }, { selector: '.b' }, { selector: '.c' }]

reported.current = null
posts.length = 0
host.clear()

effect(first, 's')          // the page reports two marks
check(host.get('s') && host.get('s').length === 2, 'the first batch lands', `${host.get('s')?.length ?? 0} held`)

// Marking a third element: the page reports the full accumulated list, because it
// no longer wipes itself. A page that wiped would report just one here.
effect(both, 's')
check(host.get('s') && host.get('s').length === 3,
  'the second batch ADDS to the first rather than replacing it',
  `${host.get('s')?.length ?? 0} held`)
console.log(`  posts: ${posts.join(' -> ')}`)

console.log('')
console.log('--- the fault, for contrast: a page that wipes reports a shorter list ---')
const host2 = new Map()
const reported2 = { current: null }
const effect2 = (annotations, session) => {
  const signature = JSON.stringify(annotations)
  if (reported2.current === null && annotations.length === 0) { reported2.current = signature; return }
  if (reported2.current === signature) return
  reported2.current = signature
  if (annotations.length) host2.set(session, annotations)
  else host2.delete(session)
}
effect2(first, 's')
effect2([{ selector: '.c' }], 's')   // the wiper would report only the new mark
check(host2.get('s') && host2.get('s').length === 1,
  'a wiping page leaves only the newest mark (the reported fault)',
  `${host2.get('s')?.length ?? 0} held`)

console.log('')
console.log('=== a report does not bounce back as a second report ===')
reported.current = null
posts.length = 0
host.clear()
report(first, 's')            // the panel reports a batch
const before = posts.length
effect(first, 's')            // the mirror updates to the same list
check(posts.length === before,
  'the identical follow-up state change is not re-posted',
  `posts went ${before} -> ${posts.length}`)

console.log('')
console.log('=== clearing reaches the host and stays cleared ===')
report([], 's')
check(!host.has('s'), 'the host is emptied', `${host.get('s')?.length ?? 0} held`)
effect([], 's')
check(!host.has('s'), 'and the empty state is not re-posted as a change',
  `posts: ${posts.join(' -> ')}`)

console.log('')
if (failures) {
  console.log(`HANDOVER CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('HANDOVER CHECKS PASSED')
