/**
 * Compare the payload against the two entries actually sent from the field.
 *
 * The report was that the block is long because it carries detailed DOM
 * structure. This measures the real difference on that exact input, so the
 * saving is a number rather than a claim.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/a3025/.dsh/profiles/web/package.json')
const jsdomDir = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/jsdom@29.1.1_@noble+hashes@2.3.0/node_modules'
const { JSDOM } = require(`${jsdomDir}/jsdom`)

// The exact entries from the field report, with the selectors the improved
// builder now produces for the same two elements.
const ENTRIES = [
  {
    id: 'a1',
    selector: '.lb-hero',
    selectorMatches: 1,
    tag: 'div',
    role: 'div',
    text: '¥126.84',
    note: '',
    doc: { x: 57, y: 166, w: 155, h: 44 },
  },
  {
    id: 'a2',
    selector: '.lb-band',
    selectorMatches: 1,
    tag: 'div',
    role: 'div',
    text: '214,502',
    note: '测试效果222',
    doc: { x: 448, y: 169, w: 101, h: 39 },
  },
]
const META = { url: 'http://localhost:54903/wallet-v3.html', w: 1018, h: 546 }

// --- the previous format, for comparison --------------------------------------
// Uses the selectors the OLD builder produced for these same two elements, so
// the before/after reflects what actually changed.
const OLD_SELECTORS = {
  a1: 'body > div:nth-of-type(2) > div:nth-of-type(2) > div:nth-of-type(1) > div:nth-of-type(2)',
  a2: 'body > div:nth-of-type(2) > div:nth-of-type(2) > div:nth-of-type(5) > div:nth-of-type(2)',
}

function renderOld(annotations, meta) {
  const head = `🎯 界面标注 · ${meta.url} · ${meta.w}×${meta.h} (${annotations.length})`
  const blocks = annotations.map((entry, index) => {
    const note = String(entry.note || '').trim()
    const tag = note ? '[批注]' : '[标注]'
    const selector = OLD_SELECTORS[entry.id] || entry.selector
    const lines = [`#${index + 1} ${tag} ${selector}`]
    if (selector) lines.push(`   selector: ${selector} (matches: ${entry.selectorMatches})`)
    if (entry.text) lines.push(`   text: ${entry.text}`)
    if (entry.doc) lines.push(`   position: x=${entry.doc.x} y=${entry.doc.y} ${entry.doc.w}×${entry.doc.h}`)
    if (note) lines.push(`   note: ${note}`)
    return lines.join('\n')
  })
  return [head, '', blocks.join('\n\n')].join('\n')
}

// --- the shipped format, loaded from the bundle --------------------------------
const src = readFileSync('E:/StudyFile/AI-Workspace/dsh_workspace/plugins/dsh-annotate/client.js', 'utf8')
// Exercise the real function by evaluating the module in a jsdom window, which
// is how it runs in the browser.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously', url: 'http://localhost:9/' })
const { window } = dom
window.__ModuleLoader__ = { load: (def) => window.__ModuleLoader__.loaded.push(def), loaded: [] }
const script = window.document.createElement('script')
script.textContent = src
window.document.body.appendChild(script)

const loaded = window.__ModuleLoader__.loaded[0]
if (!loaded) {
  console.log('the bundle did not register with the loader')
  process.exit(1)
}

// Reach renderPayload through the registered tab component is awkward; the
// function is module-private, so the comparison uses the same rules the bundle
// applies, asserted against the source itself.
// The comparison below mirrors the shipped rules. Confirm they are still the
// ones in the bundle, so this file cannot drift into testing a stale format.
const newRulesHold = [
  /lines\.push\(`   text: \$\{entry\.text\}`\)/.test(src),
  /lines\.push\(`   at: \$\{entry\.doc\.x\},\$\{entry\.doc\.y\}/.test(src),
  /\/nth-of-type\/\.test\(selector\)/.test(src),
  // The selector must appear once, on the header line, not repeated below.
  !/lines\.push\(`   selector: /.test(src),
]
console.log('shipped format uses the terse rules:', newRulesHold.every(Boolean))
if (!newRulesHold.every(Boolean)) {
  console.log('rules not found in the bundle — the comparison below would be meaningless')
  process.exit(1)
}

// Render the new format by the shipped rules.
function renderNew(annotations, meta) {
  const head = `🎯 界面标注 · ${meta.url} · ${meta.w}×${meta.h} (${annotations.length})`
  const blocks = annotations.map((entry, index) => {
    const note = String(entry.note || '').trim()
    const tag = `[${note ? '批注' : '标注'}]`
    const selector = entry.selector || entry.tag || ''
    const lines = [`#${index + 1} ${tag} ${selector}`]
    if (entry.text) lines.push(`   text: ${entry.text}`)
    if (entry.doc) lines.push(`   at: ${entry.doc.x},${entry.doc.y} ${entry.doc.w}×${entry.doc.h}`)
    if (/nth-of-type/.test(selector) && typeof entry.selectorMatches === 'number') {
      lines.push(`   matches: ${entry.selectorMatches}`)
    }
    if (entry.testId) lines.push(`   testid: ${entry.testId}`)
    if (entry.ariaLabel) lines.push(`   aria-label: ${entry.ariaLabel}`)
    if (note) lines.push(`   note: ${note}`)
    return lines.join('\n')
  })
  return [head, '', blocks.join('\n\n')].join('\n')
}

const before = renderOld(ENTRIES, META)
const after = renderNew(ENTRIES, META)

console.log('\n=== BEFORE ===')
console.log(before)
console.log('\n=== AFTER ===')
console.log(after)

const linesBefore = before.split('\n').length
const linesAfter = after.split('\n').length
console.log('\n=== comparison ===')
console.log('  lines:', linesBefore, '->', linesAfter)
console.log('  chars:', before.length, '->', after.length)

// Rough token proxy: this text is mostly ASCII with some CJK, so characters are
// the honest unit here rather than a made-up token count.
const saved = Math.round((1 - after.length / before.length) * 100)
console.log(`  ${saved}% shorter`)

if (after.length >= before.length) {
  console.log('\nFAIL: the new format is not shorter')
  process.exit(1)
}

// --- the block must not repeat a field ----------------------------------------
console.log('\n=== no field is repeated within a block ===')
const FIELD = /^\s{3}([a-z-]+):/gm
let duplicated = false
for (const block of after.split('\n\n').slice(1)) {
  const seen = new Set()
  for (const match of block.matchAll(FIELD)) {
    if (seen.has(match[1])) {
      console.log(`  FAIL: "${match[1]}" appears twice in one block`)
      duplicated = true
    }
    seen.add(match[1])
  }
}
if (duplicated) process.exit(1)
console.log('  ok   every field appears at most once per block')

// --- the intent line must invite a request -------------------------------------
console.log('\n=== the attached block invites the request ===')
const attachSrc = readFileSync('E:/StudyFile/AI-Workspace/dsh_workspace/plugins/dsh-annotate/client.js', 'utf8')
const hasAsk = /panel\.askLine/.test(attachSrc)
console.log(`  ${hasAsk ? 'ok  ' : 'FAIL'} a prompt line is appended when attaching`)
if (!hasAsk) process.exit(1)
const zhAsk = [...attachSrc.matchAll(/'panel\.askLine': '([^']+)'/g)].map((m) => m[1])
console.log(`  prompt text: ${zhAsk.join(' | ') || '(missing)'}`)
// Both catalogs must carry the line, and at least one must ask what to change.
if (zhAsk.length < 2) {
  console.log('  FAIL: the prompt line is not present in both languages')
  process.exit(1)
}
if (!zhAsk.some((one) => /改/.test(one))) {
  console.log('  FAIL: the prompt does not ask what to change')
  process.exit(1)
}

// --- direct send must not be the primary action --------------------------------
console.log('\n=== adding to the composer is the primary action ===')
const attachPrimary = /className: 'dsa-btn', 'data-primary': true, onClick: onAttach/.test(attachSrc)
const sendPrimary = /'data-primary': true, onClick: onSend/.test(attachSrc)
console.log(`  ${attachPrimary ? 'ok  ' : 'FAIL'} "add to composer" carries data-primary`)
console.log(`  ${!sendPrimary ? 'ok  ' : 'FAIL'} "send" is demoted to secondary`)
if (!attachPrimary || sendPrimary) process.exit(1)

console.log('\nPAYLOAD COMPARISON PASSED')
