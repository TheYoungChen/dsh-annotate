/**
 * Verify the capsule appears, sits in the dock above the composer, and reflects
 * the host rather than a number the sidebar pushed over.
 *
 * Two user-visible faults are guarded here. First, the capsule used to appear
 * only after pressing a button in the sidebar; it must now appear as soon as
 * anything is marked, because the sidebar writes marks to the host as they are
 * made. Second, it used to be registered on `conversation.composer.dock`, which
 * renders BELOW the input card, so it appeared under the box instead of above
 * it — `conversation.input.dock` is the slot the shell documents as "full-width
 * entries above the composer card".
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

const dom = new JSDOM('<!doctype html><html lang="zh"><head></head><body><div id="host"></div></body></html>', {
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

/** What the host claims to hold, so the capsule can be compared against it. */
let hostCount = 0
const requests = []
global.fetch = async (url, options) => {
  const u = String(url)
  requests.push({ url: u, body: options && options.body ? JSON.parse(options.body) : null })
  if (u.endsWith('/pending')) return { json: async () => ({ ok: true, count: hostCount, block: '' }) }
  if (u.endsWith('/context')) return { json: async () => ({ ok: true, count: hostCount }) }
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

// Capture every registration so the slot choice can be asserted directly.
const registered = new Map()
const ctx = {
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  interval: () => () => {},
  get: (name) => {
    if (name === 'slots') {
      return {
        inject: (key, fn) => { fn() },
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

const capsuleEntry = [...registered.values()].find((r) => r.def.id === 'annotate-capsule')

console.log('=== the capsule is registered on the dock above the composer ===')
check(capsuleEntry !== undefined, 'a capsule component is registered',
  [...registered.keys()].join(', ') || '(none)')
const slotName = capsuleEntry ? capsuleEntry.def.name : null
console.log(`  registered slot: ${slotName}`)
check(slotName === 'conversation.input.dock',
  'it rides conversation.input.dock, which renders ABOVE the input card',
  slotName)
check(slotName !== 'conversation.composer.dock',
  'it is no longer on conversation.composer.dock, which renders BELOW the card')

console.log('')
console.log('=== nothing is shown while the host holds nothing ===')
const Dock = capsuleEntry ? capsuleEntry.component : null
const host = document.createElement('div')
document.body.appendChild(host)
const root = createRoot(host)
// The real dock receives `zone`, not a bare sessionId — exercising that shape is
// the point, since reading only `props.sessionId` is what broke it before.
const zone = { session: { id: 'sess-1' }, input: {} }
await act(async () => {
  root.render(React.createElement(Dock, { zone }))
})
check(!host.querySelector('.dsa-capsule'), 'no capsule with nothing held', host.textContent)

console.log('')
console.log('=== marking something makes it appear, with no button pressed ===')
// This is the behaviour the user asked for: the count comes from the host, so a
// mark made in the sidebar shows up here without any hand-over step. The state
// is set before rendering, because the component reads once on mount.
hostCount = 3
const host2 = document.createElement('div')
document.body.appendChild(host2)
const root2 = createRoot(host2)
await act(async () => {
  root2.render(React.createElement(Dock, { zone }))
})
await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
const capsule = host2.querySelector('.dsa-capsule')
check(capsule !== null, 'the capsule appears on its own', host2.innerHTML.slice(0, 160))
if (capsule) {
  const text = capsule.textContent
  console.log(`  capsule text: ${JSON.stringify(text)}`)
  check(/3/.test(text), 'it names the count', text)
  check(/标注/.test(text), 'it says what the count refers to', text)
  check(capsule.getAttribute('title') && capsule.getAttribute('title').length > 0,
    'it explains itself on hover', capsule.getAttribute('title'))
  // No "attach" affordance: the marks are already attached.
  check(capsule.querySelectorAll('button').length === 0, 'it is not a button', capsule.outerHTML.slice(0, 120))
}

console.log('')
console.log('=== the count follows the host, not a local copy ===')
// A change made after mount is picked up by the next poll.
hostCount = 5
await act(async () => { await new Promise((r) => setTimeout(r, 1200)) })
check(/5/.test(host2.querySelector('.dsa-capsule') ? host2.querySelector('.dsa-capsule').textContent : ''),
  'it picks up a change made elsewhere')

console.log('')
console.log('=== the host clears it when the turn starts ===')
hostCount = 0
await act(async () => { await new Promise((r) => setTimeout(r, 1200)) })
check(host2.querySelector('.dsa-capsule') === null, 'the capsule disappears once the host is empty',
  host2.querySelector('.dsa-capsule') ? host2.querySelector('.dsa-capsule').textContent : undefined)
const polled = requests.filter((r) => r.url.endsWith('/pending'))
check(polled.length > 0, 'it asks the host rather than guessing', `${polled.length} poll(s)`)
check(polled.some((r) => r.body && r.body.session === 'sess-1'),
  'and it asks about the session the dock belongs to',
  JSON.stringify(polled[0] && polled[0].body))

console.log('')
await act(async () => { root.unmount() })
await act(async () => { root2.unmount() })
if (failures) {
  console.log(`CAPSULE CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('CAPSULE CHECKS PASSED')
process.exit(0)
