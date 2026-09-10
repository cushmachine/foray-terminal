// Client side of the version handshake: what this page was built from,
// and what to tell the user when the server disagrees.

import { BUILD_META_NAME, commitOf } from './shared/build'
import type { ServerHelloMessage } from './shared/protocol'

export interface VersionNotice {
  /** 'stale-page': a reload fixes it. 'server-drift': the server needs a rebuild and restart. */
  kind: 'stale-page' | 'server-drift'
  text: string
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
    return { kind: 'stale-page', text: 'Foray was updated. Reload to get the new version.' }
  }

  // The server process was started from a different commit than this page
  // was built from. A reload cannot fix that; only a rebuild and restart on
  // the server can. 'unknown' means no git either side; nothing to compare.
  const pageCommit = commitOf(pageBuild)
  if (hello.serverBuild !== 'unknown' && pageCommit !== 'unknown' && hello.serverBuild !== pageCommit) {
    return {
      kind: 'server-drift',
      text: `Server started from ${hello.serverBuild}, this page was built from ${pageCommit}. Rebuild and restart Foray to sync.`,
    }
  }
  return null
}
