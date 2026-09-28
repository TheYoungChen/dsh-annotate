/**
 * Guard the hand-off boundary between the two halves.
 *
 * The block sent to the model used to be built in the sidebar and written into
 * the composer, which is why the reader saw it as their own text. It is now
 * built by the host and delivered as runtime context. This test exists to keep
 * that boundary where it is: the moment the client starts rendering a block
 * again, the reader starts seeing it again.
 *
 * The block's own wording is checked against the real renderer in check-block.mjs.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('..', import.meta.url))
const clientSrc = readFileSync(`${HERE}/client.js`, 'utf8')
const hostSrc = readFileSync(`${HERE}/lib/index.js`, 'utf8')

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) {
    failures += 1
    if (detail) console.log(`       ${detail}`)
  }
}

console.log('=== the client no longer renders a block ===')
// Any of these reappearing means the sidebar is building model-facing text
// again, which is the exact regression this file guards.
check(!/renderPayload/.test(clientSrc), 'no renderPayload in the client')
check(!/payloadFor/.test(clientSrc), 'no payloadFor in the client')
check(!/Web page elements/.test(clientSrc), 'the client does not know the block heading')
check(!/界面标注|UI annotations/.test(clientSrc), 'no block header text in the client')
check(!/🎯/.test(clientSrc), 'no decorative marker in the client')
check(!/panel\.askLine/.test(clientSrc), 'the appended prompt line is gone')

console.log('\n=== the client reports picks, not prose ===')
// What crosses to the host is the raw pick, so the host owns all phrasing.
check(/fetch\(`\$\{API\}\/context`/.test(clientSrc), 'the client posts to the context action')
check(/session: sessionKey, annotations: payload/.test(clientSrc), 'it sends the session and the raw entries')
// Anchor on the declaration, not on a chain that a refactor rewrites. A missing
// anchor would report every field as absent, which reads as five real failures.
const shapeStart = clientSrc.indexOf('const toReport = ')
const shapeEnd = clientSrc.indexOf('/**', shapeStart)
check(shapeStart !== -1 && shapeEnd > shapeStart, 'the reported payload was located')
const payloadShape = shapeStart === -1 ? '' : clientSrc.slice(shapeStart, shapeEnd)
for (const field of ['selector', 'text', 'note', 'at', 'matches']) {
  check(new RegExp(`${field}:`).test(payloadShape), `the reported entry carries "${field}"`)
}
check(!/lines\.push|join\('\\n'\)/.test(payloadShape), 'the client composes no text')

console.log('\n=== the draft is never written with a block ===')
const shipBody = clientSrc.slice(clientSrc.indexOf('const ship ='), clientSrc.indexOf('const canSend'))
check(!/setDraft\([^)]*block/.test(shipBody), 'ship never writes a block into the draft')
// The one setDraft call clears the draft after a successful direct send.
const writes = [...shipBody.matchAll(/setDraft\(([^)]*)\)/g)].map((m) => m[1].trim())
check(writes.length <= 1, 'at most one setDraft call remains', writes.join(' | '))
check(writes.every((w) => w === "''"), 'the only write is clearing after send', writes.join(' | '))

console.log('\n=== the host owns the block ===')
check(/# Web page elements/.test(hostSrc), 'the host renders the heading')
check(/function|const renderAnnotations/.test(hostSrc), 'the host owns a renderer')
check(/systemPrompt\.context\(/.test(hostSrc), 'the block travels as runtime context')

console.log('\n=== the controls describe the new behaviour ===')
// Marks reach the host as they are made, so there is no hand-over control at all
// and nothing is gated on the draft having text.
check(!/panel\.needText/.test(clientSrc), 'no "type first" gate remains')
check(!/panel\.attach'/.test(clientSrc), 'the attach label is gone from both catalogs')
check(!/panel\.sendHint/.test(clientSrc), 'and so is its tooltip')

// The only action the panel still offers is the destructive one. Everything else
// happens on its own, which is the whole point: the reader annotates and writes.
check(!/onAttach/.test(clientSrc) && !/onSend/.test(clientSrc),
  'no hand-over or send action survives')
check(/t\('panel\.removeAll'\)/.test(clientSrc), 'clearing is the one remaining action')
check(/void clearAll\(\)/.test(clientSrc), 'and it is wired to the clearer')

console.log('')
if (failures) {
  console.log(`BOUNDARY CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('BOUNDARY CHECKS PASSED')
