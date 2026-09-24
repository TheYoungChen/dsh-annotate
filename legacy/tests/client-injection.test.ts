/**
 * Tests for the host->client composer injection crossing.
 *
 * These cover the four things that can go wrong in a way nobody would notice
 * until a user lost work: the channel stops meeting in the middle, a batch is
 * delivered twice, a block is applied to the wrong conversation, or something
 * along the path learns how to press Enter.
 *
 * Written as plain JavaScript inside a `.ts` file on purpose — Node strips the
 * (absent) types and runs it directly, so the suite needs no test toolchain and
 * exercises the real source rather than a build output.
 *
 * Run: `node --test tests/client-injection.test.ts`
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

import { formatBatch, mergeIntoDraft } from '../src/inject.ts'
import { PROTOCOL_VERSION } from '../src/protocol.ts'
import {
  createInjectionRelay,
  MAX_PENDING_INJECTIONS,
  INJECTION_TTL_MS,
} from '../src/client/injection-relay.ts'
import {
  applyInjection,
  RETRY_DELAY_MS,
} from '../src/client/injection-transport.ts'
import {
  createClientComposerPort,
  installClientComposerPort,
} from '../src/client/composer-port.ts'
import { isInjectionPullResponse, ROUTE_INJECT } from '../src/client/pairing-contract.ts'
import { createPairingRouteHandler, parseInjectionAck } from '../src/client/pairing-route.ts'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

/**
 * Remove comments and string literals from TypeScript source.
 *
 * Used by the source-level assertions below, which must read executable code
 * only. A naive substring scan over raw text matches prose too, and these
 * modules document their own guarantees in comments — so raw scanning rejects
 * the documentation rather than a violation.
 *
 * String literals are dropped for the same reason: a message like
 * `'the composer was not submitted'` is not a call.
 *
 * @param {string} source - the file contents.
 * @returns {string} the same source with comments and strings blanked out.
 */
function stripComments(source) {
  let out = ''
  let i = 0
  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === '//') {
      const end = source.indexOf('\n', i)
      i = end === -1 ? source.length : end
      continue
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i += 1
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') i += 1
        i += 1
      }
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** @param {object} [overrides] */
function batch(overrides = {}) {
  return {
    version: PROTOCOL_VERSION,
    batchId: 'b7f3c1a2-0000-4000-8000-000000000000',
    sessionId: 's1',
    page: {
      url: 'https://example.com/settings',
      title: 'Settings',
      kind: 'https',
      viewport: { width: 1440, height: 900 },
    },
    annotations: [{
      id: 'a1',
      pickedAt: 1_700_000_000_000,
      facts: {
        tag: 'button',
        selector: '#root > form > button.primary',
        selectorMatches: 1,
        rect: { x: 640, y: 512, width: 96, height: 32 },
        inViewport: true,
        frameDepth: 0,
      },
    }],
    submittedAt: 1_700_000_000_000,
    ...overrides,
  }
}

/** A relay whose clock the test controls. */
function relayAt(start = 1_000) {
  let now = start
  const lines = []
  const relay = createInjectionRelay({
    log: (message) => { lines.push(message) },
    now: () => now,
  })
  return {
    relay,
    lines,
    advance: (ms) => { now += ms },
  }
}

/**
 * A fake composer stack: the two client services the port resolves by name.
 *
 * It models the real thing in the one way that matters for these tests: a
 * session that this page does not know has no scope, so the port must report it
 * as unreachable rather than as an empty draft.
 */
function fakeClient(sessionIds = ['s1']) {
  const drafts = new Map(sessionIds.map((id) => [id, '']))
  const writes = []
  const facadeOf = (id) => ({
    setDraft: (text) => { writes.push([id, text]); drafts.set(id, text) },
    state: { getSnapshot: () => ({ draft: drafts.get(id) ?? '' }) },
  })
  const ctx = {
    get: (name) => {
      if (name === 'sessions') {
        return {
          scope: (id) => (drafts.has(id) ? { sessionId: id, ctx: { id } } : undefined),
        }
      }
      if (name === 'conversation') {
        return { input: { for: (actx) => facadeOf(actx.id) } }
      }
      return undefined
    },
  }
  return { ctx, drafts, writes, facadeOf }
}

// ---------------------------------------------------------------------------
// The crossing: host parks, page collects, page writes
// ---------------------------------------------------------------------------

test('a rendered block parked by the host is claimed once and applied to the composer', () => {
  const { relay } = relayAt()
  const client = fakeClient(['s1'])
  const port = createClientComposerPort(client.ctx)

  // Host side: injectBatch cannot reach a composer, so the host renders the
  // block and parks it. This is the exact call the host's onSubmit makes.
  const text = formatBatch(batch())
  relay.port.setDraft('s1', mergeIntoDraft('', text).text)

  // Page side: claim, apply, and confirm the draft really landed.
  const claimed = relay.takePending()
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].sessionId, 's1')
  assert.equal(applyInjection(port, claimed[0]), true)
  assert.match(client.drafts.get('s1'), /Annotated UI elements/)

  // Claiming removes: the same block is never handed out twice.
  assert.deepEqual(relay.takePending(), [])
})

test('the host port reports no composer reachable, so the host parks instead of pretending', () => {
  const { relay } = relayAt()
  // The host genuinely cannot see a composer: answering "available" would make
  // injectBatch report a delivery the host never observed.
  assert.equal(relay.port.isAvailable('s1'), false)
  assert.equal(relay.port.readDraft('s1'), undefined)
})

test('the client port merges against the real draft, so the user text survives', () => {
  const { relay } = relayAt()
  const client = fakeClient(['s1'])
  client.drafts.set('s1', 'please make this bigger')

  // The page performs the merge, because only the page can read the draft.
  const existing = client.facadeOf('s1').state.getSnapshot().draft
  const merged = mergeIntoDraft(existing, formatBatch(batch()))
  relay.port.setDraft('s1', merged.text)

  const port = createClientComposerPort(client.ctx)
  const claimed = relay.takePending()
  applyInjection(port, claimed[0])

  const written = client.drafts.get('s1')
  assert.ok(written.startsWith('please make this bigger\n\n'), 'the user text stays first and intact')
  assert.match(written, /Annotated UI elements/)
})

test('a block for a session this page does not know is not written anywhere', () => {
  const { relay } = relayAt()
  const client = fakeClient(['s1'])
  const port = createClientComposerPort(client.ctx)

  relay.port.setDraft('s-elsewhere', formatBatch(batch()))
  const claimed = relay.takePending()

  assert.equal(port.isAvailable('s-elsewhere'), false)
  assert.equal(port.readDraft('s-elsewhere'), undefined)
  assert.equal(applyInjection(port, claimed[0]), false)
  assert.deepEqual(client.writes, [], 'an unknown session must never receive a draft')
})

// ---------------------------------------------------------------------------
// The mailbox is bounded
// ---------------------------------------------------------------------------

test('the mailbox evicts the oldest entry rather than growing without bound', () => {
  const { relay } = relayAt()
  const overflow = 3
  // Park well past the cap without collecting anything: the mailbox must drop
  // from the front as it fills, or a page that stays closed turns this plugin
  // into an unbounded buffer of page content.
  for (let index = 0; index < MAX_PENDING_INJECTIONS + overflow; index += 1) {
    relay.port.setDraft('s1', `block ${index}`)
  }
  const claimed = relay.takePending()
  assert.equal(claimed.length, MAX_PENDING_INJECTIONS, 'the mailbox never exceeds its cap')
  // The `overflow` oldest blocks are the ones that went, so the survivors start
  // exactly there and end on the newest block parked.
  assert.equal(claimed[0].text, `block ${overflow}`, 'the oldest survivors come first')
  assert.equal(
    claimed[claimed.length - 1].text,
    `block ${MAX_PENDING_INJECTIONS + overflow - 1}`,
    'the newest block is the last one out',
  )
})

test('parking at the cap evicts exactly one entry', () => {
  const { relay } = relayAt()
  for (let index = 0; index < MAX_PENDING_INJECTIONS; index += 1) {
    relay.port.setDraft('s1', `block ${index}`)
  }
  relay.port.setDraft('s1', 'one more')
  const claimed = relay.takePending()
  assert.equal(claimed.length, MAX_PENDING_INJECTIONS)
  assert.equal(claimed[0].text, 'block 1', 'the single oldest entry is the one that went')
  assert.equal(claimed[claimed.length - 1].text, 'one more')
})

test('a block the page never collects expires instead of surfacing much later', () => {
  const clock = relayAt()
  clock.relay.port.setDraft('s1', 'stale')
  clock.advance(INJECTION_TTL_MS + 1)
  assert.deepEqual(clock.relay.takePending(), [], 'an expired block must not be delivered')
  assert.ok(clock.lines.some((line) => line.includes('no composer collected it')))
})

test('acknowledgement reports what the page did and tolerates unknown ids', () => {
  const { relay } = relayAt()
  relay.port.setDraft('s1', 'block')
  const claimed = relay.takePending()
  assert.match(relay.acknowledge([claimed[0].id]), /1 of 1 acknowledged/)
  // Re-acknowledging is bookkeeping, not an error: the writes already happened.
  assert.match(relay.acknowledge([claimed[0].id]), /0 of 1 acknowledged/)
  assert.match(relay.acknowledge(['never-seen']), /1 of 1 acknowledged/)
})

// ---------------------------------------------------------------------------
// The route: the host end of the crossing
// ---------------------------------------------------------------------------

/** A response double that records what the handler wrote. */
function fakeResponse() {
  const res = new EventEmitter()
  res.statusCode = 0
  res.headers = {}
  res.body = ''
  res.writableEnded = false
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers ?? {} }
  res.end = (text) => { res.body = text ?? ''; res.writableEnded = true }
  return res
}

/** A request double good enough for the trust fence and the body reader. */
function fakeRequest(method, url, body, headers = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080', ...headers }
  req.setEncoding = () => {}
  req[Symbol.asyncIterator] = async function* iterate() {
    if (typeof body === 'string' && body !== '') yield Buffer.from(body)
  }
  return req
}

/** The route source with a real relay behind it. */
function routeSource(relay) {
  return {
    status: () => ({
      connected: false,
      listening: true,
      port: 43120,
      address: '127.0.0.1',
      extensionId: null,
      connectedAt: null,
      protocolVersion: null,
      tokenIssuedAt: 1,
      lastPingMs: null,
      batchesReceived: 0,
      batchesRejected: 0,
    }),
    token: () => 'tok',
    takeInjections: () => relay.takePending(),
    acknowledgeInjections: (ids) => relay.acknowledge(ids),
  }
}

test('the injection route hands the parked block to a GET that clears the fence', () => {
  const { relay } = relayAt()
  const handler = createPairingRouteHandler(routeSource(relay))
  relay.port.setDraft('s1', 'parked block')

  const res = fakeResponse()
  handler(fakeRequest('GET', ROUTE_INJECT), res)

  assert.equal(res.statusCode, 200)
  const parsed = JSON.parse(res.body)
  assert.equal(isInjectionPullResponse(parsed), true)
  assert.equal(parsed.injections.length, 1)
  assert.equal(parsed.injections[0].text, 'parked block')
})

test('an empty mailbox holds the request open instead of answering immediately', async () => {
  const { relay } = relayAt()
  const handler = createPairingRouteHandler(routeSource(relay))
  const res = fakeResponse()
  handler(fakeRequest('GET', ROUTE_INJECT), res)

  // Nothing to hand over yet, so the response is still open: this is what makes
  // a batch that lands a moment later feel immediate instead of polled.
  assert.equal(res.writableEnded, false)
  res.emit('close')
  assert.equal(res.writableEnded, false)
})

test('a POST records the acknowledgement and always answers ok', async () => {
  const { relay } = relayAt()
  relay.port.setDraft('s1', 'block')
  const claimed = relay.takePending()
  const handler = createPairingRouteHandler(routeSource(relay))

  const res = fakeResponse()
  handler(fakeRequest('POST', ROUTE_INJECT, JSON.stringify({ ids: [claimed[0].id] })), res)
  await new Promise((resolve) => { setImmediate(resolve) })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true })
})

test('the injection route refuses a method it does not own', () => {
  const { relay } = relayAt()
  const handler = createPairingRouteHandler(routeSource(relay))
  const res = fakeResponse()
  handler(fakeRequest('DELETE', ROUTE_INJECT), res)
  assert.equal(res.statusCode, 405)
})

test('the injection route is behind the same trust fence as the token route', () => {
  const { relay } = relayAt()
  relay.port.setDraft('s1', 'parked block')
  const handler = createPairingRouteHandler(routeSource(relay))
  const res = fakeResponse()
  // A cross-site caller must not be able to drain the mailbox.
  handler(fakeRequest('GET', ROUTE_INJECT, undefined, { 'sec-fetch-site': 'cross-site' }), res)
  assert.equal(res.statusCode, 403)
  assert.equal(relay.takePending().length, 1, 'the block must still be waiting')
})

test('a malformed acknowledgement body is tolerated, never thrown', () => {
  assert.deepEqual(parseInjectionAck('not json'), [])
  assert.deepEqual(parseInjectionAck('{}'), [])
  assert.deepEqual(parseInjectionAck('{"ids":"nope"}'), [])
  assert.deepEqual(parseInjectionAck('{"ids":["a",7,null,"b"]}'), ['a', 'b'])
})

test('a response of the wrong shape is rejected rather than applied', () => {
  assert.equal(isInjectionPullResponse({ injections: [] }), true)
  assert.equal(isInjectionPullResponse({ injections: [{ id: 'x', sessionId: 's', text: 't' }] }), true)
  assert.equal(isInjectionPullResponse({}), false)
  assert.equal(isInjectionPullResponse({ injections: [{ id: 1, sessionId: 's', text: 't' }] }), false)
  assert.equal(isInjectionPullResponse(null), false)
})

// ---------------------------------------------------------------------------
// Degradation: the plugin must work with no client half at all
// ---------------------------------------------------------------------------

test('the port is not created when the client conversation stack is absent', () => {
  const bare = { get: () => undefined }
  assert.equal(createClientComposerPort(bare), undefined)

  const halfComposed = { get: (name) => (name === 'conversation' ? { input: { for: () => ({}) } } : undefined) }
  assert.equal(createClientComposerPort(halfComposed), undefined, 'sessions is also required')

  let installed = false
  assert.equal(installClientComposerPort(bare, () => { installed = true }), false)
  assert.equal(installed, false)
})

test('a service that throws while resolving degrades instead of breaking the batch', () => {
  const ctx = {
    get: (name) => {
      if (name === 'sessions') {
        return {
          scope: () => { throw new Error('client is shutting down') },
        }
      }
      if (name === 'conversation') return { input: { for: () => { throw new Error('no facade') } } }
      return undefined
    },
  }
  const port = createClientComposerPort(ctx)
  assert.notEqual(port, undefined)
  assert.equal(port.isAvailable('s1'), false)
  assert.equal(port.readDraft('s1'), undefined)
  // A write that cannot land is dropped: by the time the host asks for it, the
  // batch has already been resolved, and throwing here would fake a failure.
  assert.doesNotThrow(() => { port.setDraft('s1', 'text') })
})

// ---------------------------------------------------------------------------
// The safety property: nothing on this path can send
// ---------------------------------------------------------------------------

test('the client composer port exposes exactly the three verbs and cannot send', () => {
  const client = fakeClient(['s1'])
  const port = createClientComposerPort(client.ctx)
  assert.deepEqual(Object.keys(port).sort(), ['isAvailable', 'readDraft', 'setDraft'])
})

test('the host port exposes exactly the three verbs and cannot send', () => {
  const { relay } = relayAt()
  assert.deepEqual(Object.keys(relay.port).sort(), ['isAvailable', 'readDraft', 'setDraft'])
})

test('no module on the injection path contains a send-shaped call', () => {
  // The property "injection never sends" cannot be proved by a type once the
  // client services are reached structurally, so it is pinned by source: none of
  // these modules may name a submit path at all.
  const files = [
    'src/client/composer-port.ts',
    'src/client/injection-transport.ts',
    'src/client/injection-relay.ts',
    'src/client/index.ts',
  ]
  /** Names that only ever appear in code that posts a message. */
  const forbidden = [
    /\bsubmit\b/u,
    /\bsendSession\b/u,
    /\.send\s*\(/u,
    /\bprompt\s*\(/u,
    /'steer'/u,
    /"steer"/u,
    /\bpressEnter\b/u,
  ]
  for (const file of files) {
    // Comments are stripped first, and this matters: the modules below explain
    // in prose that they never submit ("it does not submit it", "no send/submit
    // member"), so scanning raw text would flag the very comments documenting
    // the guarantee. The assertion is about executable code.
    const source = stripComments(readFileSync(resolve(packageRoot, file), 'utf8'))
    for (const pattern of forbidden) {
      assert.equal(
        pattern.test(source),
        false,
        `${file} must not match ${String(pattern)} — injection may fill the composer, never submit it`,
      )
    }
  }
})

test('the injection route is reachable only through this plugin own prefix', () => {
  assert.ok(ROUTE_INJECT.startsWith('/dsh-annotate/api/'))
})

// ---------------------------------------------------------------------------
// The transport loop
// ---------------------------------------------------------------------------

test('applyInjection writes through the port and reports whether it landed', () => {
  const client = fakeClient(['s1'])
  const port = createClientComposerPort(client.ctx)
  assert.equal(applyInjection(port, { id: 'i1', sessionId: 's1', text: 'hello' }), true)
  assert.deepEqual(client.writes, [['s1', 'hello']])
  assert.equal(applyInjection(port, { id: 'i2', sessionId: 'nope', text: 'hello' }), false)
  assert.equal(client.writes.length, 1)
})

test('the retry delay keeps a restarted host from being stormed', () => {
  assert.ok(RETRY_DELAY_MS >= 1_000)
  assert.ok(RETRY_DELAY_MS <= 5_000)
})
