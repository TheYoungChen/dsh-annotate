/**
 * Unit tests for the toolbar badge mapping.
 *
 * `badgeFor` lives in the worker entry point, which registers platform listeners
 * as a side effect of being imported and therefore cannot be loaded outside a
 * service worker. The mapping itself is pure, so it is exercised here by reading
 * the source module's export through a minimal `chrome` stand-in: the assertions
 * are about the table, not about the platform.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ConnectionState } from '../extension/src/background/bridge-client.ts'

/**
 * The expected badge for each state, restated here rather than imported.
 *
 * A test that reads its expectations from the code under test proves only that
 * the code equals itself; this table is the specification, and the worker must
 * match it.
 */
const EXPECTED: Record<ConnectionState, { text: string; color: string }> = {
  connected: { text: 'ON', color: '#2f9e44' },
  connecting: { text: '…', color: '#f08c00' },
  reconnecting: { text: '…', color: '#f08c00' },
  unauthorized: { text: '!', color: '#c92a2a' },
  incompatible: { text: '!', color: '#c92a2a' },
  unpaired: { text: '', color: '#868e96' },
}

/**
 * Load `badgeFor` with a `chrome` stand-in installed.
 *
 * The worker's module body calls `chrome.runtime.onMessage.addListener` and
 * friends. A no-op recorder satisfies every one of them, which is enough to get
 * the module evaluated and its pure export out.
 *
 * @returns the badge mapping function.
 */
async function loadBadgeFor(): Promise<(state: ConnectionState) => { text: string; color: string }> {
  const noop = { addListener: (): void => {} }
  const fakeChrome = {
    runtime: { onMessage: noop, onInstalled: noop, onStartup: noop, id: 'test', getURL: (path: string) => path },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: noop },
    alarms: { onAlarm: noop, create: async () => {}, clear: async () => {}, get: async () => undefined },
    tabs: { query: async () => [], get: async () => ({}), sendMessage: async () => undefined, onRemoved: noop, onUpdated: noop },
    action: {
      onClicked: noop,
      setTitle: async () => {},
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    webNavigation: { getAllFrames: async () => [] },
    scripting: { executeScript: async () => [] },
  }

  const globalWithChrome = globalThis as typeof globalThis & { chrome?: unknown }
  globalWithChrome.chrome = fakeChrome
  try {
    const module = await import('../extension/src/background/index.ts')
    return module.badgeFor
  } finally {
    delete globalWithChrome.chrome
  }
}

describe('badgeFor', () => {
  it('maps every connection state to its badge', async () => {
    const badgeFor = await loadBadgeFor()
    for (const [state, expected] of Object.entries(EXPECTED)) {
      assert.deepEqual(badgeFor(state as ConnectionState), expected, `badge for ${state}`)
    }
  })

  it('keeps the text short enough to fit the badge', async () => {
    const badgeFor = await loadBadgeFor()
    for (const state of Object.keys(EXPECTED) as ConnectionState[]) {
      assert.ok(badgeFor(state).text.length <= 2, `${state} badge text is too long`)
    }
  })

  it('reserves the warning colour for states the user must act on', async () => {
    const badgeFor = await loadBadgeFor()
    const warning = badgeFor('unauthorized').color
    assert.notEqual(badgeFor('connected').color, warning)
    assert.notEqual(badgeFor('reconnecting').color, warning)
    assert.notEqual(badgeFor('unpaired').color, warning)
  })
})
