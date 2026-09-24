/**
 * Preflight: will the harness's client-module activation accept this plugin?
 *
 * The web client composes every package declaring `dsh.client` during the
 * activation scan, and a failure there THROWS (ClientPackageCompositionError),
 * which is what a bad restart would look like. A plugin added later is only
 * warned about, so being in cordis.patch.yml means we are on the strict path.
 *
 * This reproduces the checks that path performs on our row:
 *   1. the entry resolves to a module URL
 *   2. the nearest package.json declares dsh.client with platform web
 *   3. package.json exports a "./client" bundle
 *   4. that bundle is readable and non-empty
 *   5. the inject names are well-formed strings
 *   6. no row declares its own package in external
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const failures = []
const note = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// Resolved from this script, so a copied tree is inspected rather than the
// original. Hard-coded absolute paths here would make the whole check vacuous.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'lib', 'index.js')
const PROFILE_PATCH = process.env.DSH_ANNOTATE_PATCH || 'C:/Users/a3025/.dsh/profiles/web/cordis.patch.yml'
// The profile directory itself, not just its patch file: composition needs both.
const PROFILE_DIR = process.env.DSH_ANNOTATE_PROFILE || 'C:/Users/a3025/.dsh/profiles/web'

console.log('preflight: client-module activation for the configured row')
console.log('inspecting:', ROOT.replace(/\\/g, '/'), '\n')

// --- 1. the entry must resolve -------------------------------------------------
console.log('1. entry resolution')
note(existsSync(ENTRY), 'host entry exists', ENTRY)
const entryUrl = pathToFileURL(ENTRY).href

// --- 2. nearest manifest must be this plugin's and declare dsh.client ----------
console.log('\n2. package ownership')
let dir = dirname(fileURLToPath(entryUrl))
let manifest = null
for (;;) {
  const candidate = join(dir, 'package.json')
  if (existsSync(candidate)) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
      if (typeof parsed.name === 'string') {
        manifest = { path: candidate, pkg: parsed }
        break
      }
    } catch {
      /* keep walking */
    }
  }
  const parent = dirname(dir)
  if (parent === dir) break
  dir = parent
}
note(manifest !== null, 'an owning manifest was located')
note(manifest && manifest.pkg.name === 'dsh-annotate', 'the owning manifest is this package', manifest && manifest.pkg.name)
const decl = manifest && manifest.pkg.dsh && manifest.pkg.dsh.client
note(Boolean(decl), 'dsh.client is declared')
note(decl && decl.platform === 'web', 'dsh.client.platform is web', decl && decl.platform)

// --- 3. the ./client export ----------------------------------------------------
console.log('\n3. client bundle')
const exportValue = manifest && manifest.pkg.exports && manifest.pkg.exports['./client']
const rel = typeof exportValue === 'string' ? exportValue : exportValue && exportValue.default
note(Boolean(rel), 'package.json exports "./client"', rel)
const clientPath = rel ? join(dirname(manifest.path), rel) : null
note(clientPath && existsSync(clientPath), 'the exported bundle exists', clientPath)

let size = 0
if (clientPath && existsSync(clientPath)) {
  const stat = statSync(clientPath)
  size = stat.size
}
note(size > 0, 'the bundle is non-empty', `${size} bytes`)

// The loader executes it as a classic script, so it must not be an ES module.
if (clientPath && existsSync(clientPath)) {
  const text = readFileSync(clientPath, 'utf8')
  note(/__ModuleLoader__\.load\s*\(/.test(text), 'the bundle self-registers with the loader')
  note(!/^\s*(import|export)\s/m.test(text), 'the bundle is a classic script, not an ES module')
  // A syntax error would only surface in the browser, so parse it here.
  let parses = true
  let parseError = ''
  try {
    new Function(text)
  } catch (error) {
    parses = false
    parseError = error.message
  }
  note(parses, 'the bundle parses as a script', parseError)
}

// --- 4. inject declarations are well formed ------------------------------------
console.log('\n4. inject declarations')
const inject = (decl && decl.inject) || []
note(Array.isArray(inject), 'inject is an array')
note(
  inject.every((name) => typeof name === 'string' && name.length > 0),
  'every inject name is a non-empty string',
  inject.join(', '),
)

// --- 5. a row must not declare its own package as external ---------------------
console.log('\n5. external declaration')
const external = (decl && decl.external) || []
note(!external.includes('dsh-annotate'), 'the row does not declare itself external', external.join(', ') || '(none)')

// --- 6. the host entry must import cleanly ------------------------------------
console.log('\n6. host half imports')
let imported = null
try {
  imported = await import(entryUrl)
  note(true, 'the host entry imports')
  note(typeof imported.apply === 'function', 'it exports apply')
  note(Array.isArray(imported.inject), 'it declares host inject', JSON.stringify(imported.inject))
} catch (error) {
  note(false, 'the host entry imports', error.message)
}

// --- 7. the plugin must appear exactly once in the REAL composed tree ----------
// Text-matching one patch file was wrong twice over: it missed rows that arrive
// through the profile's bundle layers, and it flagged this plugin when its row
// moved there. The check now asks the harness to compose the profile itself.
console.log('\n7. composed tree')
const hostSrc = readFileSync(ENTRY, 'utf8')
const routeMatch = /const ROUTE = '([^']+)'/.exec(hostSrc)
const route = routeMatch && routeMatch[1]
note(Boolean(route), 'the route constant is readable', route)

let composed = null
try {
  const { pathToFileURL } = await import('node:url')
  const harness = process.env.DSH_HARNESS || 'E:/StudyFile/AI-Workspace/deepseek-harness'
  const profileMod = await import(pathToFileURL(`${harness}/packages/boot/app-boot/lib/profile.js`).href).catch(
    () => import(pathToFileURL(`${harness}/packages/boot/app-boot/src/profile.ts`).href),
  )
  const profile = profileMod.loadProfileDirectory('dsh', PROFILE_DIR, `${harness}/package.json`)
  composed = profileMod.composeEntries([
    ...profile.layers.map((layer) => layer.patches),
    ...(profile.patches.length ? [profile.patches] : []),
  ])
  note(true, 'the profile composes', `${composed.length} entries`)
} catch (error) {
  note(false, 'the profile composes', error.message)
}

if (composed) {
  const annotateRows = composed.filter((e) => /annotate/i.test(String(e.id)) || /annotate/i.test(String(e.name)))
  note(annotateRows.length === 1, 'exactly one annotate row is composed', annotateRows.map((r) => r.id).join(', ') || '(none)')
  note(annotateRows[0] && annotateRows[0].id === 'dsh-annotate', 'the composed row is this plugin', annotateRows[0] && annotateRows[0].id)
  // A duplicate would make webServer throw on the same route at startup.
  note(
    !annotateRows.some((r) => /upstream/i.test(String(r.id))),
    'no competing original-plugin row (it shares this route)',
  )
}

// --- 7b. declared client services must really exist ----------------------------
// A missing entry here is invisible at runtime: the client applies, finds the
// service absent, and quietly contributes no UI.
console.log('\n7b. declared client services')
const harnessDir = process.env.DSH_HARNESS || 'E:/StudyFile/AI-Workspace/deepseek-harness'
const { existsSync: exists2, readFileSync: read2 } = await import('node:fs')
const { join: join2 } = await import('node:path')

// The client packages live under packages/client/*; match by declared name
// rather than guessing a directory from the package name.
const clientRoot = join2(harnessDir, 'packages', 'client')
const declaredNames = new Map()
if (exists2(clientRoot)) {
  const { readdirSync } = await import('node:fs')
  for (const dir of readdirSync(clientRoot)) {
    const manifest = join2(clientRoot, dir, 'package.json')
    if (!exists2(manifest)) continue
    try {
      const parsed = JSON.parse(read2(manifest, 'utf8'))
      if (typeof parsed.name === 'string') declaredNames.set(parsed.name, manifest)
    } catch {
      /* ignore an unreadable manifest */
    }
  }
}
for (const service of inject) {
  note(declaredNames.has(service), `inject target exists: ${service}`)
}

// --- 8. the two halves must agree on the endpoint -----------------------------
// The client reaches the host over HTTP at a path it hard-codes. If the two
// drift apart the panel simply never talks to the host, which looks like a dead
// UI rather than a crash — so it is checked explicitly.
console.log('\n8. host/client endpoint agreement')
const clientSrc2 = readFileSync(clientPath, 'utf8')
const clientApi = /const API = '([^']+)'/.exec(clientSrc2)
const clientApiPath = clientApi && clientApi[1]
note(Boolean(clientApiPath), 'the client declares an API base', clientApiPath)
note(clientApiPath === route, 'the client API base matches the host route', `${clientApiPath} vs ${route}`)

// Every action the client calls must exist on the host.
const called = [...clientSrc2.matchAll(/fetch\(`\$\{API\}\/([a-z]+)`/g)].map((m) => m[1])
const implemented = [...hostSrc.matchAll(/case '([a-z]+)':/g)].map((m) => m[1])
console.log(`  client calls: ${called.join(', ') || '(none)'}`)
console.log(`  host implements: ${implemented.join(', ') || '(none)'}`)
for (const action of called) {
  note(implemented.includes(action), `the host implements "${action}"`)
}

// --- verdict -------------------------------------------------------------------
console.log('')
if (failures.length) {
  console.log(`PREFLIGHT FAILED — ${failures.length} problem(s):`)
  for (const one of failures) console.log(`  - ${one}`)
  console.log('\nDo not restart until these are fixed.')
  process.exit(1)
}
console.log('PREFLIGHT PASSED — the activation scan should accept this row.')
