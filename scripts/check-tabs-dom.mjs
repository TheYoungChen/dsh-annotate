/**
 * The tab strip, rendered.
 *
 * `check-tabs.mjs` reads the source and asserts the SHAPE of the multi-tab code.
 * Every one of its assertions passed while the feature was broken.
 *
 * The bug it could not see: `openTarget` opens a page across several awaits, and
 * `tabs` state only changes on the NEXT render — so two pages opened in the same
 * tick both read the same stale list, and the second one's `setTabs([...stale,
 * record])` dropped the first. The reader asks for a second page and gets one. No
 * amount of reading the source shows that; only rendering it does.
 *
 * So this mounts the real panel in jsdom and counts what the reader would count:
 * how many tabs, how many frames, which one is hidden, what closing one does. The
 * source checks are kept — they pin down intent and catch a different class of
 * fault — but they are not sufficient on their own, and this file is the proof.
 *
 * Run: node scripts/check-tabs-dom.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/a3025/.dsh/profiles/web/package.json')
const pairDir = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules'
const jsdomDir = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/jsdom@29.1.1_@noble+hashes@2.3.0/node_modules'

const { JSDOM } = require(`${jsdomDir}/jsdom`)

// The DOM globals go up BEFORE React is required, and that order is load-bearing.
// React decides once, at module init, whether the browser supports the `input` event
// (`isEventSupported('input')`), and caches the answer. Required first — with no
// `document` in scope — it concludes "no" and routes every text input through its
// old-IE polyfill, which calls `activeElement.attachEvent` and throws in jsdom. The
// symptom is that typing into the address bar silently does nothing: the failure is
// thrown before the change handler runs, so the panel looks like it ignored the input.
const dom = new JSDOM('<!doctype html><html lang="zh"><head></head><body></body></html>', {
  url: 'http://127.0.0.1:3080/',
  pretendToBeVisual: true,
})
const { window } = dom
global.window = window
global.document = window.document
// `globalThis.navigator` is a getter-only accessor on Node 22, so plain assignment
// throws. React's `isEventSupported` probe reads `document`, not `navigator`, so this
// is for the panel's own UA sniffing; define it rather than assign.
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true, writable: true })
global.HTMLElement = window.HTMLElement
global.HTMLInputElement = window.HTMLInputElement
global.Event = window.Event
global.MessageEvent = window.MessageEvent
global.MouseEvent = window.MouseEvent
global.KeyboardEvent = window.KeyboardEvent
global.requestAnimationFrame = window.requestAnimationFrame
global.localStorage = window.localStorage
global.IS_REACT_ACT_ENVIRONMENT = true

const React = require(`${pairDir}/react`)
const { createRoot } = require(`${pairDir}/react-dom/client`)
const { act } = require(`${pairDir}/react-dom/test-utils`)

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const SESSION = 's-tabs-dom'
const posted = []
global.fetch = async (url, options) => {
  const body = options && options.body ? JSON.parse(options.body) : null
  const href = String(url)
  posted.push({ url: href, body })
  if (href.endsWith('/open')) {
    // The target arrives as `url`, which is the field the panel actually posts.
    const target = (body && (body.url || body.target)) || ''
    // Two DIFFERENT origins are two previews, and two PATHS of one origin are two
    // previews as well — which is what the host now does, and what it did not do when
    // the strip shipped: it keyed reuse on `URL.origin`, so the second address of one
    // app came back as the first one's sid. A mock that only told origins apart could
    // never have caught that.
    const n = target.includes('two') ? 2 : target.includes('/b') ? 3 : 1
    return {
      json: async () => ({
        ok: true,
        sid: `sid${n}`,
        url: `http://localhost:4123${n}${target.replace(/^https?:\/\/[^/]+/, '')}`,
        origin: `http://localhost:4123${n}`,
        servers: [],
        pages: [],
      }),
    }
  }
  if (href.endsWith('/pending')) return { json: async () => ({ ok: true, annotations: [] }) }
  if (href.endsWith('/touch')) return { json: async () => ({ ok: true, kept: ['sid1', 'sid2'], missing: [] }) }
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
const ctx = {
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  interval: () => () => {},
  get: (name) => {
    if (name === 'slots') {
      return { inject: (key, fn) => fn(), register: (def, component) => { registered.set(def.id, { def, component }); return () => {} } }
    }
    if (name === 'sidebarRightTabs') return { register: () => () => {} }
    if (name === 'sidebarRight') return { openTab: () => {} }
    return undefined
  },
}
mod.apply(ctx)
const AnnotateTab = registered.get('dsh-annotate-tab').component
check(Boolean(AnnotateTab), 'the panel component is registered')

const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 120)) }) }

const ONE = 'http://127.0.0.1:41231/one'
const TWO = 'http://127.0.0.1:41232/two'

console.log('\n=== one page renders, and a strip would be noise ===')
// The panel restores whatever the session last had open, which is also how a sidebar
// tab switch brings the pages back — so this is the real reopen path, not a fixture.
window.localStorage.setItem(`dsh-annotate:open:${SESSION}`, JSON.stringify({ targets: [ONE], active: ONE }))
const single = document.createElement('div')
document.body.appendChild(single)
const singleRoot = createRoot(single)
await act(async () => {
  singleRoot.render(React.createElement(AnnotateTab, { sessionId: SESSION }))
})
await settle()
check(single.querySelectorAll('iframe').length === 1, 'the remembered page is open',
  `${single.querySelectorAll('iframe').length} frame(s)`)
// The strip is present at one page because it carries the "new page" button. It used to
// be hidden below two pages, which is precisely why the reader could not open a second
// one; one tab is still exactly one tab.
check(single.querySelectorAll('.dsa-tab').length === 1,
  'and the one page is a single tab in a strip that is present from the start',
  `${single.querySelectorAll('.dsa-tab').length} tab(s)`)
check(Boolean(single.querySelector('.dsa-tab-new')),
  'and the strip carries the control that opens another page')

console.log('\n=== the address bar sits in the toolbar, the tabs are their own row ===')
// The reader circled the empty slab beside the toolbar buttons and wrote "此处已为空":
// the address bar was a row of its OWN, stacked directly under the tab strip, so the
// two read as one unit while the toolbar kept a hole where the address belonged.
// Both arrangements are the same three elements in a column, so only the CONTAINMENT
// tells them apart — and this is the one check in the suite with a real DOM.
{
  const bar = single.querySelector('.dsa-bar')
  const strip = single.querySelector('.dsa-tabs')
  check(Boolean(bar) && Boolean(strip), 'the panel renders a toolbar and a tab strip')
  const inBar = bar && bar.querySelector('.dsa-open-wrap')
  check(Boolean(inBar), 'the address bar is contained by the toolbar row')
  const between = bar && strip
    ? (bar.compareDocumentPosition(strip) & window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    : false
  check(between, 'and the toolbar is above the tab strip, not below it')
  check(!(strip && strip.contains(strip.parentElement ? strip.parentElement.querySelector('.dsa-open-wrap') : null)),
    'the tab strip does not contain the address bar, so the two are separate rows')
  check(Boolean(inBar) && Boolean(strip) && !inBar.contains(strip) && !strip.contains(inBar),
    'and neither contains the other — they are siblings, in different rows')
  check(!single.querySelector('.dsa-spacer'), 'and no spacer is left where the address bar goes')
}

console.log('\n=== one page open, and the reader can ask for a second one ===')
// This is the reported failure, driven the way the reader drives it: open the panel on
// one page, click the strip's "+" button, type another address into the bar that
// appears, press Enter. Before the fix there was no "+" at all — the strip only
// rendered from two pages up — so the second page was unreachable by construction.
//
// The mock below serves TWO pages of the SAME app on ONE port, which is the other half
// of the reported bug: with a distinct origin per page the mock could never show the
// host-side path-collapse that made both addresses one preview.
const SAME = 'http://127.0.0.1:41233'
window.localStorage.setItem(`dsh-annotate:open:${SESSION}`, JSON.stringify({ targets: [`${SAME}/a`], active: `${SAME}/a` }))
const addRoot = createRoot(document.createElement('div'))
const addHost = document.createElement('div')
document.body.appendChild(addHost)
const addPanel = createRoot(addHost)
await act(async () => {
  addPanel.render(React.createElement(AnnotateTab, { sessionId: SESSION }))
})
await settle()

const plus = addHost.querySelector('.dsa-tab-new')
check(Boolean(plus), 'the strip renders with a single page, so "new page" is reachable')

await act(async () => {
  plus.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await settle()
const box = addHost.querySelector('.dsa-open input')
check(Boolean(box), 'clicking it opens an address bar')
check(box && box.value === '', 'and the box is empty, since a new page is a new address',
  box && JSON.stringify(box.value))

await act(async () => {
  // React tracks the value internally, so set through the native setter the way a real
  // keystroke would; assigning `.value` alone leaves React's copy stale and the submit
  // posts the OLD value — which is how this probe first fooled itself.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(box, `${SAME}/b`)
  box.dispatchEvent(new window.Event('input', { bubbles: true }))
})
await settle()
await act(async () => {
  box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
})
await settle()

const addTabs = addHost.querySelectorAll('.dsa-tab')
check(addTabs.length === 2, 'a second page of the SAME app becomes a second tab',
  `${addTabs.length} tab(s) — one means the two addresses collapsed into one preview`)
check(addHost.querySelectorAll('iframe').length === 2, 'and it is mounted alongside the first',
  `${addHost.querySelectorAll('iframe').length} frame(s)`)
check(addHost.querySelectorAll('.dsa-tab[data-on="true"]').length === 1 &&
  addHost.querySelector('.dsa-tab[data-on="true"]').textContent.includes('/b'),
  'and the new page is the one on screen')

console.log('\n=== a session remembers several pages, and they ALL come back ===')
// Two remembered pages, which is the case the stale-`tabs` bug broke: the reopen loop
// awaits `/open` for each in turn, so both continuations read the tab list.
window.localStorage.setItem(`dsh-annotate:open:${SESSION}`, JSON.stringify({ targets: [ONE, TWO], active: TWO }))
const many = document.createElement('div')
document.body.appendChild(many)
const manyRoot = createRoot(many)
await act(async () => {
  manyRoot.render(React.createElement(AnnotateTab, { sessionId: SESSION }))
})
await settle()

const tabs = many.querySelectorAll('.dsa-tab')
const frameList = [...many.querySelectorAll('iframe')]
check(tabs.length === 2, 'both remembered pages come back as tabs', `${tabs.length} tab(s)`)
check(frameList.length === 2, 'and both stay mounted, so switching back is not a reload',
  `${frameList.length} frame(s)`)

const hiddenFrames = frameList.filter((f) => f.hasAttribute('hidden'))
check(hiddenFrames.length === 1, 'exactly the page behind is hidden', `${hiddenFrames.length} hidden`)
check(many.querySelectorAll('.dsa-tab[data-on="true"]').length === 1,
  'exactly one tab is marked active')
check(many.querySelectorAll('.dsa-tab-x').length === 2, 'and every tab can be closed')

const labels = [...many.querySelectorAll('.dsa-tab-name')].map((n) => n.textContent.trim())
check(labels.length === 2 && labels[0] !== labels[1],
  'the two tabs are distinguishable', labels.join(' | '))
check(labels.some((one) => one.includes('two')),
  'the page the session was on is among them, not silently replaced')

console.log('\n=== the active page is the one that was active, not the last opened ===')
// `openTarget` activates whatever it opens, so without restoring `active` after the
// loop the reader comes back to whichever page happened to be reopened last.
const activeTab = many.querySelector('.dsa-tab[data-on="true"]')
check(activeTab !== null && activeTab.textContent.includes('two'),
  'the remembered active page is the one on screen',
  activeTab ? activeTab.textContent.trim() : 'none')
check([...many.querySelectorAll('iframe')].length === 2,
  'and the set is not collapsed by starting the strip over')

console.log('\n=== closing a page leaves the other one working ===')
const before = posted.filter((p) => p.url.endsWith('/close')).length
const closeButton = many.querySelector('.dsa-tab-x')
check(Boolean(closeButton), 'a close control is rendered')
await act(async () => {
  closeButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await settle()

// One page left, so one tab — what must hold is that a page went and one stayed.
check(many.querySelectorAll('iframe').length === 1, 'one page is closed and the other remains',
  `${many.querySelectorAll('iframe').length} frame(s)`)
check(many.querySelectorAll('.dsa-tab').length === 1,
  'and the remaining page keeps its single tab',
  `${many.querySelectorAll('.dsa-tab').length} tab(s)`)
check(posted.filter((p) => p.url.endsWith('/close')).length === before + 1,
  'the host is told to release the preview, so the port does not linger')

const remembered = window.localStorage.getItem(`dsh-annotate:open:${SESSION}`)
check(Boolean(remembered) && !remembered.includes('one'),
  'and the closed page is no longer remembered', String(remembered))

// The panel must keep the heartbeat running while pages are open, because the host
// reaps a preview whose `touched` is stale and a background page sends no requests.
check(posted.some((p) => p.url.endsWith('/touch')),
  'the open pages are kept alive against the host\'s idle sweep',
  `${posted.filter((p) => p.url.endsWith('/touch')).length} beat(s)`)

console.log('')
if (failures) {
  console.log(`TAB DOM CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('TAB DOM CHECKS PASSED')
// Explicit exit: the panel leaves a heartbeat interval running while pages are open,
// so the event loop no longer drains on its own.
process.exit(0)
