/**
 * The count popup: the two things about it the reader reported.
 *
 *   1. Pressing ✎ opened the mark's card on the page but left this dialog sitting
 *      on top of it, so the card and the list were both on screen and neither was
 *      obviously the one to write in.
 *   2. The bulk clear "should" be added — except it is already there. What was
 *      actually wrong is where it sat: the whole dialog was one scrolling column,
 *      so a long list pushed 全部清除 below the fold. Present, working, and out of
 *      sight, which reads exactly like missing.
 *
 * Both are invisible to a source-level assertion — the button exists either way and
 * the popup renders either way — so this mounts the real tab, lets it open a real
 * preview, feeds it marks over the real page channel, and then clicks the real
 * buttons.
 *
 * The origin guard means the marks can only arrive from the preview the panel
 * opened, so the preview is seeded the way the panel itself persists one, and
 * `/open` answers with the origin the marks are then claimed to come from.
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
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
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

const ORIGIN = 'http://localhost:51999'
const SESSION = 's-popup'
const posted = []
global.fetch = async (url, options) => {
  posted.push({ url: String(url), body: options && options.body ? JSON.parse(options.body) : null })
  if (String(url).endsWith('/open')) {
    return { json: async () => ({ ok: true, origin: ORIGIN, url: `${ORIGIN}/a.html`, sid: 'sid1', servers: [], pages: [] }) }
  }
  if (String(url).endsWith('/pending')) return { json: async () => ({ ok: true, annotations: [] }) }
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

// Capture the panel's page-channel handler. Registered on mount, so this has to be
// in place before the first render.
const listeners = []
const originalAdd = window.addEventListener.bind(window)
window.addEventListener = (type, fn, opts) => {
  if (type === 'message') listeners.push(fn)
  return originalAdd(type, fn, opts)
}

// Tell the panel it already had a page open, so it opens one on mount and the origin
// guard has something to compare against.
window.localStorage.setItem(`dsh-annotate:open:${SESSION}`, `${ORIGIN}/a.html`)

const host = document.createElement('div')
document.body.appendChild(host)
const root = createRoot(host)
await act(async () => {
  root.render(React.createElement(AnnotateTab, { sessionId: SESSION }))
})
await act(async () => { await new Promise((r) => setTimeout(r, 60)) })

// A batch of marks, long enough that the action bar would be pushed out of a single
// scrolling column. Twelve rows is well past what fits in the dialog's 70vh cap.
const MARKS = Array.from({ length: 12 }, (_, i) => ({
  id: `a${i}`,
  note: `批注 ${i + 1}`,
  selector: `.target-${i + 1}`,
  text: `内容 ${i + 1}`,
  page: '/a.html',
}))

await act(async () => {
  for (const fn of listeners) fn({ data: { source: 'dsh-annotate-overlay', type: 'changed', annotations: MARKS }, origin: ORIGIN })
  await new Promise((r) => setTimeout(r, 260))
})

console.log('=== the counter appears and opens ===')
const summary = host.querySelector('.dsa-count > summary')
check(Boolean(summary), 'the toolbar carries a counter once marks exist')
check(summary && summary.textContent.includes('12'), 'showing how many are attached', summary && summary.textContent.trim())

summary.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await act(async () => { await new Promise((r) => setTimeout(r, 30)) })

const body = host.querySelector('.dsa-count-body')
check(Boolean(body), 'clicking it opens the list')
const rows = host.querySelectorAll('.dsa-count-body .dsa-item')
check(rows.length === 12, 'listing every mark', `${rows.length} row(s)`)

console.log('')
console.log('=== the bulk clear is reachable without scrolling ===')
// The structural half of the fix, asserted as structure because jsdom has no layout:
// the bar must not be inside the scrolling element, or a long list carries it out of
// view. That is the whole difference between "present" and "findable".
{
  const bar = host.querySelector('.dsa-count-main .dsa-bar')
  check(Boolean(bar), 'the action bar is in the dialog')
  const clear = bar && [...bar.querySelectorAll('button')].find((b) => b.textContent.includes('全部清除'))
  check(Boolean(clear), 'and it holds the bulk clear', clear && clear.textContent.trim())
  // The scrolling element is the list, and the bar must be its SIBLING — a bar inside
  // the scroller scrolls away with the content.
  const list = host.querySelector('.dsa-count-main .dsa-list')
  check(Boolean(list), 'the list is its own element inside the dialog')
  check(bar && list && !list.contains(bar) && bar.parentElement.classList.contains('dsa-count-main'),
    'the bar is a sibling of the scrolling list, not inside it, so it stays put',
    bar && list ? `bar parent: ${bar.parentElement.className}` : 'missing')
  check(clear && !clear.disabled, 'and it is enabled — clearing is always available')
}

console.log('')
console.log('=== clearing empties the list ===')
{
  const bar = host.querySelector('.dsa-count-main .dsa-bar')
  const clear = [...bar.querySelectorAll('button')].find((b) => b.textContent.includes('全部清除'))
  await act(async () => {
    clear.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    // Two stages, and the split is load-bearing rather than tidiness. `act` flushes
    // passive effects when its scope EXITS, so the mirror effect that was already
    // holding a 120 ms debounce for the batch is only torn down — and its pending
    // timer only cancelled — once this first short scope ends. Waiting past 120 ms
    // inside a single scope would let that stale timer fire first and post the batch
    // back, which is a property of `act`'s flushing, not of the panel: in a browser
    // the effect commits long before 120 ms and the timer never lands. So the first
    // scope is just long enough to let the clear's own report and the effect commit
    // happen, and the second lets the debounce window pass.
    await new Promise((r) => setTimeout(r, 20))
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 320))
  })
  const contextPosts = posted.filter((p) => p.url.includes('/context'))
  const after = contextPosts[contextPosts.length - 1]
  check(host.querySelectorAll('.dsa-count-body .dsa-item').length === 0,
    'the rows are gone', `${host.querySelectorAll('.dsa-count-body .dsa-item').length} left`)
  check(after && Array.isArray(after.body.annotations) && after.body.annotations.length === 0,
    'and the last thing the host hears is an empty batch, so the capsule stops counting',
    `${contextPosts.length} report(s), last had ${after ? after.body.annotations.length : '?'}`)
}

console.log('')
console.log('=== ✎ opens the mark and puts the dialog away ===')
{
  // Re-seed a batch.
  await act(async () => {
    for (const fn of listeners) fn({ data: { source: 'dsh-annotate-overlay', type: 'changed', annotations: MARKS.slice(0, 3) }, origin: ORIGIN })
    await new Promise((r) => setTimeout(r, 260))
  })
  const details = host.querySelector('.dsa-count')
  check(details && !details.open, 'the dialog starts closed')
  host.querySelector('.dsa-count > summary').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
  check(host.querySelector('.dsa-count').open, 'and opens on a click')

  const editBtn = host.querySelector('.dsa-count-body .dsa-item .dsa-mini')
  check(Boolean(editBtn), 'a row carries its edit button', editBtn && editBtn.textContent)
  const before = posted.filter((p) => p.url.includes('/open')).length
  await act(async () => {
    editBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 30))
  })
  check(!host.querySelector('.dsa-count').open,
    'pressing it closes the dialog, so the card on the page is not covered',
    `open=${host.querySelector('.dsa-count').open}`)
  check(posted.filter((p) => p.url.includes('/open')).length === before,
    'without reopening or reloading the page, which would drop the marks in progress')

  // The dialog has to stay usable afterwards. Closing it by toggling `open` rather
  // than unmounting means the list survives, so reopening shows the same marks
  // instead of an empty shell.
  host.querySelector('.dsa-count > summary').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
  check(host.querySelector('.dsa-count').open, 'it can be reopened')
  check(host.querySelectorAll('.dsa-count-body .dsa-item').length === 3,
    'and still lists the batch, so only the dialog was dismissed and no state was lost',
    `${host.querySelectorAll('.dsa-count-body .dsa-item').length} row(s)`)
}

console.log('')
console.log('=== marks from several pages are grouped, and numbered within each page ===')
{
  // The reported fault, on the surface the reader reads it on: one mark on page B
  // and two on page A, with page B marked FIRST. The list used to be a single
  // sequence numbered 1..3, which no page could agree with — a page only ever
  // loads its own marks, so it can only ever count from 1.
  //
  // Three things have to hold at once, and each is asserted separately below: the
  // pages are separated by a heading, the numbers restart per page, and the pages
  // appear in the order the reader first marked in them. The last one is why the
  // fixture is ordered this way: `beta.html` is marked before `alpha.html`, so a
  // sort by document position or by name would put them the other way round.
  const SPREAD = [
    { id: 'b1', note: '乙页第一条', selector: '.b1', text: 'B one', page: '/beta.html', createdAt: 1000 },
    { id: 'a1', note: '甲页第一条', selector: '.a1', text: 'A one', page: '/alpha.html', createdAt: 2000 },
    { id: 'a2', note: '甲页第二条', selector: '.a2', text: 'A two', page: '/alpha.html', createdAt: 3000 },
  ]
  await act(async () => {
    for (const fn of listeners) fn({ data: { source: 'dsh-annotate-overlay', type: 'changed', annotations: SPREAD }, origin: ORIGIN })
    await new Promise((r) => setTimeout(r, 260))
  })
  const details = host.querySelector('.dsa-count')
  if (details && !details.open) {
    host.querySelector('.dsa-count > summary').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
  }

  const groups = [...host.querySelectorAll('.dsa-count-body .dsa-group')]
  check(groups.length === 2, 'a heading per page, and none for a single-page list', `${groups.length} heading(s)`)
  const labels = groups.map((g) => (g.querySelector('.dsa-group-page') || {}).textContent)
  check(labels.join(' | ') === '/beta.html | /alpha.html',
    'and the pages appear in the order the reader first marked in them, not by name or position',
    labels.join(' | '))
  const counts = groups.map((g) => (g.querySelector('.dsa-group-count') || {}).textContent)
  check(counts.join(' | ') === '1 | 2', 'each heading says how many marks its page holds', counts.join(' | '))

  // The numbers are the group's, so both pages restart at 1 — and each is the
  // number that page's own pin wears, which is the property the whole change is
  // for. Read as pairs so a number cannot be checked against the wrong page.
  const numbered = [...host.querySelectorAll('.dsa-count-body .dsa-item .dsa-num')].map((n) => n.textContent)
  check(numbered.join(' | ') === '1 | 1 | 2',
    'the numbers restart within each page rather than running through the session',
    numbered.join(' | '))
  // Guards the fixture: were every mark on one page the headings would be absent
  // and the numbers would read 1 | 2 | 3, so this asserts the two really differ.
  check(numbered.join(' | ') !== '1 | 2 | 3', 'and that is not the same as numbering the whole list')

  // A single page must NOT grow a heading: the common case stays as it was.
  await act(async () => {
    for (const fn of listeners) fn({ data: { source: 'dsh-annotate-overlay', type: 'changed', annotations: SPREAD.slice(1, 3) }, origin: ORIGIN })
    await new Promise((r) => setTimeout(r, 260))
  })
  check(host.querySelectorAll('.dsa-count-body .dsa-group').length === 0,
    'a list from one page carries no heading at all')
  const flat = [...host.querySelectorAll('.dsa-count-body .dsa-item .dsa-num')].map((n) => n.textContent)
  check(flat.join(' | ') === '1 | 2', 'and its numbers are the plain 1..n the reader expects', flat.join(' | '))
}

console.log('')
if (failures) {
  console.log(`${failures} failure(s)`)
  process.exit(1)
}
console.log('all checks passed')
// Explicit exit, because the panel now keeps a heartbeat interval alive while pages
// are open: the event loop no longer drains on its own once the component is mounted,
// so a check that simply runs off the end of the file would hang forever.
process.exit(0)
