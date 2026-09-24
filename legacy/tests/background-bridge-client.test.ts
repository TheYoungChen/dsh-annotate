/**
 * Unit tests for the bridge client's connection state machine.
 *
 * The client reaches the platform only through {@link BridgeEnvironment}, so
 * these tests drive it with a fake that records what it was asked to do. No
 * socket is opened and no bridge is contacted: the point is to prove the client's
 * own behaviour, and a real loopback peer would only add a dependency the
 * assertions do not need.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  BridgeClient,
  INITIAL_STATUS,
  MAX_BACKOFF_MS,
  STORAGE_KEYS,
  backoffDelay,
  bridgeUrl,
  describeStatus,
  normalizePort,
  normalizeToken,
  parseBridgeMessage,
  readPendingBatch,
  readStatusRecord,
  type BridgeEnvironment,
  type BridgeHandlers,
  type BridgeStatus,
  type ConnectionState,
  type WebSocketLike,
} from '../extension/src/background/bridge-client.ts'
import { PROTOCOL_VERSION, type AnnotationBatch } from '../src/protocol.ts'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A socket that records every frame and lets a test drive its events. */
class FakeSocket implements WebSocketLike {
  readyState = 0
  readonly sent: string[] = []
  closed: { code?: number; reason?: string } | null = null
  /** The URL this socket was dialled for, so port routing can be asserted. */
  url = ''

  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
  }

  /** Simulate a completed handshake. */
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  /** Simulate an inbound frame. */
  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  /** Simulate the peer closing. */
  drop(code = 1006): void {
    this.readyState = 3
    this.onclose?.({ code })
  }

  /** Every sent frame, decoded. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>)
  }
}

/** The platform seam, faked and inspectable. */
class FakeEnvironment implements BridgeEnvironment {
  readonly store: Record<string, unknown> = {}
  readonly sockets: FakeSocket[] = []
  readonly alarms = new Map<string, { when: number; periodInMinutes?: number }>()
  readonly timeouts = new Map<number, { handler: () => void; ms: number }>()
  readonly intervals = new Map<number, { handler: () => void; ms: number }>()
  readonly logs: string[] = []

  private clock = 1_000_000
  private nextHandle = 1
  /** When set, opening a socket throws, to model a blocked or malformed URL. */
  connectError: string | null = null

  readonly storage = {
    get: async (keys: string): Promise<Record<string, unknown>> => {
      const wanted = keys.split('/')
      const result: Record<string, unknown> = {}
      for (const key of wanted) {
        if (key in this.store) result[key] = this.store[key]
      }
      return result
    },
    set: async (items: Record<string, unknown>): Promise<void> => {
      Object.assign(this.store, items)
    },
    remove: async (keys: string | readonly string[]): Promise<void> => {
      const list = typeof keys === 'string' ? [keys] : keys
      for (const key of list) delete this.store[key]
    },
  }

  connect(url: string): WebSocketLike {
    if (this.connectError !== null) throw new Error(this.connectError)
    const socket = new FakeSocket()
    socket.url = url
    this.sockets.push(socket)
    return socket
  }

  setAlarm(name: string, info: { when: number; periodInMinutes?: number } | null): void {
    if (info === null) {
      this.alarms.delete(name)
      return
    }
    this.alarms.set(name, info)
  }

  now(): number {
    return this.clock
  }

  extensionId(): string {
    return 'test-extension-id'
  }

  setTimeout(handler: () => void, ms: number): number {
    const handle = this.nextHandle++
    this.timeouts.set(handle, { handler, ms })
    return handle
  }

  clearTimeout(handle: number): void {
    this.timeouts.delete(handle)
  }

  setInterval(handler: () => void, ms: number): number {
    const handle = this.nextHandle++
    this.intervals.set(handle, { handler, ms })
    return handle
  }

  clearInterval(handle: number): void {
    this.intervals.delete(handle)
  }

  log(_level: 'info' | 'warn' | 'error', message: string): void {
    this.logs.push(message)
  }

  /** Advance the clock without running timers, for backoff arithmetic. */
  advance(ms: number): void {
    this.clock += ms
  }

  /** Run the single pending reconnect timer, as the platform would. */
  fireRetry(): void {
    const entry = [...this.timeouts.entries()][0]
    assert.ok(entry !== undefined, 'expected a scheduled retry')
    this.timeouts.delete(entry[0])
    entry[1].handler()
  }

  /** The most recently created socket. */
  lastSocket(): FakeSocket {
    const socket = this.sockets.at(-1)
    assert.ok(socket !== undefined, 'expected a socket to have been dialled')
    return socket
  }

  /** The persisted status record. */
  status(): BridgeStatus {
    return readStatusRecord(this.store[STORAGE_KEYS.status])
  }
}

/** Collected handler calls, so push behaviour can be asserted. */
interface Recorded {
  startPicking: Array<number | null>
  stopPicking: number
  allowOnline: boolean[]
  acked: string[]
  rejected: Array<{ batchId: string; message: string }>
}

/**
 * Let every pending microtask settle.
 *
 * The client's frame handlers are `async` and await storage several times before
 * their effects land, so a single `await Promise.resolve()` observes a half-done
 * transition. Draining a fixed number of turns is deterministic here because the
 * fakes never touch the event loop beyond microtasks.
 */
async function flush(turns = 12): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve()
}

/** Build a client plus its fake environment and recorded handler calls. */
function harness(options: { token?: string; port?: number } = {}): {
  env: FakeEnvironment
  client: BridgeClient
  calls: Recorded
} {
  const env = new FakeEnvironment()
  if (options.token !== undefined) env.store[STORAGE_KEYS.token] = options.token
  if (options.port !== undefined) env.store[STORAGE_KEYS.port] = options.port

  const calls: Recorded = { startPicking: [], stopPicking: 0, allowOnline: [], acked: [], rejected: [] }
  const handlers: BridgeHandlers = {
    onStartPicking: (tabId) => { calls.startPicking.push(tabId) },
    onStopPicking: () => { calls.stopPicking += 1 },
    onAllowOnline: (value) => { calls.allowOnline.push(value) },
    onBatchAcked: (id) => { calls.acked.push(id) },
    onBatchRejected: (id, message) => { calls.rejected.push({ batchId: id, message }) },
  }
  return { env, client: new BridgeClient({ env, handlers }), calls }
}

/** A minimal valid batch, built here so the tests own their fixture. */
function batchFixture(batchId = 'batch-1'): AnnotationBatch {
  return {
    version: PROTOCOL_VERSION,
    batchId,
    page: { url: 'https://example.com/', kind: 'https', viewport: { width: 1280, height: 800 } },
    annotations: [
      {
        id: 'a1',
        pickedAt: 1_700_000_000_000,
        facts: {
          tag: 'button',
          selector: 'button.save',
          selectorMatches: 1,
          rect: { x: 10, y: 20, width: 80, height: 30 },
          inViewport: true,
          frameDepth: 1,
        },
      },
    ],
    submittedAt: 1_700_000_000_001,
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('backoffDelay', () => {
  it('doubles from one second and caps at thirty', () => {
    assert.equal(backoffDelay(0), 1_000)
    assert.equal(backoffDelay(1), 2_000)
    assert.equal(backoffDelay(2), 4_000)
    assert.equal(backoffDelay(3), 8_000)
    assert.equal(backoffDelay(4), 16_000)
    assert.equal(backoffDelay(5), MAX_BACKOFF_MS)
  })

  it('stays capped rather than overflowing', () => {
    assert.equal(backoffDelay(1_000), MAX_BACKOFF_MS)
    assert.equal(backoffDelay(Number.MAX_SAFE_INTEGER), MAX_BACKOFF_MS)
  })

  it('treats a negative or fractional attempt as the first delay', () => {
    assert.equal(backoffDelay(-3), 1_000)
    assert.equal(backoffDelay(1.9), 2_000)
  })
})

describe('normalizeToken', () => {
  it('strips the whitespace a paste brings with it', () => {
    assert.equal(normalizeToken('  abc123\n'), 'abc123')
  })

  it('treats blank and non-string values as unpaired', () => {
    assert.equal(normalizeToken(''), null)
    assert.equal(normalizeToken('   '), null)
    assert.equal(normalizeToken(undefined), null)
    assert.equal(normalizeToken(42), null)
  })
})

describe('normalizePort', () => {
  it('keeps a usable port', () => {
    assert.equal(normalizePort(43120), 43120)
  })

  it('falls back to the default for anything unusable', () => {
    assert.equal(normalizePort(0), 43120)
    assert.equal(normalizePort(70_000), 43120)
    assert.equal(normalizePort(1.5), 43120)
    assert.equal(normalizePort('43120'), 43120)
    assert.equal(normalizePort(undefined), 43120)
  })
})

describe('bridgeUrl', () => {
  it('always targets loopback', () => {
    assert.equal(bridgeUrl(43120), 'ws://127.0.0.1:43120')
  })
})

describe('parseBridgeMessage', () => {
  it('accepts every frame the bridge is allowed to send', () => {
    assert.deepEqual(parseBridgeMessage({ type: 'welcome', version: 1, sessionId: null }), {
      type: 'welcome', version: 1, sessionId: null,
    })
    assert.deepEqual(parseBridgeMessage({ type: 'rejected', reason: 'token' }), { type: 'rejected', reason: 'token' })
    assert.deepEqual(parseBridgeMessage({ type: 'pong' }), { type: 'pong' })
    assert.deepEqual(parseBridgeMessage({ type: 'start-picking' }), { type: 'start-picking' })
    assert.deepEqual(parseBridgeMessage({ type: 'start-picking', tabId: 4 }), { type: 'start-picking', tabId: 4 })
    assert.deepEqual(parseBridgeMessage({ type: 'stop-picking' }), { type: 'stop-picking' })
    assert.deepEqual(parseBridgeMessage({ type: 'submit-ack', batchId: 'b', ok: true }), {
      type: 'submit-ack', batchId: 'b', ok: true,
    })
    assert.deepEqual(parseBridgeMessage({ type: 'settings', allowOnline: true }), { type: 'settings', allowOnline: true })
  })

  it('rejects a frame with a missing or mistyped field', () => {
    assert.equal(parseBridgeMessage({ type: 'welcome', version: '1', sessionId: null }), undefined)
    assert.equal(parseBridgeMessage({ type: 'rejected', reason: 'because' }), undefined)
    assert.equal(parseBridgeMessage({ type: 'start-picking', tabId: '4' }), undefined)
    assert.equal(parseBridgeMessage({ type: 'submit-ack', batchId: 'b' }), undefined)
    assert.equal(parseBridgeMessage({ type: 'settings' }), undefined)
  })

  it('ignores an unknown frame so a newer bridge does not break this build', () => {
    assert.equal(parseBridgeMessage({ type: 'something-new' }), undefined)
    assert.equal(parseBridgeMessage(null), undefined)
    assert.equal(parseBridgeMessage('hello'), undefined)
  })
})

describe('describeStatus', () => {
  it('explains the two states a retry cannot fix', () => {
    assert.match(describeStatus({ ...INITIAL_STATUS, state: 'unauthorized' }), /token/i)
    assert.match(describeStatus({ ...INITIAL_STATUS, state: 'incompatible' }), /protocol/i)
  })

  it('prefers the recorded detail when there is one', () => {
    const status: BridgeStatus = { ...INITIAL_STATUS, state: 'reconnecting', detail: 'custom reason' }
    assert.equal(describeStatus(status), 'custom reason')
  })
})

describe('readStatusRecord', () => {
  it('returns the initial record for a missing or malformed value', () => {
    assert.deepEqual(readStatusRecord(undefined), INITIAL_STATUS)
    assert.deepEqual(readStatusRecord({ state: 'nonsense' }), INITIAL_STATUS)
  })

  it('fills missing fields rather than producing undefined', () => {
    const record = readStatusRecord({ state: 'connected' })
    assert.equal(record.state, 'connected')
    assert.equal(record.detail, null)
    assert.equal(record.batchesAcked, 0)
  })
})

describe('readPendingBatch', () => {
  it('rejects a stored batch that no longer validates', () => {
    assert.equal(readPendingBatch(undefined), null)
    assert.equal(readPendingBatch({ batch: { nope: true }, tabId: 1, attempts: 0 }), null)
  })

  it('accepts a well-formed stored batch', () => {
    const pending = readPendingBatch({ batch: batchFixture(), tabId: 7, attempts: 2 })
    assert.equal(pending?.tabId, 7)
    assert.equal(pending?.attempts, 2)
  })
})

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

describe('BridgeClient pairing', () => {
  it('stays idle and reports unpaired when there is no token', async () => {
    const { env, client } = harness()
    await client.start()
    assert.equal(env.sockets.length, 0)
    assert.equal(env.status().state, 'unpaired')
    assert.equal(client.isConnected(), false)
  })

  it('dials the configured port once a token exists', async () => {
    const { env, client } = harness({ token: 'secret', port: 44_000 })
    await client.start()
    assert.equal(env.sockets.length, 1)
    assert.equal(env.sockets[0]?.url, 'ws://127.0.0.1:44000')
  })

  it('sends hello as the very first frame, carrying the token and the version', async () => {
    const { env, client } = harness({ token: 'secret' })
    await client.start()
    const socket = env.lastSocket()
    socket.open()
    assert.equal(socket.frames().length, 1)
    assert.deepEqual(socket.frames()[0], {
      type: 'hello',
      version: PROTOCOL_VERSION,
      token: 'secret',
      extensionId: 'test-extension-id',
    })
  })

  it('does not write anything before the socket is open', async () => {
    const { env, client } = harness({ token: 'secret' })
    await client.start()
    assert.deepEqual(env.lastSocket().sent, [])
  })

  it('reports connected only after the welcome frame', async () => {
    const { env, client } = harness({ token: 'secret' })
    await client.start()
    const socket = env.lastSocket()
    socket.open()
    assert.equal(client.isConnected(), false, 'a completed handshake is not authentication')
    socket.deliver({ type: 'welcome', version: PROTOCOL_VERSION, sessionId: null })
    await flush()
    assert.equal(client.isConnected(), true)
    assert.equal(env.status().state, 'connected')
  })
})

describe('BridgeClient backoff', () => {
  it('waits longer after each failed dial and caps the wait', async () => {
    const { env, client } = harness({ token: 'secret' })
    await client.start()

    const observed: number[] = []
    for (let attempt = 0; attempt < 6; attempt += 1) {
      env.lastSocket().drop()
      await flush()
      const timer = [...env.timeouts.values()][0]
      assert.ok(timer !== undefined, `expected a retry to be scheduled after failure ${attempt + 1}`)
      observed.push(timer.ms)
      env.fireRetry()
      await flush()
    }

    assert.deepEqual(observed, [1_000, 2_000, 4_000, 8_000, 16_000, MAX_BACKOFF_MS])
  })

  it('does not stack a second retry when failures arrive together', async () => {
    const { env, client } = harness({ token: 'secret' })
    await client.start()

    // Two closes without an intervening retry: the second must not install a
    // competing timer, which would double the dial rate instead of backing off.
    env.lastSocket().drop()
    env.lastSocket().drop()
    await flush()
    assert.equal(env.timeouts.size, 1)
  })

  it('resets the backoff after a successful authentication', async () => {
    const { env, client } = harness({ token: 'secret' })
    await client.start()

    env.lastSocket().drop()
    await flush()
    env.fireRetry()
    await flush()

    const socket = env.lastSocket()
    socket.open()
    socket.deliver({ type: 'welcome', version: PROTOCOL_VERSION, sessionId: null })
    await flush()

    socket.drop()
    await flush()
    const timer = [...env.timeouts.values()][0]
    assert.equal(timer?.ms, 1_000, 'a successful connection must reset the sequence')
  })

  it('schedules a retry rather than throwing when the socket cannot be opened', async () => {
    const { env, client } = harness({ token: 'secret' })
    env.connectError = 'blocked by a policy'
    await client.start()
    assert.equal(env.sockets.length, 0)
    assert.equal([...env.timeouts.values()][0]?.ms, 1_000)
  })
})

describe('BridgeClient refusals', () => {
  it('stops reconnecting and explains a bad token', async () => {
    const { env, client } = harness({ token: 'wrong' })
    await client.start()
    const socket = env.lastSocket()
    socket.open()
    socket.deliver({ type: 'rejected', reason: 'token' })
    await flush()

    assert.equal(env.status().state, 'unauthorized')
    assert.match(env.status().detail ?? '', /token/i)
    assert.equal(env.timeouts.size, 0, 'a bad token must not be retried')

    // A later start must stay halted: nothing has changed for the user yet.
    await client.start()
    assert.equal(env.sockets.length, 1)
  })

  it('stops reconnecting and asks for an update on a version mismatch', async () => {
    const { env, client } = harness({ token: 'secret' })
    await client.start()
    const socket = env.lastSocket()
    socket.open()
    socket.deliver({ type: 'rejected', reason: 'version' })
    await flush()

    assert.equal(env.status().state, 'incompatible')
    assert.match(env.status().detail ?? '', /update/i)
    assert.equal(env.timeouts.size, 0)
  })

  it('keeps retrying when the bridge is rate limiting', async () => {
    const { env, client } = harness({ token: 'secret' })
    await client.start()
    const socket = env.lastSocket()
    socket.open()
    socket.deliver({ type: 'rejected', reason: 'rate-limit' })
    await flush()

    assert.equal(env.status().state, 'reconnecting')
    assert.equal([...env.timeouts.values()][0]?.ms, 1_000)
  })

  it('clears the halt once the user changes the token', async () => {
    const { env, client } = harness({ token: 'wrong' })
    await client.start()
    const socket = env.lastSocket()
    socket.open()
    socket.deliver({ type: 'rejected', reason: 'token' })
    await flush()
    assert.equal(env.status().state, 'unauthorized')

    env.store[STORAGE_KEYS.token] = 'right'
    await client.reloadConfiguration()

    const dialled = env.lastSocket()
    socket.open()
    dialled.open()
    dialled.deliver({ type: 'welcome', version: PROTOCOL_VERSION, sessionId: null })
    await flush()
    assert.equal(client.isConnected(), true)
  })
})

describe('BridgeClient push handling', () => {
  /** A client that has completed a handshake. */
  async function connected(): Promise<{
    env: FakeEnvironment
    client: BridgeClient
    calls: Recorded
    socket: FakeSocket
  }> {
    const { env, client, calls } = harness({ token: 'secret' })
    await client.start()
    const socket = env.lastSocket()
    socket.open()
    socket.deliver({ type: 'welcome', version: PROTOCOL_VERSION, sessionId: null })
    await flush()
    return { env, client, calls, socket }
  }

  it('forwards start-picking with and without a named tab', async () => {
    const { calls, socket } = await connected()
    socket.deliver({ type: 'start-picking' })
    socket.deliver({ type: 'start-picking', tabId: 9 })
    assert.deepEqual(calls.startPicking, [null, 9])
  })

  it('forwards stop-picking', async () => {
    const { calls, socket } = await connected()
    socket.deliver({ type: 'stop-picking' })
    assert.equal(calls.stopPicking, 1)
  })

  it('forwards an online-access setting', async () => {
    const { calls, socket } = await connected()
    socket.deliver({ type: 'settings', allowOnline: true })
    assert.deepEqual(calls.allowOnline, [true])
  })

  it('logs an unparseable frame and keeps the socket', async () => {
    const { env, client, socket } = await connected()
    socket.onmessage?.({ data: 'not json' })
    assert.equal(client.isConnected(), true)
    assert.ok(env.logs.some((line) => line.includes('unparseable')))
  })

  it('ignores an unrecognised frame without dropping the connection', async () => {
    const { env, client, socket } = await connected()
    socket.deliver({ type: 'a-frame-from-the-future' })
    assert.equal(client.isConnected(), true)
    assert.ok(env.logs.some((line) => line.includes('unrecognised')))
  })
})

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

describe('BridgeClient batches', () => {
  /** A client that has completed a handshake. */
  async function connected(): Promise<{ env: FakeEnvironment; client: BridgeClient; calls: Recorded }> {
    const { env, client, calls } = harness({ token: 'secret' })
    await client.start()
    const socket = env.lastSocket()
    socket.open()
    socket.deliver({ type: 'welcome', version: PROTOCOL_VERSION, sessionId: null })
    await flush()
    return { env, client, calls }
  }

  it('persists a batch before writing it, so a sleep cannot lose it', async () => {
    const { env, client } = await connected()
    await client.sendBatch(batchFixture(), 3)

    assert.ok(env.store['bridge.pending'] !== undefined, 'the batch must be durable before it is sent')
    const frames = env.lastSocket().frames()
    assert.equal(frames.at(-1)?.['type'], 'submit')
  })

  it('clears the stored batch once the bridge acknowledges it', async () => {
    const { env, client, calls } = await connected()
    await client.sendBatch(batchFixture('b-7'), 3)
    env.lastSocket().deliver({ type: 'submit-ack', batchId: 'b-7', ok: true })
    await flush()

    assert.equal(env.store['bridge.pending'], undefined)
    assert.deepEqual(calls.acked, ['b-7'])
    assert.equal(env.status().batchesAcked, 1)
  })

  it('reports a refused batch with the bridge explanation', async () => {
    const { env, client, calls } = await connected()
    await client.sendBatch(batchFixture('b-8'), 3)
    env.lastSocket().deliver({ type: 'submit-ack', batchId: 'b-8', ok: false, message: 'too large' })
    await flush()

    assert.deepEqual(calls.rejected, [{ batchId: 'b-8', message: 'too large' }])
  })

  it('queueing a batch while disconnected rather than dropping it', async () => {
    const { env, client } = harness({ token: 'secret' })
    await client.start()
    // The socket exists but the handshake has not completed, which is exactly
    // the window a user's first click can land in.
    await client.sendBatch(batchFixture('b-9'), 3)
    assert.equal(env.lastSocket().frames().length, 0)
    assert.ok(env.store['bridge.pending'] !== undefined)

    env.lastSocket().open()
    env.lastSocket().deliver({ type: 'welcome', version: PROTOCOL_VERSION, sessionId: null })
    await flush()

    const types = env.lastSocket().frames().map((frame) => frame['type'])
    assert.deepEqual(types, ['hello', 'submit'], 'the queued batch flushes after the handshake')
  })

  it('re-sends a stored batch when a fresh worker starts', async () => {
    const { env, client } = harness({ token: 'secret' })
    // A batch stored by a worker that was recycled before it could send.
    env.store['bridge.pending'] = { batch: batchFixture('b-10'), tabId: 5, attempts: 1 }
    await client.start()
    const socket = env.lastSocket()
    socket.open()
    socket.deliver({ type: 'welcome', version: PROTOCOL_VERSION, sessionId: null })
    await flush()

    const types = socket.frames().map((frame) => frame['type'])
    assert.ok(types.includes('submit'), 'a batch left by a dead worker must be re-sent')
    const stored = env.store['bridge.pending'] as { attempts: number }
    assert.equal(stored.attempts, 2)
  })

  it('gives up on a batch the bridge will not take', async () => {
    const { env, client, calls } = harness({ token: 'secret' })
    env.store['bridge.pending'] = { batch: batchFixture('b-11'), tabId: 5, attempts: 5 }
    await client.start()
    const socket = env.lastSocket()
    socket.open()
    socket.deliver({ type: 'welcome', version: PROTOCOL_VERSION, sessionId: null })
    await flush()

    assert.equal(env.store['bridge.pending'], undefined)
    assert.equal(calls.rejected.length, 1)
    assert.equal(calls.rejected[0]?.batchId, 'b-11')
  })

  it('does not re-send a stored batch while the socket is still connecting', async () => {
    const { env, client } = harness({ token: 'secret' })
    env.store['bridge.pending'] = { batch: batchFixture('b-12'), tabId: 5, attempts: 0 }
    await client.start()
    await client.retryPending()
    assert.equal(env.lastSocket().frames().length, 0, 'sending before the handshake would duplicate the annotations')
  })
})

// ---------------------------------------------------------------------------
// MV3 survival
// ---------------------------------------------------------------------------

describe('BridgeClient service worker survival', () => {
  it('keeps the worker anchored only while a socket is open', async () => {
    const { env, client } = harness({ token: 'secret' })
    await client.start()
    assert.equal(env.alarms.has('keepalive'), false, 'an unauthenticated socket is not worth an alarm')

    const socket = env.lastSocket()
    socket.open()
    socket.deliver({ type: 'welcome', version: PROTOCOL_VERSION, sessionId: null })
    await flush()
    assert.equal(env.alarms.has('keepalive'), true, 'an authenticated socket must survive a sleep')

    socket.drop()
    await flush()
    assert.equal(env.alarms.has('keepalive'), false, 'the alarm must be released when the socket goes')
  })

  it('arms a reconnect alarm so a sleeping worker still retries', async () => {
    const { env, client } = harness({ token: 'secret' })
    await client.start()
    env.lastSocket().drop()
    await flush()
    assert.equal(env.alarms.has('reconnect'), true)
  })

  it('cancels every timer and alarm on stop', async () => {
    const { env, client } = harness({ token: 'secret' })
    await client.start()
    const socket = env.lastSocket()
    socket.open()
    socket.deliver({ type: 'welcome', version: PROTOCOL_VERSION, sessionId: null })
    await flush()

    client.stop()
    assert.equal(env.intervals.size, 0)
    assert.equal(env.timeouts.size, 0)
    assert.equal(env.alarms.size, 0)
    assert.equal(socket.closed !== null, true)
  })

  it('does not schedule a retry for a shutdown the caller asked for', async () => {
    const { env, client } = harness({ token: 'secret' })
    await client.start()
    const socket = env.lastSocket()
    socket.open()
    client.stop()
    socket.drop()
    await flush()
    assert.equal(env.timeouts.size, 0, 'an intentional stop must not look like a failure')
  })

  it('keeps the pairing across a worker restart', async () => {
    const env = new FakeEnvironment()
    env.store[STORAGE_KEYS.token] = 'secret'
    const calls: Recorded = { startPicking: [], stopPicking: 0, allowOnline: [], acked: [], rejected: [] }
    const handlers: BridgeHandlers = {
      onStartPicking: (tabId) => { calls.startPicking.push(tabId) },
      onStopPicking: () => { calls.stopPicking += 1 },
      onAllowOnline: (value) => { calls.allowOnline.push(value) },
      onBatchAcked: () => {},
      onBatchRejected: () => {},
    }

    const first = new BridgeClient({ env, handlers })
    await first.start()
    const socket = env.sockets[0]
    assert.ok(socket !== undefined)
    socket.open()
    socket.deliver({ type: 'welcome', version: PROTOCOL_VERSION, sessionId: null })
    await flush()
    first.stop()

    // The platform recycled the worker: a brand new client over the same storage.
    const second = new BridgeClient({ env, handlers })
    await second.start()
    assert.equal(env.sockets.length, 2, 'a recycled worker must dial again without the user re-pairing')
  })

  it('probes liveness on the ping interval', async () => {
    const { env, client } = harness({ token: 'secret' })
    await client.start()
    const socket = env.lastSocket()
    socket.open()
    socket.deliver({ type: 'welcome', version: PROTOCOL_VERSION, sessionId: null })
    await flush()

    const timer = [...env.intervals.values()][0]
    assert.ok(timer !== undefined)
    timer.handler()
    assert.equal(socket.frames().at(-1)?.['type'], 'ping')
    assert.equal(client.isConnected(), true)
  })
})

describe('BridgeClient storage changes', () => {
  it('reconnects on a new port without the user reloading the extension', async () => {
    const { env, client } = harness({ token: 'secret', port: 43_120 })
    await client.start()
    env.lastSocket().open()

    env.store[STORAGE_KEYS.port] = 43_999
    await client.reloadConfiguration()
    assert.equal(env.lastSocket().url, 'ws://127.0.0.1:43999')
  })

  it('stops picking and reports unpaired when the token is cleared', async () => {
    const { env, client, calls } = harness({ token: 'secret' })
    await client.start()
    env.lastSocket().open()

    delete env.store[STORAGE_KEYS.token]
    await client.reloadConfiguration()
    assert.equal(calls.stopPicking, 1)
    assert.equal(env.status().state, 'unpaired')
  })
})
