/**
 * Drive the reported sequence end to end through the host HTTP surface.
 *
 * Reported: pick an element, type a note, save → sidebar went blank; reopening
 * the same local file then failed with
 * `Cannot read properties of null (reading 'origin')`.
 *
 * Two independent faults were found and fixed. This replays the sequence so the
 * fix is checked as a flow, not as two isolated unit tests: the sidebar reports
 * the save, then the same file is opened again.
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

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
  const calls = { register: [], hooks: [], session: [] }
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
    on: (event, fn) => {
      if (event === 'agent/pre-step') calls.hooks.push(fn)
      if (event === 'session/event') calls.session.push(fn)
      return () => {}
    },
    inject: (n, fn) => fn(ctx),
    webServer: { register: (o) => { calls.register.push(o); return () => {} } },
    interval: () => () => {},
    timeout: () => () => {},
  }
  ctx._calls = calls
  return ctx
}

/**
 * What the model would receive on one step, read through the real hook.
 *
 * The attachment is a step hook now rather than a prompt-context provider, so
 * this drives it the way the loop does — including the `next()` call whose
 * decision the hook extends. The payload carries the loop's own `position`
 * (`agent.ts:250` spreads `{ turn, step }` in), and the plugin keys its
 * once-per-turn guard on `turn`, so a fresh turn number is supplied per call.
 */
let turnCounter = 0
async function attachedText(ctx, session, position) {
  const at = position || { turn: ++turnCounter, step: 1 }
  let chain = async () => ({ kind: 'enter', messages: [] })
  for (const fn of ctx._calls.hooks) {
    const inner = chain
    chain = async () => fn({
      agent: { id: session },
      signal: { aborted: false },
      turn: at.turn,
      step: at.step,
    }, inner)
  }
  const decision = await chain()
  const mine = decision.messages.filter((m) => m.source && m.source.plugin === 'dsh-annotate')
  if (!mine.length) return ''
  return mine[0].content.map((b) => (b.type === 'text' ? b.text : '')).join('')
}

function callHandler(handler, { method, path, body }) {
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = method
    req.url = path
    // A real Node request always carries these; `requestOrigin` reads the socket
    // to decide the scheme, so the stand-in has to provide one.
    req.headers = { host: '127.0.0.1:3080' }
    req.socket = { encrypted: false }
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
    setImmediate(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
    handler(req, res)
    setTimeout(() => resolve({ status: 0, body: 'TIMEOUT' }), 4000)
  })
}

const mod = await import(MODULE)
const ctx = makeContext()
mod.apply(ctx, { enabled: true, allowExternalFiles: true })
const handler = ctx._calls.register.find((r) => r.path === '/__dsh-annotate').handler

// A workspace with two real pages, so a second open is possible without
// touching anything outside the fixture directory. The fixtures are written here
// and removed at the end, so the check leaves nothing behind.
const dir = `${process.cwd().replace(/\\/g, '/')}/_flowfix`
const pageA = `${dir}/a.html`
const pageB = `${dir}/b.html`
const PAGE = (label) => `<!doctype html><html><body><button class="x">${label}</button></body></html>\n`
mkdirSync(dir, { recursive: true })
writeFileSync(pageA, PAGE('A'))
writeFileSync(pageB, PAGE('B'))

console.log('=== step 1: open a local file (as the sidebar does) ===')
const first = await callHandler(handler, { method: 'POST', path: '/__dsh-annotate/open', body: { url: `file:///${pageA}`, root: dir } })
check(first.status === 200 && first.body && first.body.ok === true, 'the first open succeeds', JSON.stringify(first.body).slice(0, 140))
check(typeof first.body.sid === 'string', 'a preview id comes back', first.body && first.body.sid)

console.log('')
console.log('=== step 2: mark an element and save the note ===')
// Exactly what the sidebar posts after a save.
const saved = await callHandler(handler, {
  method: 'POST',
  path: '/__dsh-annotate/context',
  body: {
    session: 'session-under-test',
    annotations: [{
      selector: '.g-recharge',
      text: 'Recharge',
      note: '汇率太小，改成 20px',
      at: '679,276 50×16',
      matches: 1,
    }],
  },
})
check(saved.status === 200 && saved.body && saved.body.ok === true, 'the save is accepted', JSON.stringify(saved.body))
check(saved.body && saved.body.count === 1, 'one annotation is held', String(saved.body && saved.body.count))

console.log('')
console.log('=== step 3: what the model would receive ===')
// Read through the hook, which is what a real step does. Step 7 revisits this.
const rendered = await attachedText(ctx, 'session-under-test')
check(typeof rendered === 'string' && rendered.length > 0, 'the hook produced a block')
console.log('--- what the model would receive ---')
console.log(rendered.split('\n').map((l) => `    ${l}`).join('\n'))
check(/# Web page elements/.test(rendered), 'the block is headed')
check(/note: 汇率太小/.test(rendered), 'the note is included')

console.log('')
console.log('=== step 4: reopen THE SAME file (the reported failure) ===')
// This is where `Cannot read properties of null (reading 'origin')` was thrown:
// the reuse loop dereferenced preview.target, which is null for a file preview.
const again = await callHandler(handler, { method: 'POST', path: '/__dsh-annotate/open', body: { url: `file:///${pageA}`, root: dir } })
check(again.status === 200 && again.body && again.body.ok === true,
  'reopening the same file succeeds', JSON.stringify(again.body).slice(0, 200))
check(again.body && again.body.sid === first.body.sid, 'and it reuses the same preview',
  `${again.body && again.body.sid} vs ${first.body && first.body.sid}`)

console.log('')
console.log('=== step 5: open a different file in the same directory ===')
const other = await callHandler(handler, { method: 'POST', path: '/__dsh-annotate/open', body: { url: `file:///${pageB}`, root: dir } })
check(other.status === 200 && other.body && other.body.ok === true,
  'a different file opens', JSON.stringify(other.body).slice(0, 160))
// Files in one directory share a preview server: the server exists to give the
// framed document an origin of its own, and the entry path is what selects the
// file. Reusing it is the intent, so this asserts the URL rather than the id.
check(other.body && other.body.url && other.body.url.endsWith('/b.html'),
  'the entry URL names the second file', other.body && other.body.url)
check(other.body && other.body.sid === first.body.sid,
  'and the directory keeps its one preview server')

console.log('')
console.log('=== step 6: back to the first file, with both previews alive ===')
// The reuse loop walks every preview, so one null target anywhere used to throw.
const back = await callHandler(handler, { method: 'POST', path: '/__dsh-annotate/open', body: { url: `file:///${pageA}`, root: dir } })
check(back.status === 200 && back.body && back.body.ok === true,
  'returning to the first file succeeds', JSON.stringify(back.body).slice(0, 160))
check(back.body && back.body.sid === first.body.sid, 'and still reuses its preview')

console.log('')
console.log('=== step 7: opening pages does not disturb what is held ===')
// Step 3 read the block, but reading does not clear it: the clear is tied to the
// END of the turn, because an assembly can happen without becoming a message and
// discarding the reader's annotations on a cancelled turn would be worse than one
// extra step of context.
const peek = await callHandler(handler, { method: 'POST', path: '/__dsh-annotate/pending', body: { session: 'session-under-test' } })
check(peek.body && peek.body.count === 1, 'the block survives the step that delivered it',
  JSON.stringify(peek.body && peek.body.count))
check(peek.body && peek.body.block === rendered, 'and still renders identically for inspection')
check(await attachedText(ctx, 'other') === '', 'another session still gets nothing')

console.log('')
console.log('=== step 8: the turn ending drops it ===')
// The turn boundary is the clear. It must be `turn/end`: `turn/start` precedes the
// step loop, so clearing there would wipe the annotations before any read.
for (const fn of ctx._calls.session) fn({ id: 'session-under-test' }, { type: 'turn/end', turn: 1 })
check(await attachedText(ctx, 'session-under-test') === '',
  'the following turn receives nothing')
const after = await callHandler(handler, { method: 'POST', path: '/__dsh-annotate/pending', body: { session: 'session-under-test' } })
check(after.body && after.body.count === 0, 'and the store is now empty',
  JSON.stringify(after.body && after.body.count))

console.log('')
if (failures) {
  console.log(`REPORTED SEQUENCE CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('REPORTED SEQUENCE CHECKS PASSED')

// Each preview bound a real loopback port, and the plugin's idle sweep is the
// only thing that would release them. Close them so the process can exit.
for (const body of [first, again, other, back]) {
  if (body && body.body && body.body.sid) {
    await callHandler(handler, { method: 'POST', path: '/__dsh-annotate/close', body: { sid: body.body.sid } })
  }
}
rmSync(dir, { recursive: true, force: true })
process.exit(0)
void readFileSync
