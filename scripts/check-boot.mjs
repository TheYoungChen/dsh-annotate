/**
 * Verify the overlay mounts correctly when injected into <head>.
 *
 * The overlay ships inside <head>, so at parse time <body> does not exist. It
 * used to attach to <html>, which put the fixed layer inside a containing block
 * the page can transform — the reported "box that drifts and changes size while
 * scrolling". It must land in <body> once one exists, and it must block clicks
 * so mark mode picks elements instead of pressing page controls.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/a3025/.dsh/profiles/web/package.json')
const jsdomDir = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/jsdom@29.1.1_@noble+hashes@2.3.0/node_modules'
const { JSDOM } = require(`${jsdomDir}/jsdom`)

const overlaySrc = readFileSync('E:/StudyFile/AI-Workspace/dsh_workspace/plugins/dsh-annotate/lib/overlay.js', 'utf8')

const failures = []
const ok = (condition, label, detail) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

const HTML = `<!doctype html><html><head>
  <script>${overlaySrc}</script>
  </head><body>
    <button id="pay" style="width:120px;height:40px">立即兑换</button>
    <div id="box" style="width:200px;height:60px">hello</div>
  </body></html>`

// Run the same script once from <head> (as shipped) and once from <body>, since
// both placements must work.
async function load(placement) {
  const html =
    placement === 'head'
      ? HTML
      : `<!doctype html><html><head></head><body>
           <button id="pay" style="width:120px;height:40px">立即兑换</button>
           <div id="box" style="width:200px;height:60px">hello</div>
           <script>${overlaySrc}</script>
         </body></html>`
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost:9/' })
  await new Promise((r) => dom.window.addEventListener('load', r, { once: true }))
  await new Promise((r) => setTimeout(r, 80))
  return dom
}

for (const placement of ['head', 'body']) {
  console.log(`\n=== script placed in <${placement}> ===`)
  const dom = await load(placement)
  const { window } = dom
  const { document } = window

  const layer = document.querySelector('.dsa-layer')
  ok(Boolean(layer), 'the layer exists')
  if (!layer) continue
  ok(layer.parentNode === document.body, 'the layer is attached to <body>', `<${layer.parentNode.tagName.toLowerCase()}>`)
  ok(!/\bpopover\b/.test(layer.outerHTML.slice(0, 200)), 'no popover promotion is used')

  // Hit-testing must reach page elements while the capture surface is up.
  const box = document.getElementById('box')
  box.getBoundingClientRect = () => ({ left: 10, top: 10, width: 200, height: 60, right: 210, bottom: 70, x: 10, y: 10, toJSON() {} })
  document.elementFromPoint = () => box

  window.postMessage({ source: 'dsh-annotate-panel', type: 'mode', mode: 'marking' }, '*')
  await new Promise((r) => setTimeout(r, 60))

  const capture = document.querySelector('.dsa-capture')
  ok(Boolean(capture), 'the capture surface mounts in mark mode')

  if (capture) {
    capture.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 20, clientY: 20, bubbles: true }))
    await new Promise((r) => setTimeout(r, 40))
    const frame = document.querySelector('.dsa-frame')
    ok(frame && frame.style.display === 'block', 'hover shows the highlight', frame && frame.style.display)
    ok(frame && frame.style.width === '200px', 'the highlight matches the element box', frame && frame.style.width)
  }

  // A click must not reach a control underneath.
  let pressed = 0
  const pay = document.getElementById('pay')
  pay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 120, height: 40, right: 120, bottom: 40, x: 0, y: 0, toJSON() {} })
  pay.addEventListener('click', () => (pressed += 1))
  document.elementFromPoint = () => pay
  if (capture) {
    capture.dispatchEvent(new window.MouseEvent('click', { clientX: 10, clientY: 10, bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 40))
  }
  ok(pressed === 0, 'a click in mark mode does not press the page control', `pressed ${pressed} time(s)`)

  window.close()
}

console.log('')
if (failures.length) {
  console.log(`BOOT CHECKS FAILED — ${failures.length} problem(s)`)
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
console.log('BOOT CHECKS PASSED')
