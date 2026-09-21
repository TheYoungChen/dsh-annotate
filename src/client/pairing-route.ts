/**
 * The pairing route handler: the one crossing where the bearer token leaves
 * the Node process.
 *
 * The security model has three parts.
 *
 * 1. **A trust fence, not authentication.** These routes have no credential of
 *    their own — the bearer token IS the credential being handed out. What the
 *    fence buys is that a page on another origin cannot read the route through
 *    a victim's browser (DNS rebinding, cross-site fetch), which is exactly
 *    the class of attack that makes a loopback HTTP server dangerous. It is
 *    the same Host/Origin/Sec-Fetch-Site posture DSH's own browser API routes
 *    use, so a request that clears it is one the browser already considers
 *    same-origin with this DSH instance.
 * 2. **Two routes, not one.** The polling route never answers the token; only
 *    {@link ROUTE_TOKEN} does, and only when the user explicitly asks. A
 *    timer that re-fetched the secret every few seconds would leave the
 *    credential in devtools, in proxy logs, and in any extension watching the
 *    tab's traffic.
 * 3. **The token is not cached by the browser.** Both routes answer
 *    `no-store`, so a revealed token cannot survive in the HTTP cache into a
 *    later profile or a shared machine.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BridgeStatus } from '../bridge.ts'
import {
  INJECT_HOLD_MS,
  ROUTE_INJECT,
  ROUTE_PREFIX,
  ROUTE_STATUS,
  ROUTE_TOKEN,
  maskSecret,
  type InjectionAckRequest,
  type InjectionAckResponse,
  type InjectionPullResponse,
  type PairingErrorCode,
  type PairingErrorResponse,
  type PairingStatus,
  type PairingStatusResponse,
  type PairingTokenResponse,
  type PendingInjection,
} from './pairing-contract.ts'

/**
 * Authorities this deployment serves besides loopback.
 *
 * Read from the same environment knob DSH's own browser-trust fence consults,
 * so a deployment that exposes the GUI on a named host does not silently lose
 * its pairing page. Absent or empty means loopback only.
 *
 * @returns the configured trusted authorities, comma-separated on input.
 */
function trustedHosts(): readonly string[] {
  const raw = process.env['DSH_TRUSTED_HOSTS']
  if (typeof raw !== 'string' || raw.trim() === '') return []
  return raw.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
}

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** Whether a hostname names the local machine's loopback authority. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** Whether the request's Host header names an authority this deployment serves. */
function isTrustedAuthority(hostUrl: URL, trusted: readonly string[]): boolean {
  return trusted.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** First value of a possibly-repeated header, or undefined. */
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Decide whether one request may reach the pairing routes.
 *
 * Refuses a missing or unparsable Host (the fence is derived from it, so no
 * Host means no decision can be made), an authority that is neither loopback
 * nor explicitly trusted, a browser-marked cross-site request, and an opaque
 * `Origin: null` — a sandboxed iframe or a `file:` page has no origin to
 * compare, and treating it as same-origin would let any local document read
 * the token.
 *
 * @param request - the incoming request.
 * @returns whether the request is same-origin with this DSH instance.
 */
export function isTrustedPairingRequest(request: IncomingMessage): boolean {
  const host = header(request, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts())) return false
  if (header(request, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request, 'origin')
  // Absent Origin is fine: a top-level navigation or a same-origin fetch from
  // an older browser omits it, and the Host fence already bound the authority.
  if (origin === undefined) return true
  if (origin === 'null') return false
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/** Write one JSON response with the caching and sniffing posture these routes require. */
function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // The token route's whole point is that the secret does not linger, and
    // the status route must never show a stale connection state either.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

/** Write one failure envelope. Messages are non-specific on purpose. */
function writeError(res: ServerResponse, statusCode: number, code: PairingErrorCode): void {
  const body: PairingErrorResponse = { error: { code, message: code } }
  writeJson(res, statusCode, body)
}

/** What the pairing routes read from the plugin. */
export interface PairingRouteSource {
  /** Current bridge snapshot. Must never carry the token. */
  status: () => BridgeStatus
  /** The bearer token for this instance. */
  token: () => string
  /**
   * Claim every annotation block the host is holding for this page.
   *
   * Optional so the route table stays usable without the composer relay (and so
   * this handler stays testable on its own). When it is absent the injection
   * route answers an empty list rather than 404: the page should idle, not treat
   * a missing optional subsystem as a broken transport.
   *
   * @returns the blocks, oldest first. Claiming removes them.
   */
  takeInjections?: () => PendingInjection[]
  /**
   * Record what the page did with blocks it claimed.
   *
   * @param ids - the hand-off ids the page reported on.
   * @returns a host-log line describing the outcome.
   */
  acknowledgeInjections?: (ids: readonly string[]) => string
  /**
   * Log one host-side line about injection delivery.
   * @param message - the already-formatted line.
   */
  log?: (message: string) => void
}

/**
 * Read a request body, bounded.
 *
 * Bounded because this route is reachable by anything that clears the fence: an
 * unbounded body read would let a same-origin caller grow this process's heap
 * for free. The limit is far above any real acknowledgement (a handful of ids)
 * and far below anything that could matter.
 *
 * @param req - the incoming request.
 * @returns the body text, or undefined when it exceeded the limit.
 */
async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > limit) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Parse an acknowledgement body.
 *
 * Every failure — unparsable, wrong shape, a non-string member — collapses to an
 * empty list. The route is bookkeeping: the page has already applied the writes
 * by the time it acknowledges, so the worst outcome of a bad body is a less
 * informative log line, and refusing it would only make the page retry an
 * acknowledgement that can no longer change anything.
 *
 * @param raw - the raw request body.
 * @returns the reported ids, or an empty list.
 */
export function parseInjectionAck(raw: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const ids = (parsed as Partial<InjectionAckRequest>).ids
  if (!Array.isArray(ids)) return []
  return ids.filter((id): id is string => typeof id === 'string')
}

/**
 * Project a bridge snapshot plus its token into the UI's status shape.
 *
 * Kept separate from the handler so the masking rule is testable without an
 * HTTP server: the raw token is read here only to derive a mask, and the
 * projection has no field that can carry it.
 *
 * @param status - the bridge snapshot.
 * @param token - the bearer token for this instance.
 * @returns the status the UI renders, token redacted.
 */
export function projectStatus(status: BridgeStatus, token: string): PairingStatus {
  const tokenGenerated = token !== ''
  return {
    connected: status.connected,
    listening: status.listening,
    port: status.port,
    address: status.address,
    extensionId: status.extensionId,
    connectedAt: status.connectedAt,
    protocolVersion: status.protocolVersion,
    tokenIssuedAt: status.tokenIssuedAt,
    tokenGenerated,
    tokenMasked: tokenGenerated ? maskSecret(token) : null,
    tokenDisclosure: 'masked',
  }
}

/**
 * Build the handler for this plugin's pairing routes.
 *
 * Both routes share one handler because they share one fence and one response
 * vocabulary; splitting them would duplicate the security decision, which is
 * the one thing that must not drift between two entry points. The URL path
 * selects which facts are disclosed.
 *
 * @param source - the bridge snapshot and token readers.
 * @returns a route handler covering {@link ROUTE_PREFIX}.
 */
export function createPairingRouteHandler(
  source: PairingRouteSource,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (!isTrustedPairingRequest(req)) {
      writeError(res, 403, 'forbidden')
      return
    }
    // Parsed against a fixed base: a request-target may be an absolute form or
    // a bare path, and only the pathname is meaningful here.
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname

    if (pathname === ROUTE_INJECT) {
      handleInject(source, req, res)
      return
    }

    // GET only: a state-changing method must never be able to reach the token
    // route, and a prefetch or an <img> probe is always a GET.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeError(res, 405, 'method-error')
      return
    }
    if (pathname === ROUTE_STATUS) {
      const body: PairingStatusResponse = { status: projectStatus(source.status(), source.token()) }
      writeJson(res, 200, body)
      return
    }
    if (pathname === ROUTE_TOKEN) {
      const token = source.token()
      if (token === '') {
        writeError(res, 503, 'unavailable')
        return
      }
      const body: PairingTokenResponse = { token, issuedAt: source.status().tokenIssuedAt }
      writeJson(res, 200, body)
      return
    }
    writeError(res, 404, 'not-found')
  }
}

/**
 * Serve one request on the injection route.
 *
 * Two verbs, one resource:
 *
 * - `GET` claims whatever the host is holding, holding the response open for up
 *   to {@link INJECT_HOLD_MS} when nothing is waiting. Holding is what makes the
 *   hand-off feel immediate: the page keeps one request in flight instead of
 *   asking every few seconds, and a batch that lands in between is answered the
 *   moment it is parked.
 * - `POST` records the page's report on the blocks it claimed. The reply is
 *   always `{ ok: true }` — the writes have already happened by then, so a
 *   failure here would be a failure to describe something that is already true.
 *
 * The hold is deliberately NOT conditional on a "was anything claimed" flag: a
 * request that claims nothing waits, and a request that claims something answers
 * immediately, which is exactly what the client loop wants (apply, acknowledge,
 * ask again).
 *
 * @param source - the routes' data source; the relay members are optional.
 * @param req - the incoming request.
 * @param res - the response to own until it is answered or the hold expires.
 */
function handleInject(source: PairingRouteSource, req: IncomingMessage, res: ServerResponse): void {
  const take = source.takeInjections
  if (req.method === 'POST') {
    void readBody(req).then((raw) => {
      if (raw === undefined) {
        writeError(res, 413, 'method-error')
        return
      }
      const ids = parseInjectionAck(raw)
      const summary = source.acknowledgeInjections?.(ids)
      if (summary !== undefined && ids.length > 0) source.log?.(`[dsh-annotate] browser client ${summary}`)
      const body: InjectionAckResponse = { ok: true }
      writeJson(res, 200, body)
    }, () => { writeError(res, 400, 'internal') })
    return
  }
  if (req.method !== 'GET') {
    writeError(res, 405, 'method-error')
    return
  }

  const answer = (injections: readonly PendingInjection[]): void => {
    if (res.writableEnded) return
    const body: InjectionPullResponse = { injections }
    writeJson(res, 200, body)
  }

  const claimed = take === undefined ? [] : take()
  if (claimed.length > 0) {
    answer(claimed)
    return
  }

  // Nothing waiting: hold the request so a batch that lands next is delivered
  // without a polling delay. The timer is cleared on client disconnect, because
  // a backgrounded tab closing its connections must not leave timers behind.
  // `onClose` is declared before the timer so the timer's own callback can
  // detach it without a forward reference.
  const onClose = (): void => {
    clearTimeout(timer)
  }
  const timer = setTimeout(() => {
    res.off('close', onClose)
    answer(take === undefined ? [] : take())
  }, INJECT_HOLD_MS)
  // Node timers keep the process alive; this one must not, since it is only ever
  // waiting on a browser that may never answer.
  timer.unref?.()

  res.on('close', onClose)
}
