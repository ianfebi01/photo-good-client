import { Capacitor } from '@capacitor/core'

// ── Device camera (getUserMedia) ────────────────────────────────────
//
// The Android app has no camera service next to it — there is no Python
// sidecar on a phone or tablet — so there the booth reads the device's own
// camera in the WebView instead. The same `MediaStream` feeds all three
// consumers: the live preview (<video>), the shot (one frame drawn to a
// canvas) and the countdown clip (MediaRecorder). The server still does the
// heavy lifting: shots go through /api/captures/upload, and clips are uploaded
// raw and transcoded to the MP4/H.264 the mashup expects.
//
// Shots and clips are cropped to the same 3:2 window the preview shows (it is
// `object-cover` in a 3:2 box), so what the guest framed is what is captured —
// and so the pan bounds on the capture step, which assume a 3:2 source, hold.

/** Aspect of the booth's capture window — matches the preview box. */
export const DEVICE_CAPTURE_ASPECT = 3 / 2

/** Seconds of inactivity before an unused stream is closed. */
const RELEASE_GRACE_MS = 1_500

/**
 * True when the booth should read the device camera instead of the camera
 * service: always inside the native app, and on the web when opted in with
 * `NEXT_PUBLIC_CAMERA_SOURCE=device` (handy for trying this path on a laptop).
 */
export function usesDeviceCamera(): boolean {
  if ( typeof window === 'undefined' ) return false
  // The standalone build has no camera service to fall back to.
  if ( process.env.NEXT_PUBLIC_STANDALONE === '1' ) return true
  if ( process.env.NEXT_PUBLIC_CAMERA_SOURCE === 'device' ) return true

  return Capacitor.isNativePlatform()
}

/** Which way the camera should face — the screen side by default. */
function facingMode(): 'user' | 'environment' {
  return process.env.NEXT_PUBLIC_DEVICE_CAMERA_FACING === 'environment'
    ? 'environment'
    : 'user'
}

// ── Which camera ────────────────────────────────────────────────────
//
// A booth normally films through a real camera on an HDMI→USB capture device
// (the camera service's `uvc` mode on a computer). Android hands such a device
// to apps as an *external* camera — on phones and tablets whose camera stack
// supports USB video; many phones do not, and then only the built-in cameras
// are listed. So in `auto` the booth prefers an external camera and falls back
// to the built-in one; the operator can also pin a camera from the capture
// step's picker, and that choice is remembered on this device.
//
// Chromium labels an external camera "facing back" just like the rear camera,
// so the label cannot tell them apart. The capabilities can: a built-in camera
// reports the way it faces, an external one reports no facing at all.

export type DeviceCameraKind = 'external' | 'front' | 'back'

export type DeviceCamera = {
  deviceId: string
  label: string
  kind: DeviceCameraKind
}

/** `auto`, or the deviceId the operator picked. */
export type DeviceCameraChoice = string

const CHOICE_KEY = 'photobooth.deviceCamera'

export function getDeviceCameraChoice(): DeviceCameraChoice {
  try {
    return localStorage.getItem( CHOICE_KEY ) || 'auto'
  } catch {
    return 'auto'
  }
}

function classify( device: MediaDeviceInfo ): DeviceCameraKind {
  const label = device.label.toLowerCase()
  if ( /usb|uvc|external|capture|hdmi/.test( label ) ) return 'external'

  const caps = ( device as InputDeviceInfo ).getCapabilities?.()
  const facing = caps?.facingMode ?? []
  if ( facing.includes( 'user' ) || /front/.test( label ) ) return 'front'
  if ( facing.includes( 'environment' ) ) return 'back'

  // No facing reported: not one of the device's own cameras. When the browser
  // gives no capabilities at all, fall back to the label.
  return caps ? 'external' : /back|rear/.test( label ) ? 'back' : 'external'
}

/**
 * The cameras this device offers. Ids and labels are hidden until camera
 * permission is granted, so this is empty before the first stream opens.
 */
export async function listDeviceCameras(): Promise<DeviceCamera[]> {
  if ( typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices ) return []
  const devices = await navigator.mediaDevices.enumerateDevices()

  return devices
    .filter( ( d ) => d.kind === 'videoinput' && d.deviceId )
    .map( ( d, i ) => {
      const kind = classify( d )

      return { deviceId : d.deviceId, label : d.label || `Camera ${i + 1}`, kind }
    } )
}

/** The camera to open for `choice`: the pinned one, else USB, else built-in. */
export function pickDeviceCamera(
  cameras: DeviceCamera[],
  choice: DeviceCameraChoice = getDeviceCameraChoice(),
): DeviceCamera | null {
  if ( choice !== 'auto' ) {
    const pinned = cameras.find( ( c ) => c.deviceId === choice )
    if ( pinned ) return pinned
  }
  const preferredBuiltIn = facingMode() === 'environment' ? 'back' : 'front'

  return cameras.find( ( c ) => c.kind === 'external' ) ??
    cameras.find( ( c ) => c.kind === preferredBuiltIn ) ??
    cameras[0] ??
    null
}

/** deviceId of the camera currently streaming, if any. */
export function currentDeviceCameraId(): string | null {
  return _stream?.getVideoTracks()[0]?.getSettings().deviceId ?? null
}

/**
 * Pin a camera (or go back to `auto`) and close the open stream, so the next
 * `acquireDeviceCamera()` opens the new one. Callers restart the preview.
 */
export function setDeviceCameraChoice( choice: DeviceCameraChoice ): void {
  try {
    if ( choice === 'auto' ) localStorage.removeItem( CHOICE_KEY )
    else localStorage.setItem( CHOICE_KEY, choice )
  } catch {
    // Storage unavailable — the choice still applies until the app restarts.
  }
  reopenDeviceCamera()
  // The USB-driver source keys off this choice too (usbCamera.ts).
  window.dispatchEvent( new Event( CAMERA_CHOICE_EVENT ) )
}

/** Fired on `window` whenever the operator changes the camera choice. */
export const CAMERA_CHOICE_EVENT = 'photobooth:camera-choice'

/** Close the open stream so the next acquire picks the camera afresh. */
export function reopenDeviceCamera(): void {
  _stream?.getTracks().forEach( ( t ) => t.stop() )
  _stream = null
  _lastError = null
}

let _stream: MediaStream | null = null
let _opening: Promise<MediaStream> | null = null
let _users = 0
let _releaseTimer: ReturnType<typeof setTimeout> | null = null
let _lastError: string | null = null

function isLive( stream: MediaStream | null ): stream is MediaStream {
  return Boolean( stream?.getVideoTracks().some( ( t ) => t.readyState === 'live' ) )
}

function unavailableReason(): string | null {
  if ( typeof navigator === 'undefined' ) return 'No browser camera API'
  if ( typeof navigator.mediaDevices?.getUserMedia === 'function' ) return null
  // getUserMedia is simply absent outside a secure context — the most likely
  // cause in the app is a plain-http CAPACITOR_SERVER_URL on the LAN.
  if ( !window.isSecureContext ) {
    return 'Camera needs a secure page — serve the booth over https (or http://localhost)'
  }

  return 'This device has no camera API'
}

/** Open one camera (by id), or the default facing camera when `deviceId` is null. */
async function openCamera( deviceId: string | null ): Promise<MediaStream> {
  const target: MediaTrackConstraints = deviceId
    ? { deviceId : { exact : deviceId } }
    : { facingMode : { ideal : facingMode() } }

  try {
    return await navigator.mediaDevices.getUserMedia( {
      video : {
        ...target,
        width     : { ideal : 1920 },
        height    : { ideal : 1080 },
        frameRate : { ideal : 30 },
      },
      audio : false,
    } )
  } catch ( err ) {
    // An over-constrained request on a modest camera: retry with no size or
    // rate preferences rather than leaving the booth without a picture.
    if ( err instanceof Error && err.name === 'OverconstrainedError' ) {
      return navigator.mediaDevices.getUserMedia( { video : deviceId ? target : true, audio : false } )
    }
    throw err
  }
}

async function openStream(): Promise<MediaStream> {
  const reason = unavailableReason()
  if ( reason ) throw new Error( reason )

  const known = pickDeviceCamera( await listDeviceCameras() )
  const stream = await openCamera( known?.deviceId ?? null )
  if ( known ) return stream

  // First open: the camera list was hidden until permission was granted just
  // now. With it visible, switch if the default camera is not the one to use —
  // typically a USB capture device instead of the front camera.
  const wanted = pickDeviceCamera( await listDeviceCameras() )
  const opened = stream.getVideoTracks()[0]?.getSettings().deviceId
  if ( !wanted || wanted.deviceId === opened ) return stream

  stream.getTracks().forEach( ( t ) => t.stop() )

  return openCamera( wanted.deviceId )
}

function describeError( err: unknown ): string {
  if ( err instanceof Error ) {
    if ( err.name === 'NotAllowedError' ) return 'Camera permission was denied'
    if ( err.name === 'NotFoundError' ) return 'No camera found on this device'
    if ( err.name === 'NotReadableError' ) return 'The camera is in use by another app'

    return err.message
  }

  return 'Camera unavailable'
}

/**
 * Take a reference to the shared camera stream, opening it if needed.
 * Every call must be paired with `releaseDeviceCamera()`.
 */
export async function acquireDeviceCamera(): Promise<MediaStream> {
  _users += 1
  if ( _releaseTimer ) {
    clearTimeout( _releaseTimer )
    _releaseTimer = null
  }

  try {
    if ( isLive( _stream ) ) return _stream
    if ( !_opening ) {
      _opening = openStream()
        .then( ( stream ) => {
          _stream = stream
          _lastError = null

          return stream
        } )
        .finally( () => {
          _opening = null
        } )
    }

    return await _opening
  } catch ( err ) {
    _users = Math.max( 0, _users - 1 )
    _lastError = describeError( err )
    throw new Error( _lastError )
  }
}

/** Drop a reference; the stream closes shortly after the last one goes. */
export function releaseDeviceCamera(): void {
  _users = Math.max( 0, _users - 1 )
  if ( _users > 0 || _releaseTimer ) return

  // A short grace period: the preview remounts between shots, and reopening
  // the camera each time would flash the screen black and re-prompt focus.
  _releaseTimer = setTimeout( () => {
    _releaseTimer = null
    if ( _users > 0 ) return
    _stream?.getTracks().forEach( ( t ) => t.stop() )
    _stream = null
  }, RELEASE_GRACE_MS )
}

/** Camera state for the booth's status poll — never opens the camera itself. */
export function deviceCameraStatus(): { connected: boolean; model?: string; error?: string } {
  const reason = unavailableReason()
  if ( reason ) return { connected : false, error : reason }
  if ( _lastError ) return { connected : false, error : _lastError }

  const label = _stream?.getVideoTracks()[0]?.label

  return { connected : true, model : label || 'Device camera' }
}

// ── Shot ────────────────────────────────────────────────────────────

/** The centred crop of a `w`×`h` frame that matches the capture window. */
function captureCrop( w: number, h: number ) {
  if ( w / h > DEVICE_CAPTURE_ASPECT ) {
    const cw = Math.round( h * DEVICE_CAPTURE_ASPECT )

    return { sx : Math.round( ( w - cw ) / 2 ), sy : 0, sw : cw, sh : h }
  }
  const ch = Math.round( w / DEVICE_CAPTURE_ASPECT )

  return { sx : 0, sy : Math.round( ( h - ch ) / 2 ), sw : w, sh : ch }
}

/** Wait until a <video> has a decoded frame to draw. */
function frameReady( video: HTMLVideoElement ): Promise<void> {
  if ( video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth ) {
    return Promise.resolve()
  }

  return new Promise( ( resolve, reject ) => {
    const timer = setTimeout( () => reject( new Error( 'Camera produced no frame' ) ), 5_000 )
    video.addEventListener( 'loadeddata', () => {
      clearTimeout( timer )
      resolve()
    }, { once : true } )
  } )
}

/** One frame off the stream, as something a canvas can draw. */
async function grabFrame( stream: MediaStream ): Promise<{
  source: CanvasImageSource
  width: number
  height: number
  done: () => void
}> {
  // A standalone element, not the preview's: the preview may be mid-remount,
  // and this one is guaranteed to be bound to the stream being captured.
  const video = document.createElement( 'video' )
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  await video.play().catch( () => {} )
  await frameReady( video )

  return {
    source : video,
    width  : video.videoWidth,
    height : video.videoHeight,
    done   : () => {
      video.pause()
      video.srcObject = null
    },
  }
}

/**
 * Take a shot from the device camera: the newest frame, cropped to the
 * capture window and mirrored when the preview is, as a JPEG.
 */
export async function captureDeviceStill( mirror: boolean ): Promise<Blob> {
  const stream = await acquireDeviceCamera()
  try {
    const frame = await grabFrame( stream )
    try {
      const { sx, sy, sw, sh } = captureCrop( frame.width, frame.height )
      const canvas = document.createElement( 'canvas' )
      canvas.width = sw
      canvas.height = sh
      const context = canvas.getContext( '2d' )
      if ( !context ) throw new Error( 'Canvas unavailable' )
      if ( mirror ) {
        context.translate( sw, 0 )
        context.scale( -1, 1 )
      }
      context.drawImage( frame.source, sx, sy, sw, sh, 0, 0, sw, sh )

      return await new Promise<Blob>( ( resolve, reject ) => {
        canvas.toBlob(
          ( blob ) => ( blob ? resolve( blob ) : reject( new Error( 'Could not encode the shot' ) ) ),
          'image/jpeg',
          0.92,
        )
      } )
    } finally {
      frame.done()
    }
  } finally {
    releaseDeviceCamera()
  }
}

// ── Countdown clip ──────────────────────────────────────────────────

/**
 * Container/codec preference for the raw clip. The server re-encodes every clip
 * to H.264 regardless, so this only decides what survives the upload best:
 * MP4/H.264 where the WebView can mux it (recent Chromium), WebM otherwise.
 */
const CLIP_MIME_TYPES = [
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

function clipMimeType(): string | undefined {
  if ( typeof MediaRecorder === 'undefined' ) return undefined

  return CLIP_MIME_TYPES.find( ( type ) => MediaRecorder.isTypeSupported( type ) )
}

/**
 * Record `durationSec` of the device camera — the countdown the guest is
 * watching. Returns null when this WebView cannot record at all; the result
 * video then falls back to the image slideshow, as it does without ffmpeg.
 */
export async function recordDeviceClip( durationSec: number ): Promise<Blob | null> {
  if ( typeof MediaRecorder === 'undefined' ) return null

  const stream = await acquireDeviceCamera()
  try {
    const mimeType = clipMimeType()
    const recorder = new MediaRecorder( stream, {
      ...( mimeType ? { mimeType } : {} ),
      // Plenty for a 1080p source; the server sets the final quality.
      videoBitsPerSecond : 8_000_000,
    } )
    const chunks: Blob[] = []

    await new Promise<void>( ( resolve, reject ) => {
      recorder.ondataavailable = ( event ) => {
        if ( event.data.size > 0 ) chunks.push( event.data )
      }
      recorder.onstop = () => resolve()
      recorder.onerror = ( event ) => reject(
        ( event as Event & { error?: Error } ).error ?? new Error( 'Recording failed' ),
      )
      // A timeslice flushes data as it goes, so a stop never waits on one
      // large final chunk.
      recorder.start( 500 )
      setTimeout( () => {
        if ( recorder.state !== 'inactive' ) recorder.stop()
      }, durationSec * 1000 )
    } )

    if ( chunks.length === 0 ) return null

    return new Blob( chunks, { type : recorder.mimeType || mimeType || 'video/webm' } )
  } finally {
    releaseDeviceCamera()
  }
}
