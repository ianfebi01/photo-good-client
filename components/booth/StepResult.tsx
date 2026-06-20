'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Film, Images, Loader2, RefreshCw, Repeat, Clapperboard, ImageDown } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useBoothStore } from '@/store/boothStore'
import {
  generateSessionVideo,
  generateSessionLoopVideo,
  convertCountdownClip,
} from '@/lib/photobooth/frames.query'

type GenStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'

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

  // Index of the clip currently being converted to MP4 for download (or null).
  const [downloadingClip, setDownloadingClip] = useState<number | null>( null )
  const [downloadingAllPhotos, setDownloadingAllPhotos] = useState( false )

  /** Download every raw capture photo sequentially as individual files. */
  const handleDownloadAllPhotos = useCallback( async () => {
    if ( downloadingAllPhotos || photos.length === 0 ) return
    setDownloadingAllPhotos( true )
    try {
      for ( let i = 0; i < photos.length; i++ ) {
        const { url, file } = photos[i]
        // Infer a clean filename from the stored file name, falling back to index.
        const name = file || `photo-${i + 1}.jpg`
        const a = document.createElement( 'a' )
        a.href = url
        a.download = name
        document.body.appendChild( a )
        a.click()
        a.remove()
        // Small delay so the browser doesn't coalesce / block multiple downloads
        if ( i < photos.length - 1 ) {
          await new Promise( ( r ) => setTimeout( r, 300 ) )
        }
      }
    } finally {
      setDownloadingAllPhotos( false )
    }
  }, [downloadingAllPhotos, photos] )

  const handleDownloadClip = async ( file: string, index: number ) => {
    if ( downloadingClip !== null ) return
    setDownloadingClip( index )
    try {
      const result = await convertCountdownClip( { file } )
      // Fall back to the raw webm if ffmpeg isn't available server-side.
      const url = result?.url ?? `/api/captures/${file}`
      const ext = result ? 'mp4' : 'webm'
      const a = document.createElement( 'a' )
      a.href = url
      a.download = `countdown-${index + 1}.${ext}`
      document.body.appendChild( a )
      a.click()
      a.remove()
    } catch {
      // Conversion failed — leave the UI untouched so the user can retry.
    } finally {
      setDownloadingClip( null )
    }
  }

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

  const retryVideo = () => {
    startedRef.current.video = false
    setVideoStatus( 'idle' )
    setVideoUrl( null )
  }
  const retryLoop = () => {
    startedRef.current.loop = false
    setLoopStatus( 'idle' )
    setLoopVideoUrl( null )
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

      {/* ── Grid: Strip (hero) + Media cards ───────────────────── */}
      <div className="flex flex-col gap-6 lg:flex-row lg:flex-wrap overflow-hidden">
        {/* Photo Strip */}
        <Card className="flex flex-col overflow-hidden lg:basis-[calc(50%-0.75rem)]">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center rounded-lg size-8 bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400">
                <Images className="size-4" />
              </div>
              <div>
                <CardTitle className="text-base">Photo Strip</CardTitle>
                <CardDescription>
                  {photos.length} photo{photos.length > 1 ? 's' : ''} • {frameKey}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={strip}
              alt="Composed photo strip"
              className="w-full border rounded-lg shadow-sm"
            />
            <a
              href={strip}
              download={`photobooth-${frameKey}.jpg`}
              className="block"
            >
              <Button variant="outline"
                size="sm"
                className="w-full"
              >
                <Download className="mr-2 size-4" />
                Download Strip
              </Button>
            </a>
          </CardContent>
        </Card>

        {/* Right column for videos */}

        {/* ── Countdown Mashup Video ───────────────────────────── */}
        <Card className="flex flex-col lg:basis-[calc(50%-0.75rem)]">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center rounded-lg size-8 bg-rose-100 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400">
                <Film className="size-4" />
              </div>
              <div>
                <CardTitle className="text-base">
                  {countdownClips.length > 0
                    ? 'Countdown Mashup'
                    : 'Video Slideshow'}
                </CardTitle>
                <CardDescription>
                  {countdownClips.length > 0
                    ? `${countdownClips.length} clips combined`
                    : 'MP4 with all photos'}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {videoStatus === 'loading' && (
              <div className="flex items-center justify-center rounded-lg bg-muted/50"
                style={{ aspectRatio : '16/9', height : 'auto' }}
              >
                <div className="flex flex-col items-center gap-3 text-muted-foreground">
                  <Loader2 className="size-8 animate-spin" />
                  <span className="text-xs font-medium">
                    Rendering video&hellip;
                  </span>
                </div>
              </div>
            )}

            {( videoStatus === 'ready' && videoUrl ) && (
              <>
                <video
                  autoPlay
                  loop
                  muted
                  playsInline
                  webkit-playsinline="true"
                  preload="auto"
                  className="w-full border rounded-lg shadow-sm"
                >
                  <source src={videoUrl}
                    type="video/mp4"
                  />
                </video>
                <a
                  href={videoUrl}
                  download={`photobooth-${frameKey}.mp4`}
                  className="block"
                >
                  <Button variant="outline"
                    size="sm"
                    className="w-full"
                  >
                    <Download className="mr-2 size-4" />
                    Download Video
                  </Button>
                </a>
              </>
            )}

            {videoStatus === 'unavailable' && (
              <div className="flex flex-col items-center gap-2 py-6 text-center">
                <Film className="size-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  ffmpeg is not installed.
                  <br />
                  Install it to enable video generation.
                </p>
              </div>
            )}

            {videoStatus === 'error' && (
              <div className="flex flex-col items-center gap-2 py-4 text-center">
                <p className="text-sm text-destructive">
                  Failed to generate video
                </p>
                <Button variant="outline"
                  size="sm"
                  onClick={retryVideo}
                >
                  <RefreshCw className="mr-2 size-3" />
                  Retry
                </Button>
              </div>
            )}

            {videoStatus === 'idle' && (
              <div className="flex items-center justify-center border border-dashed rounded-lg bg-muted/30"
                style={{ aspectRatio : '16/9', height : 'auto' }}
              >
                <span className="text-xs text-muted-foreground">
                  Waiting for strip&hellip;
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        <div className='flex flex-col gap-6 lg:grid lg:grid-cols-2 lg:basis-full overflow-hidden'>
        
          {/* ── Loop Video ────────────────────────────────────────── */}
          <Card className="flex flex-col lg:grow">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="flex items-center justify-center text-indigo-600 bg-indigo-100 rounded-lg size-8 dark:bg-indigo-900/30 dark:text-indigo-400">
                  <Repeat className="size-4" />
                </div>
                <div>
                  <CardTitle className="text-base">Loop Video</CardTitle>
                  <CardDescription>
                  All {photos.length} photos &bull; 0.7s each
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {loopStatus === 'loading' && (
                <div className="flex items-center justify-center rounded-lg bg-muted/50"
                  style={{ aspectRatio : '3/2', height : 'auto' }}
                >
                  <div className="flex flex-col items-center gap-3 text-muted-foreground">
                    <Loader2 className="size-8 animate-spin" />
                    <span className="text-xs font-medium">
                    Rendering loop video&hellip;
                    </span>
                  </div>
                </div>
              )}

              {( loopStatus === 'ready' && loopVideoUrl ) && (
                <>
                  <video
                    controls={false}
                    loop
                    autoPlay
                    muted
                    playsInline
                    webkit-playsinline="true"
                    preload="auto"
                    className="w-full border rounded-lg shadow-sm"
                    style={{ aspectRatio : '3/2', height : 'auto' }}
                  >
                    <source src={loopVideoUrl}
                      type="video/mp4"
                    />
                  </video>
                  <a
                    href={loopVideoUrl}
                    download={`photobooth-${frameKey}-loop.mp4`}
                    className="block"
                  >
                    <Button variant="outline"
                      size="sm"
                      className="w-full"
                    >
                      <Download className="mr-2 size-4" />
                    Download Loop
                    </Button>
                  </a>
                </>
              )}

              {loopStatus === 'unavailable' && (
                <div className="flex flex-col items-center gap-2 py-6 text-center">
                  <Repeat className="size-8 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">
                  ffmpeg is not installed.
                    <br />
                  Install it to enable video generation.
                  </p>
                </div>
              )}

              {loopStatus === 'error' && (
                <div className="flex flex-col items-center gap-2 py-4 text-center">
                  <p className="text-sm text-destructive">
                  Failed to generate loop video
                  </p>
                  <Button variant="outline"
                    size="sm"
                    onClick={retryLoop}
                  >
                    <RefreshCw className="mr-2 size-3" />
                  Retry
                  </Button>
                </div>
              )}

              {loopStatus === 'idle' && (
                <div className="flex items-center justify-center border border-dashed rounded-lg bg-muted/30"
                  style={{ aspectRatio : '3/2', height : 'auto' }}
                >
                  <span className="text-xs text-muted-foreground">
                  Waiting for strip&hellip;
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Countdown clips ──────────────────────────────────── */}
          {countdownClips.length > 0 && (
            <Card className="flex flex-col overflow-hidden">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-center rounded-lg size-8 bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400">
                    <Clapperboard className="size-4" />
                  </div>
                  <div>
                    <CardTitle className="text-base">Raw Countdown Clips</CardTitle>
                    <CardDescription>
                      {countdownClips.length} clip{countdownClips.length > 1 ? 's' : ''} &bull; scroll to view
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className='overflow-hidden grow'>
                <div className="flex h-full gap-3 overflow-x-auto scrollbar-thin scrollbar-thumb-neutral-300">
                  {countdownClips.map( ( clip, i ) => (
                    <div
                      key={clip.file}
                      className="h-full rounded-lg shadow-sm relative min-h-50"
                      style={{ aspectRatio : 3 / 2, width : 'auto' }}
                    >
                      <video
                        autoPlay
                        loop
                        muted
                        playsInline
                        webkit-playsinline="true"
                        preload="auto"
                        className="w-full h-full object-cover rounded-lg"
                      >
                        <source src={clip.url}
                          type="video/webm"
                        />
                      </video>

                      <div className='absolute bottom-0 inset-x-0 flex items-center justify-between gap-4 text-white rounded-b-lg overflow-hidden'>
                        <div className='absolute w-full bottom-0 bg-linear-to-t from-black/50 to-transparent h-full z-0'></div>
                        <div className='flex items-center justify-between relative z-1 w-full pb-2 pt-8 px-4'>
                          <span className="text-lg font-medium">
                        Shot {i + 1}
                          </span>
                          <Button variant="ghost"
                            size="sm"
                            className="size-8"
                            disabled={downloadingClip !== null}
                            onClick={() => handleDownloadClip( clip.file, i )}
                            title="Download as MP4"
                          >
                            {downloadingClip === i ? (
                              <Loader2 className="size-6 animate-spin" />
                            ) : (
                              <Download className="size-6" />
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* ── Bottom actions ──────────────────────────────────────── */}
      <div className="flex justify-center gap-3 mt-10">
        <Button size="lg"
          variant="outline"
          onClick={handleDownloadAllPhotos}
          disabled={downloadingAllPhotos}
        >
          {downloadingAllPhotos ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <ImageDown className="mr-2 size-4" />
          )}
          Download all photos
        </Button>
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
