'use client'

import { forwardRef, useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

export const LiveStream = forwardRef<
  HTMLImageElement,
  { src: string; className?: string }
>( function LiveStream( { src, className }, ref ) {
  const innerRef = useRef<HTMLImageElement | null>( null )
  // Fade in once the first frame actually arrives — the stream is blank while
  // it (re)connects, so a mount-time fade would play on an empty image.
  const [loaded, setLoaded] = useState( false )

  useEffect( () => {
    setLoaded( false )
    const img = innerRef.current
    if ( !img ) return
    img.src = ''
    img.src = src

    return () => {
      img.src = ''
    }
  }, [src] )

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={( node ) => {
        innerRef.current = node
        if ( typeof ref === 'function' ) ref( node )
        else if ( ref ) ref.current = node
      }}
      alt="Live camera preview"
      crossOrigin="anonymous"
      data-photobooth-live=""
      onLoad={() => setLoaded( true )}
      className={cn(
        'transition-opacity duration-500',
        loaded ? 'opacity-100' : 'opacity-0',
        className,
      )}
    />
  )
} )
