'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, CheckCircle2, AlertCircle, QrCode } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { BoothQR } from '@/components/booth/BoothQR'
import { useBoothStore } from '@/store/boothStore'
import {
  generateSessionVideo,
  generateSessionLoopVideo,
  syncSessionToServer,
} from '@/lib/photobooth/frames.query'

type GenStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'
type SyncStatus = 'idle' | 'syncing' | 'done' | 'error'

function isSettled( s: GenStatus ) {
  return s === 'ready' || s === 'error' || s === 'unavailable'
}

// ── Sub-component: Sync status banner ─────────────────────────────

function SyncStatusBanner( {
  status,
  error,
  onRetry,
}: {
  status: SyncStatus
  error: string | null
  onRetry: () => void
} ) {
  if ( status === 'syncing' ) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-full bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
        <Loader2 className="size-4 animate-spin" />
        Uploading to server&hellip;
      </div>
    )
  }

  if ( status === 'done' ) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
        <CheckCircle2 className="size-4" />
        Uploaded to server
      </div>
    )
  }

  if ( status === 'error' ) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-full bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">
        <AlertCircle className="size-4" />
        Upload failed{error ? `: ${error}` : ''}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 ml-1 text-xs"
          onClick={onRetry}
        >
          <RefreshCw className="mr-1 size-3" />
          Retry
        </Button>
      </div>
    )
  }

  return null
}

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
    reset,
    setVideoUrl,
    setLoopVideoUrl,
  } = useBoothStore()

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
  const [syncStatus, setSyncStatus] = useState<SyncStatus>( 'idle' )
  const [syncError, setSyncError] = useState<string | null>( null )
  const [resultSessionId, setResultSessionId] = useState<string | null>( null )

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
    } else {
      setSyncStatus( 'error' )
      setSyncError( result.error ?? 'Unknown error' )
    }
  }, [strip, photos, sessionId, frameKey, videoUrl, loopVideoUrl, countdownClips] )

  // Auto-trigger sync once both video statuses have settled.
  // Only fires once per session — manual retry calls doSync() directly.
  useEffect( () => {
    if ( syncAttemptedRef.current ) return
    if ( !strip || photos.length === 0 ) return
    if ( !isSettled( videoStatus ) || !isSettled( loopStatus ) ) return

    syncAttemptedRef.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect
    doSync()
  }, [strip, photos, videoStatus, loopStatus, doSync] )

  // Manual retry — calls doSync directly without waiting for the
  // auto-trigger effect (avoids double-fire).
  const retrySync = useCallback( () => {
    doSync()
  }, [doSync] )

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
      <div className="flex flex-wrap items-center justify-center gap-3 mb-4">
        {videoStatus === 'loading' && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            <Loader2 className="size-3 animate-spin" />
            Generating mashup video&hellip;
          </span>
        )}
        {videoStatus === 'error' && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">
            <AlertCircle className="size-3" />
            Mashup video failed
          </span>
        )}
        {videoStatus === 'unavailable' && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-gray-50 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            Mashup unavailable
          </span>
        )}

        {loopStatus === 'loading' && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            <Loader2 className="size-3 animate-spin" />
            Generating loop video&hellip;
          </span>
        )}
        {loopStatus === 'error' && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">
            <AlertCircle className="size-3" />
            Loop video failed
          </span>
        )}
        {loopStatus === 'unavailable' && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-gray-50 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            Loop unavailable
          </span>
        )}
      </div>

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
        <div className="flex flex-col items-center gap-4">
          {syncStatus === 'done' && resultSessionId ? (
            <>
              <BoothQR
                page={`${process.env.NEXT_PUBLIC_BASE_URL || ''}/r/${resultSessionId}`}
              />
              <p className="text-sm text-muted-foreground text-center max-w-xs">
                Scan to view &amp; download your photos on your phone
              </p>
            </>
          ) : (
            // Placeholder that mirrors BoothQR dimensions exactly —
            // prevents layout shift when the real QR renders in.
            <div className="flex flex-col items-center gap-3 p-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                <QrCode className="size-4" />
                Scan to open on phone
              </div>
              <div className="relative size-50 rounded-xl border bg-secondary/50 shadow-sm flex items-center justify-center">
                <Loader2 className="size-8 animate-spin text-muted-foreground/60" />
              </div>
              <span className="text-xs text-muted-foreground h-8" />
            </div>
          )}
        </div>
      </div>

      {/* ── Bottom actions ────────────────────────────────────────── */}
      <div className="flex justify-center gap-3 mt-10">
        <Button
          size="lg"
          variant="outline"
          onClick={reset}
        >
          Start new session
        </Button>
      </div>
    </div>
  )
}
