/**
 * Overlay behaviour checks, run against a real DOM.
 *
 * Two behaviours define this build and are asserted here directly:
 *   1. An empty note is KEPT as an entry (not discarded).
 *   2. The note card docks BELOW the element when there is room.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

// The script is an ES module (top-level await), so CJS jsdom comes in through
// createRequire rather than a bare require().
const require = createRequire(import.meta.url)
const jsdomDir = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/jsdom@29.1.1_@noble+hashes@2.3.0/node_modules'
const { JSDOM } = require(`${jsdomDir}/jsdom`)

const dom = new JSDOM(
  `<!doctype html><html><head></head><body style="margin:0">
     <h1 id="title">Pricing</h1>
     <div class="plans">
       <div class="pricing-card" style="position:absolute;left:320px;top:180px;width:300px;height:200px">Pro</div>
     </div>
     <button class="primary" style="position:absolute;left:640px;top:520px;width:90px;height:30px">Save changes</button>
   </body></html>`,
  // `runScripts: 'dangerously'` is what actually executes an injected script
  // element; without it jsdom parses the tag and runs nothing.
  { url: 'http://localhost:5555/pricing', pretendToBeVisual: true, runScripts: 'dangerously' },
)
const { window } = dom
const { document } = window

// jsdom leaves layout at zero; give the elements real boxes so anchoring is
// meaningful rather than testing against 0×0 rects.
const boxes = {
  'div.pricing-card': { x: 320, y: 180, width: 300, height: 200 },
  'button.primary': { x: 640, y: 520, width: 90, height: 30 },
  '#title': { x: 20, y: 20, width: 200, height: 40 },
}
const rectOf = (el) => {
  for (const [selector, box] of Object.entries(boxes)) {
    try {
      if (el.matches && el.matches(selector)) {
        return { ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, toJSON() {} }
      }
    } catch {
      /* ignore */
    }
  }
  return { x: 0, y: 0, width: 120, height: 24, left: 0, top: 0, right: 120, bottom: 24, toJSON() {} }
}
window.Element.prototype.getBoundingClientRect = function () {
  return rectOf(this)
}
window.Element.prototype.getClientRects = function () {
  return [this.getBoundingClientRect()]
}

// The overlay posts to `parent`; capture what it says.
const posted = []
window.__DSH_ANNOTATE__ = { session: 'test', parentOrigin: '*', upstream: 'http://localhost:5555' }
Object.defineProperty(window, 'parent', { value: { postMessage: (msg) => posted.push(msg) }, configurable: true })
window.scrollX = 0
window.scrollY = 0
window.requestAnimationFrame = (fn) => setTimeout(fn, 0)
window.CSS = window.CSS || { escape: (value) => String(value).replace(/[^\w-]/g, '\\$&') }

const overlaySrc = readFileSync(new URL('../lib/overlay.js', import.meta.url), 'utf8')
// Run it the way the proxied document does: a classic script in the page's own
// realm. `window.eval` would evaluate in Node's scope, where `window` is not a
// global, so a script element is used instead.
const scriptEl = document.createElement('script')
scriptEl.textContent = overlaySrc
const scriptError = []
window.addEventListener('error', (event) => scriptError.push(event.message || String(event.error)))
document.head.appendChild(scriptEl)
if (scriptError.length) console.log('script errors:', scriptError)
if (!window.__DSH_ANNOTATE_OVERLAY__) {
  console.log('config present:', Boolean(window.__DSH_ANNOTATE__), '| already installed:', Boolean(window.__DSH_ANNOTATE_OVERLAY__))
}

assert.ok(window.__DSH_ANNOTATE_OVERLAY__, 'overlay installed')
const ready = posted.find((m) => m.type === 'ready')
assert.ok(ready, 'overlay reported ready on boot')
console.log('overlay booted; ready message:', JSON.stringify(ready.annotations))

const layer = document.querySelector('.dsa-layer')
assert.ok(layer, 'overlay layer mounted')

// --- enter marking mode -------------------------------------------------------
window.postMessage({ source: 'dsh-annotate-panel', type: 'mode', mode: 'marking' }, '*')
await new Promise((r) => setTimeout(r, 20))

const capture = document.querySelector('.dsa-capture')
assert.ok(capture, 'capture surface appears while marking')

/**
 * jsdom implements no hit-testing, so `document.elementFromPoint` is absent
 * entirely. The overlay depends on it to resolve the element under the cursor,
 * so a stub is installed on the page's own document.
 */
let hitTestTarget = null
document.elementFromPoint = () => hitTestTarget

/** Click an element the way a user would, through the capture surface. */
function clickAt(el) {
  const box = rectOf(el)
  // Re-query: the capture surface is mounted/removed as the mode changes.
  const surface = document.querySelector('.dsa-capture')
  assert.ok(surface, 'capture surface is mounted while marking')
  hitTestTarget = el
  const event = new window.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    clientX: box.x + 5,
    clientY: box.y + 5,
  })
  surface.dispatchEvent(event)
  hitTestTarget = null
}

/**
 * Click an element and save the note card it opens.
 *
 * Hoisted to module scope because more than one section needs it: it was
 * declared inside the pin-numbering block, so the first section that wanted it
 * elsewhere died with a `ReferenceError`. Annotations are made through the real
 * click path on purpose — that is the only route that reaches `commit` and so
 * the real pin list.
 * @param node - the element to mark.
 */
async function markAndSave(node) {
  clickAt(node)
  await new Promise((r) => setTimeout(r, 20))
  const card = document.querySelector('.dsa-card')
  assert.ok(card, 'a card opened for the clicked element')
  card.querySelector('[data-primary]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 20))
}

/**
 * The panel's real reading order, lifted from the shipped source.
 *
 * A copy of the rule written out here would agree with itself while the shipped
 * pair disagreed, so the client's own function is the one under test. Both halves
 * are lifted: `inReadingOrder` is a flat view of `pageGroups`, so evaluating it
 * without `pageGroups` in scope would report a missing binding rather than test
 * anything.
 * @param list - entries to order.
 * @returns them page by page, top-to-bottom then left-to-right within each.
 */
const inReadingOrder = (() => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const slice = (marker) => {
    const from = src.indexOf(marker)
    if (from === -1) throw new Error(`the bundle no longer defines ${marker}`)
    const to = src.indexOf('\n    }', from)
    return src.slice(from, to + '\n    }'.length)
  }
  // Both halves: `inReadingOrder` is a flat view over `pageGroups`, so lifting it
  // alone would fail on a missing binding rather than test the ordering.
  return new Function(
    `${slice('function pageGroups(')}\n${slice('function inReadingOrder(')}\n return inReadingOrder`,
  )()
})()

// --- ① click with NO note: the entry must survive -----------------------------
clickAt(document.querySelector('button.primary'))
await new Promise((r) => setTimeout(r, 20))

let noteCard = document.querySelector('.dsa-card')
if (!noteCard) {
  console.log('DIAG capture present:', Boolean(document.querySelector('.dsa-capture')))
  console.log('DIAG layer children:', [...(document.querySelector('.dsa-layer')?.children || [])].map((n) => n.className).join(' | '))
  console.log('DIAG posted types:', posted.map((m) => m.type).join(','))
  console.log('DIAG elementFromPoint stub returns:', document.elementFromPoint(0, 0)?.className || document.elementFromPoint(0, 0)?.tagName)
}
assert.ok(noteCard, 'note card opens on click')

// The card must sit BELOW the element, not to its right.
const cardTop = Number.parseFloat(noteCard.style.top)
const cardLeft = Number.parseFloat(noteCard.style.left)
const buttonBox = rectOf(document.querySelector('button.primary'))
console.log('element bottom:', buttonBox.bottom, '| card top:', cardTop, '| card left:', cardLeft)
assert.ok(cardTop >= buttonBox.bottom, '② card docks below the element')
assert.ok(cardLeft >= 8, 'card stays on screen')

// Save with the textarea left empty.
const textarea = noteCard.querySelector('textarea')
assert.equal(textarea.value, '', 'textarea starts empty')
noteCard.querySelector('[data-primary]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 20))

const changed = posted.filter((m) => m.type === 'changed')
const afterEmpty = changed[changed.length - 1]
assert.ok(afterEmpty, 'a change was reported after saving an empty note')
assert.equal(afterEmpty.annotations.length, 1, '① empty note is KEPT as an annotation')
assert.equal(afterEmpty.annotations[0].note, '', 'the kept entry has a blank note')
// The builder prefers an id, then a data-testid, then a class that resolves to a
// single element, and only then a positional chain. Whatever form it picks, it
// must resolve to the element that was clicked — asserted by resolution rather
// than by shape, so a better selector is not a test failure.
const pickedSelector = afterEmpty.annotations[0].selector
assert.ok(pickedSelector, 'a selector was produced')
const resolved = document.querySelectorAll(pickedSelector)
assert.equal(resolved.length, 1, `selector resolves to exactly one element (${pickedSelector})`)
assert.equal(resolved[0].tagName.toLowerCase(), 'button', 'selector resolves to the clicked element')
assert.equal(afterEmpty.annotations[0].tag, 'button')
console.log('① empty note kept:', JSON.stringify(afterEmpty.annotations[0].selector), '| note:', JSON.stringify(afterEmpty.annotations[0].note))

// --- ② add a note to a second element ----------------------------------------
clickAt(document.querySelector('div.pricing-card'))
await new Promise((r) => setTimeout(r, 20))
noteCard = document.querySelector('.dsa-card')
assert.ok(noteCard, 'card opens for the second element')
const area2 = noteCard.querySelector('textarea')
area2.value = '这个卡片太宽，改成 320px'
// React is not involved here; the badge updates on input, so fire one.
area2.dispatchEvent(new window.Event('input', { bubbles: true }))
const badge = noteCard.querySelector('.dsa-kind')
assert.equal(badge.getAttribute('data-kind'), 'note', 'badge switches to note once text is typed')
noteCard.querySelector('[data-primary]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 20))

const changed2 = posted.filter((m) => m.type === 'changed')
const final = changed2[changed2.length - 1]
assert.equal(final.annotations.length, 2, 'both entries exist')
const withNote = final.annotations.find((a) => a.note)
assert.ok(withNote, 'the noted entry persisted its note')
assert.equal(withNote.note, '这个卡片太宽，改成 320px')
console.log('② note persisted:', JSON.stringify(withNote.note))

// Both shapes coexist, which is the whole point. Compared as a joined string
// because the annotation array is built inside the jsdom realm and so carries a
// different Array prototype than this module's.
const shapes = final.annotations.map((a) => (a.note ? 'note' : 'mark')).sort()
assert.equal(shapes.join(','), 'mark,note', 'a bare mark and a note live side by side')

// Pins are numbered and rendered for both.
const pins = document.querySelectorAll('.dsa-pin')
assert.equal(pins.length, 2, 'two numbered pins rendered')
console.log('pins:', [...pins].map((p) => `${p.textContent}:${p.getAttribute('data-kind')}`).join(' '))

// --- the numbers agree with the panel's rows ---------------------------------
// The two surfaces number the same marks, so they have to number them the same
// way. The panel sorts by where an element sits on the page; the pins were
// numbered in the order the marks were MADE, and the two disagree as soon as a
// reader marks something and then marks something further up the page — pin 1
// sits at the bottom while row 1 is the element at the top, and the same number
// means two different things depending on which surface you look at.
//
// The same number must also survive a route change. Marks belong to the session,
// so marking one element on #/home and another on #/users used to give the reader
// two pins both reading 1 — because the pin counter restarted per route while the
// panel and the model's `## Element n` counted the session. That case is asserted
// in check-route-key.mjs, against a page that really navigates.
console.log('\n--- pins and panel rows number the same marks the same way ---')
{
  // Mark in an order that does NOT match the page: the element further down is
  // marked first. This is the case that used to disagree.
  const lower = document.createElement('div')
  lower.className = 'lower-target'
  lower.textContent = 'lower'
  document.body.appendChild(lower)
  // Parked inside the viewport rather than below the fold: a mark that is merely
  // scrolled out is not drawn at all, so a y past the fold would leave this
  // element without a pin and quietly stop exercising the ordering.
  boxes['div.lower-target'] = { x: 40, y: 700, width: 120, height: 30 }
  const upper = document.createElement('div')
  upper.className = 'upper-target'
  upper.textContent = 'upper'
  document.body.appendChild(upper)
  boxes['div.upper-target'] = { x: 40, y: 60, width: 120, height: 30 }

  await markAndSave(lower)
  await markAndSave(upper)

  const rows = inReadingOrder(posted.filter((m) => m.type === 'changed').pop().annotations)
  const drawn = [...document.querySelectorAll('.dsa-pin')]

  // Compared number by number, not by counting: equal counts are exactly what the
  // bug produced — both surfaces drew three numbers, just over different elements.
  // A pin wearing N must name the element row N lists.
  const rowByNumber = new Map(rows.map((a, i) => [i + 1, a.text]))
  for (const pin of drawn) {
    const n = Number(pin.textContent)
    assert.equal(
      pin.__annotation.text,
      rowByNumber.get(n),
      `pin ${n} names the element row ${n} lists`,
    )
  }
  // Guards the fixture itself: if the panel's sort happened to agree with creation
  // order, this would pass without exercising anything.
  const creationOrder = posted.filter((m) => m.type === 'changed').pop().annotations.map((a) => a.text)
  assert.notEqual(
    rows.map((a) => a.text).join(' | '),
    creationOrder.join(' | '),
    'the fixture really does mark out of page order',
  )
  // And the out-of-order mark really is on screen, or the assertion above is
  // vacuous for the element this section exists to test.
  assert.ok(
    drawn.some((p) => p.__annotation.text === 'lower'),
    'the mark made second-but-higher-on-the-page is drawn',
  )
  const byNumber = drawn.map((p) => `${p.textContent}:${p.__annotation.text}`).sort().join(' ')
  console.log(`  marked lower-then-upper -> pins by number ${byNumber}`)
}

// --- the numbers name marks, not screen positions -----------------------------
// The reader's report: two marks on two routes, both pins reading 1. The pin
// counter restarted at 1 on every route while the panel numbered the whole
// session, so the same number named two different elements.
//
// Numbering is therefore by the mark's place in the session list, which is the
// property this section pins down: the numbers are unique, a mark that cannot be
// drawn here keeps its number rather than handing it to a neighbour, and every
// pin still wears the number the panel gives that same entry. The gap that leaves
// is deliberate — the old gapless rule was what produced two 1s, and the two
// cannot both hold.
//
// Note what is NOT asserted: that a number never changes. Inserting a mark above
// the others legitimately renumbers them, because the panel renumbers too — both
// surfaces sort by position on the page. What must never happen is the two
// disagreeing, so every assertion here is a cross-surface comparison.
console.log('\n--- pin numbers are the marks\' own numbers ---')
{
  const labelled = () => [...document.querySelectorAll('.dsa-pin')]
  const numberById = () => {
    const out = new Map()
    for (const pin of labelled()) out.set(pin.__annotation.id, Number(pin.textContent))
    return out
  }
  /** The number the panel gives each entry, keyed by id, from the last report. */
  const rowsById = () => {
    const listed = inReadingOrder(posted.filter((m) => m.type === 'changed').pop().annotations)
    return new Map(listed.map((a, i) => [a.selector, i + 1]))
  }
  /** Every drawn pin must wear the panel's number for the entry it points at. */
  const assertAgrees = (label) => {
    const rows = rowsById()
    for (const pin of labelled()) {
      assert.equal(
        Number(pin.textContent),
        rows.get(pin.__annotation.selector),
        `${label}: the pin for ${pin.__annotation.selector} wears its panel row number`,
      )
    }
  }

  const before = numberById()
  const beforeLabels = [...before.values()]
  assert.equal(
    new Set(beforeLabels).size,
    beforeLabels.length,
    'no two pins wear the same number',
    JSON.stringify(beforeLabels),
  )
  assert.ok(labelled().length >= 2, 'at least two pins exist', `${labelled().length}`)
  assertAgrees('before any new mark')

  // The reader's next move: mark something else. Whatever number it lands on, the
  // pin and the panel have to land on the same one.
  const third = document.createElement('div')
  third.className = 'third-target'
  third.textContent = 'third'
  document.body.appendChild(third)
  boxes['div.third-target'] = { x: 40, y: 640, width: 120, height: 30 }
  await markAndSave(third)

  const withThird = numberById()
  const thirdPin = labelled().find((p) => p.__annotation.text === 'third')
  assert.ok(thirdPin, 'the new mark is drawn')
  const thirdNumber = Number(thirdPin.textContent)
  assert.equal(
    new Set([...withThird.values()]).size,
    withThird.size,
    'the new mark does not share a number with an existing one',
    JSON.stringify([...withThird.values()]),
  )
  assertAgrees('after a new mark')

  // Now detach one so its pin cannot anchor. The survivors must NOT renumber:
  // their numbers name entries the panel still lists, and renumbering is what
  // made a mark's number depend on which page the reader happened to be on.
  const lost = thirdPin.__annotation
  third.remove()
  window.dispatchEvent(new window.Event('resize'))
  await new Promise((r) => setTimeout(r, 80))

  const after = numberById()
  const afterLabels = [...after.values()]
  assert.equal(
    new Set(afterLabels).size,
    afterLabels.length,
    'still no two pins wear the same number',
    JSON.stringify(afterLabels),
  )
  assert.ok(
    labelled().length === before.size + 1 - 1,
    'the pin for the detached element is gone, not merely renumbered',
  )
  for (const [id, n] of withThird) {
    if (id === lost.id) continue
    assert.equal(after.get(id), n, `surviving mark ${id} keeps the number it had`)
  }
  assert.ok(!afterLabels.includes(thirdNumber),
    'and the detached mark\'s number is retired rather than reused',
    `${thirdNumber} still in ${afterLabels}`)
  // The entry itself is still listed — only its pin is gone — so the panel now
  // holds a number no pin wears. That is the deliberate gap, and the survivors
  // must still agree with the panel rather than closing ranks to fill it.
  assertAgrees('after a mark can no longer be drawn')
  console.log(`  before ${JSON.stringify(beforeLabels)} -> after ${JSON.stringify(afterLabels)} (numbers held, gap left on purpose)`)
}

// --- a mark keeps its number across a route change ----------------------------
// The reader's report, verbatim: two marks on two screens of one app, and both
// pins read 1. The pin counter restarted on every route while the panel and the
// model's `## Element n` counted the whole session — and because a mark now
// belongs to the session rather than the view, nothing stopped the second route
// from starting again at 1.
//
// Numbering by the mark's place in the session list is what makes the three
// surfaces agree, so this section drives a real navigation: it marks one element
// on the first route, moves to another route, marks a second element there, and
// asserts the two pins carry the numbers the panel gives those same two entries.
console.log('\n--- a mark keeps its number across a route change ---')
{
  // The page is driven onto a hash route and a second view is installed there,
  // the way a router swaps its outlet. `location` is jsdom's, so the hash is
  // changed for real and the overlay's own `hashchange` listener runs.
  const routeA = document.createElement('div')
  routeA.className = 'route-a'
  const onlyA = document.createElement('button')
  onlyA.className = 'only-a'
  onlyA.textContent = 'on route A'
  routeA.appendChild(onlyA)
  document.body.appendChild(routeA)
  boxes['button.only-a'] = { x: 40, y: 300, width: 120, height: 30 }

  window.location.hash = '#/a'
  await new Promise((r) => setTimeout(r, 40))

  await markAndSave(onlyA)
  const onA = [...document.querySelectorAll('.dsa-pin')].map((p) => Number(p.textContent))
  assert.ok(onA.length > 0, 'the mark on the first route is drawn', JSON.stringify(onA))

  // Now navigate. The overlay keeps every mark — that is the storage model the
  // reader asked for — so the panel's list does not shrink; only what can be
  // drawn here changes.
  routeA.remove()
  const routeB = document.createElement('div')
  routeB.className = 'route-b'
  const onlyB = document.createElement('button')
  onlyB.className = 'only-b'
  onlyB.textContent = 'on route B'
  routeB.appendChild(onlyB)
  document.body.appendChild(routeB)
  boxes['button.only-b'] = { x: 40, y: 300, width: 120, height: 30 }

  window.location.hash = '#/b'
  await new Promise((r) => setTimeout(r, 60))

  await markAndSave(onlyB)

  // The number the panel gives each entry, computed the way the panel does it:
  // grouped by page, numbered within the group. Read from the last `changed` post
  // — the same list the host receives.
  const listed = posted.filter((m) => m.type === 'changed').pop().annotations
  const seen = new Map()
  const rowOf = new Map()
  for (const entry of inReadingOrder(listed)) {
    const n = (seen.get(entry.page) || 0) + 1
    seen.set(entry.page, n)
    rowOf.set(entry.selector, n)
  }

  const drawn = [...document.querySelectorAll('.dsa-pin')]
  assert.equal(drawn.length, 1, 'only the mark belonging to this route is drawn', `${drawn.length}`)
  const shown = Number(drawn[0].textContent)
  const selector = drawn[0].__annotation.selector
  assert.equal(
    shown,
    rowOf.get(selector),
    `the pin for ${selector} wears its own page's row number`,
  )
  // Both routes hold one mark each, so each legitimately reads 1 — the number is
  // local to the page, and the panel's group for that page says the same. This is
  // the case that used to be the reported bug, now the intended behaviour.
  assert.equal(shown, 1, 'and a page with one mark numbers it 1, as its group in the panel does')
  console.log(`  route A then route B -> pin ${shown} = its page's row in the panel for ${selector}`)

  // Returning must show the first mark under the SAME number it had. This is the
  // half the reader actually sees: navigate away and back while editing.
  routeB.remove()
  const back = document.createElement('div')
  back.className = 'route-a-again'
  const againA = document.createElement('button')
  againA.className = 'only-a'
  againA.textContent = 'on route A'
  back.appendChild(againA)
  document.body.appendChild(back)
  boxes['button.only-a'] = { x: 40, y: 300, width: 120, height: 30 }

  window.location.hash = '#/a'
  await new Promise((r) => setTimeout(r, 60))

  const returned = [...document.querySelectorAll('.dsa-pin')]
  const firstPin = returned.find((p) => p.__annotation.selector.includes('only-a'))
  assert.ok(firstPin, 'the first mark is drawn again on return')
  assert.equal(
    Number(firstPin.textContent),
    rowOf.get(firstPin.__annotation.selector),
    'and it still wears its page\'s row number, not a renumbered one',
  )
  console.log(`  returned to route A -> pin ${firstPin.textContent} for ${firstPin.__annotation.selector}`)
}

// --- scrolling must not raise the "cannot locate" warning ---------------------
// The reader's report: mark something on a page, scroll down, and the panel says
// "1 项标注无法定位到页面元素". Scroll back and it disappears.
//
// Both are the ordinary consequence of scrolling. `pinAnchor` returned one bare
// `null` for both "the selector no longer resolves" and "the element is scrolled
// out of view", so the warning fired on anything that left the viewport — telling
// the reader their page had changed under them when nothing had. A warning that
// fires on scrolling is worse than none: it teaches the reader to ignore the one
// that does mean their page changed.
console.log('\n--- scrolling does not raise the "cannot locate" warning ---')
{
  const unplacedPosts = () => posted.filter((m) => m.type === 'unplaced')
  // `renderPins` posts only when the SET of unplaceable marks changes, so a report
  // can legitimately still name the previous section's casualty. What matters here
  // is whether THIS element ever shows up in one, not how many posts there are.
  // Matched on the class, not on a full selector string: the overlay records what
  // `selectorOf` produced, which prefers the bare class (`.low-target`) over the
  // tag-qualified form. Comparing against `div.low-target` matched nothing, so the
  // "no false alarm" assertion below passed without ever looking at this element.
  const namesLow = (m) => Array.isArray(m.items) && m.items.some((one) => String(one.selector).includes('low-target'))

  // A mark on an element that is VISIBLE when the reader makes it — which is the
  // only way a mark is ever made, since the click goes through the page. It is
  // parked just above the fold so the scroll below can take it out of view.
  const low = document.createElement('div')
  low.className = 'low-target'
  low.textContent = 'low'
  document.body.appendChild(low)
  boxes['div.low-target'] = { x: 40, y: 500, width: 120, height: 30 }

  await markAndSave(low)
  const afterMark = unplacedPosts()
  assert.ok(!afterMark.some(namesLow),
    'marking a visible element does not report it as unlocatable',
    JSON.stringify(afterMark.filter(namesLow).map((m) => m.items)))

  // Scroll it out: the element stays connected and keeps a real box; only where it
  // sits relative to the viewport changes, which is precisely what a scroll does.
  boxes['div.low-target'] = { x: 40, y: -4000, width: 120, height: 30 }
  window.dispatchEvent(new window.Event('resize'))
  await new Promise((r) => setTimeout(r, 80))

  const alarms = unplacedPosts().filter(namesLow)
  assert.equal(alarms.length, 0,
    'scrolling an element out of view raises no warning about it',
    JSON.stringify(alarms.map((m) => m.items)))

  // The honest case must survive, or the fix would have silenced the warning
  // outright rather than narrowed it.
  low.remove()
  window.dispatchEvent(new window.Event('resize'))
  await new Promise((r) => setTimeout(r, 80))
  const realLoss = unplacedPosts().filter(namesLow).pop()
  assert.ok(realLoss,
    'a selector that no longer resolves IS still reported',
    JSON.stringify(unplacedPosts().pop() || null))
  console.log('  off-screen: no warning | genuinely gone: reported as unlocatable')
}

// --- empty space must not read as "the whole page is selected" ----------------
// The reader's report: while in 选取 mode, moving the pointer off the sidebar —
// reaching for the composer to type — made the entire page look selected. Nothing
// was selected. `elementFromPoint` answers with the nearest element under the
// cursor, and where the page has no content at that point the nearest element IS
// the document, so the frame was outlining `<html>` and the readout was naming it.
//
// On a page that fills the viewport, "the frame is around everything" and
// "everything is selected" look identical, and the second reading is never
// useful: nobody annotates the document element. The two cases below are the
// whole rule — the page itself is empty space, and so is anywhere the pointer has
// left the preview.
console.log('\n--- empty space is not a selection ---')
{
  const frame = document.querySelector('.dsa-frame')
  const readout = document.querySelector('.dsa-readout')
  const surface = document.querySelector('.dsa-capture')
  assert.ok(surface, 'the capture surface is up while marking')

  // Reaching for the composer: the pointer leaves the preview entirely. No
  // `mousemove` follows it out, so only an explicit `mouseleave` can clear the
  // highlight the pointer left behind.
  hitTestTarget = document.querySelector('div.pricing-card')
  surface.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 330, clientY: 190 }))
  assert.equal(frame.style.display, 'block', 'hovering a real element frames it')
  surface.dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: false }))
  assert.equal(frame.style.display, 'none',
    'leaving the preview drops the highlight instead of leaving it behind',
    `frame display: ${frame.style.display}`)
  assert.equal(readout.style.display, 'none', 'and the readout goes with it')

  // A point over the page's own background: `elementFromPoint` hands back
  // `<html>`. That is empty space, not a selection.
  hitTestTarget = document.documentElement
  surface.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 900, clientY: 700 }))
  assert.equal(frame.style.display, 'none',
    'hovering the document element frames nothing',
    `frame display: ${frame.style.display}`)
  assert.equal(readout.style.display, 'none', 'and names nothing')

  hitTestTarget = document.body
  surface.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 900, clientY: 700 }))
  assert.equal(frame.style.display, 'none', 'the body counts as empty space too')

  // The honest case has to survive, or the fix would have disabled hovering
  // rather than narrowed it: a real element still frames.
  hitTestTarget = document.querySelector('button.primary')
  surface.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 645, clientY: 525 }))
  assert.equal(frame.style.display, 'block',
    'a real element under the cursor is still framed',
    `frame display: ${frame.style.display}`)
  assert.ok(readout.textContent.includes('primary'),
    'and still named', JSON.stringify(readout.textContent))

  // A click on empty space must not open a card for the document either — the
  // same hit test answers both, so a pick there would mark the whole page.
  const cardsBefore = document.querySelectorAll('.dsa-card').length
  hitTestTarget = document.documentElement
  surface.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 900, clientY: 700 }))
  assert.equal(document.querySelectorAll('.dsa-card').length, cardsBefore,
    'clicking empty space opens no card')
  console.log('  document element and pointer-out both read as nothing; real elements still frame')
}

// --- persistence across a reload ---------------------------------------------
// Keyed by the session alone. The route is recorded on each entry instead, so
// that navigating between views of one app keeps the attached list but draws a
// pin only where the mark was made.
assert.ok(window.localStorage.getItem('dsh-annotate:v1:test'), 'entries persisted to session storage')
const persisted = JSON.parse(window.localStorage.getItem('dsh-annotate:v1:test'))
assert.ok(
  persisted.every((entry) => typeof entry.page === 'string' && entry.page),
  'every persisted entry records the route it was made on',
)
console.log('persisted to localStorage under the session key, with a route on each entry')

console.log('\nALL OVERLAY CHECKS PASSED')
process.exit(0)
