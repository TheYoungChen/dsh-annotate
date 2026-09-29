/**
 * Report the frame layout of an animated GIF.
 *
 * Written because the recorder produced a 30 MB file for a ten-second clip and it
 * was not obvious why: the header claims one thing and the frames another, and no
 * image tool was available to ask. Reading the blocks directly answers it.
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const buf = readFileSync(file)
console.log(`${file}  ${(buf.length / 1024 / 1024).toFixed(1)} MB`)

let p = 0
const sig = buf.toString('ascii', 0, 6)
const width = buf.readUInt16LE(6)
const height = buf.readUInt16LE(8)
const packed = buf[10]
const hasGct = (packed & 0x80) !== 0
const gctSize = 3 * 2 ** ((packed & 0x07) + 1)
console.log(`  signature ${sig}, logical screen ${width}x${height}, global colour table: ${hasGct} (${gctSize} bytes)`)
p = 13 + (hasGct ? gctSize : 0)

let frames = 0
let totalFrameBytes = 0
let minX = Infinity
let minY = Infinity
let maxW = 0
let maxH = 0
let disposal = new Set()
let delayMin = Infinity
let delayMax = 0
let sawLocalTable = 0

const skipSubBlocks = () => {
  while (p < buf.length) {
    const n = buf[p]
    p += 1
    if (n === 0) break
    p += n
  }
}

while (p < buf.length) {
  const block = buf[p]
  if (block === 0x3b) { p += 1; break } // trailer
  if (block === 0x21) { // extension
    const label = buf[p + 1]
    if (label === 0xf9) {
      const size = buf[p + 2]
      const flags = buf[p + 3]
      disposal.add((flags >> 2) & 0x07)
      const delay = buf.readUInt16LE(p + 4)
      delayMin = Math.min(delayMin, delay)
      delayMax = Math.max(delayMax, delay)
      p += 3 + size
      skipSubBlocks()
    } else {
      p += 2
      skipSubBlocks()
    }
    continue
  }
  if (block === 0x2c) { // image descriptor
    const x = buf.readUInt16LE(p + 1)
    const y = buf.readUInt16LE(p + 3)
    const w = buf.readUInt16LE(p + 5)
    const h = buf.readUInt16LE(p + 7)
    const lflags = buf[p + 9]
    const hasLct = (lflags & 0x80) !== 0
    if (hasLct) sawLocalTable += 1
    const lctSize = hasLct ? 3 * 2 ** ((lflags & 0x07) + 1) : 0
    const dataStart = p + 10 + lctSize
    p = dataStart
    // LZW minimum code size, then sub-blocks.
    p += 1
    let bytes = 0
    while (p < buf.length) {
      const n = buf[p]
      p += 1
      if (n === 0) break
      bytes += n
      p += n
    }
    frames += 1
    totalFrameBytes += bytes + 10 + lctSize
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxW = Math.max(maxW, w)
    maxH = Math.max(maxH, h)
    continue
  }
  break
}

console.log(`  frames: ${frames}`)
console.log(`  frame rect: min (${minX}, ${minY}), max ${maxW}x${maxH}`)
console.log(`  full-canvas frames: ${maxW >= width && maxH >= height ? 'yes — every frame is the whole screen' : 'no'}`)
console.log(`  local colour tables: ${sawLocalTable}`)
console.log(`  disposal methods: ${[...disposal].join(', ')}`)
console.log(`  delay: ${delayMin}..${delayMax} hundredths of a second`)
console.log(`  pixel data: ${(totalFrameBytes / 1024 / 1024).toFixed(1)} MB of ${(buf.length / 1024 / 1024).toFixed(1)} MB`)
console.log(`  average per frame: ${(totalFrameBytes / frames / 1024).toFixed(0)} KB`)
