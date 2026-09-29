/**
 * Reloading a preview must work even after the host closed its proxy.
 *
 * The reader reported: 点击刷新后 "localhost 拒绝连接".
 *
 * Reload used to bump a nonce on the existing preview URL, which only re-mounts the
 * iframe. A workspace file survives that because it is read from disk — but a loopback
 * page is served through an ephemeral proxy that the host closes once the preview goes
 * idle (5 minutes without traffic). Re-mounting then navigates to a dead port.
 *
 * The fix routes reload back through `/open`, which reuses a live proxy and builds a
 * fresh one when the old is gone. This checks exactly that: open, close, open again.
 */
import { createServer } from 'node:http'

const BASE = process.argv[2] || 'http://127.0.0.1:3080'

const page = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><html><body><h1 id="t">reload probe</h1></body></html>')
})
await new Promise((done) => page.listen(0, '127.0.0.1', done))
const target = `http://127.0.0.1:${page.address().port}/`

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, text: await res.text() }
}
const json = async (path, body) => {
  const res = await post(path, body)
  try {
    return JSON.parse(res.text)
  } catch {
    return { ok: false, parse: res.text.slice(0, 140) }
  }
}

let failures = 0
const ok = (pass, label, detail) => {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures += 1
}

/** Can this preview url actually be fetched right now? */
const reachable = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
    return res.ok
  } catch {
    return false
  }
}

console.log('\n=== open a loopback page ===')
const first = await json('/__dsh-annotate/open', { url: target })
ok(first.ok === true, 'the page opens', JSON.stringify(first).slice(0, 120))
ok(typeof first.url === 'string' && first.url.length > 0, 'and yields a preview url', first.url)
ok(await reachable(first.url), 'which is reachable')

console.log('\n=== "reload" while the proxy is alive ===')
// What the fixed client does: ask `/open` for the same target again. The host should
// reuse the live proxy, so the page stays reachable — and it must stay the same origin,
// or the overlay would lose its postMessage channel.
const again = await json('/__dsh-annotate/open', { url: target })
ok(again.ok === true, 're-opening succeeds')
ok(again.sid === first.sid, 'the same preview is reused rather than duplicated', `${first.sid} vs ${again.sid}`)
ok(await reachable(again.url), 'and the page is still reachable')

console.log('\n=== "reload" after the host closed the proxy ===')
// This is the reader's case. Closing simulates the idle sweep firing while the tab sat
// untouched; the old client would then re-mount an iframe at the dead port.
const closed = await json('/__dsh-annotate/close', { sid: first.sid })
ok(closed.ok === true, 'the preview is closed', JSON.stringify(closed))
ok(!(await reachable(first.url)), 'and its port is now dead', first.url)

const revived = await json('/__dsh-annotate/open', { url: target })
ok(revived.ok === true, 're-opening after the close succeeds')
ok(revived.sid !== first.sid, 'a NEW proxy is built, not the dead one', `${first.sid} -> ${revived.sid}`)
ok(await reachable(revived.url), 'and the revived page is reachable', revived.url)

console.log('\n=== the reopened page is a working preview, not just a live socket ===')
const html = await fetch(revived.url).then((r) => r.text())
ok(html.includes('reload probe'), 'the target page content is served')
ok(html.includes('dsa-pins'), 'and the overlay is injected into it')

await json('/__dsh-annotate/close', { sid: revived.sid })
page.close()
console.log(failures === 0 ? '\nRELOAD CHECKS PASSED' : `\nRELOAD CHECKS FAILED — ${failures} problem(s)`)
process.exit(failures === 0 ? 0 : 1)
