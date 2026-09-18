import type { CSSProperties, RefObject } from 'react'

import { cn } from '@/lib/utils'
import type { ClientFrame } from '@/lib/photobooth/frames.client'
import type { Shot } from '@/store/boothStore'
import { getCSSFilter } from './filters'

const CAPTURE_SOURCE_ASPECT = 3 / 2

interface FramePreviewProps {
  frame: ClientFrame
  photos: Shot[]
  pending: Shot | null
  adjustments: { x: number; y: number; zoom: number; filter: string }[]
  activeSlotIdx: number | null
  reviewing: boolean
  globalFilter: string
  cacheBuster: string
  isSlotInteractive: ( i: number ) => boolean
  onSlotClick: ( i: number ) => void
  onMouseDown: ( e: React.MouseEvent, i: number ) => void
  onTouchStart: ( e: React.TouchEvent, i: number ) => void
  containerRef?: RefObject<HTMLDivElement | null>
  onZoomChange?: ( i: number, zoom: number ) => void
  className?: string
  style?: CSSProperties
  rootRef?: RefObject<HTMLDivElement | null>
}

export function FramePreview( {
  frame,
  photos,
  pending,
  adjustments,
  activeSlotIdx,
  reviewing,
  globalFilter,
  cacheBuster,
  isSlotInteractive,
  onSlotClick,
  onMouseDown,
  onTouchStart,
  containerRef,
  onZoomChange,
  className,
  style,
  rootRef,
}: FramePreviewProps ) {
  return (
    <div
      ref={rootRef}
      style={style}
      className={cn( 'overflow-hidden', className )}
    >
      <div className="relative flex-1 flex items-center justify-center overflow-hidden">
        <div
          ref={containerRef}
          className="relative overflow-hidden max-h-full"
          style={{
            aspectRatio : `${frame.width} / ${frame.height}`,
            height      : '100%',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/frames/preview?key=${frame.key}&overlay=true&t=${cacheBuster}`}
            alt="Frame template"
            className="absolute inset-0 w-full h-full object-contain z-10 pointer-events-none"
          />

          {activeSlotIdx !== null && frame.slots[activeSlotIdx] && (
            <div
              className="absolute ring-2 ring-primary ring-inset z-30 pointer-events-none animate-pulse"
              style={{
                left   : `${( frame.slots[activeSlotIdx].left / frame.width ) * 100}%`,
                top    : `${( frame.slots[activeSlotIdx].top / frame.height ) * 100}%`,
                width  : `${( frame.slots[activeSlotIdx].width / frame.width ) * 100}%`,
                height : `${( frame.slots[activeSlotIdx].height / frame.height ) * 100}%`,
              }}
            />
          )}

          {frame.slots.map( ( slot, i ) => {
            const photo = reviewing && i === activeSlotIdx ? pending : photos[i]
            const adj = adjustments[i]

            // `adj.x` / `adj.y` are frame pixels while this img is exactly one
            // slot wide, so a percentage of its own size keeps the pan identical
            // at any preview scale.
            const shiftX = slot.width ? ( adj.x / slot.width ) * 100 : 0
            const shiftY = slot.height ? ( adj.y / slot.height ) * 100 : 0
            const slotAspect = slot.width / slot.height
            const imageWidth = Math.max( 1, CAPTURE_SOURCE_ASPECT / slotAspect ) * adj.zoom * 100
            const imageHeight = Math.max( 1, slotAspect / CAPTURE_SOURCE_ASPECT ) * adj.zoom * 100

            return (
              <div
                key={i}
                onClick={() => isSlotInteractive( i ) && onSlotClick( i )}
                onMouseDown={( e ) => isSlotInteractive( i ) && onMouseDown( e, i )}
                onTouchStart={( e ) => isSlotInteractive( i ) && onTouchStart( e, i )}
                className={cn(
                  'absolute overflow-hidden select-none z-0',
                  isSlotInteractive( i ) && 'cursor-grab active:cursor-grabbing',
                )}
                style={{
                  left   : `${( slot.left / frame.width ) * 100}%`,
                  top    : `${( slot.top / frame.height ) * 100}%`,
                  width  : `${( slot.width / frame.width ) * 100}%`,
                  height : `${( slot.height / frame.height ) * 100}%`,
                }}
              >
                {photo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={photo.url}
                    alt={`Slot ${i + 1}`}
                    className="absolute pointer-events-none select-none max-w-none"
                    style={{
                      width     : `${imageWidth}%`,
                      height    : `${imageHeight}%`,
                      left      : `calc(50% + ${shiftX}%)`,
                      top       : `calc(50% + ${shiftY}%)`,
                      transform : 'translate(-50%, -50%)',
                      filter    : getCSSFilter( globalFilter ),
                    }}
                  />
                ) : (
                  <div className="absolute inset-0 bg-[#FFEDC7]/30 flex items-center justify-center text-xs font-bold text-neutral-400">
                    {i + 1}
                  </div>
                )}
              </div>
            )
          } )}

          {/* Zoom controls — one per occupied slot, above frame overlay */}
          {onZoomChange && frame.slots.map( ( slot, i ) => {
            if ( i >= photos.length ) return null
            const adj = adjustments[i]

            return (
              <div
                key={`zoom-${i}`}
                className="absolute z-40 flex items-center gap-0.5 rounded-full bg-black/60 backdrop-blur-sm px-1.5 py-0.5"
                style={{
                  left      : `${( ( slot.left + slot.width / 2 ) / frame.width ) * 100}%`,
                  top       : `${( ( slot.top + slot.height ) / frame.height ) * 100}%`,
                  transform : 'translate(-50%, calc(-100% - 4px))',
                }}
                onClick={( e ) => e.stopPropagation()}
                onMouseDown={( e ) => e.stopPropagation()}
                onTouchStart={( e ) => e.stopPropagation()}
              >
                <button
                  className="text-white text-sm font-bold w-5 h-5 flex items-center justify-center rounded-full hover:bg-white/20 transition-colors disabled:opacity-30"
                  disabled={adj.zoom <= 1.0}
                  onClick={() => onZoomChange( i, Math.max( 1.0, Number( ( adj.zoom - 0.1 ).toFixed( 1 ) ) ) )}
                >
                  −
                </button>
                <span className="text-white text-[10px] font-mono w-7 text-center tabular-nums select-none">
                  {adj.zoom.toFixed( 1 )}×
                </span>
                <button
                  className="text-white text-sm font-bold w-5 h-5 flex items-center justify-center rounded-full hover:bg-white/20 transition-colors disabled:opacity-30"
                  disabled={adj.zoom >= 2.5}
                  onClick={() => onZoomChange( i, Math.min( 2.5, Number( ( adj.zoom + 0.1 ).toFixed( 1 ) ) ) )}
                >
                  +
                </button>
              </div>
            )
          } )}
        </div>
      </div>
    </div>
  )
}
