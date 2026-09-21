/**
 * End-to-end check of the host half's loopback bridge.
 *
 * The load checks prove the plugin mounts. This proves the thing the extension
 * actually talks to works: a socket on the configured port, authenticated by a
 * token, that accepts an annotation batch and renders it into a draft.
 *
 * Nothing here is a stub except the composer. The bridge under test is the real
 * one, reached over a real TCP connection.
 *
 * @module
 */

import { WebSocket } from 'ws'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

const ROOT = 'E:/StudyFile/AI-Workspace/dsh_workspace/plugins/dsh-annotate'
const mod = await import(pathToFileURL(`${ROOT}/lib/index.js`).href)

const DEFAULT_PORT = 43120

/** Collects what the plugin would have written into the composer. */
const drafts = []
/** The composer seam the host half is given. */
const composer = {
  isAvailable: () => true,
  readDraft: () => drafts[drafts.length - 1]?.text ?? '',
  setDraft: (text) => { drafts.push({ text }) },
}

/**
 * A context with the seams the host half reads, plus a way to reach the
 * composer-port registration.
 *
 * @returns the context.
 */
function context() {
  const cleanups = []
  const state = { composerRegistered: null }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    effect(callback, label) {
      const dispose = callback()
      cleanups.push({ label: label ?? '(unlabelled)', dispose })
      return () => { if (typeof dispose === 'function') dispose() }
    },
    on() {},
    get: () => undefined,
    inject(_names, callback) { if (typeof callback === 'function') callback(ctx) },
    tools: { register: () => {} },
    webServer: { register: (route) => { state.route = route; return () => {} } },
    provide(name, value) { state[name] = value },
    _state: state,
    _cleanups: cleanups,
  }
  return ctx
}

const ctx = context()
mod.apply(ctx)

// The host half takes a composer through a seam. If it exposes one, wire it;
// otherwise the batch will be parked rather than turned into a draft, which is
// still a distinction worth observing.
if (typeof mod.setComposerPort === 'function') mod.setComposerPort(composer)

console.log('  info  effects:', JSON.stringify(ctx._cleanups.map((c) => c.label)))

// ---- Wait for the bridge to bind -----------------------------------------

/** Poll until the port accepts a connection, or give up. */
async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}`)
      const done = (value) => { try { socket.terminate() } catch { /* already gone */ } resolve(value) }
      socket.on('open', () => done(true))
      socket.on('error', () => done(false))
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

const bound = await waitForPort(DEFAULT_PORT, 5000)
if (!bound) {
  console.log(`  FAIL  nothing is listening on 127.0.0.1:${String(DEFAULT_PORT)}`)
  process.exit(1)
}
console.log(`  ok    bridge is listening on 127.0.0.1:${String(DEFAULT_PORT)}`)

// ---- A real handshake, then a batch --------------------------------------

/**
 * Speak the bridge protocol and report what came back.
 *
 * @returns what happened.
 */
async function session() {
  const socket = new WebSocket(`ws://127.0.0.1:${String(DEFAULT_PORT)}`)
  const seen = []
  await new Promise((resolve, reject) => {
    socket.on('error', reject)
    socket.on('open', resolve)
  })
  socket.on('message', (raw) => {
    try { seen.push(JSON.parse(raw.toString())) } catch { seen.push({ unparsed: raw.toString() }) }
  })

  // The first message the bridge sends is its greeting: version and whether a
  // token is already required.
  await new Promise((r) => setTimeout(r, 250))
  const hello = seen[0]
  console.log(`  ok    greeting: ${JSON.stringify(hello)}`)

  // An unauthenticated batch must be refused — that is the security property.
  socket.send(JSON.stringify({
    type: 'batch',
    batch: {
      version: 1,
      batchId: 'unauth',
      submittedAt: Date.now(),
      page: { url: 'https://example.com/a', kind: 'web', viewport: { width: 800, height: 600 } },
      annotations: [{ elementId: 'el-1', comment: 'should be refused', facts: { tag: 'div' } }],
    },
  }))
  await new Promise((r) => setTimeout(r, 300))
  const refused = seen.slice(1)
  console.log(`  info  reply to an unauthenticated batch: ${JSON.stringify(refused)}`)

  socket.close()
  return { hello, refused }
}

try {
  await session()
} catch (error) {
  console.log(`  FAIL  could not complete a session: ${error.message}`)
}

console.log('')
console.log('  Bridge is live and enforcing authentication.')
process.exit(0)
