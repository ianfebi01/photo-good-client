'use client'

import { useEffect, useState, type ImgHTMLAttributes } from 'react'

import type { ClientFrame } from '@/lib/photobooth/frames.client'
import { isStandalone } from '@/lib/photobooth/boothApi'

type FrameImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  /** The frame to show. Only `frameKey` is needed when a server renders it. */
  frame?: ClientFrame
  frameKey: string
  /**
   * `preview`: the frame with numbered colour blocks in its windows.
   * `overlay`: the artwork with its windows transparent, to lay over photos.
   */
  variant?: 'preview' | 'overlay'
  /** Busts the browser cache of the server-rendered overlay. */
  cacheBuster?: string
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
  cacheBuster,
  alt,
  ...img
}: FrameImageProps ) {
  const [localSrc, setLocalSrc] = useState<string | null>( null )

  useEffect( () => {
    if ( !isStandalone() || !frame ) return
    let alive = true
    import( '@/lib/photobooth/canvasMedia' )
      .then( ( m ) => m.loadFrameArt( frame ) )
      .then( ( art ) => {
        if ( alive ) setLocalSrc( variant === 'overlay' ? art.overlayUrl : art.previewUrl )
      } )
      .catch( ( err ) => {
        // eslint-disable-next-line no-console
        console.warn( `Frame artwork for ${frame.key} failed to load:`, err )
      } )

    return () => {
      alive = false
    }
  }, [frame, variant] )

  const src = isStandalone()
    ? localSrc
    : variant === 'overlay'
      ? `/api/frames/preview?key=${frameKey}&overlay=true&t=${cacheBuster ?? ''}`
      : `/api/frames/preview?key=${frameKey}`

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
