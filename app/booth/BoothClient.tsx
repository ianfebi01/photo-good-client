'use client'

import { useEffect, useRef } from 'react'
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

// ── Step component map ────────────────────────────────────────────

const STEP_COMPONENTS: Record<number, React.ComponentType> = {
  0 : StepSelectFrame,
  1 : StepCapture,
  2 : StepFilter,
  3 : StepResult,
}

// ── Main component ─────────────────────────────────────────────────

export function BoothClient() {
  const { step, setStatus, setFrames, restartPreview } = useBoothStore()

  // Override body bg + theme-color for iOS Safari bars.
  useBodyBackground( '#f5f5f5' )

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

  const lastFramesRef = useRef<ClientFrame[] | null>( null )

  useEffect( () => {
    const frames = framesQuery.data?.frames
    if ( !Array.isArray( frames ) ) return
    // Only sync to store when the array identity changes
    if ( frames === lastFramesRef.current ) return
    lastFramesRef.current = frames
    setFrames( frames )
  }, [framesQuery.data, setFrames] )

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
          <StepTimer />
        </div>

        {StepComponent && <StepComponent />}
      </div>
    </main>
  )
}
