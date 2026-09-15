import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Known first-path-segment prefixes that the app actually serves.
 * Everything else is a 404 and gets redirected to the homepage.
 */
const VALID_PREFIXES = [
  '/_next',       // Next.js internals (HMR, static chunks, etc.)
  '/api',         // All API routes
  '/booth',       // Photobooth kiosk
  '/captures',    // Static captured files
  '/favicon.ico', // Favicon
]

function isAllowed( pathname: string ): boolean {
  if ( pathname === '/' ) return true

  return VALID_PREFIXES.some( ( prefix ) => pathname.startsWith( prefix ) )
}

export function proxy( request: NextRequest ) {
  if ( !isAllowed( request.nextUrl.pathname ) ) {
    return NextResponse.redirect( new URL( '/', request.url ) )
  }
}

/** Only run on page / API routes — skip static assets. */
export const config = {
  matcher : ['/((?!_next/static|_next/image|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|mp4)).*)'],
}
