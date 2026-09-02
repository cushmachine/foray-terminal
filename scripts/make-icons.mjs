// Generates the PWA icons in public/icons/ with nothing but node.
//
// There's no image library on the box (and none in the dependencies), so
// this rasterises the icon itself: a dark rounded square with the teal "›"
// that prefixes session names in the top bar, drawn as two round-capped
// strokes using a signed distance so the edges are anti-aliased. Output is
// written as uncompressed-filter PNG through zlib.
//
// Run with: npm run icons

import { deflateSync, crc32 } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const OUT_DIR = path.resolve('public/icons')

const BG = [0x0a, 0x0a, 0x0c]
const TEAL = [0x3d, 0xb8, 0xa9]

/**
 * @typedef {{ name: string, size: number, fullBleed: boolean, safeZone?: number }} Spec
 * `fullBleed` keeps the background square (maskable / Apple icons); otherwise
 * the corners are rounded and transparent. `safeZone` scales the glyph down
 * so a circular mask (Android maskable) keeps it whole.
 */
/** @type {Spec[]} */
const SPECS = [
  { name: 'icon-192.png', size: 192, fullBleed: false },
  { name: 'icon-512.png', size: 512, fullBleed: false },
  { name: 'maskable-512.png', size: 512, fullBleed: true, safeZone: 0.8 },
  { name: 'apple-touch-icon.png', size: 180, fullBleed: true },
]

/** Distance from point p to segment ab. */
function segmentDistance(px, py, ax, ay, bx, by) {
  const abx = bx - ax
  const aby = by - ay
  const apx = px - ax
  const apy = py - ay
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby)))
  const cx = ax + t * abx - px
  const cy = ay + t * aby - py
  return Math.sqrt(cx * cx + cy * cy)
}

/** Signed distance to a rounded square centred in a size x size canvas. */
function roundedSquareDistance(px, py, size, radius) {
  const half = size / 2
  const qx = Math.abs(px - half) - (half - radius)
  const qy = Math.abs(py - half) - (half - radius)
  const outside = Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2)
  const inside = Math.min(Math.max(qx, qy), 0)
  return outside + inside - radius
}

/** 0..1 coverage from a signed distance (negative = inside), ~1px feather. */
function coverage(distance) {
  return Math.max(0, Math.min(1, 0.5 - distance))
}

function render({ size, fullBleed, safeZone = 1 }) {
  const rgba = new Uint8Array(size * size * 4)
  const radius = size * 0.22
  // Chevron geometry as fractions of the canvas, scaled about the centre.
  const s = safeZone
  const c = size / 2
  const pt = (fx, fy) => [c + (fx - 0.5) * size * s, c + (fy - 0.5) * size * s]
  const [ax, ay] = pt(0.38, 0.28)
  const [bx, by] = pt(0.64, 0.5)
  const [dx, dy] = pt(0.38, 0.72)
  const stroke = size * 0.085 * s

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const bgAlpha = fullBleed ? 1 : coverage(roundedSquareDistance(px, py, size, radius))
      const glyphDist = Math.min(
        segmentDistance(px, py, ax, ay, bx, by),
        segmentDistance(px, py, bx, by, dx, dy),
      ) - stroke / 2
      const glyphAlpha = coverage(glyphDist)

      const i = (y * size + x) * 4
      for (let ch = 0; ch < 3; ch++) {
        rgba[i + ch] = Math.round(BG[ch] * (1 - glyphAlpha) + TEAL[ch] * glyphAlpha)
      }
      rgba[i + 3] = Math.round(255 * bgAlpha)
    }
  }
  return rgba
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  // One filter byte (0 = none) before each row.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT_DIR, { recursive: true })
for (const spec of SPECS) {
  const png = encodePng(render(spec), spec.size)
  writeFileSync(path.join(OUT_DIR, spec.name), png)
  console.log(`wrote ${path.relative(process.cwd(), path.join(OUT_DIR, spec.name))} (${spec.size}px, ${png.length} bytes)`)
}
