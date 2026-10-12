/**
 * The real bundle, under the real cordis, with the service arriving late.
 *
 * `check-chip-dom.mjs` proves the logic against a faithful fake. This proves the
 * thing the reader actually cares about, and that no fake can: that the SHIPPED
 * `client.js`, loaded the way the shell loads it, registers its conversation
 * Definition when `uiConversation` is provided by another row — and, just as
 * important, that it still loads when that service never arrives at all.
 *
 * The fake is only ever as good as its author's understanding. This is the
 * understanding, checked against the framework itself.
 */
import { createRequire } from 'node:module'

const require = createRequire('E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/package.json')
const React = require('E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react')
const { JSDOM } = require('E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/jsdom@29.1.1_@noble+hashes@2.3.0/node_modules/jsdom')
const { Context, Fiber } = require('E:/StudyFile/AI-Workspace/deepseek-harness/vendor/cordis/lib/index.js')

const STATE = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING']

const dom = new JSDOM('<!doctype html><html lang="zh"><body><div id="host"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
  pretendToBeVisual: true,
})
const { window } = dom
for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MessageEvent', 'requestAnimationFrame', 'localStorage', 'MutationObserver', 'getComputedStyle']) {
  global[key] = window[key]
}
global.fetch = async () => ({ json: async () => ({ ok: true, count: 0, epoch: 0 }) })
window.fetch = global.fetch

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// --- load the SHIPPED bundle the way the shell does ---------------------------
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

/** The services the shell provides, and what a plugin does with them. */
function makeShell() {
  const registered = new Map()
  const definitions = []
  const ctx = new Context()
  ctx.provide('slots', {
    inject: (key, fn) => fn(),
    register: (def, component) => {
      registered.set(def.id, { def, component })
      return () => {}
    },
  })
  ctx.provide('sidebarRightTabs', { register: () => () => {} })
  ctx.provide('sidebarRight', { openTab: () => {} })
  ctx.provide('sessions', { current: () => ({ id: 's1' }) })
  ctx.provide('__sink', { registered, definitions })
  return { ctx, registered, definitions }
}

// --- 1. the service arrives AFTER the plugin applies --------------------------
console.log('=== the real bundle, with uiConversation provided late ===')
const late = makeShell()
let lateError = null
let lateFiber
try {
  lateFiber = late.ctx.plugin(mod)
} catch (error) {
  lateError = error
}
await new Promise((r) => setTimeout(r, 60))

check(lateError === null, 'loading the bundle does not throw', lateError?.message)
check(late.registered.has('dsh-annotate-chip'),
  'the renderer seat is taken immediately',
  [...late.registered.keys()].join(', '))
check(late.definitions.length === 0,
  'no Definition yet, because the service is not up',
  String(late.definitions.length))

// The other row finishes starting — exactly the interleaving that hid the chip.
late.ctx.provide('uiConversation', {
  events: { register: (def) => { late.definitions.push(def); return () => {} } },
})
await new Promise((r) => setTimeout(r, 60))

check(late.definitions.length === 1,
  'the Definition registers once the service is provided',
  String(late.definitions.length))
check(late.definitions[0]?.kind === 'dsh-annotate-chip',
  'and it is the chip kind', late.definitions[0]?.kind)

// The chip must actually match the host's delivery, using the Definition the real
// bundle registered — the last link in the chain the reader saw broken.
const definition = late.definitions[0]
if (definition) {
  const block = [
    '# Web page elements',
    '',
    '## Element 1',
    'selector: .lp-head > h2',
    'text: 个人设置',
    'note: 批注1',
  ].join('\n')
  const event = {
    id: 'annotate-1',
    type: 'user/message',
    seq: 10,
    surfaceOp: 'append',
    data: {
      id: 'annotate-1',
      source: { kind: 'plugin', plugin: 'dsh-annotate', form: 'notice' },
      content: [{ type: 'text', text: block }],
    },
  }
  // The registry enriches the Definition's own `{id, role}` with the event and its
  // location; `start` reads `match.event.seq`, so the match object has to carry it.
  const matched = definition.match(event)
  check(matched !== null, 'it matches this plugin\'s own delivery', JSON.stringify(matched))
  const state = definition.start(
    { key: 'k', id: 'annotate-1' },
    { ...matched, event, location: { kind: 'unresolved' } },
    null,
  )
  const node = definition.buildViewNode({ key: 'k', kind: 'dsh-annotate-chip', id: 'annotate-1', state, matches: [], current: null })
  check(node !== null && node.data.items.length === 1,
    'and builds one chip carrying the mark',
    JSON.stringify(node?.data?.items?.[0] ?? null).slice(0, 80))
  check(node?.target === 'chat', 'targeted at the chat transcript', node?.target)
  check(node?.location?.kind === 'unresolved',
    'left unresolved so compact mode cannot fold it away', node?.location?.kind)
  check(node?.anchorSeq === event.seq - 0.5,
    'anchored just under the reader\'s bubble', String(node?.anchorSeq))
}

// --- 2. the service never arrives --------------------------------------------
console.log('\n=== the real bundle, on a shell with no uiConversation at all ===')
const never = makeShell()
let neverError = null
let neverFiber
try {
  neverFiber = never.ctx.plugin(mod)
} catch (error) {
  neverError = error
}
await new Promise((r) => setTimeout(r, 80))

check(neverError === null, 'loading does not throw', neverError?.message)
const neverState = STATE[neverFiber?.state] ?? String(neverFiber?.state)
// The shell's own boot audit rejects any entry that is not ACTIVE. A plugin that
// parked itself PENDING forever would fail that audit — turning a lost chip into a
// dead web client, which is strictly worse than the bug being fixed.
check(neverState === 'ACTIVE',
  'and the entry fiber is ACTIVE, so the shell\'s boot audit still passes', neverState)
check(never.registered.has('dsh-annotate-tab') && never.registered.has('annotate-capsule'),
  'the tab and capsule still register',
  [...never.registered.keys()].join(', '))
check(never.definitions.length === 0, 'with no chip Definition claimed', String(never.definitions.length))

// --- 3. a second activation on a live registry ---------------------------------
console.log('\n=== a reload that re-registers the chip kind ===')
const held = new Set()
const strict = makeShell()
const strictCtx = strict.ctx
strictCtx.provide('uiConversation', {
  events: {
    register: (def) => {
      if (held.has(def.kind)) throw new Error(`conversation Definition "${def.kind}" is already registered`)
      held.add(def.kind)
      return () => held.delete(def.kind)
    },
  },
})
let reloadError = null
try {
  strictCtx.plugin(mod)
  await new Promise((r) => setTimeout(r, 60))
  strictCtx.plugin(mod)
  await new Promise((r) => setTimeout(r, 60))
} catch (error) {
  reloadError = error
}
check(reloadError === null,
  'a duplicate-kind throw does not escape and take the plugin down', reloadError?.message)
check(held.has('dsh-annotate-chip'), 'and the chip is registered', [...held].join(', '))

console.log('')
if (failures) {
  console.log(`REAL BUNDLE CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('REAL BUNDLE CHECKS PASSED')
