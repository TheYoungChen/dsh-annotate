/**
 * Check the stack fingerprinting against real response shapes.
 *
 * Each case is a header/body pair taken from a server that actually runs on this
 * machine or from a framework's documented signature. A mislabel would be worse
 * than no label, so input that identifies nothing must stay unrecognised rather
 * than falling through to a guess.
 *
 * The fixtures are served on real loopback ports and found by the plugin's own
 * scan, so the test exercises header capture and body reading, not just the
 * classifier in isolation.
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import http from 'node:http'

const PLUGIN = fileURLToPath(new URL('..', import.meta.url))
const WORKSPACE = 'E:/StudyFile/AI-Workspace/dsh_workspace'

const FIXTURES = [
  {
    name: 'Vite dev server',
    headers: { server: 'Vite', 'content-type': 'text/html' },
    body: '<script type="module" src="/@vite/client"></script><div id="root"></div>',
    expect: /vite/i,
  },
  {
    name: 'Next.js',
    headers: { 'x-nextjs-cache': 'HIT', 'content-type': 'text/html' },
    body: '<script src="/_next/static/chunks/main.js"></script><script id="__NEXT_DATA__" type="application/json">{}</script>',
    expect: /next/i,
  },
  {
    name: 'Nuxt',
    headers: { 'content-type': 'text/html' },
    body: '<div id="__nuxt"></div><script src="/_nuxt/entry.js"></script>',
    expect: /nuxt/i,
  },
  {
    name: 'production React bundle',
    headers: { 'content-type': 'text/html' },
    body: '<script defer src="/static/js/lib-react.js"></script><script defer src="/static/js/vendor-ui-primitives.js"></script>',
    expect: /react/i,
  },
  {
    name: 'Vue 2 with scoped styles',
    headers: { 'content-type': 'text/html' },
    body: '<div data-v-7ba5bd90 class="app"></div><script src="/js/vue.runtime.min.js"></script>',
    expect: /vue/i,
  },
  {
    name: 'New API gateway',
    headers: { 'x-new-api-version': '0.1.12', 'content-type': 'text/html' },
    body: '<title>dev</title>',
    expect: /new api/i,
  },
  {
    name: 'Express',
    headers: { 'x-powered-by': 'Express', 'content-type': 'text/html' },
    body: '<h1>hello</h1>',
    expect: /express/i,
  },
  {
    name: 'nginx-served static site',
    headers: { server: 'nginx/1.25.3', 'content-type': 'text/html' },
    body: '<h1>site</h1>',
    expect: /nginx/i,
  },
  {
    name: 'plain static server, nothing to identify',
    headers: { 'content-type': 'text/html' },
    body: '<h1>just some html</h1>',
    expect: null,
  },
  {
    // The reported case: a port that answers every path with 404. It is listening,
    // so the sweep sees it, but a reader who clicked it landed on "not found".
    name: 'a listener that 404s everywhere',
    headers: { 'content-type': 'text/html' },
    body: '<h1>404 Not Found</h1>',
    status: 404,
    expect: null,
    expectListed: false,
  },
  {
    // A service that serves real content but sets no `<title>`. It must stay in the
    // list — it IS openable — and carry its entry path and content type so the row
    // is not a bare "localhost".
    name: 'a page with no title',
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: '<h1>no title here</h1>',
    expect: null,
    expectListed: true,
    expectPath: '/',
  },
  {
    // Serving at a sub-path only. The row must point at the path that answered.
    name: 'a page served only at /docs',
    headers: { 'content-type': 'text/html' },
    body: '<title>Docs</title>',
    onlyPath: '/docs',
    expect: null,
    expectListed: true,
    expectPath: '/docs',
  },
]

const failures = []
const ok = (condition, label, detail) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

// Start every fixture at once, then let one scan see them all.
const servers = []
for (const fixture of FIXTURES) {
  const server = http.createServer((req, res) => {
    // A fixture may serve only one path, so the probe's walk for a usable entry
    // point can be exercised rather than assumed.
    if (fixture.onlyPath && req.url !== fixture.onlyPath) {
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end('<h1>404</h1>')
      return
    }
    res.writeHead(fixture.status || 200, fixture.headers)
    res.end(fixture.body)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  fixture.port = server.address().port
  servers.push(server)
}

// Run the plugin's own route so the scan under test is the shipped one.
const mod = await import(pathToFileURL(`${PLUGIN}/lib/index.js`).href)
const routes = []
mod.apply(
  {
    effect(fn) {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    interval: () => () => {},
    get: () => undefined,
    // The plugin subscribes to the turn boundary and the step hook; this stand-in
    // only needs to accept the subscription and hand back a disposer.
    on: () => () => {},
    logger: { warn() {}, info() {}, error() {} },
    webServer: {
      register(spec) {
        routes.push(spec)
        return () => {}
      },
    },
  },
  { enabled: true, allowRemote: false, idleMs: 300000 },
)

const host = http.createServer((req, res) => routes[0].handler(req, res))
await new Promise((r) => host.listen(0, '127.0.0.1', r))
const hostPort = host.address().port

const result = await new Promise((resolve) => {
  const req = http.request(
    { host: '127.0.0.1', port: hostPort, path: '/__dsh-annotate/detect', method: 'POST', headers: { 'content-type': 'application/json' } },
    (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve(JSON.parse(text)))
    },
  )
  req.end(JSON.stringify({ root: WORKSPACE, ports: FIXTURES.map((f) => f.port) }))
})

console.log(`scan returned ${result.servers.length} servers\n`)

for (const fixture of FIXTURES) {
  const found = result.servers.find((s) => s.port === fixture.port)
  console.log(fixture.name)
  // A fixture may declare that it should not be offered at all — the port that
  // answers 404 everywhere. Listing it is the reported bug.
  if (fixture.expectListed === false) {
    ok(!found, 'the port is NOT offered, because it has nothing to open',
      found ? `:${found.port} was listed` : '(correctly absent)')
    console.log('')
    continue
  }
  if (fixture.expect === null) {
    ok(Boolean(found), 'the server is still listed even with no label', found && `:${found.port}`)
    ok(!found || !found.stack, 'no stack is guessed', (found && found.stack && found.stack.label) || '(none)')
  } else {
    ok(Boolean(found), 'the server is found', found ? `:${found.port}` : 'not found')
    const label = found && found.stack && found.stack.label
    ok(Boolean(label) && fixture.expect.test(label), 'labelled correctly', label || '(none)')
  }
  // The entry path and content type are what make a titleless row identifiable.
  if (fixture.expectPath !== undefined) {
    ok(found && found.path === fixture.expectPath, 'the entry path is reported',
      found ? `${found.path} (wanted ${fixture.expectPath})` : 'not found')
  }
  if (found) {
    ok(typeof found.type === 'string' && found.type.length > 0,
      'the content type is reported, so a titleless row can still be named', found.type || '(none)')
  }
  console.log('')
}

for (const server of servers) server.close()
host.close()

if (failures.length) {
  console.log(`STACK CHECKS FAILED — ${failures.length} problem(s)`)
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
console.log('STACK CHECKS PASSED')
process.exit(0)
