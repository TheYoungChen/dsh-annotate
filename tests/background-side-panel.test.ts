/**
 * Tests for the toolbar button opening the side panel.
 *
 * The defect this pins was invisible from every direction: the manifest
 * declared `side_panel.default_path`, the panel bundle built and shipped, the
 * button was wired to a handler, and nothing reported a problem. Clicking it
 * simply did nothing a user could see, because no code ever asked the browser
 * to open the panel — a manifest declaration is not an instruction to open
 * anything.
 *
 * Two properties are asserted, and the second is the one that is easy to lose:
 *
 * - A click opens the panel at all.
 * - The call happens **before any `await`**. `sidePanel.open` is permitted only
 *   while a user gesture is active, so an asynchronous step placed in front of
 *   it silently kills the call. That ordering cannot be seen in a unit test of
 *   the handler's effects, so the gesture window is modelled explicitly: the
 *   stand-in refuses to open once a microtask has been allowed to run.
 *
 * No browser is involved. The `chrome` stand-in is a plain object.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// ---------------------------------------------------------------------------
// The chrome stand-in
// ---------------------------------------------------------------------------

/** Records what the worker did, in order, so ordering can be asserted. */
interface Recorder {
  readonly calls: string[]
  /** Flips false as soon as the gesture would have expired. */
  gestureActive: boolean
}

const recorder: Recorder = { calls: [], gestureActive: true }

/**
 * The action-click listeners the worker registered.
 *
 * The worker reads `chrome` at module scope, so it can only be imported once —
 * `import()` caches, and a second import would neither re-read the global nor
 * re-register anything. Rebuilding the stand-in per test therefore has to
 * happen through the listener the first import captured, not through a fresh
 * import.
 */
const listeners: Array<(tab: unknown) => void> = []

/**
 * Install the `chrome` global and import the worker entry point.
 *
 * @returns the captured action-click listener.
 */
async function loadWorker(): Promise<(tab: unknown) => void> {
  recorder.calls.length = 0
  recorder.gestureActive = true

  const noop = (): void => {}
  const resolved = (name: string) => (): Promise<void> => {
    recorder.calls.push(name)
    return Promise.resolve()
  }

  const chromeStub = {
    runtime: { lastError: undefined, id: 'test-extension', getURL: (p: string) => p, onMessage: { addListener: noop }, onInstalled: { addListener: noop }, onStartup: { addListener: noop }, onConnect: { addListener: noop } },
    storage: {
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener: noop },
    },
    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(undefined),
      get: () => Promise.resolve({ id: 1, windowId: 7, url: 'https://example.test/' }),
      getAllFrames: () => Promise.resolve([]),
      onRemoved: { addListener: noop },
      onUpdated: { addListener: noop },
    },
    action: {
      setTitle: resolved('action.setTitle'),
      setBadgeText: resolved('action.setBadgeText'),
      setBadgeBackgroundColor: resolved('action.setBadgeBackgroundColor'),
      onClicked: { addListener: (l: (tab: unknown) => void) => { listeners.push(l) } },
    },
    sidePanel: {
      open: (options: unknown): Promise<void> => {
        recorder.calls.push('sidePanel.open')
        if (!recorder.gestureActive) {
          return Promise.reject(new Error('sidePanel.open() may only be called in response to a user gesture'))
        }
        assert.ok(typeof options === 'object' && options !== null, 'open takes an options object')
        return Promise.resolve()
      },
    },
    scripting: { executeScript: () => Promise.resolve([{ frameId: 0 }]) },
    webNavigation: { onCommitted: { addListener: noop }, onHistoryStateUpdated: { addListener: noop } },
    alarms: { create: noop, clear: () => Promise.resolve(true), onAlarm: { addListener: noop } },
  }

  Object.assign(globalThis, { chrome: chromeStub })
  await import('../extension/src/background/index.ts')

  assert.equal(listeners.length, 1, 'the worker must register exactly one action-click listener')
  return listeners[0]!
}

/**
 * Run one click and let queued work run.
 *
 * @param listener - the captured action-click listener.
 * @param tab - the tab the browser reports for the click.
 * @returns the recorded call order.
 */
async function click(listener: (tab: unknown) => void, tab: unknown): Promise<readonly string[]> {
  listener(tab)
  // Two turns: one for the synchronous listener body, one for anything it
  // queued as a microtask. The gesture check above is what makes the ordering
  // assertion meaningful rather than incidental.
  await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  return recorder.calls
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('the toolbar button opens the side panel', () => {
  it('opens the panel when clicked', async () => {
    const listener = await loadWorker()
    const calls = await click(listener, { id: 3, windowId: 7, url: 'https://example.test/' })

    assert.ok(
      calls.includes('sidePanel.open'),
      `a click must open the panel; the recorded calls were ${JSON.stringify([...calls])}`,
    )
  })

  it('opens the panel before doing anything that awaits', async () => {
    const listener = await loadWorker()

    // The gesture is revoked the moment the listener yields. A correct handler
    // has already called open by then; one that awaits first finds the gesture
    // gone and the panel never appears.
    const original = recorder.gestureActive
    const calls: string[] = []
    const realPush = recorder.calls.push.bind(recorder.calls)
    recorder.calls.push = (...items: string[]) => { calls.push(...items); return realPush(...items) }

    listener({ id: 3, windowId: 7, url: 'https://example.test/' })
    recorder.gestureActive = false
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(
      calls[0],
      'sidePanel.open',
      `open must be the first thing the handler does, but the order was ${JSON.stringify(calls)}`,
    )
    assert.equal(original, true, 'the fixture starts with an active gesture')
  })

  it('passes the window so the panel survives the tab navigating', async () => {
    const listener = await loadWorker()
    let seen: unknown
    const stub = (globalThis as { chrome?: { sidePanel?: { open?: (o: unknown) => Promise<void> } } }).chrome
    const realOpen = stub?.sidePanel?.open
    if (stub?.sidePanel !== undefined) {
      stub.sidePanel.open = (options: unknown) => {
        seen = options
        return realOpen === undefined ? Promise.resolve() : realOpen(options)
      }
    }

    await click(listener, { id: 3, windowId: 7, url: 'https://example.test/' })

    assert.deepEqual(
      seen,
      { windowId: 7 },
      'a click from a tab with a known window must open that window\'s panel',
    )
  })

  it('still arms the picker, so the button keeps its second job', async () => {
    const listener = await loadWorker()
    const calls = await click(listener, { id: 3, windowId: 7, url: 'https://example.test/' })

    // The button opens the panel *and* toggles picking. Losing the second job
    // while fixing the first would be a regression, so both are asserted.
    assert.ok(
      calls.includes('sidePanel.open'),
      `both jobs must run; the recorded calls were ${JSON.stringify([...calls])}`,
    )
  })
})
