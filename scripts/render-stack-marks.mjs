/**
 * Render every stack mark to a PNG contact sheet, for eyeballing.
 *
 * Asserting that a path has enough drawing commands does not tell you it LOOKS like the
 * logo. That needs eyes, so this produces a sheet sized like the real list. Not part of
 * the suite; run it by hand when the marks change.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const client = readFileSync(`${root}client.js`, 'utf8')
const table = client.slice(client.indexOf('const STACK_MARKS = {'), client.indexOf('function StackMark'))

const marks = []
// Split on entry starts rather than matching a trailing `},`, because the last entry
// has no comma after it and a greedy match swallows the rest of the table.
const starts = [...table.matchAll(/^ {6}([a-z]+): \{/gm)]
for (let i = 0; i < starts.length; i += 1) {
  const id = starts[i][1]
  const body = table.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : table.length)
  const color = /color: '([^']+)'/.exec(body)?.[1]
  const stroke = /stroke: true/.test(body)
  const path = /path: '([^']+)'/.exec(body)?.[1]
  if (color && path) marks.push({ id, color, stroke, path })
}

const require = createRequire('E:/StudyFile/AI-Workspace/deepseek-harness/package.json')
const store = 'E:/StudyFile/AI-Workspace/deepseek-harness/node_modules/.pnpm'
const entry = readdirSync(store).find((one) => one.startsWith('sharp@'))
const sharp = require(`${store}/${entry}/node_modules/sharp`)

// Two sizes per cell: large so the shape can be judged, then exactly the 14px the list
// uses. The large one is scaled by a plain transform, so aspect ratio is preserved —
// setting width/height on the path instead would stretch a non-square path.
const cell = 190
const cols = 5
const rows = Math.ceil(marks.length / cols)
const W = cols * cell
const H = rows * cell + 60

const draw = (mark, size) => `
      <g transform="scale(${(size / 24).toFixed(4)})">
        <path d="${mark.path}" fill="${mark.stroke ? 'none' : mark.color}"
          ${mark.stroke ? `stroke="${mark.color}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"` : ''}/>
      </g>`

const cellSvg = (mark, x, y) => `
  <g transform="translate(${x},${y})">
    <rect width="${cell}" height="${cell}" fill="#1e222b"/>
    <g transform="translate(${(cell - 64) / 2},26)">${draw(mark, 64)}</g>
    <g transform="translate(${(cell - 14) / 2},${cell - 58})">${draw(mark, 14)}</g>
    <text x="${cell / 2}" y="${cell - 14}" fill="#8b93a7" font-size="13" text-anchor="middle"
      font-family="system-ui,sans-serif">${mark.id}</text>
  </g>`

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0f1115"/>
  <text x="16" y="26" fill="#e6ebf5" font-size="15" font-family="system-ui,sans-serif">
    stack marks — large, then at the real 14px list size
  </text>
  ${marks.map((mark, i) => cellSvg(mark, (i % cols) * cell, 42 + Math.floor(i / cols) * cell)).join('')}
</svg>`

const out = `${root}assets/.stack-marks-check.png`
const info = await sharp(Buffer.from(svg), { density: 144 }).png().toBuffer({ resolveWithObject: true })
writeFileSync(out, info.data)
console.log(`rendered ${marks.length} marks -> ${out}`)
console.log(`  ${info.info.width}x${info.info.height}`)
console.log(`  ids: ${marks.map((one) => one.id).join(', ')}`)
