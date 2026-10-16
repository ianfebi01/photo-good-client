import type { ClientFrame } from './frames.client'
import { boothApiJson, putBinary } from './boothApi'
import { type SlotAdjustment, composeStripLocal } from './canvasMedia'
import { captureDeviceStill, recordDeviceClip } from './deviceCamera'
import { clearLocalSession, getLocalMedia, localMediaName, putLocalMedia } from './localMedia'
import { normalizeSettings } from './settings.client'
import { activeUsbCameraBase, captureUsbStill } from './usbCamera'
import {
  buildLoopVideoLocal,
  buildMashupLocal,
  buildSlideshowLocal,
  normalizeClipLocal,
  recordUsbClipLocal,
} from './videoLocal'
import type {
  BoothClientSettings,
  BoothFramesResponse,
  BoothMedia,
  BoothMediaPresignResponse,
  BoothMediaType,
  BoothResultCreateResponse,
  BoothSettingsResponse,
} from '@/types/booth'

// ── Standalone booth backend ────────────────────────────────────────
//
// What the Next.js API routes do, done on the device for the server-less
// Android build. frames.query.ts and friends call these instead of `/api/*`
// when `isStandalone()`; each returns the same shape its route returned, so the
// UI cannot tell the difference. File names match the server's, so session
// bookkeeping (clip index from `countdown-<session>-<i>.mp4`, etc.) is shared.

type Media = { file: string; url: string }

// ── Frames & settings ───────────────────────────────────────────────

let _frames: ClientFrame[] = []

export async function getFramesLocal(): Promise<ClientFrame[]> {
  const data = await boothApiJson<BoothFramesResponse>( '/api/booth/frames', {
    fallbackError : 'Failed to load frames',
  } )
  _frames = ( data?.frames ?? [] ).map( ( f ) => ( {
    key        : f.key,
    label      : f.label,
    publicUrl  : f.imageUrl,
    width      : f.width,
    height     : f.height,
    photoCount : f.slots.length,
    slots      : f.slots,
    builtIn    : f.builtIn,
  } ) )

  return _frames
}

async function frameByKey( key: string ): Promise<ClientFrame> {
  const known = _frames.find( ( f ) => f.key === key ) ??
    ( await getFramesLocal() ).find( ( f ) => f.key === key )
  if ( !known ) throw new Error( `Unknown frame: ${key}` )

  return known
}

export async function getSettingsLocal(): Promise<BoothClientSettings> {
  const data = await boothApiJson<BoothSettingsResponse | null>( '/api/booth/settings', {
    fallbackError : 'Failed to load booth settings',
  } )

  return normalizeSettings( data?.settings )
}

// ── Capture ─────────────────────────────────────────────────────────

export async function captureShotLocal(
  sessionId: string,
  index: number,
  mirror: boolean,
): Promise<Media> {
  const usb = activeUsbCameraBase()
  const shot = usb ? await captureUsbStill( usb, mirror ) : await captureDeviceStill( mirror )

  return putLocalMedia( `shot-${sessionId}-${index}.jpg`, shot )
}

/** Record, then normalise to MP4/H.264; null when nothing usable came out. */
export async function recordClipLocal(
  sessionId: string,
  index: number,
  durationSec: number,
  mirror: boolean,
): Promise<Media | null> {
  const usb = activeUsbCameraBase()
  let clip: Blob | null
  if ( usb ) {
    clip = await recordUsbClipLocal( usb, durationSec, mirror )
  } else {
    const raw = await recordDeviceClip( durationSec )
    clip = raw ? await normalizeClipLocal( raw, mirror ) : null
  }
  if ( !clip ) return null

  return putLocalMedia( `countdown-${sessionId}-${index}.mp4`, clip )
}

function mustGet( file: string ): Blob {
  const blob = getLocalMedia( file )
  if ( !blob ) throw new Error( `Missing capture: ${file}` )

  return blob
}

// ── Strip & videos ──────────────────────────────────────────────────

export async function composeLocal(
  sessionId: string,
  frameKey: string,
  files: string[],
  adjustments: SlotAdjustment[],
): Promise<Media> {
  const frame = await frameByKey( frameKey )
  const strip = await composeStripLocal( frame, files.map( mustGet ), adjustments )

  return putLocalMedia( `strip-${sessionId}-${frameKey}.jpg`, strip )
}

/** Countdown mashup when there are clips, the photo slideshow otherwise. */
export async function generateVideoLocal(
  sessionId: string,
  files: string[],
  countdownFiles: string[],
  frameKey: string | undefined,
  adjustments: SlotAdjustment[] | undefined,
): Promise<Media | null> {
  if ( countdownFiles.length > 0 && frameKey ) {
    const frame = await frameByKey( frameKey )
    // Place each clip in the slot its name says, not in arrival order.
    const clips = new Array<Blob | null>( frame.slots.length ).fill( null )
    for ( const file of countdownFiles ) {
      const slot = Number( /-(\d+)\.mp4$/i.exec( file )?.[1] )
      const blob = getLocalMedia( file )
      if ( blob && Number.isInteger( slot ) && slot >= 0 && slot < clips.length ) clips[slot] = blob
    }

    const mashup = await buildMashupLocal( frame, clips, adjustments )
    if ( mashup ) return putLocalMedia( `countdown-mashup-${sessionId}.mp4`, mashup )
  }

  const slideshow = await buildSlideshowLocal( files.map( mustGet ) )

  return slideshow ? putLocalMedia( `slideshow-${sessionId}.mp4`, slideshow ) : null
}

export async function generateLoopLocal( sessionId: string, files: string[] ): Promise<Media | null> {
  const loop = await buildLoopVideoLocal( files.map( mustGet ) )

  return loop ? putLocalMedia( `loop-${sessionId}.mp4`, loop ) : null
}

export function clearSessionLocal( sessionId: string ): void {
  clearLocalSession( sessionId )
}

// ── Sync ────────────────────────────────────────────────────────────

/**
 * Upload one capture — presign, PUT straight to storage, finalise — the device
 * version of media.upload.ts.
 */
async function uploadMedia( blob: Blob, filename: string ): Promise<BoothMedia> {
  const mimeType = filename.endsWith( '.mp4' ) ? 'video/mp4' : 'image/jpeg'
  const presign = await boothApiJson<BoothMediaPresignResponse>( '/api/booth/media/presign', {
    method        : 'POST',
    body          : { mimeType, size : blob.size, filename },
    fallbackError : 'Presign failed',
  } )

  await putBinary( presign.uploadUrl, blob, presign.contentType )

  const { media } = await boothApiJson<{ media: BoothMedia }>( '/api/booth/media', {
    method        : 'POST',
    body          : { key : presign.key },
    fallbackError : 'Finalise failed',
  } )

  return media
}

/** Upload the session's media and record the result — /api/booth/sync. */
export async function syncLocal(
  sessionId: string,
  frameKey: string | undefined,
  items: Array<{ filename: string; type: BoothMediaType }>,
): Promise<{ success: boolean; sessionId?: string; error?: string }> {
  const synced: Array<{ mediaId: string; type: BoothMediaType }> = []

  for ( const item of items ) {
    // The strip and videos are referenced by object URL; upload under the name.
    const name = localMediaName( item.filename )
    const blob = name ? getLocalMedia( name ) : null
    if ( !name || !blob ) continue
    try {
      const media = await uploadMedia( blob, name )
      synced.push( { mediaId : media.id, type : item.type } )
    } catch ( err ) {
      // One failed file should not sink the rest of the session.
      // eslint-disable-next-line no-console
      console.error( `Error uploading ${item.filename}:`, err )
    }
  }

  if ( synced.length === 0 ) return { success : false, error : 'No media was successfully uploaded' }

  try {
    const result = await boothApiJson<BoothResultCreateResponse>( '/api/booth/results', {
      method        : 'POST',
      body          : { sessionId, frameKey, items : synced },
      fallbackError : 'Failed to create result',
    } )

    return { success : true, sessionId : result.sessionId || sessionId }
  } catch ( err ) {
    return { success : false, error : err instanceof Error ? err.message : 'Upload failed' }
  }
}
