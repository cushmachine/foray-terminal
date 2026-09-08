// Shared WebSocket protocol types for Nest.
//
// This file is imported by both the client (Vite/React, bundler resolution)
// and the server (tsx, Node ESM). Keep it free of Node- or DOM-specific APIs
// so it can be imported from either side without extra config.

/**
 * Most scrollback lines the client keeps. The server sends no more than
 * this on attach: anything beyond it would be shipped over the wire only
 * for the client to throw away, and on a phone that download is most of
 * the wait when a session reconnects.
 */
export const MAX_HISTORY_LINES = 3000

/** A single Nest session (one tmux session), as exposed to the client. */
export interface TmuxWindow {
  id: number
  /** Session name: what the user typed at create/rename, or the auto default ("bash"). */
  name: string
  /** Working directory of the pane's foreground process. Follows `cd`. */
  cwd: string
  /**
   * Terminal title set by the running program (Claude Code's `/rename`,
   * say). Empty when nothing meaningful is set: tmux's default (the
   * hostname) and titles left behind under a bare shell are filtered out
   * server-side.
   */
  title: string
  /** Foreground command in the pane, e.g. "claude", "bash". */
  command: string
  /** True once the user explicitly named this session; the UI then shows `name` over `title`. */
  named: boolean
}

/** A node in a file tree — either a file or a directory. */
export interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: FileNode[]
}

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

export interface TerminalInputMessage {
  type: 'terminal:input'
  windowId: number
  data: string
}

export interface TerminalResizeMessage {
  type: 'terminal:resize'
  windowId: number
  cols: number
  rows: number
}

export interface TerminalAttachMessage {
  type: 'terminal:attach'
  windowId: number
  /**
   * Terminal size to spawn the pty at. When given, tmux draws once at the
   * right size instead of once at 80x24 and again after the first resize.
   */
  cols?: number
  rows?: number
}

/**
 * Let go of a window without closing the connection: the server kills this
 * connection's pty for it and releases ownership. Sent when a terminal
 * stops being the active one, so only the visible session holds a pty.
 */
export interface TerminalDetachMessage {
  type: 'terminal:detach'
  windowId: number
}

/**
 * Ask for a fresh session list. The server pushes `session:list` on its
 * own (welcome, and a poll while anyone is connected), so the client does
 * not send this today; it stays as the refresh hook for a client that
 * wants the list sooner than the next poll.
 */
export interface SessionListRequest {
  type: 'session:list'
}

export interface SessionCreateMessage {
  type: 'session:create'
  name?: string
  cwd?: string
}

export interface SessionKillMessage {
  type: 'session:kill'
  windowId: number
}

export interface SessionRenameMessage {
  type: 'session:rename'
  windowId: number
  name: string
}

export interface FilesTreeRequest {
  type: 'files:tree'
  cwd: string
}

export interface FilesReadMessage {
  type: 'files:read'
  path: string
}

export interface FilesWriteMessage {
  type: 'files:write'
  path: string
  content: string
}

export interface FilesWatchMessage {
  type: 'files:watch'
  cwd: string
}

export interface FilesUnwatchMessage {
  type: 'files:unwatch'
}

/**
 * Liveness probe. Browsers can't send WebSocket ping frames, so the client
 * sends this as an ordinary message and expects a `pong` back. No reply
 * within the client's timeout means the connection is dead (a phone that
 * changed networks, say) even though the socket still reports open.
 */
export interface PingMessage {
  type: 'ping'
}

/**
 * Sent by the client once per connection, after the welcome. `build` is the
 * id stamped into the page it is running (null for a page without one, such
 * as the vite dev server). The server logs it and answers with `server:hello`.
 */
export interface ClientHelloMessage {
  type: 'client:hello'
  build: string | null
}

/** Union of every message the client may send to the server. */
export type ClientMessage =
  | TerminalInputMessage
  | TerminalResizeMessage
  | TerminalAttachMessage
  | TerminalDetachMessage
  | SessionListRequest
  | SessionCreateMessage
  | SessionKillMessage
  | SessionRenameMessage
  | FilesTreeRequest
  | FilesReadMessage
  | FilesWriteMessage
  | FilesWatchMessage
  | FilesUnwatchMessage
  | PingMessage
  | ClientHelloMessage

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

export interface TerminalOutputMessage {
  type: 'terminal:output'
  windowId: number
  data: string
}

export interface SessionListMessage {
  type: 'session:list'
  windows: TmuxWindow[]
}

export interface SessionCreatedMessage {
  type: 'session:created'
  window: TmuxWindow
}

export interface SessionKilledMessage {
  type: 'session:killed'
  windowId: number
}

export interface SessionRenamedMessage {
  type: 'session:renamed'
  windowId: number
  name: string
}

/**
 * The directory tree for a `files:tree` request. `truncated` is set when
 * the walk hit the server's node cap and stopped early, so the client can
 * say the listing is partial.
 */
export interface FilesTreeMessage {
  type: 'files:tree'
  entries: FileNode[]
  truncated?: boolean
}

export interface FilesContentMessage {
  type: 'files:content'
  path: string
  content: string
}

export interface FilesSavedMessage {
  type: 'files:saved'
  path: string
}

export interface FilesChangedMessage {
  type: 'files:changed'
  path: string
  content: string
}

/** A watched file was deleted; `path` is relative to the watched directory. */
export interface FilesRemovedMessage {
  type: 'files:removed'
  path: string
}

/**
 * Acknowledges `files:watch` once the watcher's initial scan is done and
 * changes under `cwd` are being reported. A change made before this
 * arrives may go unseen.
 */
export interface FilesWatchingMessage {
  type: 'files:watching'
  cwd: string
}

/**
 * A request failed. This is the only error shape on the socket; the HTTP
 * upload endpoint answers failures with a JSON body `{ error: string }`
 * instead (src/shared/uploads.ts). `request` names the client message
 * that failed so each consumer can pick out its own errors: the file
 * panel takes `files:*`, a terminal takes those carrying its `windowId`,
 * and the app logs the rest. It is 'unknown' when the message could not be
 * parsed or named a type the server does not know.
 */
export interface ErrorMessage {
  type: 'error'
  message: string
  request: ClientMessage['type'] | 'unknown'
  /** The window the failed request was about, when it named one. */
  windowId?: number
  /** The path the failed files:* request was about, when it named one. */
  path?: string
}

/**
 * Lines from the pane's tmux history, oldest first, with colour escapes.
 * The client shows these above the live screen as its scrollback. `reset`
 * means "replace everything you have" (attach, resize reflow, or the
 * client fell too far behind); otherwise append.
 */
export interface TerminalHistoryMessage {
  type: 'terminal:history'
  windowId: number
  lines: string[]
  reset: boolean
}

/**
 * Sent to a client that was attached to a window when another client sends
 * `terminal:attach` for the same window — the new client "took over" and
 * this client's terminal session is no longer receiving output.
 */
export interface TerminalDetachedMessage {
  type: 'terminal:detached'
  windowId: number
  reason: 'taken-over'
}

/**
 * This connection's pty for the window ended on its own: the tmux session
 * was killed or tmux went away. The server has already forgotten the pty;
 * the client may send `terminal:attach` again to retry.
 */
export interface TerminalExitedMessage {
  type: 'terminal:exited'
  windowId: number
}

/**
 * Broadcast whenever attach/detach changes which windows have clients
 * connected. Also included in the per-connection welcome message. Only
 * windows with at least one attached client appear in the list.
 */
export interface SessionOwnershipMessage {
  type: 'session:ownership'
  ownership: Array<{ windowId: number; clients: number }>
}

/** Reply to a client `ping`. */
export interface PongMessage {
  type: 'pong'
}

/**
 * Reply to `client:hello`. `serverBuild` is the commit the server process
 * was started from (`<short-sha>[-dirty]`, or 'unknown'); `clientBuild` is
 * the id of the client bundle on disk right now, or null when none is built.
 * The page compares both with its own build (src/version.ts).
 */
export interface ServerHelloMessage {
  type: 'server:hello'
  serverBuild: string
  clientBuild: string | null
}

/** Union of every message the server may send to the client. */
export type ServerMessage =
  | TerminalOutputMessage
  | TerminalHistoryMessage
  | SessionListMessage
  | SessionCreatedMessage
  | SessionKilledMessage
  | SessionRenamedMessage
  | FilesTreeMessage
  | FilesContentMessage
  | FilesSavedMessage
  | FilesChangedMessage
  | FilesRemovedMessage
  | FilesWatchingMessage
  | ErrorMessage
  | TerminalDetachedMessage
  | TerminalExitedMessage
  | SessionOwnershipMessage
  | PongMessage
  | ServerHelloMessage
