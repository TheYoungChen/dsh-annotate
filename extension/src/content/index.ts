/**
 * Content-script entry point: the only page-side code the extension runs.
 *
 * This module is the seam between three things that cannot see each other: the
 * picker (which knows the DOM but nothing about the extension), the service
 * worker (which owns frame routing and the bridge), and the side panel (which
 * shows the annotations but has no document in common with the page). Everything
 * here is therefore either a translation or a piece of routing, and the two
 * contracts it translates between are
 * {@link module:'../background/wire.ts'} (page -> worker) and
 * {@link module:'../panel/messages.ts'} (panel -> page).
 *
 * ## What crosses the message boundary, and what deliberately does not
 *
 * Messaging serialises with the structured clone algorithm. A DOM node is not
 * cloneable — sending one throws `DataCloneError` before any listener runs — so
 * an element can never be addressed by identity across this boundary. It is
 * addressed by the opaque registry id {@link module:'./picker.ts'} mints, which
 * this module resolves back to a live node, in this document, on the far side.
 * That is why `flash` and `probe` take strings and why nothing in the message
 * shapes below is an `Element`.
 *
 * ## The page is never written to
 *
 * Nowhere in this module is there an attribute write, a class write or a style
 * write on a page-owned node. Highlighting goes through the picker's isolated
 * overlay, which lives in a shadow root under a zero-sized host of its own; the
 * only node this code adds to the document is that host, and removing it leaves
 * the page exactly as it was found. That restraint is not stylistic: pages watch
 * their own DOM with `MutationObserver`, and a `data-` attribute stamped for
 * bookkeeping has, in practice, caused framework re-renders and state loss.
 *
 * ## Frames
 *
 * The manifest declares `all_frames: true`, so this script runs in every frame
 * of a tab. A content script cannot see its own frame id, and its view of its
 * ancestors stops at the first cross-origin boundary, so {@link frameDepth} is a
 * **lower bound** that this module reports as a hint and never as an authority.
 * The service worker replaces it with the depth from the browser's own frame
 * tree (`background/enrich.ts`) and keeps the estimate beside it as
 * `reportedFrameDepth`.
 *
 * @module
 */

import { PROTOCOL_VERSION, pageKindOf, type AnnotationBatch, type ElementFacts, type PageContext } from '../../../src/protocol.ts'
import type { ContentMessage } from '../background/wire.ts'
import type { PageDescription, PageResponse, PanelRequest } from '../panel/messages.ts'
import { extractElementFacts, frameDepth } from './facts.ts'
import {
  armPicking,
  disarmPicking,
  elementRegistry,
  flashElement,
  isPicking,
  type PickerEvent,
  type PickerExitReason,
} from './picker.ts'

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

/** Tag every page-to-worker message carries. The worker drops anything else. */
const WIRE_TAG = 'dsh-annotate'

/** Message type the worker relays to the panel when a pick is taken. */
const PICK_RELAY_TYPE = 'annotate:picked'

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Whether a value is a non-null object.
 *
 * Everything arriving on a message channel is `unknown`; this is the first
 * narrowing every reader below performs.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * A finite integer, or `undefined`.
 *
 * Frame and tab ids are integers the browser assigns. A float or a `NaN` is not
 * a value the platform can produce, so treating one as usable would mean acting
 * on a number that addresses nothing.
 */
function readInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  return value
}

/**
 * Whether this frame's document is the tab's top-level document.
 *
 * `window.top === window` is the only test available to a content script and it
 * is stable across origin boundaries: reading `window.top` is permitted even
 * when reading anything *through* it is not. The comparison is what makes it
 * safe, so it is written as an identity check rather than as a property read.
 */
function isTopFrame(): boolean {
  try {
    return window.top === window
  } catch {
    // A frame whose `window.top` accessor throws is, by definition, not able to
    // prove it is the top document, and a nested frame is the safer answer: the
    // worker uses this only to prefer the top frame's page facts.
    return false
  }
}

/** The document's address, or the empty string when even reading it throws. */
function documentUrl(): string {
  try {
    return document.location.href
  } catch {
    return ''
  }
}

/** The document's title, or the empty string. */
function documentTitle(): string {
  try {
    return document.title
  } catch {
    return ''
  }
}

/** This frame's viewport size, as whole pixels. */
function viewportSize(): { width: number; height: number } {
  const width = typeof window.innerWidth === 'number' ? Math.round(window.innerWidth) : 0
  const height = typeof window.innerHeight === 'number' ? Math.round(window.innerHeight) : 0
  return { width: Math.max(0, width), height: Math.max(0, height) }
}

/**
 * A registry id, or `null` when the value cannot be one.
 *
 * Ids are minted by the picker and read back by the panel, so the only thing a
 * receiver can check is the type. Rejecting a non-string here keeps a malformed
 * `flash` from reaching the registry with a value it would silently miss on.
 */
function readElementId(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** A list of registry ids, dropping anything that is not one. */
function readElementIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const entry of value) {
    const id = readElementId(entry)
    if (id !== null) ids.push(id)
  }
  return ids
}

/**
 * Narrow this frame's own address for the worker.
 *
 * The page kind comes from the protocol's own classifier rather than from a
 * prefix test written here, so the extension has exactly one definition of "an
 * address this project may annotate". A `null` kind is the protocol saying the
 * address is out of scope, and the caller refuses to build a batch from it.
 */
function pageContextForBatch(): PageContext {
  const url = documentUrl()
  // `pageKindOf` returns `null` for an address outside the protocol, and the
  // `https` placeholder it falls back to is never observable: every caller
  // checks {@link isAnnotatableUrl} before a batch carrying this context is
  // built, and refuses to build one when the address is out of scope.
  const kind = pageKindOf(url) ?? 'https'
  const context: PageContext = {
    url,
    kind,
    viewport: viewportSize(),
  }
  const title = documentTitle()
  if (title !== '') context.title = title
  if (typeof window.devicePixelRatio === 'number') context.devicePixelRatio = window.devicePixelRatio
  return context
}

/**
 * Whether the address is one the protocol can describe.
 *
 * A batch whose `page.url` cannot be classified is worse than no batch: the
 * reader would be handed a page context with a placeholder kind and no way to
 * tell that it is one.
 */
function isAnnotatableUrl(url: string): boolean {
  return pageKindOf(url) !== null
}

/**
 * A batch id that cannot collide across frames.
 *
 * Every frame of a tab mints its own ids, and a batch is deduplicated by id at
 * the bridge. A counter would restart at `1` in each frame, so two frames
 * picking at the same moment would submit the same batch id and the second
 * would be read as a retry of the first. Randomness removes that possibility
 * without needing a coordinator the page-side code cannot have. A document
 * always has `crypto` over a secure context; the counter is the fallback for a
 * context that does not, and is scoped by frame depth so it still differs
 * between frames.
 */
function newBatchId(): string {
  const random = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (random !== undefined && typeof random.randomUUID === 'function') return random.randomUUID()
  batchCounter += 1
  return `b-${frameDepth()}-${Date.now().toString(36)}-${batchCounter.toString(36)}`
}

/** Monotonic suffix for the fallback batch id above. */
let batchCounter = 0

/** Mint an annotation id, unique within one batch. */
function newAnnotationId(registryId: string, pickedAt: number): string {
  annotationCounter += 1
  return `${registryId}-${pickedAt.toString(36)}-${annotationCounter.toString(36)}`
}

/** Monotonic suffix for annotation ids. */
let annotationCounter = 0

// ---------------------------------------------------------------------------
// The frame's state
// ---------------------------------------------------------------------------

/**
 * This content script's own state, held in one place.
 *
 * The set is a record rather than a decision — the pick is always handed over,
 * because dropping one would show the user an element the panel never lists —
 * and it exists so a re-injection inherits a single object instead of becoming a
 * second, parallel installation.
 */
interface FrameState {
  /** Registry ids this frame has handed to the panel during this document. */
  readonly handedOver: Set<string>
}

/** Global slot the frame state lives in, so a re-injection is detectable. */
const STATE_SLOT = '__dshAnnotateContentEntry__'

/** The global object this script installs itself on. */
type EntryGlobal = typeof globalThis & {
  [STATE_SLOT]?: FrameState
}

// ---------------------------------------------------------------------------
// Messages outbound
// ---------------------------------------------------------------------------

/**
 * Send one message to the service worker.
 *
 * A content script cannot see its own tab or frame id, so both are sent as `-1`
 * and the worker replaces them with the ids the browser reports on the sender
 * (`sender.tab.id`, `sender.frameId`). The sent values are therefore inert
 * placeholders rather than claims, and the worker's `parseContentMessage`
 * accepts them because it validates shape, not truth.
 *
 * The promise is handled here rather than by each caller. `chrome.runtime.sendMessage`
 * rejects when the extension has no listener able to answer — the normal state
 * during an extension reload, when this script's context outlives the worker it
 * was paired with — and an unhandled rejection in a page would surface as a
 * console error the user cannot act on.
 *
 * @param message - a message built from the contract in `background/wire.ts`.
 * @returns a promise that settles once the platform has delivered or refused it.
 */
function sendToWorker(message: ContentMessage): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const result: unknown = chrome.runtime.sendMessage(message)
      if (result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
        ;(result as Promise<unknown>).then(() => { resolve() }, () => { resolve() })
        return
      }
      resolve()
    } catch {
      // A discarded extension context throws synchronously. Nothing to report:
      // the frame is no longer part of the extension, and there is no one left
      // to report it to.
      resolve()
    }
  })
}

/** The message envelope every page-to-worker message needs. */
function envelopeFor(kind: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    tag: WIRE_TAG,
    kind,
    // Placeholders: the authoritative ids come from the sender the browser
    // reports, never from a value a page-adjacent context wrote into a payload.
    tabId: -1,
    frame: { frameId: -1, url: documentUrl() },
    ...extra,
  }
}

/** Announce that picking mode is live in this frame. */
function announcePickingStarted(): void {
  void sendToWorker(envelopeFor('picking-started', {}) as unknown as ContentMessage)
}

/** Announce that picking ended in this frame, and why. */
function announcePickingEnded(reason: PickerExitReason): void {
  void sendToWorker(envelopeFor('picking-ended', { reason }) as unknown as ContentMessage)
}

/**
 * Hand a pick to the panel by way of the worker.
 *
 * The pick travels untagged, unlike the lifecycle messages. It is addressed to
 * the panel, not to the worker: the worker relays it to the panel for the tab
 * and never parses it, so tagging it as a page-to-worker message would invite
 * the worker to read a payload it has no use for.
 *
 * The facts are captured here rather than in {@link submitPick} so that both
 * messages describe the same instant. Reading the DOM twice would let a page
 * that re-renders between the two reads produce a batch and a panel row that
 * disagree about the element the user picked.
 *
 * @param event - the pick, as the picker reported it.
 * @param facts - the facts captured for that pick.
 */
function sendPickToPanel(event: PickerEvent, facts: ElementFacts): void {
  const page: { url: string; title?: string } = { url: documentUrl() }
  const title = documentTitle()
  if (title !== '') page.title = title

  try {
    const result: unknown = chrome.runtime.sendMessage({
      type: PICK_RELAY_TYPE,
      // Placeholders again: the panel compares the relayed tab id against its
      // own, and the worker rewrites this field from the sender before relaying.
      tabId: -1,
      elementId: event.id,
      facts,
      page,
    })
    if (result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
      void (result as Promise<unknown>).then(() => undefined, () => undefined)
    }
  } catch {
    // Same reasoning as `sendToWorker`: a dead context has nowhere to report to.
  }
}

/**
 * Submit this frame's picked elements as one batch.
 *
 * A batch describes exactly one document — `page.viewport` and every
 * `facts.rect` are frame-local coordinates — so a frame can only ever send
 * annotations it took itself, and this function therefore builds a one-element
 * batch. The per-frame limits are left to the worker, which is the only context
 * that can count across frames.
 *
 * @param event - the pick being submitted.
 * @param facts - the facts captured when the pick happened.
 * @returns a promise that settles once the batch has been handed to the worker.
 */
function submitPick(event: PickerEvent, facts: ElementFacts): Promise<void> {
  const batch = buildBatch([{ id: event.id, facts }])
  if (batch === null) return Promise.resolve()
  return sendToWorker(envelopeFor('batch', { batch }) as unknown as ContentMessage)
}

/**
 * Build a batch from elements picked in this frame.
 *
 * The annotation's id comes from the element's registry id with a per-message
 * suffix rather than from a fresh counter: the registry id is stable while the
 * element is connected, so re-picking the same element produces recognisably
 * related ids instead of unrelated ones.
 *
 * @param picked - registry ids with the facts captured for them.
 * @returns the batch, or `null` when the document's address cannot be described
 *   by the protocol (an extension page, a `data:` URL, a browser-internal page).
 */
function buildBatch(picked: ReadonlyArray<{ id: string; facts: ElementFacts }>): AnnotationBatch | null {
  const page = pageContextForBatch()
  if (!isAnnotatableUrl(page.url)) return null
  const submittedAt = Date.now()
  return {
    version: PROTOCOL_VERSION,
    batchId: newBatchId(),
    page,
    annotations: picked.map((entry) => ({
      id: newAnnotationId(entry.id, submittedAt),
      facts: entry.facts,
      pickedAt: submittedAt,
    })),
    submittedAt,
  }
}

// ---------------------------------------------------------------------------
// Messages inbound
// ---------------------------------------------------------------------------

/**
 * The picker handlers, together because every one of them is a translation.
 *
 * `onPick` submits and hands over in the same turn. The two are not redundant:
 * the batch is what the worker needs to keep frame provenance and routing
 * honest, and the relay is what puts the element in front of the user in the
 * panel. Sending only the batch would leave the panel showing nothing.
 */
const pickerHandlers = {
  onPick(event: PickerEvent): void {
    // The batch goes to the worker, which stamps the frame provenance onto it
    // and forwards it to the bridge; the relay goes to the panel, which is the
    // only context that can turn the pick into a row the user can comment on.
    const state = stateOf()
    if (state !== null) state.handedOver.add(event.id)
    const facts = extractElementFacts(event.element)
    void submitPick(event, facts)
    sendPickToPanel(event, facts)
  },
  onExit(reason: PickerExitReason): void {
    announcePickingEnded(reason)
  },
}

/**
 * Arm the picker for one picking run.
 *
 * `armPicking` rather than `startPicking`: a duplicated `start` — a retried
 * command, two panels, a worker that was recycled and replayed it — must leave
 * one session, not two fighting over the same click.
 *
 * @param keepAlive - whether the mode survives a pick. Comes from the command,
 *   because only the DSH side knows how many annotations the user intends.
 * @param hintText - localised hint strip text, or `undefined` for the default.
 */
function startPicking(keepAlive: boolean, hintText: string | undefined): void {
  // Nothing is read from the previous session: `armPicking` stops it first, and
  // reading `current` off a session that is being replaced is the one way this
  // function could observe a half-torn-down picker.
  const options = {
    keepAlive,
    onPick: pickerHandlers.onPick,
    onExit: (reason: PickerExitReason): void => {
      pickerHandlers.onExit(reason)
    },
  }
  armPicking(hintText === undefined ? options : { ...options, hintText })
  announcePickingStarted()
}

/**
 * Leave picking mode on this frame.
 *
 * The exit announcement comes from the session's own `onExit`, so a frame that
 * was not picking announces nothing. That is the difference between "the mode
 * ended here" and "a stop command passed through here", and the panel acts on
 * the first.
 */
function stopPicking(): void {
  disarmPicking('disabled')
}

/**
 * Handle one picking command from the worker.
 *
 * @param raw - the message, already narrowed by {@link isPickCommandShape}.
 */
function handlePickCommand(raw: Record<string, unknown>): void {
  const command = raw['command']
  if (command === 'stop') {
    stopPicking()
    return
  }
  if (command !== 'start') return
  const keepAlive = raw['keepAlive'] === true
  const hintText = typeof raw['hintText'] === 'string' ? raw['hintText'] : undefined
  startPicking(keepAlive, hintText)
}

/**
 * Whether a value is a pick command.
 *
 * The shared guard lives in `background/wire.ts`, which this file cannot import
 * at runtime: that module is only ever loaded in a service worker, and a content
 * script that pulled in a worker module would bundle the bridge's dependencies
 * into every page in the browser. The tag, the kind and the two field types are
 * the entire contract, and they are re-checked here rather than trusted.
 */
function isPickCommandShape(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  if (value['tag'] !== WIRE_TAG) return false
  if (value['kind'] !== 'pick-command') return false
  if (value['command'] !== 'start' && value['command'] !== 'stop') return false
  return typeof value['keepAlive'] === 'boolean'
}

/**
 * Build the description of this frame's document.
 *
 * `frameKind` is this frame's own answer about itself and nothing more: a
 * content script can tell whether it is the top document but cannot know how
 * the worker will route to it, so no claim about the tab's frame tree is made
 * here.
 */
function describePage(): PageDescription {
  return {
    url: documentUrl(),
    title: documentTitle(),
    frameKind: isTopFrame() ? 'top' : 'sub',
  }
}

/**
 * Answer one panel request.
 *
 * Called for every frame of the tab by the worker's relay, and most frames
 * answer `unsupported`: a pick belongs to exactly one document, and `probe`
 * resolving an id in two frames would claim an element exists twice. `describe-page`
 * is the exception — it is a question about the frame itself, which every frame
 * is the authority on.
 *
 * @param request - the narrowed request.
 * @returns the response, in the shape `isPageResponse` accepts.
 */
function answerPanelRequest(request: PanelRequest): PageResponse {
  switch (request.type) {
    case 'annotate:describe-page':
      return { ok: true, kind: 'page', page: describePage() }

    case 'annotate:start-picking': {
      // Arming from the panel is a one-shot pick, not a pass: the panel's own
      // comment box appears on the first pick.
      startPicking(false, undefined)
      return { ok: true, kind: 'picking', active: isPicking() }
    }

    case 'annotate:stop-picking':
      stopPicking()
      return { ok: true, kind: 'picking', active: isPicking() }

    case 'annotate:flash':
      return { ok: true, kind: 'flashed', found: flashElement(request.elementId) }

    case 'annotate:probe': {
      const alive = request.elementIds.filter((id) => elementRegistry.elementFor(id) !== null)
      return { ok: true, kind: 'probe', alive }
    }

    default:
      // Reached when `panel/messages.ts` grows a request this build does not
      // implement. Answering `unsupported` is what makes that a visible gap in
      // the panel rather than a request that times out with no explanation.
      return unsupported('this frame does not implement that request')
  }
}

/** An `unsupported` answer, which is the whole vocabulary for "I cannot". */
function unsupported(detail: string): PageResponse {
  return { ok: false, kind: 'unsupported', detail }
}

/**
 * Narrow a panel request.
 *
 * @param value - the value received from the message channel.
 * @returns the request, or `null` when it is not one this frame should answer.
 */
function parsePanelRequest(value: unknown): PanelRequest | null {
  if (!isRecord(value)) return null
  const type = value['type']
  switch (type) {
    case 'annotate:describe-page':
    case 'annotate:start-picking':
    case 'annotate:stop-picking':
      return { type }
    case 'annotate:flash': {
      const elementId = readElementId(value['elementId'])
      return elementId === null ? null : { type, elementId }
    }
    case 'annotate:probe':
      return { type, elementIds: readElementIds(value['elementIds']) }
    default:
      return null
  }
}

/**
 * The single message listener.
 *
 * It answers synchronously for every message it owns, and returns `undefined`
 * for everything else. Returning `true` would promise a later `sendResponse`,
 * and promising one for a message another listener handles leaves that
 * listener's channel dead until it times out.
 *
 * @param rawMessage - the message, of unknown shape by construction.
 * @param _sender - unused: a content script learns nothing from a sender it
 *   cannot verify, and the ids it needs are in the payload.
 * @param sendResponse - the reply channel.
 * @returns `undefined` always; this listener never answers asynchronously.
 */
function onMessage(
  rawMessage: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): undefined {
  if (isPickCommandShape(rawMessage)) {
    handlePickCommand(rawMessage)
    // Answered so the worker's `sendMessage` resolves rather than reporting a
    // channel that opened and was never closed.
    sendResponse({ ok: true })
    return undefined
  }

  const request = parsePanelRequest(rawMessage)
  if (request === null) return undefined
  sendResponse(answerPanelRequest(request))
  return undefined
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/** The frame's state, or `null` when this script is not installed here. */
function stateOf(): FrameState | null {
  const global = globalThis as EntryGlobal
  return global[STATE_SLOT] ?? null
}

/**
 * Install this content script into the frame.
 *
 * Idempotent on purpose. The manifest declares the script for every matching
 * document, and the worker additionally injects it on demand when a tab predates
 * the extension's install or reload — so a frame can receive this file twice.
 * A second run must be a no-op rather than a second listener answering every
 * message twice.
 *
 * @returns whether this run installed the script (as opposed to finding it).
 */
export function bootstrapContentScript(): boolean {
  const global = globalThis as EntryGlobal
  if (global[STATE_SLOT] !== undefined) return false

  const state: FrameState = { handedOver: new Set<string>() }
  global[STATE_SLOT] = state

  // An overlay left by a previous instance of this script — an extension reload
  // does not remove what the old copy appended to the document — is cleared by
  // `armPicking`, which runs before any new overlay is created. Nothing is
  // cleared here, because clearing an overlay this frame never owned would be
  // removing another instance's work while that instance is still running.
  try {
    chrome.runtime.onMessage.addListener(onMessage)
  } catch {
    // A frame with no extension runtime — an `executeScript` recovery race, or
    // a document that lost its context between the check and this line. The
    // page keeps working, which is the only acceptable outcome for a frame the
    // user did not ask to annotate.
    return false
  }

  void sendToWorker(envelopeFor('state-query', {}) as unknown as ContentMessage)
  return true
}

/**
 * Whether a value is a page-to-worker message this module would send.
 *
 * Exported so a caller can check a message against the contract without
 * importing `background/wire.ts`, which a content script must never load: that
 * module belongs to the service worker, and pulling it into a page would bundle
 * the worker's own dependencies into every document in the browser.
 *
 * @param value - the value to check.
 * @returns whether the shape is one the worker's parser accepts.
 */
export function isOwnWireMessage(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value['tag'] !== WIRE_TAG) return false
  const tabId = value['tabId']
  if (readInteger(tabId) === undefined) return false
  const frame = value['frame']
  if (!isRecord(frame)) return false
  if (readInteger(frame['frameId']) === undefined) return false
  const kind = value['kind']
  return kind === 'batch' || kind === 'picking-started' || kind === 'picking-ended' || kind === 'state-query'
}

bootstrapContentScript()
