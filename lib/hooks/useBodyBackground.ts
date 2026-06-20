'use client'

import { useEffect } from 'react'

/**
 * Override `<body>` background and `<meta name="theme-color">` for the
 * lifetime of the calling component.
 *
 * iOS Safari quirks this hook works around:
 * - Bottom bar  → reads `document.body.style.backgroundColor`, but only
 *   repaints on scroll **or** when theme-color *changes*.  We nudge
 *   theme-color by appending `fe` then restoring it to trigger the repaint.
 *
 * When the component unmounts the inline style is cleared (so your
 * Tailwind / CSS class wins again) and the previous theme-color is restored.
 */
export function useBodyBackground( bg: string ) {
  useEffect( () => {
    document.body.style.backgroundColor = bg

    // Ensure a <meta name="theme-color"> tag exists and stash the old value.
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    ) ?? ( () => {
      const m = document.createElement( 'meta' )
      m.name = 'theme-color'
      document.head.appendChild( m )
      
      return m
    } )()
    const prevTheme = meta.content
    meta.content = bg

    // Nudge theme-color to force the bottom nav bar to re-read
    // body.style.backgroundColor (WebKit quirk).
    const raf = requestAnimationFrame( () => {
      meta.content = bg + 'fe'
      requestAnimationFrame( () => {
        meta.content = bg
      } )
    } )

    return () => {
      cancelAnimationFrame( raf )
      document.body.style.backgroundColor = ''
      if ( prevTheme ) meta.content = prevTheme
      else meta.removeAttribute( 'content' )
    }
  }, [bg] )
}
