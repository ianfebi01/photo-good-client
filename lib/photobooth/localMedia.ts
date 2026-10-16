// ── On-device capture store ─────────────────────────────────────────
//
// The standalone build's stand-in for the server's captures directory. Every
// shot, clip, strip and video of a session lives here as a Blob, under the same
// file names the server used (`shot-<session>-<i>.jpg`, `countdown-…mp4`, …),
// and the UI shows it through an object URL. The store is in memory only —
// like the booth store itself, a session does not survive an app restart — and
// a session's media is dropped once it ends.

type Entry = { blob: Blob; url: string }

const media = new Map<string, Entry>()

/** Store (or replace) a file; returns the shape the capture routes returned. */
export function putLocalMedia( name: string, blob: Blob ): { file: string; url: string } {
  const previous = media.get( name )
  if ( previous ) URL.revokeObjectURL( previous.url )

  const url = URL.createObjectURL( blob )
  media.set( name, { blob, url } )

  return { file : name, url }
}

/** The stored file name for a name or an object URL handed out for it. */
export function localMediaName( nameOrUrl: string ): string | null {
  if ( media.has( nameOrUrl ) ) return nameOrUrl

  const url = nameOrUrl.split( '?' )[0]
  for ( const [name, entry] of media ) {
    if ( entry.url === url ) return name
  }

  return null
}

/** A stored file by name, or by an object URL handed out for it. */
export function getLocalMedia( nameOrUrl: string ): Blob | null {
  const name = localMediaName( nameOrUrl )

  return name ? media.get( name )?.blob ?? null : null
}

/** Drop every file belonging to `sessionId`. */
export function clearLocalSession( sessionId: string ): number {
  let deleted = 0
  for ( const [name, entry] of media ) {
    if ( name.includes( `-${sessionId}` ) ) {
      URL.revokeObjectURL( entry.url )
      media.delete( name )
      deleted++
    }
  }

  return deleted
}
