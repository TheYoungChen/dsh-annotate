#!/usr/bin/env node
/**
 * Generate the extension's icon set.
 *
 * ## Why this is hand-written
 *
 * The icons are the only binary assets the extension ships, and they are four
 * sizes of one simple mark. Writing them here keeps the repository free of a
 * checked-in binary that nobody can review, and free of an image toolchain that
 * a contributor would have to install before they could build. PNG is a small
 * enough format to emit directly — a header, one zlib stream of filtered
 * scanlines, and a terminator — and `node:zlib` supplies the only hard part.
 *
 * ## The mark
 *
 * A rounded square in the plugin's own blue, with a white crosshair square
 * inside it: the same shape the on-page highlight draws around a picked
 * element. It reads at 16px because it is two nested shapes and nothing else —
 * no text, no detail that turns to mush when scaled down.
 *
 * @module
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const assetsDir = join(here, '..', 'extension', 'assets')

/** Sizes Chromium asks for: toolbar, menu, and store/管理页. */
const SIZES = [16, 32, 48, 128]

/** The plugin's accent, matching the overlay highlight. */
const ACCENT = [37, 99, 235]

/** The mark drawn inside it. */
const MARK = [255, 255, 255]

/**
 * One RGBA pixel of the icon, on a 0..1 coordinate grid.
 *
 * Rendering in normalized coordinates means every size is the same picture
 * rather than four hand-tuned drawings, and the geometry stays readable as
 * arithmetic instead of per-size magic numbers.
 *
 * @param u - horizontal position of the pixel, 0 at the left edge.
 * @param v - vertical position of the pixel, 0 at the top edge.
 * @param size - the icon's edge length in pixels, which sets the sample step.
 * @returns the pixel's channel values.
 */
function sample(u, v, size) {
  // A supersample grid. Rounded corners and a thin stroke are the two places a
  // single sample per pixel would show stair-stepping, worst at 16px. Each
  // subsample sits at the centre of its own cell within the pixel, so the grid
  // covers the pixel rather than starting at its corner.
  const N = 4
  const step = 1 / size
  let inside = 0
  let mark = 0
  for (let sy = 0; sy < N; sy += 1) {
    for (let sx = 0; sx < N; sx += 1) {
      const x = u + ((sx + 0.5) / N) * step
      const y = v + ((sy + 0.5) / N) * step
      if (!inRoundedSquare(x, y, 0.06, 0.26)) continue
      inside += 1
      if (inMark(x, y)) mark += 1
    }
  }
  const total = N * N
  if (inside === 0) return [0, 0, 0, 0]

  // Coverage of the rounded square sets alpha; coverage of the mark blends the
  // two colours inside it. Both are fractions of the whole pixel, so a corner
  // ends up partially transparent rather than aliased against black.
  const alpha = inside / total
  const markRatio = mark / inside
  const color = [0, 1, 2].map((i) => Math.round(ACCENT[i] * (1 - markRatio) + MARK[i] * markRatio))
  return [color[0], color[1], color[2], Math.round(alpha * 255)]
}

/**
 * Whether a normalized point is inside the rounded square.
 *
 * @param x - horizontal position.
 * @param y - vertical position.
 * @param inset - margin from the icon edge.
 * @param radius - corner radius.
 * @returns whether the point is inside.
 */
function inRoundedSquare(x, y, inset, radius) {
  const lo = inset
  const hi = 1 - inset
  if (x < lo || x > hi || y < lo || y > hi) return false
  // Only the four corner quadrants can fall outside; the rest is a plain box.
  const cx = x < lo + radius ? lo + radius : x > hi - radius ? hi - radius : x
  const cy = y < lo + radius ? lo + radius : y > hi - radius ? hi - radius : y
  if (cx === x && cy === y) return true
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

/**
 * Whether a normalized point is on the mark.
 *
 * A hollow square outline — the same bracket the overlay draws around a picked
 * element. An outline rather than a filled shape because at 16px a solid mark
 * and the square behind it merge into one blob; the hole in the middle is what
 * keeps the two shapes distinguishable.
 *
 * @param x - horizontal position.
 * @param y - vertical position.
 * @returns whether the point is on the mark.
 */
function inMark(x, y) {
  const outer = 0.30 // half-extent of the bracket's outer edge
  const stroke = 0.075 // thickness of the drawn edge
  const inner = outer - stroke
  const dx = Math.abs(x - 0.5)
  const dy = Math.abs(y - 0.5)
  // Inside the outer box…
  if (dx > outer || dy > outer) return false
  // …and outside the inner one, which leaves only the border.
  return dx >= inner || dy >= inner
}

/**
 * Encode raw RGBA rows as a PNG.
 *
 * @param width - image width in pixels.
 * @param height - image height in pixels.
 * @param rgba - row-major RGBA bytes.
 * @returns the file's bytes.
 */
function encodePng(width, height, rgba) {
  // Each scanline is prefixed with its filter type. Filter 0 (None) is chosen
  // deliberately: the image is a handful of flat colours, so the per-scanline
  // predictors that help photographs would add a decoder dependency to save
  // maybe a hundred bytes.
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const chunk = (type, body) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length, 0)
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed), 0)
    return Buffer.concat([length, typed, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  // 10..12 are compression, filter, and interlace — all zero, all default.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** CRC-32 as PNG specifies it. */
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

mkdirSync(assetsDir, { recursive: true })
for (const size of SIZES) {
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = sample(x / size, y / size, size)
      const at = (y * size + x) * 4
      rgba[at] = r
      rgba[at + 1] = g
      rgba[at + 2] = b
      rgba[at + 3] = a
    }
  }
  const out = join(assetsDir, `icon${String(size)}.png`)
  writeFileSync(out, encodePng(size, size, rgba))
  console.log(`  wrote  extension/assets/icon${String(size)}.png (${String(size)}x${String(size)})`)
}
