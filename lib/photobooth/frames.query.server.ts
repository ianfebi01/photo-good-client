import 'server-only'

import type { ClientFrame } from './frames.client'
import type { FramesResponse, PageArg } from './frames.query'
import { externalFetch } from './config'

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
  // 1. Try locally-synced frames first (instant, no network)
  try {
    const { loadLocalFrames } = await import( './frames.sync' )
    const local = await loadLocalFrames()
    if ( local && local.length > 0 ) return local
  } catch {
    // Sync module not available — fall through to network
  }

  // 2. Fall back to external API
  try {
    const res = await externalFetch( '/api/booth/frames', {
      cache : 'no-store',
    } )

    if ( !res.ok ) {
      throw new Error( `Failed to fetch booth frames: ${res.statusText}` )
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

    return []
  }
}

export async function getFramesForSsr( { page, limit }: PageArg ): Promise<FramesResponse> {
  const all = await fetchBoothFrames()
  const total = all.length
  const start = ( page - 1 ) * limit

  return { frames : all.slice( start, start + limit ), total }
}
