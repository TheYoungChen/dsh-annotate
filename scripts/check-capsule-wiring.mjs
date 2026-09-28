/**
 * The capsule must find its session no matter which shape the host delivers it in.
 *
 * This is the regression that cost the user a round trip: the component read only
 * `props.sessionId`, but the dock it was registered on renders as
 * `renderSlot('conversation.input.dock', zone)` — the session arrives nested in a
 * `zone` object. The capsule then never polled, so it never appeared.
 *
 * The other two shapes are kept because the same component is mounted by more
 * than one host: a bare `sessionId` prop, and the inject face. A future slot
 * change must not silently break the capsule again, so all three are asserted.
 */
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/a3025/.dsh/profiles/web/package.json')
const pairDir = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules'
const jsdomDir = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/jsdom@29.1.1_@noble+hashes@2.3.0/node_modules'

const React = require(`${pairDir}/react`)
const { createRoot } = require(`${pairDir}/react-dom/client`)
const { act } = require(`${pairDir}/react-dom/test-utils`)
const { JSDOM } = require(`${jsdomDir}/jsdom`)

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) {
    failures += 1
    if (detail !== undefined) console.log(`       ${detail}`)
  }
}

const dom = new JSDOM('<!doctype html><html lang="zh"><head></head><body></body></html>', {
  url: 'http://127.0.0.1:3080/',
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
global.IS_REACT_ACT_ENVIRONMENT = true

/** Sessions the host claims to hold marks for. */
const held = new Map([['sess-zone', 2], ['sess-prop', 3], ['sess-injected', 4]])
const asked = []
global.fetch = async (url, options) => {
  const u = String(url)
  const body = options && options.body ? JSON.parse(options.body) : {}
  if (u.endsWith('/pending')) {
    asked.push(body.session)
    return { json: async () => ({ ok: true, count: held.get(body.session) || 0 }) }
  }
  return { json: async () => ({ ok: true, servers: [], pages: [] }) }
}
window.fetch = global.fetch

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

const registered = new Map()
mod.apply({
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  interval: () => () => {},
  get: (name) => {
    if (name === 'slots') {
      return {
        inject: (key, fn) => { fn() },
        register: (def, component) => { registered.set(def.id, { def, component }); return () => {} },
      }
    }
    if (name === 'sidebarRightTabs') return { register: () => () => {} }
    if (name === 'sidebarRight') return { openTab: () => {} }
    return undefined
  },
})

const entry = [...registered.values()].find((r) => r.def.id === 'annotate-capsule')
check(entry !== undefined, 'the capsule is registered')
const Dock = entry ? entry.component : null

/**
 * Mount the dock with one prop shape and report whether it found the marks.
 * @param label - what this shape represents.
 * @param props - the props to pass.
 * @param expected - the count the host holds for that session.
 */
async function probe(label, props, expected) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(React.createElement(Dock, props)) })
  await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
  const capsule = host.querySelector('.dsa-capsule')
  const text = capsule ? capsule.textContent : ''
  check(capsule !== null, `${label}: the capsule renders`, JSON.stringify(host.textContent))
  check(new RegExp(String(expected)).test(text), `${label}: it shows the host's count (${expected})`, text)
  await act(async () => { root.unmount() })
  return { text }
}

console.log('')
console.log('=== the dock passes { session, input }, so the id is nested ===')
// This is the exact shape ConversationRoot uses at line 350, and the one that was
// silently broken.
await probe('zone', { zone: { session: { id: 'sess-zone' }, input: {} } }, 2)

console.log('')
console.log('=== a bare sessionId prop also works ===')
await probe('prop', { sessionId: 'sess-prop' }, 3)

console.log('')
console.log('=== the inject face also works ===')
await probe('injected', { injected: { sessionId: 'sess-injected' } }, 4)

console.log('')
console.log('=== each shape asked the host about its own session ===')
check(asked.includes('sess-zone'), 'the nested id was used', asked.join(', '))
check(asked.includes('sess-prop'), 'the bare prop was used')
check(asked.includes('sess-injected'), 'the injected id was used')

console.log('')
if (failures) {
  console.log(`CAPSULE WIRING CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('CAPSULE WIRING CHECKS PASSED')
process.exit(0)
