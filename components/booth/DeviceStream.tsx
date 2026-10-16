'use client'

import { forwardRef, useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { acquireDeviceCamera, releaseDeviceCamera } from '@/lib/photobooth/deviceCamera'

/**
 * Live preview from the device camera — the <video> counterpart of LiveStream,
 * used when the booth runs without a camera service (the Android app).
 *
 * `streamKey` is the store's preview-restart signal. The shared stream survives
 * a restart while it is healthy, and is reopened when it has ended (the camera
 * was taken by another app, or permission was revoked).
 */
export const DeviceStream = forwardRef<
  HTMLVideoElement,
  { streamKey: string; className?: string }
>( function DeviceStream( { streamKey, className }, ref ) {
  const innerRef = useRef<HTMLVideoElement | null>( null )
  const [loaded, setLoaded] = useState( false )
  const [error, setError] = useState<string | null>( null )

  useEffect( () => {
    let cancelled = false
    let acquired = false
    setLoaded( false )
    setError( null )

    acquireDeviceCamera()
      .then( ( stream ) => {
        acquired = true
        if ( cancelled ) {
          releaseDeviceCamera()

          return
        }
        const video = innerRef.current
        if ( !video ) return
        video.srcObject = stream
        void video.play().catch( () => {} )
      } )
      .catch( ( err ) => {
        if ( !cancelled ) setError( err instanceof Error ? err.message : 'Camera unavailable' )
      } )

    return () => {
      cancelled = true
      const video = innerRef.current
      if ( video ) video.srcObject = null
      if ( acquired ) releaseDeviceCamera()
    }
  }, [streamKey] )

  return (
    <>
      <video
        ref={( node ) => {
          innerRef.current = node
          if ( typeof ref === 'function' ) ref( node )
          else if ( ref ) ref.current = node
        }}
        aria-label="Live camera preview"
        data-photobooth-live=""
        autoPlay
        muted
        playsInline
        onLoadedData={() => setLoaded( true )}
        className={cn(
          'transition-opacity duration-500',
          loaded ? 'opacity-100' : 'opacity-0',
          className,
        )}
      />
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-900 p-6 text-center text-sm font-medium text-neutral-300 font-sans">
          {error}
        </div>
      )}
    </>
  )
} )
