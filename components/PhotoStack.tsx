'use client'

import { useMemo, useState, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Swiper, SwiperSlide } from 'swiper/react'
import { EffectCards, Autoplay } from 'swiper/modules'
import type { Swiper as SwiperClass } from 'swiper'
import { cn } from '@/lib/utils'
import { FRAMES_QUERY_KEY, getFrames } from '@/lib/photobooth/frames.query'

import 'swiper/css'
import 'swiper/css/effect-cards'
import { isStandalone } from '@/lib/photobooth/boothApi'
import { FrameImage } from '@/components/booth/FrameImage'

const PAGE_SIZE = 10

/** Skeleton shown while the frames query is still loading. */
function StackSkeleton() {
  return (
    <div className="flex items-center justify-center w-full h-full">
      <div className="h-full w-auto max-w-[75%] aspect-2/3 rounded-sm bg-neutral-100 animate-pulse shadow-lg" />
    </div>
  )
}

export default function PhotoStack( { className }: { className?: string } ) {
  const [mounted, setMounted] = useState( false )

  useEffect( () => {
    // Defer to avoid cascading render; this is the standard pattern for client-only detection
    const raf = requestAnimationFrame( () => setMounted( true ) )

    return () => cancelAnimationFrame( raf )
  }, [] )

  const { data, isLoading } = useQuery( {
    queryKey : [...FRAMES_QUERY_KEY, { page : 1, limit : PAGE_SIZE }],
    queryFn  : () => getFrames( { page : 1, limit : PAGE_SIZE } ),
  } )

  // With a server, an empty catalog still shows its default frame; the
  // standalone build can only draw frames it actually has.
  const previews = useMemo( () => {
    const list = data?.frames
    if ( list && list.length > 0 ) return list.map( ( frame ) => ( { key : frame.key, frame } ) )

    return isStandalone() ? [] : [{ key : 'summer-day', frame : undefined }]
  }, [data] )

  // Force Swiper to recalculate after mount when dimensions are stable
  const handleSwiper = useCallback( ( swiper: SwiperClass ) => {
    // Use requestAnimationFrame to ensure the browser has painted and dimensions are settled
    requestAnimationFrame( () => {
      swiper.update()
    } )
  }, [] )

  if ( isLoading || !mounted ) {
    return (
      <div className={cn( 'p-6 relative flex items-center justify-center', className )}>
        <div className="relative w-full h-full flex items-center justify-center">
          <StackSkeleton />
        </div>
      </div>
    )
  }

  return (
    <div className={cn( 'p-6 relative flex items-center justify-center overflow-hidden', className )}>
      {previews.length > 0 && (
        <Swiper
          effect="cards"
          grabCursor
          loop
          autoplay={ {
            delay                : 2500,
            disableOnInteraction : true,
            pauseOnMouseEnter    : true,
          } }
          initialSlide={3}
          modules={[EffectCards, Autoplay]}
          onSwiper={handleSwiper}
          className="h-full w-auto max-w-[75%] mx-auto aspect-2/3"
          style={ {
            '--swiper-navigation-color' : '#fff',
            '--swiper-pagination-color' : '#fff',
          } as React.CSSProperties }
          cardsEffect={{
            slideShadows : false,
          }}
        >
          {previews.map( ( { key, frame }, idx ) => (
            <SwiperSlide
              key={idx}
              className="rounded-sm overflow-visible"
            >
              <FrameImage
                frame={frame}
                frameKey={key}
                alt={`photo frame ${idx + 1}`}
                className="w-full h-full object-contain drop-shadow-xl"
                loading={idx === 0 ? 'eager' : 'lazy'}
              />
            </SwiperSlide>
          ) )}
        </Swiper>
      )}
      
    </div>
  )
}
