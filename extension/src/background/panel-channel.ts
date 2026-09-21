/**
 * The service worker's side of the panel's message protocol.
 *
 * The panel is an ordinary extension page: it cannot reach the page it describes
 * and it cannot reach the bridge. Both live behind the worker, so every panel
 * command is a routing problem — "deliver this to the right frame", "hand this
 * batch to the bridge" — rather than a question the worker is expected to
 * understand. This module is that routing, kept out of `index.ts` because the
 * entry point registers platform listeners as a side effect of being imported
 * and therefore cannot be loaded in a test.
 *
 * ## Why every handler answers
 *
 * `chrome.runtime.sendMessage` from an extension page never settles when no
 * listener replies. The panel bounds its own calls at
 * {@link PAGE_REQUEST_TIMEOUT_MS} for exactly that reason, but a timeout is a
 * backstop and not a design: a panel that only ever finds out about a failure by
 * waiting three seconds renders a frozen interface for those three seconds. So
 * every branch below, including every error branch, produces a
 * {@link PanelCommandResult} or a {@link PageResponse} — there is no path that
 * returns nothing.
 *
 * ## Why the routing tables are here and not in the panel
 *
 * The panel names a *tab*, never a frame, because only the worker can enumerate
 * a tab's frames. A pick made inside a cross-origin iframe belongs to the frame
 * that rendered it, so `start-picking`, `stop-picking`, `flash` and `probe` all
 * have to be broadcast to every frame that might own the element and the answers
 * merged. That merge is a fact about the browser's frame tree, which is the
 * worker's to know.
 *
 * @module
 */

import type {
  PanelCommandResult,
  PageResponse,
  PanelRequest,
} from '../panel/messages.ts'
import { isPageResponse } from '../panel/messages.ts'
import type { Annotation, AnnotationBatch } from '../../../src/protocol.ts'
import { isAnnotationBatch, pageKindOf, PROTOCOL_VERSION } from '../../../src/protocol.ts'

// ---------------------------------------------------------------------------
// The wire between worker and content script
// ---------------------------------------------------------------------------

/**
 * How the worker asks a frame one {@link PanelRequest}.
 *
 * A separate envelope from the content-script wire in `wire.ts` on purpose. That
 * one carries `tag`/`kind`/`tabId`/`frame` and is validated field by field before
 * anything in it is used; this one is worker-to-content and carries the panel's
 * own request verbatim. Folding the two together would mean the page-adjacent
 * guard had to accept a shape it was not written for.
 *
 * The request is nested rather than flattened so that adding a panel request
 * later costs the worker nothing: it routes `request` without reading it.
 */
export interface PageRequestMessage {
  readonly tag: 'dsh-annotate'
  readonly kind: 'panel-request'
  /** The panel's question, forwarded unread. */
  readonly request: PanelRequest
  /** Correlates an answer with its request when several frames reply. */
  readonly requestId: string
}

/**
 * How a content script answers a {@link PageRequestMessage}.
 *
 * `requestId` is echoed so a late answer from a frame that was asked a *previous*
 * question is recognisable and dropped, rather than being mistaken for the
 * answer to the current one. Frame broadcasts are concurrent and a navigation
 * can leave a reply in flight.
 */
export interface PageResponseMessage {
  readonly tag: 'dsh-annotate'
  readonly kind: 'panel-response'
  readonly requestId: string
  readonly response: PageResponse
}

/** Whether a value is a usable answer to a {@link PageRequestMessage}. */
export function isPageResponseMessage(value: unknown): value is PageResponseMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  if (message['tag'] !== 'dsh-annotate') return false
  if (message['kind'] !== 'panel-response') return false
  if (typeof message['requestId'] !== 'string') return false
  return isPageResponse(message['response'])
}

/**
 * Build the envelope for one panel request.
 *
 * @param request - the panel's question.
 * @param requestId - the correlation id for its answer.
 * @returns the message to send to a content script.
 */
export function pageRequest(request: PanelRequest, requestId: string): PageRequestMessage {
  return { tag: 'dsh-annotate', kind: 'panel-request', request, requestId }
}

// ---------------------------------------------------------------------------
// Panel messages this module understands
// ---------------------------------------------------------------------------

/**
 * A pick the content script reports, on its way to the panel.
 *
 * `elementId` is the registry id the picker minted *in the frame that owns the
 * element*, and `page` is that frame's own address. Both are frame-local, which
 * is why they travel together: an element inside a cross-origin iframe can only
 * be re-flashed in that same frame, and the panel's later `flash`/`probe` calls
 * are broadcast for the same reason.
 */
export interface PickedMessage {
  readonly type: 'annotate:picked'
  readonly tabId: number
  readonly elementId: string
  readonly facts: unknown
  readonly page: { url: string; title?: string }
}

/** The event the panel renders when picking ends on the page. */
export interface PickEndedEvent {
  readonly type: 'annotate:pick-ended'
  readonly reason: 'escape' | 'disabled' | 'picked' | 'suspended'
}

/** The event the panel renders when the document behind it was replaced. */
export interface PageChangedEvent {
  readonly type: 'annotate:page-changed'
  readonly url: string
}

/** Everything this module relays from the worker to the panel. */
export type PanelEvent = PickedMessage | PickEndedEvent | PageChangedEvent

// ---------------------------------------------------------------------------
// Panel command narrowing
// ---------------------------------------------------------------------------

/**
 * A submission as the panel sends it.
 *
 * The published contract is `{type, batchId, annotations}` and that is all the
 * panel supplies today. Deliberately declared with the extra fields optional:
 * the panel's `AnnotationBatch` also needs a `page` and a `submittedAt`, and
 * neither is derivable in the worker without inventing it — `chrome.tabs.get`
 * returns the tab's *top-level* URL, which is not the address of an element
 * living in an embedded frame, and the whole reason `page` travels with a pick
 * is that only the owning frame knows the real address. So the worker accepts a
 * widened payload the moment the panel offers one, and refuses honestly when it
 * does not, rather than substituting a URL that would be wrong in exactly the
 * case the field exists for.
 */
export interface SubmitCommand {
  readonly type: 'annotate:submit'
  readonly batchId: string
  readonly annotations: readonly Annotation[]
  /** The panel's page context, when it sends one. Required to deliver a batch. */
  readonly page?: unknown
  /** When the user submitted. Preferred over the worker's own arrival time. */
  readonly submittedAt?: number
  /** The protocol version the panel built the batch under. */
  readonly version?: unknown
  /** The tab the batch describes, when the panel sends one. */
  readonly tabId?: number
}

/** The commands the worker handles. Anything else belongs to another listener. */
export type PanelCommand =
  | { type: 'annotate:page'; tabId: number; request: PanelRequest }
  | SubmitCommand

/**
 * Narrow a message from the panel.
 *
 * Only the two command types are recognised. Everything else — including the
 * panel's own broadcasts, which this worker never sends — returns `undefined`
 * so the listener answers nothing and another listener's channel stays open.
 *
 * @param value - the message as received.
 * @returns the narrowed command, or `undefined`.
 */
export function parsePanelCommand(value: unknown): PanelCommand | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const message = value as Record<string, unknown>

  if (message['type'] === 'annotate:page') {
    const tabId = message['tabId']
    if (typeof tabId !== 'number' || !Number.isInteger(tabId)) return undefined
    const request = parsePanelRequest(message['request'])
    if (request === undefined) return undefined
    return { type: 'annotate:page', tabId, request }
  }

  if (message['type'] === 'annotate:submit') {
    const batchId = message['batchId']
    if (typeof batchId !== 'string' || batchId === '') return undefined
    const annotations = message['annotations']
    if (!Array.isArray(annotations)) return undefined
    const command: SubmitCommand = {
      type: 'annotate:submit',
      batchId,
      annotations: annotations as readonly Annotation[],
    }
    // Widening is read here rather than validated: an unusable `page` fails
    // `isAnnotationBatch` downstream, which is the single place that decides
    // what a deliverable batch is.
    const widened: {
      type: 'annotate:submit'
      batchId: string
      annotations: readonly Annotation[]
      page?: unknown
      submittedAt?: number
      version?: unknown
      tabId?: number
    } = { ...command }

    const page = message['page']
    if (page !== undefined) widened.page = page
    const tabId = message['tabId']
    if (typeof tabId === 'number' && Number.isInteger(tabId)) widened.tabId = tabId
    // `submittedAt` is read only when it is a usable time. A non-numeric value
    // left in place would fail the batch guard downstream and turn a submission
    // that is otherwise deliverable into an `invalid` one; absent, the worker
    // stamps its own arrival time instead.
    const submittedAt = message['submittedAt']
    if (typeof submittedAt === 'number' && Number.isFinite(submittedAt)) widened.submittedAt = submittedAt
    const version = message['version']
    if (version !== undefined) widened.version = version
    return widened
  }

  return undefined
}

/**
 * Narrow one {@link PanelRequest}.
 *
 * The panel's own vocabulary is restated here rather than imported as a runtime
 * value because `messages.ts` exports only types for the request union. Keeping
 * the guard local means a malformed request is dropped in the worker instead of
 * being forwarded to every frame in the tab.
 *
 * @param value - the request as received.
 * @returns the narrowed request, or `undefined`.
 */
export function parsePanelRequest(value: unknown): PanelRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const request = value as Record<string, unknown>
  switch (request['type']) {
    case 'annotate:describe-page':
    case 'annotate:start-picking':
    case 'annotate:stop-picking':
      return { type: request['type'] }
    case 'annotate:flash': {
      const elementId = request['elementId']
      if (typeof elementId !== 'string') return undefined
      return { type: 'annotate:flash', elementId }
    }
    case 'annotate:probe': {
      const elementIds = request['elementIds']
      if (!Array.isArray(elementIds)) return undefined
      if (!elementIds.every((id) => typeof id === 'string')) return undefined
      return { type: 'annotate:probe', elementIds: elementIds as string[] }
    }
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * The worker's answer when a tab has no content script to ask.
 *
 * Distinct from a `rejected` result: nothing refused, nothing was listening. The
 * panel renders this as "that tab is not reachable", which is a different
 * instruction to the user than "the submission failed".
 *
 * @param detail - a short, secret-free explanation.
 * @returns the result.
 */
export function noReceiver(detail: string): PanelCommandResult {
  return { ok: false, kind: 'no-receiver', detail }
}

/**
 * The worker's answer when a command cannot be carried out.
 *
 * @param reason - why, in the panel's own vocabulary.
 * @param detail - a short, secret-free explanation.
 * @returns the result.
 */
export function rejected(
  reason: 'offline' | 'forbidden' | 'invalid' | 'failed',
  detail: string,
): PanelCommandResult {
  return { ok: false, kind: 'rejected', reason, detail }
}

/**
 * Wrap a page answer for the panel.
 *
 * The panel accepts either the bare {@link PageResponse} or this wrapper
 * (`unwrapPageResponse` at `panel/page-source.ts`). The wrapper is chosen
 * because it is the shape the panel's own contract declares for a command
 * result, and because it leaves room for the worker to report a routing failure
 * — `no-receiver` — that has no representation inside `PageResponse` at all.
 *
 * @param value - the merged answer.
 * @returns the command result.
 */
export function pageResult(value: PageResponse): PanelCommandResult {
  return { ok: true, kind: 'page', value }
}

// ---------------------------------------------------------------------------
// Answer merging
// ---------------------------------------------------------------------------

/**
 * Combine the answers of every frame a request was broadcast to.
 *
 * A request is broadcast because only the frame that owns an element can answer
 * for it, and the worker does not know which frame that is. The merge rules are
 * per-request rather than generic, because the requests genuinely differ:
 *
 * - `describe-page` wants the top document, so the answer claiming `frameKind:
 *   'top'` wins and a subframe's is discarded. Reporting an iframe's URL as "the
 *   page" would mislabel everything the user then does.
 * - `probe` asks about a set of ids that may be spread across frames, so the
 *   alive sets are unioned. A frame that did not recognise an id reports it
 *   absent, which is exactly right: the id belongs to whoever minted it.
 * - `flash` is a visual side effect, so it is "found" when any frame found it.
 * - `start-picking`/`stop-picking` resolve once, so the first usable answer
 *   stands and later ones do not overwrite it.
 *
 * @param request - the request the answers belong to.
 * @param answers - every usable frame answer, in the order they arrived.
 * @returns the merged answer, or `undefined` when no frame answered.
 */
export function mergeFrameAnswers(
  request: PanelRequest,
  answers: readonly PageResponse[],
): PageResponse | undefined {
  if (answers.length === 0) return undefined

  switch (request.type) {
    case 'annotate:describe-page': {
      for (const answer of answers) {
        if (answer.ok && answer.kind === 'page' && answer.page.frameKind === 'top') return answer
      }
      // No frame claimed to be the top document. That happens on a page whose
      // top frame has no content script (a tab that predates the extension, or a
      // frame the browser refused); a subframe's description is still worth more
      // to the user than nothing, and it is labelled as a subframe.
      return answers.find((answer) => answer.ok && answer.kind === 'page')
    }
    case 'annotate:probe': {
      const alive = new Set<string>()
      let sawProbe = false
      for (const answer of answers) {
        if (!answer.ok || answer.kind !== 'probe') continue
        sawProbe = true
        for (const id of answer.alive) alive.add(id)
      }
      return sawProbe ? { ok: true, kind: 'probe', alive: [...alive] } : undefined
    }
    case 'annotate:flash': {
      for (const answer of answers) {
        if (answer.ok && answer.kind === 'flashed' && answer.found) return answer
      }
      const flashed = answers.find((answer) => answer.ok && answer.kind === 'flashed')
      return flashed
    }
    case 'annotate:start-picking':
    case 'annotate:stop-picking': {
      const picking = answers.find((answer) => answer.ok && answer.kind === 'picking')
      return picking
    }
  }
}

/**
 * The answer to give when no frame produced anything usable.
 *
 * `unsupported` rather than a thrown error: the panel's `startPicking` reads a
 * non-`picking` answer as "the page could not be reached", so this is the answer
 * that produces the right UI without the panel having to special-case it.
 *
 * @param detail - what went wrong, for the panel's own diagnostics.
 * @returns the fallback answer.
 */
export function unsupportedAnswer(detail: string): PageResponse {
  return { ok: false, kind: 'unsupported', detail }
}

// ---------------------------------------------------------------------------
// Batch assembly
// ---------------------------------------------------------------------------

/**
 * Build the deliverable batch for a panel submission.
 *
 * Returns `undefined` rather than a repaired batch when the panel's payload does
 * not form one. The alternative — filling `page` from `chrome.tabs.get` — is
 * rejected on purpose: that URL is the tab's *top-level* address, and an element
 * picked inside an embedded frame lives at a different one. A batch stamped with
 * the wrong address is worse than a refused batch, because the reader downstream
 * cannot tell that it is wrong.
 *
 * @param command - the narrowed submission.
 * @param now - current time, for `submittedAt`.
 * @returns the batch, or `undefined` when the payload is incomplete.
 */
export function buildSubmittedBatch(command: SubmitCommand, now: number): AnnotationBatch | undefined {
  const candidate = {
    // The panel's own version when it declared one, otherwise the version this
    // build speaks: a payload without one was built by a panel from this same
    // release, so the running protocol version is the honest answer rather than a
    // guess.
    version: command.version ?? PROTOCOL_VERSION,
    batchId: command.batchId,
    page: command.page,
    annotations: command.annotations,
    // See above: the panel's timestamp is a fact about the user's action, and the
    // worker's clock is only a fallback for a payload that carries none.
    submittedAt: command.submittedAt ?? now,
  }
  return isAnnotationBatch(candidate) ? candidate : undefined
}

/**
 * Decide why a submission the worker cannot deliver should be refused.
 *
 * `invalid` is the honest reason for a payload that does not form a batch, and
 * it is the one the panel renders without offering a retry — a malformed payload
 * is not fixed by sending it again.
 *
 * @param command - the narrowed submission.
 * @returns the result to send back to the panel.
 */
export function describeSubmitGap(command: SubmitCommand): PanelCommandResult {
  if (command.page === undefined) {
    return rejected(
      'invalid',
      'This submission carried no page context, so its address is unknown and the batch cannot be built.',
    )
  }
  if (buildSubmittedBatch(command, 0) === undefined) {
    return rejected('invalid', 'This submission is not a well-formed batch.')
  }
  return rejected('failed', 'The batch could not be prepared for the bridge.')
}

// ---------------------------------------------------------------------------
// Relay guards for content-script broadcasts
// ---------------------------------------------------------------------------

/**
 * Narrow a pick reported by a content script.
 *
 * The facts are passed through as `unknown` rather than validated here: the
 * panel already shape-checks them before they become a row, and a second,
 * weaker guard in the worker would only be a place for the two to disagree.
 * What the worker does check is everything the *relay* needs — the tab to route
 * to, the id to address the element by, and the address the pick was taken on.
 *
 * @param value - the message as received.
 * @returns the pick to relay, or `undefined`.
 */
export function parsePickedMessage(value: unknown): PickedMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const message = value as Record<string, unknown>
  if (message['kind'] !== 'picked') return undefined
  if (message['tag'] !== 'dsh-annotate') return undefined

  const elementId = message['elementId']
  if (typeof elementId !== 'string' || elementId === '') return undefined
  const facts = message['facts']
  if (typeof facts !== 'object' || facts === null) return undefined

  const page = message['page']
  if (typeof page !== 'object' || page === null) return undefined
  const pageRecord = page as Record<string, unknown>
  const url = pageRecord['url']
  if (typeof url !== 'string' || url === '') return undefined

  const pick: PickedMessage = {
    type: 'annotate:picked',
    // Filled in by the caller from `sender.tab.id`: the browser is the only
    // trustworthy narrator of where a message came from, so a tab id inside the
    // payload is never used for routing.
    tabId: -1,
    elementId,
    facts,
    page: { url },
  }
  const title = pageRecord['title']
  if (typeof title === 'string' && title !== '') pick.page.title = title
  return pick
}

/**
 * Map a content-script picking exit reason onto the panel's vocabulary.
 *
 * The content script reports the picker's own reasons; the panel listens for
 * four specific ones. An unrecognised value is mapped to `disabled` rather than
 * passed through, because a reason the panel does not know would fail
 * `isContentEvent` and the panel would keep showing a mode that has ended —
 * silently, which is the failure this relay exists to prevent.
 *
 * @param reason - the picker's own reason string.
 * @returns the reason to broadcast.
 */
export function pickEndedReason(reason: string): 'escape' | 'disabled' | 'picked' | 'suspended' {
  switch (reason) {
    case 'escape':
    case 'disabled':
    case 'picked':
    case 'suspended':
      return reason
    default:
      return 'disabled'
  }
}

/**
 * Whether an address is one the panel should be told about.
 *
 * A navigation to a browser-internal page leaves the panel describing something
 * it can no longer annotate, and the URL is the only thing it can act on.
 *
 * @param url - the new document's address.
 * @returns whether a usable address was supplied.
 */
export function isReportableUrl(url: unknown): url is string {
  return typeof url === 'string' && url !== '' && pageKindOf(url) !== null
}
