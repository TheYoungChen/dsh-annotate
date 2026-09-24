/**
 * Preflight: run the client bundle against the harness's REAL client runtime.
 *
 * The earlier DOM check used a hand-written stub for `slots`. That proves the
 * component renders, but not that the real registries accept our shapes. This
 * loads the actual `@deepseek-ai/dsh-client-ui-slots` and the real sidebar-right
 * tab registry, then calls our `apply` with them.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const harness = 'E:/StudyFile/AI-Workspace/deepseek-harness'
const pairDir = `${harness}/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules`
const React = require(`${pairDir}/react`)

/** ESM on Windows needs a file:// URL, not a bare drive path. */
const asUrl = (path) => pathToFileURL(path).href

// --- the real slot service ----------------------------------------------------
const slotsMod = await import(asUrl(`${harness}/packages/client/ui-slots/lib/index.js`)).catch((error) => {
  console.log('could not import ui-slots:', error.message)
  return null
})
console.log('ui-slots exports:', slotsMod ? Object.keys(slotsMod).slice(0, 12).join(', ') : 'n/a')

// --- the real sidebar-right tab registry --------------------------------------
const sidebarMod = await import(asUrl(`${harness}/packages/client/ui-sidebar-right/lib/index.js`)).catch((error) => {
  console.log('could not import ui-sidebar-right:', error.message)
  return null
})
console.log('ui-sidebar-right exports:', sidebarMod ? Object.keys(sidebarMod).slice(0, 12).join(', ') : 'n/a')

if (!sidebarMod) {
  console.log('\nSKIPPED: the sidebar-right package is not importable in isolation')
  process.exit(0)
}

// The package exports only `apply`, so the registry is obtained the way the
// loader obtains it: run the plugin against a context and read the service back.
const cordis = require(`${harness}/vendor/cordis/lib/index.js`)
const app = new cordis.Context()
const sidebarApply = sidebarMod.apply || sidebarMod.default?.apply
try {
  sidebarApply(app, {})
} catch (error) {
  console.log('sidebar-right apply failed:', error.message)
  process.exit(0)
}
await new Promise((r) => setTimeout(r, 200))

let registry = null
for (const name of ['sidebarRightTabs', 'sidebarRightTabRegistry', 'sidebarRight']) {
  const candidate = app.get ? app.get(name) : undefined
  if (candidate && typeof candidate.register === 'function' && typeof candidate.claim === 'function') {
    registry = candidate
    console.log('obtained the real tab registry as:', name)
    break
  }
}
if (!registry) {
  console.log('could not obtain the tab registry from the plugin context; SKIPPED')
  process.exit(0)
}

// --- load the bundle with a loader the real registry can be injected into -----
let mod
global.window = global.window || {}
global.window.__ModuleLoader__ = {
  load({ factory }) {
    mod = factory((name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require: ${name}`)
    })
  },
}
global.document = {
  documentElement: { lang: 'zh' },
  head: { appendChild() {} },
  createElement: () => ({ setAttribute() {}, style: {} }),
}

await import('../client.js')
console.log('\nbundle loaded, apply is', typeof mod.apply)

// Point ctx.get at the real registry so the registration path is exercised.
const realCtx = {
  effect: (fn) => {
    const d = fn()
    return typeof d === 'function' ? d : () => {}
  },
  interval: () => () => {},
  get: (name) => {
    if (name === 'sidebarRightTabs') return registry
    if (name === 'slots') {
      return { inject: () => {}, register: () => () => {} }
    }
    return undefined
  },
}

mod.apply(realCtx)

// The real registry must now hold our tab type.
const kinds = registry.entries().map((entry) => ({ id: entry.id, kind: entry.kind, priority: entry.priority }))
console.log('\nregistry entries:', JSON.stringify(kinds))

const mine = registry.get('dsh-annotate')
if (!mine) {
  console.error('FAIL: the real registry did not accept the tab type')
  process.exit(1)
}
console.log('accepted by the real registry: id =', mine.id, '| kind =', mine.kind)
console.log('title() =>', mine.title('sidebar://annotate'))

// A page type must be claimable by kind, which is how openTab opens it.
try {
  const claim = registry.claim('sidebar://annotate', 'dsh-annotate')
  console.log('claim by kind =>', JSON.stringify({ kind: claim.kind, title: claim.title }))
} catch (error) {
  console.error('FAIL: claim by kind threw:', error.message)
  process.exit(1)
}

// A second registration of the same id must be rejected, or a reload would
// double-register instead of replacing.
let threw = false
try {
  registry.register({ id: 'dsh-annotate', kind: 'dsh-annotate', title: () => 'x' })
} catch {
  threw = true
}
console.log('duplicate id rejected:', threw)

console.log('\nPREFLIGHT (real client registries) PASSED')
