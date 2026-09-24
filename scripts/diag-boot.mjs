/**
 * Reproduce the field symptom: the overlay is injected into <head>, so its
 * script runs before <body> exists.
 *
 * The report was "hovering does nothing, and a box floats in the middle that
 * changes size as the page scrolls". Both follow from mounting a fixed-position
 * layer against a document whose body has not been parsed yet.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/a3025/.dsh/profiles/web/package.json')
const jsdomDir = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/jsdom@29.1.1_@noble+hashes@2.3.0/node_modules'
const { JSDOM } = require(`${jsdomDir}/jsdom`)

const overlaySrc = readFileSync('E:/StudyFile/AI-Workspace/dsh_workspace/plugins/dsh-annotate/lib/overlay.js', 'utf8')

// A page whose head carries the overlay, exactly as injectIntoHtml places it.
const HTML = `<!doctype html><html><head>
  <script>${overlaySrc}</script>
  </head><body><div id="box" style="width:200px;height:60px">hello</div></body></html>`

const dom = new JSDOM(HTML, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost:9/' })
const { window } = dom
await new Promise((r) => window.addEventListener('load', r, { once: true }))
await new Promise((r) => setTimeout(r, 80))

const { document } = window
const layer = document.querySelector('.dsa-layer')
console.log('=== where did the layer land? ===')
console.log('  layer exists          :', Boolean(layer))
if (layer) {
  console.log('  parent tagName        :', layer.parentNode && layer.parentNode.tagName)
  console.log('  is child of body      :', Boolean(document.body && document.body.contains(layer)))
  console.log('  body exists           :', Boolean(document.body))
}

// The boot order problem: if the script ran before body was parsed, anything
// that reads document.body at mount time saw null or a stub.
const problems = []
if (layer && layer.parentNode && layer.parentNode.tagName !== 'BODY') {
  problems.push(`the layer is attached to <${layer.parentNode.tagName.toLowerCase()}>, not <body>`)
}
if (!document.body || !document.body.contains(layer)) {
  problems.push('the layer is outside <body>, so it is not part of the page flow')
}

console.log('\n=== does hover hit-test reach page elements? ===')
const box = document.getElementById('box')
if (box) box.getBoundingClientRect = () => ({ left: 10, top: 10, width: 200, height: 60, right: 210, bottom: 70, x: 10, y: 10, toJSON() {} })
document.elementFromPoint = () => box

window.postMessage({ source: 'dsh-annotate-panel', type: 'mode', mode: 'marking' }, '*')
await new Promise((r) => setTimeout(r, 60))
const capture = document.querySelector('.dsa-capture')
console.log('  capture mounted       :', Boolean(capture))
if (capture) {
  capture.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 20, clientY: 20, bubbles: true }))
  await new Promise((r) => setTimeout(r, 40))
}
const frame = document.querySelector('.dsa-frame')
console.log('  frame display         :', frame && JSON.stringify(frame.style.display))
console.log('  frame size            :', frame && `${frame.style.width} x ${frame.style.height}`)
if (frame && frame.style.display !== 'block') {
  problems.push('hover produced no highlight frame')
}

console.log('\n=== verdict ===')
if (problems.length) {
  for (const p of problems) console.log('  PROBLEM:', p)
} else {
  console.log('  no problem reproduced in this environment')
}
window.close()
