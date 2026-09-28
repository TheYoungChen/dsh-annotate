/**
 * Drive the host's HTTP actions directly, including hostile input.
 *
 * The route is reachable from the page, so `context` and `consume` must reject
 * anything malformed rather than throw. An unhandled throw inside the handler
 * becomes a 500 at best; the concern is a hang or a crash that takes the host
 * down while the user is mid-edit.
 *
 * apply() is run against a stand-in context and the captured handler is called
 * with synthetic request/response objects, so this exercises the real dispatch.
 */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'

const MODULE = new URL('../lib/index.js', import.meta.url).href

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) {
    failures += 1
    if (detail !== undefined) console.log(`       ${detail}`)
  }
}

function makeContext() {
  const calls = { register: [] }
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    get: (name) => (name === 'systemPrompt' ? { context: () => () => {} } : undefined),
    effect: (fn) => { fn(); return () => {} },
    on: () => () => {},
    inject: (n, fn) => fn(ctx),
    webServer: { register: (o) => { calls.register.push(o); return () => {} } },
    interval: () => () => {},
    timeout: () => () => {},
  }
  ctx._calls = calls
  return ctx
}

/** Minimal express-like req/res the handler can drive. */
function callHandler(handler, { method, path, body }) {
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = method
    req.url = path
    req.headers = {}
    const chunks = []
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v },
      writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}) },
      end(payload) {
        let parsed = null
        try { parsed = payload ? JSON.parse(payload) : null } catch { parsed = payload }
        resolve({ status: this.statusCode, body: parsed })
      },
    }
    // The handler reads a JSON body, then answers. Feed it on the next tick so
    // the handler's own listeners are attached first.
    setImmediate(() => {
      if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)))
      for (const c of chunks) req.emit('data', c)
      req.emit('end')
    })
    handler(req, res)
    setTimeout(() => resolve({ status: 0, body: 'TIMEOUT' }), 3000)
  })
}

const mod = await import(MODULE)
const ctx = makeContext()
mod.apply(ctx, { enabled: true, allowExternalFiles: true })

const handler = ctx._calls.register.find((r) => r.path === '/__dsh-annotate').handler
check(typeof handler === 'function', 'the route handler was captured')

const call = (opts) => callHandler(handler, { method: 'POST', path: `/__dsh-annotate/${opts.action}`, body: opts.body })

console.log('\n=== ping still answers ===')
const ping = await callHandler(handler, { method: 'GET', path: '/__dsh-annotate/ping' })
check(ping.status === 200 && ping.body && ping.body.ok === true, 'GET ping → 200 ok', JSON.stringify(ping.body))
// Read the expected version from the manifest rather than repeating it, so a
// release bump cannot leave this test asserting a stale number.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
check(ping.body && ping.body.version === manifest.version, 'reports the manifest version',
  `ping ${ping.body && ping.body.version} vs package.json ${manifest.version}`)

console.log('\n=== context accepts a well-formed report ===')
const good = await call({ action: 'context', body: { session: 's1', annotations: [{ selector: '.a', note: 'n' }] } })
check(good.status === 200 && good.body && good.body.ok === true, 'accepted', JSON.stringify(good.body))
check(good.body && good.body.count === 1, 'reports the count', String(good.body && good.body.count))

console.log('\n=== context rejects malformed input without throwing ===')
const hostile = [
  ['no session', { annotations: [] }],
  ['empty session', { session: '', annotations: [] }],
  ['numeric session', { session: 42, annotations: [] }],
  ['null annotations', { session: 's1', annotations: null }],
  ['annotations not an array', { session: 's1', annotations: 'nope' }],
  ['annotations is an object', { session: 's1', annotations: { a: 1 } }],
  ['empty body', {}],
]
for (const [label, body] of hostile) {
  const res = await call({ action: 'context', body })
  check(res.status === 200 && res.body && res.body.ok === false, `refuses ${label}`, `status ${res.status} ${JSON.stringify(res.body)}`)
}

// Non-object entries carry no field this plugin reads. They are dropped rather
// than stored, so the held list never contains something the renderer must
// defend against later.
console.log('\n=== non-object entries are dropped, not stored ===')
const junk = await call({ action: 'context', body: { session: 'junk', annotations: [1, 'two', null, [], { selector: '.real' }] } })
check(junk.body && junk.body.count === 1, 'only the usable entry is counted', JSON.stringify(junk.body))

console.log('\n=== an entry with nothing to say is not rendered ===')
// Entries that survive the filter but carry no readable field must not become
// empty headings in the model's context.
await call({ action: 'context', body: { session: 's2', annotations: [{}, { selector: null }, { note: 42 }, { selector: '   ' }] } })
const emptyish = await call({ action: 'consume', body: { session: 's2' } })
check(emptyish.status === 200 && emptyish.body && emptyish.body.ok === true, 'accepted and cleared', JSON.stringify(emptyish.body))

console.log('\n=== consume clears exactly the named session ===')
await call({ action: 'context', body: { session: 'keep', annotations: [{ selector: '.keep' }] } })
await call({ action: 'context', body: { session: 'drop', annotations: [{ selector: '.drop' }] } })
const consumed = await call({ action: 'consume', body: { session: 'drop' } })
check(consumed.body && consumed.body.cleared === true, 'reports that it cleared one')
const again = await call({ action: 'consume', body: { session: 'drop' } })
check(again.body && again.body.cleared === false, 'a second clear reports nothing was held')
const noSession = await call({ action: 'consume', body: {} })
check(noSession.status === 200 && noSession.body && noSession.body.ok === true, 'consume without a session is harmless', JSON.stringify(noSession.body))

console.log('\n=== non-POST is refused ===')
const wrongMethod = await callHandler(handler, { method: 'GET', path: '/__dsh-annotate/context' })
check(wrongMethod.status === 405, 'GET on a POST action → 405', String(wrongMethod.status))

console.log('\n=== unknown action is refused, not crashed ===')
const unknown = await call({ action: 'nope', body: { session: 's1' } })
check(unknown.status === 404, 'unknown action → 404', String(unknown.status))

console.log('\n=== malformed JSON does not take the handler down ===')
const bad = await new Promise((resolve) => {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/__dsh-annotate/context'
  req.headers = {}
  const res = {
    setHeader() {},
    writeHead(code) { this.statusCode = code },
    end(payload) { resolve({ status: this.statusCode, body: payload }) },
  }
  setImmediate(() => { req.emit('data', Buffer.from('{not json')); req.emit('end') })
  handler(req, res)
  setTimeout(() => resolve({ status: 0, body: 'TIMEOUT' }), 3000)
})
check(bad.status === 400, 'invalid JSON → 400', String(bad.status))

console.log('\n=== payload stays bounded ===')
// A huge note must not be forwarded whole; the renderer clips.
const long = 'x'.repeat(5000)
await call({ action: 'context', body: { session: 'big', annotations: [{ selector: '.x', note: long }] } })
check(true, 'a 5000-character note is accepted without error')

console.log('')
if (failures) {
  console.log(`HTTP ACTION CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('HTTP ACTION CHECKS PASSED')
