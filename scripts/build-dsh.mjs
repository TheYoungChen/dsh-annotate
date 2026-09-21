#!/usr/bin/env node
/**
 * Bundle the DSH half of the plugin into `lib/`.
 *
 * ## What this produces
 *
 * `package.json` declares two entry points, and both have to exist before DSH
 * can load the plugin:
 *
 * - `lib/index.js` — the **host** half. Runs in the DSH Node process: it owns
 *   the loopback bridge and registers the `annotate_status` tool.
 * - `lib/client.js` — the **browser** half. Served to the DSH web client, where
 *   it registers the pairing settings section and installs the composer port.
 *
 * The two are separate bundles on purpose. The host half must never pull in
 * React or the DOM, and the browser half must never pull in a socket server.
 *
 * ## Why the DSH packages are external
 *
 * `@deepseek-ai/*` is supplied by the DSH runtime the plugin is mounted into,
 * not by this package. Bundling them would ship a second copy of the service
 * definitions and the two copies would not be the same objects — a plugin
 * registering into its own private copy of a service registry would load
 * cleanly and then simply never be called. They are marked external so the
 * import survives into the output and resolves against the running DSH.
 *
 * The same reasoning applies to `ws` (a real dependency, resolved normally from
 * `node_modules` at run time) and to `react`, which the client half imports and
 * the DSH web bundle already provides.
 *
 * ## Why a bundler is needed at all
 *
 * Sources import each other with explicit `.ts` / `.tsx` specifiers — that is
 * what `allowImportingTsExtensions` requires and what lets Node's own type
 * stripping run the modules directly in tests. Nothing can load those as-is, so
 * they are resolved and rewritten here.
 *
 * @module
 */

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { findEsbuild } from './esbuild-locator.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const libDir = join(packageRoot, 'lib')
const checkOnly = process.argv.includes('--check')

/** Report a build failure and stop. */
function fail(message) {
  console.error(`build-dsh: ${message}`)
  process.exit(1)
}

/**
 * Packages the running DSH supplies, and which must not be bundled.
 *
 * Each entry is a prefix match, so `@deepseek-ai/` covers every DSH package —
 * core services, client UI packages and the client sub-path entries alike. The
 * list is a deliberate allowlist rather than "everything bare": a genuine
 * third-party dependency that slipped through un-externalised would be bundled
 * silently, and a duplicate copy of a stateful package is the kind of bug that
 * shows up as "the plugin loaded but nothing happens".
 */
const EXTERNAL = [
  // Supplied by the DSH host and web runtime.
  '@deepseek-ai/',
  // Supplied by the DSH web bundle; the client half is compiled against it.
  'react',
  'react-dom',
  'react/jsx-runtime',
  // Resolved from node_modules at run time — a real dependency of this package.
  'ws',
  // Node built-ins.
  'node:',
  'fs',
  'path',
  'url',
  'crypto',
  'http',
  'https',
  'stream',
  'events',
  'util',
  'os',
  'net',
  'tls',
  'zlib',
  'buffer',
  'assert',
]

/**
 * The two bundles to emit.
 *
 * `platform` and `format` are fixed per half rather than inferred: the host is
 * a Node process loading ESM, and the client is loaded by the browser bundle,
 * also as ESM. There is nothing here that a manifest could decide, so nothing
 * is read from one.
 */
const TARGETS = [
  {
    name: 'host',
    entry: join(packageRoot, 'src', 'index.ts'),
    out: join(libDir, 'index.js'),
    platform: 'node',
    target: 'node22',
    format: 'esm',
  },
  {
    name: 'client',
    entry: join(packageRoot, 'src', 'client', 'index.ts'),
    out: join(libDir, 'client.js'),
    platform: 'browser',
    target: 'chrome116',
    format: 'esm',
  },
]

/**
 * Run one bundle step.
 *
 * @param esbuild - the executable.
 * @param step - the target to build.
 */
function runEsbuild(esbuild, step) {
  const args = [
    step.entry,
    '--bundle',
    `--platform=${step.platform}`,
    `--target=${step.target}`,
    `--format=${step.format}`,
    '--charset=utf8',
    '--legal-comments=none',
    '--log-level=warning',
    '--sourcemap',
    '--sources-content=true',
    // Type-only imports are erased by the bundler, so the output never carries
    // a dependency the code does not actually use at run time.
    `--outfile=${step.out}`,
  ]
  for (const name of EXTERNAL) args.push(`--external:${name}`)

  const result = spawnSync(esbuild, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    // The executable is resolved to an absolute path and passed as argv[0], so
    // it needs no shell and no quoting rules of its own.
    shell: false,
  })
  if (result.error !== undefined && result.error !== null) {
    fail(`could not run esbuild for ${step.name}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim() || `exit code ${String(result.status)}`
    fail(`${step.name} bundle failed:\n${detail}`)
  }
  if (result.stderr !== null && result.stderr.trim() !== '') {
    process.stderr.write(result.stderr)
  }
}

/** Check that every target produced output, and report its size. */
function report(step) {
  if (!existsSync(step.out)) fail(`${step.name} produced no ${step.out}`)
  const size = statSync(step.out).size
  console.log(`  wrote  ${step.out.replace(`${packageRoot}\\`, '')} (${String(size)} bytes)`)
}

const esbuild = findEsbuild(packageRoot)
if (esbuild === null) {
  fail(
    'no esbuild executable found.\n'
    + '  The sources are TypeScript with explicit `.ts` import specifiers, so a bundler is\n'
    + '  required. This package adds no dependency of its own: install esbuild where this\n'
    + '  script can see it, or point ESBUILD_BIN at an executable.',
  )
}

if (checkOnly) {
  console.log(`checking ${String(TARGETS.length)} bundle(s) against ${esbuild}`)
  let missing = 0
  for (const step of TARGETS) {
    if (existsSync(step.out)) {
      console.log(`  ok       ${step.name}`)
    } else {
      console.log(`  missing  ${step.name} -> ${step.out}`)
      missing += 1
    }
  }
  process.exit(missing === 0 ? 0 : 1)
}

// The whole directory is replaced rather than written into. A stale bundle from
// a renamed entry point would otherwise sit in `lib/` forever and be the file
// DSH actually loads.
rmSync(libDir, { recursive: true, force: true })
mkdirSync(libDir, { recursive: true })

console.log(`bundling with ${esbuild}`)
for (const step of TARGETS) {
  runEsbuild(esbuild, step)
  report(step)
}
console.log('')
console.log(`${String(TARGETS.length)} bundle(s) written.`)
