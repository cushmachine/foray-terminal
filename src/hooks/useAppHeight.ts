// Sizes the app to the *visual* viewport.
//
// On iOS the layout viewport (what `height: 100%` resolves against) does
// not shrink when the soft keyboard opens; only the visual viewport does.
// A layout sized to 100% therefore keeps its bottom third under the
// keyboard, which for a terminal means the prompt and the key toolbar are
// exactly the parts you can't see. Publishing the visual viewport height as
// a CSS variable lets the root size itself to the visible area, and the
// flex layout plus xterm's ResizeObserver do the rest.

import { useEffect, useState } from 'react'

/** The bit of VisualViewport we read, so the pure helper is testable. */
export interface ViewportLike {
  height: number
  scale: number
}

/** CSS custom property the root reads its height from. */
export const APP_HEIGHT_VAR = '--app-height'

/**
 * Height the app should occupy. Uses the visual viewport when available and
 * unzoomed; a pinch-zoomed viewport reports a smaller height that has
 * nothing to do with the keyboard, so it falls back to the layout height
 * rather than shrinking the UI under the user's fingers.
 */
export function appHeight(viewport: ViewportLike | null | undefined, fallback: number): number {
  if (!viewport) return fallback
  if (viewport.scale > 1.01) return fallback
  if (!(viewport.height > 0)) return fallback
  return Math.round(viewport.height)
}

export function useAppHeight(): { keyboardVisible: boolean } {
  const [keyboardVisible, setKeyboardVisible] = useState(false)

  useEffect(() => {
    const vv = window.visualViewport
    const root = document.documentElement

    const apply = () => {
      root.style.setProperty(APP_HEIGHT_VAR, `${appHeight(vv, window.innerHeight)}px`)
      // iOS may scroll the page to reveal the focused element when the
      // keyboard appears. Nothing here is meant to scroll, so pin it back.
      if (window.scrollY !== 0) window.scrollTo(0, 0)
      // Keyboard is open when the visual viewport is significantly shorter
      // than the layout viewport (pinch-zoom excluded by the scale check
      // inside appHeight).
      setKeyboardVisible(
        !!vv && vv.scale <= 1.01 && vv.height < window.innerHeight * 0.75,
      )
    }

    apply()
    vv?.addEventListener('resize', apply)
    vv?.addEventListener('scroll', apply)
    window.addEventListener('resize', apply)
    window.addEventListener('orientationchange', apply)
    return () => {
      vv?.removeEventListener('resize', apply)
      vv?.removeEventListener('scroll', apply)
      window.removeEventListener('resize', apply)
      window.removeEventListener('orientationchange', apply)
      root.style.removeProperty(APP_HEIGHT_VAR)
    }
  }, [])

  return { keyboardVisible }
}
