/**
 * The address chip: it must show the address the reader recognises.
 *
 * The reader's report was that it only ever showed the port — `localhost:8080` —
 * no matter which page or tab was open, and asked for the suffix to be shown so
 * they could tell where they were:
 *
 *   http://xxx.xxx.xxx.xxx/guicomm/#/home
 *   http://xxx.xxx.xxx.xxx:81/guicomm/#/guicom/command
 *
 * Two things were wrong. The chip was built from the preview's own URL, whose
 * origin is the ephemeral loopback port the proxy was given — a number the reader
 * never chose and cannot visit. And the route was not part of what it displayed,
 * so every view of a hash-routed app produced the same string.
 *
 * The suffix is also what the chip has to TRUNCATE FROM, if it truncates at all:
 * two views of one app share a host and a path prefix and differ only in the tail,
 * so clipping the right would leave `http://10.0.0.7:81/guicomm/#/...` for all of
 * them. That is asserted here too, because it is invisible in a unit test of the
 * string and only shows up in the stylesheet.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/**
 * Lift `previewAddress` and run the real implementation.
 *
 * Sliced rather than re-implemented: a copy of the logic in the test would pass
 * while the shipped function was wrong, which is the failure mode this whole file
 * exists to avoid.
 */
const start = src.indexOf('function previewAddress(')
assert.ok(start !== -1, 'previewAddress is present in the bundle')
const end = src.indexOf('\n    }', src.indexOf('return String(url || \'\')', start))
const body = src.slice(start, end + '\n    }'.length)
const previewAddress = new Function(`${body}\n return previewAddress`)()

console.log('=== the address the reader actually opened ===')
// The proxy port is 51234; the reader opened port 81 on a LAN host.
const TARGET = 'http://10.0.0.7:81'
check(
  previewAddress('http://localhost:51234/guicomm/#/home', TARGET) === '10.0.0.7:81/guicomm/#/home',
  'the chip shows the host the reader opened, not the proxy port',
  previewAddress('http://localhost:51234/guicomm/#/home', TARGET),
)
check(
  previewAddress('http://localhost:51234/guicomm/#/guicom/command', TARGET)
    === '10.0.0.7:81/guicomm/#/guicom/command',
  'and the whole route, hash included',
  previewAddress('http://localhost:51234/guicomm/#/guicom/command', TARGET),
)

console.log('')
console.log('=== two views of one app are distinguishable ===')
// The reader's exact complaint: switching pages inside the app left the chip
// showing one unchanging string.
const home = previewAddress('http://localhost:51234/guicomm/#/home', TARGET)
const command = previewAddress('http://localhost:51234/guicomm/#/guicom/command', TARGET)
check(home !== command, 'two hash routes produce two different addresses', `${home} vs ${command}`)
const a = previewAddress('http://localhost:51234/users', TARGET)
const b = previewAddress('http://localhost:51234/usage-log', TARGET)
check(a !== b, 'and so do two path routes', `${a} vs ${b}`)
check(a === '10.0.0.7:81/users', 'a path route keeps its path', a)

console.log('')
console.log('=== the query string survives, because views are often selected by it ===')
check(
  previewAddress('http://localhost:51234/app?tab=billing', TARGET) === '10.0.0.7:81/app?tab=billing',
  'the search string is kept',
  previewAddress('http://localhost:51234/app?tab=billing', TARGET),
)

console.log('')
console.log('=== it degrades instead of blanking ===')
// The root of an app is just the host: `/` on its own adds nothing the reader did
// not already read.
check(previewAddress('http://localhost:51234/', TARGET) === '10.0.0.7:81',
  'a root path is not shown as a bare slash',
  previewAddress('http://localhost:51234/', TARGET))
// The panel also accepts workspace-file forms that `new URL` rejects outright.
check(previewAddress('/workspace/page.html') === '/workspace/page.html',
  'an unparseable target falls back to the raw string',
  previewAddress('/workspace/page.html'))
check(previewAddress('') === '', 'and an empty value stays empty')
// A file target has no http origin to take a host from, so the preview's own is
// used rather than nothing.
const fileish = previewAddress('http://localhost:51234/preview/page.html', '/w/page.html')
check(fileish === 'localhost:51234/preview/page.html',
  'a non-http target keeps the preview host rather than dropping it',
  fileish)

console.log('')
console.log('=== the chip truncates from the left, keeping the route ===')
// The stylesheet half of the same requirement. `direction: rtl` is what puts the
// ellipsis on the left; clipping the right would show the same prefix for every
// view and reintroduce exactly the complaint the chip was fixed for.
const css = src.slice(src.indexOf('const CSS = `'), src.indexOf('\n`', src.indexOf('const CSS = `')))
const locRule = css.slice(css.indexOf('.dsa-loc-host{'))
const rule = locRule.slice(0, locRule.indexOf('}'))
check(/direction:rtl/.test(rule), 'the address is truncated from the left', rule.slice(0, 60))
check(/text-overflow:ellipsis/.test(rule), 'with a visible ellipsis')
check(/overflow:hidden/.test(rule), 'and the clipping that makes the ellipsis appear')
// `direction: rtl` reorders mixed-direction text, so the characters themselves
// must be isolated back to LTR or the address reads backwards.
check(/<bdi>/.test(src) || /'bdi'/.test(src), 'the address glyphs are isolated so they do not reverse')

console.log('')
if (failures) {
  console.log(`ADDRESS CHIP CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('ADDRESS CHIP CHECKS PASSED')
