/**
 * Reproduce the reported crash by driving the real preview manager.
 *
 * Reported: marking an element and saving blanked the sidebar; after reloading
 * DSH, opening the same local file again failed with
 * `Cannot read properties of null (reading 'origin')`.
 *
 * The manager is lifted out of the host module and exercised with the same
 * request shapes the HTTP layer builds, so this fails on the shipped bug and
 * passes on the fix rather than matching on source text.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const src = readFileSync(SRC, 'utf8')

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) {
    failures += 1
    if (detail !== undefined) console.log(`       ${detail}`)
  }
}

/**
 * Lift one top-level function declaration by matching braces.
 * @param source - the module text.
 * @param marker - the declaration's opening text.
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

console.log('=== the reuse loop, driven directly ===')
// The manager's `open()` needs a real port to bind, so the reuse decision is
// exercised on its own: the loop body is lifted and run against a preview list
// shaped exactly as the manager builds it.
const loopSrc = extractFunction(src, 'async function open(request)')
const guardSrc = loopSrc.slice(loopSrc.indexOf('for (const preview'), loopSrc.indexOf('const sid = randomUUID()'))

/** Build an `open` that only performs the reuse scan, against a given list. */
function makeReuse(previews, request) {
  const decides = `${guardSrc}
    return null`
  // Mirrors the real `open()` signature. It has to be kept in step by hand,
  // because this lifts the loop body out of the source rather than calling it:
  // a parameter added to the manager and missed here shows up as a
  // ReferenceError from inside the extracted text, which is what happened when
  // `accent` was added.
  // eslint-disable-next-line no-new-func
  return new Function('previews', 'request', `
    const { origin, target, fileRoot, accent } = request
    ${decides}
  `)(previews, request)
}

// A file preview as the manager constructs it: target null, targetOrigin set,
// origin the ephemeral loopback address.
const filePreview = {
  sid: 'aaaa1111',
  target: null,
  targetOrigin: 'file:///E:/proj',
  fileRoot: 'E:/proj',
  origin: 'http://localhost:51234',
  touched: 0,
}
const remotePreview = {
  sid: 'bbbb2222',
  target: { origin: 'http://localhost:5173' },
  targetOrigin: 'http://localhost:5173',
  fileRoot: null,
  origin: 'http://localhost:51235',
  touched: 0,
}

console.log('\n--- reopening the same local file (the reported case) ---')
const sameFile = { origin: 'file:///E:/proj', target: null, fileRoot: 'E:/proj' }
let reused = null
let threw = null
try {
  reused = makeReuse(new Map([['aaaa1111', filePreview]]), sameFile)
} catch (error) {
  threw = error
}
check(threw === null, 'reopening a file preview does not throw', threw && threw.message)
check(reused === filePreview, 'and it reuses the existing preview')

console.log('\n--- a second, different file ---')
const otherFile = { origin: 'file:///E:/other', target: null, fileRoot: 'E:/other' }
let otherResult = null
let otherThrew = null
try {
  otherResult = makeReuse(new Map([['aaaa1111', filePreview]]), otherFile)
} catch (error) {
  otherThrew = error
}
check(otherThrew === null, 'a different file does not throw', otherThrew && otherThrew.message)
check(otherResult === null, 'and it does not reuse the wrong preview')

console.log('\n--- a file preview sitting alongside a remote one ---')
// The loop visits every preview, so one null target anywhere is enough to throw.
const mixed = new Map([['aaaa1111', filePreview], ['bbbb2222', remotePreview]])
let mixedThrew = null
try {
  makeReuse(mixed, { origin: 'http://localhost:5173', target: { origin: 'http://localhost:5173' }, fileRoot: null })
} catch (error) {
  mixedThrew = error
}
check(mixedThrew === null, 'scanning past a file preview does not throw', mixedThrew && mixedThrew.message)

console.log('\n--- the same remote target is still reused ---')
const remoteHit = makeReuse(mixed, { origin: 'http://localhost:5173', target: { origin: 'http://localhost:5173' }, fileRoot: null })
check(remoteHit === remotePreview, 'an identical remote target reuses its preview')

console.log('\n=== no code reads origin through a nullable target ===')
// `open()` and the request path must not dereference `preview.target`.
const openBody = extractFunction(src, 'async function open(request)')
check(!/preview\.target\.origin/.test(openBody), 'the reuse loop never reads preview.target.origin')
// proxyHttp is reached only when fileRoot is unset, so its read is safe; assert
// that routing stays that way.
const routing = src.slice(src.indexOf('async function handlePreviewRequest'), src.indexOf('function handlePreviewRequest') + 900)
check(/if \(preview\.fileRoot\) return serveStatic/.test(routing),
  'file previews return before the proxy path')
check(/return proxyHttp\(req, res, preview\)/.test(routing), 'the proxy path is last')

console.log('')
if (failures) {
  console.log(`PREVIEW REUSE CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('PREVIEW REUSE CHECKS PASSED')
