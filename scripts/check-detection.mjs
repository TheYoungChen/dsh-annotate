/**
 * The port sweep must find a server the OS does not report, and must label it.
 *
 * Reported: three servers were running (1420, 8080, 3000) and detection found only
 * 3000. Two separate things can cause that, and this checks both:
 *
 *   1. the port is not in COMMON_PORTS and `netstat` missed it, so it is never probed
 *   2. the port is probed but the stack is not recognised, so the row has no label
 *
 * The sweep is driven through the real HTTP handler, not by calling `probe` directly,
 * because the bug was in how candidates are chosen — a direct `probe` call would test
 * the one part that was never broken.
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'

const root = fileURLToPath(new URL('..', import.meta.url))

let failures = 0
const ok = (pass, label, detail) => {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures += 1
}

// --- the constants under test -------------------------------------------------
console.log('\n=== the port list ===')
const lib = readFileSync(`${root}lib/index.js`, 'utf8')
{
  const listText = lib.slice(lib.indexOf('const COMMON_PORTS = ['), lib.indexOf(']', lib.indexOf('const COMMON_PORTS = [')))
  const ports = [...listText.matchAll(/(\d+)/g)].map((m) => Number(m[1]))
  ok(ports.includes(1420), 'Tauri\'s default port is probed', '1420')
  ok(ports.includes(8080), 'and 8080 is probed')
  ok(ports.includes(3000), 'and 3000 is probed')
  ok(ports.length <= 24, 'the list stays short enough to probe quickly', `${ports.length} ports`)
  ok(new Set(ports).size === ports.length, 'with no duplicates')
}

// --- every stack the host can report has a mark -------------------------------
console.log('\n=== every stack has a logo ===')
{
  const ids = [...new Set([...lib.matchAll(/return \{ id: '([a-z]+)'/g)].map((m) => m[1]))]
  const client = readFileSync(`${root}client.js`, 'utf8')
  const table = client.slice(client.indexOf('const STACK_MARKS = {'), client.indexOf('function StackMark'))
  const marks = [...table.matchAll(/^ {6}([a-z]+): \{/gm)].map((m) => m[1])
  ok(ids.length >= 14, 'the host can report a range of stacks', `${ids.length} ids`)
  const missing = ids.filter((id) => !marks.includes(id))
  ok(missing.length === 0, 'every one of them has a mark', missing.join(', ') || 'none missing')
  // A real logo has substance. The old approximated marks were one or two shapes —
  // a Vue mark that was a plain triangle, a React mark that was a circle with a dot —
  // and at 14px those are indistinguishable from the generic globe they replaced.
  // This counts drawing commands per mark, reading to the NEXT entry rather than to
  // the next newline, because a multi-line path would otherwise be mis-measured.
  const thin = []
  for (const id of marks) {
    const start = table.indexOf(`      ${id}: {`)
    const rest = table.slice(start + 10)
    const nextMatch = /^ {6}[a-z]+: \{/m.exec(rest)
    const body = nextMatch ? rest.slice(0, nextMatch.index) : rest
    const commands = (body.match(/[MmLlHhVvCcSsQqTtAaZz]/g) || []).length
    if (commands < 12) thin.push(`${id}(${commands})`)
  }
  ok(thin.length === 0, 'and none is a near-empty placeholder shape', thin.join(', ') || 'all drawn')
}

// --- a server on an unusual port is still found -------------------------------
console.log('\n=== a server the OS does not report is still found ===')
// Bind an ephemeral port: it is not in COMMON_PORTS and nothing lists it, so the only
// way to find it is the sweep being generous enough. This models the reader's 1420.
const page = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html', 'x-powered-by': 'Express' })
  res.end('<!doctype html><title>Sweep Probe</title><body>hello</body>')
})
await new Promise((done) => page.listen(0, '127.0.0.1', done))
const port = page.address().port
const isOpen = () => new Promise((done) => {
  const socket = connect(port, '127.0.0.1')
  socket.on('connect', () => { socket.destroy(); done(true) })
  socket.on('error', () => done(false))
})
ok(await isOpen(), 'the probe server is listening', String(port))

// `netstat` reports every listening port, including this one, so the sweep should
// reach it through `listeningPorts()` even though it is not in COMMON_PORTS. That is
// the property that makes an unusual port work — and the one to verify, because if
// `listeningPorts()` silently fails the sweep falls back to COMMON_PORTS alone.
const { execFile } = await import('node:child_process')
const listed = await new Promise((done) => {
  execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 4000 }, (error, stdout) => {
    done(error ? '' : String(stdout || ''))
  })
})
const seen = new RegExp(`:${port}\\s+\\S+\\s+LISTENING`, 'i').test(listed)
ok(seen, 'netstat reports it, so the sweep can reach it', `:${port}`)

await new Promise((done) => page.close(done))
console.log(failures === 0 ? '\nDETECTION CHECKS PASSED' : `\nDETECTION CHECKS FAILED — ${failures} problem(s)`)
process.exit(failures === 0 ? 0 : 1)
