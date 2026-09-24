/**
 * Preflight: will the PROFILE activate this plugin's client half?
 *
 * The earlier activation preflight only checked that the package is
 * well-formed. It missed the thing that actually decides whether the sidebar
 * tab appears: a plugin's client half is reached through the profile's
 * `dsh.profile.bundles` list, and a plugin that is merely a dependency — or
 * merely inserted through the user's cordis.patch.yml — gets its HOST half
 * loaded and its CLIENT half silently ignored.
 *
 * That is exactly the failure this plugin hit, so the check is explicit here:
 *   - the plugin declares dsh.bundle.patch
 *   - it is listed in the profile's dsh.profile.bundles
 *   - it is NOT also inserted by hand in the profile patch (double registration
 *     makes webServer throw on a duplicate route)
 *   - the bundle's own patch inserts exactly one row, under the expected id
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const failures = []
const note = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = process.env.DSH_ANNOTATE_PROFILE || 'C:/Users/a3025/.dsh/profiles/web'
const PACKAGE_NAME = 'dsh-annotate'

console.log('preflight: profile activation for', PACKAGE_NAME)
console.log('profile:', PROFILE, '\n')

// --- 1. the plugin declares a bundle patch ------------------------------------
console.log('1. bundle declaration')
const pkgPath = join(ROOT, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
note(pkg.name === PACKAGE_NAME, 'the package name matches', pkg.name)
const patchRel = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
note(Boolean(patchRel), 'dsh.bundle.patch is declared', patchRel)
const patchPath = patchRel ? join(ROOT, patchRel) : null
note(patchPath && existsSync(patchPath), 'the declared patch file exists', patchPath)

// --- 2. the profile lists it among its bundles --------------------------------
console.log('\n2. profile bundles')
const profilePkgPath = join(PROFILE, 'package.json')
const profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
const bundles = (profilePkg.dsh && profilePkg.dsh.profile && profilePkg.dsh.profile.bundles) || []
note(Array.isArray(bundles), 'the profile declares a bundles list', `${bundles.length} entries`)
note(bundles.includes(PACKAGE_NAME), `${PACKAGE_NAME} is in dsh.profile.bundles`)

// A bundle must also be a resolvable dependency, or the layer cannot be loaded.
const deps = profilePkg.dependencies || {}
note(
  Object.prototype.hasOwnProperty.call(deps, PACKAGE_NAME),
  `${PACKAGE_NAME} is a profile dependency`,
  deps[PACKAGE_NAME],
)

// --- 3. the profile patch must not double-register ----------------------------
console.log('\n3. no double registration')
const profilePatchPath = join(PROFILE, 'cordis.patch.yml')
const profilePatch = existsSync(profilePatchPath) ? readFileSync(profilePatchPath, 'utf8') : ''
const activeLines = profilePatch
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n')
const handInserted = new RegExp(`id:\\s*${PACKAGE_NAME}\\s*$`, 'm').test(activeLines)
note(!handInserted, 'the profile patch does not also insert this plugin by hand')

// While here: the original package registers the SAME route, so it must be off.
const upstreamActive = /id:\s*upstream-annotate\s*$/m.test(activeLines)
note(!upstreamActive, 'the original dsh-annotate row is not active (same route)')

// --- 4. the bundle patch inserts exactly the row we expect --------------------
console.log('\n4. bundle patch contents')
if (patchPath && existsSync(patchPath)) {
  const patchText = readFileSync(patchPath, 'utf8')
  const yaml = await import('file:///C:/Users/a3025/.dsh/profiles/web/node_modules/js-yaml/index.js').catch(() => null)
  if (!yaml) {
    console.log('  (js-yaml unavailable; falling back to a textual check)')
    note(/insert:/.test(patchText), 'the patch contains an insert list')
    note(new RegExp(`id:\\s*${PACKAGE_NAME}`).test(patchText), 'it inserts this plugin id')
  } else {
    let parsed = null
    try {
      parsed = yaml.default.load(patchText)
    } catch (error) {
      note(false, 'the bundle patch parses as YAML', error.message)
    }
    if (parsed) {
      note(true, 'the bundle patch parses as YAML')
      const ids = parsed.filter((e) => e && e.insert).flatMap((e) => e.insert).map((row) => row.id)
      note(ids.length === 1, 'it inserts exactly one row', ids.join(', '))
      note(ids[0] === PACKAGE_NAME, 'the inserted row id is this plugin', ids[0])
      const row = parsed.filter((e) => e && e.insert).flatMap((e) => e.insert)[0]
      note(row && row.name === PACKAGE_NAME, 'the row resolves the plugin by package name', row && row.name)
    }
  }
}

// --- 5. the installed link must point at this source tree ---------------------
console.log('\n5. profile link')
const linkedPath = typeof deps[PACKAGE_NAME] === 'string' ? deps[PACKAGE_NAME] : ''
const isLink = linkedPath.startsWith('link:')
note(isLink, 'the profile dependency is a link', linkedPath)
if (isLink) {
  const target = linkedPath.slice('link:'.length).replace(/\\/g, '/')
  const sameTree = resolve(target).toLowerCase() === resolve(ROOT).toLowerCase()
  note(sameTree, 'it links to this source tree', target)
}
const installedPkg = join(PROFILE, 'node_modules', PACKAGE_NAME, 'package.json')
if (existsSync(installedPkg)) {
  const installed = JSON.parse(readFileSync(installedPkg, 'utf8'))
  note(installed.version === pkg.version, 'the installed copy matches this version', `${installed.version} vs ${pkg.version}`)
  // A hoisted copy would shadow the link and serve stale code.
  const installedMain = join(PROFILE, 'node_modules', PACKAGE_NAME, 'lib', 'index.js')
  if (existsSync(installedMain)) {
    const a = readFileSync(installedMain, 'utf8')
    const b = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
    note(a === b, 'the installed entry is identical to this tree (not a stale copy)')
  }
} else {
  note(false, 'the profile has an installed copy of the plugin', installedPkg)
}

console.log('')
if (failures.length) {
  console.log(`PREFLIGHT FAILED — ${failures.length} problem(s):`)
  for (const one of failures) console.log(`  - ${one}`)
  process.exit(1)
}
console.log('PREFLIGHT PASSED — the profile should activate both halves.')
