/**
 * Locate a native esbuild executable.
 *
 * The project ships with no dependencies, so a bundler has to be found already
 * installed on the machine rather than declared and fetched. Both build scripts
 * need the same search — the extension build and the DSH-side build — so it
 * lives here instead of in either one.
 *
 * ## Why a native executable and not the package
 *
 * Three constraints, each of which rules out the more obvious approach:
 *
 * 1. **Do not link into a pnpm store.** A directory junction from
 *    `node_modules/esbuild` into a store entry breaks as soon as esbuild runs:
 *    the store's copy reaches its platform binary through a *relative*
 *    `node_modules/@esbuild/<platform>` path that only resolves inside its own
 *    entry, and a junction one level short points nowhere.
 * 2. **Do not `import()` out of a store.** Loading a package by absolute path
 *    resolves its dependencies from that path, which drags a second copy of the
 *    Node-runtime packages into the process. An executable that is *spawned*
 *    has no such coupling.
 * 3. **Do not add a dependency.** The package genuinely has none, and a build
 *    script is not a good reason to start.
 *
 * @module
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Store layouts a package manager may have used, hoisted first. */
const STORE_DIRS = ['.pnpm', 'node_modules']

/**
 * Where an esbuild install may be found, most specific first.
 *
 * `ESBUILD_BIN` short-circuits the search entirely. Otherwise: the package's
 * own `node_modules` (a contributor who installed one gets exactly their
 * version), then the workspace the package lives in, then any sibling checkout
 * — which is where this project already looks for the types it compiles
 * against, so a contributor working inside a larger repository needs no extra
 * setup.
 *
 * @param packageRoot - the package whose build is running.
 * @returns candidate `node_modules` directories.
 */
export function candidateRoots(packageRoot) {
  const roots = [join(packageRoot, 'node_modules')]
  let dir = packageRoot
  // Walk up a bounded number of levels, skipping duplicates: a package manager
  // may hoist an install above the repository, which is exactly the workspace
  // case — the install sits beside the workspace rather than inside it.
  for (let hops = 0; hops < 6; hops += 1) {
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
    for (const name of ['node_modules', 'deepseek-harness']) {
      const modules = name === 'node_modules' ? join(dir, name) : join(dir, name, 'node_modules')
      if (existsSync(modules) && !roots.includes(modules)) roots.push(modules)
    }
  }
  return roots
}

/**
 * Every `.pnpm`-style store entry under a directory that looks like esbuild.
 *
 * @param dir - a directory holding a store.
 * @returns candidate esbuild package directories.
 */
export function storeEntries(dir) {
  const entries = []
  for (const store of STORE_DIRS) {
    const storeDir = join(dir, store)
    if (!existsSync(storeDir)) continue
    let names
    try {
      names = readdirSync(storeDir)
    } catch {
      // An unreadable store is not an error; the search simply moves on.
      continue
    }
    for (const name of names) {
      // `esbuild@1.2.3` in a pnpm store, `esbuild` in a flat install.
      if (name === 'esbuild' || name.startsWith('esbuild@')) {
        entries.push(join(storeDir, name, 'node_modules', 'esbuild'))
      }
    }
  }
  const flat = join(dir, 'esbuild')
  if (existsSync(flat)) entries.push(flat)
  return entries
}

/**
 * The platform binary inside an esbuild install.
 *
 * esbuild's JavaScript entry point launches a native executable, and the
 * executable is the part worth invoking. It lives either beside the package (a
 * flat install) or under `@esbuild/<platform>` in the `node_modules` directory
 * that also holds the package — the store layout, reached by a relative path
 * that only resolves there.
 *
 * @param packageDir - an esbuild package directory.
 * @returns the executable's path, or `null` when this install has none.
 */
export function platformBinary(packageDir) {
  const exe = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild'
  const platform = `${process.platform}-${process.arch}`
  const candidates = [
    join(packageDir, exe),
    join(packageDir, 'bin', exe),
    join(dirname(packageDir), '@esbuild', platform, exe),
    join(packageDir, 'node_modules', '@esbuild', platform, exe),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Find an esbuild executable.
 *
 * When several versions are installed — a pnpm store keeps every version any
 * package in the workspace ever asked for — the **newest** is chosen. An older
 * esbuild does not understand a newer `target` and reports it as an
 * "Unrecognized target environment" warning while still emitting output, which
 * is the worst possible failure mode: a build that looks green and silently
 * ignores the target it was asked for.
 *
 * @param packageRoot - the package whose build is running.
 * @returns the executable's path, or `null` when none is installed.
 */
export function findEsbuild(packageRoot) {
  const explicit = process.env['ESBUILD_BIN']
  if (typeof explicit === 'string' && explicit !== '') {
    return existsSync(explicit) ? explicit : null
  }
  const found = []
  for (const root of candidateRoots(packageRoot)) {
    for (const packageDir of storeEntries(root)) {
      const binary = platformBinary(packageDir)
      if (binary !== null && !found.includes(binary)) found.push(binary)
    }
  }
  if (found.length === 0) return null
  return found.sort(compareEsbuildPaths).at(-1) ?? null
}

/**
 * Order two esbuild executables by the version in their path.
 *
 * The versions live in the store directory names (`esbuild@0.28.1`), but the
 * binary is a few levels below that, so the whole path is searched rather than
 * the immediate parent. A path with no version sorts first, which keeps a
 * hand-installed `node_modules/esbuild` from beating a versioned one.
 *
 * @param a - one executable path.
 * @param b - the other.
 * @returns a negative number, zero, or a positive number.
 */
function compareEsbuildPaths(a, b) {
  const versionOf = (path) => {
    const match = /esbuild[@/\\](\d+)\.(\d+)\.(\d+)/.exec(path)
    if (match === null) return [0, 0, 0]
    return [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const left = versionOf(a)
  const right = versionOf(b)
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
