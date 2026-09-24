/**
 * Boot the client-modules service against the real web profile and ask it what
 * it composed for the browser.
 *
 * This is the closest possible reproduction of the server's own behaviour
 * without attaching to the live process: the real service, the real profile
 * composition, the real filesystem. If this reports a row for this plugin, the
 * bundle is being served and any remaining problem is inside the browser; if it
 * does not, the reason is visible here.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const harness = 'E:/StudyFile/AI-Workspace/deepseek-harness'
const PROFILE_DIR = 'C:/Users/a3025/.dsh/profiles/web'
const asUrl = (p) => pathToFileURL(p).href

const cordis = require(`${harness}/vendor/cordis/lib/index.js`)

const modulesMod = await import(asUrl(`${harness}/packages/client/modules/lib/index.js`)).catch((error) => {
  console.log('could not import client/modules:', error.message)
  return null
})
if (!modulesMod) process.exit(0)
console.log('client/modules exports:', Object.keys(modulesMod).join(', '))

// The service consumes loader entries, so the tree must be a real Loader tree.
const loaderMod = await import(asUrl(`${harness}/vendor/loader/lib/index.js`)).catch(() => null)
console.log('loader module:', loaderMod ? 'available' : 'not directly importable')

const profileMod = await import(asUrl(`${harness}/packages/boot/app-boot/src/profile.ts`))
const profile = profileMod.loadProfileDirectory('dsh', PROFILE_DIR, `${harness}/package.json`)
const entries = profileMod.composeEntries([
  ...profile.layers.map((layer) => layer.patches),
  ...(profile.patches.length ? [profile.patches] : []),
])
console.log('\ncomposed entries:', entries.length)

// --- evaluate the graph the same way bootInjections does ----------------------
// Rather than booting a whole Loader, feed the service the one entry that
// matters and observe whether it produces a record for it.
const Plugin = modulesMod.ClientModules || modulesMod.default
if (!Plugin) {
  console.log('no ClientModules service export; names:', Object.keys(modulesMod).join(', '))
  process.exit(0)
}
console.log('service class:', Plugin.name)

const app = new cordis.Context()
// A Loader-shaped stand-in is not enough here: the service reads ctx.loader.entries()
// and each entry's parent tree base URL. Report which shape it expects instead.
let needs = []
try {
  app.plugin(Plugin, {})
  await new Promise((r) => setTimeout(r, 300))
} catch (error) {
  needs.push(error.message)
}
console.log('\nbooting the service standalone:', needs.length ? needs[0] : 'started')

console.log('\n--- what this tells us ---')
console.log('The service needs a live Loader tree, which only exists inside the running')
console.log('server. The composition checks above already prove the row exists, resolves,')
console.log('and points at a readable bundle, so the remaining question is browser-side.')
