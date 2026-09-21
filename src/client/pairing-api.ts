/**
 * Browser-side client for this plugin's pairing routes.
 *
 * Deliberately a tiny hand-written fetch rather than a framework facility:
 * the routes are this plugin's private transport, and the reveal call is the
 * one request in the whole plugin that must be issued by an explicit user
 * gesture rather than by a subscription.
 *
 * Every response is treated as untrusted input — the shape guards live in the
 * contract module and are applied here, so a stale bundled client talking to
 * a newer host degrades to a visible error instead of a broken render.
 *
 * @module
 */

import {
  ROUTE_STATUS,
  ROUTE_TOKEN,
  isStatusResponse,
  isTokenResponse,
  type PairingStatus,
  type PairingTokenResponse,
} from './pairing-contract.ts'

/**
 * A pairing call that failed.
 *
 * Carries a code rather than a user-facing message: the copy belongs to the
 * locale dictionary, and a host-side string would arrive untranslated.
 */
export class PairingRequestError extends Error {
  /** Stable machine-readable reason. */
  readonly code: 'network' | 'forbidden' | 'unavailable' | 'malformed'

  /**
   * @param code - stable reason for the failure.
   */
  constructor(code: PairingRequestError['code']) {
    super(code)
    this.name = 'PairingRequestError'
    this.code = code
  }
}

/** Map an HTTP status onto the failure code the UI renders. */
function codeForStatus(status: number): PairingRequestError['code'] {
  if (status === 403) return 'forbidden'
  if (status === 503) return 'unavailable'
  return 'network'
}

/**
 * Build the request init for one pairing read.
 *
 * `signal` is spread in rather than assigned: under `exactOptionalPropertyTypes`
 * an explicit `undefined` is not a valid `AbortSignal | null`, and the caller
 * genuinely may have no signal to pass.
 *
 * @param signal - caller-owned cancellation, when one exists.
 * @returns the fetch init for a JSON GET.
 */
function init(signal?: AbortSignal): RequestInit {
  return {
    method: 'GET',
    headers: { accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  }
}

/**
 * Fetch the connection facts, with the token already masked by the host.
 * @param signal - caller-owned cancellation.
 * @returns the status the section renders.
 * @throws {PairingRequestError} when the route is unreachable or answers an unexpected shape.
 */
export async function fetchPairingStatus(signal?: AbortSignal): Promise<PairingStatus> {
  let response: Response
  try {
    response = await fetch(ROUTE_STATUS, init(signal))
  } catch (error: unknown) {
    // An aborted signal is the caller's own cancellation, not a failure to
    // report; rethrowing unchanged lets the caller tell the two apart.
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new PairingRequestError('network')
  }
  if (!response.ok) throw new PairingRequestError(codeForStatus(response.status))
  const parsed: unknown = await response.json().catch(() => undefined)
  if (!isStatusResponse(parsed)) throw new PairingRequestError('malformed')
  return parsed.status
}

/**
 * Fetch the bearer token in full.
 *
 * Only ever called from the reveal control. The caller is responsible for not
 * persisting the result: it belongs in transient component state, never in a
 * store that survives remounts or in `sessionStorage`.
 *
 * @param signal - caller-owned cancellation.
 * @returns the token and its issue time.
 * @throws {PairingRequestError} when the route refuses or answers an unexpected shape.
 */
export async function fetchPairingToken(signal?: AbortSignal): Promise<PairingTokenResponse> {
  let response: Response
  try {
    response = await fetch(ROUTE_TOKEN, init(signal))
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new PairingRequestError('network')
  }
  if (!response.ok) throw new PairingRequestError(codeForStatus(response.status))
  const parsed: unknown = await response.json().catch(() => undefined)
  if (!isTokenResponse(parsed)) throw new PairingRequestError('malformed')
  return parsed
}
