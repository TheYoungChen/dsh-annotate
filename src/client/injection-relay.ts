/**
 * The injection relay: the host end of the crossing between a batch arriving in
 * Node and a composer living in the page.
 *
 * ## What this is
 *
 * A tiny keyed mailbox. {@link createInjectionRelay} returns:
 *
 * - a **host port** that satisfies the host's composer seam by *parking* the
 *   rendered text, and
 * - a **relay** that this plugin's own route handler drains when the page asks.
 *
 * The port never writes a draft and never reports success: `isAvailable` is
 * always false, because the host genuinely cannot see whether a composer is
 * currently reachable. The host therefore renders the block, parks it, logs it,
 * and answers the extension `ok`. The page, when it is open, collects the entry,
 * writes it into the composer, and acknowledges.
 *
 * ## Why success is the right answer even when the page is closed
 *
 * The alternative — rejecting the batch at the bridge — is actively worse. The
 * extension treats a rejected acknowledgement as "the bridge did not take this",
 * re-offers the same batch with backoff until its attempt budget runs out, and
 * then shows the user a failure and drops their annotations. A batch that waits
 * in this mailbox has exactly the same content and loses nothing, and it stops
 * waiting the moment the user opens the GUI.
 *
 * ## Why the mailbox is bounded
 *
 * `takePending` *removes* the entry it returns, so nothing can be replayed twice
 * by a reconnecting page. A page that fetches and then dies before acknowledging
 * does lose that one block, and that is the deliberate trade: the alternative is
 * a redelivery loop that would append the same annotations to the composer over
 * and over. Entries are additionally capped and expired, so a page that never
 * opens cannot turn this plugin into an unbounded buffer of page content.
 *
 * @module
 */

import type { ComposerPort } from '../inject.ts'
import type { PendingInjection } from './pairing-contract.ts'

/**
 * How many undelivered injections are kept.
 *
 * Small on purpose: this is a hand-off buffer for a page that is usually already
 * open, not a durable queue. The oldest entry is evicted first, so a page that
 * has been closed for a long time cannot push out the batch the user just made.
 */
export const MAX_PENDING_INJECTIONS = 8

/**
 * How long an undelivered injection is kept, in milliseconds.
 *
 * Five minutes is long enough to cover "the user annotates, then switches to the
 * DSH window", and short enough that a block of page facts collected an hour ago
 * is not silently appended into a conversation that has moved on.
 */
export const INJECTION_TTL_MS = 5 * 60 * 1000

/** The host end of the relay. */
export interface InjectionRelay {
  /**
   * The composer seam the host half installs.
   *
   * Returned as a {@link ComposerPort} rather than as a bespoke type so the host
   * half cannot grow a capability the seam does not declare — in particular it
   * cannot send.
   */
  readonly port: ComposerPort
  /**
   * Claim every injection waiting for the page, oldest first.
   *
   * Claiming removes: an entry is handed out exactly once. The caller is
   * expected to apply the writes and then acknowledge through
   * {@link InjectionRelay.acknowledge}, which is what the host logs.
   *
   * @returns the pending entries, newest sweep applied.
   */
  takePending(): PendingInjection[]
  /**
   * Record that the page applied injections, or refused them.
   *
   * @param ids - the batch ids the page reported on.
   * @returns a one-line human summary for the host log.
   */
  acknowledge(ids: readonly string[]): string
}

/** One parked injection. */
interface Parked extends PendingInjection {
  /** When it was parked, epoch ms, for the TTL sweep. */
  readonly parkedAt: number
}

/** What the relay needs from the plugin to report outcomes. */
export interface InjectionRelayOptions {
  /**
   * Log one host-side line.
   * @param message - the already-formatted line.
   */
  log: (message: string) => void
  /**
   * Current time in epoch milliseconds. Injectable so the expiry sweep is
   * testable without waiting.
   * @returns the current time.
   */
  now?: () => number
}

/**
 * Build the relay and the port that feeds it.
 *
 * The port's `setDraft` is where a rendered block is parked. It is called only
 * after the host has already read the draft through {@link ComposerPort.readDraft}
 * and merged — see `injectBatch` — and it is called only once per batch, because
 * the host's injection path returns before the page is consulted at all.
 *
 * @param options - log sink and clock.
 * @returns the relay.
 */
export function createInjectionRelay(options: InjectionRelayOptions): InjectionRelay {
  const now = options.now ?? (() => Date.now())
  const pending = new Map<string, Parked>()
  /** Batch ids the page has reported on, so an ack for an unknown id is not a lie. */
  const settled = new Set<string>()
  /**
   * Monotonic counter behind the hand-off ids.
   *
   * It must be a counter and not a derived value: the mailbox is a Map, so two
   * entries that collide on `id` are not two entries — the second silently
   * replaces the first, and the user loses an annotation with no log line to
   * explain it. A clock is not enough on its own (several batches can be parked
   * in the same millisecond) and `pending.size` is not enough either (it stops
   * changing once the mailbox is full and starts evicting).
   */
  let seq = 0

  /** Drop entries that have outlived {@link INJECTION_TTL_MS}. */
  const sweep = (at: number): void => {
    for (const [id, entry] of pending) {
      if (at - entry.parkedAt <= INJECTION_TTL_MS) continue
      pending.delete(id)
      options.log(`[dsh-annotate] dropping undelivered injection ${id}: no composer collected it within ${INJECTION_TTL_MS}ms`)
    }
  }

  const port: ComposerPort = {
    /**
     * Always false, and deliberately so.
     *
     * This method is the host asking "can you write a draft into that session's
     * composer right now?" — and the host cannot know. Answering true would make
     * the host report a successful delivery it never observed; answering false is
     * what routes the block into the mailbox instead. That asymmetry is the whole
     * design: a false here means "park it", not "give up on it".
     *
     * @param sessionId - unused; reachability is a property of the page, not of a session.
     * @returns false, always.
     */
    isAvailable(sessionId: string): boolean {
      void sessionId
      return false
    },

    /**
     * Report no readable draft.
     *
     * Also honest rather than merely conservative: the host uses this value to
     * preserve whatever the user is already typing, and this process has no view
     * of that text. Returning `''` would make the host merge against a draft it
     * invented, which is exactly the failure mode the seam exists to prevent.
     *
     * @param sessionId - unused.
     * @returns undefined, always.
     */
    readDraft(sessionId: string): string | undefined {
      void sessionId
      return undefined
    },

    /**
     * Park one rendered block for the page to collect.
     *
     * @param sessionId - the session the block is addressed to.
     * @param text - the complete draft text the host rendered and merged.
     */
    setDraft(sessionId: string, text: string): void {
      const at = now()
      sweep(at)
      // A batch id would be the natural key, but the seam's contract is
      // (session, text) and nothing else — so the id is derived only from what
      // the seam hands over. Nothing a page writes can influence it, and the
      // most a page could do with the key is disturb its own mailbox.
      seq += 1
      const id = `${sessionId}:${String(at)}:${String(seq)}`
      // Room is made BEFORE the insert, so the mailbox never exceeds the cap by
      // one: evicting after the put would leave MAX+1 entries for the duration
      // of the call, which is exactly the unbounded-buffer bug this guards.
      while (pending.size >= MAX_PENDING_INJECTIONS) {
        const oldest = pending.keys().next()
        if (oldest.done === true) break
        pending.delete(oldest.value)
        options.log(`[dsh-annotate] dropping undelivered injection ${oldest.value}: the mailbox is full`)
      }
      pending.set(id, { id, sessionId, text, parkedAt: at })
      settled.delete(id)
      options.log(`[dsh-annotate] parked an injection for session ${sessionId} (${text.length} characters) awaiting the browser client`)
    },

    // NOTE: there is deliberately no fourth member here. The seam declares three,
    // and the whole point of routing the host through this seam is that the host
    // has no verb that could post a message on the user's behalf.
  }

  return {
    port,

    takePending(): PendingInjection[] {
      const at = now()
      sweep(at)
      const entries = [...pending.values()].sort((left, right) => left.parkedAt - right.parkedAt)
      const out: PendingInjection[] = []
      for (const entry of entries) {
        pending.delete(entry.id)
        out.push({ id: entry.id, sessionId: entry.sessionId, text: entry.text })
      }
      return out
    },

    acknowledge(ids: readonly string[]): string {
      let known = 0
      for (const id of ids) {
        if (settled.has(id)) continue
        settled.add(id)
        known += 1
      }
      // The set is capped so a long-lived host cannot accumulate one string per
      // injection ever seen; acks only need to be recognised for about as long as
      // a page could plausibly be retrying one.
      if (settled.size > MAX_PENDING_INJECTIONS * 4) {
        const drop = settled.size - MAX_PENDING_INJECTIONS * 4
        let index = 0
        for (const id of settled) {
          settled.delete(id)
          index += 1
          if (index >= drop) break
        }
      }
      return `${known} of ${ids.length} acknowledged (unknown or already-settled ids are ignored)`
    },
  }
}
