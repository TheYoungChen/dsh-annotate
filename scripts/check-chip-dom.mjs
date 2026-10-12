/**
 * Mount the transcript chip in a real DOM and look at what it renders.
 *
 * Everything else about the chip is asserted against the shipped source or against
 * the Definition object. Neither can tell the reader what they will actually see:
 * whether the chip draws at all, whether the count is right, whether a click opens
 * the list, and whether the component survives the props the shell really passes
 * it — a node with a `data` bag, and nothing else.
 *
 * That last point is the one that matters most before a restart. The shell mounts
 * this component on every turn it has ever rendered, including turns with no
 * annotations, and a component that throws there takes the transcript down with it.
 * So the props are deliberately hostile: missing node, missing data, wrong types.
 */
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/a3025/.dsh/profiles/web/package.json')
const pairDir = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules'
const jsdomDir = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm/jsdom@29.1.1_@noble+hashes@2.3.0/node_modules'

const React = require(`${pairDir}/react`)
const { createRoot } = require(`${pairDir}/react-dom/client`)
const { act } = require(`${pairDir}/react-dom/test-utils`)
const { JSDOM } = require(`${jsdomDir}/jsdom`)

const dom = new JSDOM('<!doctype html><html lang="zh"><head></head><body><div id="host"></div></body></html>', {
  url: 'http://127.0.0.1:3000/',
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
global.fetch = async () => ({ json: async () => ({ ok: true, count: 0, epoch: 0 }) })
window.fetch = global.fetch
global.IS_REACT_ACT_ENVIRONMENT = true

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// --- load the bundle and capture the chip's seat ------------------------------
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

const registered = new Map()
const definitions = []
// The services this shell offers, as a mutable table rather than one `get` branch
// per name: a service that is provided AFTER the plugin applies is the whole point
// of the race below, and a `get` that can only ever answer from a closure cannot
// express it.
const services = {
  sidebarRightTabs: { register: () => () => {} },
  sidebarRight: { openTab: () => {} },
  sessions: { current: () => ({ id: 's1' }) },
  uiConversation: { events: { register: (def) => { definitions.push(def); return () => {} } } },
}
// Injection requests waiting on a service that is not up yet. Real cordis holds the
// callback until the provider applies; a fake that called it anyway would hide the
// bug this file exists to catch.
const pendingInjections = []
const ctx = {
  effect: (fn) => {
    const d = fn()
    return typeof d === 'function' ? d : () => {}
  },
  interval: () => () => {},
  get(name) {
    if (name === 'slots') {
      return {
        inject: (key, fn) => fn(),
        register: (def, component) => {
          registered.set(def.id, { def, component })
          return () => {}
        },
      }
    }
    return services[name]
  },
  // Faithful to `ctx.inject`: defer until every dependency is active, then call back
  // with a scope carrying them. `this` so a test can override `get`.
  inject(deps, cb) {
    const run = () => {
      const values = deps.map((dep) => this.get(dep))
      if (values.some((value) => value === undefined)) return false
      const scope = Object.assign({}, this)
      deps.forEach((dep, i) => { scope[dep] = values[i] })
      cb(scope)
      return true
    }
    if (!run()) pendingInjections.push(run)
    return { dispose() {} }
  },
  // Standing in for a provider fiber applying: publish, then release whoever waited.
  provide(name, value) {
    services[name] = value
    for (const run of pendingInjections.splice(0)) run()
  },
}
mod.apply(ctx)

console.log('=== the shell can find the chip\'s renderer ===')
check(registered.has('dsh-annotate-chip'),
  'a renderer is seated under the chip kind',
  [...registered.keys()].join(', '))
check(definitions.length === 1, 'and exactly one chip Definition registered', String(definitions.length))
const Chip = registered.get('dsh-annotate-chip')?.component
check(typeof Chip === 'function', 'the seat holds a component')

// --- mount it the way the shell does -----------------------------------------
const host = document.createElement('div')
document.body.appendChild(host)
const root = createRoot(host)

const ITEMS = [
  { selector: '.g-recharge', note: '汇率太小，改成 20px', text: 'Recharge', page: '' },
  { selector: 'body > div:nth-of-type(2) > p', note: '', text: '复制邀请码', page: '' },
]
const mount = async (node) => {
  await act(async () => {
    root.render(React.createElement(Chip, { node }))
  })
}

console.log('\n=== collapsed: the count, and nothing else ===')
await mount({ data: { items: ITEMS } })
const text = host.textContent
check(text.includes('批注'), 'the chip is labelled', text.slice(0, 40))
check(text.includes('×2'), 'and shows the count', text.match(/×\d+/)?.[0])
check(!text.includes('汇率太小'), 'the notes stay hidden until it is opened')
const button = host.querySelector('button.dsa-chip')
check(button !== null, 'it is a real button, so it is reachable by keyboard')
check(button?.getAttribute('aria-expanded') === 'false', 'and reports itself collapsed')

console.log('\n=== placed under the bubble, and the fallback when it cannot be measured ===')
// The chip is its own flow row, a SIBLING of the reader's row, so its left edge is
// the column's left edge and not the bubble's: the bubble is content-sized and
// right-aligned inside its row, so its left edge moves with the text. Aligning the
// chip to the left WITHOUT measuring therefore parked it at the far side of the
// transcript, nowhere near the message it describes — reported from a real session
// with a screenshot.
//
// jsdom has no layout, so every rect here is zero and this component can only ever
// take its fallback path in this environment. That is exactly why the two halves are
// asserted separately: the arithmetic is asserted where it is reachable (a pure
// function, in check-chip.mjs) and the fallback is asserted here.
const row = host.firstElementChild
check(row?.className === 'dsa-chip-row', 'the chip sits in its own flow row', row?.className)
check(/\.dsa-chip-row\{[^}]*align-items:flex-end/.test(readCss()),
  'with no measurement the row still right-aligns, under the bubble')
check(!row?.getAttribute('style'),
  'and jsdom really does take the fallback path, so this case is not vacuous',
  row?.getAttribute('style') ?? 'no style attribute')
// The indent mode, which the measured path switches to. Its two halves have to agree:
// while the items stay end-aligned a left padding only narrows the content box and
// the chip does not move at all, so a rule that forgot the alignment flip would look
// correct in the DOM and place the chip wrong on screen.
check(/\.dsa-chip-row--indent\{[^}]*align-items:flex-start/.test(readCss()),
  'the measured mode flips the alignment, without which padding would not move it')
check(!/\.dsa-chip-row\{[^}]*max-width/.test(readCss()),
  'the row is not width-capped, which would make the offset wrong by the trimmed amount')

console.log('\n=== the anchor is the seat, not the row\'s sibling ===')
// This is the mistake that would have made the whole placement silently do nothing.
// The shell wraps each transcript node in its own element (`ChatNodeSeat` sets
// `data-chat-anchor-key`), and the slot occupant is rendered INSIDE it — so the
// chip's row has NO sibling, `previousElementSibling` is always null, and the
// measurement would fall back on every real message while looking deliberate. The
// message is a sibling of the chip's SEAT.
const seat = document.createElement('div')
seat.setAttribute('data-chat-anchor-key', 'dsh-annotate-chip')
const row2 = document.createElement('div')
row2.className = 'dsa-chip-row'
seat.appendChild(row2)
document.body.appendChild(seat)
check(mod.__chipSeat(row2) === seat,
  'the seat is found from the row it wraps, through the shell\'s own hook',
  mod.__chipSeat(row2)?.getAttribute('data-chat-anchor-key') ?? 'null')
// The fault itself: the row has no sibling, so the obvious lookup finds nothing.
check(row2.previousElementSibling === null,
  'the row really does have no sibling, which is why the naive lookup failed',
  String(row2.previousElementSibling))
// Nesting deeper must not break it: `closest` walks all the way up, so an extra
// wrapper added by a future shell does not silently disable the measurement.
const deeper = document.createElement('div')
seat.removeChild(row2)
deeper.appendChild(row2)
seat.appendChild(deeper)
check(mod.__chipSeat(row2) === seat,
  'and it still resolves when the occupant nests deeper',
  mod.__chipSeat(row2)?.getAttribute('data-chat-anchor-key') ?? 'null')
check(mod.__chipSeat(null) === null, 'a missing row is handled')
// With no seat at all the row itself is the fallback, whose sibling IS the right
// thing to look at — a bare harness, or a shell that stops wrapping.
const bare = document.createElement('div')
document.body.appendChild(bare)
check(mod.__chipSeat(bare) === bare, 'with no seat wrapper the row is its own anchor')
seat.remove()
bare.remove()

console.log('\n=== a click opens the list ===')
await act(async () => {
  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
const open = host.textContent
check(open.includes('汇率太小'), 'the note is shown once opened', open.includes('汇率太小'))
check(open.includes('.g-recharge'), 'and so is the selector')
check(open.includes('复制邀请码'), 'every mark is listed, not just the first')
check(host.querySelector('.dsa-chip-list') !== null, 'the list is a real element')
check(host.querySelectorAll('.dsa-chip-item').length === 2, 'with one row per mark',
  String(host.querySelectorAll('.dsa-chip-item').length))
check(host.querySelector('button.dsa-chip')?.getAttribute('aria-expanded') === 'true',
  'and the button reports itself expanded')
// `at` is geometry for the model, not for the reader.
check(!open.includes('679,276'), 'geometry is not shown')

console.log('\n=== closing it again ===')
await act(async () => {
  host.querySelector('button.dsa-chip').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
check(!host.textContent.includes('汇率太小'), 'the list closes on a second click')
check(host.textContent.includes('×2'), 'and the chip itself remains')

console.log('\n=== it survives the props the shell really passes ===')
// Every turn in the transcript mounts this seat, including turns with no
// annotations at all. A throw here would take the whole conversation down, which is
// the restart-into-an-error failure mode.
const hostile = [
  ['no node', undefined],
  ['an empty node', {}],
  ['no data', { data: undefined }],
  ['data with no items', { data: {} }],
  ['items of the wrong type', { data: { items: 'nope' } }],
  ['an empty list', { data: { items: [] } }],
  ['an item with no fields', { data: { items: [{}] } }],
  ['a null item', { data: { items: [null] } }],
]
for (const [label, node] of hostile) {
  let threw = null
  try {
    await mount(node)
  } catch (error) {
    threw = error
  }
  check(threw === null, `renders without throwing: ${label}`, threw?.message)
}
// A delivery that carried marks always has content, so the meaningful case is an
// item with a selector but no note: that must still draw (it is a real mark) while
// an item with nothing at all must not.
await mount({ data: { items: [{ selector: '#a', note: '', text: '', page: '' }] } })
check(host.textContent.includes('×1'), 'a mark with only a selector still draws', host.textContent.slice(0, 30))
await mount({ data: { items: [{ selector: '', note: '', text: '' }] } })
check(host.textContent === '', 'a mark with nothing at all draws nothing', JSON.stringify(host.textContent))

console.log('\n=== the component reads the theme, it does not assume it ===')
await mount({ data: { items: ITEMS } })
const chipEl = host.querySelector('.dsa-chip')
check(chipEl?.getAttribute('data-dark') === 'false', 'light by default', chipEl?.getAttribute('data-dark'))
document.body.setAttribute('data-ds-dark-theme', '')
await mount({ data: { items: ITEMS } })
check(host.querySelector('.dsa-chip')?.getAttribute('data-dark') === 'true',
  'and dark when the shell says so', host.querySelector('.dsa-chip')?.getAttribute('data-dark'))

await act(async () => { root.unmount() })

// --- the reload path, which is the one the reader actually fears --------------
console.log('\n=== a second activation does not take the plugin down ===')
// This is the restart-into-an-error failure mode, reproduced for real. The host's
// registry refuses a kind it already holds BY THROWING, and `apply` can run again
// on a live registry (a reload, a re-composition). Activation is shared with the
// sidebar, the tab and the composer capsule, so an escaping throw loses all of it.
//
// The fake registry below throws exactly as `ConversationEventRegistry.register`
// does — same condition, same synchronous throw — rather than politely accepting a
// duplicate, because a fake that accepts everything cannot fail this test.
const held = new Set()
const strictCtx = {
  ...ctx,
  get: (name) => {
    if (name !== 'uiConversation') return ctx.get(name)
    return {
      events: {
        register: (def) => {
          if (held.has(def.kind)) {
            throw new Error(`conversation Definition "${def.kind}" is already registered`)
          }
          held.add(def.kind)
          return () => held.delete(def.kind)
        },
      },
    }
  },
}
let secondActivation = null
try {
  mod.apply(strictCtx)
} catch (error) {
  secondActivation = error
}
check(secondActivation === null,
  'a reload that re-registers the chip kind does not throw out of apply',
  secondActivation?.message)
check(held.has('dsh-annotate-chip'), 'and the chip is registered after it', [...held].join(', '))

// And the same activation repeated: still no throw, still one chip.
let thirdActivation = null
try {
  mod.apply(strictCtx)
} catch (error) {
  thirdActivation = error
}
check(thirdActivation === null, 'nor on a third activation', thirdActivation?.message)

// --- a shell with no conversation service at all -------------------------------
console.log('\n=== an older shell without uiConversation still loads ===')
// The service arrives with the release that added per-plugin Definitions. A shell
// without it must cost the chip and nothing else: no throw, and the sidebar and the
// capsule still registered.
const bareRegistered = new Map()
const bareCtx = {
  ...ctx,
  get: (name) => {
    if (name === 'uiConversation') return undefined
    if (name === 'slots') {
      return {
        inject: (key, fn) => fn(),
        register: (def, component) => {
          bareRegistered.set(def.id, { def, component })
          return () => {}
        },
      }
    }
    return ctx.get(name)
  },
}
let bareActivation = null
try {
  mod.apply(bareCtx)
} catch (error) {
  bareActivation = error
}
check(bareActivation === null, 'apply survives a missing uiConversation', bareActivation?.message)
check(bareRegistered.has('dsh-annotate-tab') && bareRegistered.has('annotate-capsule'),
  'the tab and the composer capsule still register',
  [...bareRegistered.keys()].join(', '))
check(bareRegistered.has('dsh-annotate-chip'),
  'and the chip renderer is seated anyway, so a later Definition has an occupant')

// --- the race that actually shipped -------------------------------------------
console.log('\n=== a conversation service that arrives AFTER the plugin applies ===')
// This is the bug the reader hit: the sidebar tab and the composer capsule appeared,
// the chip never did, and nothing errored anywhere.
//
// `uiConversation` is provided by another row, and rows apply concurrently, so a
// plugin that SAMPLES the service during its own apply reads `undefined` whenever
// that row happens to be slower. The shipped code branched on exactly that sample,
// skipped the registration for good, and warned into a console nobody reads — a
// missing feature rather than an error. Waiting is the fix, so the assertion is that
// the Definition appears when the service does, however late that is.
const late = makeFakeShell()
mod.apply(late.ctx)

check(late.registered.has('dsh-annotate-chip'),
  'the renderer seat goes in immediately, before the service exists',
  [...late.registered.keys()].join(', '))
check(late.definitions.length === 0,
  'and no chip Definition is claimed while the service is missing',
  String(late.definitions.length))

// The other row finishes starting.
late.ctx.provide('uiConversation', {
  events: { register: (def) => { late.definitions.push(def); return () => {} } },
})

check(late.definitions.length === 1,
  'the Definition registers once the service arrives',
  String(late.definitions.length))
check(late.definitions[0]?.kind === 'dsh-annotate-chip',
  'and it is the chip kind', late.definitions[0]?.kind)

// The same shell, but the service never arrives at all: the plugin must stay usable
// rather than half-loaded, which is what the tab and capsule checks above cover.
const never = makeFakeShell()
let neverThrew = null
try {
  mod.apply(never.ctx)
} catch (error) {
  neverThrew = error
}
check(neverThrew === null, 'and apply does not throw when the service never arrives', neverThrew?.message)
check(never.definitions.length === 0, 'with no chip Definition claimed', String(never.definitions.length))

console.log('')
if (failures) {
  console.log(`CHIP DOM CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('CHIP DOM CHECKS PASSED')

/**
 * A fake shell whose services can be provided late.
 *
 * The important fidelity is `inject`: it must DEFER until every dependency is up,
 * exactly as cordis does. A fake that called back immediately would report success
 * for a plugin that sampled the service too early, which is the whole bug.
 */
function makeFakeShell() {
  const registered = new Map()
  const definitions = []
  const services = {}
  const pending = []
  const ctx = {
    effect: (fn) => {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    interval: () => () => {},
    get(name) {
      if (name === 'slots') {
        return {
          inject: (key, fn) => fn(),
          register: (def, component) => {
            registered.set(def.id, { def, component })
            return () => {}
          },
        }
      }
      return services[name]
    },
    inject(deps, cb) {
      const run = () => {
        const values = deps.map((dep) => this.get(dep))
        if (values.some((value) => value === undefined)) return false
        const scope = Object.assign({}, this)
        deps.forEach((dep, i) => { scope[dep] = values[i] })
        cb(scope)
        return true
      }
      if (!run()) pending.push(run)
      return { dispose() {} }
    },
    provide(name, value) {
      services[name] = value
      for (const run of pending.splice(0)) run()
    },
  }
  return { ctx, registered, definitions }
}

/** Read the shipped stylesheet out of the bundle's own source. */
function readCss() {
  const { readFileSync } = require('node:fs')
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  return src.slice(src.indexOf('const CSS = `'), src.indexOf('\n`', src.indexOf('const CSS = `')))
}
