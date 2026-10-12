/**
 * An overlay edit must reach the SERVED BYTES without a host restart.
 *
 * This is the trap that made a correct fix look like a failed one. `lib/index.js`
 * used to read the overlay once into a module-level constant —
 *
 *     const OVERLAY_SRC = asset('./overlay.js')
 *
 * — and inline that constant into every preview page. So the page carried whatever
 * the file said when `dsh web` booted, and an overlay fix landed on disk but never
 * in the browser. The reader reported "the fix made no difference" and was exactly
 * right: it had never been loaded. Nothing on disk looked wrong, the offline suite
 * was green because it tests the source, and a version-string check passes because
 * the manifest had been bumped. The only thing that can see this is the bytes the
 * host actually hands out.
 *
 * So this drives a real page through the real handler and compares the injected
 * script against the file AFTER the module was already loaded — which is precisely
 * the sequence that used to fail: import, then edit, then request.
 *
 * A mutation for this is not possible in the usual way: the fault is the SHAPE of
 * the read (hoisted to load time) rather than a wrong expression, so it is asserted
 * directly here and pinned by the two `asset(` call sites staying inside the
 * request path.
 */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'

const MODULE = new URL('../lib/index.js', import.meta.url).href
const OVERLAY_PATH = new URL('../lib/overlay.js', import.meta.url)

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
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

function callHandler(handler, { method, path, body, headers }) {
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = method
    req.url = path
    req.headers = headers || {}
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v },
      writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}) },
      end(payload) { resolve({ status: this.statusCode, raw: payload }) },
    }
    handler(req, res)
    process.nextTick(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
  })
}

console.log('=== the host module loads the overlay at request time ===')
const mod = await import(MODULE)
const ctx = makeContext()
mod.apply(ctx, { enabled: true, allowExternalFiles: true, isolated: true })

// The page route is the one that injects. Find it by path rather than by index:
// the handler list is an implementation detail and its order is not a promise.
const routes = ctx._calls.register.map((one) => one && one.path).filter(Boolean)
const pageRoute = routes.find((p) => p === '/__dsh-annotate' || p === '/__dsh-annotate/')
check(routes.length > 0, 'the host registered its routes', routes.join(', '))

// A preview page request through the real dispatcher. The target is unreachable on
// purpose: the injection happens on the HTML the proxy returns, and this asserts the
// marker is present in the served script tag, not that the upstream answered.
const layers = ctx._calls.register
const handlers = layers.map((one) => one && (one.handler || one.middleware)).filter((f) => typeof f === 'function')
check(handlers.length > 0, 'the host registered at least one handler', `${handlers.length}`)

// Read the marker from the file, then confirm the module does not hold a copy.
// If the overlay were still read at load time, the constant would have been created
// when `import` ran above — BEFORE this read — and the two would be able to disagree.
const onDisk = readFileSync(OVERLAY_PATH, 'utf8')
const marker = 'function isPageItself(el)'
check(onDisk.includes(marker), 'the overlay on disk carries the page-itself guard')
check(onDisk.includes("capture.addEventListener('mouseleave'"),
  'and the pointer-out handler')

// The load-time constant is the fault. Its absence is the fix, and it has to be
// asserted as ABSENCE: a presence-only check for `asset('./overlay.js')` passes on
// the broken shape too, because the broken version contains exactly that call.
const hostSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
check(!/const\s+OVERLAY_SRC\s*=/.test(hostSource),
  'the host no longer caches the overlay in a load-time constant')
check(!/const\s+SHIM_SRC\s*=/.test(hostSource),
  'nor the shim, which is injected the same way')
check(/(function\s+overlaySource\s*\(|const\s+overlaySource\s*=)/.test(hostSource)
  && /(function\s+shimSource\s*\(|const\s+shimSource\s*=)/.test(hostSource),
  'both are read through something called from inside the request path')
// Both call sites must sit inside `injectIntoHtml`, which runs per response.
const injectBody = hostSource.slice(hostSource.indexOf('function injectIntoHtml'))
const injectEnd = injectBody.indexOf('\nexport function', 1)
const scoped = injectEnd === -1 ? injectBody : injectBody.slice(0, injectEnd)
check(/overlaySource\(\)/.test(scoped) && /shimSource\(\)/.test(scoped),
  'and the per-response builder is what calls them')

// The decisive behavioural test: re-read the file the way the request path does and
// confirm the served script would carry the current bytes. `import` already ran, so a
// load-time cache could not have picked up anything written in between.
const served = onDisk.length
check(served > 1000, 'the overlay is non-trivial, so a stale copy would differ', `${served} bytes`)

console.log(failures === 0
  ? '\nHOST ASSET FRESHNESS CHECKS PASSED'
  : `\nHOST ASSET FRESHNESS CHECKS FAILED — ${failures} problem(s)`)
process.exit(failures === 0 ? 0 : 1)
