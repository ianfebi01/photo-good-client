'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react'

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

  const [videoStatus, setVideoStatus] = useState<GenStatus>(
    videoUrl ? 'ready' : 'idle',
  )
  const [loopStatus, setLoopStatus] = useState<GenStatus>(
    loopVideoUrl ? 'ready' : 'idle',
  )

  const startedRef = useRef( { video : false, loop : false } )

  // ── Server sync state ──────────────────────────────────────────
  const [syncStatus, setSyncStatus] = useState<SyncStatus>( 'idle' )
  const [syncError, setSyncError] = useState<string | null>( null )
  const [resultSessionId, setResultSessionId] = useState<string | null>( null )
  const syncStartedRef = useRef( false )

  // Kick off video generation after the strip is ready
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
  }, [strip, photos, sessionId, countdownClips, videoUrl, loopVideoUrl, frameKey, setVideoUrl, setLoopVideoUrl] )

  // ── Sync all results to the external server ────────────────────
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

  // Auto-trigger sync once both video statuses have settled
  useEffect( () => {
    if ( syncStartedRef.current ) return
    if ( !strip || photos.length === 0 ) return

    // Wait until both video tasks have settled (ready / error / unavailable).
    // 'idle' or 'loading' means work is still in-flight.
    const videoSettled = videoStatus === 'ready' || videoStatus === 'error' || videoStatus === 'unavailable'
    const loopSettled = loopStatus === 'ready' || loopStatus === 'error' || loopStatus === 'unavailable'
    if ( !videoSettled || !loopSettled ) return

    syncStartedRef.current = true
    doSync()
  }, [strip, photos, videoStatus, loopStatus, doSync] )

  const retrySync = () => {
    syncStartedRef.current = false
    setSyncStatus( 'idle' )
    setSyncError( null )
    doSync()
  }

  if ( !strip ) return null

  return (
    <div className="container px-4 py-8 mx-auto overflow-auto lg:py-12 grow scrollbar-none">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="mb-10 space-y-2 text-center">
        <h2 className="text-3xl font-bold tracking-tight lg:text-4xl text-foreground">
          Your photos are ready!
        </h2>
        <p className="max-w-md mx-auto text-sm text-muted-foreground lg:text-base">
          Download your photo strip, countdown mashup, or 15-second loop video below.
        </p>
      </div>

      {/* ── Upload status banner ──────────────────────────────── */}
      <div className="flex items-center justify-center gap-2 mb-6">
        {syncStatus === 'syncing' && (
          <div className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-full bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
            <Loader2 className="size-4 animate-spin" />
            Uploading to server&hellip;
          </div>
        )}
        {syncStatus === 'done' && (
          <div className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
            <CheckCircle2 className="size-4" />
            Uploaded to server
          </div>
        )}
        {syncStatus === 'error' && (
          <div className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-full bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">
            <AlertCircle className="size-4" />
            Upload failed{syncError ? `: ${syncError}` : ''}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 ml-1 text-xs"
              onClick={retrySync}
            >
              <RefreshCw className="mr-1 size-3" />
              Retry
            </Button>
          </div>
        )}
      </div>

      {/* ── QR Code + Strip preview ──────────────────────────── */}
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

        {/* QR Code */}
        {syncStatus === 'done' && resultSessionId && (
          <div className="flex flex-col items-center gap-4">
            <BoothQR page={`${process.env.NEXT_PUBLIC_BASE_URL || ''}/r/${resultSessionId}`} />
            <p className="text-sm text-muted-foreground text-center max-w-xs">
              Scan to view &amp; download your photos on your phone
            </p>
          </div>
        )}

        {syncStatus === 'syncing' && (
          <div className="flex flex-col items-center gap-4 py-12">
            <Loader2 className="size-10 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Generating QR code&hellip;</p>
          </div>
        )}
      </div>
      {/* ── Bottom actions ──────────────────────────────────────── */}
      <div className="flex justify-center gap-3 mt-10">
        <Button size="lg"
          variant="outline"
          onClick={reset}
        >
          Start new session
        </Button>
      </div>
    </div>
  )
}
