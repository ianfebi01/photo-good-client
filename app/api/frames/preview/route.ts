import sharp from 'sharp'
import fs from 'node:fs/promises'
import { getFrame, externalFetch } from '@/lib/photobooth/config'
import { detectGreenSlots, clearGreenPixels } from '@/lib/photobooth/slots'

export const runtime = 'nodejs'

/**
 * The frame image with its green slot panels turned transparent, so photos
 * placed underneath show through while the surrounding artwork stays on top.
 * This is the same transform compose uses; the booth's live FramePreview
 * overlays it on top of the captured photos.
 */
async function buildTransparentOverlay( buffer: Buffer ): Promise<Buffer | null> {
  const detected = await detectGreenSlots( buffer )
  if ( detected.slots.length === 0 ) {
    return null
  }

  const overlayInfo = await sharp( buffer )
    .ensureAlpha()
    .raw()
    .toBuffer( { resolveWithObject : true } )

  const channels = overlayInfo.info.channels
  const pixels = Buffer.from( overlayInfo.data )
  clearGreenPixels( pixels, overlayInfo.info.width, overlayInfo.info.height, channels )

  return sharp( pixels, {
    raw : { width : overlayInfo.info.width, height : overlayInfo.info.height, channels },
  } )
    .png()
    .toBuffer()
}

async function generatePreviewBuffer( buffer: Buffer ) {
  // Detect slots
  const detected = await detectGreenSlots( buffer )
  if ( detected.slots.length === 0 ) {
    return null
  }

  // Generate transparent-green overlay
  const overlayBuffer = await buildTransparentOverlay( buffer )
  if ( !overlayBuffer ) {
    return null
  }

  // Create solid color blocks for each slot with text
  const colors = [
    { bg : '#EB4C4C', text : '#ffffff' }, // Primary
    { bg : '#FF7070', text : '#ffffff' }, // Coral
    { bg : '#FFA6A6', text : '#3b1515' }, // Accent
    { bg : '#FFEDC7', text : '#3b1515' }, // Secondary
  ]

  const slotComposites = detected.slots.map( ( slot, idx ) => {
    const swatch = colors[idx % colors.length]
    const padding = 8
    const w = slot.width + padding * 2
    const h = slot.height + padding * 2
    const fontSize = Math.max( 12, Math.floor( Math.min( slot.width, slot.height ) * 0.4 ) )

    const svg = Buffer.from(
      `<svg width="${w}" height="${h}">
        <rect width="100%" height="100%" fill="${swatch.bg}" />
        <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="${fontSize}px" font-weight="bold" fill="${swatch.text}">${idx + 1}</text>
      </svg>`
    )

    return {
      input : svg,
      left  : slot.left - padding,
      top   : slot.top - padding,
    }
  } )

  // Composite background with colored slots, then overlay
  return sharp( {
    create : {
      width      : detected.width,
      height     : detected.height,
      channels   : 4,
      background : { r : 255, g : 255, b : 255, alpha : 1 },
    },
  } )
    .composite( [...slotComposites, { input : overlayBuffer, left : 0, top : 0 }] )
    .png()
    .toBuffer()
}

export async function GET( request: Request ) {
  const { searchParams } = new URL( request.url )
  const key = searchParams.get( 'key' )
  const raw = searchParams.get( 'raw' ) === 'true'
  const overlay = searchParams.get( 'overlay' ) === 'true'

  if ( !key ) {
    return Response.json( { error : 'Missing key parameter' }, { status : 400 } )
  }

  // Resolve frame — getFrame() now checks both filesystem and DB
  const frame = await getFrame( key )

  if ( !frame ) {
    return Response.json( { error : 'Frame not found' }, { status : 404 } )
  }

  try {
    let buffer: Buffer

    if ( frame.image ) {
      // Local filesystem frame (built-in or legacy user-manifest)
      buffer = await fs.readFile( frame.image )
    } else {
      // Fetch from the external URL
      const res = await externalFetch( frame.publicUrl );
      if ( !res.ok ) throw new Error( `Failed to fetch frame image: ${res.statusText}` );
      buffer = Buffer.from( await res.arrayBuffer() );
    }

    if ( raw ) {
      const contentType = key.endsWith( '.png' ) ? 'image/png' : 'image/jpeg'

      return new Response( new Uint8Array( buffer ), {
        headers : {
          'Content-Type'  : contentType,
          'Cache-Control' : 'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      } )
    }

    // Transparent-slot overlay — used by the booth's live FramePreview, which
    // renders captured photos beneath the frame artwork.
    if ( overlay ) {
      const transparent = await buildTransparentOverlay( buffer )
      const body = transparent ?? buffer

      return new Response( new Uint8Array( body ), {
        headers : {
          'Content-Type'  : transparent ? 'image/png' : ( key.endsWith( '.png' ) ? 'image/png' : 'image/jpeg' ),
          'Cache-Control' : 'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      } )
    }

    const composed = await generatePreviewBuffer( buffer )

    if ( !composed ) {
      const contentType = key.endsWith( '.png' ) ? 'image/png' : 'image/jpeg'

      return new Response( new Uint8Array( buffer ), {
        headers : {
          'Content-Type'  : contentType,
          'Cache-Control' : 'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      } )
    }

    return new Response( new Uint8Array( composed ), {
      headers : {
        'Content-Type'  : 'image/png',
        'Cache-Control' : 'no-store, no-cache, must-revalidate, proxy-revalidate',
      },
    } )
  } catch ( e ) {
    return Response.json(
      { error : e instanceof Error ? e.message : 'Failed to generate preview' },
      { status : 500 },
    )
  }
}
