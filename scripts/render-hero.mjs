/**
 * Render assets/hero.svg to assets/hero.png.
 *
 * GitHub renders SVG in a README, but PNG is more predictable across clients and
 * lets the image be sized consistently. This reuses the `sharp` that the harness
 * already depends on rather than adding a toolchain.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const svgPath = resolve(here, '../assets/hero.svg')
const pngPath = resolve(here, '../assets/hero.png')

if (!existsSync(svgPath)) {
  console.log('hero.svg is missing; nothing to render')
  process.exit(1)
}

// `sharp` lives in the harness checkout, not in this plugin. It is a pnpm
// dependency, so it sits in the virtual store rather than at the root; resolve
// the store entry directly rather than assuming a hoisted layout.
const require = createRequire('E:/StudyFile/AI-Workspace/deepseek-harness/package.json')
const store = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm'
const { readdirSync } = await import('node:fs')
const entry = readdirSync(store).find((one) => one.startsWith('sharp@'))
if (!entry) {
  console.log('sharp is not present in the harness store; skipping the render')
  console.log('hero.svg is still valid and can be committed as-is')
  process.exit(0)
}
const sharp = require(`${store}/${entry}/node_modules/sharp`)

const svg = readFileSync(svgPath)
const info = await sharp(svg, { density: 144 })
  .resize(1600, null, { fit: 'inside' })
  .png({ compressionLevel: 9, palette: true })
  .toBuffer({ resolveWithObject: true })

writeFileSync(pngPath, info.data)
console.log(`rendered ${svgPath}`)
console.log(`     -> ${pngPath}`)
console.log(`     ${info.info.width}x${info.info.height}, ${(info.info.size / 1024).toFixed(1)} KB`)
