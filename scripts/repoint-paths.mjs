/**
 * Repair relative paths after repointing.
 *
 * The repoint pass had to guess whether a literal referred to the plugin root or
 * to a file under it, and it guessed wrong for the ones that had already been
 * written with `../`. This fixes the two shapes it broke, so a test either resolves
 * to `<plugin>/<rest>` or `<plugin>` itself and nothing resolves into `scripts/`.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** Each entry is a broken form and the form it should have been. */
const FIXES = [
  // `new URL('../lib/index.js', import.meta.url)` -> `../lib/index.js`
  [/new URL\('lib\//g, "new URL('../lib/"],
  [/new URL\('client\.js'/g, "new URL('../client.js'"],
  [/new URL\('package\.json'/g, "new URL('../package.json'"],
  // A bare `..` is correct for the plugin root; leave it alone.
]

/** Import `fileURLToPath` wherever a `fileURLToPath(` call exists without it. */
function ensureImport(source) {
  if (!/\bfileURLToPath\(/.test(source)) return source
  if (/import\s*\{[^}]*\bfileURLToPath\b[^}]*\}\s*from\s*'node:url'/.test(source)) return source
  if (/from 'node:url'/.test(source)) {
    return source.replace(/import\s*\{([^}]*)\}\s*from\s*'node:url'/, (whole, names) => {
      const trimmed = names.trim().replace(/,\s*$/, '')
      return `import { ${trimmed}, fileURLToPath } from 'node:url'`
    })
  }
  const lines = source.split('\n')
  let last = -1
  for (let i = 0; i < lines.length; i += 1) if (/^import /.test(lines[i])) last = i
  if (last === -1) return `import { fileURLToPath } from 'node:url'\n${source}`
  lines.splice(last + 1, 0, "import { fileURLToPath } from 'node:url'")
  return lines.join('\n')
}

let changed = 0
for (const file of readdirSync(HERE)) {
  if (!file.endsWith('.mjs')) continue
  const path = `${HERE}${file}`
  const before = readFileSync(path, 'utf8')
  let after = before
  for (const [pattern, to] of FIXES) after = after.replace(pattern, to)
  after = ensureImport(after)
  if (after === before) continue
  writeFileSync(path, after)
  changed += 1
  console.log(`fixed ${file}`)
}
console.log(`${changed} file(s) changed`)
