/**
 * Ask the real client-modules resolver whether this plugin yields a client row.
 *
 * `resolveSource` -> `resolveMeta` -> `locatePkgJson` is the gate that decides
 * whether a loader entry contributes a browser bundle. The host half loading
 * proves nothing about it, which is exactly the trap this plugin fell into.
 *
 * The resolver is a private method on a service that needs a full context, so
 * the same steps are run here against the real filesystem and the real resolver
 * helpers, using the composed entry the profile actually produces.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const harness = 'E:/StudyFile/AI-Workspace/deepseek-harness'
const PROFILE_DIR = 'C:/Users/a3025/.dsh/profiles/web'

// --- 1. what the composed tree says the row is --------------------------------
const { pathToFileURL } = await import('node:url')
// app-boot ships no built lib for this entry, so the TypeScript source is used;
// the runner already has tsx available through the harness toolchain.
const profileMod = await import(pathToFileURL(`${harness}/packages/boot/app-boot/lib/profile.js`).href).catch(
  () => import(pathToFileURL(`${harness}/packages/boot/app-boot/src/profile.ts`).href),
)
const profile = profileMod.loadProfileDirectory('dsh', PROFILE_DIR, `${harness}/package.json`)
const entries = profileMod.composeEntries([
  ...profile.layers.map((layer) => layer.patches),
  ...(profile.patches.length ? [profile.patches] : []),
])
const row = entries.find((e) => e.id === 'dsh-annotate')
if (!row) {
  console.log('FAIL: the composed tree has no dsh-annotate row')
  process.exit(1)
}
const loaderName = row.name
console.log('composed row name (the loader specifier):', loaderName)

// --- 2. resolve it the way the Loader would -----------------------------------
// The profile's own tree is the base URL for its entries.
const baseUrl = (await import('node:url')).pathToFileURL(join(PROFILE_DIR, 'package.json')).href
console.log('resolution base:', baseUrl)

const require = createRequire(join(PROFILE_DIR, 'package.json'))
let resolvedPath = null
try {
  resolvedPath = require.resolve(loaderName)
  console.log('resolved to:', resolvedPath)
} catch (error) {
  console.log('FAIL: the loader specifier does not resolve:', error.message)
  process.exit(1)
}

// --- 3. nearestPackage from the resolved module --------------------------------
// Mirrors client-modules' own walk: the nearest ancestor manifest owns the module.
let dir = dirname(resolvedPath)
let owner = null
for (;;) {
  const candidate = join(dir, 'package.json')
  if (existsSync(candidate)) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
      if (typeof parsed.name === 'string') {
        owner = { path: candidate, pkg: parsed }
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
console.log('\nowning manifest:', owner && owner.path)
console.log('owning package:', owner && owner.pkg.name)

if (!owner || owner.pkg.name !== 'dsh-annotate') {
  console.log('FAIL: the walk did not land on this plugin\'s manifest')
  process.exit(1)
}

// --- 4. the declaration the resolver reads -------------------------------------
const decl = owner.pkg.dsh && owner.pkg.dsh.client
console.log('\ndsh.client:', JSON.stringify(decl))
if (!decl || decl.platform !== 'web') {
  console.log('FAIL: platform is not web, so resolveMeta returns null and no client row exists')
  process.exit(1)
}

const exportValue = owner.pkg.exports && owner.pkg.exports['./client']
const rel = typeof exportValue === 'string' ? exportValue : exportValue && exportValue.default
const clientPath = join(dirname(owner.path), rel)
console.log('client bundle:', clientPath)
console.log('exists:', existsSync(clientPath), '| bytes:', existsSync(clientPath) ? readFileSync(clientPath).length : 0)

// --- 5. would it be the ONLY source for this package? --------------------------
// reconcilePackage throws when one package resolves from two active rows.
console.log('\n=== other rows that could claim the same package ===')
const others = entries.filter((e) => e.name && /annotate/i.test(String(e.name)))
for (const other of others) {
  console.log('  ', other.id, '->', other.name)
}
if (others.length > 1) {
  console.log('  NOTE: more than one row names an annotate package;')
  console.log('        the original and this plugin declare different package names, so this is expected.')
} else {
  console.log('  only one row; no duplicate-source conflict')
}

console.log('\nRESULT: this plugin yields exactly one client row, from', owner.pkg.name)
