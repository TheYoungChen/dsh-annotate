/**
 * A login must survive the preview, which means the frame has to be SAME-SITE.
 *
 * The plugin has no auth policy at all: nothing reads a credential, and the only
 * auth-adjacent code is the hop-by-hop `proxy-authorization`/`proxy-authenticate`
 * pair plus a ban on `user:pass@` URLs. So "I log in and stay logged out" was a
 * defect, not a restriction — and it was one defect seen four times.
 *
 * The cause was the hostname. The harness answers on `http://127.0.0.1:3080` while
 * the preview server named itself `http://localhost:<port>`. Those are different
 * SITES, so in a cross-site frame the browser refuses the app's own session cookie:
 * the login POST is delivered and the 302 comes back, but the `Set-Cookie` is
 * discarded and the redirect arrives anonymous. Every symptom the reader reported —
 * "it says success but does not navigate", "no cookie is stored", "still logged out",
 * "the console asks me to log in again" — is that one refusal.
 *
 * Storage stays walled off because the preview port is ephemeral, so this is still a
 * different ORIGIN. Cookies are scoped by site, storage by origin: matching the
 * hostname buys the login without handing the preview the harness's `localStorage`.
 *
 * The whole exchange runs through the real handler and the real preview server
 * against a real loopback app, so it fails on the actual behaviour rather than on a
 * string. Needs no running host.
 */
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'

const MODULE = new URL('../lib/index.js', import.meta.url).href

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

/** Drive the captured host handler with a chosen Host header and JSON body. */
function callHandler(handler, { method, path, body, host }) {
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = method
    req.url = path
    req.headers = host ? { host } : {}
    req.socket = { encrypted: false }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v },
      writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}) },
      end(payload) {
        let parsed = null
        try { parsed = payload ? JSON.parse(payload) : null } catch { parsed = payload }
        resolve({ status: this.statusCode, body: parsed })
      },
    }
    handler(req, res)
    setImmediate(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
    setTimeout(() => resolve({ status: 0, body: 'TIMEOUT' }), 5000)
  })
}

// A stand-in for the reader's New API fork: it trusts a session cookie and nothing
// else, so the preview is only "logged in" if a real cookie round-trips.
const seen = []
const upstream = createServer((req, res) => {
  const cookie = String(req.headers.cookie || '')
  const authed = /session=good/.test(cookie)
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, cookie, authed, body })
    if (req.method === 'POST' && req.url === '/api/login') {
      res.writeHead(302, {
        location: '/console',
        'set-cookie': 'session=good; Path=/; HttpOnly; SameSite=Lax',
        'content-type': 'text/plain',
      })
      res.end('ok')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><body><div id="state">${authed ? 'IN' : 'OUT'}</div></body></html>`)
  })
})
await new Promise((done) => upstream.listen(0, '127.0.0.1', done))
const target = `http://127.0.0.1:${upstream.address().port}/`

const mod = await import(MODULE)
const ctx = makeContext()
mod.apply(ctx, { enabled: true, allowExternalFiles: true })
const handler = ctx._calls.register.find((r) => r.path === '/__dsh-annotate').handler
check(typeof handler === 'function', 'the host route handler was captured')

const openPreview = async (host) => {
  const opened = await callHandler(handler, {
    method: 'POST', path: '/__dsh-annotate/open', host, body: { action: 'open', url: target },
  })
  return opened.body
}

console.log('\n=== the preview hostname follows the harness hostname ===')
const onLoopback = await openPreview('127.0.0.1:3080')
check(Boolean(onLoopback && onLoopback.ok), 'a preview opened', JSON.stringify(onLoopback && onLoopback.origin))
check(String(onLoopback.origin).startsWith('http://127.0.0.1:'),
  'reaching the harness on 127.0.0.1 puts the frame on 127.0.0.1 too',
  onLoopback.origin)
check(!String(onLoopback.origin).includes('localhost'),
  'so the frame is same-site with the harness, not cross-site', onLoopback.origin)
// The port must still differ, or the preview would share the harness's origin and
// therefore its storage — the wall the plugin exists to keep.
check(new URL(onLoopback.origin).port !== '3080',
  'and it is still a different ORIGIN, so storage stays walled off',
  `harness 3080 vs preview ${new URL(onLoopback.origin).port}`)

const onLocalhost = await openPreview('localhost:3080')
check(String(onLocalhost.origin).startsWith('http://localhost:'),
  'reaching the harness on localhost puts the frame on localhost', onLocalhost.origin)

// A differing hostname must not reuse the other preview, or the reader would keep
// getting a frame on the wrong site after the harness moved.
check(onLocalhost.origin !== onLoopback.origin,
  'and the two hostnames do not share one preview record')

console.log('\n=== a session login round-trips through the preview ===')
const preview = new URL(onLoopback.origin)
const login = await fetch(new URL('/api/login', preview), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'me', password: 'secret' }),
  redirect: 'manual',
})
const upstreamLogin = seen.find((one) => one.method === 'POST' && one.url === '/api/login')
check(Boolean(upstreamLogin), 'the app received the credential POST')
check(Boolean(upstreamLogin && upstreamLogin.body.includes('secret')),
  'and the credentials arrived intact')
check(login.status === 302, 'it answered with its redirect', String(login.status))

const cookies = typeof login.headers.getSetCookie === 'function'
  ? login.headers.getSetCookie()
  : [login.headers.get('set-cookie')].filter(Boolean)
check(cookies.length > 0, 'the session cookie was issued', cookies.join(' | ') || '(none)')
// The attribute that decides whether a browser keeps this cookie in a framed
// response. The proxy rewrites `SameSite` away and relies on the frame being
// same-site, so this documents the contract the hostname change exists to satisfy.
check(cookies.some((one) => /samesite=lax/i.test(String(one))),
  'and it is one a same-site frame is allowed to keep')

// Follow the redirect the way the browser does, carrying what it would have stored.
const stored = cookies.map((one) => String(one).split(';')[0]).join('; ')
const console_ = await fetch(new URL('/console', preview), { headers: { cookie: stored } })
const html = await console_.text()
check(html.includes('IN'),
  'a request carrying it is recognised as logged in',
  html.match(/id="state">([^<]*)</) ? `state=${html.match(/id="state">([^<]*)</)[1]}` : html.slice(0, 100))

const upstreamConsole = seen.find((one) => one.url === '/console')
check(Boolean(upstreamConsole && /session=good/.test(upstreamConsole.cookie)),
  'and the app got its own cookie name back, untagged',
  upstreamConsole ? `cookie=${upstreamConsole.cookie || '(none)'}` : 'no console request')

console.log(failures === 0
  ? '\nPREVIEW LOGIN CHECKS PASSED'
  : `\nPREVIEW LOGIN CHECKS FAILED — ${failures} problem(s)`)
upstream.close()
process.exit(failures === 0 ? 0 : 1)
