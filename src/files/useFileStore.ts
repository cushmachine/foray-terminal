// The file panel's state: the tree, cached file contents, the edit in
// progress, and what the watcher last said about the open file.
//
// `reduceFileStore` is pure so the save flow and the changed-on-disk
// conflict are unit tested without a DOM. `useFileStore` wires it to the
// socket: the listing and the watcher are held only while the panel is
// showing (see `activation`), and the server forgets this connection's
// cwd and watcher when the socket closes, so the hook re-establishes
// both whenever the panel is shown on a live socket.

import { useEffect, useMemo, useReducer, useRef } from 'react'
import type { ClientMessage, FileNode, ServerMessage } from '../shared/protocol'
import { useSocketContext } from '../SocketContext'

export interface DiskChange {
  path: string
  content: string
}

export interface FileStoreState {
  /** The file being viewed or edited, relative to cwd; mirrors the panel's prop. */
  openFile: string | null
  tree: FileNode[] | null
  /** The server hit its node cap; the tree is partial. */
  truncated: boolean
  treeError: string | null
  /** Contents by relative path, kept fresh by the watcher. */
  contents: Record<string, string>
  /** A files:read failure for the open file. */
  fileError: string | null
  /** Expanded directories; survives reconnects and panel toggles. */
  expanded: ReadonlySet<string>
  editing: boolean
  editContent: string
  saving: boolean
  /** A files:write failure; the edit stays so nothing is lost. */
  saveError: string | null
  /** The open file changed on disk mid-edit and the user has not chosen reload or keep. */
  diskChange: DiskChange | null
  /** The open file was deleted on disk. */
  removed: boolean
}

export type FileStoreAction =
  | { type: 'message'; msg: ServerMessage }
  /** A new cwd: the tree and every cached file are about another directory. */
  | { type: 'reset' }
  /**
   * The same cwd listed again (the panel shown again, or a reconnect): the
   * tree stays in view until the fresh one arrives, and the cached files
   * go, since they may have changed while nothing was watching.
   */
  | { type: 'refresh' }
  | { type: 'select'; path: string | null }
  | { type: 'toggle-dir'; path: string }
  | { type: 'edit' }
  | { type: 'change'; content: string }
  | { type: 'save' }
  | { type: 'cancel-edit' }
  | { type: 'reload-from-disk' }
  | { type: 'keep-edits' }

export const INITIAL_FILE_STORE: FileStoreState = {
  openFile: null,
  tree: null,
  truncated: false,
  treeError: null,
  contents: {},
  fileError: null,
  expanded: new Set(),
  editing: false,
  editContent: '',
  saving: false,
  saveError: null,
  diskChange: null,
  removed: false,
}

const NOT_EDITING = {
  editing: false,
  editContent: '',
  saving: false,
  saveError: null,
  diskChange: null,
} as const

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

/** The server's order: directories first, then alphabetical. */
function compareNodes(a: FileNode, b: FileNode): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
  return a.name.localeCompare(b.name)
}

function toggleIn(set: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(set)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

/** The tree without the node at `path` (a file or a whole directory). */
export function removeNode(nodes: FileNode[], path: string): FileNode[] {
  return nodes
    .filter((node) => node.path !== path)
    .map((node) => (
      node.children && path.startsWith(`${node.path}/`)
        ? { ...node, children: removeNode(node.children, path) }
        : node
    ))
}

/**
 * The tree with a file at `path`, creating directories on the way. The
 * watcher reports a new file as a change, and the tree should show it
 * without a refetch. Already-present paths are left alone.
 */
export function insertFile(nodes: FileNode[], path: string): FileNode[] {
  return insertAt(nodes, path.split('/'), '')
}

function insertAt(nodes: FileNode[], segments: string[], prefix: string): FileNode[] {
  const [name, ...rest] = segments
  if (!name) return nodes
  const nodePath = prefix ? `${prefix}/${name}` : name
  const existing = nodes.find((node) => node.path === nodePath)
  if (rest.length === 0) {
    if (existing) return nodes
    const file: FileNode = { name, path: nodePath, type: 'file' }
    return [...nodes, file].sort(compareNodes)
  }
  if (existing) {
    if (existing.type !== 'dir') return nodes
    return nodes.map((node) => (
      node === existing ? { ...node, children: insertAt(node.children ?? [], rest, nodePath) } : node
    ))
  }
  const dir: FileNode = { name, path: nodePath, type: 'dir', children: insertAt([], rest, nodePath) }
  return [...nodes, dir].sort(compareNodes)
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** The store with `content` cached for `path`. */
function withContent(state: FileStoreState, path: string, content: string): FileStoreState {
  return { ...state, contents: { ...state.contents, [path]: content } }
}

function reduceMessage(state: FileStoreState, msg: ServerMessage): FileStoreState {
  switch (msg.type) {
    case 'files:tree':
      return { ...state, tree: msg.entries, truncated: msg.truncated === true, treeError: null }
    case 'files:content': {
      const next: FileStoreState = {
        ...withContent(state, msg.path, msg.content),
        fileError: msg.path === state.openFile ? null : state.fileError,
      }
      // Read again after a spell with no watcher (the panel was hidden),
      // the open file can turn out changed under an edit in progress: the
      // same conflict a files:changed reports. The cached copy is what the
      // edit started from; a read matching the edit is our own save.
      const cached = state.contents[msg.path]
      if (
        msg.path === state.openFile && state.editing
        && cached !== undefined && msg.content !== cached && msg.content !== state.editContent
      ) {
        next.diskChange = { path: msg.path, content: msg.content }
      }
      return next
    }
    case 'files:changed': {
      // Cache every watched file, open or not, so reopening is instant.
      const next: FileStoreState = {
        ...withContent(state, msg.path, msg.content),
        tree: state.tree ? insertFile(state.tree, msg.path) : state.tree,
      }
      if (msg.path !== state.openFile) return next
      next.removed = false
      // Our own save echoes back through the watcher; only someone else's
      // write is a conflict worth asking about.
      if (state.editing) next.diskChange = msg.content === state.editContent ? null : { path: msg.path, content: msg.content }
      return next
    }
    case 'files:removed': {
      const contents = { ...state.contents }
      delete contents[msg.path]
      return {
        ...state,
        contents,
        tree: state.tree ? removeNode(state.tree, msg.path) : state.tree,
        removed: msg.path === state.openFile ? true : state.removed,
      }
    }
    case 'files:saved':
      if (msg.path !== state.openFile) return state
      return { ...state, ...NOT_EDITING, removed: false }
    case 'error': {
      // Only this panel's own requests; terminal and session errors are not ours to show.
      if (!msg.request.startsWith('files:')) return state
      if (msg.request === 'files:write') return { ...state, saving: false, saveError: msg.message }
      if (msg.request === 'files:read') return { ...state, fileError: msg.message }
      return { ...state, treeError: msg.message }
    }
    default:
      return state
  }
}

export function reduceFileStore(state: FileStoreState, action: FileStoreAction): FileStoreState {
  switch (action.type) {
    case 'message':
      return reduceMessage(state, action.msg)
    case 'reset':
      // The edit in progress survives; everything about the directory does not.
      return {
        ...state,
        tree: null,
        truncated: false,
        treeError: null,
        contents: {},
        fileError: null,
        removed: false,
      }
    case 'refresh': {
      // The open file's copy stays so the re-read that follows can tell a
      // change on disk from the content the edit started with.
      const { openFile } = state
      const contents = openFile !== null && openFile in state.contents
        ? { [openFile]: state.contents[openFile] }
        : {}
      return { ...state, contents, fileError: null, removed: false }
    }
    case 'select':
      return { ...state, ...NOT_EDITING, openFile: action.path, fileError: null, removed: false }
    case 'toggle-dir':
      return { ...state, expanded: toggleIn(state.expanded, action.path) }
    case 'edit':
      if (state.openFile === null) return state
      return {
        ...state,
        ...NOT_EDITING,
        editing: true,
        editContent: state.contents[state.openFile] ?? '',
      }
    case 'change':
      return { ...state, editContent: action.content }
    case 'save':
      if (state.openFile === null || !state.editing) return state
      // Cache the saved text now so the preview is right the moment the
      // editor closes; the watcher's echo confirms it.
      return { ...withContent(state, state.openFile, state.editContent), saving: true, saveError: null }
    case 'cancel-edit':
      return { ...state, ...NOT_EDITING }
    case 'reload-from-disk':
      if (!state.diskChange) return state
      return { ...state, editContent: state.diskChange.content, diskChange: null }
    case 'keep-edits':
      return { ...state, diskChange: null }
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface FileStoreActions {
  toggleDir: (path: string) => void
  edit: () => void
  change: (content: string) => void
  save: () => void
  cancelEdit: () => void
  reloadFromDisk: () => void
  keepEdits: () => void
}

export type FileStore = FileStoreState & FileStoreActions

/**
 * What the hook sends when the panel is shown on a live socket. `listed`
 * is the cwd whose tree the store holds (null for none): the same cwd is
 * refreshed behind the tree in view, another one starts over. The open
 * file is read again either way; its cached copy may be stale.
 */
export function activation(listed: string | null, cwd: string, openFile: string | null): {
  action: 'reset' | 'refresh'
  messages: ClientMessage[]
} {
  const messages: ClientMessage[] = [{ type: 'files:tree', cwd }, { type: 'files:watch', cwd }]
  if (openFile !== null) messages.push({ type: 'files:read', path: openFile })
  return { action: listed === cwd ? 'refresh' : 'reset', messages }
}

/**
 * The panel's state, bound to the socket. `active` is whether the panel is
 * showing: the server lists and watches only for a panel in view, so a
 * hidden one costs no directory walk and no pushed file contents. The
 * tree, the expansion and any edit in progress are kept while hidden.
 */
export function useFileStore(cwd: string, openFile: string | null, active: boolean): FileStore {
  const { send, onMessage, status } = useSocketContext()
  const [state, dispatch] = useReducer(reduceFileStore, INITIAL_FILE_STORE)

  // `send` may not be referentially stable across parent re-renders; refs
  // keep the effects below from re-running for it or for state they only
  // read at the moment they fire.
  const sendRef = useRef(send)
  sendRef.current = send
  const stateRef = useRef(state)
  stateRef.current = state
  const openFileRef = useRef(openFile)
  openFileRef.current = openFile

  useEffect(() => onMessage((msg) => dispatch({ type: 'message', msg })), [onMessage])

  // Fetch a not-yet-cached file when it is selected. Declared before the
  // reconnect effect so the mount order is select, then reset.
  useEffect(() => {
    dispatch({ type: 'select', path: openFile })
    if (openFile && stateRef.current.contents[openFile] === undefined) {
      sendRef.current({ type: 'files:read', path: openFile })
    }
  }, [openFile])

  // The cwd whose tree the store holds, so showing the panel again for
  // the same directory refreshes behind the tree rather than blanking it.
  const listedRef = useRef<string | null>(null)

  // List and watch while the panel is showing on a live socket; stop
  // watching when it is hidden. A cwd change while hidden sends nothing
  // until the panel is next shown. Only the connected state re-runs it,
  // so a disconnect does not wipe the tree the user is looking at.
  const connected = status === 'connected'
  useEffect(() => {
    if (!connected || !active) return
    const { action, messages } = activation(listedRef.current, cwd, openFileRef.current)
    listedRef.current = cwd
    dispatch({ type: action })
    for (const msg of messages) sendRef.current(msg)
    return () => {
      sendRef.current({ type: 'files:unwatch' })
    }
  }, [cwd, connected, active])

  const actions = useMemo<FileStoreActions>(() => ({
    toggleDir: (path) => dispatch({ type: 'toggle-dir', path }),
    edit: () => dispatch({ type: 'edit' }),
    change: (content) => dispatch({ type: 'change', content }),
    save: () => {
      const { openFile: path, editing, editContent } = stateRef.current
      if (path === null || !editing) return
      dispatch({ type: 'save' })
      sendRef.current({ type: 'files:write', path, content: editContent })
    },
    cancelEdit: () => dispatch({ type: 'cancel-edit' }),
    reloadFromDisk: () => dispatch({ type: 'reload-from-disk' }),
    keepEdits: () => dispatch({ type: 'keep-edits' }),
  }), [])

  return useMemo(() => ({ ...state, ...actions }), [state, actions])
}
