import { useEffect, useRef } from 'react'
import { Camera } from 'lucide-react'

import type { Phase, Shot } from '@/store/boothStore'
import { cn } from '@/lib/utils'
import { LiveStream } from './LiveStream'
import { getCSSFilter } from './filters'
import { createPortal } from 'react-dom'

interface CameraPreviewProps {
  phase: Phase
  liveSrc: string
  pending: Shot | null
  activePhoto: Shot | null
  globalFilter: string
  flash: boolean
  mirrorCamera: boolean
  className?: string
}

export function CameraPreview( {
  phase,
  liveSrc,
  pending,
  activePhoto,
  globalFilter,
  flash,
  mirrorCamera,
  className,
}: CameraPreviewProps ) {
  const showStream = phase !== 'reviewing' && phase !== 'adjusting'
  const running = phase === 'running'
  const composing = phase === 'composing'

  const liveImgRef = useRef<HTMLImageElement | null>( null )
  const frozenRef = useRef<HTMLCanvasElement | null>( null )

  // During capture the live stream pauses (and can blank to white). The instant
  // capture starts — the stream is still showing a real frame here — paint it
  // onto a canvas and use that as the backdrop, so the "Capturing…" overlay sits
  // on the last frame instead of a white box.
  useEffect( () => {
    if ( !running ) return
    const img = liveImgRef.current
    const canvas = frozenRef.current
    if ( !img || !canvas || !img.naturalWidth || !img.naturalHeight ) return
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const context = canvas.getContext( '2d' )
    if ( !context ) return
    if ( mirrorCamera ) {
      context.translate( canvas.width, 0 )
      context.scale( -1, 1 )
    }
    context.drawImage( img, 0, 0 )
  }, [mirrorCamera, running] )

  return (
    <div className={cn( 'relative overflow-hidden w-full h-auto xl:w-auto xl:rounded-3xl hover:shadow-xl transition-all duration-300 ease-in-out', className )}
      style={{ aspectRatio : '3/2' }}
    >
      {showStream ? (
        <LiveStream
          key="stream"
          ref={liveImgRef}
          src={liveSrc}
          className={cn(
            'absolute inset-0 h-full w-full object-cover',
            mirrorCamera && 'scale-x-[-1]',
          )}
        />
      ) : pending ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key="pending"
          src={pending.url}
          alt="Captured photo preview"
          className="absolute inset-0 h-full w-full object-cover animate-in fade-in zoom-in-95 duration-300"
        />
      ) : activePhoto ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key="active"
          src={activePhoto.url}
          alt="Active slot photo preview"
          className="absolute inset-0 h-full w-full object-cover animate-in fade-in duration-300"
          style={{ filter : getCSSFilter( globalFilter ) }}
        />
      ) : (
        <div
          key="standby"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-neutral-900 text-neutral-500 animate-in fade-in duration-300"
        >
          <Camera className="size-10 text-neutral-600 animate-pulse" />
          <span className="text-xs font-semibold tracking-wider uppercase font-sans">
            Camera Standby
          </span>
        </div>
      )}

      {running && (
        <canvas
          ref={frozenRef}
          className="absolute inset-0 h-full w-full object-cover z-10"
        />
      )}

      {running && (
        <div className="absolute inset-0 bg-black/45 backdrop-blur-xs flex items-center justify-center text-white z-20 animate-in fade-in duration-300">
          <div className="flex flex-col items-center gap-2 animate-pulse">
            <div className="size-2 bg-primary rounded-full animate-ping" />
            <span className="text-sm font-bold tracking-wider uppercase font-sans">
              Capturing Memory...
            </span>
          </div>
        </div>
      )}

      {composing && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center text-white z-20 animate-in fade-in duration-300">
          <div className="flex flex-col items-center gap-3">
            <span className="size-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
            <span className="text-sm font-bold tracking-wider uppercase font-sans">
              Composing photo strip...
            </span>
          </div>
        </div>
      )}

      {flash && (
        createPortal(
          <div className="fixed w-full h-full inset-0 bg-white animate-fade-out z-30" />,
          document.body
        )
      )}
    </div>
  )
}
