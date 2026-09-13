import type { ClientFrame } from './frames.client'
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
        gphoto2   : true,
      };
    } catch {
      // Sidecar became unreachable — fall through to server fallback
      _cameraBase = null;
    }
  }

  // Fall back to server API
  const response = await fetch( "/api/camera/status", { cache : "no-store" } );
  
  return parseJson<Status>( response, "Failed to load camera status" );
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
    // Capture directly from the local camera service, then upload to server
    const captureRes = await fetch( `${base}/capture`, {
      method : "POST",
      cache  : "no-store",
    } );
    if (
      !captureRes.ok ||
      !captureRes.headers.get( "content-type" )?.startsWith( "image/" )
    ) {
      throw new Error( "Local capture failed" );
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
}: {
  sessionId: string
  files: string[]
  countdownFiles?: string[]
  frameKey?: string
} ): Promise<{ file: string; url: string } | null> {
  const response = await fetch( '/api/captures/video', {
    method  : 'POST',
    headers : { 'Content-Type' : 'application/json' },
    body    : JSON.stringify( { sessionId, files, countdownFiles, frameKey } ),
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
 * Upload a countdown video clip recorded during the 3s countdown.
 *
 * Hi-res MP4 when the browser can mux H.264 (no server conversion needed),
 * webm otherwise — the extension tells the upload route which path to take.
 */
export async function uploadCountdownClip( {
  sessionId,
  index,
  blob,
}: {
  sessionId: string
  index: number
  blob: Blob
} ): Promise<{ file: string; url: string }> {
  const ext = blob.type.startsWith( 'video/mp4' ) ? 'mp4' : 'webm'

  const form = new FormData()
  form.append( 'file', blob, `countdown-${sessionId}-${index}.${ext}` )
  form.append( 'sessionId', sessionId )
  form.append( 'index', String( index ) )
  form.append( 'kind', 'countdown' )

  const response = await fetch( '/api/captures/upload', {
    method : 'POST',
    body   : form,
  } )

  return parseJson( response, 'Countdown video upload failed' )
}

/** Convert a recorded countdown clip (webm) to a downloadable MP4. */
export async function convertCountdownClip( {
  file,
}: {
  file: string
} ): Promise<{ file: string; url: string } | null> {
  const response = await fetch( '/api/captures/countdown-mp4', {
    method  : 'POST',
    headers : { 'Content-Type' : 'application/json' },
    body    : JSON.stringify( { file } ),
  } )
  // 501 means ffmpeg not available — return null gracefully
  if ( response.status === 501 ) return null

  return parseJson( response, 'MP4 conversion failed' )
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
