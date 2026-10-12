/**
 * Ask the RUNNING host whether the overlay it actually serves carries this round's
 * work, and drive a real navigation through that overlay.
 *
 * `check-live-host.mjs` proves the process is up and the version string matches the
 * manifest. Both of those are things a stale process can satisfy: the version is
 * bumped by hand in `lib/index.js`, so a restart that picked up the manifest but
 * cached the old overlay would still pass. This reads the bytes the running host
 * injects and looks for the pieces that only exist after the route rework — and
 * for the ABSENCE of the per-route bucketing that was removed, since a leftover
 * copy would keep passing a presence-only check.
 *
 * It then boots those exact bytes against a real loopback HTTP target and moves
 * through all four navigations, so the proxy and the injection are exercised
 * together instead of each in isolation. Needs a running host, so it lives in
 * NEEDS_HOST and is not part of the offline suite.
 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'

const BASE = process.argv[2] || 'http://127.0.0.1:3080'

// jsdom is the harness's copy, the same one the offline checks use.
const require = createRequire(import.meta.url)
const jsdomDir = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/jsdom@29.1.1_@noble+hashes@2.3.0/node_modules'
const { JSDOM } = require(`${jsdomDir}/jsdom`)

const page = createServer((req, res) => {
  // Every path serves the same document: an SPA, so its own routing decides what
  // is on screen — which is the condition the route handling has to survive.
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><body><div class="alpha">A</div><div class="beta">B</div></body></html>')
})
await new Promise((done) => page.listen(0, '127.0.0.1', done))
const target = `http://127.0.0.1:${page.address().port}/`

const open = await fetch(`${BASE}/__dsh-annotate/open`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'open', url: target }),
}).then((r) => r.json())

// The preview's own URL is what serves the injected overlay. Read it defensively:
// an earlier probe here assumed the field was named `entry` and died on
// `fetch(undefined)` instead of reporting a mismatch.
const entry = open && (open.url || open.entry || open.src)
if (typeof entry !== 'string') {
  console.log(`  FAIL the host did not return a preview URL — ${JSON.stringify(open).slice(0, 160)}`)
  page.close()
  process.exit(1)
}

const html = await fetch(entry).then((r) => r.text())

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

console.log('=== the live overlay carries the route work ===')
// The hash is part of the route, which is what makes a hash-routed app's views
// distinguishable at all.
check(/location\.pathname \+ location\.search \+ location\.hash/.test(html),
  'the route includes path, search and hash')
// Both history methods are wrapped: neither fires an event on its own.
check(/'pushState', 'replaceState'/.test(html),
  'pushState and replaceState are both wrapped')
check(/hashchange/.test(html) && /popstate/.test(html),
  'hashchange and popstate are both hooked')
// Option A: the bucket is keyed by the session, NOT by the route.
check(/return STORE_PREFIX \+ session\b/.test(html),
  'the storage bucket is keyed by the session')
check(!/return STORE_PREFIX \+ session \+ ':' \+ pagePath/.test(html),
  'and is no longer keyed by the route')
// Each mark records which route it was made on, and pins are drawn per route.
check(/annotation\.page === path/.test(html) || /annotationsOn/.test(html),
  'a mark carries the route it was made on')
// The host hands a lost list back to a rebuilt page.
check(/'restore'/.test(html),
  'the page accepts a restore from the panel')

// Scroll handling: the overlay must distinguish "the selector no longer resolves"
// from "the element is scrolled out of view". The offline suite proves the logic;
// this proves the RUNNING process has it. That matters because `lib/index.js` reads
// the overlay once at module load (`const OVERLAY_SRC = asset('./overlay.js')`), so
// a fix that is correct on disk stays absent from the served bytes until a restart
// — and a version-number check cannot see the difference.
check(/reason: 'offscreen'/.test(html),
  'a scrolled-out element is not treated as unlocatable')
check(!/!el\.isConnected \|\| !el\.getClientRects\(\)\.length\) return null/.test(html),
  'and the old single-null anchor is gone')

// Empty space must not read as a selection. This is asserted against the SERVED
// bytes for the same reason as the scroll work above, and here it is the whole
// point: the fix for it was committed, the offline suite went green, and the reader
// still saw the whole page outlined — because the host inlined the overlay from a
// load-time constant and had been running since before the edit. Reading the served
// bytes is the only check that can tell those two situations apart.
check(/isPageItself/.test(html),
  'the served overlay treats the document itself as empty space')
check(/capture\.addEventListener\('mouseleave'/.test(html),
  'and drops the highlight when the pointer leaves the frame')

// Session-wide numbering: the pin's number is the mark's place in the whole
// session list, so it matches the panel's row and the block's `## Element n`, and
// survives navigation. The per-route COUNTER that made two routes both read 1 is
// asserted ABSENT, because a presence-only check cannot tell the two apart — the
// old build also contained the word `numbered` nowhere, but it did contain the
// counter, and a fault reintroduced alongside the fix would pass unnoticed.
check(/var numbered = readingOrder\(state\.annotations\.filter\(/.test(html),
  'pins are numbered by the session list, in the panel\'s reading order')
check(/numbered\.indexOf\(annotation\) \+ 1/.test(html),
  'and a pin reads its own number rather than a counter')
check(!/shown \+= 1/.test(html),
  'the per-route counter that numbered two routes both 1 is gone')

console.log('')
console.log('=== the live host answers /pending with the entries ===')
const posted = await fetch(`${BASE}/__dsh-annotate/context`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    session: 'live-probe-session',
    annotations: [{ selector: '.alpha', text: 'A', note: 'live', matches: 1, page: '/x' }],
  }),
}).then((r) => r.json())
check(posted.ok === true, 'a report is accepted', JSON.stringify(posted).slice(0, 80))

const pending = await fetch(`${BASE}/__dsh-annotate/pending`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ session: 'live-probe-session' }),
}).then((r) => r.json())
check(Array.isArray(pending.annotations), 'the poll returns an array, not just a count',
  JSON.stringify(pending).slice(0, 120))
check(pending.annotations.length === 1, 'carrying the entry itself',
  String(pending.annotations.length))

// Clean up so the probe does not linger in the host's state.
await fetch(`${BASE}/__dsh-annotate/context`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ session: 'live-probe-session', annotations: [] }),
})

page.close()
console.log('')
console.log(failures ? `LIVE OVERLAY PROBE FAILED — ${failures}` : 'LIVE OVERLAY PROBE PASSED')
process.exit(failures ? 1 : 0)
