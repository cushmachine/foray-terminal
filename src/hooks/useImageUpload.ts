// Image upload into a terminal: drop, paste, or the toolbar's photo key.
// Each image is POSTed to /api/upload and its saved path typed at the
// prompt (imageUpload.ts has the pure parts). The hook owns the status
// shown while uploads run and the drag state for the drop target.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, RefObject } from 'react'
import { useSocketContext } from '../SocketContext'
import { imageFilesFromClipboard, pathToTerminalInput, pickImageFiles, uploadImage } from '../imageUpload'

export interface UploadStatus {
  kind: 'uploading' | 'error'
  message: string
}

const UPLOAD_ERROR_FLASH_MS = 4000

export interface UseImageUploadOptions {
  windowId: number
  /** Where a paste of image data is intercepted before xterm sees it. */
  containerRef: RefObject<HTMLElement | null>
  /** Called when an upload finishes, however it went: focus returns to the terminal. */
  onSettled?: () => void
}

export interface DragHandlers {
  onDragEnter: (e: ReactDragEvent) => void
  onDragOver: (e: ReactDragEvent) => void
  onDragLeave: (e: ReactDragEvent) => void
  onDrop: (e: ReactDragEvent) => void
}

function isFileDrag(e: ReactDragEvent): boolean {
  return e.dataTransfer.types.includes('Files')
}

export function useImageUpload({ windowId, containerRef, onSettled }: UseImageUploadOptions) {
  const { send } = useSocketContext()
  const [status, setStatus] = useState<UploadStatus | null>(null)
  const [dragging, setDragging] = useState(false)
  // dragenter/dragleave fire for every child crossed; the target is left
  // only when the depth returns to zero.
  const dragDepth = useRef(0)
  const uploadsInFlight = useRef(0)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onSettledRef = useRef(onSettled)
  onSettledRef.current = onSettled

  useEffect(() => {
    return () => {
      if (errorTimer.current) clearTimeout(errorTimer.current)
    }
  }, [])

  const flashError = useCallback((message: string) => {
    setStatus({ kind: 'error', message })
    if (errorTimer.current) clearTimeout(errorTimer.current)
    errorTimer.current = setTimeout(() => {
      errorTimer.current = null
      setStatus((current) => (current?.kind === 'error' ? null : current))
    }, UPLOAD_ERROR_FLASH_MS)
  }, [])

  const uploadFiles = useCallback(
    async (files: File[]) => {
      const images = pickImageFiles(files)
      if (images.length === 0) {
        flashError('only PNG, JPEG, GIF, or WEBP images can be uploaded')
        return
      }
      uploadsInFlight.current += 1
      setStatus({
        kind: 'uploading',
        message: images.length > 1 ? `uploading ${images.length} images…` : 'uploading…',
      })
      try {
        for (const image of images) {
          const savedPath = await uploadImage(image)
          send({ type: 'terminal:input', windowId, data: pathToTerminalInput(savedPath) })
        }
        uploadsInFlight.current -= 1
        if (uploadsInFlight.current === 0) setStatus(null)
      } catch (err) {
        uploadsInFlight.current -= 1
        flashError(`upload failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        onSettledRef.current?.()
      }
    },
    [windowId, send, flashError],
  )

  // A pasted image is uploaded; a paste with no image is left to xterm.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handlePaste = (e: ClipboardEvent) => {
      const images = imageFilesFromClipboard(e.clipboardData?.items)
      if (images.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      void uploadFiles(images)
    }
    container.addEventListener('paste', handlePaste, { capture: true })
    return () => container.removeEventListener('paste', handlePaste, { capture: true })
  }, [containerRef, uploadFiles])

  const dragHandlers: DragHandlers = {
    onDragEnter: (e) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      dragDepth.current += 1
      setDragging(true)
    },
    onDragOver: (e) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (e) => {
      if (!isFileDrag(e)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    },
    onDrop: (e) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      void uploadFiles(Array.from(e.dataTransfer.files))
    },
  }

  return { uploadFiles, status, dragging, dragHandlers }
}
