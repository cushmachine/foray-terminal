// Client-side helpers for image upload via drag-and-drop / paste.
//
// Framework-agnostic (no React, no DOM beyond fetch/FormData) so the
// filtering and shell-insertion logic can be unit-tested under node. The
// Terminal component wires these to real drop/paste events.

import {
  UPLOAD_FIELD_NAME,
  isSupportedImageType,
  type UploadErrorResponse,
  type UploadResponse,
} from './shared/uploads.ts'

/** The subset of File we need, so tests can pass plain objects. */
export interface TypedFile {
  type: string
}

/** Keep only the files the upload endpoint will accept. */
export function pickImageFiles<T extends TypedFile>(files: Iterable<T>): T[] {
  return Array.from(files).filter((f) => isSupportedImageType(f.type))
}

/** The subset of DataTransferItem we read during a paste. */
export interface ClipboardItemLike<F> {
  kind: string
  type: string
  getAsFile(): F | null
}

/**
 * Image files carried by a paste event's clipboard items, or [] if there are
 * none. An empty result means the caller should leave the event alone so
 * xterm handles it as an ordinary text paste.
 */
export function imageFilesFromClipboard<F extends TypedFile>(
  items: ArrayLike<ClipboardItemLike<F>> | null | undefined,
): F[] {
  if (!items) return []
  const files: F[] = []
  for (const item of Array.from(items)) {
    if (item.kind !== 'file' || !isSupportedImageType(item.type)) continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  return files
}

/** Characters that can be typed into a POSIX shell without quoting. */
const SHELL_SAFE = /^[A-Za-z0-9_\-./~+:@%,=]+$/

/** Single-quote a string for the shell unless it's made only of safe characters. */
export function shellQuote(value: string): string {
  if (SHELL_SAFE.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * What to type into the terminal for an uploaded file: the (quoted if
 * necessary) path plus a trailing space, so the user can keep typing the
 * rest of the command rather than having it executed.
 */
export function pathToTerminalInput(filePath: string): string {
  return `${shellQuote(filePath)} `
}

/**
 * POST one image to /api/upload. Resolves with the absolute path the server
 * saved it to; rejects with the server's error message on failure.
 */
export async function uploadImage(file: File, fetchImpl: typeof fetch = fetch): Promise<string> {
  const form = new FormData()
  form.append(UPLOAD_FIELD_NAME, file, file.name || 'image')
  const res = await fetchImpl('/api/upload', { method: 'POST', body: form })
  const body = (await res.json().catch(() => null)) as UploadResponse | UploadErrorResponse | null
  if (!res.ok || !body || !('path' in body)) {
    const reason = body && 'error' in body ? body.error : `server responded ${res.status}`
    throw new Error(reason)
  }
  return body.path
}
