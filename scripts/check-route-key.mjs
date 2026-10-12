/**
 * Route-change checks: one attached list, one pin per view.
 *
 * A single-page app changes the address without loading a document. Three
 * separate ways do it, and the overlay used to hear only one of them:
 *
 *   1. `history.pushState` / `replaceState` — fire NO event at all.
 *   2. assigning `location.hash`             — fires `hashchange`, not `popstate`.
 *   3. back / forward                        — fires `popstate`.
 *
 * Only the third was handled, so a hash-routed app never re-anchored: the marks
 * stayed bound to the view the reader had left, and because the storage key was
 * derived from the address they were also filed under the view they were made
 * on — so switching screens emptied the list. The reader's complaint was exactly
 * that: "切换了页面 之前的标注会失效".
 *
 * The fix is two separate ideas, and this file asserts both, because collapsing
 * them is what made the first attempt wrong:
 *
 *   - what is ATTACHED belongs to the browsing session, so the bucket is keyed
 *     by session alone and navigation must never drop or re-key the list;
 *   - what is DRAWN belongs to the route, so each annotation records the `page`
 *     it was made on and only its own view gets a pin.
 *
 * The two questions no longer share one answer, which is the whole point.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const jsdomDir = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/jsdom@29.1.1_@noble+hashes@2.3.0/node_modules'
const { JSDOM } = require(`${jsdomDir}/jsdom`)

// A hash-routed app mounted under a path prefix — the reader's own shape:
// every view shares one pathname and differs only after the `#`.
const START = 'http://localhost:5555/guicomm/#/home'
const overlaySrc = readFileSync(new URL('../lib/overlay.js', import.meta.url), 'utf8')

/**
 * Boot the overlay into a fresh window, the way the injector does.
 *
 * A function because the checks need TWO pages: one that navigates, and one that
 * comes up on empty storage to be handed a list it never stored. Reloading the
 * first window would not do — its in-memory state would survive, which is exactly
 * what a rebuilt page does not have.
 * @param url - the address the page boots on.
 * @param session - the session id the panel passes in.
 * @returns the window, its document, the messages it sent, and any script error.
 */
function bootOverlayPage(url, session) {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body style="margin:0">
       <div id="view"></div>
     </body></html>`,
    { url, pretendToBeVisual: true, runScripts: 'dangerously' },
  )
  const { window } = dom
  const { document } = window

  // jsdom does no layout, so every element would measure 0×0 and anchoring would
  // be vacuous. Real boxes make the placement meaningful.
  const BOX = { x: 30, y: 40, width: 240, height: 60 }
  window.Element.prototype.getBoundingClientRect = function () {
    const own = this.__box || BOX
    return {
      ...own,
      left: own.x,
      top: own.y,
      right: own.x + own.width,
      bottom: own.y + own.height,
      toJSON() {},
    }
  }
  window.Element.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()]
  }

  const posted = []
  window.__DSH_ANNOTATE__ = { session, parentOrigin: '*', upstream: 'http://localhost:5555' }
  Object.defineProperty(window, 'parent', { value: { postMessage: (msg) => posted.push(msg) }, configurable: true })
  window.scrollX = 0
  window.scrollY = 0
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0)
  window.CSS = window.CSS || { escape: (value) => String(value).replace(/[^\w-]/g, '\\$&') }
  document.elementFromPoint = () => hitTestTarget

  // Listen BEFORE the overlay's own handler so the DOM is already the new view
  // when the overlay's deferred pass runs — which is what a real router does.
  window.addEventListener('hashchange', () => renderApp(window, document))
  renderApp(window, document)

  const scriptEl = document.createElement('script')
  scriptEl.textContent = overlaySrc
  const scriptError = []
  window.addEventListener('error', (event) => scriptError.push(event.message || String(event.error)))
  document.head.appendChild(scriptEl)
  assert.deepEqual(scriptError, [], 'the overlay ran without throwing')
  assert.ok(window.__DSH_ANNOTATE_OVERLAY__, 'overlay installed')
  return { window, document, posted, scriptError }
}

let hitTestTarget = null

/** Render the view for a page's current address, the way a router would. */
function renderApp(window, document) {
  const which = window.location.hash === '#/command' ? 'command' : window.location.hash === '#/home' ? 'home' : 'other'
  const view = document.getElementById('view')
  view.textContent = ''
  const el = document.createElement('h2')
  el.id = which
  // Each view's headline sits in its own place, so a pin anchored on one view
  // has a distinct target rather than landing on whatever the next view drew.
  el.__box = { x: 30, y: which === 'home' ? 40 : 200, width: 240, height: 60 }
  el.textContent = which + ' view'
  view.appendChild(el)
}

const page = bootOverlayPage(START, 'test')
const { window, document, posted } = page

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const lastOf = (type, list) => [...(list || posted)].reverse().find((m) => m.type === type)
const pins = () => [...document.querySelectorAll('.dsa-pin')]
/**
 * The one bucket, named for the session and nothing else.
 *
 * There is deliberately no `route` argument: a per-route key is the defect this
 * file guards against, so the helper that reads storage must not be able to
 * express one. A route-shaped key would simply read `null` here.
 */
const KEY = 'dsh-annotate:v1:test'
const read = () => {
  const raw = window.localStorage.getItem(KEY)
  return raw ? JSON.parse(raw) : null
}

function clickAt(el) {
  const surface = document.querySelector('.dsa-capture')
  assert.ok(surface, 'capture surface is mounted while marking')
  hitTestTarget = el
  const box = el.getBoundingClientRect()
  surface.dispatchEvent(
    new window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: box.x + 5,
      clientY: box.y + 5,
    }),
  )
  hitTestTarget = null
}

/** Mark an element and save a note on it, through the real UI path. */
async function markAndSave(el, note) {
  clickAt(el)
  await wait(20)
  const card = document.querySelector('.dsa-card')
  assert.ok(card, 'a note card opened for the clicked element')
  if (note) {
    const textarea = card.querySelector('textarea')
    textarea.value = note
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  card.querySelector('[data-primary]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await wait(20)
}

// --- 1. boot ------------------------------------------------------------------
console.log('\n=== 1. boot announces the real address, and keys storage by session ===')
const boot = lastOf('ready')
assert.ok(boot, 'the overlay announced ready on boot')
assert.ok(boot.url.endsWith('/guicomm/#/home'), `ready carries the real address (${boot.url})`)
assert.equal(boot.path, '/guicomm/#/home', `and the route is reported as a route (${boot.path})`)
assert.equal(read(), null, 'no bucket exists before anything is marked')

window.postMessage({ source: 'dsh-annotate-panel', type: 'mode', mode: 'marking' }, '*')
await wait(20)
assert.ok(document.querySelector('.dsa-capture'), 'marking mode is active')

console.log('\n=== 2. a mark is stored once, tagged with the view that made it ===')
await markAndSave(document.getElementById('home'), 'belongs to home')
const afterHome = read()
assert.ok(afterHome, 'the entry landed in the session bucket')
assert.equal(afterHome.length, 1, 'one entry is held for the session')
assert.equal(afterHome[0].note, 'belongs to home')
assert.equal(afterHome[0].page, '/guicomm/#/home', 'and it records the route it was made on')
console.log('  key:', KEY, '| page:', JSON.stringify(afterHome[0].page))

// --- 3. navigation keeps the list, moves only the pins ------------------------
console.log('\n=== 3. a hash route change keeps the attachment ===')
window.location.hash = '#/command'
await wait(80)

const moved = lastOf('ready')
assert.notEqual(moved, boot, 'a route change was announced, not only the boot')
assert.ok(moved.url.endsWith('/guicomm/#/command'), `the address follows the route (${moved.url})`)
assert.equal(moved.path, '/guicomm/#/command', `the route follows too (${moved.path})`)
// THE REGRESSION. Under the per-route build this was 0 — the reader's marks
// vanished on every menu click. Switching screens must not touch the list.
assert.equal(moved.annotations.length, 1, 'the mark made on #/home is STILL attached')
// ...while the drawing is honest about where it belongs: #/command is a
// different screen, and a pin for an element that is not here would be a lie.
assert.equal(pins().length, 0, 'no pin is drawn for a mark from another view')
console.log('  announced:', moved.path, '| attached:', moved.annotations.length, '| pins here:', pins().length)

// --- 4. the bucket did not move ----------------------------------------------
console.log('\n=== 4. the bucket is the same one, with the same entry ===')
const afterMove = read()
assert.equal(afterMove.length, 1, 'the session bucket still holds the entry')
assert.equal(afterMove[0].page, '/guicomm/#/home', 'still filed under the view it was made on')

// --- 5. navigating back restores the pin, not the list -----------------------
console.log('\n=== 5. returning to a view restores its pin ===')
window.location.hash = '#/home'
await wait(80)
const back = lastOf('ready')
assert.equal(back.path, '/guicomm/#/home', `the route is back on #/home (${back.path})`)
assert.equal(back.annotations.length, 1, 'the list is unchanged by having left and returned')
assert.equal(pins().length, 1, 'and a pin is drawn for it against the restored DOM')
console.log('  restored pins:', pins().length)

// --- 6. a mark on the second view joins the same list ------------------------
console.log('\n=== 6. marking a second view adds to the one list ===')
window.location.hash = '#/command'
await wait(80)
await markAndSave(document.getElementById('command'), 'belongs to command')
const both = lastOf('changed') || lastOf('ready')
assert.equal(both.annotations.length, 2, 'both views\' marks are attached together')
const stored = read()
assert.equal(stored.length, 2, 'and both are in the one session bucket')
assert.deepEqual(
  stored.map((entry) => entry.page).sort(),
  ['/guicomm/#/command', '/guicomm/#/home'],
  'each entry records the view it came from',
)
assert.equal(pins().length, 1, 'only the current view\'s mark is drawn')
console.log('  attached:', both.annotations.length, '| pages:', stored.map((e) => e.page).join(' , '))

// The reported fault, on a scenario that produces it: two marks, two routes, and
// both pins reading 1. This used to be the complaint — the panel numbered the
// whole session while each page could only number itself — and the fix was to
// stop fighting it: the page is what a number is local to, because every tab is
// its own origin and therefore its own storage, so a page loads only its own
// marks and any count it makes starts at 1. A session-wide number is not merely
// inconvenient here, it is unrepresentable on the page.
//
// So the panel groups by page and numbers within the group, and this asserts the
// two surfaces agree on that — including the case that used to be the bug, where
// both pages legitimately say 1.
//
// Read from the reported list rather than from storage: the number the reader
// sees beside the element has to match the number on the row they read, and the
// row is built from what the panel announced.
{
  const listed = both.annotations
  // The panel's rule, mirrored: number within the page, in the order that page
  // lists its marks.
  const seen = new Map()
  const rowOf = new Map()
  for (const entry of listed) {
    const n = (seen.get(entry.page) || 0) + 1
    seen.set(entry.page, n)
    rowOf.set(entry.page + ' ' + entry.selector, n)
  }
  for (const pin of pins()) {
    const key = pin.__annotation.page + ' ' + pin.__annotation.selector
    assert.equal(
      Number(pin.textContent),
      rowOf.get(key),
      `the pin for ${key} wears its own page's row number`,
    )
  }
  // One mark per route, so each route numbers from 1 — and the two surfaces agree
  // because both scope to the page. Asserted from the panel's list, since one pin
  // is off-screen.
  //
  // Joined rather than `deepEqual`ed: `listed` comes from the jsdom realm, whose
  // `Array.prototype` is not this one, so a strict deep comparison rejects two
  // byte-identical arrays. The values are what this assertion is about.
  assert.equal(
    [...seen.values()].join(' | '),
    '1 | 1',
    'each route holds one mark and numbers it 1, and the panel says the same',
  )
  // The pin on screen must be its own page's 1, not a session-wide 2. Without this
  // the block above passes whenever each route happens to draw its own single pin.
  assert.equal(
    Number(pins()[0].textContent),
    1,
    'the second route numbers its mark 1, matching the group the panel lists it in',
  )
  console.log(`  pin on #/command reads ${pins()[0].textContent}; each route's group numbers from 1`)
}

// --- 7. pushState fires no event, so it must be wrapped ----------------------
console.log('\n=== 7. pushState re-anchors without any navigation event ===')
const view = document.getElementById('view')
view.textContent = ''
const other = document.createElement('h2')
other.id = 'other'
other.__box = { x: 30, y: 300, width: 240, height: 60 }
other.textContent = 'other view'
view.appendChild(other)
window.history.pushState(null, '', '/guicomm/other')
await wait(80)
const pushed = lastOf('ready')
assert.notEqual(pushed, back, 'pushState was noticed even though it fires no event')
assert.equal(pushed.path, '/guicomm/other', `the route is the pushed path (${pushed.path})`)
assert.equal(pushed.annotations.length, 2, 'and the attachment survived it as well')
assert.equal(pins().length, 0, 'with no pins, since neither mark belongs to this route')
console.log('  route after pushState:', pushed.path, '| attached:', pushed.annotations.length)

// The reader's second complaint: the address must show the whole thing, not
// just a host and port. Every announcement carries what the bar needs.
console.log('\n=== 8. replaceState is wrapped too, and keeps the marks ===')
// `replaceState` is the other half of the history API and also fires no event. It
// is the one a router reaches for when it must not add a history entry — a
// redirect, or normalising a URL — so a page that navigates only that way would
// otherwise never be noticed at all.
window.history.replaceState(null, '', '/guicomm/other?tab=logs#row-3')
await wait(80)
const replaced = lastOf('ready')
assert.notEqual(replaced, pushed, 'replaceState was noticed even though it fires no event')
assert.equal(replaced.path, '/guicomm/other?tab=logs#row-3',
  `the route is what replaceState set (${replaced.path})`)
// Search and hash are part of the route, because a view is very often selected by
// them rather than by path.
assert.equal(replaced.annotations.length, 2, 'and the attachment survived it too')
assert.ok(replaced.url.endsWith('/guicomm/other?tab=logs#row-3'),
  `and the announced address carries query and hash (${replaced.url})`)
console.log('  route after replaceState:', replaced.path)

console.log('\n=== 9. every announcement carries a usable address ===')
const announced = posted.filter((m) => m.type === 'ready')
for (const message of announced) {
  assert.ok(typeof message.url === 'string' && message.url.length > 0, 'each ready carries a url')
  assert.ok(/^https?:\/\//.test(message.url), `the url is absolute (${message.url})`)
}
const distinct = new Set(announced.map((m) => m.url))
assert.ok(distinct.size >= 4, `the address changed as the reader navigated (${[...distinct].join(' , ')})`)
console.log('  addresses seen:', [...distinct].join('\n                  '))

// --- 10. the host hands a lost list back --------------------------------------
console.log('\n=== 10. a rebuilt page adopts the list the host still holds ===')
// The preview is an ephemeral loopback origin. When it is reaped and reopened the
// page comes up on a FRESH origin whose storage is empty — so it reports nothing —
// while the host is still holding the marks the reader attached, and the composer
// capsule is still counting them. Without a way back the two sides disagree
// permanently: the panel lists nothing while the capsule insists there are two.
//
// A distinct page, not a reload: a reload would keep the overlay's in-memory
// state, which is exactly what a rebuilt origin does not have.
const heldMarks = read()
const rebuilt = bootOverlayPage('http://localhost:5555/guicomm/#/home', 'test')
assert.equal(
  rebuilt.window.localStorage.getItem(KEY),
  null,
  'the rebuilt page starts with empty storage',
)
assert.equal(lastOf('ready', rebuilt.posted).annotations.length, 0,
  'so it reports nothing of its own')
// The panel answers the empty report with what the host holds.
rebuilt.window.postMessage({ source: 'dsh-annotate-panel', type: 'restore', annotations: heldMarks }, '*')
await wait(80)
const restored = lastOf('changed', rebuilt.posted)
assert.ok(restored, 'the page announced the adoption')
assert.equal(restored.annotations.length, 2, 'both held marks are back in the list')
const reStored = JSON.parse(rebuilt.window.localStorage.getItem(KEY))
assert.deepEqual(
  reStored.map((entry) => entry.page).sort(),
  ['/guicomm/#/command', '/guicomm/#/home'],
  'and are persisted again, each still filed under its own view',
)
assert.equal([...rebuilt.document.querySelectorAll('.dsa-pin')].length, 1,
  'the pin for this route is drawn again')
// Merging, not overwriting: a page that already has the marks must not double them.
rebuilt.window.postMessage({ source: 'dsh-annotate-panel', type: 'restore', annotations: heldMarks }, '*')
await wait(60)
assert.equal(JSON.parse(rebuilt.window.localStorage.getItem(KEY)).length, 2,
  'a second restore of the same marks does not duplicate them')
console.log('  restored:', restored.annotations.length, '| pages:', reStored.map((e) => e.page).join(' , '))

console.log('\nroute-key checks passed')
