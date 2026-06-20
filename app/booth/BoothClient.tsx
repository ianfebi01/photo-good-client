'use client'

import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'

import { useBoothStore } from '@/store/boothStore'
import {
  FRAMES_QUERY_KEY,
  CAMERA_STATUS_QUERY_KEY,
  getCameraStatus,
  getAllFrames,
  ensureCameraDiscovered,
} from '@/lib/photobooth/frames.query'

import { StepCapture } from '@/components/booth/StepCapture'
import { StepResult } from '@/components/booth/StepResult'
import { StepSelectFrame } from '@/components/booth/StepSelectFrame'
import { StepFilter } from '@/components/booth/StepFilter'
import { StepTimer } from '@/components/booth/StepTimer'
import { useBodyBackground } from '@/lib/hooks/useBodyBackground'

export function BoothClient() {
  const { step, setStatus, setFrames, restartPreview } = useBoothStore()
  const statusRef = useRef<boolean | null>( null )
  const initialLoadRef = useRef( true )

  // Override body bg + theme-color for iOS Safari bars.
  useBodyBackground( '#f5f5f5' )

  // Kick off camera service discovery as early as possible so the stream URL
  // gets updated to the local service once detection completes.
  useEffect( () => {
    ensureCameraDiscovered().then( () => restartPreview() );
  }, [restartPreview] );

  const framesQuery = useQuery( {
    queryKey  : FRAMES_QUERY_KEY,
    queryFn   : getAllFrames,
    staleTime : 1000 * 60,
  } )

  const statusQuery = useQuery( {
    queryKey        : CAMERA_STATUS_QUERY_KEY,
    queryFn         : getCameraStatus,
    staleTime       : 4_000,
    refetchInterval : 4_000,
    retry           : false,
  } )

  useEffect( () => {
    if ( Array.isArray( framesQuery.data?.frames ) ) {
      setFrames( framesQuery.data.frames )
    }
  }, [framesQuery.data, setFrames] )

  useEffect( () => {
    if ( !statusQuery.data ) {
      if ( statusQuery.isError ) {
        setStatus( { connected : false, mock : true, gphoto2 : false } )
      }
      
      return
    }

    const status = statusQuery.data
    const isFirst = initialLoadRef.current
    initialLoadRef.current = false
    if ( isFirst || ( statusRef.current !== null && statusRef.current !== status.connected ) ) {
      restartPreview()
    }
    statusRef.current = status.connected
    setStatus( status )
  }, [statusQuery.data, statusQuery.isError, setStatus, restartPreview] )

  return (
    <main className="bg-neutral-100">
      <div className="h-screen xl:min-h-[unset] xl:h-screen overflow-hidden flex flex-col">
        {/* Timer indicator in the top-right corner */}
        <div className="absolute top-4 right-4 z-40">
          <StepTimer />
        </div>

        {step === 0 && <StepSelectFrame />}
        {step === 1 && <StepCapture />}
        {step === 2 && <StepFilter />}
        {step === 3 && <StepResult />}
      </div>
    </main>
  )
}
