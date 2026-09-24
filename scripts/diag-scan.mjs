/**
 * Show what the port scan actually reports for the servers on this machine,
 * including the stack fingerprints. This is the readout the panel renders.
 */
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL('E:/StudyFile/AI-Workspace/dsh_workspace/plugins/dsh-annotate/lib/index.js').href)

// Reach the probe helpers the host uses. They are module-private, so the scan
// is driven through the plugin's own HTTP handler instead: start the route on a
// throwaway context and POST `detect` to it.
import http from 'node:http'

const routes = []
const ctx = {
  // The plugin owns its route through ctx.effect, so the stub must actually run
  // the callback the way cordis does.
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  interval: () => () => {},
  get: () => undefined,
  logger: { warn() {}, info() {}, error() {} },
  webServer: {
    register(spec) {
      routes.push(spec)
      return () => {}
    },
  },
}
mod.apply(ctx, { enabled: true, allowRemote: false, idleMs: 300000 })
if (!routes.length) {
  console.log('the plugin registered no route')
  process.exit(1)
}

const { handler } = routes[0]
const server = http.createServer((req, res) => handler(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const body = JSON.stringify({ root: 'E:/StudyFile/AI-Workspace/dsh_workspace' })
const result = await new Promise((resolve) => {
  const req = http.request(
    { host: '127.0.0.1', port, path: '/__dsh-annotate/detect', method: 'POST', headers: { 'content-type': 'application/json' } },
    (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve(JSON.parse(text)))
    },
  )
  req.end(body)
})

console.log('servers found:', result.servers.length)
console.log('')
for (const s of result.servers) {
  const tag = s.stack ? `${s.stack.label} [${s.stack.kind}]` : '(unrecognised)'
  console.log(`  :${String(s.port).padEnd(6)} ${tag.padEnd(24)} ${s.title ? `"${s.title}"` : ''}`)
}

const labelled = result.servers.filter((s) => s.stack).length
console.log('')
console.log(`fingerprinted ${labelled}/${result.servers.length} servers`)

// Close immediately: the scan itself must not keep the process alive.
server.close()
process.exit(0)
