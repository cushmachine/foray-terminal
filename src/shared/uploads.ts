// Shared constants and types for the image upload endpoint (POST /api/upload).
//
// Imported by both the client (Terminal drop/paste handling) and the server
// (the multer gate), so keep it free of Node- and DOM-specific APIs.

/** MIME types the upload endpoint accepts. */
export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number]

/** Hard cap on a single upload, enforced server-side. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** Multipart field name the client sends the file under. */
export const UPLOAD_FIELD_NAME = 'file'

/** Successful upload: the absolute path of the saved file on the server. */
export interface UploadResponse {
  path: string
}

/** Failed upload (4xx/5xx): a human-readable reason. */
export interface UploadErrorResponse {
  error: string
}

export function isSupportedImageType(type: string): type is SupportedImageType {
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(type)
}
