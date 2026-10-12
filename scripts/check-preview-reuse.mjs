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
// `previewHost` is lifted from the real source rather than reimplemented, so a change
// to how the hostname is derived is exercised here instead of being papered over.
// eslint-disable-next-line no-new-func
const previewHost = new Function(`${extractFunction(src, 'function previewHost(parentHost)')}
  return previewHost`)()

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
  // `accent` was added and again when `host` was.
  //
  // `previewHost` is injected rather than lifted: the loop needs it to compute the
  // host it compares against, and it is a pure function of the request, so the real
  // one is passed in to keep this honest about what the loop actually compares.
  // eslint-disable-next-line no-new-func
  return new Function('previews', 'request', 'previewHost', `
    const { origin, target, fileRoot, accent, host: parentHost } = request
    const host = previewHost(parentHost)
    ${decides}
  `)(previews, request, previewHost)
}

// A file preview as the manager constructs it: target null, targetOrigin set,
// origin the ephemeral loopback address. `host` is the hostname half of that
// address and is part of the reuse key, so a fixture without it describes a record
// the manager never builds.
//
// `targetOrigin` is the FULL address the caller resolved, not a bare origin: the
// host passes `target.href`. The fixtures say so because a fixture built with
// `http://localhost:5173` would describe a reuse key the host no longer produces,
// and the same-app case below would pass for the wrong reason.
const filePreview = {
  sid: 'aaaa1111',
  host: 'localhost',
  target: null,
  targetOrigin: 'file:///E:/proj',
  fileRoot: 'E:/proj',
  origin: 'http://localhost:51234',
  touched: 0,
}
const remotePreview = {
  sid: 'bbbb2222',
  host: 'localhost',
  target: { origin: 'http://localhost:5173' },
  targetOrigin: 'http://localhost:5173/app',
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
  makeReuse(mixed, { origin: 'http://localhost:5173/app', target: { origin: 'http://localhost:5173' }, fileRoot: null })
} catch (error) {
  mixedThrew = error
}
check(mixedThrew === null, 'scanning past a file preview does not throw', mixedThrew && mixedThrew.message)

console.log('\n--- the same remote target is still reused ---')
const remoteHit = makeReuse(mixed, { origin: 'http://localhost:5173/app', target: { origin: 'http://localhost:5173' }, fileRoot: null })
check(remoteHit === remotePreview, 'an identical remote target reuses its preview')

console.log('\n--- TWO PAGES OF ONE APP are two previews (the reported case) ---')
// Reported after the tab strip shipped: "there is only one address bar, I have no way
// to open a second page at all". The cause was here, not in the panel.
//
// The defect was in the CALLER, not the loop: `/open` passed `target.origin`, which
// drops the path, so `localhost:5173/a` and `localhost:5173/b` produced the same reuse
// key, the second `/open` handed back the first page's sid, and the panel correctly
// concluded the page was already open and switched to it. One tab, forever.
//
// So the test must drive the caller's own expression. A fixture that hand-writes
// `origin: '…/a'` describes a request the buggy host never built, and passes on the
// bug — which is exactly what the first version of this case did.
const identitySrc = src.slice(src.indexOf('origin: target ?'), src.indexOf('origin: target ?') + 120)
const identityExpr = identitySrc.slice(identitySrc.indexOf('target ?'), identitySrc.indexOf(',\n'))
// Both `filePath` and `fileRoot` are parameters, and they are given DIFFERENT values at
// every call site below. That is deliberate: an expression keyed on the folder and one
// keyed on the file then produce different strings, so the assertions fail on the bug by
// VALUE rather than by throwing a ReferenceError at the missing name. A test that only
// distinguishes the two by which name it can resolve would be testing the extraction,
// not the decision.
// eslint-disable-next-line no-new-func
const identityOf = new Function('target', 'filePath', 'fileRoot', `return (${identityExpr})`)

/** The full `/open` decision for one raw address, run through the real expressions. */
function openIdentity(storedRaw, wantedRaw) {
  const stored = new URL(storedRaw)
  const wanted = new URL(wantedRaw)
  return makeReuse(
    new Map([['cccc3333', {
      sid: 'cccc3333',
      host: 'localhost',
      target: stored,
      targetOrigin: identityOf(stored, null, null),
      fileRoot: null,
      origin: 'http://localhost:51236',
      touched: 0,
    }]]),
    { origin: identityOf(wanted, null, null), target: wanted, fileRoot: null },
  )
}

/**
 * The `/open` decision for a workspace FILE, through the caller's own expression.
 *
 * A file preview has `target === null`, so the identity comes from the other arm of the
 * same expression. `filePath` and `fileRoot` are given different values — as they are in
 * the host, where one is the page and the other is the folder holding it.
 * @param storedPath - the file already open.
 * @param storedRoot - the folder it sits in.
 * @param wantedPath - the file the reader is now asking for.
 * @param wantedRoot - that file's folder.
 * @returns the preview the reuse scan would pick, or null.
 */
function fileIdentity(storedPath, storedRoot, wantedPath, wantedRoot) {
  return makeReuse(
    new Map([['dddd4444', {
      sid: 'dddd4444',
      host: 'localhost',
      target: null,
      targetOrigin: identityOf(null, storedPath, storedRoot),
      fileRoot: storedRoot,
      origin: 'http://localhost:51237',
      touched: 0,
    }]]),
    { origin: identityOf(null, wantedPath, wantedRoot), target: null, fileRoot: wantedRoot },
  )
}

// Page /a is open; the reader asks for /b of the SAME app.
const appHit = openIdentity('http://localhost:5173/a', 'http://localhost:5173/b')
check(appHit === null, 'a second page of the SAME app does not reuse the first page preview',
  appHit && `reused ${appHit.sid} — the reader would get one tab instead of two`)

// And the same address still reuses, or every switch back would leak a port.
const appAgain = openIdentity('http://localhost:5173/a', 'http://localhost:5173/a')
check(appAgain !== null && appAgain.sid === 'cccc3333',
  'but the exact same address still reuses its preview')

console.log('\n--- TWO PAGES IN ONE DIRECTORY are two previews ---')
// The same defect, a second time, on the other arm of the same expression. A file
// preview has `target === null`, so the identity came from `file://${fileRoot}` — the
// FOLDER the page sits in, not the page. Two pages saved side by side therefore shared
// one reuse key: asking for the second handed back the first one's sid, the panel read
// that as "already open" and switched to it, and the reader saw one tab with no way to
// reach a second — the same report as the app case, on a different kind of address.
//
// Both files sit in ONE directory here, which is exactly what makes `fileRoot`
// insufficient to tell them apart.
const sideBySide = fileIdentity('E:/proj/one.html', 'E:/proj', 'E:/proj/two.html', 'E:/proj')
check(sideBySide === null,
  'a second page in the SAME directory does not reuse the first page preview',
  sideBySide && `reused ${sideBySide.sid} — the reader would get one tab instead of two`)

// Reopening the very same file must still reuse, or every reload leaks a port.
const sameFileAgain = fileIdentity('E:/proj/one.html', 'E:/proj', 'E:/proj/one.html', 'E:/proj')
check(sameFileAgain !== null && sameFileAgain.sid === 'dddd4444',
  'but reopening the exact same page still reuses its preview')

// And a page in a DIFFERENT directory is still distinguished, which it always was.
const otherDir = fileIdentity('E:/proj/one.html', 'E:/proj', 'E:/else/one.html', 'E:/else')
check(otherDir === null, 'a page in another directory is still its own preview')

console.log('\n=== the key is the full address, not just the origin ===')
// The defect was one expression, so this pins the expression itself. Both arms matter:
// the URL arm must be the full href (not the origin, which drops the path) and the file
// arm must be the file (not the folder, which is shared by every page beside it).
check(/origin: target \? target\.href : /.test(src),
  'the host resolves the reuse identity from the full href, not target.origin')
check(/origin: target \? target\.href : `file:\/\/\$\{filePath\}`/.test(src),
  'and a workspace page keys on the FILE, not the directory holding it')

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
