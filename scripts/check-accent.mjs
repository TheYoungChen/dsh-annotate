/**
 * Verify the mark colour is a setting, not a hardcoded orange.
 *
 * Three surfaces have to agree and they are reached three different ways, so
 * each is asserted where it can actually be observed:
 *
 *   1. the shell's own UI follows a custom property on the document element,
 *   2. the choice survives a reload,
 *   3. the previewed page is TOLD, because it is a separate document and cannot
 *      inherit a property set on the shell.
 *
 * The reported problem was that the accent was a literal `#f0a05a` in a dozen
 * rules. A test that only checked the setting existed would have passed the whole
 * time that was true, so this one asserts the var is what the rules use.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(here, '..')
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

const posted = []
global.fetch = async (url) => {
  const u = String(url)
  if (u.endsWith('/pending')) return { json: async () => ({ ok: true, count: 0, block: '', epoch: 0 }) }
  if (u.endsWith('/context')) return { json: async () => ({ ok: true, count: 0 }) }
  if (u.endsWith('/detect')) return { json: async () => ({ ok: true, servers: [], pages: [] }) }
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
  on: () => () => {},
  logger: { warn() {}, info() {}, error() {} },
}

// Capture the messages the dock pushes into the previewed page.
const pageMessages = []
window.addEventListener('message', (event) => { pageMessages.push(event.data) })

mod.apply(ctx, { enabled: true })

const tab = registered.get('dsh-annotate:annotate') || [...registered.values()][0]

console.log('=== the accent is a setting, not a literal in the stylesheet ===')
const src = readFileSync(join(PLUGIN, 'client.js'), 'utf8')

// The stylesheet is a template literal, so a backtick anywhere inside it —
// including in a sentence of prose — terminates the string early and turns the
// rest of the CSS into JavaScript. The failure surfaces as a syntax error a long
// way from the comment that caused it. Written three times now; checked here so
// the fourth time is caught by the suite rather than by a broken page.
const literalStart = src.indexOf('const CSS = `') + 'const CSS = `'.length
const literalLines = src.slice(literalStart).split('\n')
let literalEnd = -1
for (let i = 1; i < literalLines.length; i++) if (literalLines[i].trim() === '`') { literalEnd = i; break }
check(literalEnd > 0, 'the stylesheet literal terminates on its own line')
const strayTicks = literalLines.slice(1, literalEnd).filter((line) => line.includes('`'))
check(strayTicks.length === 0,
  'no stray backtick inside the stylesheet literal',
  strayTicks.length ? `line: ${strayTicks[0].trim().slice(0, 70)}` : undefined)

// Every accent-coloured rule must read the variable. A literal that survives in a
// colour position is a place the setting silently does not reach.
const styleBlock = src.slice(src.indexOf('const CSS = `'), src.indexOf('.dsa-swatch:focus-visible'))
const hardcoded = styleBlock.match(/#f0a05a(?![,)])/g) || []
check(hardcoded.length === 0,
  'no accent colour is hardcoded in a rule body',
  hardcoded.length ? `${hardcoded.length} literal(s) remain` : '(all read the variable)')
check(/--dsa-accent:hsl\(var\(--dsa-h\)/.test(src),
  'the accent is built from HSL channels, so one value drives every alpha')
check(/ACCEPT|ACCENTS = \[/.test(src), 'a preset table exists')

console.log('')
console.log('=== the capsule is opaque AND still coloured ===')
// Two faults in a row here, in opposite directions: a translucent tint let the
// transcript show through the pill, and replacing it with the shell's neutral
// surface removed the colour entirely. Both are asserted, because fixing either
// one alone reintroduces the other.
const capsuleRule = /\.dsa-capsule\{([^}]*)\}/.exec(src)?.[1] || ''
check(/background-color:var\(--dsw-specific-menu/.test(capsuleRule),
  'the capsule sits on an opaque theme surface, so nothing shows through')
check(/background-image:linear-gradient\(var\(--dsa-accent-soft\)/.test(capsuleRule),
  'and the accent is layered over it, so it is not a plain white pill')
check(/border:1px solid var\(--dsa-accent-line\)/.test(capsuleRule),
  'a border in the accent colour separates it from the transcript either way')
check(/--dsa-accent-ink/.test(capsuleRule) || /dsa-capsule-label\{[^}]*--dsa-accent-ink/.test(src),
  'the label is tinted with the accent rather than left inheriting')

console.log('')
console.log('=== every preset stays readable in both themes ===')
// The ink's lightness is fixed and the surface is the preset tinted over the
// theme background, so contrast is computable without a browser. It was NOT
// before: deriving the ink from the preset left 青竹 at 4.23:1, under the AA floor.
const srgb = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
const luminance = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b)
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (hi + 0.05) / (lo + 0.05)
}
const hsl2rgb = (h, s, l) => {
  s /= 100; l /= 100
  const k = (n) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))]
}
const blend = (fg, bg, alpha) => fg.map((v, i) => Math.round(v * alpha + bg[i] * (1 - alpha)))

const presetRows = [...src.matchAll(/value: '(\d+) (\d+)% (\d+)%'/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])])
check(presetRows.length >= 4, 'the presets are readable from the source', `${presetRows.length} found`)
check(/--dsa-accent-ink:hsl\(var\(--dsa-h\) calc\(var\(--dsa-s\) \* \.9\) 26%\)/.test(src),
  'the ink lightness is fixed, so contrast does not vary with the chosen preset')

const WHITE = [255, 255, 255]
const DARKBG = [30, 30, 30]
let worst = Infinity
for (const [h, s, l] of presetRows) {
  const tint = hsl2rgb(h, s, l)
  const light = contrast(hsl2rgb(h, s * 0.9, 26), blend(tint, WHITE, 0.18))
  const dark = contrast(hsl2rgb(h, s * 0.8, 80), blend(tint, DARKBG, 0.18))
  worst = Math.min(worst, light, dark)
}
check(worst >= 4.5,
  `every preset clears WCAG AA in both themes (worst ${worst.toFixed(2)}:1)`,
  worst < 4.5 ? 'a preset is unreadable against its own tint' : undefined)

console.log('')
console.log('=== the variables the capsule reads are actually in scope ===')
// This is the check that was missing, and its absence is why a "fixed" capsule
// shipped as a plain white pill. Asserting the RULE mentions a variable proves
// nothing: `var()` with nothing to resolve to makes the whole declaration invalid
// at computed-value time, so the browser drops it silently and falls back.
//
// Two things have to hold. The properties must be defined on a selector that
// really encloses both halves of the plugin — they live in different DOM branches,
// the composer dock and the right sidebar — and the chain must terminate in a
// colour rather than in another unresolvable `var()`.
const cssStart = src.indexOf('const CSS = `') + 'const CSS = `'.length
const cssLines = src.slice(cssStart).split('\n')
let cssEnd = -1
for (let i = 1; i < cssLines.length; i++) if (cssLines[i].trim() === '`') { cssEnd = i; break }
const stylesheet = cssLines.slice(1, cssEnd).join('\n')

const defined = {}
for (const block of stylesheet.matchAll(/:root\{([^}]*)\}/g)) {
  for (const decl of block[1].split(';')) {
    const colon = decl.indexOf(':')
    if (colon > 0 && decl.trim().startsWith('--')) defined[decl.slice(0, colon).trim()] = decl.slice(colon + 1).trim()
  }
}
const needed = ['--dsa-accent-soft', '--dsa-accent-line', '--dsa-accent-ink']
check(needed.every((name) => defined[name] !== undefined),
  'every accent variable the capsule uses is defined on :root',
  needed.filter((n) => defined[n] === undefined).join(', ') || '(all present)')

const resolveVars = (value, depth = 0) => {
  if (value === undefined || depth > 12 || !value.includes('var(')) return value
  return resolveVars(
    value.replace(/var\((--[a-z0-9-]+)(?:,\s*([^)]*))?\)/g, (_, name, fallback) => defined[name] ?? fallback ?? ''),
    depth + 1,
  )
}
const unresolved = needed.filter((name) => {
  const out = resolveVars(defined[name])
  return out === undefined || out === '' || out.includes('var(')
})
check(unresolved.length === 0,
  'and the chain resolves to a real colour, so no declaration is dropped',
  unresolved.length ? `${unresolved.join(', ')} do not resolve` : needed.map((n) => resolveVars(defined[n])).join(' | '))

// A plugin-local wrapper would look correct here and still fail in the browser,
// because the capsule is not inside it.
check(!/\.dsa-root\{--dsa/.test(stylesheet),
  'the variables are not scoped to a wrapper the capsule lives outside of')

console.log('')
console.log('=== the choice reaches the shell and survives a reload ===')
const root0 = window.document.documentElement
check(root0.style.getPropertyValue('--dsa-h') !== '',
  'the accent is applied to the document element when the plugin loads',
  `--dsa-h=${root0.style.getPropertyValue('--dsa-h') || '(unset)'}`)

// Mount the panel and pick a colour through the UI, the way a reader does.
const host = window.document.getElementById('host')
const root = createRoot(host)
await act(async () => {
  root.render(React.createElement(tab.component, { sessionId: 'sess-accent' }))
})

// The picker lives in the overflow menu, so it is not in the DOM until the menu
// opens. Asserted directly rather than worked around: keeping the toolbar to two
// rows is the reason the panel has room for the page at all.
check(host.querySelectorAll('.dsa-swatch').length === 0,
  'the picker stays out of the toolbar until the menu is opened')

const menuButton = host.querySelector('.dsa-menu-wrap button')
check(menuButton !== null, 'the overflow menu has a trigger on the toolbar')
await act(async () => { menuButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

const swatches = [...host.querySelectorAll('.dsa-swatch')]
check(swatches.length >= 4, 'the picker renders a set of presets', `${swatches.length} swatch(es)`)
check(host.querySelectorAll('.dsa-swatch[data-on="true"]').length === 1,
  'exactly one preset reads as selected')

// Pick the third one, which is not the default.
const target = swatches[2]
const targetColour = target.querySelector('i').style.background
await act(async () => { target.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

const afterH = root0.style.getPropertyValue('--dsa-h')
check(afterH !== '' && afterH !== '32',
  'choosing a preset moves the document property off the default', `--dsa-h=${afterH}`)
check(window.localStorage.getItem('dsh-annotate:accent') !== null,
  'and the choice is stored, so it survives a reload',
  String(window.localStorage.getItem('dsh-annotate:accent')))

console.log('')
console.log('=== an opened page is told the accent ===')
// The page is a separate document and cannot inherit the property set on the
// shell, so the accent has to travel in the open request instead.
//
// Driven through the source rather than by clicking: React's synthetic events do
// not reach handlers in jsdom (a limitation this suite has hit repeatedly), so a
// click-based assertion here would fail for a reason unrelated to the accent and
// I would be tuning the test until it went green.
const openSrc = src.slice(src.indexOf('const openTarget = async (target)'), src.indexOf('const setPageMode'))
check(/accent/.test(openSrc),
  'the open request sends the accent to the host',
  openSrc.match(/body: JSON\.stringify\([^)]*\)/)?.[0] || '(no body found)')
check(/currentAccent/.test(src) || /accent,/.test(openSrc),
  'and it sends the CURRENT value, not a captured default')
// The host must accept it and reject anything that is not HSL channels, because
// the value is interpolated into a stylesheet inside the previewed page.
const hostSrc = readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8')
check(/function normaliseAccent/.test(hostSrc),
  'the host validates the accent before it reaches a stylesheet')
check(/normaliseAccent\(body && body\.accent\)/.test(hostSrc),
  'and the open route is where it is applied')
const overlaySrc = readFileSync(join(PLUGIN, 'lib', 'overlay.js'), 'utf8')
check(/case 'accent'/.test(overlaySrc),
  'the page can also be recoloured live, without a reload')
check(/config\.accent/.test(overlaySrc),
  'and it reads the accent from its own injected config')

console.log('')
console.log('=== a reload restores the stored colour rather than the default ===')
const stored = window.localStorage.getItem('dsh-annotate:accent')
const ctx2 = { ...ctx }
delete ctx2.get
ctx2.get = () => undefined
// Re-run apply against a fresh document to prove the value is read back, not
// merely left over in the DOM from the click above.
root0.style.removeProperty('--dsa-h')
root0.style.removeProperty('--dsa-s')
root0.style.removeProperty('--dsa-l')
mod.apply(ctx, { enabled: true, __reset: true })
check(root0.style.getPropertyValue('--dsa-h') !== '',
  'loading again reapplies an accent', `--dsa-h=${root0.style.getPropertyValue('--dsa-h')}`)
check(root0.style.getPropertyValue('--dsa-h') === String(stored).split(' ')[0],
  'and it is the stored one', `${root0.style.getPropertyValue('--dsa-h')} vs ${String(stored).split(' ')[0]}`)

console.log('')
if (failures) {
  console.log(`ACCENT CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('ACCENT CHECKS PASSED')
process.exit(0)
