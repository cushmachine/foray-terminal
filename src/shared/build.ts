// Build identity shared by the client bundle and the server.
//
// vite stamps every build with an id, `<short-sha>[-dirty].<timestamp>`, in
// a <meta> tag in index.html (see vite.config.ts). The server reads that tag
// from the dist/ it serves and reports it, with its own start commit, in
// `server:hello`. A page compares both to the id it was built with to notice
// drift (src/version.ts). Pure string helpers only: this file is bundled
// into the client.

export const BUILD_META_NAME = 'nest-build'

/** The build id stamped into a built index.html, or null if it has none. */
export function readBuildIdFromHtml(html: string): string | null {
  const tag = new RegExp(`<meta\\s+name="${BUILD_META_NAME}"\\s+content="([^"]*)"`)
  const match = html.match(tag)
  return match && match[1] !== '' ? match[1] : null
}

/** The commit part of a build id: `abc1234-dirty.kx9q2` -> `abc1234-dirty`. */
export function commitOf(buildId: string): string {
  const dot = buildId.indexOf('.')
  return dot === -1 ? buildId : buildId.slice(0, dot)
}
