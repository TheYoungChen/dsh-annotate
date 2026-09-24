/**
 * Find out why hovering in mark mode does not show the highlight.
 *
 * The overlay is loaded into a real DOM with a page underneath, mark mode is
 * switched on, a mousemove is dispatched at a known element, and the resulting
 * frame state is inspected. This distinguishes "the handler never ran" from
 * "the frame is positioned but invisible".
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// jsdom and the React pair live in the harness store, not beside this plugin.
const require = createRequire('C:/Users/a3025/.dsh/profiles/web/package.json')
const jsdomDir = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/jsdom@29.1.1_@noble+hashes@2.3.0/node_modules'
const { JSDOM } = require(`${jsdomDir}/jsdom`)
const pluginDir = 'E:/StudyFile/AI-Workspace/dsh_workspace/plugins/dsh-annotate'
const overlaySrc = readFileSync(`${pluginDir}/lib/overlay.js`, 'utf8')

const dom = new JSDOM(
  `<!doctype html><html><body>
     <div id="box" style="position:absolute;left:100px;top:80px;width:200px;height:60px">hello</div>
     <p id="para" style="position:absolute;left:50px;top:300px">text</p>
   </body></html>`,
  { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost:9/' },
)
const { window } = dom
const { document } = window

// jsdom has no layout: give every element a rect derived from its inline style so
// hit-testing and positioning have something real to work with.
const rects = new Map()
for (const el of document.querySelectorAll('div,p')) {
  const left = parseFloat(el.style.left) || 0
  const top = parseFloat(el.style.top) || 0
  const width = parseFloat(el.style.width) || 100
  const height = parseFloat(el.style.height) || 20
  rects.set(el, { left, top, width, height, right: left + width, bottom: top + height })
  el.getBoundingClientRect = () => ({ ...rects.get(el), x: left, y: top, toJSON() {} })
}
document.documentElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800, x: 0, y: 0, toJSON() {} })
document.body.getBoundingClientRect = document.documentElement.getBoundingClientRect

// Hit-testing stand-in: return the element whose rect contains the point.
document.elementFromPoint = (x, y) => {
  let best = null
  for (const [el, r] of rects) {
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) best = el
  }
  return best || document.body
}

// Run the overlay the way the shim does: it self-mounts and listens for messages.
const script = document.createElement('script')
script.textContent = overlaySrc
document.documentElement.appendChild(script)

await new Promise((r) => setTimeout(r, 60))

const layer = document.querySelector('.dsa-layer')
console.log('overlay mounted     :', Boolean(layer))
const frame = document.querySelector('.dsa-frame')
const readout = document.querySelector('.dsa-readout')
const capture = document.querySelector('.dsa-capture')
console.log('frame exists        :', Boolean(frame))
console.log('capture mounted     :', capture ? capture.parentNode !== null : false, '(false until mark mode)')

// --- switch to mark mode via the panel message the client sends ---------------
// The wire format keys on `source`; the panel is 'dsh-annotate-panel'.
window.postMessage({ source: 'dsh-annotate-panel', type: 'mode', mode: 'marking' }, '*')
await new Promise((r) => setTimeout(r, 60))

console.log('\nafter entering mark mode')
console.log('  capture mounted   :', Boolean(document.querySelector('.dsa-capture')))

// --- hover over the box -------------------------------------------------------
const box = document.getElementById('box')
const r = rects.get(box)
const at = { clientX: r.left + 10, clientY: r.top + 10, bubbles: true }
const captureNow = document.querySelector('.dsa-capture')
console.log('  capture present   :', Boolean(captureNow))
captureNow.dispatchEvent(new window.MouseEvent('mousemove', at))
await new Promise((res) => setTimeout(res, 40))

const f = document.querySelector('.dsa-frame')
console.log('\nframe after hover')
console.log('  display           :', JSON.stringify(f.style.display))
console.log('  left/top          :', f.style.left, f.style.top)
console.log('  width/height      :', f.style.width, f.style.height)
const ro = document.querySelector('.dsa-readout')
console.log('  readout display   :', JSON.stringify(ro.style.display))
console.log('  readout text      :', JSON.stringify(ro.textContent))

const visible = f.style.display === 'block'
console.log('\nVERDICT:', visible ? 'the highlight IS applied on hover' : 'the highlight is NOT applied — handler or gating is broken')

// Clean up the timers the overlay started so the process can exit.
window.close()
