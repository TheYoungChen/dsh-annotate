#!/usr/bin/env node
/**
 * Link the type sources this plugin compiles against.
 *
 * dsh-annotate imports a handful of packages that are not published to npm:
 * the DSH core packages (`@deepseek-ai/dsh-tools` and friends) and the DSH
 * client packages. They only exist inside a DSH checkout, so a contributor
 * cannot `npm install` them.
 *
 * Rather than vendoring copies, this script points `node_modules` at the
 * checkout the developer already has. Junctions (directory symlinks) are used
 * so the sources stay in one place and edits to DSH are picked up on the next
 * compile with no reinstall step.
 *
 * The checkout is found without configuration: this repository lives at
 * `<workspace>/plugins/dsh-annotate`, and a sibling workspace usually holds the
 * DSH checkout. `DSH_CHECKOUT` overrides the search when it does not.
 *
 * Usage:
 *   node scripts/link-dsh.mjs            # link what is missing
 *   node scripts/link-dsh.mjs --check    # report, change nothing
 *
 * @module
 */

import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const nodeModules = join(packageRoot, 'node_modules')
const checkOnly = process.argv.includes('--check')

/**
 * Candidate DSH checkouts, most specific first.
 *
 * A checkout is recognised by its root `package.json` naming the workspace, so
 * a stale or unrelated directory is skipped rather than linked blindly.
 */
function candidateCheckouts() {
  const explicit = process.env['DSH_CHECKOUT']
  const candidates = []
  if (typeof explicit === 'string' && explicit !== '') candidates.push(resolve(explicit))
  // <workspace>/plugins/dsh-annotate -> <workspace>/../<checkout>
  candidates.push(resolve(packageRoot, '..', '..', '..', 'deepseek-harness'))
  candidates.push(resolve(packageRoot, '..', '..', '..', '..', 'deepseek-harness'))
  return candidates
}

/** Whether a directory looks like the DSH checkout this plugin builds against. */
function isDshCheckout(dir) {
  return existsSync(join(dir, 'packages', 'core', 'tools', 'package.json'))
}

/** The first candidate that is a real checkout, or null. */
function findCheckout() {
  for (const candidate of candidateCheckouts()) {
    if (isDshCheckout(candidate)) return candidate
  }
  return null
}

/**
 * Package name to its directory inside the checkout.
 *
 * Only packages this plugin actually imports are listed; linking the whole
 * workspace would make the dependency surface impossible to review.
 */
const DSH_PACKAGES = {
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-host-webserver': 'packages/host/webserver',
  '@deepseek-ai/dsh-client-ui-settings': 'packages/client/ui-settings',
  '@deepseek-ai/dsh-client-locale': 'packages/client/locale',
  '@deepseek-ai/dsh-client-ui-renderer': 'packages/client/ui-renderer',
  '@deepseek-ai/dsh-client-ui-slots': 'packages/client/ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives': 'packages/client/ui-primitives',
}

/** Where a scoped package name lives under `node_modules`. */
function linkPath(name) {
  const [scope, bare] = name.startsWith('@') ? name.split('/') : [null, name]
  return scope === null ? join(nodeModules, bare) : join(nodeModules, scope, bare)
}

/** Nest a package inside the pnpm store, where hoisted deps are unavailable. */
function storePath(checkout, dir, name) {
  const bare = name.startsWith('@') ? name.split('/')[1] : name
  const pnpm = join(checkout, 'node_modules', '.pnpm')
  if (!existsSync(pnpm)) return null
  for (const entry of readdirSync(pnpm)) {
    if (!entry.startsWith(`${bare}@`)) continue
    const candidate = name.startsWith('@')
      ? join(pnpm, entry, 'node_modules', name.split('/')[0], bare)
      : join(pnpm, entry, 'node_modules', bare)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Create a directory link, replacing a stale one but never a real directory. */
function link(target, source, label) {
  if (existsSync(target)) {
    let existing = null
    try {
      existing = readlinkSync(target)
    } catch {
      // A real directory, not a link. Leave it alone: someone installed it.
      console.log(`  keep   ${label} (a real directory exists)`)
      return 'kept'
    }
    if (resolve(dirname(target), existing) === resolve(source)) {
      console.log(`  ok     ${label}`)
      return 'ok'
    }
    if (checkOnly) {
      console.log(`  stale  ${label} -> ${existing}`)
      return 'stale'
    }
    rmSync(target, { recursive: true, force: true })
  }
  if (checkOnly) {
    console.log(`  missing ${label}`)
    return 'missing'
  }
  mkdirSync(dirname(target), { recursive: true })
  symlinkSync(source, target, 'junction')
  console.log(`  linked ${label}`)
  return 'linked'
}

const checkout = findCheckout()
if (checkout === null) {
  console.error(
    'No DSH checkout found.\n'
    + 'Set DSH_CHECKOUT to the directory that contains packages/core/tools, e.g.\n'
    + '  $env:DSH_CHECKOUT = "E:\\path\\to\\deepseek-harness"',
  )
  process.exit(2)
}

console.log(`checkout: ${checkout}`)
console.log(checkOnly ? 'mode: check only' : 'mode: link')
console.log('')

const results = []

for (const [name, relative] of Object.entries(DSH_PACKAGES)) {
  const source = join(checkout, relative)
  if (!existsSync(source)) {
    console.log(`  skip   ${name} (not present in this checkout)`)
    results.push('skipped')
    continue
  }
  results.push(link(linkPath(name), source, name))
}

// Cordis and React are ordinary dependencies, but the checkout's copies are the
// ones whose type identities match the DSH packages above. Mixing a second copy
// in would produce duplicate-identity errors rather than useful diagnostics.
const HOISTED = {
  '@deepseek-ai/cordis': join(checkout, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', 'cordis'),
}

/**
 * Locate a package inside the checkout's pnpm store.
 *
 * The store names entries `<bare>@<version>` (with the scope spelled as a path
 * segment, e.g. `@types+node@22.10.2`), and the package itself sits under a
 * `node_modules` directory inside that entry. Versions are not pinned here on
 * purpose: whichever copy the checkout resolved is the one whose type
 * identities match the DSH packages linked above.
 */
function storeLookup(bare, scoped) {
  const pnpm = join(checkout, 'node_modules', '.pnpm')
  if (!existsSync(pnpm)) return null
  // pnpm spells a scoped entry as `@scope+name@version`.
  const prefix = scoped === null ? `${bare}@` : `${scoped.replace('@', '@')}+${bare}@`
  for (const entry of readdirSync(pnpm)) {
    if (!entry.startsWith(prefix)) continue
    const candidate = scoped === null
      ? join(pnpm, entry, 'node_modules', bare)
      : join(pnpm, entry, 'node_modules', scoped, bare)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Resolve a package the checkout already depends on.
 *
 * Hoisted copies are preferred over store lookups because a hoisted package is
 * the one the checkout itself resolves; falling back to the store only matters
 * for transitively-installed packages.
 */
function resolveDependency(name) {
  const bare = name.startsWith('@') ? name.split('/')[1] : name
  const scope = name.startsWith('@') ? name.split('/')[0] : null
  const hoisted = join(checkout, 'node_modules', ...(scope === null ? [bare] : [scope, bare]))
  if (existsSync(hoisted)) return hoisted
  return storeLookup(bare, scope)
}

for (const [name, fallback] of Object.entries(HOISTED)) {
  const source = existsSync(fallback) ? fallback : resolveDependency(name)
  if (source === null) {
    console.log(`  skip   ${name} (not found in the checkout)`)
    results.push('skipped')
    continue
  }
  results.push(link(linkPath(name), source, name))
}

// Type packages and tooling come from the checkout too: the DSH packages are
// compiled against these exact copies, and a second copy of `@types/react`
// would produce duplicate-identity errors rather than useful diagnostics.
for (const name of ['react', '@types/react', '@types/node', '@types/ws', 'ws', 'typescript']) {
  const source = resolveDependency(name)
  if (source === null) {
    console.log(`  skip   ${name} (not found in the checkout)`)
    results.push('skipped')
    continue
  }
  results.push(link(linkPath(name), source, name))
}

const problems = results.filter(r => r === 'missing' || r === 'stale').length
console.log('')
if (checkOnly && problems > 0) {
  console.log(`${problems} link(s) need attention. Re-run without --check to fix.`)
  process.exit(1)
}
console.log('Done. Run `npm run check` to typecheck against these sources.')
