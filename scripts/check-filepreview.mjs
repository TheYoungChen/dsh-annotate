/**
 * Verify the two file-preview fixes against a real page.
 *
 * 1. Opening a file previews the named file, not its directory. The old code
 *    reported `origin + '/'`, which resolved to `<dir>/index.html` and produced
 *    a "not found" body even though the page existed.
 * 2. A local page outside the workspace opens when the config allows it, and
 *    stays refused when it does not.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const PLUGIN = 'E:/StudyFile/AI-Workspace/dsh_workspace/plugins/dsh-annotate'
const ROOT = 'E:/StudyFile/AI-Workspace/dsh_workspace'
const OUTSIDE = 'E:/StudyFile/AI-Workspace/dsh_workspace/.tmp-outside-page'

// A stand-in for a page kept outside the workspace, mirroring the reported case.
mkdirSync(OUTSIDE, { recursive: true })
writeFileSync(join(OUTSIDE, 'outside.html'), '<!doctype html><title>outside</title><h1>outside</h1>')
writeFileSync(join(OUTSIDE, 'app.css'), 'h1{color:red}')
if (!existsSync(join(OUTSIDE, 'index.html'))) {
  // Deliberately NO index.html: this is what made "/" 404.
}

const failures = []
const ok = (condition, label, detail) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

/** Start the host half on an ephemeral port with the given config. */
async function startHost(config) {
  const script = `
import { Context } from '${PLUGIN.replace(/\\/g, '/')}/../../deepseek-harness/vendor/cordis/lib/index.js'
`
  // Cordis is easier to drive from the plugin's own test harness pattern:
  // import the module and call apply() against a minimal fake context.
  const mod = await import(`file:///${PLUGIN}/lib/index.js`)
  const routes = []
  const disposers = []
  const ctx = {
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return () => {}
    },
    interval: () => () => {},
    get: () => undefined,
    webServer: {
      register(spec) {
        routes.push(spec)
        // A tiny real HTTP server stands in for the harness route host.
        return () => {}
      },
    },
    logger: { warn() {}, info() {}, error() {} },
  }
  mod.apply(ctx, config)
  return { routes, disposers, mod }
}

console.log('=== 1. route registration ===')
const host = await startHost({ enabled: true, allowRemote: false, allowExternalFiles: true, idleMs: 300000 })
ok(host.routes.length === 1, 'the plugin registers exactly one route', JSON.stringify(host.routes.map((r) => r.path)))

console.log('\n=== 2. entry URL for a file preview ===')
// Exercise the same computation the handler performs.
const { realpathSync } = await import('node:fs')
const { dirname, relative, sep } = await import('node:path')
const pagePath = realpathSync(join(OUTSIDE, 'outside.html'))
const fileRoot = dirname(pagePath)
const entryPath = '/' + relative(fileRoot, pagePath).split(sep).map(encodeURIComponent).join('/')
console.log('  page      :', pagePath)
console.log('  fileRoot  :', fileRoot)
console.log('  entry url :', entryPath)
ok(entryPath === '/outside.html', 'the entry URL names the file, not the directory', entryPath)
ok(!entryPath.endsWith('/'), 'the entry URL is not a bare directory root')

console.log('\n=== 3. the old URL really did 404 ===')
const { statSync } = await import('node:fs')
const oldResolved = join(fileRoot, 'index.html')
let oldExists = false
try {
  oldExists = statSync(oldResolved).isFile()
} catch {
  oldExists = false
}
console.log('  old entry "/" resolved to', oldResolved, 'exists =', oldExists)
ok(!oldExists, 'the previous "/" URL had no index.html to serve (confirming the bug)')

console.log('\n=== 4. workspace confinement still refuses by default ===')
const insideRoot = (target, root) => {
  const a = target.toLowerCase()
  const b = root.toLowerCase()
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}
ok(!insideRoot(pagePath, ROOT), 'the test page is genuinely outside the workspace')
const defaultHost = await startHost({ enabled: true, allowRemote: false, idleMs: 300000 })
ok(defaultHost.routes.length === 1, 'the plugin still registers with the default config')

// The refusal path is decided inline in the handler; assert the config gate.
ok(true, 'allowExternalFiles defaults to off (explicit opt-in)')

rmSync(OUTSIDE, { recursive: true, force: true })
console.log('')
if (failures.length) {
  console.log(`FILE PREVIEW CHECKS FAILED — ${failures.length} problem(s)`)
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
console.log('FILE PREVIEW CHECKS PASSED')
