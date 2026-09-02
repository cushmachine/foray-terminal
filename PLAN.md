# Nest: Implementation Plan

## Architecture

```
src/
  server/
    index.ts          — Express + WebSocket server entry
    tmux.ts            — tmux CLI wrapper (list/create/kill/rename windows)
    pty-bridge.ts      — node-pty attachment to tmux windows, piped over WebSocket
    files.ts           — filesystem API (tree, read, write, watch)
    types.ts           — shared protocol types (WebSocket messages)
  client/
    App.tsx            — already built (sidebar, terminal, file panel, key toolbar)
    Terminal.tsx        — swap demo for real WebSocket connection
    Sidebar.tsx         — wire to live session list
    FilePanel.tsx       — wire to live filesystem
    MarkdownEditor.tsx  — already built (CodeMirror)
    KeyToolbar.tsx      — already built
    hooks/
      useSocket.ts     — WebSocket connection manager with reconnect
    styles.css         — already built
    main.tsx           — already built
  shared/
    protocol.ts        — message type definitions shared by client + server
```

Server runs on port 3000 (Express + ws). Vite dev server proxies `/ws` to it during development. Production: Vite builds static files, Express serves them + WebSocket.

## Protocol

All communication over a single WebSocket at `/ws`. Messages are JSON:

```typescript
// Client → Server
{ type: 'terminal:input', windowId: number, data: string }
{ type: 'terminal:resize', windowId: number, cols: number, rows: number }
{ type: 'terminal:attach', windowId: number }
{ type: 'session:list' }
{ type: 'session:create', name?: string, cwd?: string }
{ type: 'session:kill', windowId: number }
{ type: 'session:rename', windowId: number, name: string }
{ type: 'files:tree', cwd: string }
{ type: 'files:read', path: string }
{ type: 'files:write', path: string, content: string }
{ type: 'files:watch', cwd: string }
{ type: 'files:unwatch' }

// Server → Client
{ type: 'terminal:output', windowId: number, data: string }
{ type: 'session:list', windows: TmuxWindow[] }
{ type: 'session:created', window: TmuxWindow }
{ type: 'session:killed', windowId: number }
{ type: 'session:renamed', windowId: number, name: string }
{ type: 'files:tree', entries: FileNode[] }
{ type: 'files:content', path: string, content: string }
{ type: 'files:saved', path: string }
{ type: 'files:changed', path: string, content: string }
{ type: 'error', message: string }
```

## Dependencies to Add

```
# Server
express, ws, node-pty, chokidar

# Dev
@types/express, @types/ws, tsx (for running server in dev)
```

---

## Chunks

### Phase 1: Foundation

#### Chunk 0: Scaffolding + Shared Types
**Model:** sonnet
**Parallel:** none (must complete first)
**Scope:**
- Create `src/shared/protocol.ts` with all message types
- Create `src/server/index.ts` skeleton (Express + ws, serves static files, WebSocket upgrade)
- Add server dependencies to package.json
- Add `dev:server` and `dev:client` scripts
- Update vite.config.ts with WebSocket proxy to port 3000

**Tests (write first):**
- `protocol.ts` types compile
- Server starts on port 3000 and responds to HTTP health check
- WebSocket connection established and receives welcome message

**Eval:** `npm run test:chunk0` passes

---

### Phase 2: Backend Core (parallel)

#### Chunk A: tmux + pty bridge
**Model:** opus
**Parallel with:** Chunk B
**Scope:**
- `src/server/tmux.ts`:
  - `listWindows()` — parse `tmux list-windows -F '#{window_id} #{window_name} #{pane_current_path}'`
  - `createWindow(name?, cwd?)` — `tmux new-window`
  - `killWindow(id)` — `tmux kill-window`
  - `renameWindow(id, name)` — `tmux rename-window`
- `src/server/pty-bridge.ts`:
  - `attachToWindow(windowId)` — spawn `node-pty` process attached to tmux pane
  - Pipe pty output → WebSocket `terminal:output` messages
  - Pipe WebSocket `terminal:input` → pty input
  - Handle resize events
  - Clean up pty on disconnect
- Wire into server: handle `terminal:*` and `session:*` WebSocket messages

**Tests (write first):**
- `tmux.ts`: mock `child_process.execSync` — verify `listWindows` parses tmux output correctly for 0, 1, and 3 windows
- `tmux.ts`: verify `createWindow` calls correct tmux command
- `tmux.ts`: verify `killWindow` and `renameWindow` call correct commands
- `pty-bridge.ts`: mock `node-pty` — verify data flows from pty.onData → WebSocket send
- `pty-bridge.ts`: verify WebSocket message → pty.write
- `pty-bridge.ts`: verify resize message → pty.resize
- `pty-bridge.ts`: verify cleanup on WebSocket close

**Eval:** `npm run test:chunkA` passes

---

#### Chunk B: Filesystem API
**Model:** sonnet
**Parallel with:** Chunk A
**Scope:**
- `src/server/files.ts`:
  - `getTree(cwd)` — recursive directory listing, respecting .gitignore, max depth 5
  - `readFile(path)` — read file contents, enforce path is under cwd
  - `writeFile(path, content)` — write file, enforce path is under cwd
  - `watchDir(cwd, onChange)` — chokidar watcher, debounced, pushes changes
- Wire into server: handle `files:*` WebSocket messages
- Path traversal protection: reject paths containing `..` or starting with `/`

**Tests (write first):**
- `getTree`: create temp dir with nested structure, verify output matches
- `getTree`: verify .gitignore patterns are respected
- `getTree`: verify max depth is enforced
- `readFile`: verify reads content correctly
- `readFile`: verify rejects path traversal (`../etc/passwd`)
- `writeFile`: verify writes and reads back
- `writeFile`: verify rejects path traversal
- `watchDir`: verify change callback fires on file edit (use temp dir)

**Eval:** `npm run test:chunkB` passes

---

### Phase 3: Frontend Wiring (parallel)

#### Chunk C: Wire terminal + sidebar to backend
**Model:** sonnet
**Parallel with:** Chunk D
**Depends on:** Chunk A
**Scope:**
- `src/client/hooks/useSocket.ts`:
  - WebSocket connection manager
  - Auto-reconnect with backoff
  - Message send/receive typed to protocol
  - Connection state (connecting / connected / disconnected)
- Update `Terminal.tsx`:
  - On mount: send `terminal:attach` with windowId
  - Pipe `terminal:output` → xterm.write
  - Pipe xterm.onData → `terminal:input`
  - Send `terminal:resize` on fit
  - Show connection status overlay when disconnected
- Update `Sidebar.tsx`:
  - Fetch session list on mount via `session:list`
  - Live-update on `session:created`, `session:killed`, `session:renamed`
  - Create/rename/kill buttons call real WebSocket messages
- Update `App.tsx`:
  - Pass socket to children via context or props
  - Remove mock session data, use live data

**Tests (write first):**
- `useSocket`: mock WebSocket — verify reconnect fires after disconnect
- `useSocket`: verify messages are typed correctly
- Terminal: mock socket — verify `terminal:attach` sent on mount
- Terminal: verify `terminal:output` message calls xterm.write
- Sidebar: mock socket — verify session list renders from `session:list` response
- Sidebar: verify create button sends `session:create` message

**Eval:** `npm run test:chunkC` passes

---

#### Chunk D: Wire file panel to backend
**Model:** sonnet
**Parallel with:** Chunk C
**Depends on:** Chunk B
**Scope:**
- Update `FilePanel.tsx`:
  - Fetch tree from server via `files:tree` on open
  - Load file content via `files:read` on file click
  - Save edits via `files:write`
  - Subscribe to `files:changed` for live updates
  - Show loading states
  - Remove mock data
- Update `MarkdownEditor.tsx`:
  - Accept `onSave` callback
  - Ctrl+S / Cmd+S triggers save

**Tests (write first):**
- FilePanel: mock socket — verify `files:tree` sent on panel open
- FilePanel: verify tree renders from response
- FilePanel: verify file click sends `files:read`
- FilePanel: verify save button sends `files:write`
- MarkdownEditor: verify Cmd+S triggers onSave callback

**Eval:** `npm run test:chunkD` passes

---

### Phase 4: Polish

#### Chunk E: Session handoff + deployment config
**Model:** sonnet
**Depends on:** Chunks C, D
**Scope:**
- Session handoff:
  - Server tracks connected clients per window (by WebSocket connection)
  - When a second client attaches to an owned window, show confirmation
  - "Take over" sends `terminal:attach` which detaches the previous client
  - Sidebar shows ownership status from server state
- Deployment:
  - `ecosystem.config.cjs` for pm2 (runs server in production)
  - `npm run build` produces static client + server bundle
  - `npm run start` runs production server
  - Tailscale Serve config: `tailscale serve --bg 3000`

**Tests (write first):**
- Handoff: mock two WebSocket clients — verify second attach detaches first
- Handoff: verify ownership state broadcasts to all clients
- Build: verify `npm run build` produces dist/ with server and client
- Start: verify `npm run start` boots server (mock pty)

**Eval:** `npm run test:chunkE` passes

---

### Phase 5: Review

#### Chunk F: Parsimony Review
**Model:** opus
**Scope:**
- Review all written code for:
  - Duplicated logic between chunks
  - Abstractions that can be consolidated
  - Dead code from the mock/demo phase
  - Type definitions that can be simplified
  - CSS that can be deduplicated
  - Error handling consistency
- Apply fixes
- Run all tests to verify nothing broke

**Eval:** all prior test suites still pass + LOC reduced or equal

---

### Phase 6: End-to-End

#### Chunk G: E2E tests
**Model:** opus
**Scope:**
- Integration tests that run on the VM:
  - Start server, connect WebSocket, verify session list matches real tmux
  - Send terminal input, verify output arrives
  - Create window, verify it appears in tmux and session list
  - Kill window, verify cleanup
  - Read file tree, verify matches actual filesystem
  - Write file, verify persisted to disk
  - Two clients: first attaches, second takes over, first gets detached
- Write a `test:e2e` script
- Write a one-line deploy doc for the VM

**Eval:** `npm run test:e2e` passes on VM

---

## Dependency Graph

```
                ┌─── Chunk A (tmux+pty) ──→ Chunk C (wire terminal+sidebar) ──┐
Chunk 0 ───────┤                                                               ├──→ Chunk E ──→ Chunk F ──→ Chunk G
(scaffolding)  └─── Chunk B (filesystem) ──→ Chunk D (wire file panel) ───────┘
                     [parallel]                [parallel]
```

## Phase Summary

| Phase | Chunks | Parallel? | Model | VM deploy needed? |
|-------|--------|-----------|-------|-------------------|
| 1     | 0      | no        | sonnet | no               |
| 2     | A, B   | yes       | opus, sonnet | no        |
| 3     | C, D   | yes       | sonnet, sonnet | no     |
| 4     | E      | no        | sonnet | no               |
| 5     | F      | no        | opus   | no               |
| 6     | G      | no        | opus   | yes — first deploy |

## Deploy Command (run on VM at each phase boundary)

```bash
cd ~/nest && git pull && npm install && npm run build && pm2 restart nest 2>/dev/null || pm2 start ecosystem.config.cjs
```

## Simplify Reviews

Run `/simplify` after Phase 3 (all wiring done) and after Phase 5 (parsimony review complete) to maximize elegance before E2E.
