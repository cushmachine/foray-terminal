// Pure helpers behind the mobile layout: which viewports count as "mobile",
// edge-swipe detection for the sidebar drawer, and the persisted terminal
// font size. No DOM here so it can be unit tested; App.tsx wires it up.

/** Viewports narrower than this get the phone layout (drawer sidebar, view toggle). */
export const MOBILE_MAX_WIDTH = 768
/**
 * A touch device shorter than this is a phone in landscape. It's wider than
 * MOBILE_MAX_WIDTH, but a fixed 240px sidebar next to a 390px-tall terminal
 * is not a desktop experience.
 */
export const MOBILE_LANDSCAPE_MAX_HEIGHT = 500

/** matchMedia form of isMobileViewport, so the two can't drift apart. */
export const MOBILE_MEDIA_QUERY =
  `(max-width: ${MOBILE_MAX_WIDTH - 1}px), ` +
  `((pointer: coarse) and (max-height: ${MOBILE_LANDSCAPE_MAX_HEIGHT}px))`

export interface ViewportInfo {
  width: number
  height: number
  /** True for a touch-first device (`pointer: coarse`). */
  coarse: boolean
}

export function isMobileViewport({ width, height, coarse }: ViewportInfo): boolean {
  if (width < MOBILE_MAX_WIDTH) return true
  return coarse && height <= MOBILE_LANDSCAPE_MAX_HEIGHT
}

// ---------------------------------------------------------------------------
// Sidebar swipe
// ---------------------------------------------------------------------------

export interface Point {
  x: number
  y: number
}

/** A swipe must start this close to the left edge to open the drawer. */
export const SWIPE_EDGE_PX = 28
/** Minimum horizontal travel for a gesture to count as a swipe. */
export const SWIPE_DISTANCE_PX = 50

/**
 * What a completed touch gesture should do to the drawer, if anything.
 * Opening requires starting at the screen's left edge so ordinary terminal
 * scrolling and text selection are never mistaken for it; closing accepts a
 * leftward swipe anywhere, since the drawer and its backdrop cover the
 * screen while it's open. Mostly-vertical movement is never a swipe.
 */
export function swipeAction(
  start: Point,
  end: Point,
  sidebarOpen: boolean,
): 'open' | 'close' | null {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (Math.abs(dx) < SWIPE_DISTANCE_PX || Math.abs(dy) > Math.abs(dx)) return null
  if (!sidebarOpen && dx > 0 && start.x <= SWIPE_EDGE_PX) return 'open'
  if (sidebarOpen && dx < 0) return 'close'
  return null
}

// ---------------------------------------------------------------------------
// Terminal font size
// ---------------------------------------------------------------------------

export const FONT_SIZE_KEY = 'nest:fontSize'
export const MIN_FONT_SIZE = 10
export const MAX_FONT_SIZE = 22

/**
 * Phones get a smaller default: at 14px a portrait iPhone fits about 44
 * columns, which wraps Claude Code's UI badly. 13px gets it to ~48, and the
 * user can go smaller from the sidebar.
 */
export function defaultFontSize(isMobile: boolean): number {
  return isMobile ? 13 : 14
}

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return MIN_FONT_SIZE
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)))
}

/** Parse a stored font size, falling back for anything that isn't a sane number. */
export function readFontSize(raw: string | null | undefined, fallback: number): number {
  if (raw === null || raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return clampFontSize(parsed)
}

// ---------------------------------------------------------------------------
// Side panels: exclusive on tablets so the terminal is never squeezed
// ---------------------------------------------------------------------------

/**
 * Below this width the sidebar and the file panel are exclusive: with both
 * open on a 768px tablet the terminal is squeezed to ~230px and wraps every
 * few characters. Desktop widths keep them independent.
 */
export const TABLET_MAX_WIDTH = 1024

export interface PanelState {
  sidebarOpen: boolean
  filePanelOpen: boolean
}

export type PanelAction = 'toggle-sidebar' | 'toggle-files' | 'open-files'

/** The panel state after `action`, given the viewport width. */
export function resolvePanels(state: PanelState, action: PanelAction, width: number): PanelState {
  const exclusive = width < TABLET_MAX_WIDTH
  switch (action) {
    case 'toggle-sidebar': {
      const sidebarOpen = !state.sidebarOpen
      return { sidebarOpen, filePanelOpen: exclusive && sidebarOpen ? false : state.filePanelOpen }
    }
    case 'toggle-files': {
      const filePanelOpen = !state.filePanelOpen
      return { sidebarOpen: exclusive && filePanelOpen ? false : state.sidebarOpen, filePanelOpen }
    }
    case 'open-files':
      return { sidebarOpen: exclusive ? false : state.sidebarOpen, filePanelOpen: true }
  }
}

// ---------------------------------------------------------------------------
// Key toolbar on desktop: off by default next to a physical keyboard
// ---------------------------------------------------------------------------

export const KEY_TOOLBAR_KEY = 'nest:keyToolbar'

/**
 * Whether the key toolbar shows. Touch layouts always need it. On desktop
 * it is clutter next to a physical keyboard, so it is off unless the user
 * turned it on and that choice was stored.
 */
export function readToolbarVisible(raw: string | null | undefined, isMobile: boolean): boolean {
  if (isMobile) return true
  return raw === 'true'
}
