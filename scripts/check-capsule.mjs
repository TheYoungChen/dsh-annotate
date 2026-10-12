/**
 * Verify the capsule appears, sits in the dock above the composer, and reflects
 * the host rather than a number the sidebar pushed over.
 *
 * Two user-visible faults are guarded here. First, the capsule used to appear
 * only after pressing a button in the sidebar; it must now appear as soon as
 * anything is marked, because the sidebar writes marks to the host as they are
 * made. Second, it used to be registered on `conversation.composer.dock`, which
 * renders BELOW the input card, so it appeared under the box instead of above
 * it — `conversation.input.dock` is the slot the shell documents as "full-width
 * entries above the composer card".
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
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) {
    failures += 1
    if (detail !== undefined) console.log(`       ${detail}`)
  }
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

/** What the host claims to hold, so the capsule can be compared against it. */
let hostCount = 0
/**
 * The entries the host hands back alongside the count.
 *
 * It always answered with these — the capsule was simply keeping the count and
 * dropping the rest — so the expandable detail costs no extra request. Modelled here
 * because a fake that returned a count and no entries would let a broken panel pass:
 * the panel would show its "nothing to show" note and look deliberate.
 */
let hostEntries = []
const requests = []
global.fetch = async (url, options) => {
  const u = String(url)
  requests.push({ url: u, body: options && options.body ? JSON.parse(options.body) : null })
  if (u.endsWith('/pending')) {
    return { json: async () => ({ ok: true, count: hostCount, annotations: hostEntries, block: '' }) }
  }
  if (u.endsWith('/context')) return { json: async () => ({ ok: true, count: hostCount }) }
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

// Capture every registration so the slot choice can be asserted directly.
const registered = new Map()
const ctx = {
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  interval: () => () => {},
  get: (name) => {
    if (name === 'slots') {
      return {
        inject: (key, fn) => { fn() },
        register: (def, component) => {
          registered.set(def.id, { def, component })
          return () => {}
        },
      }
    }
    if (name === 'sidebarRightTabs') return { register: () => () => {} }
    if (name === 'sidebarRight') return { openTab: () => {} }
    return undefined
  },
}
mod.apply(ctx)

const capsuleEntry = [...registered.values()].find((r) => r.def.id === 'annotate-capsule')

console.log('=== the capsule is registered on the dock above the composer ===')
check(capsuleEntry !== undefined, 'a capsule component is registered',
  [...registered.keys()].join(', ') || '(none)')
const slotName = capsuleEntry ? capsuleEntry.def.name : null
console.log(`  registered slot: ${slotName}`)
check(slotName === 'conversation.input.dock',
  'it rides conversation.input.dock, which renders ABOVE the input card',
  slotName)
check(slotName !== 'conversation.composer.dock',
  'it is no longer on conversation.composer.dock, which renders BELOW the card')

console.log('')
console.log('=== nothing is shown while the host holds nothing ===')
const Dock = capsuleEntry ? capsuleEntry.component : null
const host = document.createElement('div')
document.body.appendChild(host)
const root = createRoot(host)
// The real dock receives `zone`, not a bare sessionId — exercising that shape is
// the point, since reading only `props.sessionId` is what broke it before.
const zone = { session: { id: 'sess-1' }, input: {} }
await act(async () => {
  root.render(React.createElement(Dock, { zone }))
})
check(!host.querySelector('.dsa-capsule'), 'no capsule with nothing held', host.textContent)

console.log('')
console.log('=== marking something makes it appear, with no button pressed ===')
// This is the behaviour the user asked for: the count comes from the host, so a
// mark made in the sidebar shows up here without any hand-over step. The state
// is set before rendering, because the component reads once on mount.
hostCount = 3
hostEntries = [
  { selector: '.l2 > span:nth-of-type(3) > b', text: '默认 · vip', note: '再次测试批注', page: '' },
  { selector: '.pa-grid > div:nth-of-type(1) span:nth-of-type(2)', text: 'Bindings', note: '', page: '' },
  { selector: '.l1 > button', text: '编辑', note: '', page: '' },
]
const host2 = document.createElement('div')
document.body.appendChild(host2)
const root2 = createRoot(host2)
await act(async () => {
  root2.render(React.createElement(Dock, { zone }))
})
await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
const capsule = host2.querySelector('.dsa-capsule')
check(capsule !== null, 'the capsule appears on its own', host2.innerHTML.slice(0, 160))
if (capsule) {
  const text = capsule.textContent
  console.log(`  capsule text: ${JSON.stringify(text)}`)
  check(/3/.test(text), 'it names the count', text)
  check(/标注/.test(text), 'it says what the count refers to', text)
  check(capsule.getAttribute('title') && capsule.getAttribute('title').length > 0,
    'it explains itself on hover', capsule.getAttribute('title'))
  // The marks are already attached, so the control opens a list rather than
  // performing the attachment. It IS a control, though: it is the only way to reach
  // its own detail, so it has to be reachable from the keyboard.
  check(capsule.tagName === 'BUTTON', 'it is a button, so its detail is reachable', capsule.tagName)
  check(capsule.getAttribute('aria-expanded') === 'false', 'and reports itself collapsed')
  check(!/再次测试批注/.test(host2.textContent), 'the detail stays hidden until it is opened')
}

console.log('')
console.log('=== opening it lists what this batch actually carries ===')
// The reader's ask: the pill used to say only "3 attached", which answers "how many"
// and nothing else. The interesting question before sending is "which ones".
await act(async () => {
  capsule.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
const opened = host2.textContent
check(/再次测试批注/.test(opened), 'the note is shown once opened', opened.slice(0, 200))
check(/\.l2 > span:nth-of-type\(3\) > b/.test(opened), 'and so is the selector it belongs to')
check(/默认 · vip/.test(opened), 'and the element\'s own text')
check(/Bindings/.test(opened), 'every mark is listed, not just the first')
check(/编辑/.test(opened), 'and the last one too')
// The number is the row's position, which is the same number the host writes as
// `## Element n` and the sidebar and the pins show. A surface that numbered its rows
// differently would make "element 2" ambiguous between two windows.
const nums = [...host2.querySelectorAll('.dsa-chip-num')].map((el) => el.textContent)
check(nums.join(',') === '1,2,3', 'the rows are numbered in order', nums.join(','))
check(capsule.getAttribute('aria-expanded') === 'true', 'the control now reports itself expanded')
const list = host2.querySelector('.dsa-chip-list')
check(list !== null, 'the detail is a real list element')
check(list && list.className.includes('dsa-capsule-list'),
  'and is marked as the capsule\'s own, so its container styling can win over the shared row rule',
  list ? list.className : 'none')
// The extra request would be wasted work: the count and the entries arrive in the
// same answer, so opening must not fetch anything.
const before = requests.length
await act(async () => {
  capsule.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
check(requests.length === before, 'opening and closing costs no request', `${requests.length - before} extra`)
check(!/再次测试批注/.test(host2.textContent), 'and closing hides the detail again')

console.log('')
console.log('=== the detail never describes a different batch than the count ===')
// Both come from the same answer, so a change the reader made elsewhere has to move
// them together. A list that lagged the count by one answer would be the one fault
// here that cannot be detected by looking: both halves are individually plausible.
await act(async () => { await new Promise((r) => setTimeout(r, 1100)) })
hostCount = 1
hostEntries = [{ selector: '.l1 > button', text: '编辑', note: '只剩一条', page: '' }]
await act(async () => { await new Promise((r) => setTimeout(r, 1200)) })
// Reopened, because the closing case above deliberately left it shut. The point is
// what the list contains once it is shown again, not that a shut list updates.
await act(async () => {
  capsule.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
const shrunk = host2.textContent
check(/1/.test(shrunk), 'the count follows the host down')
check(host2.querySelectorAll('.dsa-chip-item').length === 1,
  'and so does the open list, from the same answer',
  String(host2.querySelectorAll('.dsa-chip-item').length))
check(/只剩一条/.test(shrunk), 'showing the surviving mark, not the cleared ones')
check(!/Bindings/.test(shrunk), 'and none of the ones the host no longer holds')

console.log('')
console.log('=== nothing is left over when the host lets go ===')

console.log('')
console.log('=== the host clears it when the turn starts ===')
hostCount = 0
await act(async () => { await new Promise((r) => setTimeout(r, 1200)) })
check(host2.querySelector('.dsa-capsule') === null, 'the capsule disappears once the host is empty',
  host2.querySelector('.dsa-capsule') ? host2.querySelector('.dsa-capsule').textContent : undefined)
const polled = requests.filter((r) => r.url.endsWith('/pending'))
check(polled.length > 0, 'it asks the host rather than guessing', `${polled.length} poll(s)`)
check(polled.some((r) => r.body && r.body.session === 'sess-1'),
  'and it asks about the session the dock belongs to',
  JSON.stringify(polled[0] && polled[0].body))

console.log('')
console.log('=== a slow answer cannot undo a newer one ===')
// The capsule polls on a 1s clock and `fetch` answers on its own schedule, so two
// polls can be in flight together and the OLDER answer can land last. It is not
// cosmetic: the poll right after a send asks "how many are still held", the host
// answers 0 because the turn consumed them, and a straggler from a second earlier
// then writes the pre-send count back. The reader sees the capsule stay up after a
// message that already went out — reported as "发送消息后对话栏上方胶囊不消失" — and
// the sidebar and the capsule then disagree about a number the host has changed.
//
// Answered out of order on purpose, because that is the only way this reproduces:
// the newer poll resolves with the cleared count, then the older one resolves with
// the count it read a moment before.
const pendingPolls = []
global.fetch = window.fetch = (url, options) => {
  if (!String(url).endsWith('/pending')) return Promise.resolve({ json: async () => ({ ok: true }) })
  return new Promise((resolve) => {
    pendingPolls.push({ resolve, body: options && options.body ? JSON.parse(options.body) : null })
  })
}
const host3 = document.createElement('div')
document.body.appendChild(host3)
const root3 = createRoot(host3)
await act(async () => {
  root3.render(React.createElement(Dock, { zone }))
})
// Let the second poll join the first, so both are in flight at once.
await act(async () => { await new Promise((r) => setTimeout(r, 1100)) })
check(pendingPolls.length >= 2,
  'two polls are in flight together, which is what makes the race possible',
  `${pendingPolls.length} outstanding`)

if (pendingPolls.length >= 2) {
  const stale = pendingPolls[0]
  const fresh = pendingPolls[pendingPolls.length - 1]
  // The newer poll answers first: the turn consumed the batch, nothing is held.
  await act(async () => {
    fresh.resolve({ json: async () => ({ ok: true, count: 2, epoch: 1 }) })
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
  check(root3 && host3.querySelector('.dsa-capsule') !== null,
    'the newer answer is applied', host3.textContent)

  // Then the straggler, carrying the count the host held BEFORE the send.
  await act(async () => {
    stale.resolve({ json: async () => ({ ok: true, count: 9, epoch: 1 }) })
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
  const after = host3.querySelector('.dsa-capsule')
  const shown = after ? after.textContent : ''
  check(!/9/.test(shown),
    'and the older answer is dropped rather than written back',
    `capsule shows ${JSON.stringify(shown)}`)
  check(root3 && /2/.test(shown),
    'leaving the newer count in place', JSON.stringify(shown))
}
await act(async () => { root3.unmount() })

console.log('')
await act(async () => { root.unmount() })
await act(async () => { root2.unmount() })
if (failures) {
  console.log(`CAPSULE CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('CAPSULE CHECKS PASSED')
process.exit(0)
