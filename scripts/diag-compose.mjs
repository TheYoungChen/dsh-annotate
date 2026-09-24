/**
 * Reproduce DSH's own profile composition for the web profile.
 *
 * This calls the harness's real `loadProfileDirectory` + `composeEntries`, so the
 * answer is what the running server would have computed — not a re-implementation
 * of it. The point is to see whether this plugin's row actually survives
 * composition, and under which id and module specifier.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire('E:/StudyFile/AI-Workspace/deepseek-harness/package.json')
const harness = 'E:/StudyFile/AI-Workspace/deepseek-harness'
const asUrl = (p) => pathToFileURL(p).href

const profileMod = await import(asUrl(`${harness}/packages/boot/app-boot/lib/profile.js`)).catch(async () => {
  return import(asUrl(`${harness}/packages/boot/app-boot/src/profile.ts`))
})
console.log('profile module exports:', Object.keys(profileMod).filter((k) => /load|compose|resolve/i.test(k)).join(', '))

const PROFILE_DIR = 'C:/Users/a3025/.dsh/profiles/web'
// The install anchor is the dsh app package's own package.json.
const installAnchor = `${harness}/package.json`

let profile
try {
  profile = profileMod.loadProfileDirectory('dsh', PROFILE_DIR, installAnchor)
} catch (error) {
  console.log('\nloadProfileDirectory threw:', error.message)
  process.exit(1)
}

console.log('\n=== bundle layers DSH resolved ===')
for (const layer of profile.layers) {
  const hasInsert = layer.patches.some((p) => p && p.insert)
  console.log(`  - ${layer.packageName}`)
  console.log(`      dir:   ${layer.packageDir}`)
  console.log(`      patch: ${layer.patchPath}  (${layer.patches.length} entries, insert: ${hasInsert})`)
}

console.log('\n=== user patch layer ===')
console.log(`  ${profile.patchPath}  (${profile.patches.length} entries)`)

// --- compose ------------------------------------------------------------------
// `composeEntries` takes the ordered patch layers, not the profile object.
const warn = []
let entries
try {
  entries = profileMod.composeEntries(
    [...profile.layers.map((layer) => layer.patches), ...(profile.patches.length ? [profile.patches] : [])],
    (message) => warn.push(message),
  )
} catch (error) {
  console.log('composeEntries threw:', error.message)
  process.exit(1)
}
if (warn.length) {
  console.log('\n=== composition warnings ===')
  for (const line of warn) console.log('  !', line)
}

console.log('\n=== composed entries mentioning annotate ===')
console.log('total composed entries:', entries.length)
const annotateRows = entries.filter((e) => /annotate/i.test(JSON.stringify(e)))
for (const row of annotateRows) {
  console.log('  ->', JSON.stringify(row))
}
console.log('\nannotate rows found:', annotateRows.length)
if (annotateRows.length === 0) {
  console.log('*** this plugin is NOT in the composed tree ***')
} else if (annotateRows.length > 1) {
  console.log('*** more than one annotate row — duplicate ids will throw ***')
}
