/**
 * Tests for the service worker's side of the panel's message protocol.
 *
 * Two layers are exercised, and the split is deliberate.
 *
 * - The pure routing decisions — narrowing a panel command, merging answers that
 *   came back from several frames, deciding why a submission cannot be
 *   delivered — are tested directly against `panel-channel.ts`. They are the
 *   parts with real logic in them, and they need no platform at all.
 * - The whole entry point is then driven through a `chrome` stand-in that
 *   captures the listeners the worker registers. That is the only way to reach
 *   `handlePanelCommand`, which is what actually answers the panel, and the
 *   assertions that matter there are about the two properties the panel depends
 *   on: it always gets an answer, and the answer says the right thing.
 *
 * No browser is involved anywhere. The stand-in is a plain object.
 */

import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'

import {
  buildSubmittedBatch,
  describeSubmitGap,
  isReportableUrl,
  mergeFrameAnswers,
  noReceiver,
  pageRequest,
  pageResult,
  parsePanelCommand,
  parsePanelRequest,
  parsePickedMessage,
  pickEndedReason,
  rejected,
  unsupportedAnswer,
} from '../extension/src/background/panel-channel.ts'
import { PROTOCOL_VERSION, type AnnotationBatch, type PageContext } from '../src/protocol.ts'
import type { PageResponse } from '../extension/src/panel/messages.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A page context of the shape the panel holds for a picked element. */
function pageContext(): PageContext {
  return {
    url: 'https://example.test/settings',
    kind: 'https',
    viewport: { width: 800, height: 600 },
  }
}

/** One annotation, carrying the minimum a batch validator requires. */
function annotation(id = 'a1'): Record<string, unknown> {
  return {
    id,
    pickedAt: 1,
    facts: {
      tag: 'button',
      selector: 'button.save',
      selectorMatches: 1,
      rect: { x: 1, y: 2, width: 3, height: 4 },
      inViewport: true,
      frameDepth: 0,
    },
  }
}

/** A complete batch, for the "the widened payload actually delivers" case. */
function completeBatch(): AnnotationBatch {
  return {
    version: PROTOCOL_VERSION,
    batchId: 'b1',
    page: pageContext(),
    annotations: [annotation() as unknown as AnnotationBatch['annotations'][number]],
    submittedAt: 42,
  }
}

/** A panel submission with the fields the published contract guarantees. */
function submitCommand(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'annotate:submit', batchId: 'b1', annotations: [annotation()], ...extra }
}

// ---------------------------------------------------------------------------
// parsePanelCommand
// ---------------------------------------------------------------------------

describe('parsePanelCommand', () => {
  it('accepts a page request naming a tab', () => {
    const command = parsePanelCommand({
      type: 'annotate:page',
      tabId: 7,
      request: { type: 'annotate:describe-page' },
    })
    assert.equal(command?.type, 'annotate:page')
    assert.equal(command?.type === 'annotate:page' ? command.tabId : null, 7)
  })

  it('refuses a page request with no usable tab id', () => {
    const request = { type: 'annotate:describe-page' }
    assert.equal(parsePanelCommand({ type: 'annotate:page', request }), undefined)
    assert.equal(parsePanelCommand({ type: 'annotate:page', tabId: '7', request }), undefined)
    assert.equal(parsePanelCommand({ type: 'annotate:page', tabId: 1.5, request }), undefined)
  })

  it('refuses a page request whose request is not one of the five', () => {
    assert.equal(parsePanelCommand({ type: 'annotate:page', tabId: 7, request: { type: 'nope' } }), undefined)
    assert.equal(parsePanelCommand({ type: 'annotate:page', tabId: 7, request: null }), undefined)
  })

  it('accepts a submission carrying only the published fields', () => {
    const command = parsePanelCommand(submitCommand())
    assert.equal(command?.type, 'annotate:submit')
    assert.equal(command?.type === 'annotate:submit' ? command.batchId : null, 'b1')
    assert.equal(command?.type === 'annotate:submit' ? command.page : 'unset', undefined)
  })

  it('reads the widened fields when the panel supplies them', () => {
    const command = parsePanelCommand(submitCommand({ page: pageContext(), submittedAt: 5, tabId: 9 }))
    assert.ok(command?.type === 'annotate:submit')
    assert.deepEqual(command.page, pageContext())
    assert.equal(command.submittedAt, 5)
    assert.equal(command.tabId, 9)
  })

  it('refuses a submission with no batch id or no annotation list', () => {
    assert.equal(parsePanelCommand({ type: 'annotate:submit', annotations: [] }), undefined)
    assert.equal(parsePanelCommand({ type: 'annotate:submit', batchId: '', annotations: [] }), undefined)
    assert.equal(parsePanelCommand({ type: 'annotate:submit', batchId: 'b1' }), undefined)
    assert.equal(parsePanelCommand({ type: 'annotate:submit', batchId: 'b1', annotations: 'nope' }), undefined)
  })

  it('ignores a message that is neither command, leaving it to other listeners', () => {
    // The panel's own broadcasts are the important case: the worker sends those
    // and must never mistake one for a command addressed to itself.
    assert.equal(parsePanelCommand({ type: 'annotate:pick-ended', reason: 'escape' }), undefined)
    assert.equal(parsePanelCommand({ type: 'annotate:picked', tabId: 1 }), undefined)
    assert.equal(parsePanelCommand({ tag: 'dsh-annotate', kind: 'state-query' }), undefined)
    assert.equal(parsePanelCommand(null), undefined)
    assert.equal(parsePanelCommand('annotate:page'), undefined)
  })
})

describe('parsePanelRequest', () => {
  it('accepts each of the five requests', () => {
    assert.deepEqual(parsePanelRequest({ type: 'annotate:describe-page' }), { type: 'annotate:describe-page' })
    assert.deepEqual(parsePanelRequest({ type: 'annotate:start-picking' }), { type: 'annotate:start-picking' })
    assert.deepEqual(parsePanelRequest({ type: 'annotate:stop-picking' }), { type: 'annotate:stop-picking' })
    assert.deepEqual(parsePanelRequest({ type: 'annotate:flash', elementId: 'el-1' }), {
      type: 'annotate:flash',
      elementId: 'el-1',
    })
    assert.deepEqual(parsePanelRequest({ type: 'annotate:probe', elementIds: ['el-1'] }), {
      type: 'annotate:probe',
      elementIds: ['el-1'],
    })
  })

  it('refuses a flash with no element id', () => {
    assert.equal(parsePanelRequest({ type: 'annotate:flash' }), undefined)
    assert.equal(parsePanelRequest({ type: 'annotate:flash', elementId: 7 }), undefined)
  })

  it('refuses a probe whose ids are not all strings', () => {
    assert.equal(parsePanelRequest({ type: 'annotate:probe' }), undefined)
    assert.equal(parsePanelRequest({ type: 'annotate:probe', elementIds: ['el-1', 2] }), undefined)
    // An empty probe is legitimate: the panel short-circuits it, but a frame
    // answering one is not an error.
    assert.deepEqual(parsePanelRequest({ type: 'annotate:probe', elementIds: [] }), {
      type: 'annotate:probe',
      elementIds: [],
    })
  })
})

// ---------------------------------------------------------------------------
// mergeFrameAnswers
// ---------------------------------------------------------------------------

/** A page description answer, built as the declared union member. */
function pageAnswer(url: string, title: string, frameKind: 'top' | 'sub'): PageResponse {
  return { ok: true, kind: 'page', page: { url, title, frameKind } }
}

/** A picking answer. */
function pickingAnswer(active: boolean): PageResponse {
  return { ok: true, kind: 'picking', active }
}

/** A flash answer. */
function flashedAnswer(found: boolean): PageResponse {
  return { ok: true, kind: 'flashed', found }
}

/** A probe answer. */
function probeAnswer(alive: string[]): PageResponse {
  return { ok: true, kind: 'probe', alive }
}

/** The answer a frame gives when it cannot answer at all. */
function unsupportedResponse(detail = 'no'): PageResponse {
  return { ok: false, kind: 'unsupported', detail }
}

describe('mergeFrameAnswers', () => {
  it('reports no answer when no frame answered', () => {
    assert.equal(mergeFrameAnswers({ type: 'annotate:describe-page' }, []), undefined)
    assert.equal(mergeFrameAnswers({ type: 'annotate:probe', elementIds: ['a'] }, []), undefined)
  })

  it('prefers the top document when describing the page', () => {
    const sub = pageAnswer('https://frame.test/', 'Ad', 'sub')
    const top = pageAnswer('https://example.test/', 'Page', 'top')
    // Order is not the discriminator: the subframe answers first here and the
    // top frame must still win, or every page with an iframe would be mislabelled.
    assert.deepEqual(mergeFrameAnswers({ type: 'annotate:describe-page' }, [sub, top]), top)
    assert.deepEqual(mergeFrameAnswers({ type: 'annotate:describe-page' }, [top, sub]), top)
  })

  it('falls back to a subframe description when no frame claims the top', () => {
    const sub = pageAnswer('https://frame.test/', 'Ad', 'sub')
    assert.deepEqual(mergeFrameAnswers({ type: 'annotate:describe-page' }, [sub]), sub)
  })

  it('ignores an unsupported answer when a real one exists', () => {
    const top = pageAnswer('https://example.test/', 'P', 'top')
    assert.deepEqual(mergeFrameAnswers({ type: 'annotate:describe-page' }, [unsupportedResponse(), top]), top)
  })

  it('unions the alive ids of every frame for a probe', () => {
    const answers = [probeAnswer(['el-1']), probeAnswer(['el-2', 'el-1'])]
    const merged = mergeFrameAnswers({ type: 'annotate:probe', elementIds: ['el-1', 'el-2'] }, answers)
    assert.deepEqual(merged, { ok: true, kind: 'probe', alive: ['el-1', 'el-2'] })
  })

  it('does not invent liveness from a frame that could not answer', () => {
    // A frame reporting `unsupported` must not be read as "everything is gone":
    // the ids it did not see may belong to a frame that answered properly.
    const merged = mergeFrameAnswers({ type: 'annotate:probe', elementIds: ['el-1'] }, [unsupportedResponse()])
    assert.equal(merged, undefined)
  })

  it('reports a flash as found when any frame found it', () => {
    const answers = [flashedAnswer(false), flashedAnswer(true)]
    assert.deepEqual(mergeFrameAnswers({ type: 'annotate:flash', elementId: 'el-1' }, answers), {
      ok: true,
      kind: 'flashed',
      found: true,
    })
  })

  it('reports a flash as not found when no frame found it', () => {
    const merged = mergeFrameAnswers({ type: 'annotate:flash', elementId: 'el-1' }, [flashedAnswer(false)])
    assert.deepEqual(merged, { ok: true, kind: 'flashed', found: false })
  })

  it('keeps the first picking answer rather than letting a later frame overwrite it', () => {
    const answers = [pickingAnswer(true), pickingAnswer(false)]
    assert.deepEqual(mergeFrameAnswers({ type: 'annotate:start-picking' }, answers), {
      ok: true,
      kind: 'picking',
      active: true,
    })
  })

  it('ignores a picking answer that is not about picking', () => {
    assert.equal(mergeFrameAnswers({ type: 'annotate:stop-picking' }, [unsupportedResponse()]), undefined)
  })
})

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

describe('panel results', () => {
  it('wraps a page answer in the declared command result', () => {
    const response = unsupportedAnswer('nothing there')
    assert.deepEqual(pageResult(response), { ok: true, kind: 'page', value: response })
  })

  it('names the reason a tab could not be reached', () => {
    // `no-receiver` specifically: the panel renders any other kind as a different
    // problem, and this is the one that does not offer a Retry button.
    const result = noReceiver('no content script')
    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.kind : null, 'no-receiver')
  })

  it('carries the submission failure reason the panel switches on', () => {
    const reasons: Array<Parameters<typeof rejected>[0]> = ['offline', 'forbidden', 'invalid', 'failed']
    for (const reason of reasons) {
      const result = rejected(reason, 'why')
      assert.ok(result.ok === false && result.kind === 'rejected')
      assert.equal(result.reason, reason)
      assert.equal(result.detail, 'why')
    }
  })
})

// ---------------------------------------------------------------------------
// Batch assembly
// ---------------------------------------------------------------------------

function submitOf(extra: Record<string, unknown>): Parameters<typeof buildSubmittedBatch>[0] {
  return parsePanelCommand(submitCommand(extra)) as Parameters<typeof buildSubmittedBatch>[0]
}

describe('buildSubmittedBatch', () => {
  it('builds a deliverable batch from a widened payload', () => {
    const batch = buildSubmittedBatch(submitOf({ page: pageContext(), submittedAt: 42 }), 999)
    assert.ok(batch !== undefined)
    assert.equal(batch.batchId, 'b1')
    assert.equal(batch.version, PROTOCOL_VERSION)
    // The supplied timestamp wins: the worker must not stamp its own arrival time
    // over a fact the panel already knows.
    assert.equal(batch.submittedAt, 42)
    assert.deepEqual(batch.page, pageContext())
  })

  it('carries the address of the frame the element was picked in', () => {
    // The whole reason `page` travels with the submission: this URL is a
    // subframe's, and the tab's own URL is a different one. A batch stamped with
    // the tab URL would misdescribe the element.
    const framed = pageContext()
    framed.url = 'https://widget.example.net/inner'
    const batch = buildSubmittedBatch(submitOf({ page: framed }), 999)
    assert.equal(batch?.page.url, 'https://widget.example.net/inner')
  })

  it('stamps the given time only when the payload carries none', () => {
    const batch = buildSubmittedBatch(submitOf({ page: pageContext() }), 999)
    assert.equal(batch?.submittedAt, 999)
  })

  it('refuses a payload with no page rather than inventing one', () => {
    assert.equal(buildSubmittedBatch(submitOf({}), 999), undefined)
  })

  it('refuses a page the protocol does not accept', () => {
    assert.equal(buildSubmittedBatch(submitOf({ page: { url: '' } }), 999), undefined)
    assert.equal(buildSubmittedBatch(submitOf({ page: { url: 'https://a.test', kind: 'gemini' } }), 999), undefined)
    assert.equal(buildSubmittedBatch(submitOf({ page: 'https://a.test' }), 999), undefined)
  })

  it('refuses a batch whose annotations do not validate', () => {
    const bad = submitCommand({ page: pageContext(), annotations: [{ id: 'a1' }] })
    assert.equal(buildSubmittedBatch(parsePanelCommand(bad) as Parameters<typeof buildSubmittedBatch>[0], 999), undefined)
  })

  it('round-trips a complete batch unchanged', () => {
    const complete = completeBatch()
    const batch = buildSubmittedBatch(
      {
        type: 'annotate:submit',
        batchId: complete.batchId,
        annotations: complete.annotations,
        page: complete.page,
        ...{ submittedAt: complete.submittedAt, version: complete.version },
      } as Parameters<typeof buildSubmittedBatch>[0],
      999,
    )
    assert.deepEqual(batch, complete)
  })
})

describe('describeSubmitGap', () => {
  it('names the missing field when the page was not supplied', () => {
    const result = describeSubmitGap(submitOf({}))
    assert.ok(result.ok === false && result.kind === 'rejected')
    // `invalid`, not `failed`: the panel renders this without a Retry button,
    // because resending an unformable payload cannot fix it.
    assert.equal(result.reason, 'invalid')
    assert.match(result.detail, /page/i)
  })

  it('uses `invalid` for any payload that is not a batch', () => {
    const result = describeSubmitGap(submitOf({ page: { url: '' } }))
    assert.ok(result.ok === false && result.kind === 'rejected')
    assert.equal(result.reason, 'invalid')
  })

  it('never returns a success result', () => {
    assert.equal(describeSubmitGap(submitOf({})).ok, false)
    assert.equal(describeSubmitGap(submitOf({ page: pageContext() })).ok, false)
  })
})

// ---------------------------------------------------------------------------
// Content-script relay narrowing
// ---------------------------------------------------------------------------

describe('parsePickedMessage', () => {
  it('accepts a pick carrying an id, facts and a page', () => {
    const pick = parsePickedMessage({
      tag: 'dsh-annotate',
      kind: 'picked',
      elementId: 'el-4',
      facts: { tag: 'button', selector: 'button.save' },
      page: { url: 'https://example.test/', title: 'Example' },
    })
    assert.ok(pick !== undefined)
    assert.equal(pick.elementId, 'el-4')
    assert.equal(pick.type, 'annotate:picked')
    assert.deepEqual(pick.page, { url: 'https://example.test/', title: 'Example' })
  })

  it('requires the page, because only the owning frame knows the address', () => {
    assert.equal(
      parsePickedMessage({
        tag: 'dsh-annotate',
        kind: 'picked',
        elementId: 'el-4',
        facts: { tag: 'button', selector: 'b' },
      }),
      undefined,
    )
    assert.equal(
      parsePickedMessage({
        tag: 'dsh-annotate',
        kind: 'picked',
        elementId: 'el-4',
        facts: { tag: 'button', selector: 'b' },
        page: { url: '' },
      }),
      undefined,
    )
  })

  it('omits an empty title rather than carrying a blank one', () => {
    const pick = parsePickedMessage({
      tag: 'dsh-annotate',
      kind: 'picked',
      elementId: 'el-4',
      facts: { tag: 'button' },
      page: { url: 'https://example.test/', title: '' },
    })
    assert.equal(Object.hasOwn(pick?.page ?? {}, 'title'), false)
  })

  it('does not trust a tab id inside the payload', () => {
    // The browser supplies the real one; a payload value is forgeable and the
    // panel filters picks by tab, so honouring it would cross-deliver picks.
    const pick = parsePickedMessage({
      tag: 'dsh-annotate',
      kind: 'picked',
      tabId: 999,
      elementId: 'el-4',
      facts: { tag: 'button' },
      page: { url: 'https://example.test/' },
    })
    assert.equal(pick?.tabId, -1)
  })

  it('requires the id and the facts', () => {
    const base = { tag: 'dsh-annotate', kind: 'picked', page: { url: 'https://a.test/' } }
    assert.equal(parsePickedMessage({ ...base, facts: {} }), undefined)
    assert.equal(parsePickedMessage({ ...base, elementId: '', facts: {} }), undefined)
    assert.equal(parsePickedMessage({ ...base, elementId: 'el-1' }), undefined)
  })

  it('ignores anything that is not a tagged pick', () => {
    assert.equal(parsePickedMessage({ kind: 'picked', elementId: 'el-1' }), undefined)
    assert.equal(parsePickedMessage({ tag: 'other', kind: 'picked' }), undefined)
    assert.equal(parsePickedMessage({ tag: 'dsh-annotate', kind: 'batch' }), undefined)
    assert.equal(parsePickedMessage(null), undefined)
  })
})

describe('pickEndedReason', () => {
  it('passes through every reason the panel knows', () => {
    for (const reason of ['escape', 'disabled', 'picked', 'suspended']) {
      assert.equal(pickEndedReason(reason), reason)
    }
  })

  it('maps an unknown reason to one the panel can act on', () => {
    // Passing an unknown value through would fail the panel's guard and the
    // broadcast would be silently dropped, leaving it showing a dead mode.
    assert.equal(pickEndedReason('timeout'), 'disabled')
    assert.equal(pickEndedReason(''), 'disabled')
  })
})

describe('isReportableUrl', () => {
  it('accepts the three address families the extension annotates', () => {
    assert.equal(isReportableUrl('https://example.test/'), true)
    assert.equal(isReportableUrl('http://example.test/'), true)
    assert.equal(isReportableUrl('file:///C:/page.html'), true)
  })

  it('refuses an address the panel could not annotate', () => {
    assert.equal(isReportableUrl('chrome://extensions'), false)
    assert.equal(isReportableUrl('about:blank'), false)
    assert.equal(isReportableUrl(''), false)
    assert.equal(isReportableUrl(undefined), false)
  })
})

describe('pageRequest', () => {
  it('tags the envelope so a content script recognises it', () => {
    const message = pageRequest({ type: 'annotate:flash', elementId: 'el-1' }, 'r1')
    assert.equal(message.tag, 'dsh-annotate')
    assert.equal(message.kind, 'panel-request')
    assert.equal(message.requestId, 'r1')
    assert.deepEqual(message.request, { type: 'annotate:flash', elementId: 'el-1' })
  })
})

// ---------------------------------------------------------------------------
// The worker entry point, driven through a chrome stand-in
// ---------------------------------------------------------------------------

/** What the worker asked the platform to do, recorded for assertions. */
interface Platform {
  /** Every message written to a tab, with the tab it was addressed to. */
  readonly sentToTabs: Array<{ tabId: number; message: unknown }>
  /** Every message broadcast to extension contexts, i.e. to the panel. */
  readonly broadcast: unknown[]
  /** Answers the fake tabs return for `sendMessage`. */
  tabAnswer: unknown
  /**
   * Builds a tab answer from the request id the worker actually sent.
   *
   * The worker correlates answers by that id precisely so a stale reply from a
   * previous question is ignored, so a test that wants a *usable* answer has to
   * echo the id back rather than invent one.
   */
  answerFactory: ((requestId: string) => unknown) | null
  /** Set to make `tabs.sendMessage` reject, as it does with no content script. */
  tabThrows: boolean
  /** Whether the bridge reports itself authenticated. */
  connected: boolean
  /** Paths the fake bridge has been asked to persist, in order. */
  readonly stored: Array<Record<string, unknown>>
  /** The live tab list the fake platform reports. */
  tabs: Array<{ id?: number; url?: string; title?: string }>
}

/** One captured listener, typed loosely because the platform types are ambient. */
type CapturedListener = (message: unknown, sender: unknown, respond: (response?: unknown) => void) => boolean | undefined

/**
 * The listeners the worker registered, kept from its single module evaluation.
 *
 * ES module evaluation happens once and is cached, so the worker's module body —
 * and therefore its `addListener` calls — runs exactly once per test process.
 * Re-importing per test would return the cached module and capture nothing. The
 * listeners are installed against whichever `chrome` stand-in was present at
 * that first evaluation, so this holds them and lets each test install its own
 * platform state underneath.
 */
interface CapturedWorker {
  onMessage: CapturedListener
  onUpdated: (tabId: number, changeInfo: { status?: string }, tab: { url?: string }) => void
}

/** The captured listeners, filled in by the first {@link loadWorker} call. */
const captured: { worker: CapturedWorker | null } = { worker: null }

/** The platform state the installed listeners read from, swapped per test. */
let active: Platform

/**
 * Install a `chrome` stand-in and load the worker.
 *
 * The worker registers its listeners as a side effect of being imported and
 * cannot be loaded outside a service worker, so the stand-in captures them: the
 * assertions below drive the real `onMessage` the worker installed rather than a
 * reimplementation of it.
 *
 * The stand-in is installed once, because the module body runs once. Its
 * behaviour is delegated to whatever {@link active} points at, and
 * {@link beforeEach} makes that a fresh state, so the tests stay independent
 * without fighting the module cache.
 *
 * @param platform - the platform state this test drives.
 * @returns the captured listeners.
 */
async function loadWorker(platform: Platform): Promise<CapturedWorker> {
  active = platform
  if (captured.worker !== null) return captured.worker

  let onMessage: unknown
  let onUpdated: unknown
  /** A no-op event for the listeners whose callbacks no test drives. */
  const ignored = { addListener: (): void => {}, removeListener: (): void => {} }

  const fakeChrome = {
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => path,
      onMessage: { addListener: (listener: unknown): void => { onMessage = listener }, removeListener: (): void => {} },
      onInstalled: ignored,
      onStartup: ignored,
      sendMessage: async (message: unknown): Promise<unknown> => {
        active.broadcast.push(message)
        return undefined
      },
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async (items: Record<string, unknown>) => { active.stored.push(items) },
        remove: async () => {},
      },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: ignored,
    },
    alarms: { onAlarm: ignored, create: async () => {}, clear: async () => {}, get: async () => undefined },
    tabs: {
      query: async () => active.tabs,
      get: async (tabId: number) => active.tabs.find((tab) => tab.id === tabId) ?? { id: tabId },
      sendMessage: async (tabId: number, message: unknown): Promise<unknown> => {
        active.sentToTabs.push({ tabId, message })
        if (active.tabThrows) throw new Error('Could not establish connection.')
        if (active.answerFactory !== null) {
          const requestId = (message as { requestId?: unknown }).requestId
          return active.answerFactory(typeof requestId === 'string' ? requestId : '')
        }
        return active.tabAnswer
      },
      onRemoved: ignored,
      onUpdated: { addListener: (listener: unknown): void => { onUpdated = listener }, removeListener: (): void => {} },
    },
    action: {
      onClicked: ignored,
      setTitle: async () => {},
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1 }] },
    scripting: { executeScript: async () => [] },
  }

  // A plain record rather than an intersection with `typeof globalThis`:
  // intersecting keeps the ambient `chrome` declaration in the property's type,
  // and the stand-in deliberately implements only the slice this project calls,
  // so it would never be assignable to the full platform namespace.
  const globals = globalThis as unknown as { chrome?: unknown }
  globals.chrome = fakeChrome
  await import('../extension/src/background/index.ts')

  assert.equal(typeof onMessage, 'function')
  assert.equal(typeof onUpdated, 'function')
  captured.worker = {
    onMessage: onMessage as CapturedListener,
    onUpdated: onUpdated as (tabId: number, changeInfo: { status?: string }, tab: { url?: string }) => void,
  }
  return captured.worker
}

/** A platform whose tab answer is built from the request id the worker actually sent. */
function answeringWith(response: unknown): void {
  platform.tabAnswer = undefined
  platform.answerFactory = (requestId: string): unknown => ({
    tag: 'dsh-annotate',
    kind: 'panel-response',
    requestId,
    response,
  })
}

/** A fresh platform state. */
function newPlatform(): Platform {
  return {
    sentToTabs: [],
    broadcast: [],
    tabAnswer: undefined,
    tabThrows: false,
    connected: false,
    stored: [],
    tabs: [],
    answerFactory: null,
  }
}

/** Drive one message through the worker's listener and await its answer. */
async function ask(
  onMessage: (message: unknown, sender: unknown, respond: (response?: unknown) => void) => boolean | undefined,
  message: unknown,
  sender: unknown = {},
): Promise<unknown> {
  return await new Promise((resolve) => {
    const returned = onMessage(message, sender, resolve)
    // `undefined` means the worker answered synchronously and never called back.
    // Resolving with a sentinel keeps the assertion honest instead of hanging.
    if (returned === undefined) resolve('__no-answer__')
  })
}

/** Whether the worker claimed it would answer later. */
function claimsAsync(
  onMessage: (message: unknown, sender: unknown, respond: (response?: unknown) => void) => boolean | undefined,
  message: unknown,
): boolean | undefined {
  return onMessage(message, {}, () => {})
}

let platform: Platform

beforeEach(() => {
  platform = newPlatform()
  // The installed listeners read platform state through `active`, so pointing it
  // at the fresh one is what keeps one test out of the next one's business.
  active = platform
})

describe('the panel forwarding the page it collected', () => {
  it('puts the page on the wire when asserting a real submission', async () => {
    // The gap this guards: the panel has to HOLD the page for the worker to be
    // able to deliver a batch at all, and the worker's own guard is tested above
    // with a hand-built payload. This drives the real page channel, so a
    // regression that drops the argument is caught here rather than only
    // surfacing as an `invalid` rejection in a real browser.
    const { TabPageSource } = await import('../extension/src/panel/page-source.ts')
    const sent: Array<Record<string, unknown>> = []
    const source = new TabPageSource(4, {
      send: async (message): Promise<unknown> => {
        sent.push(message as unknown as Record<string, unknown>)
        return { ok: true, kind: 'submitted' }
      },
    })

    const context = pageContext()
    context.url = 'https://widget.example.net/inner'
    const result = await source.submit('b7', [], context, 4242)

    assert.deepEqual(result, { ok: true, kind: 'submitted' })
    assert.equal(sent.length, 1)
    const command = sent[0] as {
      type?: unknown
      batchId?: unknown
      page?: { url?: string }
      submittedAt?: unknown
      tabId?: unknown
    }
    assert.equal(command.type, 'annotate:submit')
    assert.equal(command.batchId, 'b7')
    // The frame's address, not the tab's: the field exists for the cross-origin
    // case, and the tab id travelling alongside is what lets the worker resolve
    // the frame tree without guessing at the focused tab.
    assert.equal(command.page?.url, 'https://widget.example.net/inner')
    assert.equal(command.submittedAt, 4242)
    assert.equal(command.tabId, 4)
  })

  it('omits the page entirely when the panel has none', async () => {
    // A panel bound to no tab, or one that never described its page, must send a
    // payload the worker can recognise as incomplete rather than one carrying a
    // null that would be read as present.
    const { TabPageSource } = await import('../extension/src/panel/page-source.ts')
    const sent: Array<Record<string, unknown>> = []
    const source = new TabPageSource(4, {
      send: async (message): Promise<unknown> => {
        sent.push(message as unknown as Record<string, unknown>)
        return { ok: false, kind: 'rejected', reason: 'invalid', detail: 'no page' }
      },
    })

    await source.submit('b8', [], null, 1)
    assert.equal(Object.hasOwn(sent[0] ?? {}, 'page'), false)
  })
})

describe('the worker answering the panel', () => {
  it('always returns `true` for a panel command, so the reply can be awaited', async () => {
    const { onMessage } = await loadWorker(platform)
    assert.equal(
      claimsAsync(onMessage, { type: 'annotate:page', tabId: 1, request: { type: 'annotate:describe-page' } }),
      true,
    )
  })

  it('answers a page request by forwarding it to the named tab', async () => {
    const { onMessage } = await loadWorker(platform)
    const page = { url: 'https://example.test/', title: 'Example', frameKind: 'top' }
    answeringWith({ ok: true, kind: 'page', page })

    const answer = await ask(onMessage, {
      type: 'annotate:page',
      tabId: 7,
      request: { type: 'annotate:describe-page' },
    })

    assert.equal(platform.sentToTabs.length, 1)
    assert.equal(platform.sentToTabs[0]?.tabId, 7)
    const sent = platform.sentToTabs[0]?.message as { kind: string; request: unknown; requestId: string }
    assert.equal(sent.kind, 'panel-request')
    assert.deepEqual(sent.request, { type: 'annotate:describe-page' })
    // The panel accepts the wrapped result, and the wrapper is what lets the
    // worker report a routing failure that a bare response cannot express.
    assert.deepEqual(answer, { ok: true, kind: 'page', value: { ok: true, kind: 'page', page } })
  })

  it('drops an answer carrying a different request id', async () => {
    // A frame answering a previous question must not be read as the answer to
    // this one; the merged result falls back to `unsupported` instead.
    const { onMessage } = await loadWorker(platform)
    platform.tabAnswer = {
      tag: 'dsh-annotate',
      kind: 'panel-response',
      requestId: 'stale',
      response: { ok: true, kind: 'page', page: { url: 'https://wrong.test/', title: 'W', frameKind: 'top' } },
    }
    const answer = await ask(onMessage, {
      type: 'annotate:page',
      tabId: 7,
      request: { type: 'annotate:describe-page' },
    })
    assert.ok(answer !== null && typeof answer === 'object')
    const result = answer as { ok: boolean; kind: string; value?: { ok: boolean; kind: string } }
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'page')
    assert.equal(result.value?.ok, false)
    assert.equal(result.value?.kind, 'unsupported')
  })

  it('accepts an answer that echoes the request id it was sent', async () => {
    // The other half of the correlation: an id that matches must be accepted, or
    // the guard above would be indistinguishable from dropping everything.
    const { onMessage } = await loadWorker(platform)
    const page = { url: 'https://example.test/', title: 'Example', frameKind: 'top' }
    answeringWith({ ok: true, kind: 'page', page })
    const answer = await ask(onMessage, {
      type: 'annotate:page',
      tabId: 7,
      request: { type: 'annotate:describe-page' },
    })
    const result = answer as { ok: boolean; value?: { ok: boolean; kind: string } }
    assert.equal(result.value?.ok, true)
    assert.equal(result.value?.kind, 'page')
  })

  it('uses a fresh request id for each request', async () => {
    const { onMessage } = await loadWorker(platform)
    platform.tabThrows = true
    const request = { type: 'annotate:page', tabId: 1, request: { type: 'annotate:describe-page' } }
    await ask(onMessage, request)
    await ask(onMessage, request)
    const ids = platform.sentToTabs.map((sent) => (sent.message as { requestId: string }).requestId)
    assert.equal(ids.length, 2)
    assert.notEqual(ids[0], ids[1])
  })

  it('reports `no-receiver` rather than hanging when the tab has no content script', async () => {
    const { onMessage } = await loadWorker(platform)
    platform.tabThrows = true
    const answer = await ask(onMessage, {
      type: 'annotate:page',
      tabId: 7,
      request: { type: 'annotate:describe-page' },
    })
    const result = answer as { ok: boolean; kind: string; detail?: string }
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'no-receiver')
    assert.equal(typeof result.detail, 'string')
  })

  it('reports `unsupported` when the tab answered with nothing usable', async () => {
    const { onMessage } = await loadWorker(platform)
    platform.tabAnswer = undefined
    const answer = await ask(onMessage, {
      type: 'annotate:page',
      tabId: 7,
      request: { type: 'annotate:start-picking' },
    })
    const result = answer as { ok: boolean; kind: string; value?: { ok: boolean; kind: string } }
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'page')
    assert.equal(result.value?.ok, false)
    assert.equal(result.value?.kind, 'unsupported')
  })

  it('rejects a submission with no page context instead of inventing a URL', async () => {
    const { onMessage } = await loadWorker(platform)
    // The published panel contract sends only batchId and annotations. The worker
    // must refuse rather than stamp the batch with the tab's top-level URL, which
    // is the wrong address for an element picked inside an iframe.
    const answer = await ask(onMessage, submitCommand())
    const result = answer as { ok: boolean; kind: string; reason?: string; detail?: string }
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'rejected')
    assert.equal(result.reason, 'invalid')
    assert.match(result.detail ?? '', /page/i)
    // Nothing reached the bridge.
    assert.equal(platform.stored.length, 0)
  })

  it('reports `offline` when a complete submission arrives with no bridge', async () => {
    const { onMessage } = await loadWorker(platform)
    // `offline` specifically: it is the reason the panel turns into a Retry
    // button, so any other reason would hide a fixable problem.
    const answer = await ask(onMessage, submitCommand({ page: pageContext(), submittedAt: 42, tabId: 3 }))
    const result = answer as { ok: boolean; kind: string; reason?: string }
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'rejected')
    assert.equal(result.reason, 'offline')
  })

  it('carries the panel page through the whole route to the bridge', async () => {
    // The end-to-end shape of the fix: a widened submission must reach the
    // bridge's own persistence with the panel's address and timestamp intact,
    // not merely parse. `sendBatch` writes the batch before any socket call, so
    // the stored record is proof the route completed.
    const { onMessage } = await loadWorker(platform)
    const framed = pageContext()
    framed.url = 'https://widget.example.net/inner'

    const answer = await ask(
      onMessage,
      submitCommand({ page: framed, submittedAt: 4242, tabId: 3, version: PROTOCOL_VERSION }),
    )

    // No socket is authenticated in this stand-in, so the bridge reports the
    // batch as stored rather than delivered — which is what places it on the
    // retry path and proves `sendBatch` was reached.
    const result = answer as { ok: boolean; kind: string; reason?: string }
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'offline')

    const pending = platform.stored.find((items) => 'bridge.pending' in items)
    assert.ok(pending !== undefined, 'the batch never reached the bridge client')
    const record = pending['bridge.pending'] as { batch: AnnotationBatch; tabId: number }
    assert.equal(record.tabId, 3)
    assert.equal(record.batch.submittedAt, 4242)
    assert.equal(record.batch.version, PROTOCOL_VERSION)
    // The frame's address, not the tab's: this is the field the whole widening
    // exists to carry.
    assert.equal(record.batch.page.url, 'https://widget.example.net/inner')
    assert.equal(record.batch.batchId, 'b1')
  })

  it('stamps its own time when a widened submission carries none', async () => {
    const { onMessage } = await loadWorker(platform)
    await ask(onMessage, submitCommand({ page: pageContext(), tabId: 3 }))
    const pending = platform.stored.find((items) => 'bridge.pending' in items)
    const record = pending?.['bridge.pending'] as { batch: AnnotationBatch } | undefined
    assert.ok(record !== undefined)
    // A fallback, not a fabrication: the batch still carries a real time, and
    // the test only asserts it is a number so it does not depend on the clock.
    assert.equal(typeof record.batch.submittedAt, 'number')
  })

  it('still answers a submission it cannot route at all', async () => {
    const { onMessage } = await loadWorker(platform)
    platform.tabs = []
    const answer = await ask(onMessage, submitCommand({ page: pageContext() }))
    // No tab id in the payload and no active tab: the worker must still answer
    // something rather than leaving the panel to time out.
    const result = answer as { ok: boolean; kind: string; reason?: string }
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'rejected')
    assert.equal(result.reason, 'failed')
  })

  it('leaves a message it does not own completely alone', async () => {
    const { onMessage } = await loadWorker(platform)
    // Returning anything but `undefined` here would close another listener's
    // channel; returning `true` would leave it open forever.
    assert.equal(claimsAsync(onMessage, { some: 'other broadcast' }), undefined)
    assert.equal(claimsAsync(onMessage, { type: 'annotate:pick-ended', reason: 'escape' }), undefined)
    assert.equal(platform.broadcast.length, 0)
  })

  it('relays a pick reported by a content script through to the panel', async () => {
    const { onMessage } = await loadWorker(platform)
    const returned = onMessage(
      {
        tag: 'dsh-annotate',
        kind: 'picked',
        tabId: 999,
        elementId: 'el-4',
        facts: { tag: 'button', selector: 'button.save' },
        page: { url: 'https://widget.example.net/inner', title: 'Widget' },
      },
      { tab: { id: 12 }, frameId: 3 },
      () => {},
    )
    assert.equal(returned, undefined)
    assert.equal(platform.broadcast.length, 1)
    const relayed = platform.broadcast[0] as Record<string, unknown>
    assert.equal(relayed['type'], 'annotate:picked')
    // The browser's tab id wins over the payload's, so a page cannot deliver its
    // pick into another tab's panel.
    assert.equal(relayed['tabId'], 12)
    assert.equal(relayed['elementId'], 'el-4')
    assert.deepEqual(relayed['page'], { url: 'https://widget.example.net/inner', title: 'Widget' })
  })

  it('relays a picking exit to the panel with a reason it understands', async () => {
    const { onMessage } = await loadWorker(platform)
    const returned = onMessage(
      { tag: 'dsh-annotate', kind: 'picking-ended', tabId: 1, frame: { frameId: 0 }, reason: 'timeout' },
      { tab: { id: 1 }, frameId: 0 },
      () => {},
    )
    assert.equal(returned, undefined)
    assert.deepEqual(platform.broadcast, [{ type: 'annotate:pick-ended', reason: 'disabled' }])
  })

  it('passes a known exit reason through unchanged', async () => {
    const { onMessage } = await loadWorker(platform)
    onMessage(
      { tag: 'dsh-annotate', kind: 'picking-ended', tabId: 1, frame: { frameId: 0 }, reason: 'escape' },
      { tab: { id: 1 }, frameId: 0 },
      () => {},
    )
    assert.deepEqual(platform.broadcast, [{ type: 'annotate:pick-ended', reason: 'escape' }])
  })
})

describe('the worker broadcasting a page change', () => {
  it('tells the panel when a tab finished navigating', async () => {
    const { onUpdated } = await loadWorker(platform)
    onUpdated(4, { status: 'complete' }, { url: 'https://example.test/next' })
    assert.deepEqual(platform.broadcast, [
      { type: 'annotate:page-changed', url: 'https://example.test/next' },
    ])
  })

  it('does not announce a privileged page the panel cannot annotate', async () => {
    const { onUpdated } = await loadWorker(platform)
    onUpdated(4, { status: 'complete' }, { url: 'chrome://extensions' })
    assert.deepEqual(platform.broadcast, [])
  })

  it('does not announce a navigation that has only started', async () => {
    const { onUpdated } = await loadWorker(platform)
    onUpdated(4, { status: 'loading' }, { url: 'https://example.test/next' })
    assert.deepEqual(platform.broadcast, [])
  })
})
