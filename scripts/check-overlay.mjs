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

// --- persistence across a reload ---------------------------------------------
assert.ok(window.localStorage.getItem('dsh-annotate:v1:test:/pricing'), 'entries persisted to page storage')
console.log('persisted to localStorage under session+path key')

console.log('\nALL OVERLAY CHECKS PASSED')
process.exit(0)
