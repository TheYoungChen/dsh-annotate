/**
 * The pairing wire between this plugin's host half and its browser half.
 *
 * Two facts the pairing UI needs (the bearer token and the live connection
 * state) live in the Node process, while the UI runs in the page. They are
 * bridged over an HTTP route this plugin registers on the DSH web server
 * rather than through a forwarded Remote event, because the token must travel
 * on exactly one request that the user explicitly triggers — a broadcast
 * channel would hand the credential to every subscriber the moment the page
 * boots.
 *
 * This module is imported by both halves, so it must stay free of Node and
 * DOM APIs: it is types plus pure string constants only.
 *
 * @module
 */

/**
 * Base path of this plugin's own HTTP routes.
 *
 * Namespaced under the plugin's own name so it can never collide with another
 * package's route table, and deliberately distinct from any shared DSH API
 * prefix: these routes are this plugin's private transport, not a framework
 * facility.
 */
export const ROUTE_PREFIX = '/dsh-annotate/api'

/** Route answering the connection/port facts, with the token redacted. */
export const ROUTE_STATUS = `${ROUTE_PREFIX}/status`

/**
 * Route answering the bearer token in full.
 *
 * Separated from {@link ROUTE_STATUS} on purpose: the status route is polled
 * on a timer, while the token is fetched only when the user asks to see it.
 * One route serving both would put the credential on the wire on every poll.
 */
export const ROUTE_TOKEN = `${ROUTE_PREFIX}/token`

/**
 * Route handing this page any annotation block the host is holding.
 *
 * The host accepts an annotation batch over its loopback bridge, which lives in
 * Node, but the composer it has to end up in lives here. This route is that
 * crossing, and it exists because there is no other one: the host has no
 * composer API at all, and the framework's host-to-client push channel is a
 * fixed allowlist that a plugin cannot join. The transport is therefore this
 * plugin's own — the same prefix this page already reads its pairing facts from.
 *
 * Reads and writes share one path because they are one operation: a GET that
 * *claims* whatever is waiting (see `takePending` — claiming removes, so a block
 * is never handed out twice), and a POST that reports what happened to the
 * blocks just claimed.
 */
export const ROUTE_INJECT = `${ROUTE_PREFIX}/inject`

/**
 * How long a pending-injection GET is held open before answering "nothing yet".
 *
 * This is a long poll rather than a timer because the delay it removes is the
 * one the user feels: a batch that arrives while the poll is open is handed over
 * the instant it lands, and a batch that arrives while the page is idle costs
 * one held request instead of a request every few seconds forever.
 */
export const INJECT_HOLD_MS = 25_000

/**
 * How the token is presented to the user.
 *
 * The distinction exists so the UI never renders the raw secret by default:
 * the status route answers `masked`, and only an explicit reveal answers
 * `full`.
 */
export type TokenDisclosure = 'masked' | 'full'

/**
 * Masked form of a secret, preserving only a short prefix.
 *
 * The prefix is what lets a user confirm *which* token they are looking at
 * when several DSH instances are running; the remaining characters are
 * replaced wholesale so the mask cannot be reversed by counting bullets.
 *
 * @param secret - the value to mask.
 * @param visible - how many leading characters stay readable.
 * @returns the masked display form.
 */
export function maskSecret(secret: string, visible = 4): string {
  const kept = secret.slice(0, Math.max(0, Math.min(visible, secret.length)))
  // The bullet count is capped: a 64-character token must not turn into an
  // unreadable wall of dots that pushes the reveal control off the row.
  const hidden = Math.min(Math.max(secret.length - kept.length, 0), 8)
  return `${kept}${'•'.repeat(hidden)}`
}

/** Connection and pairing facts the UI renders, with the token already redacted. */
export interface PairingStatus {
  /** Whether an authenticated extension currently owns the bridge connection. */
  readonly connected: boolean
  /** Whether the bridge socket is bound at all. */
  readonly listening: boolean
  /** Loopback port the bridge is bound to. */
  readonly port: number
  /** Bind address. Always loopback. */
  readonly address: string
  /** The connected extension's reported id, when one is connected. */
  readonly extensionId: string | null
  /** When the current connection was established (epoch ms), or null. */
  readonly connectedAt: number | null
  /** Negotiated protocol version of the live connection, or null. */
  readonly protocolVersion: number | null
  /** When the bearer token was generated (epoch ms). */
  readonly tokenIssuedAt: number
  /** Whether a bearer token exists for this instance. */
  readonly tokenGenerated: boolean
  /** Masked token, safe to render without an explicit reveal. */
  readonly tokenMasked: string | null
  /** How the token field in this response was disclosed. */
  readonly tokenDisclosure: TokenDisclosure
}

/** Response body of {@link ROUTE_STATUS}. */
export interface PairingStatusResponse {
  readonly status: PairingStatus
}

/** Response body of {@link ROUTE_TOKEN}. */
export interface PairingTokenResponse {
  /** The full bearer token. Only ever sent in answer to an explicit reveal. */
  readonly token: string
  /** When the token was generated (epoch ms). */
  readonly issuedAt: number
}

/**
 * One annotation block the host is holding for this page.
 *
 * `text` is the finished composer draft the host already merged against what it
 * believed the draft was — the page does NOT merge again. Two merges would mean
 * two different ideas of the current draft, and the user's own words would be
 * the thing that got lost.
 */
export interface PendingInjection {
  /** Opaque hand-off id, quoted back on acknowledgement. */
  readonly id: string
  /** The session whose composer the block belongs in. */
  readonly sessionId: string
  /** The complete next draft for that composer. */
  readonly text: string
}

/** Response body of a {@link ROUTE_INJECT} GET. */
export interface InjectionPullResponse {
  /** Blocks claimed by this request; empty after a long poll times out. */
  readonly injections: readonly PendingInjection[]
}

/** Request body of a {@link ROUTE_INJECT} POST. */
export interface InjectionAckRequest {
  /** Hand-off ids this page has finished with, in any order. */
  readonly ids: readonly string[]
}

/** Response body of a {@link ROUTE_INJECT} POST. */
export interface InjectionAckResponse {
  /** Always true: acknowledgement is bookkeeping, and a page cannot act on a failure here. */
  readonly ok: true
}

/**
 * Whether a parsed JSON body carries the one field {@link InjectionPullResponse} promises.
 *
 * The page validates rather than asserts, like every other read of this route
 * family: a stale bundled client, an error page or a proxy can all produce a
 * parseable body of the wrong shape, and a wrong shape here would mean applying
 * a draft that no host ever produced.
 *
 * @param value - the parsed body.
 * @returns whether the value is a usable pull response.
 */
export function isInjectionPullResponse(value: unknown): value is InjectionPullResponse {
  if (typeof value !== 'object' || value === null) return false
  const injections = (value as { injections?: unknown }).injections
  if (!Array.isArray(injections)) return false
  return injections.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const record = entry as Record<string, unknown>
    return typeof record['id'] === 'string'
      && typeof record['sessionId'] === 'string'
      && typeof record['text'] === 'string'
  })
}

/** Wire failure codes; the UI maps these to copy rather than showing raw text. */
export type PairingErrorCode =
  | 'forbidden'
  | 'method-error'
  | 'not-found'
  | 'unavailable'
  | 'internal'

/** Failure envelope shared by both routes. */
export interface PairingErrorResponse {
  readonly error: {
    readonly code: PairingErrorCode
    readonly message: string
  }
}

/**
 * Whether a parsed JSON body is a successful status/envelope value.
 *
 * The page treats every response as untrusted input — a stray proxy, an old
 * bundled client against a newer host, or an error page can all produce a
 * parseable body with the wrong shape — so the shape is checked rather than
 * asserted at the call site.
 *
 * @param value - the parsed body.
 * @returns whether the value carries a usable status object.
 */
export function isStatusResponse(value: unknown): value is PairingStatusResponse {
  if (typeof value !== 'object' || value === null) return false
  const status = (value as { status?: unknown }).status
  if (typeof status !== 'object' || status === null) return false
  const record = status as Record<string, unknown>
  return typeof record['connected'] === 'boolean'
    && typeof record['listening'] === 'boolean'
    && typeof record['port'] === 'number'
    && typeof record['tokenMasked'] !== 'undefined'
}

/**
 * Whether a parsed JSON body carries a full token.
 * @param value - the parsed body.
 * @returns whether the value carries a non-empty token string.
 */
export function isTokenResponse(value: unknown): value is PairingTokenResponse {
  if (typeof value !== 'object' || value === null) return false
  const token = (value as { token?: unknown }).token
  return typeof token === 'string' && token !== ''
}
