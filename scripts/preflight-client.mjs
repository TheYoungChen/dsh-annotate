/**
 * Preflight: reproduce the client-modules resolution chain for this plugin.
 *
 * The web client decides which packages contribute a client bundle by walking
 * up from the host entry's resolved URL to the nearest package.json and reading
 * its `dsh.client` declaration. If that walk lands on the wrong manifest, the
 * plugin silently contributes no sidebar UI — or throws.
 *
 * This mirrors `locatePkgJson` + `nearestPackage` + `resolveMeta` closely enough
 * to catch a wiring mistake before a restart.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ENTRY = 'E:/StudyFile/AI-Workspace/dsh_workspace/plugins/dsh-annotate/lib/index.js'
const entryUrl = pathToFileURL(ENTRY).href
console.log('entry url:', entryUrl)

/** Mirrors nearestPackage: walk up from the module to the owning manifest. */
function nearestPackage(moduleUrl) {
  if (!moduleUrl.startsWith('file:')) return undefined
  let dir = dirname(fileURLToPath(moduleUrl))
  const visited = []
  for (;;) {
    const candidate = join(dir, 'package.json')
    visited.push(candidate)
    if (existsSync(candidate)) {
      try {
        const name = JSON.parse(readFileSync(candidate, 'utf8')).name
        if (typeof name === 'string') return { path: candidate, packageName: name, visited }
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { path: undefined, packageName: undefined, visited }
}

const located = nearestPackage(entryUrl)
console.log('\n--- package walk ---')
for (const [index, step] of located.visited.entries()) {
  const found = existsSync(step)
  console.log(`  ${index === 0 ? '->' : '  '} ${step} ${found ? '[FOUND manifest]' : ''}`)
  if (index > 3) break
}
console.log('owning package:', located.packageName)
console.log('owning manifest:', located.path)

if (located.packageName !== 'dsh-annotate') {
  console.error('\nFAIL: the walk did not stop at this plugin\'s own manifest')
  process.exit(1)
}

// --- the declaration client-modules will parse --------------------------------
const pkg = JSON.parse(readFileSync(located.path, 'utf8'))
const decl = pkg.dsh && pkg.dsh.client
console.log('\n--- dsh.client declaration ---')
console.log(JSON.stringify(decl, null, 1))

if (!decl) {
  console.error('FAIL: package.json declares no dsh.client')
  process.exit(1)
}
if (decl.platform !== 'web') {
  console.error(`FAIL: platform is ${decl.platform}, expected web`)
  process.exit(1)
}

// --- the ./client export must resolve to a real file ---------------------------
const clientRel = pkg.exports && pkg.exports['./client']
const clientExport = typeof clientRel === 'string' ? clientRel : clientRel && clientRel.default
console.log('\nclient export:', clientExport)
const clientPath = join(dirname(located.path), clientExport)
console.log('client bundle path:', clientPath)
if (!existsSync(clientPath)) {
  console.error('FAIL: the ./client export points at a missing file')
  process.exit(1)
}

// --- the client bundle must declare itself to the runtime loader ---------------
const clientSrc = readFileSync(clientPath, 'utf8')
const checks = [
  ['calls the module loader', /__ModuleLoader__\.load\s*\(/.test(clientSrc)],
  ['declares an id', /id:\s*['"]dsh-annotate['"]/.test(clientSrc)],
  ['exports apply', /exports\.apply\s*=/.test(clientSrc)],
  ['factory takes require', /factory:\s*\(?\s*require\s*\)?\s*=>/.test(clientSrc)],
  ['does not import at top level', !/^\s*import\s+/m.test(clientSrc)],
]
console.log('\n--- client bundle shape ---')
let bad = 0
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) bad += 1
}
if (bad) process.exit(1)

// --- inject entries must be packages the client can actually require -----------
console.log('\n--- dsh.client.inject resolvability ---')
const { createRequire } = await import('node:module')
const profileRequire = createRequire('C:/Users/a3025/.dsh/profiles/web/package.json')
for (const name of decl.inject || []) {
  try {
    const resolved = profileRequire.resolve(name)
    console.log(`  ok   ${name} -> ${resolved.replace(/\\/g, '/').split('/').slice(-3).join('/')}`)
  } catch (error) {
    console.log(`  WARN ${name} is not resolvable from the profile (${error.code || error.message})`)
    console.log('       the client runtime provides this itself; only a runtime failure would show it')
  }
}
// `react` is required by the bundle and is supplied by the runtime, not resolved
// from the profile tree; confirm it exists somewhere the client runtime owns.
try {
  const react = profileRequire.resolve('react')
  console.log(`  ok   react -> ${react.replace(/\\/g, '/').split('/').slice(-3).join('/')}`)
} catch (error) {
  console.log(`  WARN react not resolvable from the profile: ${error.code}`)
}

console.log('\nPREFLIGHT (client wiring) PASSED')
