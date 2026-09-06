// Audit eval — verifies each finding from the codebase audit has been addressed.
// Run with: tsx src/__tests__/audit-eval.ts
// Each check prints PASS/FAIL and a one-line description.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const SRC = path.join(ROOT, 'src')

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf-8')
}

function fileExists(rel: string): boolean {
  return fs.existsSync(path.join(SRC, rel))
}

// ─── SECURITY ────────────────────────────────────────────────────────────────

describe('Security', () => {

  it('S1: files:tree cwd is validated against session cwd', () => {
    const server = readSrc('server/index.ts')
    // Should NOT accept msg.cwd directly without validation
    const hasRawCwd = /case\s+'files:tree'[\s\S]{0,200}currentCwd\s*=\s*msg\.cwd\s*\n\s*const entries = await getTree\(msg\.cwd\)/.test(server)
    assert.ok(!hasRawCwd, 'files:tree should validate cwd before using it')
  })

  it('S2: resolveSafePath uses fs.realpath to follow symlinks', () => {
    const files = readSrc('server/files.ts')
    assert.ok(files.includes('realpath'), 'resolveSafePath should use fs.realpath')
  })

  it('S3: WebSocket messages are validated at runtime', () => {
    const server = readSrc('server/index.ts')
    // Should not have bare `as ClientMessage` without validation
    const hasBarecast = /JSON\.parse\(.*\)\s+as\s+ClientMessage/.test(server)
    assert.ok(!hasBarecast, 'Should validate messages at runtime, not just cast')
  })

  it('S4: terminal:resize clamps cols and rows', () => {
    // Check either server/index.ts or wherever the handler lives
    const allServer = fs.readdirSync(path.join(SRC, 'server'))
      .filter(f => f.endsWith('.ts') && !f.includes('test'))
      .map(f => readSrc(`server/${f}`))
      .join('\n')
    // Should clamp or validate cols/rows to reasonable ranges
    const clampsOrValidates = /cols.*Math\.(min|max|clamp)|rows.*Math\.(min|max|clamp)|cols\s*[<>]=?\s*\d|validateResize/.test(allServer)
    assert.ok(clampsOrValidates, 'terminal:resize should clamp cols/rows to sane ranges')
  })
})

// ─── BUGS ────────────────────────────────────────────────────────────────────

describe('Bugs', () => {

  it('B1: MarkdownEditor recreates on content change (not just readOnly)', () => {
    const editor = readSrc('MarkdownEditor.tsx')
    // The effect should depend on content, or dispatch a doc replacement
    const hasContentDep = /\[.*content.*\]/.test(editor) || /view\.dispatch|replaceAll|doc\.replace/.test(editor)
    assert.ok(hasContentDep, 'MarkdownEditor effect should respond to content changes')
  })

  it('B2: FilePanel re-fetches open file on reconnect', () => {
    const panel = readSrc('FilePanel.tsx')
    // The connected effect should re-fetch the open file via openFileRef
    const handlesReconnect = panel.includes('openFileRef') && panel.includes("files:read")
    assert.ok(handlesReconnect, 'FilePanel should re-fetch the open file on reconnect')
  })

  it('B3: editContent empty string is preserved (no || fallback)', () => {
    const panel = readSrc('FilePanel.tsx')
    // Should NOT have `editContent || fileContent` — should use ?? or ternary
    const hasBadFallback = /editContent\s*\|\|\s*fileContent/.test(panel)
    assert.ok(!hasBadFallback, 'Should use ?? or ternary, not || which loses empty string')
  })

  it('B4: Error messages are routed to the correct error state', () => {
    const panel = readSrc('FilePanel.tsx')
    // Should NOT set both treeError and fileError for every error
    const setsBoth = /setTreeError\(msg\.message\)\s*\n\s*setFileError\(msg\.message\)/.test(panel)
    assert.ok(!setsBoth, 'Should not set both treeError and fileError on every error')
  })

  it('B5: ResizeHandle handles pointercancel', () => {
    const panel = readSrc('FilePanel.tsx')
    assert.ok(panel.includes('onPointerCancel') || panel.includes('pointercancel'),
      'ResizeHandle should handle pointercancel')
  })

  it('B6: session:rename sanitizes name', () => {
    const tmux = readSrc('server/tmux.ts')
    // Should strip or reject . and : in session names
    const sanitizes = /replace.*[.:]|[.:].*reject|sanitize|invalid.*name/.test(tmux)
      || /\.replace\(\/\[.*\\.\]/.test(tmux)
    assert.ok(sanitizes, 'renameWindow should sanitize . and : from session names')
  })

  it('B7: Orphaned JSDoc comment fixed in protocol.ts', () => {
    const protocol = readSrc('shared/protocol.ts')
    // The TerminalDetachedMessage comment should be immediately above its interface
    const lines = protocol.split('\n')
    const detachedIdx = lines.findIndex(l => l.includes('interface TerminalDetachedMessage'))
    // Check the comment block just above it mentions "taken over" or "detached"
    if (detachedIdx > 0) {
      const above = lines.slice(Math.max(0, detachedIdx - 6), detachedIdx).join(' ')
      assert.ok(above.includes('taken over') || above.includes('detach') || above.includes('Sent to a client'),
        'Comment about detachment should be above TerminalDetachedMessage')
    }
  })
})

// ─── HARDENING ───────────────────────────────────────────────────────────────

describe('Hardening', () => {

  it('H1: File reads have a size limit', () => {
    const files = readSrc('server/files.ts')
    assert.ok(files.includes('stat') || files.includes('MAX_FILE') || files.includes('size'),
      'readFile should check file size before reading')
  })

  it('H2: Error messages sent to client are sanitized', () => {
    const allServer = fs.readdirSync(path.join(SRC, 'server'))
      .filter(f => f.endsWith('.ts') && !f.includes('test'))
      .map(f => readSrc(`server/${f}`))
      .join('\n')
    // Should not send raw err.message to client
    const sendsRawError = /send\(ws,\s*\{\s*type:\s*'error',\s*message:\s*err\s*(instanceof\s+Error\s*\?\s*err\.message|\.message)/.test(allServer)
    assert.ok(!sendsRawError, 'Should not send raw error messages to client')
  })

  it('H3: escapeHtml handles single quotes', () => {
    const ansi = readSrc('ansi.ts')
    assert.ok(ansi.includes("'") && /['']/.test(ansi.match(/HTML_ESCAPES.*?}/s)?.[0] ?? ''),
      'escapeHtml should escape single quotes')
  })
})

// ─── SIMPLIFICATION ─────────────────────────────────────────────────────────

describe('Simplification', () => {

  it('X1: theme.ts exists with shared font and color constants', () => {
    assert.ok(fileExists('theme.ts'), 'src/theme.ts should exist')
    const theme = readSrc('theme.ts')
    assert.ok(theme.includes('MONO') || theme.includes('fontFamily') || theme.includes('font'),
      'theme.ts should export a shared font constant')
    assert.ok(theme.includes('#0a0a0c') || theme.includes('COLORS') || theme.includes('background'),
      'theme.ts should export color constants')
  })

  it('X2: server/index.ts is under 450 lines', () => {
    const server = readSrc('server/index.ts')
    const lines = server.split('\n').length
    assert.ok(lines < 450, `server/index.ts is ${lines} lines, should be under 450`)
  })

  it('X3: FilePanel.tsx is under 530 lines (MarkdownRenderer extracted)', () => {
    const panel = readSrc('FilePanel.tsx')
    const lines = panel.split('\n').length
    assert.ok(lines < 530, `FilePanel.tsx is ${lines} lines, should be under 530 after MarkdownRenderer extraction`)
  })

  it('X4: MarkdownRenderer is in its own file', () => {
    assert.ok(fileExists('MarkdownRenderer.tsx'), 'MarkdownRenderer.tsx should exist')
  })

  it('X5: TopBar is extracted from App.tsx', () => {
    const app = readSrc('App.tsx')
    const lines = app.split('\n').length
    assert.ok(lines < 380, `App.tsx is ${lines} lines, should be under 380 after TopBar extraction`)
  })

  it('X6: Font constant is imported from theme.ts (not defined locally)', () => {
    const sidebar = readSrc('Sidebar.tsx')
    const app = readSrc('App.tsx')
    // These files should import from theme.ts, not define MONO locally
    const sidebarDefinesMono = /^const MONO\s*=/m.test(sidebar)
    const appDefinesMono = /^const MONO\s*=/m.test(app)
    assert.ok(!sidebarDefinesMono, 'Sidebar should import MONO from theme.ts')
    assert.ok(!appDefinesMono, 'App should import MONO from theme.ts')
  })
})

// ─── CODE QUALITY ────────────────────────────────────────────────────────────

describe('Code Quality', () => {

  it('Q1: Test files have descriptive names (not chunk*)', () => {
    const clientTests = fs.readdirSync(path.join(SRC, '__tests__'))
      .filter(f => f.endsWith('.test.ts') && f !== 'audit-eval.ts')
    const serverTests = fs.readdirSync(path.join(SRC, 'server/__tests__'))
      .filter(f => f.endsWith('.test.ts'))
    const allTests = [...clientTests, ...serverTests]
    const chunkTests = allTests.filter(f => /^chunk[0-9A-Z]/i.test(f))
    assert.ok(chunkTests.length === 0,
      `Found chunk-named tests: ${chunkTests.join(', ')}. All should have descriptive names.`)
  })

  it('Q2: Unused Session re-export removed from App.tsx', () => {
    const app = readSrc('App.tsx')
    assert.ok(!app.includes("export type { Session }"),
      'App.tsx should not re-export Session type')
  })

  it('Q3: Error boundary exists', () => {
    const main = readSrc('main.tsx')
    const hasErrorBoundary = main.includes('ErrorBoundary')
      || fileExists('ErrorBoundary.tsx')
      || fileExists('components/ErrorBoundary.tsx')
    assert.ok(hasErrorBoundary, 'App should have an ErrorBoundary')
  })

  it('Q4: Firefox scrollbar styling exists', () => {
    const css = readSrc('styles.css')
    assert.ok(css.includes('scrollbar-width') || css.includes('scrollbar-color'),
      'styles.css should include Firefox scrollbar styling')
  })

  it('Q5: package.json has a unified test script', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
    assert.ok(pkg.scripts.test, 'package.json should have a "test" script')
  })
})
