// Client side of the version handshake: what this page was built from,
// what to tell the user when the server disagrees, and the one thing that
// fixes each disagreement.

import { BUILD_META_NAME, commitOf } from './shared/build'
import type { ServerHelloMessage, TmuxWindow } from './shared/protocol'

/**
 * What a banner's button does.
 *
 * VersionBanner is handed one handler per id (a Record keyed by this
 * type), so adding an id here fails to compile until App has something for
 * the new button to do. Together with the required `action` below, that is
 * what keeps a notice from ever reaching the screen with nothing to click:
 * "Rebuild and restart Foray to sync" once shipped as text and a dismiss
 * cross, which is an order with no way to obey it.
 */
export const VERSION_ACTION_IDS = ['reload', 'sync'] as const
export type VersionActionId = (typeof VERSION_ACTION_IDS)[number]

export interface VersionAction {
  id: VersionActionId
  /** The button's text. */
  label: string
}

/**
 * The disagreements worth telling the user about. A list, not a bare
 * union, so a test can walk every one of them and check it comes with an
 * action that works (src/__tests__/version.test.ts).
 */
export const VERSION_NOTICE_KINDS = ['stale-page', 'server-drift'] as const
/** 'stale-page': a reload fixes it. 'server-drift': the server is behind this page. */
export type VersionNoticeKind = (typeof VERSION_NOTICE_KINDS)[number]

export interface VersionNotice {
  kind: VersionNoticeKind
  text: string
  /**
   * Required, and rendered unconditionally by VersionBanner: a new kind
   * cannot be added without saying what the user can do about it.
   */
  action: VersionAction
}

/** Load the bundle the server already has on disk. */
const RELOAD: VersionAction = { id: 'reload', label: 'reload' }
/** Build and restart the server itself, in a session on the box (see planSync). */
const SYNC: VersionAction = { id: 'sync', label: 'sync now' }

/**
 * The session "sync now" deploys in, and the lock that keeps one deploy
 * running at a time: a session with this name is taken to be a deploy in
 * flight, so the banner brings it into view instead of starting a second
 * one. Two vite builds at once have OOM-killed every session on this box
 * before. A session an earlier deploy finished in and left behind counts
 * too — there is no telling the two apart from the session list — so App
 * says as much when it lands on one.
 */
export const SYNC_SESSION = 'deploy'

/** What "sync now" runs in that session. */
export const SYNC_COMMAND = 'npm run deploy'

/** What "sync now" should do next: watch the deploy already running, or start one. */
export type SyncStep =
  | { kind: 'focus'; windowId: number }
  | { kind: 'create'; name: string; cwd: string | null }

/**
 * Decide between the two. `serverRoot` is where the server runs from, from
 * `server:hello`; null when the server is old enough not to send it — which
 * is exactly the drift this banner reports — and then the session opens
 * wherever a new session normally would and the command is run there, so a
 * wrong directory is an npm error the user can see and fix in the shell
 * that just opened, rather than a button that quietly does nothing.
 */
export function planSync(
  sessions: readonly Pick<TmuxWindow, 'id' | 'name'>[],
  serverRoot: string | null,
): SyncStep {
  const running = sessions.find((session) => session.name === SYNC_SESSION)
  if (running) return { kind: 'focus', windowId: running.id }
  return { kind: 'create', name: SYNC_SESSION, cwd: serverRoot }
}

/**
 * Whether the session that came back from `session:create` is the one
 * holding the lock. tmux refuses a duplicate name and the server retries
 * with "-1" appended, so any other name means another client created the
 * deploy session between our check and our create: that deploy is running,
 * and this session must not start a second one on top of it.
 */
export function holdsSyncSession(window: Pick<TmuxWindow, 'name'>): boolean {
  return window.name === SYNC_SESSION
}

/** Build id stamped into the current page, or null (dev server, tests). */
export function readPageBuild(
  doc: Pick<Document, 'querySelector'> | undefined = typeof document === 'undefined' ? undefined : document,
): string | null {
  const meta = doc?.querySelector(`meta[name="${BUILD_META_NAME}"]`)
  return meta?.getAttribute('content') || null
}

/**
 * Compare this page's build with the server's `server:hello`. Pure, so it
 * can be tested without a DOM.
 *
 * Only production pages are checked. A dev page (vite dev server) has no
 * bundle on disk to compare against and is expected to be ahead of the
 * server while someone is editing.
 */
export function versionNotice(
  pageBuild: string | null,
  hello: Pick<ServerHelloMessage, 'serverBuild' | 'clientBuild'>,
  isProd: boolean,
): VersionNotice | null {
  if (!isProd || pageBuild === null) return null

  // The bundle on disk is not the one this page is running: the page is
  // stale. Checked first because it is the case a reload actually fixes.
  if (hello.clientBuild !== null && hello.clientBuild !== pageBuild) {
    return { kind: 'stale-page', text: 'Foray was updated. Reload to get the new version.', action: RELOAD }
  }

  // The server process was started from a different commit than this page
  // was built from — usually a build that reached dist/ without the
  // restart that would have picked it up. A reload cannot fix that; only a
  // rebuild and restart on the box can, which is what "sync now" runs.
  // 'unknown' means no git either side; nothing to compare.
  const pageCommit = commitOf(pageBuild)
  if (hello.serverBuild !== 'unknown' && pageCommit !== 'unknown' && hello.serverBuild !== pageCommit) {
    return {
      kind: 'server-drift',
      text: `Foray's server is still running ${hello.serverBuild}, not the ${pageCommit} this page was built from. Sync to rebuild and restart it.`,
      action: SYNC,
    }
  }
  return null
}
