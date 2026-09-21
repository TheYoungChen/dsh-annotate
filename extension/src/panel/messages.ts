/**
 * The message contract between the annotation panel, the content script and the
 * background service worker.
 *
 * Three facts about extension messaging shape everything below.
 *
 * 1. **A side panel is an ordinary extension page.** It has its own document and
 *    its own globals; it cannot reach into the page it is describing, not even
 *    to ask whether an element still exists. Every question about the page is a
 *    question asked of the content script, and every answer travels as a
 *    structured-cloneable value.
 *
 * 2. **Structured clone is the only serialisation.** Functions, DOM nodes,
 *    `undefined` as a property value, class instances and cyclic references
 *    either throw or silently become something else. A DOM element could not be
 *    sent even if the panel had one, so an element is addressed by the opaque
 *    registry id the picker handed out.
 *
 * 3. **Addressing a frame is the background's job.** A page's elements live in
 *    whichever frame they were rendered in, and only the service worker can
 *    enumerate a tab's frames or know which one a pick came from. The panel
 *    therefore names a *tab*, never a frame, and leaves routing to the worker.
 *
 * The two directions are declared as separate unions so each side can narrow on
 * its own without knowing the other's full vocabulary.
 *
 * @module
 */

import type { Annotation, PageContext } from '../../../src/protocol.ts'

// ---------------------------------------------------------------------------
// Panel -> content script
// ---------------------------------------------------------------------------

/**
 * A question the panel asks the page.
 *
 * Every one of these is a *request*, not a command: the panel holds no belief
 * about the page between calls, because the page can change under it at any
 * moment (a route change, a re-render, a reload) and a cached belief would be a
 * lie the UI then presents as fact.
 */
export type PanelRequest =
  /**
   * Report what the top-level document is.
   *
   * Asked on every navigation so the panel can tell the user which page the list
   * describes, and so a site the online-access gate forbids is refused before
   * the user spends time annotating it.
   */
  | { type: 'annotate:describe-page' }
  /** Arm picking mode. Resolves once the mode is live on the frame. */
  | { type: 'annotate:start-picking' }
  /** Leave picking mode. Resolves whether or not a session was running. */
  | { type: 'annotate:stop-picking' }
  /**
   * Draw the momentary marker over one already-picked element.
   *
   * Sent on list-row hover. A marker needs no reply: the panel has nothing to do
   * with the answer, and waiting for one would delay the hover feedback.
   */
  | { type: 'annotate:flash'; elementId: string }
  /** Ask whether a registry id still resolves to a connected element. */
  | { type: 'annotate:probe'; elementIds: string[] }

// ---------------------------------------------------------------------------
// Content script -> panel
// ---------------------------------------------------------------------------

/** What the page says about itself. */
export interface PageDescription {
  url: string
  title: string
  /** `document` when the frame holds a document, `unavailable` when it cannot say. */
  frameKind: 'top' | 'sub'
}

/** A message the content script pushes without being asked. */
export type ContentEvent =
  /**
   * Picking ended on the page.
   *
   * The user can leave the mode from either side — Esc on the page, the panel's
   * own stop button — so the panel must hear about an exit it did not cause, or
   * it would keep showing a mode that is no longer running.
   */
  | { type: 'annotate:pick-ended'; reason: 'escape' | 'disabled' | 'picked' | 'suspended' }
  /** The document was replaced (navigation, reload) and every id is now stale. */
  | { type: 'annotate:page-changed'; url: string }

// ---------------------------------------------------------------------------
// Panel -> background
// ---------------------------------------------------------------------------

/**
 * What the panel asks the service worker to do.
 *
 * The panel never talks to the page directly for these: the worker owns frame
 * routing and its own connection to the local bridge, and duplicating either in
 * a UI page would give the extension two sources of truth about a tab.
 */
export type PanelCommand =
  /**
   * Run one {@link PanelRequest} against a tab and return its answer verbatim.
   *
   * One relay for every page question rather than one message type per question:
   * the worker does not need to understand what is being asked, only where to
   * deliver it, so adding a question later costs the worker nothing.
   */
  | { type: 'annotate:page'; tabId: number; request: PanelRequest }
  /**
   * Hand a finished batch to the bridge.
   *
   * The worker answers with `accepted` once the bridge acknowledged the batch,
   * and `rejected` with a reason the panel can show. A batch is only ever
   * outstanding once: a submission the user did not see acknowledged is offered
   * again as a retry of the same `batchId`, so the bridge can recognise the
   * duplicate instead of recording the annotations twice.
   *
   * `page` travels with the submission because the worker cannot derive it. A
   * batch describes the document an element was picked in, and an element inside
   * a cross-origin iframe lives at an address the tab's own URL is not — the
   * worker can only see the tab's top-level URL, which would be wrong in exactly
   * the case this field exists for. The panel already holds the value: it is the
   * page identity captured at pick time and persisted so a retry keeps it.
   *
   * `submittedAt` is likewise the panel's to supply, for the same reason: it is a
   * fact about when the user sent this, not about when a worker happened to
   * receive it. Omitting it lets the worker stamp its own arrival time, which is
   * a strictly worse approximation and is only a fallback.
   */
  | {
      type: 'annotate:submit'
      batchId: string
      annotations: Annotation[]
      /** Where the batch was collected. Required for the worker to deliver it. */
      page?: PageContext
      /** When the user submitted, as an epoch millisecond value. */
      submittedAt?: number
      /**
       * The tab the batch describes.
       *
       * Optional because the panel is bound to one tab and the worker can
       * resolve the focused one; supplying it removes that guess.
       */
      tabId?: number
    }

/** Why a submission did not reach the conversation. */
export type SubmitFailure = 'offline' | 'forbidden' | 'invalid' | 'failed'

/** What the worker answers for {@link PanelCommand}. */
export type PanelCommandResult =
  /** The page answered. `value` is the response to the relayed request. */
  | { ok: true; kind: 'page'; value: PageResponse }
  /** The batch reached the bridge. */
  | { ok: true; kind: 'submitted' }
  /** Nothing was listening on the tab. */
  | { ok: false; kind: 'no-receiver'; detail: string }
  /** The worker or the bridge refused. */
  | { ok: false; kind: 'rejected'; reason: SubmitFailure; detail: string }

/** What the content script answers for a {@link PanelRequest}. */
export type PageResponse =
  | { ok: true; kind: 'page'; page: PageDescription }
  | { ok: true; kind: 'picking'; active: boolean }
  | { ok: true; kind: 'flashed'; found: boolean }
  | { ok: true; kind: 'probe'; alive: string[] }
  | { ok: false; kind: 'unsupported'; detail: string }

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Whether a value is a non-null object, narrowed for guard use. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Whether a value is a response to {@link PanelRequest}.
 *
 * Message payloads cross a process boundary and arrive as `unknown`; nothing in
 * this module trusts one before this guard has passed. Rejecting a malformed
 * response outright is the point: a half-read answer such as a page description
 * with no URL would otherwise become a URL-shaped hole in the UI.
 *
 * @param value - the value received from the message channel.
 * @returns `true` when the value satisfies {@link PageResponse}.
 */
export function isPageResponse(value: unknown): value is PageResponse {
  if (!isRecord(value)) return false
  if (value['ok'] === false) return value['kind'] === 'unsupported' && typeof value['detail'] === 'string'
  if (value['ok'] !== true) return false
  switch (value['kind']) {
    case 'page': {
      const page = value['page']
      if (!isRecord(page)) return false
      return typeof page['url'] === 'string'
        && typeof page['title'] === 'string'
        && (page['frameKind'] === 'top' || page['frameKind'] === 'sub')
    }
    case 'picking':
      return typeof value['active'] === 'boolean'
    case 'flashed':
      return typeof value['found'] === 'boolean'
    case 'probe':
      return Array.isArray(value['alive']) && value['alive'].every((id) => typeof id === 'string')
    default:
      return false
  }
}

/**
 * Whether a value is a result returned for a {@link PanelCommand}.
 *
 * @param value - the value received from the message channel.
 * @returns `true` when the value satisfies {@link PanelCommandResult}.
 */
export function isPanelCommandResult(value: unknown): value is PanelCommandResult {
  if (!isRecord(value)) return false
  if (value['ok'] === true) {
    if (value['kind'] === 'submitted') return true
    return value['kind'] === 'page' && isPageResponse(value['value'])
  }
  if (value['ok'] !== false) return false
  if (value['kind'] === 'no-receiver') return typeof value['detail'] === 'string'
  if (value['kind'] !== 'rejected') return false
  if (typeof value['detail'] !== 'string') return false
  const reason = value['reason']
  return reason === 'offline' || reason === 'forbidden' || reason === 'invalid' || reason === 'failed'
}

/**
 * Whether a value is a message the panel knows how to handle.
 *
 * `chrome.runtime.onMessage` delivers every broadcast the extension makes, and
 * the panel is not the only listener. Anything that fails this guard is ignored
 * rather than answered, so an unrelated broadcast cannot be mistaken for a page
 * event with the same shape.
 *
 * @param value - the value received from the message channel.
 * @returns `true` when the value satisfies {@link ContentEvent}.
 */
export function isContentEvent(value: unknown): value is ContentEvent {
  if (!isRecord(value)) return false
  switch (value['type']) {
    case 'annotate:page-changed':
      return typeof value['url'] === 'string'
    case 'annotate:pick-ended': {
      const reason = value['reason']
      return reason === 'escape' || reason === 'disabled' || reason === 'picked' || reason === 'suspended'
    }
    default:
      return false
  }
}
