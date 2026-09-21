/**
 * The extension's service worker: the only context that sees every tab, every
 * frame and the bridge at once.
 *
 * It has three jobs, in this order:
 *
 * 1. Hold the {@link BridgeClient}, so the DSH side has exactly one peer.
 * 2. Answer content scripts, resolving each message's tab and frame against the
 *    browser's own frame tree before any of it is trusted.
 * 3. Relay picking commands, in both directions.
 *
 * ## Why the worker owns frame resolution
 *
 * A content script cannot see its own frame ids, and its view of its ancestors
 * stops at the first cross-origin boundary. Every message therefore carries the
 * frame id the platform reported and the depth the page-side code estimated, and
 * the worker replaces the estimate with the authoritative value from
 * `webNavigation` before the batch goes anywhere. The page-side number is kept
 * as `reportedFrameDepth` rather than discarded: the two disagreeing is a signal,
 * and a signal that has been overwritten is no signal at all.
 *
 * ## Why the worker owns routing
 *
 * `chrome.runtime.sendMessage` from a content script carries no tab id in its
 * payload unless the sender puts one there, and a sender is the least reliable
 * narrator of its own origin. The ids used for routing come from
 * `sender.tab.id` and `sender.frameId`, which the browser fills in and a page
 * cannot forge.
 *
 * ## Why the worker holds no state
 *
 * MV3 stops an idle service worker and destroys everything in it. Every handler
 * below is written so that a worker started from cold by a single event does the
 * right thing: state that matters lives in `chrome.storage`, frame trees are
 * re-read per use and cached only briefly, and nothing assumes a previous event
 * already ran in this worker instance.
 *
 * @module
 */

import type { AnnotationBatch } from '../../../src/protocol.ts'
import { PROTOCOL_VERSION } from '../../../src/protocol.ts'
import {
  BridgeClient,
  INITIAL_STATUS,
  STORAGE_KEYS,
  describeStatus,
  readStatusRecord,
  type BridgeEnvironment,
  type BridgeHandlers,
  type BridgeStatus,
  type ConnectionState,
  type WebSocketLike,
} from './bridge-client.ts'
import { enrichBatch } from './enrich.ts'
import {
  MAX_FRAME_DEPTH,
  NO_PARENT,
  resolveFramePath,
  toFrameNodes,
  type FrameNode,
  type FramePath,
} from './frames.ts'
import {
  buildSubmittedBatch,
  describeSubmitGap,
  isReportableUrl,
  mergeFrameAnswers,
  noReceiver,
  pageRequest,
  pageResult,
  parsePanelCommand,
  parsePickedMessage,
  pickEndedReason,
  rejected,
  unsupportedAnswer,
  type PanelCommand,
  type PanelEvent,
} from './panel-channel.ts'
import { isPageResponse, type PageResponse, type PanelRequest } from '../panel/messages.ts'
import {
  isPickCommand,
  parseContentMessage,
  pickCommand,
  type ContentMessage,
  type FrameRef,
} from './wire.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Alarm names. Named constants because a typo in a string is a silent failure. */
const ALARM_KEEPALIVE = 'keepalive'
const ALARM_RECONNECT = 'reconnect'

/**
 * How long a tab's frame tree is reused.
 *
 * Long enough that a burst of picks in one tab costs one tree read, short enough
 * that a page which navigated in the meantime is not described by its old shape.
 * Frames can change between messages at any time, so this is a cache with an
 * explicit lie-by-at-most window rather than a source of truth.
 */
const FRAME_TREE_TTL_MS = 5_000

/** Most tabs whose frame tree is cached before the oldest entries are dropped. */
const FRAME_TREE_CACHE_LIMIT = 8

/**
 * How many frames one tab's in-flight batch may carry before a second page is
 * refused.
 *
 * The protocol already bounds a batch; this bounds how many frames can each
 * contribute one, so a page made of a thousand iframes cannot turn the user's
 * single click into a thousand submissions.
 */
const MAX_SUBMITTED_FRAMES_PER_TAB = 16

/** Badge colours, keyed by what the user needs to know at a glance. */
const BADGE_COLORS = {
  connected: '#2f9e44',
  working: '#f08c00',
  problem: '#c92a2a',
  idle: '#868e96',
} as const

// ---------------------------------------------------------------------------
// Frame tree cache
// ---------------------------------------------------------------------------

/** One cached frame tree. */
interface FrameTree {
  readonly nodes: readonly FrameNode[]
  /** When it was read, so staleness is measurable rather than guessed. */
  readonly readAt: number
}

/**
 * Small, explicitly bounded cache of per-tab frame trees.
 *
 * A `Map` keeps insertion order, so the oldest key is the first one out; that is
 * enough for a working set of a handful of tabs and avoids a dependency for what
 * is, in effect, an eight-entry cache.
 */
const frameTrees = new Map<number, FrameTree>()

/** Tabs whose frames have already contributed a batch, cleared on navigation. */
const submittedFrames = new Map<number, Set<number>>()

/**
 * Read a tab's frame tree, reusing a recent one.
 *
 * `getAllFrames` rejects for a tab that has closed between the message arriving
 * and the read, which is a routine race rather than a fault; that case resolves
 * to an empty tree and the caller reports an incomplete path.
 *
 * @param tabId - the tab to read.
 * @param now - current time, injected so the cache window is testable.
 * @returns the frame nodes, possibly empty.
 */
async function frameTreeFor(tabId: number, now: number): Promise<readonly FrameNode[]> {
  const cached = frameTrees.get(tabId)
  if (cached !== undefined && now - cached.readAt < FRAME_TREE_TTL_MS) return cached.nodes

  let nodes: readonly FrameNode[] = []
  try {
    nodes = toFrameNodes(await chrome.webNavigation.getAllFrames({ tabId }))
  } catch {
    // The tab is gone. An empty tree yields `complete: false` downstream, which
    // is the honest answer: the frame cannot be placed any more.
    nodes = []
  }
  frameTrees.set(tabId, { nodes, readAt: now })
  while (frameTrees.size > FRAME_TREE_CACHE_LIMIT) {
    const oldest = frameTrees.keys().next()
    if (oldest.done === true) break
    frameTrees.delete(oldest.value)
  }
  return nodes
}

/** Drop every cached fact about one tab. */
function forgetTab(tabId: number): void {
  frameTrees.delete(tabId)
  submittedFrames.delete(tabId)
}

// ---------------------------------------------------------------------------
// Batch enrichment
// ---------------------------------------------------------------------------

/**
 * Whether a frame has already contributed to this tab's current page.
 *
 * @param tabId - the tab.
 * @param frameId - the frame.
 * @param limit - most frames allowed to contribute.
 * @returns whether the frame may submit now.
 */
function allowFrameSubmission(tabId: number, frameId: number, limit: number): boolean {
  let frames = submittedFrames.get(tabId)
  if (frames === undefined) {
    frames = new Set<number>()
    submittedFrames.set(tabId, frames)
  }
  if (frames.has(frameId)) return true
  if (frames.size >= limit) return false
  frames.add(frameId)
  return true
}

// ---------------------------------------------------------------------------
// Picking relay
// ---------------------------------------------------------------------------

/**
 * Find the tab a bridge-initiated pick command should land in.
 *
 * The bridge may name a tab, but the DSH side does not know the browser's tab
 * ids — the ones it saw in an earlier message are a snapshot, and the user may
 * have closed that tab since. So a named tab is used when it still exists, and
 * anything else falls back to the tab the user is actually looking at. That is
 * what "start picking" means from the user's point of view regardless of which
 * ids the DSH side happens to be holding.
 *
 * @param requested - the tab named by the bridge, or `null`.
 * @returns the tab id to use, or `null` when there is no usable tab.
 */
async function resolveTargetTab(requested: number | null): Promise<number | null> {
  if (requested !== null) {
    try {
      const tab = await chrome.tabs.get(requested)
      if (tab.id !== undefined) return tab.id
    } catch (error: unknown) {
      report('warn', `[dsh-annotate] named tab ${requested} is gone: ${errorText(error)}`)
    }
  }
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    return active?.id ?? null
  } catch (error: unknown) {
    report('warn', `[dsh-annotate] could not resolve the active tab: ${errorText(error)}`)
    return null
  }
}

/**
 * Arm the picker in a tab's top frame.
 *
 * The top frame only, deliberately. Picking is driven by the page the user is
 * looking at, and arming every subframe would put a highlight layer inside each
 * embedded advert and tracker — which is both a privacy problem (the extension
 * waking frames the user never interacted with) and a usability one (two
 * overlays competing for the same pointer). The picker itself promotes a pick
 * made inside a nested frame, and the worker's frame resolution describes it
 * correctly either way.
 *
 * @param tabId - the tab to arm.
 * @param client - the bridge client, so the state can be announced.
 * @returns whether the command was delivered.
 */
async function startPickingInTab(tabId: number, client: BridgeClient): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId)
    const url = tab.url ?? ''
    if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('devtools://')) {
      // Extension pages and browser internals cannot host a content script, so
      // injecting is not merely pointless, it is rejected by the browser.
      report('warn', `[dsh-annotate] cannot annotate a privileged page: ${url}`)
      return false
    }
  } catch (error: unknown) {
    report('warn', `[dsh-annotate] could not inspect tab ${tabId}: ${errorText(error)}`)
    return false
  }

  const command = pickCommand('start', { keepAlive: true })
  try {
    // A frame id of 0 is the tab's top-level document. Addressing it explicitly
    // rather than broadcasting means a page with a hundred frames gets one
    // message, not a hundred.
    await chrome.tabs.sendMessage(tabId, command, { frameId: 0 })
    return true
  } catch (error: unknown) {
    report('warn', `[dsh-annotate] tab ${tabId} has no content script yet: ${errorText(error)}`)
  }

  // The content script is declared in the manifest, so it is normally already
  // there; it is absent when the tab predates the extension's install or reload.
  // Injecting on demand is what stops "reload the page first" from being the
  // user's problem.
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] })
    await chrome.tabs.sendMessage(tabId, command, { frameId: 0 })
    return true
  } catch (error: unknown) {
    report('error', `[dsh-annotate] could not arm picking in tab ${tabId}: ${errorText(error)}`)
    client.announcePage(tabId, '', '')
    return false
  }
}

/**
 * Disarm the picker everywhere it might be armed.
 *
 * Broadcast rather than targeted: the worker does not track which frames armed,
 * because that set is exactly the kind of in-memory state an MV3 worker loses.
 * Asking every frame is cheap, and a frame that was not picking answers "no"
 * rather than failing, so the broadcast is idempotent.
 *
 * @returns a promise that settles once every tab has been asked.
 */
async function stopPickingEverywhere(): Promise<void> {
  const command = pickCommand('stop', { keepAlive: false })
  let tabs: chrome.tabs.Tab[] = []
  try {
    tabs = await chrome.tabs.query({})
  } catch (error: unknown) {
    report('warn', `[dsh-annotate] could not enumerate tabs: ${errorText(error)}`)
    return
  }
  await Promise.all(tabs.map(async (tab) => {
    const tabId = tab.id
    if (tabId === undefined) return
    try {
      await chrome.tabs.sendMessage(tabId, command)
    } catch {
      // A tab without a content script, or one that navigated. Nothing to do:
      // if it has no content script it has no picker to disarm.
    }
  }))
}

// ---------------------------------------------------------------------------
// Panel relay
// ---------------------------------------------------------------------------

/**
 * How long a panel request waits for a content script before it is reported as
 * unanswered.
 *
 * Deliberately below the panel's own {@link PAGE_REQUEST_TIMEOUT_MS} of 3000ms.
 * The panel's deadline exists because `chrome.tabs.sendMessage` never settles
 * when nothing is listening; if the worker used the same value, the two timers
 * would race and the panel would sometimes report a timeout for a request the
 * worker was about to answer. Answering first makes the worker's verdict — which
 * can say *why* — the normal path, and leaves the panel's timer as a backstop
 * for the case where the worker itself is gone.
 */
const PANEL_REQUEST_TIMEOUT_MS = 2_000

/**
 * Correlates a frame answer with the request it belongs to.
 *
 * A counter rather than a random value: it only has to be unique among the
 * requests this worker instance has in flight, and an MV3 worker that restarts
 * has no in-flight requests by definition.
 */
let nextRequestId = 1

/**
 * Ask one tab's content scripts a question and merge what comes back.
 *
 * The request is broadcast to every frame rather than sent to frame 0. Only the
 * frame that rendered an element can answer for it, and an element inside a
 * cross-origin iframe is invisible to the top document — so addressing the top
 * frame would make the majority of picks unaddressable for `flash` and `probe`,
 * which are the two calls that exist to reach a picked element again.
 *
 * @param tabId - the tab to ask.
 * @param request - the panel's question.
 * @returns the merged answer, never a rejection.
 */
async function askTab(tabId: number, request: PanelRequest): Promise<unknown> {
  const requestId = `r${nextRequestId}`
  nextRequestId += 1

  let answers: unknown
  try {
    answers = await chrome.tabs.sendMessage(tabId, pageRequest(request, requestId))
  } catch (error: unknown) {
    // A tab with no content script, or one that navigated mid-call. Both are
    // ordinary: the panel is told there is no receiver rather than left waiting.
    report('warn', `[dsh-annotate] tab ${tabId} did not answer a panel request: ${errorText(error)}`)
    return noReceiver('That tab is not reachable. Reload the page and try again.')
  }

  const usable = collectFrameAnswers(answers, requestId)
  const merged = mergeFrameAnswers(request, usable)
  // Never `undefined`: an unanswered broadcast is reported as `unsupported`, so
  // the panel has an answer to render instead of waiting out its own deadline.
  return pageResult(merged ?? unsupportedAnswer('No frame in that tab could answer this request.'))
}

/**
 * Keep the answers that belong to this request and are well-formed.
 *
 * `chrome.tabs.sendMessage` resolves with an array when it broadcasts to several
 * frames — one entry per frame that replied — but the exact shape is a platform
 * detail, so both an array and a single value are accepted. Answers carrying a
 * different `requestId` are dropped: a slow frame answering a previous question
 * must not be read as the answer to this one.
 *
 * @param raw - whatever the platform resolved with.
 * @param requestId - the id this request was sent under.
 * @returns the usable answers, in arrival order.
 */
function collectFrameAnswers(raw: unknown, requestId: string): PageResponse[] {
  const entries = Array.isArray(raw) ? raw : [raw]
  const answers: PageResponse[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const message = entry as Record<string, unknown>
    if (message['tag'] !== 'dsh-annotate') continue
    if (message['kind'] !== 'panel-response') continue
    if (message['requestId'] !== requestId) continue
    const response = message['response']
    // The panel's guard, not a restatement of it: two copies of this predicate
    // would be two places for the worker and the panel to disagree about what a
    // usable answer is.
    if (isPageResponse(response)) answers.push(response)
  }
  return answers
}

/**
 * Handle one command from the panel.
 *
 * Every path returns a value. `sendResponse` is called exactly once for every
 * command the worker owns, including on failure — the alternative is a panel
 * that discovers a problem by timing out.
 *
 * @param command - the narrowed command.
 * @returns the result to send back.
 */
async function handlePanelCommand(command: PanelCommand): Promise<unknown> {
  if (command.type === 'annotate:page') {
    return askTab(command.tabId, command.request)
  }

  // A submission. The batch is rebuilt through the protocol's own guard rather
  // than trusted, because the panel's payload is only *part* of a batch: it
  // carries the id and the annotations, and a batch also needs the page it was
  // collected on. The worker declines to invent that page — see
  // {@link buildSubmittedBatch} — and says so in the panel's own vocabulary.
  const batch = buildSubmittedBatch(command, Date.now())
  if (batch === undefined) {
    report('warn', `[dsh-annotate] panel submission ${command.batchId} is missing page context`)
    return describeSubmitGap(command)
  }

  const tabId = command.tabId ?? (await activeTabId())
  if (tabId === null) {
    return rejected('failed', 'The batch names no tab, so its frame tree cannot be resolved.')
  }

  try {
    // Handed over BEFORE the connectivity check, deliberately. `sendBatch`
    // persists the batch and only then attempts delivery, so a batch submitted
    // while the bridge is down is still there when it comes back. Refusing
    // early on `isConnected()` would make the panel's own Retry button the only
    // thing standing between the user's work and a lost connection, and the
    // client's durability would never be reached.
    await client.sendBatch(batch, tabId)
  } catch (error: unknown) {
    return rejected('failed', errorText(error))
  }
  await refreshBadge(tabId)

  // `offline` specifically, and only after the batch is durably stored: it is
  // the reason the panel turns into a Retry button, and the stored batch is what
  // makes that retry — or the bridge's own reconnect — succeed.
  if (!client.isConnected()) {
    return rejected('offline', 'The local bridge is not connected; the batch was stored and will be sent when it is.')
  }
  return { ok: true, kind: 'submitted' }
}

/**
 * The active tab's id, when a submission did not name one.
 *
 * The panel is bound to one tab for its life and does not send that id with a
 * batch, so the worker resolves it the same way the toolbar action does. `null`
 * when there is genuinely no tab, which the caller reports rather than guessing.
 *
 * @returns the tab id, or `null`.
 */
async function activeTabId(): Promise<number | null> {
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    return active?.id ?? null
  } catch (error: unknown) {
    report('warn', `[dsh-annotate] could not resolve the active tab: ${errorText(error)}`)
    return null
  }
}

/**
 * Broadcast one event to the extension's own contexts, which is where the panel
 * listens.
 *
 * `chrome.runtime.sendMessage` rejects when nothing is listening — a panel that
 * is closed — and that is the normal case rather than a fault, so the rejection
 * is swallowed. The panel reads the message's `type`; everything else is carried
 * verbatim.
 *
 * @param event - the event to broadcast.
 */
function broadcastToPanel(event: PanelEvent): void {
  void Promise.resolve(chrome.runtime.sendMessage(event)).catch(() => undefined)
}

/**
 * Relay a pick reported by a content script through to the panel.
 *
 * The tab id comes from the browser (`sender.tab.id`), never from the payload: a
 * page cannot forge the former and can trivially forge the latter, and the panel
 * filters picks by tab so a forged id would deliver one page's pick to another
 * page's panel.
 *
 * NOTE: the content script does not send a `picked` message yet — the D-line
 * picker reports picks to its own caller. This relay is implemented so the panel
 * side is complete and the content script only has to add the send. Nothing here
 * invents a page-side implementation.
 *
 * @param raw - the message as received.
 * @param senderTabId - the tab the browser says it came from.
 * @returns whether the message was a pick and was relayed.
 */
function relayPick(raw: unknown, senderTabId: number): boolean {
  const pick = parsePickedMessage(raw)
  if (pick === undefined) return false
  broadcastToPanel({ ...pick, tabId: senderTabId })
  return true
}

// ---------------------------------------------------------------------------
// Status reporting
// ---------------------------------------------------------------------------

/**
 * Log through the worker console.
 *
 * One funnel so the extension's own prefix is uniform and no call site has to
 * remember it.
 *
 * @param level - console level.
 * @param message - the message, already prefixed by the caller's context.
 */
function report(level: 'info' | 'warn' | 'error', message: string): void {
  if (level === 'error') console.error(message)
  else if (level === 'warn') console.warn(message)
  else console.info(message)
}

/**
 * Render an unknown thrown value as text.
 *
 * @param error - the caught value.
 * @returns a string, never `[object Object]` for the common Error case.
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Repaint the toolbar badge from the persisted status.
 *
 * Read from storage rather than from a field so the badge is correct in a worker
 * that was started cold by an unrelated event — which is most worker starts.
 *
 * @param tabId - the tab to badge, or `null` for the global badge.
 */
async function refreshBadge(tabId: number | null): Promise<void> {
  let status = INITIAL_STATUS
  try {
    status = await readStatus()
  } catch {
    // Storage unavailable means the extension is being unloaded; the badge is
    // cosmetic and must never be the reason a worker start throws.
    return
  }

  const { text, color } = badgeFor(status.state)
  const scope = tabId === null ? {} : { tabId }
  try {
    await chrome.action.setBadgeText({ text, ...scope })
    await chrome.action.setBadgeBackgroundColor({ color, ...scope })
    await chrome.action.setTitle({ title: `dsh-annotate — ${describeStatus(status)}`, ...scope })
  } catch {
    // A tab that closed between the read and the write. Cosmetic; ignored.
  }
}

/**
 * The badge text and colour for one connection state.
 *
 * Pulled out of {@link refreshBadge} because the state-to-badge mapping is a
 * small table that reads far better as one, and because it is the part worth
 * testing without a browser.
 *
 * @param state - the connection state.
 * @returns the badge text, kept to two characters so it fits, and its colour.
 */
export function badgeFor(state: ConnectionState): { text: string; color: string } {
  switch (state) {
    case 'connected':
      return { text: 'ON', color: BADGE_COLORS.connected }
    case 'connecting':
    case 'reconnecting':
      return { text: '…', color: BADGE_COLORS.working }
    case 'unauthorized':
    case 'incompatible':
      return { text: '!', color: BADGE_COLORS.problem }
    case 'unpaired':
      // Blank rather than a marker: an unpaired extension is the state a fresh
      // install is in, and a permanent warning badge for "you have not set this
      // up yet" trains the user to ignore the badge.
      return { text: '', color: BADGE_COLORS.idle }
  }
}

/** Read the persisted status for badge and tooltip text. */
async function readStatus(): Promise<BridgeStatus> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.status)
  return readStatusRecord(stored[STORAGE_KEYS.status])
}

// ---------------------------------------------------------------------------
// Platform seams
// ---------------------------------------------------------------------------

/** Cap on how many bytes of a page title reach the bridge's log. */
const MAX_ANNOUNCED_TITLE = 120

/** The real platform, bound once so the client never touches a global directly. */
const environment: BridgeEnvironment = {
  storage: {
    get: (keys: string) => chrome.storage.local.get(keys),
    set: (items: Record<string, unknown>) => chrome.storage.local.set(items),
    remove: (keys: string | readonly string[]) => chrome.storage.local.remove(keys),
  },
  connect: (url: string): WebSocketLike => new WebSocket(url) as unknown as WebSocketLike,
  setAlarm: (name: string, info): void => {
    if (info === null) {
      // `clear` rejects if the alarm does not exist in some builds, so the
      // promise is swallowed: cancelling an absent alarm is success.
      void chrome.alarms.clear(name).catch(() => undefined)
      return
    }
    void chrome.alarms.create(name, info).catch(() => undefined)
  },
  now: () => Date.now(),
  extensionId: () => chrome.runtime.id ?? 'unknown',
  setTimeout: (handler: () => void, ms: number): number => globalThis.setTimeout(handler, ms) as unknown as number,
  clearTimeout: (handle: number): void => { globalThis.clearTimeout(handle) },
  setInterval: (handler: () => void, ms: number): number => globalThis.setInterval(handler, ms) as unknown as number,
  clearInterval: (handle: number): void => { globalThis.clearInterval(handle) },
  log: (level, message) => { report(level, message) },
}

// ---------------------------------------------------------------------------
// Worker body
// ---------------------------------------------------------------------------

/** Handlers the client calls when the bridge pushes something. */
const handlers: BridgeHandlers = {
  onStartPicking: (tabId) => {
    void (async () => {
      const target = await resolveTargetTab(tabId)
      if (target === null) {
        report('warn', '[dsh-annotate] start-picking ignored: no tab to arm')
        return
      }
      await startPickingInTab(target, client)
      await refreshBadge(target)
    })()
  },
  onStopPicking: () => {
    void stopPickingEverywhere().then(() => refreshBadge(null))
  },
  onAllowOnline: (allowOnline) => {
    // Persisted, not held: the content script reads this to decide whether it may
    // work on a non-loopback page, and it must see the same answer after a
    // worker recycle as it did before.
    void chrome.storage.local.set({ 'privacy.allowOnline': allowOnline }).then(() => {
      report('info', `[dsh-annotate] online access ${allowOnline ? 'enabled' : 'disabled'}`)
    })
  },
  onBatchAcked: (batchId) => {
    report('info', `[dsh-annotate] batch ${batchId} accepted`)
    void refreshBadge(null)
  },
  onBatchRejected: (batchId, message) => {
    report('error', `[dsh-annotate] batch ${batchId} refused: ${message}`)
    void refreshBadge(null)
  },
}

const client = new BridgeClient({ env: environment, handlers })

/**
 * Handle one batch from a content script.
 *
 * @param message - the narrowed message.
 * @param senderTabId - the tab the browser says it came from.
 * @param senderFrameId - the frame the browser says it came from.
 * @param now - current time.
 * @returns a promise that settles once the batch has been handed to the client.
 */
async function handleBatch(
  message: ContentMessage & { kind: 'batch' },
  senderTabId: number,
  senderFrameId: number,
  now: number,
): Promise<void> {
  // The ids from the sender are used for routing, never the ones in the payload:
  // the browser fills these in and a page cannot forge them, which is exactly
  // the property the payload lacks.
  const tabId = senderTabId
  const frame: FrameRef = { frameId: senderFrameId, url: message.frame.url }

  if (!allowFrameSubmission(tabId, senderFrameId, MAX_SUBMITTED_FRAMES_PER_TAB)) {
    report('warn', `[dsh-annotate] ignoring a batch: tab ${tabId} already has ${MAX_SUBMITTED_FRAMES_PER_TAB} contributing frames`)
    return
  }

  const nodes = await frameTreeFor(tabId, now)
  const path = resolveFramePath(nodes, frame.frameId)
  const batch = enrichBatch(message.batch, path)

  if (!path.complete) {
    // The frame tree did not describe this frame, so the depth is a floor rather
    // than an answer. The batch still goes: a slightly uncertain depth is worth
    // far more to the reader than no annotation at all, and the reader can see
    // the uncertainty in `reportedFrameDepth`.
    report('warn', `[dsh-annotate] frame ${frame.frameId} of tab ${tabId} is missing from the frame tree; depth is a lower bound`)
  }

  report('info', `[dsh-annotate] batch ${batch.batchId}: ${batch.annotations.length} annotation(s), frame ${path.label} (depth ${path.depth})`)
  await client.sendBatch(batch, tabId)
  await refreshBadge(tabId)
}

/**
 * The message listener.
 *
 * It must answer synchronously with `undefined` for anything it does not own.
 * Returning `true` promises a later `sendResponse`, and promising one for a
 * message addressed to another listener leaves that listener's channel dead.
 */
function onMessage(
  rawMessage: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean | undefined {
  // Panel commands are checked first and answer asynchronously, because neither
  // routing branch can complete synchronously: asking a tab is a round trip and
  // handing a batch to the bridge awaits storage. The sender here is an
  // extension page, so `sender.tab` is absent by construction — which is exactly
  // why the panel's own commands carry their tab id in the payload.
  const command = parsePanelCommand(rawMessage)
  if (command !== undefined) {
    void handlePanelCommand(command).then(
      (result) => { sendResponse(result) },
      (error: unknown) => {
        // A throw inside the worker must still produce an answer. Falling
        // through to silence here would leave the panel waiting out its own
        // timeout for a reply the worker could have given immediately.
        report('error', `[dsh-annotate] panel command ${command.type} failed: ${errorText(error)}`)
        sendResponse(rejected('failed', errorText(error)))
      },
    )
    return true
  }

  const message = parseContentMessage(rawMessage)
  if (message === undefined) {
    // Not part of the content-script wire. It may still be a pick the picker is
    // reporting, which the panel needs; anything else belongs to another
    // listener and is left alone so that listener's channel stays open.
    const senderTabId = sender.tab?.id
    if (senderTabId !== undefined) relayPick(rawMessage, senderTabId)
    return undefined
  }

  // A content script always has both; an extension page that happened to send a
  // tagged message does not, and routing it would invent an origin.
  const tabId = sender.tab?.id
  const frameId = sender.frameId
  if (tabId === undefined || frameId === undefined) return undefined

  const now = Date.now()
  switch (message.kind) {
    case 'batch':
      void handleBatch(message, tabId, frameId, now)
      sendResponse({ accepted: true })
      return undefined
    case 'picking-started':
      report('info', `[dsh-annotate] picking armed in tab ${tabId} frame ${frameId}`)
      sendResponse({ ok: true })
      return undefined
    case 'picking-ended':
      report('info', `[dsh-annotate] picking ended in tab ${tabId} frame ${frameId}: ${message.reason}`)
      // Relayed to the panel so a mode the user ended on the page (Esc) stops
      // being shown as running. The reason is mapped onto the panel's own
      // vocabulary: a reason it does not know would fail its guard and the
      // broadcast would be dropped, leaving the panel claiming a mode that has
      // already ended.
      broadcastToPanel({ type: 'annotate:pick-ended', reason: pickEndedReason(message.reason) })
      sendResponse({ ok: true })
      return undefined
    case 'state-query':
      // Answered asynchronously because reading storage is asynchronous, and the
      // sender needs the real value rather than a default it might act on.
      void (async () => {
        const stored = await chrome.storage.local.get('privacy.allowOnline')
        const allowOnline = stored['privacy.allowOnline'] === true
        const status = await readStatus()
        sendResponse({
          connected: client.isConnected(),
          allowOnline,
          port: client.currentPort(),
          protocolVersion: PROTOCOL_VERSION,
          maxFrameDepth: MAX_FRAME_DEPTH,
          state: status.state,
          message: describeStatus(status),
        })
      })()
      return true
  }
}

/**
 * Start the worker's long-lived parts.
 *
 * Idempotent by construction: `BridgeClient.start()` re-reads storage and returns
 * early when a socket is already live, so a worker that is started repeatedly for
 * one user action still ends up with exactly one connection.
 */
function start(): void {
  void client.start().catch((error: unknown) => {
    report('error', `[dsh-annotate] bridge client failed to start: ${errorText(error)}`)
  })
  void refreshBadge(null)
}

chrome.runtime.onMessage.addListener(onMessage)

chrome.runtime.onInstalled.addListener((details) => {
  report('info', `[dsh-annotate] worker installed (${details.reason})`)
  start()
})

// The worker can be started by any event, including the two alarms below, and
// `onStartup` never fires for a worker that the platform merely recycled. These
// three are therefore the complete set of entry points, and each one is cheap
// when the work is already done.
chrome.runtime.onStartup?.addListener(() => { start() })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_KEEPALIVE) {
    // The socket is open and the alarm exists only to stop the worker being
    // recycled under it; touching the connection is the whole point.
    client.ping()
    return
  }
  if (alarm.name === ALARM_RECONNECT) {
    start()
  }
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  // A token or port typed into the settings page must take effect without the
  // user having to reload the extension, so the client re-reads its config and
  // reconnects when either changed.
  if (STORAGE_KEYS.token in changes || STORAGE_KEYS.port in changes) {
    void client.reloadConfiguration().then(() => { start() })
    return
  }
  if (STORAGE_KEYS.status in changes) {
    void refreshBadge(null)
  }
})

chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    if (tab.id === undefined) return
    if (client.isConnected()) {
      // The toolbar button is the user's toggle: connected means "put the
      // picker in this tab", and pressing it again takes the picker away.
      await startPickingInTab(tab.id, client)
      await refreshBadge(tab.id)
      return
    }
    // Not connected is the one case where the user needs words rather than a
    // toggle, and the badge cannot carry a sentence. The status is already in
    // storage for the settings page; this makes the reason visible immediately.
    const status = await readStatus()
    report('warn', `[dsh-annotate] ${describeStatus(status)}`)
    await refreshBadge(tab.id)
  })()
})

chrome.tabs.onRemoved.addListener((tabId) => { forgetTab(tabId) })
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // A navigation invalidates both the frame tree and the set of frames that have
  // already submitted, because the new document's ids are unrelated to the old
  // one's.
  if (changeInfo.status === 'loading') forgetTab(tabId)
  // The panel's own `describe-page` round trip is what tells it which page it is
  // describing, but a navigation the user did not initiate in the panel — a
  // redirect, a link followed on the page itself — would otherwise not reach it
  // until the next interaction. The broadcast carries the URL so the panel can
  // behave without a further round trip.
  if (changeInfo.status === 'complete') {
    const url = tab.url ?? ''
    if (isReportableUrl(url)) broadcastToPanel({ type: 'annotate:page-changed', url })
  }
})

// The worker is started by the platform, not by this file being imported, but an
// explicit call keeps the first run deterministic when the platform starts the
// worker for `onInstalled` or an alarm.
start()

/**
 * The frame ids this module reports for a top-level document.
 *
 * Re-exported so the content script and the panel can talk about "the top frame"
 * without each hard-coding the platform's sentinel.
 */
export const TOP_FRAME_ID = 0

export { NO_PARENT, resolveFramePath, toFrameNodes }
export type { FrameNode, FramePath }
