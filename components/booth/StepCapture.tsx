'use client'
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type CSSProperties,
} from 'react'

import { Button } from '@/components/ui/button'
import { useBoothStore } from '@/store/boothStore'

import { CameraPreview } from './CameraPreview'
import { FramePreview } from './FramePreview'
import { ShutterControls } from './ShutterControls'
import { StepHeader } from './StepHeader'
import { getCameraPreviewUrl } from '@/lib/photobooth/frames.query'
import { uploadCountdownClip } from '@/lib/photobooth/frames.query'
import { ChevronRight } from 'lucide-react'

/** Draw the live MJPEG img onto a canvas every frame so we can record it. */
function useRecordingCanvas(
  active: boolean,
): React.RefObject<HTMLCanvasElement | null> {
  const canvasRef = useRef<HTMLCanvasElement | null>( null )
  const rafRef = useRef<number | null>( null )

  useEffect( () => {
    if ( !active ) {
      if ( rafRef.current !== null ) {
        cancelAnimationFrame( rafRef.current )
        rafRef.current = null
      }

      return
    }

    const tick = () => {
      const canvas = canvasRef.current
      const img = document.querySelector<HTMLImageElement>(
        'img[data-photobooth-live]',
      )
      if ( canvas && img && img.naturalWidth > 0 ) {
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        canvas.getContext( '2d' )?.drawImage( img, 0, 0 )
      }
      rafRef.current = requestAnimationFrame( tick )
    }
    rafRef.current = requestAnimationFrame( tick )

    return () => {
      if ( rafRef.current !== null ) cancelAnimationFrame( rafRef.current )
    }
  }, [active] )

  return canvasRef
}

export function StepCapture() {
  const {
    frameKey,
    photos,
    phase,
    pending,
    flash,
    streamKey,
    error,
    frames,
    acceptPending,
    retakePending,
    takeShot,
    goToFilter,
    disableCountdown,
  } = useBoothStore()

  const frame = frames.find( ( f ) => f.key === frameKey ) ?? frames[0]
  const photoCount = frame?.photoCount ?? 0
  const liveSrc = useMemo(
    () => getCameraPreviewUrl( streamKey ),
    [streamKey],
  )

  const reviewing = phase === 'reviewing'
  const adjusting = phase === 'adjusting'
  const busy = phase === 'running' || phase === 'composing'

  const [countdown, setCountdown] = useState<number | null>( null )

  // ── Countdown video recording ──────────────────────────────────────
  const mediaRecorderRef = useRef<MediaRecorder | null>( null )
  const recordedChunksRef = useRef<Blob[]>( [] )
  const recordingIndexRef = useRef<number>( 0 )
  const recordingCanvasRef = useRecordingCanvas( countdown !== null )

  const startRecording = useCallback( () => {
    const canvas = recordingCanvasRef.current
    if ( !canvas ) return
    const img = document.querySelector<HTMLImageElement>(
      'img[data-photobooth-live]',
    )
    if ( img && img.naturalWidth > 0 ) {
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext( '2d' )?.drawImage( img, 0, 0 )
    }
    let stream: MediaStream
    try {
      stream = canvas.captureStream( 15 )
    } catch {
      return
    }
    recordedChunksRef.current = []
    try {
      const recorder = new MediaRecorder( stream, {
        mimeType : MediaRecorder.isTypeSupported( 'video/webm;codecs=vp9' )
          ? 'video/webm;codecs=vp9'
          : 'video/webm',
      } )
      recorder.ondataavailable = ( e ) => {
        if ( e.data.size > 0 ) recordedChunksRef.current.push( e.data )
      }
      recorder.start( 250 )
      mediaRecorderRef.current = recorder
    } catch {
      // MediaRecorder not supported — silently skip recording
    }
  }, [recordingCanvasRef] )

  const stopAndUploadRecording = useCallback(
    async ( sessionId: string, index: number ) => {
      const recorder = mediaRecorderRef.current
      if ( !recorder || recorder.state === 'inactive' ) return
      mediaRecorderRef.current = null

      return new Promise<void>( ( resolve ) => {
        recorder.onstop = async () => {
          const blob = new Blob( recordedChunksRef.current, {
            type : 'video/webm',
          } )
          recordedChunksRef.current = []
          if ( blob.size < 1000 ) {
            resolve()

            return
          }
          try {
            const result = await uploadCountdownClip( {
              sessionId,
              index,
              blob,
            } )
            useBoothStore.getState().addCountdownClip( {
              file : result.file,
              url  : result.url,
            } )
          } catch {
            // Upload failed silently — strip still works
          }
          resolve()
        }
        recorder.stop()
      } )
    },
    [],
  )

  // Start recording when countdown begins
  useEffect( () => {
    if ( countdown === 3 ) {
      recordingIndexRef.current = photos.length
      startRecording()
    }
  }, [countdown, photos.length, startRecording] )

  // Stop recording and upload when capture completes (pending is set)
  useEffect( () => {
    if ( pending && mediaRecorderRef.current ) {
      const sessionId = useBoothStore.getState().sessionId
      stopAndUploadRecording( sessionId, recordingIndexRef.current )
    }
  }, [pending, stopAndUploadRecording] )

  const canCapture =
    !busy &&
    !reviewing &&
    !adjusting &&
    photoCount - photos.length > 0 &&
    countdown === null

  useEffect( () => {
    if ( countdown === null ) return
    const timer = setTimeout( () => {
      if ( countdown === 1 ) {
        setCountdown( null )
        takeShot()
      } else {
        setCountdown( countdown - 1 )
      }
    }, 1000 )

    return () => clearTimeout( timer )
  }, [countdown, takeShot] )

  const [adjustments, setAdjustments] = useState<
    { x: number; y: number; zoom: number; filter: string }[]
  >( () =>
    Array.from( { length : 10 } ).map( () => ( {
      x      : 0,
      y      : 0,
      zoom   : 1.0,
      filter : 'none',
    } ) ),
  )
  const [selectedSlotIdx, setSelectedSlotIdx] = useState<number | null>( null )
  const [targetSlotIdx, setTargetSlotIdx] = useState<number | null>( null )
  const [cacheBuster, setCacheBuster] = useState( '' )

  useEffect( () => {
    const timer = setTimeout( () => setCacheBuster( String( Date.now() ) ), 0 )

    return () => clearTimeout( timer )
  }, [] )

  const activeSlotIdx = useMemo(
    () =>
      reviewing
        ? ( targetSlotIdx ?? photos.length )
        : adjusting
          ? ( selectedSlotIdx ?? 0 )
          : selectedSlotIdx,
    [reviewing, adjusting, targetSlotIdx, photos.length, selectedSlotIdx],
  )

  const isSlotInteractive = useCallback(
    ( i: number ) => {
      if ( reviewing ) return i === activeSlotIdx

      return i < photos.length && adjustments[i].zoom > 1
    },
    [reviewing, activeSlotIdx, photos.length, adjustments],
  )

  // pending takes priority over stored photo when reviewing its slot
  const activePhoto =
    activeSlotIdx !== null
      ? reviewing && activeSlotIdx === targetSlotIdx
        ? pending
        : ( photos[activeSlotIdx] ?? null )
      : null

  const handleRetake = () => {
    if ( activeSlotIdx !== null ) {
      setAdjustments( ( prev ) => {
        const next = [...prev]
        next[activeSlotIdx] = { x : 0, y : 0, zoom : 1.0, filter : 'none' }

        return next
      } )
    }
    setSelectedSlotIdx( null )
    retakePending()
  }

  const handleSnap = () => {
    setTargetSlotIdx( photos.length )

    // Kiosk config — skip the 3-2-1 countdown and shoot immediately.
    if ( disableCountdown ) {
      takeShot()

      return
    }

    setCountdown( 3 )
  }

  const handleAcceptPending = async () => {
    const idx = activeSlotIdx
    setSelectedSlotIdx( null )
    await acceptPending( idx ?? undefined )
  }

  const frameContainerRef = useRef<HTMLDivElement>( null )

  const getScale = useCallback( () => {
    if ( !frameContainerRef.current ) return 1
    const el = frameContainerRef.current

    return Math.min(
      el.clientHeight / frame.height,
      ( el.parentElement?.clientWidth ?? el.clientWidth ) / frame.width,
    )
  }, [frame] )

  const handleGoToFilter = () => {
    goToFilter()
  }

  const dragStartRef = useRef<{
    x: number
    y: number
    initX: number
    initY: number
  } | null>( null )

  const handleMouseDown = ( e: React.MouseEvent, index: number ) => {
    e.preventDefault()
    setSelectedSlotIdx( index )
    dragStartRef.current = {
      x     : e.clientX,
      y     : e.clientY,
      initX : adjustments[index].x,
      initY : adjustments[index].y,
    }
  }

  const handleZoomChange = useCallback(
    ( i: number, newZoom: number ) => {
      const clampedZoom = Math.max( 1.0, Math.min( 2.5, newZoom ) )
      setAdjustments( ( prev ) => {
        const scale = getScale()
        const slot = frame.slots[i]
        const maxDx = slot ? ( slot.width * scale * ( clampedZoom - 1 ) ) / 2 : 0
        const maxDy = slot ? ( slot.height * scale * ( clampedZoom - 1 ) ) / 2 : 0
        const next = [...prev]
        next[i] = {
          ...next[i],
          zoom : clampedZoom,
          x    : Math.max( -maxDx, Math.min( maxDx, next[i].x ) ),
          y    : Math.max( -maxDy, Math.min( maxDy, next[i].y ) ),
        }

        return next
      } )
    },
    [frame, getScale],
  )

  const handleMouseMove = useCallback(
    ( e: MouseEvent ) => {
      if ( !dragStartRef.current || activeSlotIdx === null ) return
      const { x: startX, y: startY, initX, initY } = dragStartRef.current
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      const scale = getScale()
      const slot = frame.slots[activeSlotIdx]
      setAdjustments( ( prev ) => {
        const zoom = prev[activeSlotIdx].zoom
        const maxDx = slot ? ( slot.width * scale * ( zoom - 1 ) ) / 2 : 0
        const maxDy = slot ? ( slot.height * scale * ( zoom - 1 ) ) / 2 : 0
        const next = [...prev]
        next[activeSlotIdx] = {
          ...next[activeSlotIdx],
          x : Math.max( -maxDx, Math.min( maxDx, initX + dx ) ),
          y : Math.max( -maxDy, Math.min( maxDy, initY + dy ) ),
        }

        return next
      } )
    },
    [activeSlotIdx, frame, getScale],
  )

  const handleMouseUp = useCallback( () => {
    dragStartRef.current = null
  }, [] )

  const handleTouchStart = ( e: React.TouchEvent, index: number ) => {
    setSelectedSlotIdx( index )
    const touch = e.touches[0]
    dragStartRef.current = {
      x     : touch.clientX,
      y     : touch.clientY,
      initX : adjustments[index].x,
      initY : adjustments[index].y,
    }
  }

  const handleTouchMove = useCallback(
    ( e: TouchEvent ) => {
      if ( !dragStartRef.current || activeSlotIdx === null ) return
      const touch = e.touches[0]
      const { x: startX, y: startY, initX, initY } = dragStartRef.current
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      const scale = getScale()
      const slot = frame.slots[activeSlotIdx]
      setAdjustments( ( prev ) => {
        const zoom = prev[activeSlotIdx].zoom
        const maxDx = slot ? ( slot.width * scale * ( zoom - 1 ) ) / 2 : 0
        const maxDy = slot ? ( slot.height * scale * ( zoom - 1 ) ) / 2 : 0
        const next = [...prev]
        next[activeSlotIdx] = {
          ...next[activeSlotIdx],
          x : Math.max( -maxDx, Math.min( maxDx, initX + dx ) ),
          y : Math.max( -maxDy, Math.min( maxDy, initY + dy ) ),
        }

        return next
      } )
    },
    [activeSlotIdx, frame, getScale],
  )

  const handleTouchEnd = useCallback( () => {
    dragStartRef.current = null
  }, [] )

  useEffect( () => {
    window.addEventListener( 'mousemove', handleMouseMove )
    window.addEventListener( 'mouseup', handleMouseUp )
    window.addEventListener( 'touchmove', handleTouchMove )
    window.addEventListener( 'touchend', handleTouchEnd )

    return () => {
      window.removeEventListener( 'mousemove', handleMouseMove )
      window.removeEventListener( 'mouseup', handleMouseUp )
      window.removeEventListener( 'touchmove', handleTouchMove )
      window.removeEventListener( 'touchend', handleTouchEnd )
    }
  }, [handleMouseMove, handleMouseUp, handleTouchMove, handleTouchEnd] )

  // Clean up MediaRecorder on unmount
  useEffect( () => {
    return () => {
      const recorder = mediaRecorderRef.current
      if ( recorder && recorder.state !== 'inactive' ) {
        recorder.stop()
      }
    }
  }, [] )

  const errorBanner = error ? (
    <div className="shrink-0 p-4 rounded-xl bg-destructive/10 text-destructive text-sm font-medium border border-destructive/20 font-sans">
      {error}
    </div>
  ) : null

  const shutterControls = (
    <ShutterControls
      reviewing={reviewing}
      adjusting={adjusting}
      canCapture={canCapture}
      photosTaken={photos.length}
      photoCount={photoCount}
      countdown={countdown}
      onRetake={handleRetake}
      onAccept={handleAcceptPending}
      onCompose={handleGoToFilter}
      onSnap={handleSnap}
    />
  )

  const renderCamera = ( className?: string ) => (
    <CameraPreview
      className={className}
      phase={phase}
      liveSrc={liveSrc}
      pending={pending}
      activePhoto={activePhoto}
      globalFilter="none"
      flash={flash}
    />
  )

  return (
    <div className="container mx-auto px-4 py-8 lg:py-16 flex flex-col gap-6 grow overflow-visible">
      {/* Header */}
      <StepHeader
        title="Capture Photos"
        subtitle={`${photos.length}/${photoCount} shots taken`}
        actions={
          adjusting && (
            <Button
              size="lg"
              onClick={handleGoToFilter}
            >
              Next <ChevronRight />
            </Button>
          )
        }
      />

      {/* 2-column layout: camera + trigger | frame preview */}
      <div className="flex flex-col lg:grid lg:grid-cols-2 gap-6 grow min-h-0 overflow-visible">
        {/* Left: Camera + Shutter */}
        <div className="flex flex-col items-center justify-center gap-6 min-h-0 max-xl:flex-1">
          <div className="w-full h-full max-xl:bg-white max-xl:flex max-xl:p-2 max-xl:items-center xl:h-max">
            {renderCamera( 'w-full max-h-full' )}
          </div>
          <div className="shrink-0 h-28 flex items-center justify-center">
            {shutterControls}
          </div>
        </div>

        {/* Right: Frame preview */}
        {frame && (
          <div className="hidden xl:flex items-center justify-center min-h-0 h-full overflow-hidden">
            <FramePreview
              style={
                {
                  '--frame-ar' : `${frame.width} / ${frame.height}`,
                } as CSSProperties
              }
              className="flex flex-col h-full max-w-full aspect-(--frame-ar)"
              frame={frame}
              photos={photos}
              pending={pending}
              adjustments={adjustments}
              activeSlotIdx={activeSlotIdx}
              reviewing={reviewing}
              globalFilter="none"
              cacheBuster={cacheBuster}
              isSlotInteractive={isSlotInteractive}
              onSlotClick={setSelectedSlotIdx}
              onMouseDown={handleMouseDown}
              onTouchStart={handleTouchStart}
              containerRef={frameContainerRef}
              onZoomChange={adjusting ? handleZoomChange : undefined}
            />
          </div>
        )}
      </div>

      {errorBanner}

      {/* Hidden canvas for countdown video recording */}
      <canvas
        ref={recordingCanvasRef}
        className="hidden"
        aria-hidden="true"
      />
    </div>
  )
}
