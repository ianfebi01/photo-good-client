'use client'

import { useEffect, useState, type ImgHTMLAttributes } from 'react'

import type { ClientFrame } from '@/lib/photobooth/frames.client'
import { isStandalone } from '@/lib/photobooth/boothApi'

type Variant = 'preview' | 'overlay'

type FrameImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  /** The frame to show. Only `frameKey` is needed when a server renders it. */
  frame?: ClientFrame
  frameKey: string
  /**
   * `preview`: the frame with numbered colour blocks in its windows.
   * `overlay`: the artwork with its windows transparent, to lay over photos.
   */
  variant?: Variant
}

/** Object URLs of standalone frame art already drawn, so a remount shows it at once. */
const localSrcCache = new Map<string, string>()

const localCacheKey = ( frame: ClientFrame, variant: Variant ) =>
  `${frame.key}|${frame.publicUrl}|${variant}`

function serverSrc( frameKey: string, variant: Variant ) {
  return variant === 'overlay'
    ? `/api/frames/preview?key=${frameKey}&overlay=true`
    : `/api/frames/preview?key=${frameKey}`
}

async function loadLocalSrc( frame: ClientFrame, variant: Variant ): Promise<string> {
  const { loadFrameArt } = await import( '@/lib/photobooth/canvasMedia' )
  const art = await loadFrameArt( frame )
  const src = variant === 'overlay' ? art.overlayUrl : art.previewUrl
  localSrcCache.set( localCacheKey( frame, variant ), src )

  return src
}

/**
 * Warm the cache for a frame image before it is shown, so the next step can
 * render it without waiting on the network or the canvas.
 */
export function preloadFrameImage( frame: ClientFrame, variant: Variant ) {
  if ( isStandalone() ) {
    loadLocalSrc( frame, variant ).catch( () => {} )
  } else {
    new Image().src = serverSrc( frame.key, variant )
  }
}

/**
 * A frame's preview or overlay image.
 *
 * With a server, `/api/frames/preview` renders it. The standalone build has no
 * server, so the same image is drawn on the device from the frame artwork and
 * shown through an object URL (see canvasMedia.ts).
 */
export function FrameImage( {
  frame,
  frameKey,
  variant = 'preview',
  alt,
  ...img
}: FrameImageProps ) {
  const cached = frame ? localSrcCache.get( localCacheKey( frame, variant ) ) ?? null : null
  const [localSrc, setLocalSrc] = useState<string | null>( cached )

  useEffect( () => {
    if ( !isStandalone() || !frame ) return
    let alive = true
    loadLocalSrc( frame, variant )
      .then( ( src ) => {
        if ( alive ) setLocalSrc( src )
      } )
      .catch( ( err ) => {
        // eslint-disable-next-line no-console
        console.warn( `Frame artwork for ${frame.key} failed to load:`, err )
      } )

    return () => {
      alive = false
    }
  }, [frame, variant] )

  const src = isStandalone() ? localSrc ?? cached : serverSrc( frameKey, variant )

  // An empty src would make the browser refetch the page itself.
  if ( !src ) return null

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      {...img}
    />
  )
}
