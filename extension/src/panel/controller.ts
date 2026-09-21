/**
 * The panel controller.
 *
 * Owns the DOM, the store and the conversation with the page, and is the only
 * place where the three meet. Everything it decides is delegated: which view
 * state to show comes from `view.ts`, how a row reads comes from `row.ts`, what
 * a submission contains comes from `store.ts`. What is left here is wiring and
 * timing — when to ask the page something, when to redraw, when to send.
 *
 * Three timing rules matter and are easy to get wrong:
 *
 * - **Hover feedback is fire-and-forget.** Marking an element on the page is a
 *   side effect with no result the panel acts on, so it is issued without being
 *   awaited and without being allowed to reject into the render loop.
 * - **Renders coalesce.** One interaction can touch several store fields, each
 *   of which notifies; coalescing on a microtask keeps the list from being
 *   rebuilt three times per click.
 * - **A page question never blocks a render.** Every answer arrives later, and
 *   the panel draws the honest intermediate state ("we do not know yet") rather
 *   than holding the interface still until the page replies.
 *
 * @module
 */

import type { Annotation, ElementFacts, PageContext, PageKind } from '../../../src/protocol.ts'
import { pageKindOf } from '../../../src/protocol.ts'
import { extensionApi, type RuntimeMessageListener } from './extension-api.ts'
import type { ContentEvent, PageDescription, PanelCommandResult } from './messages.ts'
import { isContentEvent } from './messages.ts'
import type { PageSource } from './page-source.ts'
import { createFactTable, createRow, type RowHandle } from './row.ts'
import type { AnnotationStore, PanelSnapshot } from './store.ts'
import { pageLabel } from './summary.ts'
import {
  deriveView,
  PICKING_HINT,
  primaryActionLabel,
  unavailableMessage,
  type PanelView,
  type UnavailableReason,
} from './view.ts'

/** The rendered element tree the controller drives. */
export interface PanelElements {
  root: HTMLElement
  banner: HTMLElement
  bannerText: HTMLElement
  pageLine: HTMLElement
  primaryButton: HTMLButtonElement
  composer: HTMLElement
  composerTarget: HTMLElement
  composerInput: HTMLTextAreaElement
  sendWithoutComment: HTMLButtonElement
  saveComment: HTMLButtonElement
  list: HTMLElement
  emptyState: HTMLElement
  countLine: HTMLElement
  submitButton: HTMLButtonElement
  clearButton: HTMLButtonElement
  statusLine: HTMLElement
  retryButton: HTMLButtonElement
}

/** Options for {@link createController}. */
export interface ControllerOptions {
  elements: PanelElements
  store: AnnotationStore
  page: PageSource
}

/** The controller's public surface; the entry point wires nothing else. */
export interface PanelController {
  /** Render once and start listening. */
  start(): void
  /** Release listeners, timers and DOM references. */
  destroy(): void
  /**
   * Report a pick that arrived from the page.
   *
   * Exposed rather than kept internal because the pick itself is delivered by
   * the content script through the background, and the entry point is where that
   * listener lives.
   *
   * @param elementId - the registry id the picker handed out.
   * @param facts - the facts captured on the page.
   * @param context - the page the pick was taken on, when the relay carried one.
   */
  acceptPick(elementId: string, facts: ElementFacts, context?: PageContext): void
}

/** Turn a submission result into something worth putting on screen. */
function describeResult(result: PanelCommandResult): { message: string; retryable: boolean } {
  if (result.ok) return { message: 'Sent to DeepSeek Harness.', retryable: false }
  switch (result.kind) {
    case 'no-receiver':
      return { message: 'That tab is not reachable any more. Reload the page and pick again.', retryable: false }
    case 'rejected':
      switch (result.reason) {
        case 'offline':
          return { message: 'DeepSeek Harness is not reachable. Start it, then retry.', retryable: true }
        case 'forbidden':
          return { message: 'Online annotation is turned off for this site.', retryable: false }
        case 'invalid':
          return { message: `The batch was refused: ${result.detail}`, retryable: false }
        case 'failed':
          return { message: `Sending failed: ${result.detail}`, retryable: true }
      }
  }
}

/** A fresh batch id, so a retry is recognisable as the same submission. */
function newBatchId(): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `b${Date.now().toString(36)}-${random}`
}

/**
 * Create the controller for one panel document.
 *
 * @param options - the rendered tree, the store and the page channel.
 * @returns a controller that is inert until {@link PanelController.start}.
 */
export function createController(options: ControllerOptions): PanelController {
  const { elements, store, page } = options

  /** Live rows, keyed by annotation id, so typing never loses its caret. */
  const rows = new Map<string, RowHandle>()
  /**
   * Registry id behind each annotation.
   *
   * Held beside the annotations rather than on them: `Annotation` is the wire
   * format a model reads, and an id that only means something inside one live
   * document has no business travelling in it.
   */
  const elementIds = new Map<string, string>()
  /** Cached liveness per annotation; absent means "not asked yet". */
  const liveness = new Map<string, boolean>()
  /** Registry id of the pick waiting for a comment. */
  let pendingElementId: string | null = null

  let reachable = true
  let unreachableReason: UnavailableReason = null
  let snapshot: PanelSnapshot = store.snapshot()
  let view: PanelView = deriveView(snapshot, reachable, unreachableReason)
  let destroyed = false
  let renderQueued = false
  const teardown: Array<() => void> = []

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** Redraw, coalescing everything the current task changed. */
  function invalidate(): void {
    if (destroyed || renderQueued) return
    renderQueued = true
    queueMicrotask(() => {
      renderQueued = false
      if (!destroyed) render()
    })
  }

  /** Apply everything a render depends on to the live DOM. */
  function render(): void {
    view = deriveView(snapshot, reachable, unreachableReason)
    elements.root.dataset['state'] = view.state

    elements.banner.hidden = view.state !== 'picking'
    elements.bannerText.textContent = view.state === 'picking' ? PICKING_HINT : ''

    elements.pageLine.hidden = view.state === 'unavailable'
    elements.pageLine.textContent = describePageLine(view, snapshot.stale)
    elements.pageLine.classList.toggle('is-stale', snapshot.stale)

    elements.primaryButton.textContent = primaryActionLabel(view.state)
    elements.primaryButton.disabled = view.state === 'unavailable' || view.submitting
    elements.primaryButton.setAttribute('aria-pressed', view.state === 'picking' ? 'true' : 'false')

    renderComposer()
    renderList()
    renderFooter()
  }

  /** The pending pick: which element is waiting, and how to commit it. */
  function renderComposer(): void {
    const facts = snapshot.currentFacts
    elements.composer.hidden = facts === null || view.state === 'unavailable'
    if (facts === null) {
      elements.composerTarget.textContent = ''
      return
    }
    elements.composerTarget.textContent = `Selected ${facts.tag} — ${facts.selector === '' ? '(no selector)' : facts.selector}`
    elements.composerTarget.title = facts.selector
  }

  /** The list, reusing rows and preserving document order. */
  function renderList(): void {
    const annotations = snapshot.annotations
    elements.emptyState.hidden = annotations.length > 0 || view.state === 'unavailable'
    elements.countLine.textContent = annotations.length === 0
      ? ''
      : `${annotations.length} annotation${annotations.length === 1 ? '' : 's'}`

    const seen = new Set<string>()
    let previous: HTMLElement | null = null
    for (const annotation of annotations) {
      seen.add(annotation.id)
      let handle = rows.get(annotation.id)
      if (handle === undefined) {
        handle = createRow(annotation, rowHandlers)
        rows.set(annotation.id, handle)
      }
      handle.update(annotation, liveness.get(annotation.id) ?? null)
      placeAfter(handle.element, previous)
      previous = handle.element
    }
    for (const [id, handle] of rows) {
      if (seen.has(id)) continue
      handle.element.remove()
      rows.delete(id)
      elementIds.delete(id)
      liveness.delete(id)
    }
  }

  /** Ensure `element` is the node immediately after `previous`, moving it if not. */
  function placeAfter(element: HTMLElement, previous: HTMLElement | null): void {
    const expected = previous === null ? elements.list.firstElementChild : previous.nextElementSibling
    if (expected === element) return
    const anchor = previous === null ? elements.list.firstElementChild : previous.nextElementSibling
    elements.list.insertBefore(element, anchor)
  }

  /** The batch actions and the last result. */
  function renderFooter(): void {
    elements.submitButton.disabled = !view.canSubmit
    elements.submitButton.textContent = view.submitting ? 'Sending…' : 'Send batch to DSH'
    elements.clearButton.disabled = view.rowCount === 0 || view.submitting
    elements.statusLine.textContent = view.state === 'unavailable'
      ? unavailableMessage(view.unavailableReason)
      : view.result ?? ''
    elements.statusLine.classList.toggle('is-error', view.state === 'unavailable' || view.result !== null)
    elements.retryButton.hidden = !view.retryable
  }

  /** The page line: where the batch will say it was collected. */
  function describePageLine(current: PanelView, stale: boolean): string {
    const label = pageLabel(current.pageUrl)
    if (label === null) return ''
    const title = current.pageTitle === null || current.pageTitle === '' ? '' : ` — ${current.pageTitle}`
    return `${label}${title}${stale ? ' · picked before the last page change' : ''}`
  }

  // -------------------------------------------------------------------------
  // Row interaction
  // -------------------------------------------------------------------------

  const rowHandlers = {
    onHover(annotationId: string, entered: boolean): void {
      if (!entered) return
      const elementId = elementIds.get(annotationId)
      if (elementId === undefined) return
      void page.flash(elementId).catch(() => { /* a missed marker is not worth reporting */ })
    },
    onToggle(annotationId: string, expanded: boolean): void {
      if (expanded) void openFacts(annotationId)
    },
    onCommentChange(annotationId: string, comment: string): void {
      if (!store.setComment(annotationId, comment)) return
      void store.persist()
    },
    onRemove(annotationId: string): void {
      if (!store.remove(annotationId)) return
      void store.persist()
    },
  }

  /**
   * Fill in the fact table for a row the user just opened.
   *
   * The table is rendered immediately with liveness unknown, then corrected when
   * the page answers. Waiting for the answer first would leave a click with no
   * visible effect on a slow tab, and the page can be gone entirely — in which
   * case no answer is ever coming.
   */
  async function openFacts(annotationId: string): Promise<void> {
    const handle = rows.get(annotationId)
    const annotation = snapshot.annotations.find((candidate) => candidate.id === annotationId)
    if (handle === undefined || annotation === undefined) return
    handle.setFacts(createFactTable(annotation.facts, liveness.get(annotationId) ?? null))

    const elementId = elementIds.get(annotationId)
    if (elementId === undefined || !reachable) return
    const alive = await page.probe([elementId])
    if (destroyed) return
    const isAlive = alive.has(elementId)
    liveness.set(annotationId, isAlive)
    const current = rows.get(annotationId)
    if (current !== undefined) current.setFacts(createFactTable(annotation.facts, isAlive))
  }

  // -------------------------------------------------------------------------
  // Page conversation
  // -------------------------------------------------------------------------

  /** Build the batch's page context from what the page reported. */
  function pageContext(description: PageDescription): PageContext | null {
    const kind: PageKind | null = pageKindOf(description.url)
    if (kind === null) return null
    const context: PageContext = {
      url: description.url,
      kind,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }
    if (description.title !== '') context.title = description.title
    if (typeof window.devicePixelRatio === 'number') context.devicePixelRatio = window.devicePixelRatio
    return context
  }

  /** Ask the page what it is, and adapt the panel to the answer. */
  async function refreshPage(): Promise<void> {
    const description = await page.describePage()
    if (destroyed) return
    if (description === null) {
      reachable = false
      unreachableReason = 'no-receiver'
      invalidate()
      return
    }
    const context = pageContext(description)
    if (context === null) {
      reachable = false
      unreachableReason = 'unsupported-url'
      invalidate()
      return
    }
    reachable = true
    unreachableReason = null
    store.setPage(context)
    invalidate()
  }

  /** Toggle picking mode, following the page's own answer rather than our intent. */
  async function togglePicking(): Promise<void> {
    if (view.state === 'picking') {
      store.setPicking(false)
      await page.stopPicking()
      return
    }
    const active = await page.startPicking()
    if (destroyed) return
    if (!active) {
      reachable = false
      unreachableReason = 'no-receiver'
      invalidate()
      return
    }
    store.setPicking(true)
  }

  /** Add the pending pick to the list, with or without a comment. */
  function commitPending(comment: string): void {
    const elementId = pendingElementId
    const annotation: Annotation | null = store.commit(comment)
    if (annotation === null) return
    if (elementId !== null) elementIds.set(annotation.id, elementId)
    pendingElementId = null
    elements.composerInput.value = ''
    // Committing ends the pass: the user gets their page back, and starting
    // another pick is one click away in the same interface.
    void page.stopPicking()
    void store.persist()
  }

  /** Send the whole batch to the background, which relays it to the bridge. */
  async function submitBatch(): Promise<void> {
    const annotations = snapshot.annotations
    if (annotations.length === 0 || snapshot.submitting) return
    store.beginSubmit()
    // The page travels with the batch because the worker cannot derive it: it can
    // only see the tab's top-level URL, and an element picked inside a
    // cross-origin iframe lives at a different address. This is the identity the
    // store captured at pick time and persists precisely so a retry keeps it.
    const result = await page.submit(newBatchId(), annotations, snapshot.page, Date.now())
    if (destroyed) return
    const outcome = describeResult(result)
    store.finishSubmit(outcome.message, outcome.retryable)
  }

  /** React to one page event pushed by the content script. */
  function handleContentEvent(event: ContentEvent): void {
    switch (event.type) {
      case 'annotate:pick-ended':
        store.setPicking(false)
        return
      case 'annotate:page-changed':
        // Every registry id belonged to the document that just went away. The
        // rows stay — they are the user's own work — but the panel stops
        // claiming the elements behind them still exist.
        store.clearPicked()
        store.setStale(true)
        pendingElementId = null
        elementIds.clear()
        liveness.clear()
        invalidate()
        return
    }
  }

  /** Handle a message broadcast by the extension, ignoring anything unrelated. */
  const onRuntimeMessage: RuntimeMessageListener = (raw) => {
    if (isContentEvent(raw)) handleContentEvent(raw)
    // Never `true`: this panel answers nothing, and claiming an async response
    // would keep the sender's channel open until it timed out.
    return undefined
  }

  /** Attach one listener and register its removal. */
  function listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
  ): void {
    target.addEventListener(type, handler)
    teardown.push(() => { target.removeEventListener(type, handler) })
  }

  /** Subscribe to the page events the content script broadcasts. */
  function listenForContentEvents(): void {
    const api = extensionApi()
    if (api === null) return
    api.runtime.onMessage.addListener(onRuntimeMessage)
    teardown.push(() => { api.runtime.onMessage.removeListener(onRuntimeMessage) })
  }

  return {
    start(): void {
      snapshot = store.snapshot()
      teardown.push(store.subscribe((next) => {
        snapshot = next
        invalidate()
      }))

      listen(elements.primaryButton, 'click', () => { void togglePicking() })
      listen(elements.saveComment, 'click', () => { commitPending(elements.composerInput.value) })
      listen(elements.sendWithoutComment, 'click', () => { commitPending('') })
      listen(elements.composerInput, 'keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return
        // Same rule as a list row: Enter commits, Shift+Enter keeps a line.
        event.preventDefault()
        commitPending(elements.composerInput.value)
      })
      listen(elements.submitButton, 'click', () => { void submitBatch() })
      listen(elements.retryButton, 'click', () => { void submitBatch() })
      listen(elements.clearButton, 'click', () => {
        store.clear()
        elementIds.clear()
        liveness.clear()
        void store.persist()
      })

      listenForContentEvents()

      render()
      void store.restore().then(() => { void refreshPage() })
    },

    destroy(): void {
      destroyed = true
      for (const remove of teardown) remove()
      teardown.length = 0
      rows.clear()
      elementIds.clear()
      liveness.clear()
    },

    acceptPick(elementId: string, facts: ElementFacts, context?: PageContext): void {
      pendingElementId = elementId
      store.setPicked({ id: elementId, facts }, context)
      invalidate()
    },
  }
}
