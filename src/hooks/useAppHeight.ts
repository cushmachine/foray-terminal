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
    // Baseline: the viewport height at mount (before any keyboard). On
    // Android window.innerHeight shrinks WITH the keyboard, so comparing
    // against a live value never detects it. Captured once; reset only on
    // orientation change.
    let fullHeight = window.innerHeight

    const apply = () => {
      const h = appHeight(vv, window.innerHeight)
      root.style.setProperty(APP_HEIGHT_VAR, `${h}px`)
      if (window.scrollY !== 0) window.scrollTo(0, 0)
      setKeyboardVisible(h < fullHeight * 0.75)
    }

    const onOrientationChange = () => {
      setTimeout(() => {
        fullHeight = window.innerHeight
        apply()
      }, 300)
    }

    apply()
    vv?.addEventListener('resize', apply)
    vv?.addEventListener('scroll', apply)
    window.addEventListener('resize', apply)
    window.addEventListener('orientationchange', onOrientationChange)
    return () => {
      vv?.removeEventListener('resize', apply)
      vv?.removeEventListener('scroll', apply)
      window.removeEventListener('resize', apply)
      window.removeEventListener('orientationchange', onOrientationChange)
      root.style.removeProperty(APP_HEIGHT_VAR)
    }
  }, [])

  return { keyboardVisible }
}
