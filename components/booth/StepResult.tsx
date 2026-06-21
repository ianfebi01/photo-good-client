'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { useBoothStore } from '@/store/boothStore'
import {
  generateSessionVideo,
  generateSessionLoopVideo,
  syncSessionToServer,
} from '@/lib/photobooth/frames.query'

import { SyncStatusBanner, type SyncStatus } from '@/components/booth/SyncStatusBanner'
import { VideoGenBadges, isSettled, type GenStatus } from '@/components/booth/VideoGenBadges'
import { QRSection } from '@/components/booth/QRSection'

// ── Main component ─────────────────────────────────────────────────

export function StepResult() {
  const {
    strip,
    videoUrl,
    loopVideoUrl,
    frameKey,
    photos,
    sessionId,
    countdownClips,
    timerEnabled,
    timerSecondsLeft,
    resultSynced,
    reset,
    setVideoUrl,
    setLoopVideoUrl,
  } = useBoothStore()

  const router = useRouter()

  // ── Derive initial statuses from persisted store values ─────────
  const [videoStatus, setVideoStatus] = useState<GenStatus>( () =>
    videoUrl ? 'ready' : 'idle',
  )
  const [loopStatus, setLoopStatus] = useState<GenStatus>( () =>
    loopVideoUrl ? 'ready' : 'idle',
  )

  // Ref-based guards for one-shot generation & sync
  const startedRef = useRef( { video : false, loop : false } )
  const syncAttemptedRef = useRef( false )

  // ── Reset in-flight guards when the session changes ──────────────
  // Must be in a useEffect (before the generation effect) to comply
  // with React 19's rule against reading/writing refs during render.
  useEffect( () => {
    startedRef.current = { video : false, loop : false }
    syncAttemptedRef.current = false
    // Re-derive statuses from (potentially new) store values.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVideoStatus( videoUrl ? 'ready' : 'idle' )
    setLoopStatus( loopVideoUrl ? 'ready' : 'idle' )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId] )

  // ── Kick off video generation after the strip is ready ──────────
  useEffect( () => {
    if ( !strip || photos.length === 0 ) return

    const files = photos.map( ( p ) => p.file )
    const cdFiles = countdownClips.map( ( c ) => c.file )

    // Countdown mashup (or image slideshow fallback)
    if ( !startedRef.current.video && !videoUrl ) {
      startedRef.current.video = true
      setVideoStatus( 'loading' )
      generateSessionVideo( { sessionId, files, countdownFiles : cdFiles, frameKey } )
        .then( ( r ) => {
          if ( r ) {
            setVideoUrl( r.url )
            setVideoStatus( 'ready' )
          } else {
            setVideoStatus( 'unavailable' )
          }
        } )
        .catch( () => setVideoStatus( 'error' ) )
    }

    // 15-second loop video from all images
    if ( !startedRef.current.loop && !loopVideoUrl ) {
      startedRef.current.loop = true
      setLoopStatus( 'loading' )
      generateSessionLoopVideo( { sessionId, files } )
        .then( ( r ) => {
          if ( r ) {
            setLoopVideoUrl( r.url )
            setLoopStatus( 'ready' )
          } else {
            setLoopStatus( 'unavailable' )
          }
        } )
        .catch( () => setLoopStatus( 'error' ) )
    }
  }, [
    strip,
    photos,
    sessionId,
    countdownClips,
    videoUrl,
    loopVideoUrl,
    frameKey,
    setVideoUrl,
    setLoopVideoUrl,
  ] )

  // ── Server sync ─────────────────────────────────────────────────
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(
    resultSynced ? 'done' : 'idle',
  )
  const [syncError, setSyncError] = useState<string | null>( null )
  const [resultSessionId, setResultSessionId] = useState<string | null>(
    resultSynced ? sessionId : null,
  )

  const doSync = useCallback( async () => {
    if ( !strip || photos.length === 0 ) return

    setSyncStatus( 'syncing' )
    setSyncError( null )

    const result = await syncSessionToServer( {
      sessionId,
      frameKey,
      stripUrl           : strip,
      photoFiles         : photos.map( ( p ) => p.file ),
      videoUrl           : videoUrl ?? null,
      loopVideoUrl       : loopVideoUrl ?? null,
      countdownClipFiles : countdownClips.map( ( c ) => c.file ),
    } )

    if ( result.success ) {
      setSyncStatus( 'done' )
      setResultSessionId( result.sessionId ?? sessionId )
      useBoothStore.setState( { resultSynced : true } )
    } else {
      setSyncStatus( 'error' )
      setSyncError( result.error ?? 'Unknown error' )
    }
  }, [strip, photos, sessionId, frameKey, videoUrl, loopVideoUrl, countdownClips] )

  // Auto-trigger sync once both video statuses have settled.
  // Persisted `resultSynced` prevents re-syncing on page refresh.
  useEffect( () => {
    if ( syncAttemptedRef.current || resultSynced ) return
    if ( !strip || photos.length === 0 ) return
    if ( !isSettled( videoStatus ) || !isSettled( loopStatus ) ) return

    syncAttemptedRef.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect
    doSync()
  }, [strip, photos, videoStatus, loopStatus, resultSynced, doSync] )

  // Manual retry — calls doSync directly without waiting for the
  // auto-trigger effect (avoids double-fire).
  const retrySync = useCallback( () => {
    doSync()
  }, [doSync] )

  const resetSession = useCallback( () => {
    reset()
    router.push( '/booth/payment' )
  }, [reset, router] )

  // ── Idle timer expiry → navigate home ───────────────────────────
  // StepTimer counts down and calls reset() when it reaches 1.
  // On the result step, we navigate to the homepage instead of
  // just resetting back to the frame selector.
  useEffect( () => {
    if ( !timerEnabled || timerSecondsLeft === null ) return
    if ( timerSecondsLeft <= 1 ) {
      resetSession()
    }
  }, [timerSecondsLeft, timerEnabled, resetSession] )

  // ── Early return: no strip yet ──────────────────────────────────
  if ( !strip ) return null

  return (
    <div className="container px-4 py-8 mx-auto overflow-auto lg:py-12 grow scrollbar-none">
      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="mb-10 space-y-2 text-center">
        <h2 className="text-3xl font-bold tracking-tight lg:text-4xl text-foreground">
          Your photos are ready!
        </h2>
        <p className="max-w-md mx-auto text-sm text-muted-foreground lg:text-base">
          Download your photo strip, countdown mashup, or 15-second loop
          video below.
        </p>
      </div>

      {/* ── Video generation status ──────────────────────────────── */}
      <VideoGenBadges
        videoStatus={videoStatus}
        loopStatus={loopStatus}
      />

      {/* ── Upload status banner ─────────────────────────────────── */}
      <div className="flex items-center justify-center gap-2 mb-6">
        <SyncStatusBanner
          status={syncStatus}
          error={syncError}
          onRetry={retrySync}
        />
      </div>

      {/* ── QR Code + Strip preview ──────────────────────────────── */}
      <div className="flex flex-col items-center gap-8 lg:flex-row lg:justify-center lg:items-start">
        {/* Strip preview */}
        {strip && (
          <div className="w-full max-w-xs">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={strip}
              alt="Composed photo strip"
              className="w-full border rounded-xl shadow-md"
            />
          </div>
        )}

        {/* QR Code — always occupies its space to prevent layout shift */}
        <QRSection
          syncStatus={syncStatus}
          resultSessionId={resultSessionId}
        />
      </div>

      {/* ── Bottom actions ────────────────────────────────────────── */}
      <div className="flex justify-center gap-3 mt-10">
        <Button
          size="lg"
          variant="outline"
          onClick={resetSession}
        >
          Start new session
        </Button>
      </div>
    </div>
  )
}
