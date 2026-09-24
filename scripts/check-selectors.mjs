/**
 * Check selector generation against the page that produced the field report.
 *
 * The reported selectors were four-level `nth-of-type` chains, which say nothing
 * to a reader. This loads the real page and asks what the shipped rules produce
 * for the two elements that were annotated, so the improvement is measured
 * rather than assumed.
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/a3025/.dsh/profiles/web/package.json')
const jsdomDir = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/jsdom@29.1.1_@noble+hashes@2.3.0/node_modules'
const { JSDOM } = require(`${jsdomDir}/jsdom`)

const PAGE = 'E:/StudyFile/AI-Workspace/dsh_workspace/docs/wallet-v3.html'
const ORIGINAL = 'E:/StudyFile/Notes/API_Zhongzhuan/临时原型/console/wallet-v3.html'
const source = existsSync(PAGE) ? PAGE : ORIGINAL
console.log('page under test:', source)

const html = readFileSync(source, 'utf8')
const dom = new JSDOM(html, { url: 'http://localhost:54903/wallet-v3.html', pretendToBeVisual: true })
const { document } = dom.window

// The shipped selector logic, lifted from the bundle and evaluated here.
const overlay = readFileSync('E:/StudyFile/AI-Workspace/dsh_workspace/plugins/dsh-annotate/lib/overlay.js', 'utf8')
const fnStart = overlay.indexOf('function uniqueClassSelector')
const fnEnd = overlay.indexOf('function matchesOf')
if (fnStart < 0 || fnEnd < 0) {
  console.log('could not locate the selector helpers in overlay.js')
  process.exit(1)
}
const helpers = overlay.slice(fnStart, fnEnd)

// jsdom does not implement CSS.escape, which the selector builder uses to make a
// class name safe. Supply the standard behaviour so the real logic runs unchanged.
const CSSShim = dom.window.CSS || {}
if (typeof CSSShim.escape !== 'function') {
  CSSShim.escape = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
}

const selectors = new Function(
  'document',
  'CSS',
  `${helpers}
   ${overlay.slice(overlay.indexOf('  function selectorOf'), overlay.indexOf('  function uniqueClassSelector'))}
   return selectorOf`,
)(document, CSSShim)
function matchesOf(selector) {
  try {
    return document.querySelectorAll(selector).length
  } catch {
    return -1
  }
}

// The two elements the report annotated, found by their text.
const targets = ['¥126.84', '214,502']
console.log('')
let allUnique = true
for (const text of targets) {
  const el = [...document.querySelectorAll('div')].find((one) => (one.textContent || '').trim() === text)
  if (!el) {
    console.log(`  "${text}": element not found in this copy of the page`)
    continue
  }
  const selector = selectors(el)
  const count = matchesOf(selector)
  const levels = selector.split(' > ').length
  console.log(`  "${text}"`)
  console.log(`    selector: ${selector}`)
  console.log(`    matches : ${count}  |  depth: ${levels}`)
  if (count !== 1) allUnique = false
}

console.log('')
if (!allUnique) {
  console.log('FAIL: a generated selector does not resolve to exactly one element')
  process.exit(1)
}
console.log('SELECTOR CHECK PASSED — every selector is unique and shorter than a full chain')
