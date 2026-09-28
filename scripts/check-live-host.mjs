/**
 * Ask the RUNNING host what overlay it is actually serving.
 *
 * Every offline check proves the files on disk are right. Only this proves the
 * process the reader is looking at has them. The previous round shipped a fix that
 * was correct in source and absent from the running host for an hour.
 */
import { createServer } from 'node:http'

const BASE = process.argv[2] || 'http://127.0.0.1:3080'

const page = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><html><body><div class="l2"><span><b>默认 · vip</b></span></div></body></html>')
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

let failures = 0
const ok = (pass, label, detail) => {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures += 1
}

console.log(`\n=== what ${BASE} is serving right now ===`)
const ping = await fetch(`${BASE}/__dsh-annotate/ping`).then((r) => r.json()).catch(() => null)
ok(ping && ping.ok === true, 'the plugin answers', ping ? JSON.stringify(ping) : 'no response')
ok(ping && ping.version === '0.2.2', 'and it is the current version', ping && ping.version)

const opened = await post('/__dsh-annotate/open', { action: 'open', url: target })
let body = null
try {
  body = JSON.parse(opened.text)
} catch { /* reported below */ }
const entry = body && (body.entry || body.url || body.src)
ok(typeof entry === 'string' && entry.length > 0, 'a preview opens', entry || opened.text.slice(0, 100))

if (entry) {
  const html = await fetch(entry).then((r) => r.text())
  console.log('\n=== the served overlay carries this round\'s selector fix ===')
  // The three pieces that make an anchored path: the element's own class tried first,
  // the helper that tests uniqueness, and the ambiguous-selector guard.
  ok(html.includes('firstUniqueClass'),
    'the element\'s own class is tried before any ancestor\'s')
  ok(html.includes('uniqueClassSelector'),
    'ancestors are still available as anchors')
  // The specific shape: the path must be built from segments that reach the element,
  // not by returning an ancestor as a complete selector.
  ok(!/var byClass = uniqueClassSelector\(el, 0\)\n\s*if \(byClass\) return byClass/.test(html),
    'and an ancestor is no longer returned as a whole selector')
  ok(html.includes('segments.unshift'), 'the positional path is built from segments')
  ok(html.includes('candidates.length > 1'),
    'an ambiguous selector is resolved by text rather than guessed')

  console.log('\n=== and it still behaves like the overlay ===')
  ok(html.includes('dsa-pins'), 'the pin layer is present')
  ok(/\.dsa-pins>\.dsa-pin\{[^}]*pointer-events:auto/.test(html), 'pins are clickable')
  ok(/\.dsa-layer\{[^}]*pointer-events:none/.test(html), 'and the page stays clickable')
}

page.close()
console.log(failures === 0
  ? `\nLIVE HOST CHECKS PASSED (${BASE})`
  : `\nLIVE HOST CHECKS FAILED — ${failures} problem(s)`)
process.exit(failures === 0 ? 0 : 1)
