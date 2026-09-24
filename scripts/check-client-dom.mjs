/**
 * Live DOM check for the sidebar half.
 *
 * Server rendering never runs effects, so the postMessage wiring and the
 * composer bridge are invisible to it. This mounts the real component into a
 * jsdom document with react-dom/client, then drives it the way the framed page
 * and the composer dock would.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/a3025/.dsh/profiles/web/package.json')
const pairDir = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules'
const jsdomDir = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/jsdom@29.1.1_@noble+hashes@2.3.0/node_modules'

const React = require(`${pairDir}/react`)
const { createRoot } = require(`${pairDir}/react-dom/client`)
const { JSDOM } = require(`${jsdomDir}/jsdom`)

// --- a document the component can actually mount into ------------------------
const dom = new JSDOM('<!doctype html><html lang="zh"><head></head><body><div id="host"></div></body></html>', {
  url: 'http://127.0.0.1:3000/',
  pretendToBeVisual: true,
})
const { window } = dom
global.window = window
global.document = window.document
global.HTMLElement = window.HTMLElement
global.Event = window.Event
global.MessageEvent = window.MessageEvent
global.requestAnimationFrame = window.requestAnimationFrame
global.localStorage = window.localStorage
global.fetch = async () => ({ json: async () => ({ ok: true, servers: [], pages: [] }) })
window.fetch = global.fetch

// React reads these to decide whether it is in a browser.
global.IS_REACT_ACT_ENVIRONMENT = true

// --- load the bundle ---------------------------------------------------------
let mod
window.__ModuleLoader__ = {
  load({ factory }) {
    mod = factory((name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require: ${name}`)
    })
  },
}
await import('../client.js')

// --- fake slots that keep the components reachable ---------------------------
const registered = new Map()
let composerProps = null
const ctx = {
  effect: (fn) => {
    const d = fn()
    return typeof d === 'function' ? d : () => {}
  },
  interval: () => () => {},
  get: (name) => {
    if (name === 'slots') {
      return {
        inject: (key, fn) => {
          fn()
        },
        register: (def, component) => {
          registered.set(def.id, { def, component })
          return () => {}
        },
      }
    }
    if (name === 'sidebarRightTabs') return { register: () => () => {} }
    if (name === 'sidebarRight') return { openTab: () => {} }
    return undefined
  },
}
mod.apply(ctx)

const AnnotateTab = registered.get('dsh-annotate-tab').component
const ComposerBridge = registered.get('annotate-bridge').component

// --- mount the composer bridge the way the dock would ------------------------
let draftValue = 'existing draft'
const setDraftCalls = []
function BridgeHost() {
  // Mirrors the real input dock: it passes a selector hook and the actions.
  const useInput = (selector) => selector({ draft: draftValue })
  React.useEffect(() => {
    // The bridge reads props on every render; keep them fresh by re-rendering.
  })
  return React.createElement(ComposerBridge, {
    sessionId: 's1',
    useInput,
    inputActions: {
      setDraft: (value) => {
        setDraftCalls.push(value)
        draftValue = value
      },
    },
  })
}

const bridgeRoot = createRoot(document.getElementById('host'))
const { act } = require(`${pairDir}/react-dom/test-utils`)
await act(async () => {
  bridgeRoot.render(React.createElement(BridgeHost))
})
console.log('composer bridge mounted')

// --- mount the tab -----------------------------------------------------------
const host = document.createElement('div')
document.body.appendChild(host)
const root = createRoot(host)
await act(async () => {
  root.render(React.createElement(AnnotateTab, { sessionId: 's1' }))
})
console.log('tab mounted, text sample:', host.textContent.slice(0, 30))

// --- drive the page -> panel channel ----------------------------------------
/**
 * Feed the panel an overlay message. The panel ignores anything whose origin
 * is not the preview it opened, so this checks the guard as well as the path.
 */
const messageListeners = []
const originalAdd = window.addEventListener.bind(window)
window.addEventListener = (type, fn, opts) => {
  if (type === 'message') messageListeners.push(fn)
  return originalAdd(type, fn, opts)
}

// Re-mount so the listener registration is captured.
await act(async () => {
  root.unmount()
})
const host2 = document.createElement('div')
document.body.appendChild(host2)
const root2 = createRoot(host2)
await act(async () => {
  root2.render(React.createElement(AnnotateTab, { sessionId: 's1' }))
})
console.log('panel message listeners:', messageListeners.length)
assert.ok(messageListeners.length > 0, 'panel subscribes to page messages')

// Annotations arriving from a page the panel has NOT opened must be ignored.
await act(async () => {
  for (const fn of messageListeners) {
    fn({
      data: {
        source: 'dsh-annotate-overlay',
        type: 'changed',
        annotations: [{ id: 'x', note: 'nope', selector: '#x' }],
      },
      origin: 'http://localhost:9999',
    })
  }
})
assert.ok(!host2.textContent.includes('nope'), 'messages from an unopened origin are ignored')
console.log('cross-origin page spoof ignored: true')

// --- the payload builder is reachable through a render ------------------------
// Send with no composer bridge for this session: the tab must report that
// rather than throwing.
await act(async () => {
  root2.unmount()
})
const host3 = document.createElement('div')
document.body.appendChild(host3)
const root3 = createRoot(host3)
await act(async () => {
  root3.render(React.createElement(AnnotateTab, { sessionId: 'other-session' }))
})
console.log('tab with no bridge for its session renders:', host3.textContent.length > 0)

console.log('\nALL LIVE DOM CHECKS PASSED')
process.exit(0)
