/**
 * The panel's only channel to the page.
 *
 * A side panel is an ordinary extension page. It shares no globals with the
 * document it is describing, owns no `Element`, and cannot call
 * `getBoundingClientRect` on anything the user picked. So the panel keeps no
 * page state at rest and asks for everything it needs, at the moment it needs
 * it, over the message channel described in {@link module:'./messages.ts'}.
 *
 * Two consequences are visible in this module's shape:
 *
 * - **Every call is a request with a deadline.** A content script is absent from
 *   a tab it was never injected into (a browser-internal page, a tab opened
 *   before the extension was installed) and its context is discarded whenever
 *   the page navigates. Without a timeout the first such case would leave the
 *   panel waiting on a promise that can never settle, which reads to the user as
 *   a frozen interface.
 * - **A failure is data, not an exception.** The callers are UI handlers that
 *   must render *something* — usually "this page cannot be annotated" — so every
 *   method resolves with the outcome rather than throwing.
 *
 * @module
 */

import type { Annotation, PageContext } from '../../../src/protocol.ts'
import { extensionApi } from './extension-api.ts'
import {
  isPanelCommandResult,
  isPageResponse,
  type PageDescription,
  type PageResponse,
  type PanelCommand,
  type PanelCommandResult,
  type PanelRequest,
} from './messages.ts'

/** How long a page question waits before it is reported as unanswered. */
export const PAGE_REQUEST_TIMEOUT_MS = 3000

/** The surface of `chrome.runtime` this module uses, so tests can supply their own. */
export interface MessageTransport {
  /**
   * Send one message to the background worker and await its answer.
   *
   * @param message - a structured-cloneable command.
   * @returns the answer, or `undefined` when nothing replied.
   */
  send(message: PanelCommand): Promise<unknown>
}

/** Something the panel needs from the page. */
export interface PageSource {
  /** Whether the currently bound tab can be reached at all. */
  describePage(): Promise<PageDescription | null>
  /** Arm picking mode. `false` when the page could not be reached. */
  startPicking(): Promise<boolean>
  /** Leave picking mode. */
  stopPicking(): Promise<void>
  /** Ask the page to mark one element. Returns whether it was found. */
  flash(elementId: string): Promise<boolean>
  /**
   * Ask which of these registry ids still resolve to a connected element.
   *
   * Asked lazily, when a row is expanded, rather than for the whole list up
   * front: a batch can hold dozens of annotations and a per-frame round trip for
   * elements the user never looks at would be pure cost.
   */
  probe(elementIds: string[]): Promise<Set<string>>
  /**
   * Hand a batch to the background for delivery to the local bridge.
   *
   * Part of the same interface on purpose. The panel has one channel to the
   * outside world, and splitting the batch hand-off into a second object would
   * mean two failure vocabularies for one user action.
   *
   * @param batchId - identifies this submission across retries.
   * @param annotations - the annotations to send.
   * @param page - where the batch was collected. The worker cannot derive this:
   *   it can only see the tab's top-level URL, and an element picked inside a
   *   cross-origin iframe lives at a different address than the tab's. The store
   *   already holds the identity captured at pick time, so it is passed through
   *   rather than guessed at the other end. Optional so that the worker still
   *   receives a usable command from a caller that has not yet been updated;
   *   omitting it makes the worker refuse the batch with `invalid` rather than
   *   deliver one stamped with the wrong address.
   * @param submittedAt - when the user sent this. Supplied so the timestamp is a
   *   fact about the submission rather than about the worker's receive loop.
   * @returns the worker's verdict.
   */
  submit(
    batchId: string,
    annotations: readonly Annotation[],
    page?: PageContext | null,
    submittedAt?: number,
  ): Promise<PanelCommandResult>
}

/** The default transport, backed by the extension's own message channel. */
export function chromeTransport(): MessageTransport {
  return {
    async send(message: PanelCommand): Promise<unknown> {
      const api = extensionApi()
      if (api === null) throw new Error('no extension runtime available')
      return api.runtime.sendMessage(message)
    },
  }
}

/**
 * Bound page source.
 *
 * The tab id is fixed at construction rather than passed per call. The panel
 * describes exactly one tab for its whole life, and threading the id through
 * every method would make it possible for two calls in one interaction to name
 * different tabs.
 */
export class TabPageSource implements PageSource {
  private readonly tabId: number
  private readonly transport: MessageTransport
  private readonly timeoutMs: number

  /**
   * @param tabId - the tab the panel is bound to.
   * @param transport - message channel, injected so the panel is testable
   *   without a browser.
   * @param timeoutMs - how long to wait for an answer.
   */
  constructor(tabId: number, transport: MessageTransport, timeoutMs = PAGE_REQUEST_TIMEOUT_MS) {
    this.tabId = tabId
    this.transport = transport
    this.timeoutMs = timeoutMs
  }

  /**
   * Send one request, bounded in time, and never throw.
   *
   * `sendMessage` rejects when the receiver goes away mid-call — a page that
   * navigates between the send and the reply — and it never settles when there
   * is no receiver at all. Both are ordinary outcomes here, so both collapse to
   * `null` for the caller to interpret.
   *
   * @param request - the question for the page.
   * @returns the page's answer, or `null` when there was none in time.
   */
  async ask(request: PanelRequest): Promise<PageResponse | null> {
    const command: PanelCommand = { type: 'annotate:page', tabId: this.tabId, request }
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => { resolve(null) }, this.timeoutMs)
    })
    try {
      const answer = await Promise.race([this.dispatch(command), deadline])
      return answer
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Send a command and normalise whatever comes back into a page response. */
  private async dispatch(command: PanelCommand): Promise<PageResponse | null> {
    let raw: unknown
    try {
      raw = await this.transport.send(command)
    } catch {
      return null
    }
    return unwrapPageResponse(raw)
  }

  async describePage(): Promise<PageDescription | null> {
    const response = await this.ask({ type: 'annotate:describe-page' })
    return response !== null && response.ok && response.kind === 'page' ? response.page : null
  }

  async startPicking(): Promise<boolean> {
    const response = await this.ask({ type: 'annotate:start-picking' })
    return response !== null && response.ok && response.kind === 'picking' ? response.active : false
  }

  async stopPicking(): Promise<void> {
    await this.ask({ type: 'annotate:stop-picking' })
  }

  async flash(elementId: string): Promise<boolean> {
    const response = await this.ask({ type: 'annotate:flash', elementId })
    return response !== null && response.ok && response.kind === 'flashed' ? response.found : false
  }

  async probe(elementIds: string[]): Promise<Set<string>> {
    if (elementIds.length === 0) return new Set()
    const response = await this.ask({ type: 'annotate:probe', elementIds })
    if (response === null || !response.ok || response.kind !== 'probe') return new Set()
    return new Set(response.alive)
  }

  /**
   * Hand a batch to the background for delivery to the bridge.
   *
   * Kept on this class rather than in a module of its own because it is the same
   * channel, the same tab and the same failure vocabulary: a panel that had to
   * reach two objects to find out whether anything it sent arrived would have to
   * merge two error models for no gain.
   *
   * @param batchId - identifies this submission across retries.
   * @param annotations - the annotations to send.
   * @param page - where the batch was collected, when the caller has it.
   * @param submittedAt - when the user sent this, when the caller has it.
   * @returns the worker's verdict.
   */
  async submit(
    batchId: string,
    annotations: readonly Annotation[],
    page?: PageContext | null,
    submittedAt?: number,
  ): Promise<PanelCommandResult> {
    const command: PanelCommand = { type: 'annotate:submit', batchId, annotations: [...annotations], tabId: this.tabId }
    // `exactOptionalPropertyTypes` distinguishes "absent" from "present and
    // undefined", and the worker reads absence to decide whether it has enough
    // to build a batch, so the fields are added rather than set to undefined.
    if (page !== undefined && page !== null) command.page = page
    if (submittedAt !== undefined) command.submittedAt = submittedAt
    try {
      const raw = await this.transport.send(command)
      return isPanelCommandResult(raw)
        ? raw
        : { ok: false, kind: 'rejected', reason: 'failed', detail: 'The extension worker gave an unusable answer.' }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, kind: 'rejected', reason: 'failed', detail }
    }
  }
}

/**
 * Dig the page's answer out of whatever the background replied with.
 *
 * The worker is developed independently of this panel, so the panel accepts the
 * two plausible shapes — the full {@link PanelCommandResult} or the bare
 * {@link PageResponse} it wrapped — and refuses anything else. Being liberal
 * here costs one function and removes an ordering dependency between two
 * components that are built in parallel; being liberal about *page* responses
 * would cost correctness, so those still go through the strict guard.
 *
 * @param raw - the value the worker returned.
 * @returns the page response, or `null` when the reply is unusable.
 */
export function unwrapPageResponse(raw: unknown): PageResponse | null {
  if (isPageResponse(raw)) return raw
  if (isPanelCommandResult(raw) && raw.ok && raw.kind === 'page') return raw.value
  return null
}
