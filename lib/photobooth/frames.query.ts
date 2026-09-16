import type { ClientFrame } from './frames.client'
import type { CameraDevice, CameraMode, CameraModeState } from '@/types/booth'
import type { Status } from '@/store/boothStore'

export const FRAMES_QUERY_KEY = ['frames'] as const
export const CAMERA_STATUS_QUERY_KEY = ['camera-status'] as const

export type PageArg = { page: number; limit: number }

export type FramesResponse = {
  frames: ClientFrame[]
  total: number
}

export type FrameSlot = {
  left: number
  top: number
  width: number
  height: number
}

async function parseJson<T>( response: Response, fallbackMessage: string ): Promise<T> {
  const data = await response.json().catch( () => null )
  if ( !response.ok ) {
    const message = data?.error ?? fallbackMessage
    throw new Error( message )
  }

  return data as T
}

export async function getFrames( { page, limit }: PageArg ): Promise<FramesResponse> {
  const response = await fetch( `/api/frames?page=${page}&limit=${limit}`, { cache : 'no-store' } )

  return parseJson<FramesResponse>( response, 'Failed to load frames' )
}

/** Fetch all frames (unpaginated — for frame selector). */
export async function getAllFrames(): Promise<FramesResponse> {
  const response = await fetch( '/api/frames?page=1&limit=200', { cache : 'no-store' } )
  const data = await parseJson<FramesResponse>( response, 'Failed to load frames' )

  return data
}

// ── Camera service URL resolution ────────────────────────────────────
//
// Priority:
//   1. `__CAMERA_SERVICE_URL` — runtime override via browser console
//   2. `NEXT_PUBLIC_CAMERA_SERVICE_URL` — baked in at build time
//   3. `http://127.0.0.1:8088` — auto-detected if the Python sidecar is running
//   4. `null` — fall back to server API routes
//
// Auto-detection is lazy: the first status poll probes the local service and
// caches the result so subsequent calls don't re-check.

let _cameraBase: string | null | undefined = undefined;
let _discovering: Promise<string | null> | null = null;

function _explicitUrl(): string | null {
  try {
    if ( typeof __CAMERA_SERVICE_URL === "string" ) {
      return __CAMERA_SERVICE_URL as string;
    }
  } catch {
    /* not in browser */
  }
  
  return process.env.NEXT_PUBLIC_CAMERA_SERVICE_URL ?? null;
}

async function _discoverUrl(): Promise<string | null> {
  const explicit = _explicitUrl();
  if ( explicit ) return explicit;

  // Probe the default local sidecar port
  try {
    const res = await fetch( "http://127.0.0.1:8088/status", {
      signal : AbortSignal.timeout( 800 ),
      cache  : "no-store",
    } );
    if ( res.ok ) {
      const data = await res.json();
      // Only use it if a real camera is connected, not when it's just the
      // sidecar running with no camera — otherwise mock mode on the server
      // is actually better (gives mock photos instead of errors).
      if ( data.connected ) return "http://127.0.0.1:8088";
    }
  } catch {
    /* unreachable */
  }
  
  return null;
}

function getCameraServiceUrl(): string | null {
  if ( _cameraBase !== undefined ) return _cameraBase;
  
  // If no discovery is in-flight, return the explicit URL (or null) synchronously
  return _explicitUrl();
}

/** Kicks off auto-detection on first call; idempotent. */
export function ensureCameraDiscovered(): Promise<string | null> {
  if ( _cameraBase !== undefined ) return Promise.resolve( _cameraBase );
  if ( _discovering ) return _discovering;
  _discovering = _discoverUrl().then( ( url ) => {
    _cameraBase = url;
    _discovering = null;
    
    return url;
  } );
  
  return _discovering;
}

/** URL for the MJPEG live preview stream (local service or server proxy). */
export function getCameraPreviewUrl( streamKey: string ): string {
  const base = getCameraServiceUrl();
  if ( base ) return `${base}/preview`;

  return `/api/camera/stream?key=${streamKey}`;
}

export async function getCameraStatus(): Promise<Status> {
  // Ensure discovery runs before fetching status
  const base = await ensureCameraDiscovered();

  if ( base ) {
    try {
      const res = await fetch( `${base}/status`, { cache : "no-store" } );
      const data = await parseJson<any>( res, "Failed to load camera status" );
      
      return {
        connected : data.connected,
        mock      : !data.connected,
        model     : data.model ?? undefined,
        gphoto2   : true,        // Carry the source through: the booth's mode toggle reads it from here.
        mode      : data.mode === 'gphoto' ? 'gphoto' : 'uvc',
        device    : data.device ?? null,      };
    } catch {
      // Sidecar became unreachable — fall through to server fallback
      _cameraBase = null;
    }
  }

  // Fall back to server API
  const response = await fetch( "/api/camera/status", { cache : "no-store" } );
  
  return parseJson<Status>( response, "Failed to load camera status" );
}

// ── Camera source (gphoto PTP vs. USB video capture) ─────────────────

/** Coerce whatever the camera service returned into a complete mode state. */
function normalizeModeState(
  modeData: Partial<CameraModeState> & { mode?: string },
  devices: CameraDevice[] = [],
): CameraModeState {
  const modes = Array.isArray( modeData.modes )
    ? modeData.modes.filter( ( m ): m is CameraMode => m === 'gphoto' || m === 'uvc' )
    : []

  return {
    mode   : modeData.mode === 'gphoto' ? 'gphoto' : 'uvc',
    device : modeData.device ?? null,
    modes  : modes.length ? modes : [ 'gphoto', 'uvc' ],
    ffmpeg : Boolean( modeData.ffmpeg ),
    devices,
  }
}

/**
 * The camera source in use, plus the capture devices this camera host can read.
 *
 * Reads the local service directly when the browser can reach it (same
 * preference order as captures), otherwise the app's `/api/camera/mode` proxy.
 */
export async function getCameraModeState(): Promise<CameraModeState> {
  const base = await ensureCameraDiscovered()

  if ( base ) {
    try {
      const [ modeRes, devicesRes ] = await Promise.all( [
        fetch( `${base}/mode`, { cache : 'no-store' } ),
        fetch( `${base}/devices`, { cache : 'no-store' } ),
      ] )
      const modeData = await parseJson<Partial<CameraModeState>>(
        modeRes,
        'Failed to read camera mode',
      )
      const deviceData = devicesRes.ok
        ? await devicesRes.json().catch( () => null )
        : null

      return normalizeModeState( modeData, deviceData?.devices ?? [] )
    } catch {
      // Sidecar became unreachable — fall through to the server proxy
      _cameraBase = null
    }
  }

  const response = await fetch( '/api/camera/mode', { cache : 'no-store' } )

  return normalizeModeState( await parseJson<CameraModeState>( response, 'Failed to read camera mode' ) )
}

/**
 * Switch the camera source (`gphoto` ⇄ `uvc`).
 *
 * Callers must restart the preview afterwards: the running MJPEG stream was
 * opened against the old source and will not switch by itself.
 */
export async function setCameraMode(
  mode: CameraMode,
  device?: string,
): Promise<CameraModeState> {
  const body = JSON.stringify( { mode, ...( device ? { device } : {} ) } )
  const init: RequestInit = {
    method  : 'POST',
    headers : { 'Content-Type' : 'application/json' },
    body,
  }
  const base = await ensureCameraDiscovered()

  if ( base ) {
    try {
      const res = await fetch( `${base}/mode`, init )
      await parseJson<{ mode : CameraMode }>( res, 'Camera mode switch failed' )

      // Re-read so the device list and resolved device match the new source.
      return getCameraModeState()
    } catch ( err ) {
      if ( err instanceof TypeError ) _cameraBase = null // service gone
      else throw err
    }
  }

  const response = await fetch( '/api/camera/mode', init )

  return normalizeModeState(
    await parseJson<CameraModeState>( response, 'Camera mode switch failed' ),
  )
}

export async function captureShot( {
  sessionId,
  index,
}: {
  sessionId: string;
  index: number;
} ): Promise<{ file: string; url: string }> {
  const base = await ensureCameraDiscovered();

  if ( base ) {
    // A shot is a screenshot of the movie preview: take the local service's
    // newest live-view frame, then upload it. Driving a PTP still here would
    // freeze the preview the guest is posing into.
    const captureRes = await fetch( `${base}/snapshot`, {
      method : "GET",
      cache  : "no-store",
    } );
    if (
      !captureRes.ok ||
      !captureRes.headers.get( "content-type" )?.startsWith( "image/" )
    ) {
      throw new Error( "Local snapshot failed" );
    }

    const blob = await captureRes.blob();
    const form = new FormData();
    form.append( "file", blob, `shot-${sessionId}-${index}.jpg` );
    form.append( "sessionId", sessionId );
    form.append( "index", String( index ) );

    const uploadRes = await fetch( "/api/captures/upload", {
      method : "POST",
      body   : form,
    } );

    return parseJson<{ file: string; url: string }>(
      uploadRes,
      "Capture upload failed",
    );
  }

  // Fallback: capture through the server API routes
  const response = await fetch( "/api/camera/capture", {
    method  : "POST",
    headers : { "Content-Type" : "application/json" },
    body    : JSON.stringify( { sessionId, index } ),
  } );

  return parseJson( response, "Capture failed" );
}

export async function composeStrip( {
  sessionId,
  frame,
  files,
  adjustments,
}: {
  sessionId: string
  frame: string
  files: string[]
  adjustments: Array<{ x: number; y: number; zoom: number; filter: string }>
} ): Promise<{ url: string }> {
  const response = await fetch( '/api/camera/compose', {
    method  : 'POST',
    headers : { 'Content-Type' : 'application/json' },
    body    : JSON.stringify( { sessionId, frame, files, adjustments } ),
  } )

  return parseJson( response, 'Compose failed' )
}

/** Generate an animated GIF from session captures. */
export async function generateSessionGif( {
  sessionId,
  files,
}: {
  sessionId: string
  files: string[]
} ): Promise<{ file: string; url: string }> {
  const response = await fetch( '/api/captures/gif', {
    method  : 'POST',
    headers : { 'Content-Type' : 'application/json' },
    body    : JSON.stringify( { sessionId, files } ),
  } )

  return parseJson( response, 'GIF generation failed' )
}

/** Generate a video — countdown mashup if clips available, image slideshow otherwise. */
export async function generateSessionVideo( {
  sessionId,
  files,
  countdownFiles,
  frameKey,
  adjustments,
}: {
  sessionId: string
  files: string[]
  countdownFiles?: string[]
  frameKey?: string
  adjustments?: Array<{ x: number; y: number; zoom: number; filter: string }>
} ): Promise<{ file: string; url: string } | null> {
  const response = await fetch( '/api/captures/video', {
    method  : 'POST',
    headers : { 'Content-Type' : 'application/json' },
    body    : JSON.stringify( {
      sessionId,
      files,
      countdownFiles,
      frameKey,
      adjustments,
    } ),
  } )
  // 501 means ffmpeg not available — return null gracefully
  if ( response.status === 501 ) return null

  return parseJson( response, 'Video generation failed' )
}

/** Generate a 15-second loop MP4 cycling through all captured images. */
export async function generateSessionLoopVideo( {
  sessionId,
  files,
}: {
  sessionId: string
  files: string[]
} ): Promise<{ file: string; url: string } | null> {
  const response = await fetch( '/api/captures/loop-video', {
    method  : 'POST',
    headers : { 'Content-Type' : 'application/json' },
    body    : JSON.stringify( { sessionId, files } ),
  } )
  if ( response.status === 501 ) return null

  return parseJson( response, 'Loop video generation failed' )
}

/**
 * Record the countdown clip for one shot, server-side.
 *
 * ffmpeg reads the live preview the booth is showing (`streamUrl`) and encodes
 * the countdown window straight to MP4/H.264 — no canvas, no MediaRecorder, and
 * no second encode generation in the browser.
 *
 * Returns null when the server can't record (no ffmpeg, or nothing usable came
 * off the stream): the capture still works, the result video just falls back to
 * the image slideshow.
 */
export async function recordCountdownClip( {
  sessionId,
  index,
  durationSec,
  streamUrl,
}: {
  sessionId: string
  index: number
  durationSec: number
  streamUrl: string
} ): Promise<{ file: string; url: string } | null> {
  const response = await fetch( '/api/captures/countdown', {
    method  : 'POST',
    headers : { 'Content-Type' : 'application/json' },
    body    : JSON.stringify( { sessionId, index, durationSec, streamUrl } ),
  } )
  // 501 = no ffmpeg, 422 = nothing usable recorded — both mean "no clip".
  if ( response.status === 501 || response.status === 422 ) return null

  return parseJson( response, 'Countdown recording failed' )
}

// ── In-flight countdown recordings ───────────────────────────────
//
// A recording only finishes when ffmpeg stops reading, and the preview goes
// quiet while the still capture holds the camera — so the clip lands a couple of
// seconds after the countdown ends. The result step can be reached before that,
// which would build the mashup with that slot missing, so it waits for these.

let _recording = 0
let _idle: Promise<void> | null = null
let _resolveIdle: ( () => void ) | null = null

/** Track a recording so `whenCountdownClipsSettled()` can wait for it. */
export function trackCountdownClip<T>( recording: Promise<T> ): Promise<T> {
  _recording += 1
  if ( !_idle ) {
    _idle = new Promise<void>( ( resolve ) => {
      _resolveIdle = resolve
    } )
  }

  const done = () => {
    _recording -= 1
    if ( _recording === 0 && _resolveIdle ) {
      _resolveIdle()
      _idle = null
      _resolveIdle = null
    }
  }
  recording.then( done, done )

  return recording
}

/** Resolve once no countdown recording is still in flight. */
export async function whenCountdownClipsSettled(): Promise<void> {
  // Another recording can start while awaiting, so re-check until none is left.
  while ( _idle ) await _idle
}

// ── Server-proxied session sync (API key stays server-side) ─────────

type MediaType = import( '@/types/booth' ).BoothMediaType

/** Extract a filename from a URL like `/captures/strip-abc.jpg?v=123`. */
function filenameFromUrl( url: string ): string | null {
  return url.split( '/' ).pop()?.split( '?' )[0] || null
}

/**
 * Sync all session media to the external server via the server-side proxy.
 * The API key never leaves the server — the client sends only filenames,
 * and the server reads files from disk and uploads them to the external API.
 */
export async function syncSessionToServer( {
  sessionId,
  frameKey,
  stripUrl,
  photoFiles,
  videoUrl,
  loopVideoUrl,
  countdownClipFiles,
}: {
  sessionId: string
  frameKey?: string
  stripUrl: string | null
  photoFiles: string[]
  videoUrl: string | null
  loopVideoUrl: string | null
  countdownClipFiles: string[]
} ): Promise<{ success: boolean; sessionId?: string; error?: string }> {
  // Collect all items to upload: [filename, type]
  const items: Array<{ filename: string; type: MediaType }> = []

  if ( stripUrl ) {
    const f = filenameFromUrl( stripUrl )
    if ( f ) items.push( { filename : f, type : 'strip' } )
  }

  for ( const file of photoFiles ) {
    items.push( { filename : file, type : 'image' } )
  }

  if ( videoUrl ) {
    const f = filenameFromUrl( videoUrl )
    if ( f ) items.push( { filename : f, type : 'mashup' } )
  }

  if ( loopVideoUrl ) {
    const f = filenameFromUrl( loopVideoUrl )
    if ( f ) items.push( { filename : f, type : 'loop' } )
  }

  for ( const file of countdownClipFiles ) {
    items.push( { filename : file, type : 'countdown' } )
  }

  if ( items.length === 0 ) {
    return { success : false, error : 'No media to upload' }
  }

  try {
    const res = await fetch( '/api/booth/sync', {
      method  : 'POST',
      headers : { 'Content-Type' : 'application/json' },
      body    : JSON.stringify( { sessionId, frameKey, items } ),
    } )

    const data = await res.json().catch( () => ( {} ) )

    if ( !res.ok ) {
      return { success : false, error : ( data as { error?: string } ).error ?? 'Upload failed' }
    }

    return { success : true, sessionId : ( data as { sessionId?: string } ).sessionId || sessionId }
  } catch ( err ) {
    return {
      success : false,
      error   : err instanceof Error ? err.message : 'Upload failed',
    }
  }
}
