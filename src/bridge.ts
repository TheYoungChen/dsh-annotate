/**
 * Loopback WebSocket carrier for the dsh-annotate browser extension.
 *
 * The bridge deliberately does NOT ride on the DSH host webserver. Two reasons:
 *
 * 1. The host webserver's routes sit behind DSH's own browser-trust fence, which
 *    is derived from the Host header and the `--trusted-host` list. A browser
 *    extension's service worker is not a browser page and cannot present a
 *    trustworthy Host in the way that fence expects, so reusing it would mean
 *    either weakening the fence or adding an exemption to it. A socket we own
 *    keeps DSH's fence untouched.
 * 2. The extension's `connect-src` is pinned to `ws://127.0.0.1:*`, so a fixed
 *    loopback port is the only address it can reach without a manifest change.
 *
 * Because WebSockets have NO same-origin policy, binding to loopback is not by
 * itself an authorization boundary: any page the user visits can open a socket
 * to `ws://127.0.0.1:<port>` and reach this server. Loopback keeps the attack
 * surface local, and the bearer token — required in the first frame, before any
 * other message is accepted — is what actually decides who gets in.
 *
 * @module
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  isAnnotationBatch,
  type AnnotationBatch,
  type BridgeMessage,
  type ExtensionMessage,
} from './protocol.ts'

/** Bind address. Loopback only — see the module docblock for why this is a floor. */
export const BIND_ADDRESS = '127.0.0.1'

/**
 * How long a freshly-opened socket may take to present a valid `hello`.
 *
 * Unauthenticated sockets are the cheapest resource an attacker can consume
 * (open a socket, send nothing), so they are reaped rather than kept alive.
 */
export const HELLO_TIMEOUT_MS = 5_000

/** How often the bridge pings a promoted socket to prove it is still there. */
export const PING_INTERVAL_MS = 30_000

/** How long a promoted socket may go without a `pong` before it is terminated. */
export const PONG_TIMEOUT_MS = 10_000

/** Bearer-token entropy: 32 bytes, the conventional 256-bit width for a shared secret. */
export const TOKEN_BYTES = 32

/** Close code used when a socket is dropped for an authentication failure. */
export const CLOSE_BAD_TOKEN = 4002

/** Close code used when a socket is dropped for speaking the wrong protocol. */
export const CLOSE_PROTOCOL = 4003

/** Close code used when a socket is dropped for failing to say `hello` in time. */
export const CLOSE_HELLO_TIMEOUT = 4001

/** Close code used when a socket is replaced by a newer authenticated socket. */
export const CLOSE_REPLACED = 4000

/**
 * Generate a fresh bearer token.
 *
 * Uses the CSPRNG rather than `Math.random`, which is seeded from a predictable
 * source and would let a local attacker who observed one token derive the next.
 *
 * @returns 64 lowercase hex characters, or `DSH_ANNOTATE_TOKEN` when that
 *   environment variable is set (an escape hatch for test harnesses that need
 *   to know the token before the bridge starts).
 */
export function generateToken(): string {
  const fromEnv = process.env['DSH_ANNOTATE_TOKEN']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return randomBytes(TOKEN_BYTES).toString('hex')
}

/**
 * Constant-time token comparison.
 *
 * A byte-by-byte `===` leaks the length of the matching prefix through timing,
 * which is enough to recover a token one character at a time over many
 * attempts. `timingSafeEqual` requires equal-length buffers, so unequal lengths
 * are rejected up front — that branch leaks only the length, which is fixed.
 *
 * @param expected - the token this bridge was started with.
 * @param presented - the token the extension sent.
 * @returns whether the two match.
 */
export function verifyToken(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(presented, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Whether an address is a loopback literal.
 *
 * The bind address already restricts the listening socket, but a deployment
 * behind a loopback proxy (or an OS that reports IPv4-mapped addresses) can
 * still hand us a non-loopback remote, so the upgrade is re-checked.
 *
 * @param address - `req.socket.remoteAddress`, possibly undefined.
 * @returns whether the address is loopback.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Snapshot of what the bridge is currently doing, for the status tool and the UI. */
export interface BridgeStatus {
  /** Whether the acceptor is listening. */
  readonly listening: boolean
  /** Port the acceptor is bound to. */
  readonly port: number
  /** Address the acceptor is bound to. Always loopback. */
  readonly address: string
  /** Whether an authenticated extension currently owns the connection slot. */
  readonly connected: boolean
  /** The connected extension's id, when one is connected. */
  readonly extensionId: string | null
  /** When the current connection was established, as epoch milliseconds. */
  readonly connectedAt: number | null
  /** Negotiated protocol version of the live connection. */
  readonly protocolVersion: number | null
  /** Round-trip latency of the last ping/pong exchange, in milliseconds. */
  readonly lastPingMs: number | null
  /** How many `submit` batches have been accepted since start. */
  readonly batchesReceived: number
  /** How many `submit` batches have been dropped by the guard since start. */
  readonly batchesRejected: number
  /** When the token was generated, as epoch milliseconds. */
  readonly tokenIssuedAt: number
}

/** What the plugin layer must supply for the bridge to be useful. */
export interface BridgeOptions {
  /** Loopback port to bind. Defaults to {@link DEFAULT_PORT}. */
  port?: number
  /**
   * Called for every batch that passed {@link isAnnotationBatch}.
   *
   * Return value contract: resolve to receive `{ ok: true }` in the
   * `submit-ack`; reject with an `Error` to receive `{ ok: false }` and its
   * message. The bridge never swallows a rejection silently — the extension has
   * to know whether its batch landed, or it will retry forever.
   */
  onSubmit: (batch: AnnotationBatch) => void | Promise<void>
  /** Log sink. Defaults to silence so the bridge is usable from a plain script. */
  logger?: BridgeLogger
}

/** Minimal logging seam, so the bridge does not depend on the DSH logger shape. */
export interface BridgeLogger {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

/** The single authenticated socket, plus the bookkeeping needed to keep it honest. */
interface ReadyConnection {
  ws: WebSocket
  extensionId: string
  protocolVersion: number
  connectedAt: number
  /** Payload of the most recent ping, so a pong can be matched to its probe. */
  pendingPing: { nonce: string; sentAt: number } | null
  lastPingMs: number | null
  pingTimer: NodeJS.Timeout
  pongTimer: NodeJS.Timeout | null
}

/**
 * Decode one WebSocket payload to text.
 *
 * `ws` delivers a `Buffer` in practice, but the three shapes are handled
 * because the type signature is a union and a future `ws` version may pick
 * another arm.
 *
 * @param data - the raw message payload.
 * @returns the decoded UTF-8 text.
 */
export function messageToText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Narrow one decoded WebSocket message to an {@link ExtensionMessage}.
 *
 * This is a transport guard, not a trust decision: it only proves the frame has
 * a shape the bridge knows how to route. A `submit` frame that passes here has
 * a `batch` of type `unknown`, which is exactly why the handler runs
 * {@link isAnnotationBatch} on it afterwards rather than believing this guard.
 *
 * @param value - the result of `JSON.parse` on a message, or anything else.
 * @returns the narrowed message, or `undefined` when it is not routable.
 */
export function parseExtensionMessage(value: unknown): ExtensionMessage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  switch (record['type']) {
    case 'hello':
      if (typeof record['token'] !== 'string') return undefined
      if (typeof record['extensionId'] !== 'string' || record['extensionId'] === '') return undefined
      return {
        type: 'hello',
        // A hello from a future protocol version is still parseable; version
        // rejection is a policy decision taken by the handler, so the two
        // failure modes can report different reasons to the extension.
        version: typeof record['version'] === 'number'
          ? record['version'] as typeof PROTOCOL_VERSION
          : PROTOCOL_VERSION,
        token: record['token'],
        extensionId: record['extensionId'],
      }
    case 'submit':
      // Deliberately does NOT validate the batch: that is `isAnnotationBatch`'s
      // job, and doing it here would make a malformed batch indistinguishable
      // from an unparseable frame (one gets an ack, the other gets a close).
      return { type: 'submit', batch: record['batch'] as AnnotationBatch }
    case 'ping':
      return { type: 'ping' }
    case 'page-picked': {
      const tabId = record['tabId']
      const url = record['url']
      const title = record['title']
      if (typeof tabId !== 'number' || typeof url !== 'string' || typeof title !== 'string') return undefined
      return { type: 'page-picked', tabId, url, title }
    }
    default:
      return undefined
  }
}

/**
 * Loopback WebSocket server that authenticates one browser extension.
 *
 * Exactly one extension owns the connection slot at a time: a newly
 * authenticated socket replaces the previous one, so a reloading service worker
 * cannot leave a zombie socket holding the slot.
 *
 * @example
 * ```ts
 * const bridge = new BridgeServer({ onSubmit: async (batch) => { await render(batch) } })
 * await bridge.start()
 * console.log(bridge.status().port)
 * await bridge.stop()
 * ```
 */
export class BridgeServer {
  private readonly port: number
  private readonly onSubmit: (batch: AnnotationBatch) => void | Promise<void>
  private readonly logger: BridgeLogger

  private wss: WebSocketServer | null = null
  private current: ReadyConnection | null = null
  private stopping = false

  private readonly token: string
  private readonly tokenIssuedAt: number
  private batchesReceived = 0
  private batchesRejected = 0

  /**
   * @param options - submission callback, port, and optional logger.
   */
  constructor(options: BridgeOptions) {
    this.port = options.port ?? DEFAULT_PORT
    this.onSubmit = options.onSubmit
    this.logger = options.logger ?? { info: () => {}, warn: () => {}, error: () => {} }
    this.token = generateToken()
    this.tokenIssuedAt = Date.now()
  }

  /**
   * The bearer token an extension must present in its `hello` frame.
   *
   * Exposed so the plugin can hand it to a pairing UI. It must never be logged
   * or written to a world-readable file: possession is the entire credential.
   *
   * @returns the token generated for this instance.
   */
  getToken(): string {
    return this.token
  }

  /**
   * Bind the acceptor and start accepting connections.
   *
   * Resolves only once the socket is actually listening, so a caller that
   * awaits `start()` can rely on {@link status} reporting `listening: true`.
   *
   * @returns a promise that settles when the port is bound, or rejects when it
   *   is unavailable (another DSH instance already owns it).
   */
  async start(): Promise<void> {
    if (this.wss !== null) return
    // `host` is what keeps this loopback-only. `WebSocketServer` binds all
    // interfaces when it is omitted, which would expose the bridge to the LAN.
    const wss = new WebSocketServer({ host: BIND_ADDRESS, port: this.port })
    this.wss = wss

    wss.on('connection', (ws, req) => {
      this.attach(ws, req.socket.remoteAddress)
    })
    wss.on('error', (error) => {
      this.logger.error(`[dsh-annotate] bridge server error: ${String(error)}`)
    })

    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        wss.off('error', onError)
        resolve()
      }
      const onError = (error: Error): void => {
        wss.off('listening', onListening)
        this.wss = null
        reject(error)
      }
      wss.once('listening', onListening)
      wss.once('error', onError)
    })
    this.logger.info(`[dsh-annotate] bridge listening on ws://${BIND_ADDRESS}:${this.port}`)
  }

  /**
   * Stop the acceptor, drop the live socket, and settle every timer.
   *
   * Idempotent: DSH may dispose a plugin more than once across a reload, and a
   * second `stop()` must not throw.
   *
   * @returns a promise that settles once the acceptor has closed.
   */
  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.dropConnection('bridge stopping')
    const wss = this.wss
    this.wss = null
    if (wss === null) return
    await new Promise<void>((resolve) => {
      // Terminate rather than close: a half-dead socket must not be able to
      // hold the port open past the plugin's own teardown.
      for (const socket of wss.clients) socket.terminate()
      wss.close(() => { resolve() })
    })
    this.logger.info('[dsh-annotate] bridge stopped')
  }

  /**
   * Whether an authenticated extension currently owns the connection slot.
   * @returns true when an extension is connected and authenticated.
   */
  hasConnection(): boolean {
    return this.current !== null
  }

  /**
   * Snapshot the bridge's current state for the `annotate_status` tool.
   * @returns a frozen-in-time status object.
   */
  status(): BridgeStatus {
    const conn = this.current
    return {
      listening: this.wss !== null,
      port: this.port,
      address: BIND_ADDRESS,
      connected: conn !== null,
      extensionId: conn?.extensionId ?? null,
      connectedAt: conn?.connectedAt ?? null,
      protocolVersion: conn?.protocolVersion ?? null,
      lastPingMs: conn?.lastPingMs ?? null,
      batchesReceived: this.batchesReceived,
      batchesRejected: this.batchesRejected,
      tokenIssuedAt: this.tokenIssuedAt,
    }
  }

  /**
   * Send one frame to the connected extension.
   *
   * A no-op when nothing is connected: callers that push UI state (for example
   * "start picking") should not have to check first, and a caller that cares
   * can consult {@link hasConnection}.
   *
   * @param message - the frame to send.
   * @returns whether the frame was written to a live socket.
   */
  send(message: BridgeMessage): boolean {
    const conn = this.current
    if (conn === null) return false
    if (conn.ws.readyState !== conn.ws.OPEN) return false
    conn.ws.send(JSON.stringify(message))
    return true
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Wire one freshly-accepted socket.
   *
   * The socket is UNTRUSTED until `hello` clears both the token and the version
   * check. Until then only `hello` is accepted, and a hello timer reaps sockets
   * that never speak.
   *
   * @param ws - the accepted socket.
   * @param remoteAddress - the peer address, re-checked for loopback.
   */
  private attach(ws: WebSocket, remoteAddress: string | undefined): void {
    // Defence in depth: the bind address is loopback, but a loopback proxy or a
    // container port-forward can still surface a non-loopback peer here.
    if (!isLoopbackAddress(remoteAddress)) {
      this.logger.warn(`[dsh-annotate] rejected non-loopback connection from ${String(remoteAddress)}`)
      ws.close(CLOSE_BAD_TOKEN, 'loopback only')
      return
    }

    let helloTimer: NodeJS.Timeout | null = setTimeout(() => {
      this.logger.warn('[dsh-annotate] socket dropped: no hello within the timeout')
      ws.close(CLOSE_HELLO_TIMEOUT, 'hello timeout')
    }, HELLO_TIMEOUT_MS)

    // One dispatcher for the whole socket lifetime, branching on whether the
    // socket has been promoted yet. Attaching a second listener at promotion
    // time instead would leave the hello-phase listener in place, so the hello
    // frame itself would be handled twice (promoting on the first pass and
    // being logged as a duplicate on the second).
    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      const text = messageToText(data)
      const conn = this.current
      if (conn !== null && conn.ws === ws) {
        this.handleReadyMessage(conn, text)
        return
      }
      const message = parseExtensionMessage(this.parseJson(text))
      if (message === undefined) {
        ws.close(CLOSE_PROTOCOL, 'unparseable frame')
        return
      }
      if (message.type !== 'hello') {
        ws.close(CLOSE_PROTOCOL, 'hello first')
        return
      }
      if (message.version !== PROTOCOL_VERSION) {
        this.sendDirect(ws, { type: 'rejected', reason: 'version' })
        ws.close(CLOSE_PROTOCOL, 'protocol version mismatch')
        return
      }
      if (!verifyToken(this.token, message.token)) {
        // Logged WITHOUT the presented value: a near-miss token in the log is
        // still a token, and logs travel further than the process does.
        this.logger.warn(`[dsh-annotate] rejected connection from extension "${message.extensionId}": bad token`)
        this.sendDirect(ws, { type: 'rejected', reason: 'token' })
        ws.close(CLOSE_BAD_TOKEN, 'bad token')
        return
      }
      if (helloTimer !== null) {
        clearTimeout(helloTimer)
        helloTimer = null
      }
      this.promote(ws, message.extensionId, message.version)
    }

    ws.on('message', onMessage)
    const clearHelloTimer = (): void => {
      if (helloTimer !== null) {
        clearTimeout(helloTimer)
        helloTimer = null
      }
    }
    ws.once('close', clearHelloTimer)
    ws.once('error', clearHelloTimer)
  }

  /**
   * Promote an authenticated socket into the single connection slot.
   * @param ws - the authenticated socket.
   * @param extensionId - the id the extension reported in `hello`.
   * @param version - the negotiated protocol version.
   */
  private promote(ws: WebSocket, extensionId: string, version: number): void {
    // A reloading service worker reconnects before the old socket's close is
    // observed, so the old one is displaced rather than counted as a second.
    this.dropConnection('replaced by a newer connection')

    const conn: ReadyConnection = {
      ws,
      extensionId,
      protocolVersion: version,
      connectedAt: Date.now(),
      pendingPing: null,
      lastPingMs: null,
      pingTimer: setInterval(() => { this.ping(conn) }, PING_INTERVAL_MS),
      pongTimer: null,
    }
    this.current = conn

    // No message listener is added here: `attach` installed one dispatcher that
    // routes to {@link handleReadyMessage} as soon as `this.current` names this
    // socket, so registering another would double-handle every frame.
    ws.once('close', () => {
      if (this.current === conn) {
        this.logger.info(`[dsh-annotate] extension "${extensionId}" disconnected`)
        this.dropConnection('socket closed')
      }
    })
    ws.once('error', () => {
      if (this.current === conn) this.dropConnection('socket error')
    })

    this.sendDirect(ws, { type: 'welcome', version: PROTOCOL_VERSION, sessionId: null })
    this.logger.info(`[dsh-annotate] extension "${extensionId}" connected (protocol v${version})`)
  }

  /**
   * Probe the live socket. A pong must arrive before {@link PONG_TIMEOUT_MS} or
   * the socket is terminated.
   *
   * A WebSocket can stay "open" indefinitely against a peer that vanished
   * (a laptop sleeping, a USB NIC unplugged), and nothing else would tell us:
   * the extension would simply never send another batch and the UI would keep
   * claiming a live connection.
   *
   * @param conn - the connection to probe.
   */
  private ping(conn: ReadyConnection): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return
    const nonce = randomUUID()
    conn.pendingPing = { nonce, sentAt: Date.now() }
    this.sendDirect(conn.ws, { type: 'ping' } as unknown as BridgeMessage)
    // The protocol has no client->bridge `pong` frame, so liveness is proven by
    // ANY inbound frame after a ping. A silent socket is what we terminate.
    conn.pongTimer = setTimeout(() => {
      this.logger.warn(`[dsh-annotate] extension "${conn.extensionId}" went silent; dropping the socket`)
      conn.ws.terminate()
      if (this.current === conn) this.dropConnection('pong timeout')
    }, PONG_TIMEOUT_MS)
  }

  /**
   * Route one frame from an authenticated connection.
   * @param conn - the owning connection.
   * @param text - the decoded frame text.
   */
  private handleReadyMessage(conn: ReadyConnection, text: string): void {
    // Any inbound frame proves liveness, so the outstanding pong timer clears
    // here rather than in a dedicated frame handler.
    if (conn.pongTimer !== null) {
      clearTimeout(conn.pongTimer)
      conn.pongTimer = null
    }
    if (conn.pendingPing !== null) {
      conn.lastPingMs = Date.now() - conn.pendingPing.sentAt
      conn.pendingPing = null
    }

    const message = parseExtensionMessage(this.parseJson(text))
    if (message === undefined) {
      // An authenticated peer sending rubbish is a bug, not an attack; closing
      // would make the extension reconnect-loop and hide the original error, so
      // it is logged and the frame dropped.
      this.logger.warn('[dsh-annotate] dropped an unparseable frame from the extension')
      return
    }

    switch (message.type) {
      case 'hello':
        // A second hello on a promoted socket is a protocol violation: the
        // extension is re-authenticating without reconnecting.
        this.logger.warn('[dsh-annotate] ignored a duplicate hello frame')
        break
      case 'ping':
        // Symmetric liveness: the extension may probe us too. There is no
        // bridge->extension "pong" in the protocol, so a `welcome` is the only
        // side-effect-free frame available; the inbound ping itself already
        // refreshed our liveness bookkeeping above.
        break
      case 'page-picked':
        this.logger.info(`[dsh-annotate] page picked: ${message.title} (${message.url})`)
        break
      case 'submit':
        void this.handleSubmit(conn, message.batch)
        break
    }
  }

  /**
   * Validate and deliver one submitted batch, then ack the extension.
   *
   * The batch arrives from a page-adjacent runtime, so it is treated as
   * untrusted input: {@link isAnnotationBatch} runs before anything downstream
   * sees it, and a batch that fails is refused with an ack rather than thrown,
   * so the extension can tell "your payload was wrong" from "the bridge died".
   *
   * @param conn - the owning connection.
   * @param batch - the batch, as received (unvalidated).
   */
  private async handleSubmit(conn: ReadyConnection, batch: unknown): Promise<void> {
    if (!isAnnotationBatch(batch)) {
      this.batchesRejected += 1
      // batchId is read defensively: a batch that failed the guard may not have
      // one at all, and the ack still needs a correlation id.
      const batchId = typeof (batch as { batchId?: unknown } | null)?.batchId === 'string'
        ? (batch as { batchId: string }).batchId
        : ''
      this.logger.warn('[dsh-annotate] rejected a malformed batch')
      this.sendDirect(conn.ws, {
        type: 'submit-ack',
        batchId,
        ok: false,
        message: 'the batch failed protocol validation and was dropped',
      })
      return
    }

    this.batchesReceived += 1
    try {
      await this.onSubmit(batch)
      this.sendDirect(conn.ws, { type: 'submit-ack', batchId: batch.batchId, ok: true })
    } catch (error: unknown) {
      // The extension must learn that delivery failed; without this it would
      // assume success and drop the user's annotations.
      this.sendDirect(conn.ws, {
        type: 'submit-ack',
        batchId: batch.batchId,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Clear the connection slot and every timer it owns.
   * @param reason - logged reason, so a drop is never silent.
   */
  private dropConnection(reason: string): void {
    const conn = this.current
    if (conn === null) return
    this.current = null
    clearInterval(conn.pingTimer)
    if (conn.pongTimer !== null) clearTimeout(conn.pongTimer)
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.close(CLOSE_REPLACED, reason)
    this.logger.info(`[dsh-annotate] connection dropped: ${reason}`)
  }

  /**
   * Parse JSON without throwing.
   * @param text - candidate JSON text.
   * @returns the parsed value, or `undefined`.
   */
  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }

  /**
   * Write one frame, ignoring a socket that died mid-write.
   * @param ws - the target socket.
   * @param message - the frame to write.
   */
  private sendDirect(ws: WebSocket, message: BridgeMessage): void {
    if (ws.readyState !== ws.OPEN) return
    ws.send(JSON.stringify(message))
  }
}
