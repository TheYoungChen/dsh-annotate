/**
 * Bring up a throwaway page and check what the preview actually inlines.
 *
 * Every previous attempt at this guessed at a route or a bundle URL and got a 404,
 * which proves nothing about the plugin. This asks the real endpoint and reads the
 * real HTML back, so the answer is about the code rather than about my guess.
 */
import { createServer } from 'node:http'

const BASE = process.argv[2] || 'http://127.0.0.1:3099'

const page = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><html><body><h1 id="t">probe</h1><p class="x">body</p></body></html>')
})
await new Promise((done) => page.listen(0, '127.0.0.1', done))
const target = `http://127.0.0.1:${page.address().port}/`
console.log(`  probe page serving at ${target}`)

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

console.log('\n=== the plugin answers on its own route ===')
const opened = await post('/__dsh-annotate/open', { action: 'open', url: target })
ok(opened.status === 200, 'the open endpoint responds', `HTTP ${opened.status}`)
let body = null
try {
  body = JSON.parse(opened.text)
} catch {
  ok(false, 'the response is JSON', opened.text.slice(0, 120))
}
if (body && !body.entry) console.log(`  response keys: ${Object.keys(body).join(', ')}`)
// The field holding the preview location has been named differently across
// revisions; take whichever one is present rather than asserting a name.
const entry = body && (body.entry || body.url || body.src || body.preview)
ok(typeof entry === 'string' && entry.length > 0, 'and returns a preview entry url', entry || JSON.stringify(body))

if (entry) {
  console.log('\n=== the preview html carries this round\'s overlay ===')
  const res = await fetch(entry)
  const html = await res.text()
  ok(res.status === 200, 'the entry loads', `HTTP ${res.status}, ${html.length} bytes`)
  ok(html.includes('dsa-pins'), 'the pin container class is inlined')
  ok(html.includes('.dsa-pins>.dsa-pin'), 'and so is the rule that makes pins clickable')
  ok(html.includes('dsa-keys'), 'the keyboard legend is inlined')
  ok(html.includes('IS_MAC'), 'the platform-aware modifier is inlined')
  ok(html.includes('keyNewline') && html.includes('keySave'),
    'both hint labels are present')
  // The regression this round: `pointer-events:auto` on the pin alone did nothing,
  // because `.dsa-layer` disables pointer events for the whole overlay and a
  // descendant cannot opt back in across an ancestor that said no.
  ok(/\.dsa-layer\{[^}]*pointer-events:none/.test(html),
    'the overlay still lets the page underneath be clicked')
  console.log('\n=== and it is still a real preview, not just our chrome ===')
  ok(html.includes('probe'), 'the target page content is present')
}

page.close()
console.log(failures === 0 ? '\nPREVIEW INLINE CHECKS PASSED' : `\nPREVIEW INLINE CHECKS FAILED — ${failures} problem(s)`)
process.exit(failures === 0 ? 0 : 1)
