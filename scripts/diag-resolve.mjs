/**
 * Do the reported selectors actually locate the annotated element?
 *
 * The user asked whether the annotations can point at the right DOM node. This
 * loads the real page said to be annotated and resolves each selector, so the
 * answer is measured rather than assumed. It also reports what else shares the
 * selector, since a class that matches several rows is ambiguous.
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/a3025/.dsh/profiles/web/package.json')
const jsdomDir = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/jsdom@29.1.1_@noble+hashes@2.3.0/node_modules'
const { JSDOM } = require(`${jsdomDir}/jsdom`)

const CANDIDATES = [
  'E:/StudyFile/Notes/API_Zhongzhuan/临时原型/console/wallet-v3.html',
  'E:/StudyFile/AI-Workspace/dsh_workspace/docs/wallet-v3.html',
]
const source = CANDIDATES.find((one) => existsSync(one))
if (!source) {
  console.log('no copy of the page found; skipping')
  process.exit(0)
}
console.log('page:', source)

const dom = new JSDOM(readFileSync(source, 'utf8'))
const { document } = dom.window

// The two entries from the report, with the text that was captured for each.
const ENTRIES = [
  { selector: '.g-recharge', text: 'Recharge', at: [679, 276, 50, 16] },
  { selector: '.code-row', text: '复制邀请码', at: [612, 1005, 118, 33] },
]

let problems = 0
for (const entry of ENTRIES) {
  console.log(`\n${entry.selector}   (captured text: ${JSON.stringify(entry.text)})`)
  let nodes
  try {
    nodes = [...document.querySelectorAll(entry.selector)]
  } catch (error) {
    console.log('  the selector does not parse:', error.message)
    problems += 1
    continue
  }
  console.log(`  matches: ${nodes.length}`)
  if (nodes.length === 0) {
    console.log('  FAIL: resolves to nothing')
    problems += 1
    continue
  }
  for (const node of nodes.slice(0, 4)) {
    const text = (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)
    const rect = node.getBoundingClientRect()
    console.log(`    <${node.tagName.toLowerCase()}> class="${node.getAttribute('class') || ''}" text="${text}"`)
    console.log(`       rect: ${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}×${Math.round(rect.height)}`)
  }

  // The captured text should be inside the resolved node, and vice versa.
  const target = [...entry.text]
  const contains = nodes.some((node) => (node.textContent || '').includes(entry.text))
  const containsPart = nodes.some((node) => entry.text.includes((node.textContent || '').trim()))
  console.log(`  captured text is inside the node : ${contains}`)
  console.log(`  node text is inside captured text: ${containsPart}`)
  if (!contains && !containsPart) {
    console.log('  NOTE: the captured text does not correspond to any node this selector finds')
    problems += 1
  }
  if (nodes.length > 1) {
    console.log('  NOTE: the selector is ambiguous — several nodes share it')
  }
  void target
}

console.log('')
if (problems) {
  console.log(`SELECTOR RESOLUTION: ${problems} problem(s) found`)
  process.exit(1)
}
console.log('SELECTOR RESOLUTION PASSED — every reported selector finds its element')
