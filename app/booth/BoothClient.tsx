'use client'

import { useEffect, useRef, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { Loader2, AlertCircle } from 'lucide-react'

import { useBoothStore } from '@/store/boothStore'
import {
  FRAMES_QUERY_KEY,
  CAMERA_STATUS_QUERY_KEY,
  getCameraStatus,
  getAllFrames,
  ensureCameraDiscovered,
} from '@/lib/photobooth/frames.query'
import type { ClientFrame } from '@/lib/photobooth/frames.client'

import { StepCapture } from '@/components/booth/StepCapture'
import { StepResult } from '@/components/booth/StepResult'
import { StepSelectFrame } from '@/components/booth/StepSelectFrame'
import { StepFilter } from '@/components/booth/StepFilter'
import { StepTimer } from '@/components/booth/StepTimer'
import { useBodyBackground } from '@/lib/hooks/useBodyBackground'
import { useBoothSettings } from '@/lib/hooks/useBoothSettings'

// ── Step component map ────────────────────────────────────────────

const STEP_COMPONENTS: Record<number, React.ComponentType> = {
  0 : StepSelectFrame,
  1 : StepCapture,
  2 : StepFilter,
  3 : StepResult,
}

// ── Main component ─────────────────────────────────────────────────

export function BoothClient() {
  const {
    step, setStatus, setFrames, restartPreview, paymentStatus,
    reset, start, goToFilter, takeShot, acceptPending,
    composeStripWithAdjustments, photos, frameKey, selectFrame, settings,
  } = useBoothStore()
  const router = useRouter()

  // ── Timer expiry handler ────────────────────────────────────────
  const handleTimesUp = useCallback( () => {
    // Read latest state for step-1 decisions (pending / photo count)
    const state = useBoothStore.getState()

    switch ( state.step ) {
    case 0:
      // Select Frame idle timeout → jump straight to capture
      start()
      break

    case 1: {
      // Capture — auto-capture or advance
      const frame = state.frames.find( ( f ) => f.key === state.frameKey ) ?? state.frames[0]
      const photoCount = frame?.photoCount ?? 0

      if ( state.pending ) {
        // A shot is waiting for review — auto-accept it
        acceptPending()
      } else if ( state.photos.length < photoCount ) {
        // Still have empty slots — auto-capture
        takeShot()
      } else {
        // All slots filled — go to filter
        goToFilter()
      }
      break
    }

    case 2: {
      // Filter idle timeout — compose with the current filter and advance to result.
      // Reuse the framing panned/zoomed on the capture step instead of dropping it.
      const frame = state.frames.find( ( f ) => f.key === state.frameKey ) ?? state.frames[0]
      const count = frame?.photoCount ?? 0
      const filter = state.globalFilter ?? 'none'
      const adjustments = state.adjustments.slice( 0, count ).map( ( adj ) => ( {
        ...adj,
        filter,
      } ) )
      composeStripWithAdjustments( adjustments )
      break
    }

    case 3:
    default:
      // Result idle timeout → back to home
      reset()
      router.replace( '/booth' )
    }
  }, [start, acceptPending, takeShot, goToFilter, composeStripWithAdjustments, reset, router] )

  // Override body bg + theme-color for iOS Safari bars.
  useBodyBackground( '#f5f5f5' )

  // ── Per-booth settings ──────────────────────────────────────────
  // While these are loading the store keeps `settings === null`, so the
  // payment guard below waits instead of guessing a default.
  useBoothSettings()

  // ── Payment guard: redirect if not paid ─────────────────────────
  useEffect( () => {
    if ( !settings ) return
    if ( !settings.paymentEnabled ) return
    if ( paymentStatus !== 'paid' ) {
      router.replace( '/booth/payment' )
    }
  }, [settings, paymentStatus, router] )

  // ── Camera discovery (fire-and-forget, guarded against unmount) ─
  useEffect( () => {
    let mounted = true
    ensureCameraDiscovered().then( () => {
      if ( mounted ) restartPreview()
    } )

    return () => {
      mounted = false
    }
  }, [restartPreview] )

  // ── Frames query ────────────────────────────────────────────────
  const framesQuery = useQuery( {
    queryKey  : FRAMES_QUERY_KEY,
    queryFn   : getAllFrames,
    staleTime : 1000 * 60,
  } )

  // Apply the booth deny-list client-side as well. `/api/frames` is served
  // from the locally-synced manifest first, which bypasses the API's own
  // filtering and can go stale when a frame is disabled in the backend.
  const visibleFrames = useMemo( () => {
    const all = framesQuery.data?.frames
    if ( !Array.isArray( all ) ) return null
    const disabled = new Set( settings?.disabledFrameKeys ?? [] )

    return all.filter( ( f ) => !disabled.has( f.key ) )
  }, [framesQuery.data, settings?.disabledFrameKeys] )

  const lastFramesRef = useRef<ClientFrame[] | null>( null )

  useEffect( () => {
    if ( !visibleFrames ) return
    // Only sync to store when the array identity changes
    if ( visibleFrames === lastFramesRef.current ) return
    lastFramesRef.current = visibleFrames
    setFrames( visibleFrames )
  }, [visibleFrames, setFrames] )

  // ── Skip the frame picker when there is only one choice ─────────
  useEffect( () => {
    if ( step !== 0 ) return
    if ( !visibleFrames || visibleFrames.length !== 1 ) return

    const only = visibleFrames[0]
    if ( only.key !== frameKey ) selectFrame( only.key )
    start()
  }, [step, visibleFrames, frameKey, selectFrame, start] )

  // ── Camera status query ─────────────────────────────────────────
  const statusQuery = useQuery( {
    queryKey        : CAMERA_STATUS_QUERY_KEY,
    queryFn         : getCameraStatus,
    staleTime       : 4_000,
    refetchInterval : 4_000,
    retry           : false,
  } )

  const prevConnectedRef = useRef<boolean | null>( null )

  useEffect( () => {
    if ( !statusQuery.data ) {
      if ( statusQuery.isError ) {
        setStatus( { connected : false, mock : true, gphoto2 : false } )
      }

      return
    }

    const status = statusQuery.data
    setStatus( status )

    const prev = prevConnectedRef.current
    prevConnectedRef.current = status.connected

    // Restart preview on first data arrival *or* when the camera
    // connection state changes (e.g. camera plugged in / unplugged).
    if ( prev === null || prev !== status.connected ) {
      restartPreview()
    }
  }, [statusQuery.data, statusQuery.isError, setStatus, restartPreview] )

  // ── Wait for settings before deciding anything ─────────────────
  if ( !settings ) return null

  // ── Don't render booth steps if payment guard hasn't passed ─────
  if ( settings.paymentEnabled && paymentStatus !== 'paid' ) return null

  // ── Frames loading / error state ────────────────────────────────
  if ( framesQuery.isLoading && step === 0 ) {
    return (
      <main className="flex items-center justify-center h-screen bg-neutral-100">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="size-8 animate-spin" />
          <p className="text-sm font-medium">Loading frames&hellip;</p>
        </div>
      </main>
    )
  }

  if ( framesQuery.isError && step === 0 ) {
    return (
      <main className="flex items-center justify-center h-screen bg-neutral-100">
        <div className="flex flex-col items-center gap-3 px-4 text-center">
          <AlertCircle className="size-8 text-red-500" />
          <p className="text-sm font-medium text-red-600">
            Failed to load frames
          </p>
          <p className="text-xs text-muted-foreground max-w-xs">
            Check your connection and try refreshing the page.
          </p>
        </div>
      </main>
    )
  }

  // ── Render active step ──────────────────────────────────────────
  const StepComponent = STEP_COMPONENTS[step]

  return (
    <main className="bg-neutral-100">
      <div className="h-screen xl:min-h-[unset] xl:h-screen overflow-hidden flex flex-col">
        {/* Timer indicator in the top-right corner */}
        <div className="absolute top-4 right-4 z-40">
          <StepTimer
            onTimesUp={handleTimesUp}
            resetKey={step === 1 ? photos.length : undefined}
          />
        </div>

        {StepComponent && <StepComponent />}
      </div>
    </main>
  )
}
