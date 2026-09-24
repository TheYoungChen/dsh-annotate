/**
 * Panel entry point: assemble the shell, bind it to a tab, and hand over.
 *
 * The panel is bound to one tab for its whole life. `chrome.tabs.getCurrent()` is
 * not usable here — a side panel is not a tab — so the binding rests on the
 * side panel's own notion of its window, resolved once at startup and then
 * frozen into the store and the page channel. There is deliberately no rebind
 * path: silently switching the panel to a different tab would leave the user's
 * half-written annotations attached to a page they are no longer looking at.
 *
 * @module
 */

import type { ElementFacts, PageContext, PageKind } from '../../../src/protocol.ts'
import { pageKindOf } from '../../../src/protocol.ts'
import { createController, type PanelController, type PanelElements } from './controller.ts'
import { extensionApi, type RuntimeMessageListener } from './extension-api.ts'
import { chromeTransport, TabPageSource } from './page-source.ts'
import { AnnotationStore, sessionStateStorage } from './store.ts'

/**
 * Resolve the tab this panel describes.
 *
 * A side panel belongs to a window, and the tab the user is working in is the
 * active one in that window. A panel opened over a window with no tabs at all
 * (a rare but reachable state) yields `null`, which the panel reports rather
 * than guessing.
 *
 * @returns the tab id, or `null` when there is no tab to describe.
 */
async function resolveTabId(): Promise<number | null> {
  const api = extensionApi()
  if (api === null) return null
  try {
    const current = await api.windows.getCurrent()
    if (current.id === undefined) return null
    const [tab] = await api.tabs.query({ active: true, windowId: current.id })
    return tab?.id ?? null
  } catch {
    return null
  }
}

/**
 * Look up one element of the shell by id.
 *
 * @param id - the element's id in `index.html`.
 * @returns the element, typed as required.
 * @throws when the markup and this module disagree, which is a build error and
 *   not a runtime condition worth degrading over.
 */
function need<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`panel markup is missing #${id}`)
  return element as T
}

/** Collect the shell's elements. */
function collectElements(): PanelElements {
  return {
    root: need('panel'),
    banner: need('picking-banner'),
    bannerText: need('picking-hint'),
    pageLine: need('page-line'),
    primaryButton: need<HTMLButtonElement>('primary-action'),
    composer: need('composer'),
    composerTarget: need('composer-target'),
    composerInput: need<HTMLTextAreaElement>('composer-input'),
    sendWithoutComment: need<HTMLButtonElement>('send-without-comment'),
    saveComment: need<HTMLButtonElement>('save-comment'),
    list: need('annotation-list'),
    emptyState: need('empty-state'),
    countLine: need('count-line'),
    submitButton: need<HTMLButtonElement>('submit-batch'),
    clearButton: need<HTMLButtonElement>('clear-batch'),
    statusLine: need('status-line'),
    retryButton: need<HTMLButtonElement>('retry-submit'),
  }
}

/**
 * Wire the panel.
 *
 * @returns the running controller, or `null` when there is no tab to bind to.
 */
async function boot(): Promise<PanelController | null> {
  const elements = collectElements()
  const tabId = await resolveTabId()
  if (tabId === null) {
    // Rendered through the same controller so the "no tab" state is the ordinary
    // unavailable state rather than a second code path with its own markup.
    const store = new AnnotationStore(-1, sessionStateStorage())
    const source = new TabPageSource(-1, { send: () => Promise.resolve(undefined) })
    const controller = createController({ elements, store, page: source })
    controller.start()
    return controller
  }

  const store = new AnnotationStore(tabId, sessionStateStorage())
  const source = new TabPageSource(tabId, chromeTransport())
  const controller = createController({ elements, store, page: source })

  // Picks arrive from the content script through the worker; the entry point is
  // where that listener belongs, because it is the only place that knows whether
  // a pick belongs to this tab.
  const onPick: RuntimeMessageListener = (raw) => {
    const pick = parsePickMessage(raw, tabId)
    if (pick === null) return undefined
    // The pick carries the page it was taken on, so the batch keeps the address
    // of the frame that actually owns the element — which is not necessarily the
    // tab's top-level URL, and is the only address a later reader could use.
    const context = pageContextFor(pick)
    controller.acceptPick(pick.elementId, pick.facts, context ?? undefined)
    return undefined
  }
  const api = extensionApi()
  api?.runtime.onMessage.addListener(onPick)

  controller.start()
  window.addEventListener('pagehide', () => {
    api?.runtime.onMessage.removeListener(onPick)
    controller.destroy()
  }, { once: true })
  return controller
}

/** A pick relayed from the content script. */
interface RelayedPick {
  elementId: string
  facts: ElementFacts
  /** Page identity captured by the frame that owns the element. */
  page: { url: string; title?: string }
}

/**
 * Read a relayed pick message.
 *
 * Shape-checked rather than cast: the message channel is shared with every other
 * part of the extension, and a pick whose facts are malformed would otherwise
 * become a list row that renders as blanks.
 *
 * @param raw - the value received from the message channel.
 * @param tabId - this panel's tab, which the message must agree with.
 * @returns the pick, or `null` when the message is not one for this panel.
 */
function parsePickMessage(raw: unknown, tabId: number): RelayedPick | null {
  if (typeof raw !== 'object' || raw === null) return null
  const message = raw as { type?: unknown; tabId?: unknown; elementId?: unknown; facts?: unknown; page?: unknown }
  if (message.type !== 'annotate:picked') return null
  if (message.tabId !== tabId) return null
  if (typeof message.elementId !== 'string' || message.elementId === '') return null
  const facts = message.facts
  if (typeof facts !== 'object' || facts === null) return null
  const candidate = facts as { tag?: unknown; selector?: unknown }
  if (typeof candidate.tag !== 'string' || typeof candidate.selector !== 'string') return null

  const pageRaw = message.page
  const page = typeof pageRaw === 'object' && pageRaw !== null ? pageRaw as { url?: unknown; title?: unknown } : {}
  if (typeof page.url !== 'string' || page.url === '') return null
  const pick: RelayedPick = {
    elementId: message.elementId,
    facts: facts as ElementFacts,
    page: { url: page.url },
  }
  if (typeof page.title === 'string' && page.title !== '') pick.page.title = page.title
  return pick
}

/**
 * Build the batch's page context from a relayed pick.
 *
 * The viewport is measured here, in the panel's own document, which is the one
 * place a side panel is allowed to take a measurement — the panel shares neither
 * `window` nor layout with the page, but the side panel's viewport tracks the
 * browser window's, which is the closest thing to the page's own it can see.
 * The frame that owns the element reports the address, because only it knows it.
 *
 * @param pick - the relayed pick.
 * @returns the context, or `null` when the address is one we may not annotate.
 */
function pageContextFor(pick: RelayedPick): PageContext | null {
  const kind: PageKind | null = pageKindOf(pick.page.url)
  if (kind === null) return null
  const context: PageContext = {
    url: pick.page.url,
    kind,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  }
  if (pick.page.title !== undefined) context.title = pick.page.title
  if (typeof window.devicePixelRatio === 'number') context.devicePixelRatio = window.devicePixelRatio
  return context
}

void boot()
