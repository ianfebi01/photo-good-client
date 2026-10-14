'use client'

import { forwardRef, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { cn } from '@/lib/utils'
import { getUsbCameraState, subscribeUsbCamera, usbFrames } from '@/lib/photobooth/usbCamera'

/** How long to wait for a first frame before showing what the driver says. */
const STATUS_DELAY_MS = 3_000

const noServerState = () => null

/**
 * Live preview from a USB capture device read by the app's own driver — the
 * canvas counterpart of LiveStream. The MJPEG stream is read with fetch and each
 * frame drawn as it arrives (see usbFrames for why not an <img>).
 *
 * If no picture arrives, the box says why, from the driver's own status, so the
 * operator does not have to open the USB details to find out.
 */
export const UsbStream = forwardRef<
  HTMLCanvasElement,
  { base: string; streamKey: string; className?: string }
>( function UsbStream( { base, streamKey, className }, ref ) {
  const innerRef = useRef<HTMLCanvasElement | null>( null )
  const [loaded, setLoaded] = useState( false )
  const [waitedLong, setWaitedLong] = useState( false )
  const [failure, setFailure] = useState<string | null>( null )
  const usbState = useSyncExternalStore( subscribeUsbCamera, getUsbCameraState, noServerState )

  useEffect( () => {
    const controller = new AbortController()
    let first = true
    const resetTimer = setTimeout( () => {
      setLoaded( false )
      setFailure( null )
      setWaitedLong( false )
    }, 0 )
    const slowTimer = setTimeout( () => setWaitedLong( true ), STATUS_DELAY_MS )

    void ( async () => {
      try {
        for await ( const { bitmap } of usbFrames( base, controller.signal ) ) {
          const canvas = innerRef.current
          if ( canvas ) {
            if ( canvas.width !== bitmap.width || canvas.height !== bitmap.height ) {
              canvas.width = bitmap.width
              canvas.height = bitmap.height
            }
            canvas.getContext( '2d' )?.drawImage( bitmap, 0, 0 )
          }
          bitmap.close()
          if ( first ) {
            first = false
            setLoaded( true )
          }
        }
      } catch ( err ) {
        if ( !controller.signal.aborted ) {
          setFailure( err instanceof Error ? err.message : 'The USB preview stopped' )
        }
      }
    } )()

    return () => {
      controller.abort()
      clearTimeout( resetTimer )
      clearTimeout( slowTimer )
    }
  }, [base, streamKey] )

  const lastLog = usbState?.log?.[usbState.log.length - 1]
  const status = failure ??
    ( waitedLong && !loaded
      ? `${usbState?.error ?? `USB camera: ${usbState?.state ?? 'not started'}, ${usbState?.frames ?? 0} frames`}${lastLog ? ` — ${lastLog}` : ''}`
      : null )

  return (
    <>
      <canvas
        ref={( node ) => {
          innerRef.current = node
          if ( typeof ref === 'function' ) ref( node )
          else if ( ref ) ref.current = node
        }}
        aria-label="Live camera preview"
        data-photobooth-live=""
        className={cn(
          'transition-opacity duration-500',
          loaded ? 'opacity-100' : 'opacity-0',
          className,
        )}
      />
      {status && (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-900 p-6 text-center font-sans text-xs font-medium text-neutral-300">
          {status}
        </div>
      )}
    </>
  )
} )
