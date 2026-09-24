/**
 * End-to-end proxy check: start a real web app on loopback, open it through the
 * plugin's preview proxy, and confirm the HTML comes back injected, the framing
 * headers are gone, and sub-resources are served.
 */
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/a3025/.dsh/profiles/web/package.json')
const cordis = require('@deepseek-ai/cordis')
const Timer = require('E:/StudyFile/AI-Workspace/deepseek-harness/vendor/timer/lib/index.js').default
const WebServer = require('@deepseek-ai/dsh-host-webserver').default

// --- the app being annotated -------------------------------------------------
const app = http.createServer((req, res) => {
  if (req.url === '/app.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end('window.__APP_LOADED__ = true;')
    return
  }
  if (req.url === '/api/data') {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=abc123; Path=/; HttpOnly' })
    res.end(JSON.stringify({ ok: true, sawCookie: req.headers.cookie || null }))
    return
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    // These must all be stripped or the page cannot be framed.
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'same-origin',
  })
  res.end('<!doctype html><html><head><title>Demo App</title></head><body><h1 id="total">Hello</h1><button class="primary">Save changes</button><script src="/app.js"></script></body></html>')
})
await new Promise((done) => app.listen(0, '127.0.0.1', done))
const appPort = app.address().port
console.log('demo app on', appPort)

// --- the harness side --------------------------------------------------------
const ctx = new cordis.Context()
ctx.plugin(Timer)
ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
await new Promise((done) => setTimeout(done, 600))
const mod = await import('../lib/index.js')
mod.apply(ctx, { allowRemote: false })
await new Promise((done) => setTimeout(done, 400))

const base = `http://127.0.0.1:${ctx.webServer.port}/__dsh-annotate`
const open = await fetch(`${base}/open`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: `http://127.0.0.1:${appPort}/`, root: 'E:/StudyFile/AI-Workspace/dsh_workspace' }),
})
const opened = await open.json()
console.log('open ->', open.status, opened.origin, 'sid:', opened.sid)
if (!opened.ok) process.exit(1)

// Fetch through the preview the way a browser frame would, naming the parent.
const previewOrigin = opened.origin
const page = await fetch(`${previewOrigin}/`, {
  headers: { referer: `${previewOrigin}/`, 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' },
})
const html = await page.text()
console.log('page status:', page.status)
console.log('x-frame-options stripped:', page.headers.get('x-frame-options') === null)
console.log('csp stripped:', page.headers.get('content-security-policy') === null)
console.log('coop stripped:', page.headers.get('cross-origin-opener-policy') === null)
console.log('coep stripped:', page.headers.get('cross-origin-embedder-policy') === null)
console.log('corp stripped:', page.headers.get('cross-origin-resource-policy') === null)
console.log('config injected:', html.includes('window.__DSH_ANNOTATE__='))
console.log('overlay injected:', html.includes('__DSH_ANNOTATE_OVERLAY__'))
console.log('shim injected:', html.includes('__DSH_ANNOTATE_SHIM__'))
console.log('app markup intact:', html.includes('id="total"') && html.includes('/app.js'))

// Sub-resource through the same preview.
const script = await fetch(`${previewOrigin}/app.js`, {
  headers: { referer: `${previewOrigin}/`, 'sec-fetch-dest': 'script', 'sec-fetch-site': 'same-origin' },
})
console.log('app.js ->', script.status, (await script.text()).slice(0, 40))

// Cookie is namespaced on the way back.
const api = await fetch(`${previewOrigin}/api/data`, {
  headers: { referer: `${previewOrigin}/`, 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' },
})
const setCookie = api.headers.get('set-cookie')
console.log('api ->', api.status, 'cookie rewritten:', /dsa_[A-Za-z0-9_-]+_sid=abc123/.test(setCookie || ''), '|', (setCookie || '').slice(0, 60))

// A cross-origin caller must not be able to read through the preview.
const blocked = await fetch(`${previewOrigin}/`, { headers: { referer: 'https://evil.example/', 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'empty' } })
console.log('cross-site read ->', blocked.status, '(expect 403)')

app.close()
process.exit(0)
