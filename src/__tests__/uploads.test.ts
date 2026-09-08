// Image upload (drag-and-drop / paste -> ~/uploads -> shell) tests.
//
// Run with: npx tsx --test src/__tests__/uploads.test.ts
// (executed directly via `tsx`, using node's built-in test runner)
//
// Covers:
//  1. POST /api/upload saves a PNG under the upload dir (created on demand)
//     with a timestamped name and returns its absolute path
//  2. It rejects non-image MIME types (415), non-image bytes (415),
//     oversized files (413), and requests with no/misnamed file field (400)
//  3. saveUpload picks the extension from the bytes and gives same-second
//     uploads distinct names
//  4. sniffImageType / uploadFilename in isolation
//  5. Client helpers (no DOM available here): image filtering for drop and
//     paste, shell-safe path insertion, and uploadImage against the real
//     endpoint
//  6. The upload sweep: ~/uploads is temp-only, so purgeOldUploads deletes
//     anything older than the cutoff, and the server runs it on a timer
//     (never immediately at startup, so test runs can't touch a real
//     ~/uploads)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startTestServer, tmpDir } from '../server/__tests__/helpers.ts'
import {
  DEFAULT_MAX_UPLOAD_AGE_DAYS,
  UPLOAD_SWEEP_INITIAL_DELAY_MS,
  purgeOldUploads,
  saveUpload,
  sniffImageType,
  uploadFilename,
} from '../server/uploads.ts'
import { MAX_UPLOAD_BYTES } from '../shared/uploads.ts'
import {
  imageFilesFromClipboard,
  pathToTerminalInput,
  pickImageFiles,
  shellQuote,
  uploadImage,
} from '../imageUpload.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0]
const GIF_MAGIC = Array.from(Buffer.from('GIF89a'))
const WEBP_MAGIC = [...Buffer.from('RIFF'), 0x10, 0x00, 0x00, 0x00, ...Buffer.from('WEBP')]

/** A fake image: the right magic bytes followed by filler up to `size`. */
function fakeImage(magic: number[], size = 64): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(size).fill(0xab)
  buf.set(magic)
  return buf
}

/** POST bytes to /api/upload as multipart/form-data, the way the browser does. */
async function postUpload(
  url: string,
  bytes: Uint8Array<ArrayBuffer>,
  type: string,
  field = 'file',
): Promise<Response> {
  const form = new FormData()
  form.append(field, new Blob([bytes], { type }), 'shot.png')
  return fetch(`${url}/api/upload`, { method: 'POST', body: form })
}

// ---------------------------------------------------------------------------
// Server endpoint
// ---------------------------------------------------------------------------

test('POST /api/upload saves a PNG to the upload dir (creating it) and returns its absolute path', async () => {
  const tmp = await tmpDir('nest-uploads-')
  // Two levels deep and not yet created: the endpoint must mkdir -p it.
  const uploadDir = path.join(tmp, 'home', 'uploads')
  const { url, close } = await startTestServer({ uploadDir })
  try {
    const bytes = fakeImage(PNG_MAGIC)
    const res = await postUpload(url, bytes, 'image/png')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(path.isAbsolute(body.path), `expected absolute path, got ${body.path}`)
    assert.equal(path.dirname(body.path), uploadDir)
    assert.match(path.basename(body.path), /^upload-\d{4}-\d{2}-\d{2}-\d{6}\.png$/)
    assert.deepEqual(new Uint8Array(await fs.readFile(body.path)), bytes)
  } finally {
    await close()
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('POST /api/upload rejects unsupported MIME types with 415 and writes nothing', async () => {
  const tmp = await tmpDir('nest-uploads-')
  const uploadDir = path.join(tmp, 'uploads')
  const { url, close } = await startTestServer({ uploadDir })
  try {
    const res = await postUpload(url, fakeImage(PNG_MAGIC), 'text/plain')
    assert.equal(res.status, 415)
    const body = await res.json()
    assert.match(body.error, /unsupported file type: text\/plain/)
    await assert.rejects(fs.access(uploadDir), 'upload dir should not have been created')
  } finally {
    await close()
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('POST /api/upload rejects bytes that are not an image, even with an image MIME type', async () => {
  const tmp = await tmpDir('nest-uploads-')
  const uploadDir = path.join(tmp, 'uploads')
  const { url, close } = await startTestServer({ uploadDir })
  try {
    const notAnImage = new TextEncoder().encode('#!/bin/sh\necho definitely not a png\n')
    const res = await postUpload(url, notAnImage, 'image/png')
    assert.equal(res.status, 415)
    const body = await res.json()
    assert.match(body.error, /not a PNG, JPEG, GIF, or WEBP/)
    await assert.rejects(fs.access(uploadDir), 'upload dir should not have been created')
  } finally {
    await close()
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('POST /api/upload rejects files over 10MB with 413', async () => {
  const tmp = await tmpDir('nest-uploads-')
  const uploadDir = path.join(tmp, 'uploads')
  const { url, close } = await startTestServer({ uploadDir })
  try {
    const res = await postUpload(url, fakeImage(PNG_MAGIC, MAX_UPLOAD_BYTES + 1), 'image/png')
    assert.equal(res.status, 413)
    const body = await res.json()
    assert.match(body.error, /10MB/)
    await assert.rejects(fs.access(uploadDir), 'upload dir should not have been created')
  } finally {
    await close()
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('POST /api/upload responds 400 when the file field is missing or misnamed', async () => {
  const tmp = await tmpDir('nest-uploads-')
  const uploadDir = path.join(tmp, 'uploads')
  const { url, close } = await startTestServer({ uploadDir })
  try {
    const textOnly = new FormData()
    textOnly.append('note', 'no file here')
    const missing = await fetch(`${url}/api/upload`, { method: 'POST', body: textOnly })
    assert.equal(missing.status, 400)
    assert.match((await missing.json()).error, /no file uploaded/)

    const misnamed = await postUpload(url, fakeImage(PNG_MAGIC), 'image/png', 'image')
    assert.equal(misnamed.status, 400)
    assert.equal(typeof (await misnamed.json()).error, 'string')
  } finally {
    await close()
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Storage module
// ---------------------------------------------------------------------------

test('saveUpload: extension follows the image bytes, and same-second uploads get distinct names', async () => {
  const tmp = await tmpDir('nest-uploads-')
  try {
    const now = new Date(2026, 8, 3, 9, 45, 12) // 2026-09-03 09:45:12 local
    const first = await saveUpload(fakeImage(PNG_MAGIC), tmp, now)
    const second = await saveUpload(fakeImage(PNG_MAGIC), tmp, now)
    const third = await saveUpload(fakeImage(PNG_MAGIC), tmp, now)
    assert.equal(path.basename(first), 'upload-2026-09-03-094512.png')
    assert.equal(path.basename(second), 'upload-2026-09-03-094512-1.png')
    assert.equal(path.basename(third), 'upload-2026-09-03-094512-2.png')

    assert.equal(path.extname(await saveUpload(fakeImage(JPEG_MAGIC), tmp, now)), '.jpg')
    assert.equal(path.extname(await saveUpload(fakeImage(GIF_MAGIC), tmp, now)), '.gif')
    assert.equal(path.extname(await saveUpload(fakeImage(WEBP_MAGIC), tmp, now)), '.webp')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('sniffImageType identifies the four supported formats and rejects everything else', () => {
  assert.equal(sniffImageType(fakeImage(PNG_MAGIC)), 'image/png')
  assert.equal(sniffImageType(fakeImage(JPEG_MAGIC)), 'image/jpeg')
  assert.equal(sniffImageType(fakeImage(GIF_MAGIC)), 'image/gif')
  assert.equal(sniffImageType(fakeImage(Array.from(Buffer.from('GIF87a')))), 'image/gif')
  assert.equal(sniffImageType(fakeImage(WEBP_MAGIC)), 'image/webp')
  // RIFF container that isn't WEBP (e.g. a .wav)
  assert.equal(sniffImageType(fakeImage([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVE')])), null)
  assert.equal(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), null)
  assert.equal(sniffImageType(new Uint8Array(0)), null)
  assert.equal(sniffImageType(new Uint8Array([0x89, 0x50])), null) // truncated magic
})

test('uploadFilename formats local time with zero padding and an optional collision suffix', () => {
  const when = new Date(2026, 0, 5, 3, 7, 9) // 2026-01-05 03:07:09 local
  assert.equal(uploadFilename('image/png', when), 'upload-2026-01-05-030709.png')
  assert.equal(uploadFilename('image/jpeg', when, 2), 'upload-2026-01-05-030709-2.jpg')
  assert.equal(uploadFilename('image/webp', when, 0), 'upload-2026-01-05-030709.webp')
})

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------

test('pickImageFiles keeps only supported image types, preserving order', () => {
  const files = [
    { type: 'image/png', name: 'a.png' },
    { type: 'text/plain', name: 'notes.txt' },
    { type: 'image/svg+xml', name: 'icon.svg' },
    { type: 'image/jpeg', name: 'b.jpg' },
    { type: 'image/gif', name: 'c.gif' },
    { type: 'image/webp', name: 'd.webp' },
    { type: '', name: 'unknown' },
  ]
  assert.deepEqual(
    pickImageFiles(files).map((f) => f.name),
    ['a.png', 'b.jpg', 'c.gif', 'd.webp'],
  )
  assert.deepEqual(pickImageFiles([]), [])
})

test('imageFilesFromClipboard: text-only (or empty) clipboards yield [] so xterm handles the paste', () => {
  const textItems = [
    { kind: 'string', type: 'text/plain', getAsFile: () => null },
    { kind: 'string', type: 'text/html', getAsFile: () => null },
  ]
  assert.deepEqual(imageFilesFromClipboard(textItems), [])
  assert.deepEqual(imageFilesFromClipboard([]), [])
  assert.deepEqual(imageFilesFromClipboard(null), [])
  assert.deepEqual(imageFilesFromClipboard(undefined), [])
})

test('imageFilesFromClipboard: returns image files, skipping text and non-image file items', () => {
  const png = { type: 'image/png', name: 'image.png' }
  const items = [
    { kind: 'string', type: 'text/html', getAsFile: () => null },
    { kind: 'file', type: 'image/png', getAsFile: () => png },
    { kind: 'file', type: 'application/pdf', getAsFile: () => ({ type: 'application/pdf', name: 'doc.pdf' }) },
    // A file item whose getAsFile() comes back null is skipped, not crashed on.
    { kind: 'file', type: 'image/jpeg', getAsFile: () => null },
  ]
  assert.deepEqual(imageFilesFromClipboard(items), [png])
})

test('pathToTerminalInput: plain paths get a trailing space; awkward paths are single-quoted', () => {
  assert.equal(
    pathToTerminalInput('/root/uploads/upload-2026-09-03-094512.png'),
    '/root/uploads/upload-2026-09-03-094512.png ',
  )
  assert.equal(pathToTerminalInput('/Users/Jo Smith/uploads/x.png'), "'/Users/Jo Smith/uploads/x.png' ")
  assert.equal(shellQuote("/tmp/it's.png"), "'/tmp/it'\\''s.png'")
  assert.equal(shellQuote('/tmp/$HOME.png'), "'/tmp/$HOME.png'")
  // Never a newline: the user should be able to keep typing the command.
  assert.ok(!pathToTerminalInput('/root/uploads/a.png').includes('\n'))
})

test('uploadImage: resolves with the saved path on success and throws the server error on failure', async () => {
  const tmp = await tmpDir('nest-uploads-')
  const uploadDir = path.join(tmp, 'uploads')
  const { url, close } = await startTestServer({ uploadDir })
  try {
    // The browser calls fetch('/api/upload') relative to its origin; here we
    // point that at the test server.
    const fetchImpl: typeof fetch = (input, init) => fetch(new URL(String(input), url), init)

    const shot = new File([fakeImage(PNG_MAGIC)], 'screenshot.png', { type: 'image/png' })
    const saved = await uploadImage(shot, fetchImpl)
    assert.equal(path.dirname(saved), uploadDir)
    assert.match(path.basename(saved), /^upload-.*\.png$/)

    const notes = new File([new TextEncoder().encode('hello')], 'notes.txt', { type: 'text/plain' })
    await assert.rejects(uploadImage(notes, fetchImpl), /unsupported file type: text\/plain/)
  } finally {
    await close()
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Upload sweep (~/uploads is temp-only)
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000

/** Backdate a path's mtime to `ageMs` before `now`. */
async function ageFile(file: string, ageMs: number, now: Date): Promise<void> {
  const when = new Date(now.getTime() - ageMs)
  await fs.utimes(file, when, when)
}

const exists = (file: string): Promise<boolean> =>
  fs.access(file).then(
    () => true,
    () => false,
  )

/** Poll until `check` resolves true, or fail after `timeoutMs`. */
async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for condition')
}

test('purgeOldUploads: deletes files past the cutoff regardless of name, keeps newer files and subdirs', async () => {
  const tmp = await tmpDir('nest-uploads-')
  try {
    const now = new Date()
    const old = path.join(tmp, 'upload-2026-08-01-120000.png')
    const oldHandmade = path.join(tmp, 'anything-goes.txt') // temp-only: no name is spared
    const fresh = path.join(tmp, 'upload-2026-09-03-094512.png')
    const sub = path.join(tmp, 'subdir')
    const nested = path.join(sub, 'nested.png')
    for (const file of [old, oldHandmade, fresh]) await fs.writeFile(file, 'x')
    await fs.mkdir(sub)
    await fs.writeFile(nested, 'x')
    await ageFile(old, 8 * DAY, now)
    await ageFile(oldHandmade, 30 * DAY, now)
    await ageFile(fresh, 6 * DAY, now)
    await ageFile(nested, 30 * DAY, now)
    await ageFile(sub, 30 * DAY, now)

    const deleted = await purgeOldUploads(tmp, 7 * DAY, now)
    assert.deepEqual(deleted.sort(), [old, oldHandmade].sort())
    assert.equal(await exists(old), false)
    assert.equal(await exists(oldHandmade), false)
    assert.equal(await exists(fresh), true, 'a 6-day-old file survives a 7-day cutoff')
    assert.equal(await exists(nested), true, 'subdirectories are left alone')

    assert.equal(DEFAULT_MAX_UPLOAD_AGE_DAYS, 7)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('purgeOldUploads: a missing upload dir is not an error (nothing uploaded yet)', async () => {
  const tmp = await tmpDir('nest-uploads-')
  try {
    assert.deepEqual(await purgeOldUploads(path.join(tmp, 'never-created'), 7 * DAY), [])
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

/** A temp upload dir holding one 3-day-old file and one 1-day-old file. */
async function makeAgedUploadDir(): Promise<{ tmp: string; uploadDir: string; old: string; fresh: string }> {
  const tmp = await tmpDir('nest-uploads-')
  const uploadDir = path.join(tmp, 'uploads')
  await fs.mkdir(uploadDir)
  const old = path.join(uploadDir, 'upload-2026-08-01-120000.png')
  const fresh = path.join(uploadDir, 'upload-2026-09-03-094512.png')
  await fs.writeFile(old, 'x')
  await fs.writeFile(fresh, 'x')
  const now = new Date()
  await ageFile(old, 3 * DAY, now)
  await ageFile(fresh, 1 * DAY, now)
  return { tmp, uploadDir, old, fresh }
}

test('server sweeps the upload dir on its timer using maxUploadAgeDays', async () => {
  const { tmp, uploadDir, old, fresh } = await makeAgedUploadDir()
  const { close } = await startTestServer({ uploadDir, maxUploadAgeDays: 2, uploadSweepIntervalMs: 50 })
  try {
    await waitUntil(async () => !(await exists(old)))
    assert.equal(await exists(fresh), true, 'a 1-day-old file survives a 2-day cutoff')
  } finally {
    await close()
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

// The server's sweep timer runs on the test clock here: a minute of wall
// time is a tick, and "never" is a very large one.
test('server does not sweep immediately at startup (protects a real ~/uploads during short test runs)', async (t) => {
  const { tmp, uploadDir, old } = await makeAgedUploadDir()
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  // Default interval (hours), so the first sweep is a minute out at the earliest.
  const server = await startTestServer({ uploadDir, maxUploadAgeDays: 2 })
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await server.close()
  }
  try {
    t.mock.timers.tick(UPLOAD_SWEEP_INITIAL_DELAY_MS - 1)
    assert.equal(await exists(old), true, 'nothing is touched before the initial delay')
    t.mock.timers.tick(1)
    // The sweep is in flight. Its file work is real, so once the server
    // (and the fake clock) are out of the way, poll for it on real timers.
    await close()
    t.mock.timers.reset()
    await waitUntil(async () => !(await exists(old)))
  } finally {
    await close()
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('server leaves the upload dir alone when maxUploadAgeDays is 0', async (t) => {
  const { tmp, uploadDir, old } = await makeAgedUploadDir()
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { close } = await startTestServer({ uploadDir, maxUploadAgeDays: 0, uploadSweepIntervalMs: 20 })
  try {
    t.mock.timers.tick(DAY)
    assert.equal(await exists(old), true)
  } finally {
    await close()
    t.mock.timers.reset()
    await fs.rm(tmp, { recursive: true, force: true })
  }
})
