import 'server-only'

import type { ClientFrame } from './frames.client'
import type { FramesResponse, PageArg } from './frames.query'
import { externalFetch, FetchError } from './config'

// Re-export so consumers can catch FetchError without reaching into config.
export { FetchError }

export type BoothFrameSlot = {
  left : number
  top : number
  width : number
  height : number
}

/** A frame returned by the booth-facing frames API. */
export type BoothFrame = {
  key : string
  label : string
  imageUrl : string
  width : number
  height : number
  slots : BoothFrameSlot[]
  builtIn : boolean
}

/** GET /api/booth/frames response. */
export type BoothFramesResponse = {
  frames : BoothFrame[]
}

export async function fetchBoothFrames(): Promise<ClientFrame[]> {
  try {
    const res = await externalFetch( '/api/booth/frames', {
      cache : 'no-store',
    } )

    if ( !res.ok ) {
      const body = await res.text().catch( () => '' )
      throw new FetchError( body || res.statusText, res.status )
    }

    const data = ( await res.json() ) as BoothFramesResponse
    if ( !data || !Array.isArray( data.frames ) ) {
      return []
    }

    return data.frames.map( ( f ) => ( {
      key        : f.key,
      label      : f.label,
      publicUrl  : f.imageUrl,
      width      : f.width,
      height     : f.height,
      photoCount : f.slots.length,
      slots      : f.slots,
      builtIn    : f.builtIn,
    } ) )
  } catch ( err ) {
    // eslint-disable-next-line no-console
    console.error( 'Error fetching frames from external API:', err )

    throw err
  }
}

export async function getFramesForSsr( { page, limit }: PageArg ): Promise<FramesResponse> {
  let all: ClientFrame[]
  try {
    all = await fetchBoothFrames()
  } catch ( err ) {
    if ( err instanceof FetchError ) {
      // Re-throw so the API route can forward the correct status code.
      // SSR pages that call this directly will see the error page with the
      // right status — Next.js surfaces thrown errors from server components.
      throw err
    }
    // Unexpected errors (network, etc.) — surface as 502 Bad Gateway
    throw new FetchError(
      err instanceof Error ? err.message : 'Failed to fetch frames',
      502,
    )
  }
  const total = all.length
  const start = ( page - 1 ) * limit

  return { frames : all.slice( start, start + limit ), total }
}
