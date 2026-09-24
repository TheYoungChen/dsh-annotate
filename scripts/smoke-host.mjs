/**
 * Boots the real webserver plus timer service and loads the plugin the same way
 * a profile does, then exercises the API over HTTP.
 */
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/a3025/.dsh/profiles/web/package.json')
const cordis = require('@deepseek-ai/cordis')
const Timer = require('E:/StudyFile/AI-Workspace/deepseek-harness/vendor/timer/lib/index.js').default
const WebServer = require('@deepseek-ai/dsh-host-webserver').default

const app = new cordis.Context()
app.plugin(Timer)
app.plugin(WebServer, { host: '127.0.0.1', port: 0 })
await new Promise((done) => setTimeout(done, 600))

console.log('interval after timer:', typeof app.interval)
console.log('webServer after webserver:', typeof app.webServer, app.webServer && typeof app.webServer.register)

const mod = await import('../lib/index.js')
console.log('plugin name:', mod.name, '| inject:', mod.inject)

mod.apply(app, { allowRemote: false })
await new Promise((done) => setTimeout(done, 400))

const port = app.webServer.port
const base = `http://127.0.0.1:${port}/__dsh-annotate`
console.log('listening port:', port)

const ping = await fetch(`${base}/ping`)
console.log('ping ->', ping.status, await ping.text())

const detect = await fetch(`${base}/detect`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ root: 'E:/StudyFile/AI-Workspace/dsh_workspace' }),
})
const detected = await detect.json()
console.log('detect ->', detect.status, 'ok:', detected.ok, 'servers:', (detected.servers || []).length)

// Remote targets must be refused while allowRemote is off.
const remote = await fetch(`${base}/open`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: 'https://example.com/', root: 'E:/StudyFile/AI-Workspace/dsh_workspace' }),
})
console.log('open(remote) ->', remote.status, JSON.stringify(await remote.json()))

// A loopback target that is not listening should fail cleanly, not hang.
const dead = await fetch(`${base}/open`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: 'http://127.0.0.1:59999/', root: 'E:/StudyFile/AI-Workspace/dsh_workspace' }),
})
console.log('open(dead port) ->', dead.status, JSON.stringify(await dead.json()))

console.log('previews open:', app.webServer ? 'n/a' : 'n/a')
process.exit(0)
