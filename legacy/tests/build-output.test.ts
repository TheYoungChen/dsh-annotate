/**
 * The built halves load the way DSH loads them.
 *
 * Every other suite in this directory tests `src/`. This one tests `lib/` —
 * the artifacts DSH actually mounts. The distinction matters because the two
 * can disagree: a source tree that type-checks and passes its unit tests can
 * still be bundled into something the loader rejects, and the failure then
 * appears as an unrelated plugin failing to load, with no pointer back here.
 *
 * That is not hypothetical. An earlier revision emitted the client half as an
 * ES module with a real `import "react"` in it. The browser has no import map
 * for that specifier, the composed client bundle failed to parse, and DSH
 * reported the failure against `@deepseek-ai/dsh-client-ui-renderer` — a
 * package this plugin has nothing to do with.
 *
 * So these assertions are about the artifact's contract with the loader:
 *
 *   1. the client half registers a factory under the right id and requires only
 *      specifiers the loader can answer
 *   2. both halves export the four things Cordis reads
 *   3. every name in `dsh.client.inject` resolves to a real client row
 *
 * The third is the one with no other guard. An `inject` name that resolves to
 * nothing is skipped silently by the loader, so the plugin claims a dependency
 * it does not have and nothing ever reports it.
 *
 * @module
 */

import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const packageRoot = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const libDir = join(packageRoot, 'lib')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

const HOST_BUNDLE = join(libDir, 'index.js')
const CLIENT_BUNDLE = join(libDir, 'client.js')

/** Whether both artifacts exist, which is what a checkout without a build lacks. */
const built = existsSync(HOST_BUNDLE) && existsSync(CLIENT_BUNDLE)

/**
 * The DSH checkout, located the way the build scripts locate it.
 *
 * Returns `null` when there is none, so the suite degrades to the checks that
 * need no checkout rather than failing on a machine that never had one.
 *
 * @returns the checkout root, or null.
 */
function dshCheckout() {
  const explicit = process.env['DSH_CHECKOUT']
  if (typeof explicit === 'string' && explicit !== '' && existsSync(explicit)) return explicit
  let dir = packageRoot
  for (let hops = 0; hops < 6; hops += 1) {
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
    const candidate = join(dir, 'deepseek-harness')
    if (existsSync(join(candidate, 'packages'))) return candidate
    if (existsSync(join(dir, 'packages', 'client'))) return dir
  }
  return null
}

const checkout = dshCheckout()

/**
 * Assert that an `inject` list names services the way Cordis reads them.
 *
 * `inject` is a list of service names to wait for before activating. Cordis
 * interpolates each entry into the boot error it raises when the wait does not
 * end, so an entry that is not a string is reported as `[object Object]` — and
 * a service by that name does not exist, so the wait never ends. The plugin
 * stays `pending` forever and the only symptom is a boot message that names
 * nothing actionable.
 *
 * This is an easy mistake to make, because the mistake looks like a feature: a
 * `{ name: undefined }` entry reads as "optional dependency" and is in fact
 * "wait for a service called [object Object]". An optional dependency belongs in
 * the code that uses it, resolved by name at run time.
 *
 * @param inject - the value exported as `inject`.
 * @param half - which half this is, for the failure message.
 */
function assertInjectNamesAreStrings(inject, half) {
  assert.ok(Array.isArray(inject), `${half} must export an inject array`)
  for (const entry of inject) {
    assert.equal(
      typeof entry,
      'string',
      `${half} inject contains ${JSON.stringify(entry)}; every entry must be a service name, `
      + 'or Cordis waits forever for a service called [object Object]',
    )
    assert.notEqual(entry, '', `${half} inject contains an empty service name`)
  }
}

/**
 * The platform seed, as DSH's `seed.ts` builds it.
 *
 * These are the only specifiers the loader answers from a shell-static import.
 * Anything else a client factory requires has to arrive as a graph row.
 *
 * @returns specifier → module exports.
 */
function platformSeed() {
  if (checkout === null) return null
  const shell = join(checkout, 'packages', 'client', 'web', 'package.json')
  if (!existsSync(shell)) return null
  const require = createRequire(shell)
  try {
    return {
      'react': require('react'),
      'react/jsx-runtime': require('react/jsx-runtime'),
      'react-dom': require('react-dom'),
      'react-dom/client': require('react-dom/client'),
    }
  } catch {
    // A checkout without the shell's dependencies installed cannot answer this,
    // and that is a property of the checkout rather than of this plugin.
    return null
  }
}

test('the host half exposes the four things Cordis reads', { skip: !built }, async () => {
  const mod = await import(pathToFileURL(HOST_BUNDLE).href)
  assert.equal(typeof mod.name, 'string', 'name must be a string')
  assert.equal(mod.name, manifest.name, 'name must match the package name')
  assert.equal(typeof mod.apply, 'function', 'apply must be callable')
  assertInjectNamesAreStrings(mod.inject, 'the host half')
})

test('the client half registers a factory rather than being an ES module', { skip: !built }, () => {
  const source = readFileSync(CLIENT_BUNDLE, 'utf8')

  // A top-level `import` statement is the exact failure this test exists for:
  // the browser cannot resolve a bare specifier, so the parse fails and the
  // whole composed bundle goes with it.
  const staticImports = source.split('\n').filter((line) => /^\s*import\s/.test(line))
  assert.deepEqual(
    staticImports,
    [],
    'the client bundle must contain no static import; the loader cannot answer one',
  )

  assert.match(source, /__ModuleLoader__\.load\(/, 'the bundle must register through the loader global')
  assert.match(
    source,
    new RegExp(`id:\\s*["']${manifest.name}["']`),
    'the registration id must be the package name',
  )
})

test('the client factory runs, and only asks for specifiers the loader answers', { skip: !built }, async () => {
  const seed = platformSeed()
  if (seed === null) return // No checkout, or its shell is not installed.

  // A minimal stand-in for the two browser globals a client bundle touches at
  // module scope. Everything else is real.
  const globals = globalThis
  const saved = { window: globals.window, document: globals.document }
  const registrations = []
  const loader = {
    mode: 'queue',
    pendingQueue: registrations,
    load: (registration) => { registrations.push(registration) },
  }
  try {
    globals.window = globals
    globals.document = { createElement: () => ({ style: {} }), head: { appendChild: () => {} } }
    globals.window.__ModuleLoader__ = loader

    const source = readFileSync(CLIENT_BUNDLE, 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, '')
    // eslint-disable-next-line no-new-func
    new Function(source)()

    assert.equal(registrations.length, 1, 'the bundle must register exactly one factory')
    const registration = registrations[0]
    assert.equal(registration.id, manifest.name)

    /** Specifiers the factory asked the loader for. */
    const requested = []
    /**
     * The loader's synchronous require, as `ModuleSystem.require` implements it:
     * a seed word resolves, anything else is a hard miss rather than undefined.
     *
     * @param spec - the specifier the factory asked for.
     * @returns the module's exports.
     */
    const loaderRequire = (spec) => {
      requested.push(spec)
      if (Object.hasOwn(seed, spec)) return seed[spec]
      throw new Error(`require("${spec}") missed the module table`)
    }

    const exports = registration.factory(loaderRequire)

    assert.equal(typeof exports.apply, 'function', 'the factory must return a plugin body')
    assert.equal(exports.name, manifest.name, 'the factory must return the plugin id')
    assertInjectNamesAreStrings(exports.inject, 'the client half')

    // Every specifier the factory asked for resolved, or the call above threw.
    // Recording them makes a future failure name the specifier directly.
    assert.ok(requested.length > 0, 'the factory is expected to require react')
  } finally {
    if (saved.window === undefined) delete globals.window
    else globals.window = saved.window
    if (saved.document === undefined) delete globals.document
    else globals.document = saved.document
  }
})

test('every declared client inject name resolves to a real client row', { skip: checkout === null }, () => {
  const declared = manifest.dsh?.client?.inject ?? []
  assert.ok(declared.length > 0, 'the plugin is expected to declare its client dependencies')

  // Index every client package DSH ships, by name.
  const packages = new Map()
  const clientDir = join(checkout, 'packages', 'client')
  if (!existsSync(clientDir)) return
  for (const entry of readdirSync(clientDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(clientDir, entry.name, 'package.json')
    if (!existsSync(file)) continue
    const candidate = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof candidate.name === 'string') packages.set(candidate.name, candidate)
  }

  const unresolved = []
  for (const name of declared) {
    const found = packages.get(name)
    // A name that is not a package in the checkout cannot be a row either.
    if (found === undefined) {
      unresolved.push(`${name} (no such package in the DSH checkout)`)
      continue
    }
    // A package without a `dsh.client` declaration never becomes a client row,
    // so the loader skips it: the plugin would be claiming a dependency it does
    // not have, and nothing would ever report it.
    if (found.dsh?.client == null || found.dsh.client.platform !== 'web') {
      unresolved.push(`${name} (declares no web client row)`)
    }
  }
  assert.deepEqual(unresolved, [], 'declared client dependencies must resolve to real client rows')
})

test('the host half declares only services DSH actually provides', { skip: checkout === null }, async () => {
  const mod = await import(pathToFileURL(HOST_BUNDLE).href)
  const declared = mod.inject
  assert.ok(Array.isArray(declared))

  // Scoped entries are package names, not runtime services; only a bare word is
  // a service name, and those are what this check is about.
  const services = declared
    .map((entry) => (typeof entry === 'string' ? entry : Object.keys(entry)[0]))
    .filter((name) => typeof name === 'string' && !name.startsWith('@'))

  const hostPackages = join(checkout, 'packages')
  const names = new Set()
  /** Collect every package name in the checkout, one group level deep. */
  const walk = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = join(dir, entry.name, 'package.json')
      if (existsSync(file)) {
        try {
          const candidate = JSON.parse(readFileSync(file, 'utf8'))
          if (typeof candidate.name === 'string') names.add(candidate.name)
        } catch { /* an unparseable manifest is not this check's business */ }
      }
      if (depth > 0) walk(join(dir, entry.name), depth - 1)
    }
  }
  walk(hostPackages, 1)

  // The two services this plugin injects are provided by first-party packages.
  // The check is that each name is one DSH knows about, so a typo or a rename
  // upstream is caught here rather than as a plugin that never activates.
  for (const service of services) {
    assert.ok(
      ['tools', 'webServer'].includes(service) || names.has(service),
      `inject declares service "${service}", which no DSH package provides`,
    )
  }
})

test('every privileged extension API used is declared in the manifest', { skip: !built }, () => {
  // Chrome refuses a call whose permission is undeclared by throwing. The throw
  // happens at run time, in a service worker nobody is watching, so the symptom
  // is a button that does nothing rather than an error anyone sees — which is
  // exactly how `sidePanel.open` shipped without the `sidePanel` permission.
  //
  // The map is deliberately explicit rather than derived: there is no reliable
  // way to extract API usage from a bundle, and a hand-written table that fails
  // loudly when a new API appears is worth more than a clever check that
  // silently covers less than it appears to.
  const REQUIRED_PERMISSION = [
    { pattern: /\bchrome\.sidePanel\b/, permission: 'sidePanel' },
    { pattern: /\bchrome\.scripting\b/, permission: 'scripting' },
    { pattern: /\bchrome\.alarms\b/, permission: 'alarms' },
    { pattern: /\bchrome\.webNavigation\b/, permission: 'webNavigation' },
  ]

  // Only the worker can call a privileged API expecting a permission; the
  // content script runs with the page's own privileges and the panel is an
  // ordinary extension page.
  const worker = readFileSync(join(packageRoot, 'extension', 'background.js'), 'utf8')
  // The extension's manifest, not the npm one: the two are different documents
  // and only this one carries `permissions`.
  const extensionManifest = JSON.parse(
    readFileSync(join(packageRoot, 'extension', 'manifest.json'), 'utf8'),
  )
  const declared = new Set(extensionManifest.permissions ?? [])

  const missing = REQUIRED_PERMISSION
    .filter(({ pattern }) => pattern.test(worker))
    .filter(({ permission }) => !declared.has(permission))
    .map(({ permission }) => permission)

  assert.deepEqual(
    missing,
    [],
    `the worker calls APIs whose permissions the manifest does not declare: ${missing.join(', ')}. `
    + 'Chrome throws at the call site, so the symptom is a silent no-op.',
  )
})
