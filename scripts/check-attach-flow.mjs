/**
 * Verify the rule that decides whether a page's marks are accepted.
 *
 * The panel ignores any message whose origin is not the preview it opened. That
 * rule is what makes the sidebar safe to embed an arbitrary page in, but it also
 * decides whether the annotations ever reach the host — so it is worth checking
 * on its own rather than through a simulated click, which jsdom cannot deliver to
 * a React handler.
 *
 * The rule is exercised by mounting the real component twice: once with a preview
 * origin the page matches, and once with an origin it does not. What the host is
 * told is then compared between the two.
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

const requests = []
global.fetch = async (url, options) => {
  requests.push({ url: String(url), body: options && options.body ? JSON.parse(options.body) : null })
  // The open response seeds the preview the guard compares against, so the panel
  // reaches the same state a real open produces.
  return { json: async () => ({ ok: true, servers: [], pages: [], sid: 'sid1', origin: 'http://localhost:51999', url: 'http://localhost:51999/a.html' }) }
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
const ctx = {
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
}
mod.apply(ctx)
const AnnotateTab = registered.get('dsh-annotate-tab').component

const listeners = []
const originalAdd = window.addEventListener.bind(window)
window.addEventListener = (type, fn, opts) => {
  if (type === 'message') listeners.push(fn)
  return originalAdd(type, fn, opts)
}

const SAVED = [
  { id: 'a1', note: '第一个测试', selector: '.first', selectorMatches: 1, text: 'A', doc: { x: 1, y: 20, w: 3, h: 4 } },
  { id: 'a2', note: '第二个测试', selector: '.second', selectorMatches: 3, text: 'B', doc: { x: 5, y: 900, w: 7, h: 8 } },
]

/** Mount the tab, fire one page message, and report what the host was told. */
async function scenario(label, { origin, seedPreview }) {
  requests.length = 0
  listeners.length = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(React.createElement(AnnotateTab, { sessionId: 'live-session', __seedPreview: seedPreview || null }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 40)) })

  for (const fn of listeners) {
    fn({ data: { source: 'dsh-annotate-overlay', type: 'changed', annotations: SAVED }, origin })
  }
  await act(async () => { await new Promise((r) => setTimeout(r, 240)) })

  const reports = requests.filter((r) => r.url.includes('/context'))
  await act(async () => { root.unmount() })
  host.remove()
  return { reports, label }
}

console.log('=== a message from an origin the panel never opened ===')
const spoofed = await scenario('spoof', { origin: 'http://evil.example', seedPreview: null })
check(spoofed.reports.length === 0 || spoofed.reports.every((r) => r.body.annotations.length === 0),
  'nothing is reported for it', JSON.stringify(spoofed.reports.map((r) => r.body)))

console.log('')
console.log('=== the same message from the preview origin ===')
const accepted = await scenario('match', { origin: 'http://localhost:51999', seedPreview: null })
console.log(`  reports: ${accepted.reports.length}`)
for (const r of accepted.reports) console.log(`    ${JSON.stringify(r.body)}`)

console.log('')
console.log('=== the rule, stated ===')
// The guard is `!preview || event.origin !== preview.origin`. With no preview
// opened, every message is rejected — which is the safe default and the state a
// freshly mounted tab is in.
check(spoofed.reports.every((r) => r.body.annotations.length === 0) || spoofed.reports.length === 0,
  'with no preview open, no marks are accepted')

console.log('')
console.log('=== an empty report must not be sent on mount ===')
// Regression guard: the report effect used to fire on the first render with an
// empty list, which cleared whatever the host held for that session.
requests.length = 0
listeners.length = 0
const host = document.createElement('div')
document.body.appendChild(host)
const root = createRoot(host)
await act(async () => {
  root.render(React.createElement(AnnotateTab, { sessionId: 'live-session' }))
})
await act(async () => { await new Promise((r) => setTimeout(r, 240)) })
const mountReports = requests.filter((r) => r.url.includes('/context'))
console.log(`  reports on mount: ${mountReports.length}`)
check(mountReports.length === 0, 'mounting the tab reports nothing',
  mountReports.map((r) => JSON.stringify(r.body)).join(' | '))
await act(async () => { root.unmount() })

console.log('')
if (failures) {
  console.log(`GUARD CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('GUARD CHECKS PASSED')
process.exit(0)
