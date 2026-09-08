// Logging: an injectable sink plus per-module prefixes.

/** Where log lines go; `console` in production, a no-op under test. */
export interface Logger {
  log(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** A logger that drops everything. */
export const SILENT: Logger = { log: () => {}, error: () => {} }

/** `logger` with every line prefixed `[scope]`, so prefixes are never hand-typed. */
export function scopedLog(logger: Logger, scope: string): Logger {
  const prefix = `[${scope}]`
  return {
    log: (...args) => logger.log(prefix, ...args),
    error: (...args) => logger.error(prefix, ...args),
  }
}
