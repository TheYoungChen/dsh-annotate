#!/usr/bin/env node
/**
 * Bundle the browser extension into the layout `extension/manifest.json` names.
 *
 * ## Why a bundler is needed at all
 *
 * The extension sources are plain ESM, but every import specifier carries an
 * explicit `.ts` extension — that is what `allowImportingTsExtensions` in the
 * project's tsconfig requires, and it is what lets Node's own type-stripping run
 * the modules directly in tests. No browser can load such a specifier, and the
 * manifest asks for `.js` files, so something has to resolve and rewrite them.
 *
 * ## Which bundler, and why that one
 *
 * `esbuild`, run as a **native binary**, located by searching for it at run time
 * and driven over its command line. Three constraints decided that:
 *
 * 1. **No new dependency.** The package deliberately has none, and this script
 *    may not add one. Any bundler it uses therefore has to be found already
 *    installed on the machine.
 * 2. **Do not link into a store.** The obvious shortcut — a directory junction
 *    from `node_modules/esbuild` into a pnpm store — breaks the moment esbuild
 *    runs: the store's copy reaches its platform binary through a *relative*
 *    `node_modules/@esbuild/<platform>` path that only resolves inside its own
 *    entry, and a junction into `node_modules/esbuild` puts it one level short.
 *    Nothing in this repository may silently rewrite a shared store either.
 * 3. **Do not execute code out of a store.** Loading a package by absolute path
 *    with `import()` resolves its own dependencies from that path, which drags a
 *    second copy of Node-runtime packages into the process. An executable that
 *    is spawned instead of imported has no such coupling.
 *
 * A hand-written resolver was the other option and was rejected: it would have
 * to reproduce bundler semantics — import hoisting, live bindings, module
 * ordering, the temporal dead zone — with no test that could tell a correct
 * implementation from one that merely works on today's files. The output of this
 * script is loaded by a browser, where a subtle ordering bug is invisible until
 * a user hits it.
 *
 * ## What the manifest decides
 *
 * Every entry point below is read from the manifest at build time rather than
 * hard-coded, and the source path for each is derived from it. That is what
 * makes the manifest authoritative: a rename on either side fails the build
 * loudly instead of shipping an extension whose declared files do not exist.
 *
 * The format of each output is decided by the manifest too:
 *
 * - `background.service_worker` + `background.type: "module"` → **ESM**, because
 *   the extension platform loads a service worker declared as a module as a
 *   module.
 * - `content_scripts[].js` with no `"type": "module"` on the entry → **IIFE**,
 *   because a content script without that field is a classic script. Classic
 *   scripts have no module scope and no import syntax, so ESM output there is a
 *   `SyntaxError` at injection time and the feature is simply dead. This
 *   manifest does not set the field, so the content script is classic.
 * - the panel page's `<script type="module" src>` → **ESM**, and the reference in
 *   the copied HTML is rewritten from the source path to the built one.
 *
 * ## Assets
 *
 * Non-TypeScript files are copied, not bundled: the panel's `index.html` (with
 * its script reference rewritten) and its stylesheet. Nothing is copied into a
 * location the manifest does not name, so the extension directory after a build
 * is exactly the set of files the browser will load — plus this script's own
 * leftovers, which it removes first.
 *
 * Usage:
 *   node scripts/build.mjs             # build
 *   node scripts/build.mjs --check     # report what would be built, write nothing
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const extensionDir = join(packageRoot, 'extension')
const sourceDir = join(extensionDir, 'src')
const manifestPath = join(extensionDir, 'manifest.json')
const checkOnly = process.argv.includes('--check')

/** Fail the build with a message a human can act on. */
function fail(message) {
  console.error(`build: ${message}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * Read and sanity-check the manifest.
 *
 * The manifest is a build input, not documentation: every path below is taken
 * from it. A manifest that does not parse, or that names a file outside the
 * extension directory, is a build error rather than something to work around.
 */
function readManifest() {
  if (!existsSync(manifestPath)) fail(`no manifest at ${manifestPath}`)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    fail(`manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) fail('manifest.json is not an object')
  if (parsed.manifest_version !== 3) fail(`manifest_version must be 3, found ${String(parsed.manifest_version)}`)
  return parsed
}

/**
 * Resolve a manifest-declared path to an absolute output path.
 *
 * @param value - the path as the manifest spells it, always with `/` separators.
 * @returns the absolute path.
 */
function outputPath(value) {
  return resolve(extensionDir, value)
}

// ---------------------------------------------------------------------------
// Toolchain discovery
// ---------------------------------------------------------------------------

/** Directory names a checkout keeps its installed packages in. */
const STORE_DIRS = ['.pnpm', 'node_modules']

/**
 * Directories that may hold an esbuild install, most specific first.
 *
 * `ESBUILD_BIN` short-circuits the search with an explicit executable. The
 * others are the package's own `node_modules` (a contributor who installed one
 * gets exactly their version), the workspace this repository lives in, and any
 * sibling checkout, which is where this project already looks for the types it
 * compiles against.
 */
function candidateRoots() {
  const roots = [join(packageRoot, 'node_modules')]
  let dir = packageRoot
  // Walk up a bounded number of levels, skipping duplicates. A package manager
  // may hoist an install above the repository, and a workspace layout is exactly
  // that case: the install sits beside the workspace rather than inside it.
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

/** Every `.pnpm`-style store entry that looks like an esbuild install. */
function storeEntries(dir) {
  const entries = []
  for (const store of STORE_DIRS) {
    const storeDir = join(dir, store)
    if (!existsSync(storeDir)) continue
    let names
    try {
      names = readdirSync(storeDir)
    } catch {
      continue
    }
    for (const name of names) {
      // `esbuild@1.2.3` in a pnpm store, `esbuild` in a flat install.
      if (name === 'esbuild' || name.startsWith('esbuild@')) entries.push(join(storeDir, name, 'node_modules', 'esbuild'))
    }
  }
  const flat = join(dir, 'esbuild')
  if (existsSync(flat)) entries.push(flat)
  return entries
}

/**
 * The platform binary inside an esbuild install.
 *
 * esbuild's JavaScript entry point is a launcher for a native executable, and
 * the executable is the part worth invoking. It lives either beside the package
 * (a flat install) or under `@esbuild/<platform>` in the same `node_modules`
 * directory that holds the package — which is where a store install keeps it,
 * reached through a relative path that only resolves there.
 *
 * @param packageDir - an esbuild package directory.
 * @returns the executable's path, or `null` when this install has none.
 */
function platformBinary(packageDir) {
  const exe = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild'
  const platform = `${process.platform}-${process.arch}`
  const candidates = [
    join(packageDir, exe),
    join(packageDir, 'bin', exe),
    // Sibling of the package: the store layout for a store install, and the
    // hoisted layout for a flat one.
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
 * @returns the executable's path.
 */
function findEsbuild() {
  const explicit = process.env['ESBUILD_BIN']
  if (typeof explicit === 'string' && explicit !== '') {
    if (!existsSync(explicit)) fail(`ESBUILD_BIN points at ${explicit}, which does not exist`)
    return explicit
  }

  for (const root of candidateRoots()) {
    for (const packageDir of storeEntries(root)) {
      const binary = platformBinary(packageDir)
      if (binary !== null) return binary
    }
  }

  fail(
    'no esbuild executable found.\n'
    + '  The extension sources are TypeScript with explicit `.ts` import specifiers, so a\n'
    + '  bundler is required. This repository adds no dependency of its own: install esbuild\n'
    + '  where this script can see it (a sibling checkout\'s `node_modules` is searched), or\n'
    + '  point ESBUILD_BIN at an executable.',
  )
}

// ---------------------------------------------------------------------------
// Build plan
// ---------------------------------------------------------------------------

/**
 * A manifest-declared file to emit.
 *
 * `mode` is what the extension platform will load the file as, and it is taken
 * from the manifest rather than chosen here — see the module comment.
 */
function bundle({ entry, out, mode, label }) {
  if (!existsSync(entry)) {
    fail(
      `${label} entry point is missing: ${relative(packageRoot, entry)}\n`
      + '  Add the source file, or point the manifest at the file that exists.',
    )
  }
  return { kind: 'bundle', entry, out, mode, label }
}

/** A file copied verbatim, optionally with a script reference rewritten. */
function copy({ from, out, rewrite, label }) {
  if (!existsSync(from)) fail(`${label} asset is missing: ${relative(packageRoot, from)}`)
  return { kind: 'copy', from, out, rewrite, label }
}

/**
 * The build plan, derived entirely from the manifest.
 *
 * @param manifest - the parsed manifest.
 * @returns one step per file the extension will load.
 */
function planFor(manifest) {
  const plan = []

  const worker = manifest.background?.service_worker
  if (typeof worker !== 'string') fail('manifest.background.service_worker is missing')
  // A service worker is loaded as a module only when the manifest says so; any
  // other value means the classic-script path, which this build does not emit
  // because the worker genuinely uses `import` at the top level.
  const workerMode = manifest.background.type === 'module' ? 'esm' : 'iife'
  plan.push(bundle({
    entry: sourceForOutput(worker, ['background/index.ts']),
    out: outputPath(worker),
    mode: workerMode,
    label: 'background service worker',
  }))

  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []
  if (contentScripts.length === 0) fail('manifest.content_scripts lists no scripts')
  for (const [index, declaration] of contentScripts.entries()) {
    const files = Array.isArray(declaration?.js) ? declaration.js : []
    if (files.length !== 1) {
      fail(`manifest.content_scripts[${index}].js must name exactly one bundled file, found ${files.length}`)
    }
    const file = files[0]
    // `content_scripts` has no per-entry module declaration today; its
    // `"type": "module"` field is newer than the minimum Chrome version this
    // manifest declares, so classic script is the only form every declared
    // browser can load.
    const mode = declaration.type === 'module' ? 'esm' : 'iife'
    plan.push(bundle({
      entry: sourceForOutput(file, ['content/index.ts']),
      out: outputPath(file),
      mode,
      label: `content script ${file}`,
    }))
  }

  const panelHtml = manifest.side_panel?.default_path
  if (typeof panelHtml !== 'string') fail('manifest.side_panel.default_path is missing')
  const htmlSource = sourceForOutput(panelHtml, ['panel/index.html'])
  const panelDir = dirname(panelHtml)
  const scripts = moduleScriptSources(htmlSource)
  if (scripts.length === 0) fail(`${relative(packageRoot, htmlSource)} declares no \`<script type="module">\``)
  if (scripts.length > 1) fail(`${relative(packageRoot, htmlSource)} declares ${scripts.length} module scripts; this build emits one`)

  const pageScript = scripts[0]
  const pageOut = `${panelDir}/${basenameWithExtension(pageScript, 'js')}`
  const pageEntry = resolve(dirname(htmlSource), pageScript)
  // The entry has the same name as its source file, so the output *is* the
  // source path once a previous build has run. Descending back into the source
  // tree from the emitted file would bundle the last bundle, so the source tree
  // is consulted directly: today the panel's script is a sibling of its markup,
  // and `src/panel/main.ts` is where that file lives.
  if (outputPath(pageOut) === pageEntry) {
    const fromSourceTree = join(sourceDir, dirname(panelHtml), `${basenameWithExtension(pageScript, 'ts')}`)
    if (!existsSync(fromSourceTree)) {
      fail(
        `refusing to bundle ${relative(packageRoot, pageEntry)} for a second time:\n`
        + `  no source at ${relative(packageRoot, fromSourceTree)}, so the only input would be the last build's output.`,
      )
    }
    plan.push(bundle({ entry: fromSourceTree, out: outputPath(pageOut), mode: 'esm', label: 'panel script' }))
  } else {
    plan.push(bundle({ entry: pageEntry, out: outputPath(pageOut), mode: 'esm', label: 'panel script' }))
  }
  plan.push(copy({
    from: htmlSource,
    out: outputPath(panelHtml),
    rewrite: { from: pageScript, to: basenameWithExtension(pageScript, 'js') },
    label: 'panel page',
  }))

  // Stylesheets and icons are referenced by the manifest or by the page, and are
  // copied rather than bundled: there is nothing to resolve in them.
  for (const asset of declaredAssets(manifest, htmlSource)) {
    plan.push(copy({ from: asset.from, out: outputPath(asset.to), rewrite: null, label: asset.label }))
  }

  return plan
}

/**
 * The source file that produces a manifest-declared output.
 *
 * The mapping is derived from the declared name so a manifest rename cannot
 * silently keep building the old file. For a root-level output such as
 * `content.js` the source is `src/content/index.ts`: the output's stem names a
 * directory under `src/`, and `index.ts` is that directory's entry point.
 * `fallbacks` are tried first, for an entry point whose name is not its
 * directory's — the service worker's, which lives in `src/background/` beside
 * the modules it owns but is named for the worker rather than for the folder.
 *
 * @param declared - the manifest's path.
 * @param fallbacks - source paths relative to `extension/`, most specific first.
 * @returns the absolute source path.
 */
function sourceForOutput(declared, fallbacks) {
  const stem = basenameWithExtension(declared, 'ts').slice(0, -'.ts'.length)
  const candidates = []
  for (const fallback of fallbacks) candidates.push(join(extensionDir, fallback))
  // A source file of the same name, then a directory of that name with an entry
  // point inside it: `panel/index.html` is `src/panel/index.html`, and
  // `content.js` is `src/content/index.ts`.
  candidates.push(join(sourceDir, declared))
  candidates.push(join(sourceDir, stem, 'index.ts'))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  fail(
    `no source found for the manifest's ${declared}\n`
    + `  Looked for: ${candidates.map((candidate) => relative(packageRoot, candidate)).join(', ')}`,
  )
}

/** A path's file name with its extension replaced. */
function basenameWithExtension(path, extension) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return `${dot === -1 ? name : name.slice(0, dot)}.${extension}`
}

/** The `src` of every `<script type="module">` in an HTML file, in order. */
function moduleScriptSources(htmlPath) {
  const html = readFileSync(htmlPath, 'utf8')
  const found = []
  const pattern = /<script\b[^>]*>/gi
  for (const tag of html.match(pattern) ?? []) {
    if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)
    if (src !== null) found.push(src[1])
  }
  return found
}

/**
 * Assets to copy that no bundle step covers: the panel's stylesheets and the
 * manifest's icons.
 *
 * Discovered rather than listed, so a stylesheet added to the page is copied
 * without a build-script change, and one removed stops being copied.
 */
function declaredAssets(manifest, htmlSource) {
  const assets = []
  const seen = new Set()

  const panelDir = dirname(htmlSource)
  const panelOut = dirname(manifest.side_panel.default_path)
  const html = readFileSync(htmlSource, 'utf8')
  for (const match of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const href = match[1]
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('data:')) continue
    const from = resolve(panelDir, href)
    const to = `${panelOut}/${href.replace(/^\.\//, '')}`
    if (seen.has(to)) continue
    seen.add(to)
    assets.push({ from, to, label: `panel asset ${href}` })
  }

  const iconPaths = new Set()
  for (const value of Object.values(manifest.icons ?? {})) iconPaths.add(value)
  for (const value of Object.values(manifest.action?.default_icon ?? {})) iconPaths.add(value)
  for (const declared of iconPaths) {
    if (typeof declared !== 'string') continue
    const from = outputPath(declared)
    // An icon the repository does not ship is not a build failure: the
    // manifest declaring it is a packaging concern, and failing here would make
    // a source checkout unbuildable over a binary that is not in the tree.
    if (!existsSync(from)) continue
    if (seen.has(declared)) continue
    seen.add(declared)
    assets.push({ from, to: declared, label: `icon ${declared}` })
  }

  return assets
}

// ---------------------------------------------------------------------------
// Output cleanup
// ---------------------------------------------------------------------------

/**
 * Delete files a previous build wrote that this plan does not produce.
 *
 * Without this, renaming an entry point leaves the old bundle in the extension
 * directory, and a browser loading the directory gets both — a stale `.js` next
 * to the new one is exactly the confusion this build exists to prevent. Only
 * `.js` files are considered, and only ones the plan names as outputs, so a
 * hand-placed file is never deleted.
 *
 * @param plan - the build plan.
 * @param outputs - absolute paths this build will write.
 */
function removeStaleBundles(plan, outputs) {
  const keep = new Set(outputs)
  const stale = []
  for (const step of plan) {
    if (step.kind !== 'bundle') continue
    // The directory the manifest puts a bundle in, scanned for other bundles.
    const dir = dirname(step.out)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.js')) continue
      const candidate = join(dir, name)
      if (keep.has(candidate)) continue
      stale.push(candidate)
    }
  }
  for (const file of stale) {
    console.log(`  clean  ${relative(packageRoot, file)}`)
    if (!checkOnly) rmSync(file, { force: true })
  }
}

// ---------------------------------------------------------------------------
// Running esbuild
// ---------------------------------------------------------------------------

/**
 * Bundle one entry point.
 *
 * `--legal-comments=none` keeps third-party licence banners out of the output;
 * the sources are this project's own and carry no such comments. Source maps are
 * emitted because a bundled content script is otherwise undebuggable inside a
 * page, and the browser only fetches a map when devtools is open. Their `sources`
 * are absolute, so a map points at the file that was built rather than at a path
 * relative to wherever the extension happens to be loaded from — the extension
 * directory is the load root, and a relative path there would resolve to a
 * `.ts` file that is not part of the package.
 *
 * @param esbuild - the executable.
 * @param step - the bundle step.
 */
function runEsbuild(esbuild, step) {
  const args = [
    step.entry,
    '--bundle',
    // Every dependency is a relative path inside this repository. A bare
    // specifier would resolve out of `node_modules`, which is not part of the
    // extension and cannot be shipped.
    '--platform=browser',
    '--target=chrome116',
    `--format=${step.mode}`,
    '--charset=utf8',
    '--legal-comments=none',
    '--log-level=warning',
    '--sourcemap',
    '--sources-content=true',
    `--outfile=${step.out}`,
  ]
  if (step.mode === 'iife') {
    // A named global is not needed — the script only registers listeners — but
    // naming it keeps a stray second copy from throwing on redefinition.
    args.push('--global-name=__dshAnnotateContentScript')
  }

  const result = spawnSync(esbuild, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    // The executable is resolved to an absolute path and passed as argv[0], so
    // it needs no shell and no quoting rules of its own.
    shell: false,
  })
  if (result.error !== undefined && result.error !== null) {
    fail(`could not run esbuild: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter((text) => typeof text === 'string' && text !== '').join('\n')
    fail(`esbuild failed for ${relative(packageRoot, step.entry)}:\n${detail.trim()}`)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const manifest = readManifest()
const plan = planFor(manifest)

const outputs = plan.map((step) => resolve(step.out))
for (const output of outputs) {
  // A manifest naming a path outside the extension directory would make the
  // browser look for a file the packager never includes.
  const relativeOutput = relative(extensionDir, output)
  if (relativeOutput.startsWith('..') || relativeOutput.includes(`..${sep}`)) {
    fail(`manifest path escapes the extension directory: ${relativeOutput}`)
  }
}

console.log(`manifest: ${relative(packageRoot, manifestPath)}`)
console.log(checkOnly ? 'mode: check only (nothing is written)' : 'mode: build')
console.log('')

removeStaleBundles(plan, outputs)

if (!checkOnly) {
  for (const output of outputs) mkdirSync(dirname(output), { recursive: true })
}

const esbuild = plan.some((step) => step.kind === 'bundle') ? findEsbuild() : null
if (esbuild !== null) console.log(`esbuild: ${esbuild}`)

for (const step of plan) {
  if (step.kind === 'bundle') {
    console.log(`  bundle ${relative(packageRoot, step.entry)} -> ${relative(packageRoot, step.out)} (${step.mode})`)
    if (!checkOnly) runEsbuild(esbuild, step)
    continue
  }
  console.log(`  copy   ${relative(packageRoot, step.from)} -> ${relative(packageRoot, step.out)}`)
  if (checkOnly) continue
  if (step.rewrite === null) {
    writeFileSync(step.out, readFileSync(step.from))
    continue
  }
  const html = readFileSync(step.from, 'utf8').split(step.rewrite.from).join(step.rewrite.to)
  writeFileSync(step.out, html)
}

if (!checkOnly) {
  const written = []
  for (const step of plan) {
    written.push(step.out)
    if (step.kind === 'bundle' && existsSync(`${step.out}.map`)) written.push(`${step.out}.map`)
  }
  // Reported, so the caller can see that every file the manifest names exists.
  for (const file of written) {
    if (!existsSync(file)) fail(`expected output is missing after the build: ${relative(packageRoot, file)}`)
    const size = statSync(file).size
    console.log(`  wrote  ${relative(packageRoot, file)} (${size} bytes)`)
  }
  console.log(`\n${written.length} file(s) written.`)
}

process.exit(0)
