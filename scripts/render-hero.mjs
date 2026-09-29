/**
 * Render every assets/*.svg to a matching .png.
 *
 * GitHub renders SVG in a README, but PNG is more predictable across clients and lets
 * the image be sized consistently. This reuses the `sharp` that the harness already
 * depends on rather than adding a toolchain.
 *
 * Rendering ALL of them rather than just the hero matters for the screenshots: the
 * README points at `shot-*.png`, and a placeholder that only exists as SVG would show
 * up as a broken image. Running this keeps the PNGs present until real screenshots
 * replace them.
 *
 * Usage: node scripts/render-hero.mjs [name ...]   (default: every .svg in assets/)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, basename } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const assets = resolve(here, '../assets')

const wanted = process.argv.slice(2)
const svgs = readdirSync(assets)
  .filter((one) => one.endsWith('.svg'))
  .filter((one) => wanted.length === 0 || wanted.includes(basename(one, '.svg')))

if (svgs.length === 0) {
  console.log('no svg to render')
  process.exit(wanted.length === 0 ? 0 : 1)
}

// `sharp` lives in the harness checkout, not in this plugin. It is a pnpm
// dependency, so it sits in the virtual store rather than at the root; resolve
// the store entry directly rather than assuming a hoisted layout.
const require = createRequire('E:/StudyFile/AI-Workspace/deepseek-harness/package.json')
const store = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm'
const entry = readdirSync(store).find((one) => one.startsWith('sharp@'))
if (!entry) {
  console.log('sharp is not present in the harness store; skipping the render')
  console.log('the .svg files are still valid and can be committed as-is')
  process.exit(0)
}
const sharp = require(`${store}/${entry}/node_modules/sharp`)

let failed = 0
for (const name of svgs) {
  const svgPath = resolve(assets, name)
  const pngPath = resolve(assets, name.replace(/\.svg$/, '.png'))
  if (!existsSync(svgPath)) {
    console.log(`  skipped ${name} (missing)`)
    failed += 1
    continue
  }
  const info = await sharp(readFileSync(svgPath), { density: 144 })
    .resize(1600, null, { fit: 'inside' })
    .png({ compressionLevel: 9, palette: true })
    .toBuffer({ resolveWithObject: true })
  writeFileSync(pngPath, info.data)
  console.log(`  ${name} -> ${basename(pngPath)}  ${info.info.width}x${info.info.height}, ${(info.info.size / 1024).toFixed(1)} KB`)
}

console.log(failed === 0 ? `\nrendered ${svgs.length} asset(s)` : `\n${failed} asset(s) missing`)
process.exit(failed === 0 ? 0 : 1)
