/**
 * Preflight: check our registrations against the harness's real validation.
 *
 * Standing up the whole sidebar-right dependency graph is not practical here, so
 * this goes after the parts that can actually be wrong in a way a restart would
 * punish: the argument shapes our `apply` passes to `slots.register`, and the
 * `inject` names we declare.
 */
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const require = createRequire(import.meta.url)
const harness = 'E:/StudyFile/AI-Workspace/deepseek-harness'
const asUrl = (path) => pathToFileURL(path).href

// --- 1. our apply() must only call slots the harness actually declares --------
const slotDecl = readFileSync(`${harness}/packages/client/ui-slots/lib/types/index.d.ts`, 'utf8')
const declared = new Set()
// SlotMap keys are declared across packages; collect from every client package.
const { readdirSync, statSync } = await import('node:fs')
const { join } = await import('node:path')
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}
const dtsFiles = walk(`${harness}/packages/client`).filter((f) => f.includes('lib\\types') || f.includes('lib/types'))
for (const file of dtsFiles) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/^\s*'([a-z][a-z0-9.\-]*(?:\.[a-z0-9\-]+)+)':\s*\{/gim)) {
    declared.add(match[1])
  }
}
console.log('declared slot keys discovered:', declared.size)

const clientSrc = readFileSync('client.js', 'utf8')
const usedSlots = [...clientSrc.matchAll(/contribute\(\s*'([^']+)'/g)].map((m) => m[1])
console.log('slots this plugin contributes to:', usedSlots.join(', '))

let bad = 0
for (const key of usedSlots) {
  const ok = declared.has(key)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${key}${ok ? '' : ' is not a declared slot'}`)
  if (!ok) bad += 1
}

// --- 2. the registration object shape -----------------------------------------
// `slots.register(def, component)` needs name/id/label; the sidebar tab seat is
// keyed, so it also needs the entry key.
const registerCalls = [...clientSrc.matchAll(/slots\.register\(([^)]*)\)/g)].map((m) => m[1])
console.log('\nregister() call sites:', registerCalls.length)
for (const call of registerCalls) {
  for (const field of ['name', 'id', 'label']) {
    if (!call.includes(field)) {
      console.log(`  WARN a register() call omits ${field}: ${call.trim()}`)
    }
  }
}
console.log('  (fields are merged from the contribute() helper; checked below)')

const helper = /const contribute = \(key, id, component, label, extra\) => \{[\s\S]*?\n      \}/.exec(clientSrc)
if (!helper) {
  console.log('  FAIL could not find the contribute helper')
  bad += 1
} else {
  const body = helper[0]
  const ok = ['name', 'id', 'label', 'order'].every((field) => body.includes(field))
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} the contribute helper sets name/id/label/order`)
  if (!ok) bad += 1
}

// --- 3. the keyed tab seat must be registered under the definition's own id ----
const tabIdMatch = /const TAB_ID = '([^']+)'/.exec(clientSrc)
const tabId = tabIdMatch && tabIdMatch[1]
console.log('\nTAB_ID:', tabId)
const registersUnderOwnId = new RegExp(`contribute\\('sidebar\\.right\\.pane\\.tab',\\s*TAB_ID`).test(clientSrc)
console.log(`  ${registersUnderOwnId ? 'ok  ' : 'FAIL'} the pane seat is registered under TAB_ID (the definition id)`)
if (!registersUnderOwnId) bad += 1
const definitionIdMatches = new RegExp(`id:\\s*TAB_ID`).test(clientSrc)
console.log(`  ${definitionIdMatches ? 'ok  ' : 'FAIL'} the tab definition reuses the same id`)
if (!definitionIdMatches) bad += 1

// --- 4. inject names must match what other working plugins declare -------------
console.log('\n--- inject names ---')
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
for (const name of pkg.dsh.client.inject) {
  console.log(`  ${name}`)
}
// Cross-check against a sibling plugin that is known to activate. The reference
// lives outside this package, so it is absent when the plugin is checked out on
// its own — that is not a failure, just a comparison we cannot make here.
const purgePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../dsh-purge/package.json')
if (existsSync(purgePath)) {
  const purgePkg = JSON.parse(readFileSync(purgePath, 'utf8'))
  const purgeInject = new Set(purgePkg.dsh.client.inject)
  console.log('compared against a known-working plugin (dsh-purge):')
  for (const name of pkg.dsh.client.inject) {
    console.log(`  ${purgeInject.has(name) ? 'ok  ' : 'new '} ${name}`)
  }
} else {
  console.log('(no sibling dsh-purge checkout — skipped the cross-check)')
}

console.log(bad ? `\nPREFLIGHT FAILED (${bad} problem(s))` : '\nPREFLIGHT (registration shapes) PASSED')
process.exit(bad ? 1 : 0)
