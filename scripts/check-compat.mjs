/**
 * Check the plugin's declared API surface against a specific DSH release.
 *
 * The plugin declares itself compatible with a DSH version only when the
 * services and slot names it uses actually exist in that release. This reads the
 * published packages for a target version and reports, per dependency, whether
 * what the plugin relies on is present.
 *
 * Usage:
 *   node scripts/check-compat.mjs 0.1.7-rc.1
 *
 * It does not install anything and does not modify a profile: it fetches the
 * published tarballs into a temp directory and inspects their declarations.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const target = process.argv[2]
if (!target) {
  console.log('usage: node scripts/check-compat.mjs <dsh-version>')
  console.log('example: node scripts/check-compat.mjs 0.1.7-rc.1')
  process.exit(2)
}

// What the plugin actually depends on, taken from its own manifest and code.
const NEEDS = [
  {
    pkg: '@deepseek-ai/dsh-client-ui-slots',
    why: 'ctx.get("slots") plus slots.register() for every panel entry',
    must: [/register\s*\(/, /SlotMap/],
  },
  {
    pkg: '@deepseek-ai/dsh-client-ui-sidebar-right',
    why: 'ctx.reflect.provide("sidebarRightTabs") and the sidebar.right.pane.tab slot',
    must: [/sidebarRightTabs/, /sidebar\.right\.pane\.tab/],
  },
]

const work = mkdtempSync(join(tmpdir(), 'dsh-compat-'))
// On Windows npm is a .cmd shim rather than an executable.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
console.log(`checking dsh ${target}`)
console.log(`scratch: ${work}\n`)

let missing = 0
for (const need of NEEDS) {
  const spec = `${need.pkg}@${target}`
  process.stdout.write(`${need.pkg}\n  ${need.why}\n  fetching ${spec} ... `)
  // Use --pack-destination so the tarball lands in a directory of our own and
  // cannot be confused with a leftover from the previous iteration. `silent`
  // suppresses the notice block npm prints on stderr.
  const dest = join(work, 'out')
  // npm does not create the pack destination, so it must exist first.
  mkdirSync(dest, { recursive: true })
  try {
    // On Windows `npm` is a .cmd shim, which spawnSync cannot execute directly,
    // so run it through the shell there. The spec is passed as a separate argv
    // entry and the package names contain no shell metacharacters.
    execFileSync(NPM, ['pack', spec, '--silent', '--pack-destination', dest], {
      cwd: work,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    })
  } catch (error) {
    const raw = String((error && error.stderr) || (error && error.message) || error).trim()
    const detail = raw ? raw.split('\n').slice(-3).join(' | ') : `exit ${error && error.status}`
    console.log('FETCH FAILED')
    console.log(`  -> ${detail}\n`)
    missing += 1
    continue
  }

  const tgz = readdirSync(dest).find((one) => one.endsWith('.tgz'))
  if (!tgz) {
    console.log('FETCH FAILED (no tarball produced)')
    missing += 1
    continue
  }
  execFileSync('tar', ['-xzf', join(dest, tgz)], { cwd: work, stdio: 'pipe' })
  rmSync(dest, { recursive: true, force: true })
  console.log('ok')

  // Concatenate the declaration files: the symbols may live in any of them.
  const typesDir = join(work, 'package', 'lib', 'types')
  const root = existsSync(typesDir) ? typesDir : join(work, 'package')
  const text = collect(root)
  for (const pattern of need.must) {
    const found = pattern.test(text)
    console.log(`  ${found ? 'ok  ' : 'MISS'} ${pattern}`)
    if (!found) missing += 1
  }
  console.log('')

  rmSync(join(work, 'package'), { recursive: true, force: true })
}

rmSync(work, { recursive: true, force: true })

if (missing) {
  console.log(`COMPAT CHECK FAILED — ${missing} required symbol(s) absent from dsh ${target}`)
  console.log('Declare this release as incompatible or unknown in dsh.compatibility.dshReleases.')
  process.exit(1)
}
console.log(`COMPAT CHECK PASSED — everything the plugin uses exists in dsh ${target}`)
console.log('A passing signal check is NOT a runtime acceptance test: only an install')
console.log('and start in a disposable profile proves that.')

function collect(dir) {
  let out = ''
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) out += collect(full)
    else if (/\.(d\.ts|js|md)$/.test(entry)) out += readFileSync(full, 'utf8')
  }
  return out
}
