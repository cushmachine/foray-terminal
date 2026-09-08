// Errors the client is allowed to see.
//
// Anything a handler throws ends up in an `error` message on the socket.
// Most failures carry server-internal detail (paths, tmux stderr) that a
// browser has no use for, so only a ClientError's message crosses the wire
// as written; everything else is reduced to what its errno says, or to a
// generic line.

/** A failure whose message was written for the user and is safe to send. */
export class ClientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClientError'
  }
}

const ERRNO_MESSAGES: Record<string, string> = {
  ENOENT: 'File or directory not found',
  EACCES: 'Permission denied',
  EISDIR: 'Path is a directory',
  ENOTDIR: 'Not a directory',
}

/** The message to put in an `error` reply for `err`. */
export function safeErrorMessage(err: unknown): string {
  if (err instanceof ClientError) return err.message
  if (err instanceof Error && 'code' in err) {
    const mapped = ERRNO_MESSAGES[String((err as NodeJS.ErrnoException).code)]
    if (mapped) return mapped
  }
  return 'Operation failed'
}
