// Static evals for AUDIT.md items whose fix is a code shape a browser test
// cannot see directly (renderer choice, tmux options, test ids). The
// behaviour itself is covered by src/visual/*.spec.ts and src/e2e/keys.e2e.test.ts.
//
// Run with: npm run test:visual-audit

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; scripts: Record<string, string> }

describe('#1 mobile drawer', () => {
  it('is visibility-hidden while closed, so nothing inside it is reachable', () => {
    const src = read('src/Sidebar.tsx')
    assert.match(src, /visibility:\s*isOpen\s*\?\s*'visible'\s*:\s*'hidden'/)
  })
  it('the close button has a stable test id', () => {
    assert.ok(read('src/Sidebar.tsx').includes('data-testid="sidebar-close"'))
  })
})

describe('#2 terminal renderer', () => {
  it('depends on @xterm/addon-webgl', () => {
    assert.ok('@xterm/addon-webgl' in pkg.dependencies)
  })
  it('loads the WebGL addon and falls back to the DOM renderer on context loss or failure', () => {
    const src = read('src/Terminal.tsx')
    assert.ok(src.includes('WebglAddon'), 'Terminal.tsx should load WebglAddon')
    assert.ok(src.includes('onContextLoss'), 'should dispose the addon on WebGL context loss')
    assert.match(src, /try\s*\{[\s\S]*WebglAddon[\s\S]*\}\s*catch/, 'loading must be wrapped in try/catch for browsers without WebGL')
  })
  it('publishes the active terminal for tests', () => {
    assert.ok(read('src/Terminal.tsx').includes('__nest'))
  })
})

describe('#11 sidebar footer', () => {
  it('the session list can shrink below its content so the footer stays on screen', () => {
    const src = read('src/Sidebar.tsx')
    const list = src.slice(src.indexOf('data-testid="session-list"'), src.indexOf('data-testid="session-list"') + 400)
    assert.match(list, /minHeight:\s*0/)
  })
})

describe('#17 clipboard', () => {
  it('copies the selection to the system clipboard when the selection changes', () => {
    const src = read('src/Terminal.tsx')
    assert.ok(src.includes('onSelectionChange'), 'should listen for selection changes')
    assert.ok(src.includes('clipboard.writeText'), 'should write the selection to navigator.clipboard')
  })
})

describe('#18 Shift+Enter through tmux', () => {
  it('the server asks tmux to pass extended keys to panes as CSI u', () => {
    const src = read('src/server/tmux.ts')
    assert.ok(src.includes("'extended-keys'") && src.includes("'always'"), 'tmux.ts should set extended-keys always')
    assert.ok(src.includes("'extended-keys-format'") && src.includes("'csi-u'"), 'tmux.ts should set extended-keys-format csi-u')
  })
  it('install.sh writes the same options into ~/.tmux.conf', () => {
    const src = read('install.sh')
    assert.ok(src.includes('extended-keys always'))
    assert.ok(src.includes('extended-keys-format csi-u'))
  })
})

describe('#21 test infrastructure', () => {
  const ids: Array<[string, string[]]> = [
    ['src/Sidebar.tsx', ['sidebar', 'sidebar-close', 'session-list', 'session-row', 'session-item', 'session-rename', 'session-kill', 'session-name-input', 'new-session']],
    ['src/App.tsx', ['sidebar-backdrop', 'terminal-area']],
    ['src/TopBar.tsx', ['sidebar-toggle', 'files-toggle']],
    ['src/KeyToolbar.tsx', ['key-toolbar', 'key-toolbar-row', 'keytoolbar-fade-right']],
    ['src/Terminal.tsx', ['terminal']],
    ['src/FilePanel.tsx', ['file-panel']],
    ['src/VersionBanner.tsx', ['version-banner']],
  ]
  for (const [file, wanted] of ids) {
    it(`${file} carries data-testid ${wanted.join(', ')}`, () => {
      const src = read(file)
      for (const id of wanted) assert.ok(src.includes(`data-testid="${id}"`), `${file} lacks data-testid="${id}"`)
    })
  }
  it('has a test:visual script that runs the Playwright suite', () => {
    assert.match(pkg.scripts['test:visual'] ?? '', /playwright test/)
  })
})
