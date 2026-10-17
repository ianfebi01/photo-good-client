'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useShallow } from 'zustand/react/shallow'

import { Button } from '@/components/ui/button'
import { useBoothStore } from '@/store/boothStore'
import {
  generateSessionVideo,
  generateSessionLoopVideo,
  syncSessionToServer,
  whenCountdownClipsSettled,
} from '@/lib/photobooth/frames.query'

import { SyncStatusBanner, type SyncStatus } from '@/components/booth/SyncStatusBanner'
import { VideoGenBadges, isSettled, type GenStatus } from '@/components/booth/VideoGenBadges'
import { QRSection } from '@/components/booth/QRSection'

// ── Session media (read fresh from the store at call time) ─────────

type GeneratedVideo = { url : string } | null

/** Countdown mashup, or an image slideshow when there are no clips. */
async function generateMashup(): Promise<GeneratedVideo> {
  // A clip may still be recording (ffmpeg finishes once the preview goes
  // quiet after the shot), so wait for it before reading the clip list.
  await whenCountdownClipsSettled()
  const s = useBoothStore.getState()

  return generateSessionVideo( {
    sessionId      : s.sessionId,
    files          : s.photos.map( ( p ) => p.file ),
    countdownFiles : s.countdownClips.map( ( c ) => c.file ),
    frameKey       : s.frameKey,
    // The strip applied the filter step's choice to every slot, so the
    // video has to as well.
    adjustments    : s.adjustments.map( ( adj ) => ( { ...adj, filter : s.globalFilter } ) ),
  } )
}

/** 15-second loop video from all images. */
function generateLoop(): Promise<GeneratedVideo> {
  const s = useBoothStore.getState()

  return generateSessionLoopVideo( { sessionId : s.sessionId, files : s.photos.map( ( p ) => p.file ) } )
}

function syncSession() {
  const s = useBoothStore.getState()

  return syncSessionToServer( {
    sessionId          : s.sessionId,
    frameKey           : s.frameKey,
    stripUrl           : s.strip,
    photoFiles         : s.photos.map( ( p ) => p.file ),
    videoUrl           : s.videoUrl ?? null,
    loopVideoUrl       : s.loopVideoUrl ?? null,
    countdownClipFiles : s.countdownClips.map( ( c ) => c.file ),
  } )
}

// ── Hooks ──────────────────────────────────────────────────────────

/**
 * Generate a video once `enabled` turns true, unless the store already has
 * one. While it runs the status reads as 'loading'.
 */
function useGeneratedVideo(
  url: string | null,
  enabled: boolean,
  generate: () => Promise<GeneratedVideo>,
  save: ( url: string ) => void,
): GenStatus {
  const [failure, setFailure] = useState<'error' | 'unavailable' | null>( null )
  const startedRef = useRef( false )

  useEffect( () => {
    if ( !enabled || url || startedRef.current ) return
    startedRef.current = true

    generate()
      .then( ( video ) => ( video ? save( video.url ) : setFailure( 'unavailable' ) ) )
      .catch( () => setFailure( 'error' ) )
  }, [enabled, url, generate, save] )

  if ( url ) return 'ready'
  if ( failure ) return failure

  return enabled ? 'loading' : 'idle'
}

/**
 * Upload the session once `enabled` turns true. `resultSynced` in the store
 * keeps it from uploading twice; clearing the error via `retry` re-runs it.
 */
function useResultSync( enabled: boolean ) {
  const resultSynced = useBoothStore( ( s ) => s.resultSynced )
  const sessionId = useBoothStore( ( s ) => s.sessionId )
  const [error, setError] = useState<string | null>( null )
  const [syncedId, setSyncedId] = useState<string | null>( null )
  const inFlightRef = useRef( false )

  const shouldSync = enabled && !resultSynced && !error

  useEffect( () => {
    if ( !shouldSync || inFlightRef.current ) return
    inFlightRef.current = true

    syncSession()
      .then( ( result ) => {
        if ( result.success ) {
          setSyncedId( result.sessionId ?? null )
          useBoothStore.setState( { resultSynced : true } )
        } else {
          setError( result.error ?? 'Unknown error' )
        }
      } )
      .catch( ( err ) => setError( err instanceof Error ? err.message : 'Unknown error' ) )
      .finally( () => {
        inFlightRef.current = false
      } )
  }, [shouldSync] )

  let status: SyncStatus = 'idle'
  if ( resultSynced ) status = 'done'
  else if ( error ) status = 'error'
  else if ( shouldSync ) status = 'syncing'

  return {
    status,
    error,
    resultSessionId : resultSynced ? syncedId ?? sessionId : null,
    retry           : () => setError( null ),
  }
}

// ── Main component ─────────────────────────────────────────────────

export function StepResult() {
  const router = useRouter()
  const {
    strip, hasPhotos, videoUrl, loopVideoUrl, timerEnabled, timerSecondsLeft,
    reset, setVideoUrl, setLoopVideoUrl,
  } = useBoothStore( useShallow( ( s ) => ( {
    strip            : s.strip,
    hasPhotos        : s.photos.length > 0,
    videoUrl         : s.videoUrl,
    loopVideoUrl     : s.loopVideoUrl,
    timerEnabled     : s.timerEnabled,
    timerSecondsLeft : s.timerSecondsLeft,
    reset            : s.reset,
    setVideoUrl      : s.setVideoUrl,
    setLoopVideoUrl  : s.setLoopVideoUrl,
  } ) ) )

  const hasMedia = Boolean( strip ) && hasPhotos
  const videoStatus = useGeneratedVideo( videoUrl, hasMedia, generateMashup, setVideoUrl )
  const loopStatus = useGeneratedVideo( loopVideoUrl, hasMedia, generateLoop, setLoopVideoUrl )
  const sync = useResultSync( hasMedia && isSettled( videoStatus ) && isSettled( loopStatus ) )

  // Navigate first and reset once the booth has unmounted. Resetting
  // eagerly clears `paymentStatus` while BoothClient is still mounted,
  // so its payment guard redirects to /booth/payment and wins the race.
  const resetOnLeaveRef = useRef( false )

  useEffect( () => () => {
    if ( resetOnLeaveRef.current ) reset()
  }, [reset] )

  const resetSession = useCallback( () => {
    resetOnLeaveRef.current = true
    router.replace( '/' )
  }, [router] )

  // StepTimer calls reset() when it reaches 1; on this step we go home
  // instead of falling back to the frame selector.
  useEffect( () => {
    if ( timerEnabled && timerSecondsLeft !== null && timerSecondsLeft <= 1 ) resetSession()
  }, [timerEnabled, timerSecondsLeft, resetSession] )

  if ( !strip ) return null

  return (
    <div className="container px-4 py-8 mx-auto overflow-auto lg:py-12 grow scrollbar-none lg:flex lg:flex-col lg:justify-center">
      <div className="mb-10 space-y-2 text-center">
        <h2 className="text-3xl font-bold tracking-tight lg:text-4xl text-foreground">
          Your photos are ready!
        </h2>
        <p className="max-w-md mx-auto text-sm text-muted-foreground lg:text-base font-jakarta">
          Download your photo strip, countdown mashup, or 15-second loop
          video below.
        </p>
      </div>

      <div className="font-jakarta">
        <VideoGenBadges
          videoStatus={videoStatus}
          loopStatus={loopStatus}
        />

        <div className="flex items-center justify-center gap-2 mb-6">
          <SyncStatusBanner
            status={sync.status}
            error={sync.error}
            onRetry={sync.retry}
          />
        </div>

        <div className="flex flex-col items-center gap-8 lg:flex-row lg:justify-center lg:items-center">
          <div className="w-full max-w-xs">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={strip}
              alt="Composed photo strip"
              className="w-full border rounded-xl shadow-md"
            />
          </div>

          {/* Always occupies its space to prevent layout shift */}
          <QRSection
            syncStatus={sync.status}
            resultSessionId={sync.resultSessionId}
          />
        </div>

        <div className="flex justify-center gap-3 mt-10">
          <Button
            size="lg"
            variant="outline"
            onClick={resetSession}
            disabled={sync.status === 'syncing'}
          >
            Start new session
          </Button>
        </div>
      </div>
    </div>
  )
}
