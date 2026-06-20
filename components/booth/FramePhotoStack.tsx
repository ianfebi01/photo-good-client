'use client'

import { useRef, useEffect, useCallback } from 'react'
import { Swiper, SwiperSlide } from 'swiper/react'
import { EffectCards, Navigation } from 'swiper/modules'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { type ClientFrame } from '@/lib/photobooth/frames.client'
import type { Swiper as SwiperClass } from 'swiper'

import 'swiper/css'
import 'swiper/css/effect-cards'

export function FramePhotoStack( {
  frames,
  activeKey,
  onSelect,
  disabled = false,
}: {
  frames: ClientFrame[]
  activeKey: string
  onSelect: ( key: string ) => void
  disabled?: boolean
} ) {
  const swiperRef = useRef<SwiperClass | null>( null )
  const activeKeyRef = useRef( activeKey )

  // Keep ref in sync
  useEffect( () => {
    activeKeyRef.current = activeKey
  }, [activeKey] )

  // Sync Swiper slide when activeKey changes externally
  useEffect( () => {
    const swiper = swiperRef.current
    if ( !swiper || frames.length === 0 ) return
    const idx = frames.findIndex( ( f ) => f.key === activeKey )
    if ( idx !== -1 && idx !== swiper.activeIndex ) {
      swiper.slideTo( idx )
    }
  }, [activeKey, frames] )

  const handleSlideChange = useCallback(
    ( swiper: SwiperClass ) => {
      const frame = frames[swiper.realIndex]
      if ( frame && frame.key !== activeKeyRef.current ) {
        onSelect( frame.key )
      }
    },
    [frames, onSelect],
  )

  if ( frames.length === 0 ) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-neutral-400 font-sans">
        No frames available
      </div>
    )
  }

  const activeFrame = frames.find( ( f ) => f.key === activeKey ) || frames[0]
  const initialIdx = Math.max( frames.findIndex( ( f ) => f.key === activeKey ), 0 )

  return (
    <div className="flex flex-col items-center gap-6 w-full h-full relative justify-center">
      {/* Swiper Stack Area */}
      <div
        className={cn(
          'relative flex items-center justify-center overflow-visible w-full h-80 sm:h-100 xl:h-112.5 select-none group/stack',
          disabled && 'pointer-events-none opacity-60',
        )}
      >
        <Swiper
          effect="cards"
          grabCursor={!disabled}
          loop={false}
          initialSlide={initialIdx}
          modules={[EffectCards, Navigation]}
          className="h-full w-auto max-w-[75%] mx-auto relative aspect-2/3"
          onSwiper={( swiper ) => {
            swiperRef.current = swiper
            // Force recalculate after mount when dimensions are stable
            requestAnimationFrame( () => swiper.update() )
          }}
          onSlideChange={handleSlideChange}
          allowTouchMove={!disabled}
          navigation={{
            prevEl : '.swiper-button-prev',
            nextEl : '.swiper-button-next',
          }}
          cardsEffect={{
            slideShadows : false,
          }}
        >
          {frames.map( ( frame, idx ) => (
            <SwiperSlide
              key={frame.key}
              className="rounded-sm overflow-visible"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/frames/preview?key=${frame.key}`}
                alt={frame.label}
                className="w-full h-full object-contain drop-shadow-xl"
                loading={idx === initialIdx ? 'eager' : 'lazy'}
              />
            </SwiperSlide>
          ) )}
          <div className="swiper-button-prev absolute left-0 -translate-x-full inset-y-0 my-auto h-fit z-10 [&.swiper-button-disabled>button]:pointer-events-none [&.swiper-button-disabled>button]:opacity-50">
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label="Previous frame"
            >
              <ChevronLeft />
            </Button>
          </div>
          <div className="swiper-button-next absolute right-0 translate-x-full inset-y-0 my-auto h-fit z-10 [&.swiper-button-disabled>button]:pointer-events-none [&.swiper-button-disabled>button]:opacity-50">
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label="Next frame"
            >
              <ChevronRight />
            </Button>
          </div>
        </Swiper>
      </div>

      {/* Frame details at the bottom */}
      {activeFrame && (
        <div className="flex flex-col items-center gap-0.5 shrink-0">
          <span className="text-base font-bold text-neutral-800 font-sans">
            {activeFrame.label}
          </span>
          <span className="text-xs text-neutral-400 font-sans">
            {activeFrame.photoCount} slot{activeFrame.photoCount !== 1 ? 's' : ''} · {activeFrame.width} × {activeFrame.height} px
          </span>
        </div>
      )}
    </div>
  )
}
