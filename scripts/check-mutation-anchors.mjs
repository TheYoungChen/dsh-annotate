/**
 * Every mutation carries a literal `from` anchor into a source file, and the harness
 * only notices a stale one at the moment that case runs. That makes an edited source
 * file a landmine: the mutation silently stops applying, the mutated tree is
 * therefore IDENTICAL to the good one, the check "passes", and the case is reported
 * as undetected — or worse, the run aborts at whatever case got there first.
 *
 * So check them all up front, in one pass, before anything else runs.
 */
import { readFileSync } from 'node:fs'

// `import.meta.url` is this FILE, so `..` has to keep the trailing slash to mean
// the parent directory rather than the parent path with its last segment dropped.
const scripts = new URL('./', import.meta.url)
const dir = new URL('../', scripts)
const src = readFileSync(new URL('mutate.mjs', scripts), 'utf8')
const block = src.slice(src.indexOf('const MUTATIONS = {'), src.indexOf('\nconst mutation = MUTATIONS'))

const names = [...block.matchAll(/^  '([A-Za-z0-9-]+)': \{/gm)].map((m) => m[1])
const files = {}
for (const f of ['client.js', 'lib/index.js', 'lib/overlay.js']) files[f] = readFileSync(new URL(f, dir), 'utf8')

// Let the engine decode the anchors instead of re-implementing JS string escaping.
// The block is a plain `const MUTATIONS = { … }`, so evaluating it and handing back
// the object gets the exact same values the harness will use — including `\n` and
// the single-quote escapes, which a hand-written decoder gets subtly wrong.
const MUTATIONS = new Function(`${block}\nreturn MUTATIONS`)()

let stale = 0
let checked = 0
for (const name of names) {
  const mutation = MUTATIONS[name]
  const file = mutation?.file
  const needle = mutation?.from
  if (typeof file !== 'string' || typeof needle !== 'string') {
    console.log(`  skip   ${name} (no literal "from")`)
    continue
  }
  const target = files[file]
  if (target === undefined) {
    console.log(`  STALE  ${name} -> ${file} (no such file)`)
    stale += 1
    continue
  }
  checked += 1
  if (!target.includes(needle)) {
    console.log(`  STALE  ${name} -> ${file}`)
    stale += 1
  }
}

console.log(`\n${checked} literal mutation anchor(s) checked, ${stale} stale`)
process.exit(stale === 0 ? 0 : 1)
