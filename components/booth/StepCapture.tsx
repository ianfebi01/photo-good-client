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
// import { CameraModeToggle } from './CameraModeToggle'
import { FramePreview } from './FramePreview'
import { ShutterControls } from './ShutterControls'
import { StepHeader } from './StepHeader'
import { getCameraPreviewUrl } from '@/lib/photobooth/frames.query'
import { recordCountdownClip } from '@/lib/photobooth/frames.query'
import { trackCountdownClip } from '@/lib/photobooth/frames.query'
import { ChevronRight } from 'lucide-react'

// ── Countdown clip ──────────────────────────────────────────────────
//
// The clip is recorded on the server: ffmpeg reads the live MJPEG preview this
// page is showing and encodes the countdown window straight to MP4/H.264 (see
// /api/captures/countdown). The browser keeps no canvas and no MediaRecorder —
// one encode generation instead of two, no dropped frames, and nothing for the
// kiosk's CPU to do while the guest poses.
//
// Recording stays at the stream's native size and is never upscaled: the EOS
// M6's PTP live view is only 480×320, so stretching it would add no detail and
// only force the mashup to resample a second time.

/**
 * Seconds counted down before each shot — and the length of its clip, which
 * also sets the result video's duration: the mashup runs as long as its clips.
 */
const COUNTDOWN_SECS = 5

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
    settings,
    disableCountdown,
    adjustments,
    patchAdjustment,
    resetAdjustment,
    mirrorCamera,
    toggleMirrorCamera,
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

  // ── Countdown clip ─────────────────────────────────────────────────
  // Recording happens on the server (see /api/captures/countdown): ffmpeg
  // reads the stream this preview is showing and encodes the countdown window
  // to MP4. The browser only kicks it off and stores the clip that comes back.
  const recordCountdown = useCallback( ( index: number ) => {
    void trackCountdownClip(
      recordCountdownClip( {
        sessionId   : useBoothStore.getState().ensureSessionId(),
        index,
        durationSec : COUNTDOWN_SECS,
        streamUrl   : liveSrc,
        mirror      : mirrorCamera,
      } ),
    )
      .then( ( clip ) => {
        if ( !clip ) {
          // eslint-disable-next-line no-console
          console.warn( `Countdown clip ${index} recorded no usable frames` )

          return
        }
        useBoothStore.getState().addCountdownClip( {
          file : clip.file,
          url  : clip.url,
        } )
      } )
      // A missing clip is not fatal — the capture still works and the result
      // video falls back to the image slideshow — but it should be visible.
      .catch( ( err ) => {
        // eslint-disable-next-line no-console
        console.warn( `Countdown clip ${index} failed:`, err )
      } )
  }, [liveSrc, mirrorCamera] )

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
      // Drop this slot's framing along with the rejected shot.
      resetAdjustment( activeSlotIdx )
    }
    setSelectedSlotIdx( null )
    retakePending()
  }

  const handleSnap = () => {
    setTargetSlotIdx( photos.length )

    // Kiosk config — skip the countdown and shoot immediately.
    if ( disableCountdown ) {
      takeShot()

      return
    }

    // Kick the recording off first, so the clip covers exactly the countdown
    // the guest is about to see. It lands in the store in the background.
    recordCountdown( photos.length )
    setCountdown( COUNTDOWN_SECS )
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
      const current = useBoothStore.getState().adjustments[i]
      const slot = frame.slots[i]
      // Bounds are frame pixels, matching what the store holds.
      const maxDx = slot ? ( slot.width * ( clampedZoom - 1 ) ) / 2 : 0
      const maxDy = slot ? ( slot.height * ( clampedZoom - 1 ) ) / 2 : 0
      patchAdjustment( i, {
        zoom : clampedZoom,
        x    : Math.max( -maxDx, Math.min( maxDx, current.x ) ),
        y    : Math.max( -maxDy, Math.min( maxDy, current.y ) ),
      } )
    },
    [frame, patchAdjustment],
  )

  const handleMouseMove = useCallback(
    ( e: MouseEvent ) => {
      if ( !dragStartRef.current || activeSlotIdx === null ) return
      const { x: startX, y: startY, initX, initY } = dragStartRef.current
      const scale = getScale() || 1
      const slot = frame.slots[activeSlotIdx]
      const zoom = useBoothStore.getState().adjustments[activeSlotIdx].zoom
      const maxDx = slot ? ( slot.width * ( zoom - 1 ) ) / 2 : 0
      const maxDy = slot ? ( slot.height * ( zoom - 1 ) ) / 2 : 0
      // Screen pixels → frame pixels, so the stored pan is preview-size agnostic.
      patchAdjustment( activeSlotIdx, {
        x : Math.max( -maxDx, Math.min( maxDx, initX + ( e.clientX - startX ) / scale ) ),
        y : Math.max( -maxDy, Math.min( maxDy, initY + ( e.clientY - startY ) / scale ) ),
      } )
    },
    [activeSlotIdx, frame, getScale, patchAdjustment],
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
      const scale = getScale() || 1
      const slot = frame.slots[activeSlotIdx]
      const zoom = useBoothStore.getState().adjustments[activeSlotIdx].zoom
      const maxDx = slot ? ( slot.width * ( zoom - 1 ) ) / 2 : 0
      const maxDy = slot ? ( slot.height * ( zoom - 1 ) ) / 2 : 0
      patchAdjustment( activeSlotIdx, {
        x : Math.max( -maxDx, Math.min( maxDx, initX + ( touch.clientX - startX ) / scale ) ),
        y : Math.max( -maxDy, Math.min( maxDy, initY + ( touch.clientY - startY ) / scale ) ),
      } )
    },
    [activeSlotIdx, frame, getScale, patchAdjustment],
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
      captureCounterEnabled={settings?.captureCounterEnabled ?? true}
      onRetake={handleRetake}
      onAccept={handleAcceptPending}
      onCompose={handleGoToFilter}
      onSnap={handleSnap}
      mirrorCamera={mirrorCamera}
      onToggleMirror={toggleMirrorCamera}
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
      mirrorCamera={mirrorCamera}
      captureSlot={
        frame?.slots[reviewing ? ( targetSlotIdx ?? photos.length ) : photos.length] ?? null
      }
    />
  )

  return (
    <div className="container mx-auto px-4 py-8 lg:py-16 flex flex-col gap-6 grow overflow-visible">
      {/* Header */}
      <StepHeader
        title="Capture Photos"
        subtitle={`${photos.length}/${photoCount} shots taken`}
        actions={
          <div className="flex items-center gap-2">
            {/* Switching source mid-shot would swap the camera under a live
                stream, so it waits for the capture to settle. */}
            {/* <CameraModeToggle disabled={busy || countdown !== null} /> */}
            {adjusting && (
              <Button
                size="lg"
                onClick={handleGoToFilter}
              >
                Next <ChevronRight />
              </Button>
            )}
          </div>
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
    </div>
  )
}
