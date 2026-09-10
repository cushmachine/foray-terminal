// Image upload storage for POST /api/upload.
//
// Files land in ~/uploads/ (created on demand) under a timestamped name like
// upload-2026-09-03-094512.png, so the path the client types into the shell
// needs no quoting and sorts chronologically in `ls`.
//
// The folder is temp-only by convention: anything worth keeping belongs in
// a project. purgeOldUploads sweeps out everything older than a week, and
// the server runs it periodically (see startServer).

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SupportedImageType } from '../shared/uploads.ts'

export const DEFAULT_UPLOAD_DIR = path.join(os.homedir(), 'uploads')

const EXTENSIONS: Record<SupportedImageType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** Thrown when the uploaded bytes aren't one of the supported image formats. */
export class UnsupportedImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedImageError'
  }
}

function bytesAt(bytes: Uint8Array, offset: number, expected: number[]): boolean {
  if (bytes.length < offset + expected.length) return false
  return expected.every((b, i) => bytes[offset + i] === b)
}

/**
 * Identify an image by its magic bytes. Returns null for anything that isn't
 * PNG/JPEG/GIF/WEBP. The client's declared MIME type only gates the request;
 * the on-disk extension comes from the actual content.
 */
export function sniffImageType(bytes: Uint8Array): SupportedImageType | null {
  if (bytesAt(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (bytesAt(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  // "GIF87a" or "GIF89a"
  if (bytesAt(bytes, 0, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif'
  }
  // "RIFF" <4-byte chunk size> "WEBP"
  if (bytesAt(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && bytesAt(bytes, 8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp'
  return null
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Timestamped basename for an upload, in local time:
 * upload-YYYY-MM-DD-HHMMSS.ext, with "-N" before the extension when `suffix`
 * is non-zero (used to dodge collisions within the same second).
 */
export function uploadFilename(type: SupportedImageType, now: Date, suffix = 0): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const collision = suffix > 0 ? `-${suffix}` : ''
  return `upload-${date}-${time}${collision}.${EXTENSIONS[type]}`
}

/** Upper bound on same-second collision retries before giving up. */
const MAX_COLLISION_SUFFIX = 1000

/**
 * Write image bytes into `dir` (created if missing) under a timestamped name
 * and resolve with the absolute path. Uses an exclusive create ('wx') so two
 * uploads in the same second get distinct names instead of clobbering.
 */
export async function saveUpload(
  bytes: Uint8Array,
  dir: string = DEFAULT_UPLOAD_DIR,
  now: Date = new Date(),
): Promise<string> {
  const type = sniffImageType(bytes)
  if (!type) {
    throw new UnsupportedImageError('file is not a PNG, JPEG, GIF, or WEBP image')
  }
  // Screenshots can hold anything; keep the folder to the owner.
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  for (let suffix = 0; suffix < MAX_COLLISION_SUFFIX; suffix++) {
    const target = path.resolve(dir, uploadFilename(type, now, suffix))
    try {
      await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
      return target
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error(`could not find a free upload filename in ${dir}`)
}

/** Default age after which files in the upload dir are deleted. */
export const DEFAULT_MAX_UPLOAD_AGE_DAYS = 7

/** How often the server re-runs the sweep while it's up. */
export const UPLOAD_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Delay before the first sweep after startup. Not immediate, so short-lived
 * servers (the test suites start real ones with the default upload dir)
 * never touch a real ~/uploads.
 */
export const UPLOAD_SWEEP_INITIAL_DELAY_MS = 60 * 1000

export const DAY_MS = 24 * 60 * 60 * 1000

/** The names saveUpload writes; the sweep touches nothing else. */
const UPLOAD_NAME_RE = /^upload-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?\.(png|jpg|gif|webp)$/

/**
 * Delete every upload in `dir` last modified `maxAgeMs` or more ago and
 * resolve with the paths removed. Only files named as saveUpload names
 * them are candidates: ~/uploads is a folder a user may already have, and
 * whatever else they keep there is theirs. A missing dir just means
 * nothing has been uploaded yet.
 */
export async function purgeOldUploads(dir: string, maxAgeMs: number, now: Date = new Date()): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return []
    throw err
  })
  const cutoff = now.getTime() - maxAgeMs
  const deleted: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !UPLOAD_NAME_RE.test(entry.name)) continue
    const file = path.join(dir, entry.name)
    try {
      const { mtimeMs } = await fs.stat(file)
      if (mtimeMs > cutoff) continue
      await fs.unlink(file)
      deleted.push(file)
    } catch (err) {
      // Vanished between readdir and here (someone else cleaned up): fine.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  return deleted
}
