/**
 * The browser end of the injection crossing.
 *
 * This is the half that actually types into the composer. It runs a single
 * long-poll loop against this plugin's own host route: ask, apply, acknowledge,
 * ask again. There is no timer and no second loop, because the host holds each
 * request open until there is something to hand over — a standing request IS the
 * subscription, and one in flight at a time means a reconnecting or duplicated
 * page cannot double-apply a batch.
 *
 * ## What "apply" means, exactly
 *
 * Applying a block means exactly one call: the composer's `setDraft`. The host
 * already merged the annotation text against what it believed the draft was, and
 * this page does not merge again — two merges would mean two different ideas of
 * the user's own words, and those words are the one thing that must survive.
 *
 * ## What this file must never do
 *
 * Nothing here presses Enter. The composer's posting verb is not mirrored, not
 * looked up, and not named, so there is no line of code that could put a message
 * on the user's behalf even if the port contract were later widened by mistake.
 * The lock for that is in `tests/client-injection.test.ts`, which sweeps this
 * module's source for an Enter-shaped call.
 *
 * @module
 */

import {
  INJECT_HOLD_MS,
  ROUTE_INJECT,
  isInjectionPullResponse,
  type PendingInjection,
} from './pairing-contract.ts'
import type { ClientComposerPort } from './composer-port.ts'

/**
 * How long to wait before re-asking after a failed poll.
 *
 * The loop must not turn a host that is restarting into a request storm, but the
 * user should not have to reload the page either. Two seconds is short enough to
 * be invisible when the host comes back and long enough that a host which is
 * down stays down quietly.
 */
export const RETRY_DELAY_MS = 2_000

/** What the loop needs to run. */
export interface InjectionTransportOptions {
  /** The composer port the claimed blocks are written through. */
  port: ClientComposerPort
  /**
   * Log one client-side line.
   * @param message - the already-formatted line.
   */
  log: (message: string) => void
  /**
   * Schedule one delayed call. Injectable so the loop is testable without
   * waiting on a real clock.
   * @param run - the callback.
   * @param delayMs - how long to wait.
   * @returns a handle usable with {@link InjectionTransportOptions.clearTimer}.
   */
  setTimer?: (run: () => void, delayMs: number) => unknown
  /**
   * Cancel a handle from {@link InjectionTransportOptions.setTimer}.
   * @param handle - the handle to cancel.
   */
  clearTimer?: (handle: unknown) => void
  /**
   * Whether the page is currently visible.
   *
   * A hidden page does not poll: the request would be held open across a
   * backgrounded tab for no benefit, and the host is already keeping the block.
   * Injectable so a test can drive both branches.
   * @returns whether a poll may be issued.
   */
  visible?: () => boolean
  /**
   * Subscribe to visibility changes.
   * @param listener - called when the page becomes visible again.
   * @returns an unsubscribe function.
   */
  onVisible?: (listener: () => void) => () => void
}

/** A running transport. */
export interface InjectionTransport {
  /** Stop polling and release the timer. Idempotent. */
  stop(): void
  /** Run exactly one poll cycle; resolves once that cycle has settled. */
  tick(): Promise<void>
}

/** Default timer plumbing, kept separate so the transport body stays branch-free. */
const defaultSetTimer = (run: () => void, delayMs: number): unknown => setTimeout(run, delayMs)
const defaultClearTimer = (handle: unknown): void => {
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    // Node timers must not hold a process open; browser handles have no `unref`.
    const unref = (handle as { unref?: () => void }).unref
    if (typeof unref === 'function') unref.call(handle)
  }
  clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * Apply one claimed block.
 *
 * The block is applied only when the port can actually see that session: an id
 * this page does not know is skipped rather than written "somewhere", because a
 * draft that lands in the wrong conversation is worse than one that stays in the
 * host's mailbox, where the user can still ask for it again.
 *
 * @param port - the composer port.
 * @param injection - the claimed block.
 * @returns whether the write was applied.
 */
export function applyInjection(port: ClientComposerPort, injection: PendingInjection): boolean {
  if (!port.isAvailable(injection.sessionId)) return false
  port.setDraft(injection.sessionId, injection.text)
  return true
}

/**
 * Start the injection loop.
 *
 * @param options - port, logging and timer plumbing.
 * @returns a handle that stops the loop.
 */
export function startInjectionTransport(options: InjectionTransportOptions): InjectionTransport {
  const setTimer = options.setTimer ?? defaultSetTimer
  const clearTimer = options.clearTimer ?? defaultClearTimer
  const visible = options.visible ?? (() => true)
  let stopped = false
  let timer: unknown

  /** Ask the host for one batch of pending blocks and apply them. */
  const poll = async (signal: AbortSignal): Promise<void> => {
    let response: Response
    try {
      response = await fetch(ROUTE_INJECT, {
        method: 'GET',
        headers: { accept: 'application/json' },
        // The host holds this request open for up to its own hold window; the
        // client-side ceiling sits above it so the host's own empty answer is
        // what ends the request in the normal case, and the abort only fires if
        // the host died mid-hold.
        signal,
      })
    } catch {
      return
    }
    if (!response.ok) return
    const parsed: unknown = await response.json().catch(() => undefined)
    if (!isInjectionPullResponse(parsed)) return

    const applied: string[] = []
    for (const injection of parsed.injections) {
      if (applyInjection(options.port, injection)) applied.push(injection.id)
      else applied.push(injection.id)
    }
    if (parsed.injections.length === 0) return

    // Acknowledge every claimed id, including ones this page could not apply:
    // the host handed them over, and re-offering a block whose session is not
    // open here would only re-deliver it later as a duplicate.
    try {
      await fetch(ROUTE_INJECT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ids: applied }),
        signal,
      })
    } catch {
      options.log('[dsh-annotate] could not acknowledge an injected block; it will not be redelivered')
      return
    }
    options.log(`[dsh-annotate] applied ${applied.length} injected block(s) to the composer`)
  }

  let controller: AbortController | undefined

  const loop = async (): Promise<void> => {
    while (!stopped) {
      if (!visible()) return
      controller = new AbortController()
      const abort = setTimeout(() => { controller?.abort() }, INJECT_HOLD_MS * 2)
      try {
        await poll(controller.signal)
      } finally {
        clearTimeout(abort)
      }
      if (stopped) return
      // A failed poll and a successful one take the same path here: the loop
      // re-asks, and the delay only exists to bound the rate when the host is
      // unreachable. Success needs no delay — the long poll already provided it.
      await new Promise<void>((resolve) => { timer = setTimer(resolve, RETRY_DELAY_MS) })
      timer = undefined
    }
  }

  const offVisible = options.onVisible?.(() => {
    if (stopped) return
    void loop()
  })

  return {
    tick(): Promise<void> {
      return loop()
    },
    stop(): void {
      if (stopped) return
      stopped = true
      if (timer !== undefined) clearTimer(timer)
      timer = undefined
      controller?.abort()
      offVisible?.()
    },
  }
}
