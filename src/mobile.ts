// The mobile layout's two axes, and the pure helpers behind them.
//
// Touch (`IS_TOUCH`, static): the device has a coarse pointer. Decides
// input policy that never changes while the page lives: DOM renderer so
// long-press selection works, fixed pty height under the soft keyboard,
// the Composer instead of typing into xterm, no copy-on-select.
//
// Mobile (`useIsMobile`, live): the viewport is phone-sized, or a touch
// device held in landscape. Decides layout: the drawer sidebar, the
// terminal/files view toggle, panel exclusivity. It changes on rotation
// and window resize, so it is state.
//
// A touch tablet in portrait is touch but not mobile; a narrow desktop
// window is mobile but not touch. Everything below is DOM-free and unit
// tested except the two axis readers themselves.

import { useEffect, useState } from 'react'

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

/** Touch-first device (`pointer: coarse`). Read once: it does not change while the page lives. */
export const IS_TOUCH =
  typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches

/** The mobile axis right now; the initial value for state that must know it before the first effect. */
export function detectMobile(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof window.matchMedia === 'function') return window.matchMedia(MOBILE_MEDIA_QUERY).matches
  return isMobileViewport({ width: window.innerWidth, height: window.innerHeight, coarse: IS_TOUCH })
}

/**
 * Phone layout or desktop layout. Driven by a media query rather than a
 * bare width check so a phone held in landscape (wide but very short, with
 * a touch pointer) still gets the drawer sidebar instead of losing a third
 * of its height to a fixed one.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(detectMobile)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(MOBILE_MEDIA_QUERY)
    const handler = () => setIsMobile(mql.matches)
    handler()
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])
  return isMobile
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

/** Desktop file panel width, in px: the user drags it between the bounds. */
export const FILE_PANEL_MIN_WIDTH = 200
export const FILE_PANEL_MAX_WIDTH = 800
export const FILE_PANEL_DEFAULT_WIDTH = 320

export function clampFilePanelWidth(width: number): number {
  if (!Number.isFinite(width)) return FILE_PANEL_DEFAULT_WIDTH
  return Math.min(FILE_PANEL_MAX_WIDTH, Math.max(FILE_PANEL_MIN_WIDTH, Math.round(width)))
}

/** Which of the two full-width views a phone shows; desktop shows both side by side. */
export type MobileView = 'terminal' | 'files'

export interface PanelState {
  sidebarOpen: boolean
  filePanelOpen: boolean
  /** Only read when the layout is mobile; desktop leaves it alone. */
  mobileView: MobileView
}

export type PanelAction =
  | 'toggle-sidebar'
  | 'open-sidebar'
  | 'close-sidebar'
  /** The file panel button or shortcut: a phone flips views, desktop toggles the panel. */
  | 'toggle-files'
  | 'open-files'
  /** A file was picked in the tree. */
  | 'open-file'
  /** The open file was closed, back to the tree (desktop) or the terminal (phone). */
  | 'close-file'
  /** A session was picked, or the one this client created arrived. */
  | 'select-session'
  | 'show-terminal'
  | 'show-files'

/**
 * The panel state after `action`. On desktop and tablet widths the sidebar
 * and file panel are real panels, exclusive below TABLET_MAX_WIDTH. On a
 * phone the sidebar is a drawer and the file panel is one of two views;
 * a drawer is closed by anything that shows content behind it.
 */
export function resolvePanels(
  state: PanelState,
  action: PanelAction,
  width: number,
  isMobile: boolean,
): PanelState {
  const exclusive = width < TABLET_MAX_WIDTH
  const withSidebar = (sidebarOpen: boolean): PanelState => ({
    ...state,
    sidebarOpen,
    filePanelOpen: exclusive && sidebarOpen ? false : state.filePanelOpen,
  })
  const withFiles = (filePanelOpen: boolean): PanelState => ({
    ...state,
    sidebarOpen: exclusive && filePanelOpen ? false : state.sidebarOpen,
    filePanelOpen,
  })
  const view = (mobileView: MobileView, sidebarOpen = state.sidebarOpen): PanelState =>
    ({ ...state, sidebarOpen, mobileView })

  switch (action) {
    case 'toggle-sidebar':
      return withSidebar(!state.sidebarOpen)
    case 'open-sidebar':
      return withSidebar(true)
    case 'close-sidebar':
      return withSidebar(false)
    case 'toggle-files':
      if (isMobile) return view(state.mobileView === 'files' ? 'terminal' : 'files')
      return withFiles(!state.filePanelOpen)
    case 'open-files':
      return withFiles(true)
    case 'open-file':
      return isMobile ? view('files', false) : withFiles(true)
    case 'close-file':
      return isMobile ? view('terminal') : state
    case 'select-session':
      return isMobile ? view('terminal', false) : state
    case 'show-terminal':
      return isMobile ? view('terminal') : state
    case 'show-files':
      return isMobile ? view('files') : state
  }
}

// ---------------------------------------------------------------------------
// Key toolbar on desktop: off by default next to a physical keyboard
// ---------------------------------------------------------------------------

/**
 * Whether the key toolbar shows. Touch layouts always need it. On desktop
 * it is clutter next to a physical keyboard, so it is off unless the user
 * turned it on and that choice was stored.
 */
export function readToolbarVisible(raw: string | null | undefined, isMobile: boolean): boolean {
  if (isMobile) return true
  return raw === 'true'
}
