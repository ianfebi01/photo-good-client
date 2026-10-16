import { Capacitor, registerPlugin } from '@capacitor/core'

import {
  CAMERA_CHOICE_EVENT,
  DEVICE_CAPTURE_ASPECT,
  getDeviceCameraChoice,
} from './deviceCamera'

// ── USB capture device via the app's own driver ─────────────────────
//
// Many phones never hand a USB capture device to apps as a camera, so
// getUserMedia cannot see it. The Android app then reads it itself (native
// UsbCamera plugin: libusb + libuvc) and answers /__usb-camera/status, /preview
// and /snapshot from inside the WebView — same-origin, so no CORS, mixed-content
// or local-network rules apply. The booth uses them like the Python camera
// service: the preview is its MJPEG stream (drawn to a canvas, see UsbStream),
// and a shot is the newest frame. See android/…/usbcamera/.

export type UsbCameraState = {
  connected: boolean
  /** idle | waiting | opening | starting | streaming | error */
  state: string
  model: string | null
  error: string | null
  preview: { width: number; height: number; fps: number }
  /** Frames received in the current video mode. */
  frames?: number
  /** What the driver did, newest last — for the "USB details" panel. */
  log?: string[]
}

type UsbCameraPlugin = {
  start(): Promise<UsbCameraState>
  status(): Promise<UsbCameraState>
  stop(): Promise<UsbCameraState>
  startTestPattern(): Promise<UsbCameraState>
  addListener( event: 'change', cb: ( state: UsbCameraState ) => void ): Promise<unknown>
}

const UsbCamera = registerPlugin<UsbCameraPlugin>( 'UsbCamera' )

/** The picker value that selects the app's own USB driver. */
export const USB_DRIVER_CHOICE = 'usb-driver'

/** Where the app serves the capture device's frames (same origin as the page). */
const USB_CAMERA_BASE = '/__usb-camera'

let _state: UsbCameraState | null = null
let _starting: Promise<void> | null = null
const _listeners = new Set<() => void>()

function update( state: UsbCameraState ) {
  _state = state
  _listeners.forEach( ( cb ) => cb() )
}

/** Whether this build can drive a USB capture device itself (the Android app). */
export function usbDriverAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

/**
 * Start the in-app camera service (idempotent). Asks for the camera permission
 * Android requires for USB cameras, then for USB access when a device is found.
 */
export function startUsbCamera(): Promise<void> {
  if ( !usbDriverAvailable() ) return Promise.resolve()
  if ( !_starting ) {
    _starting = ( async () => {
      await UsbCamera.addListener( 'change', update )
      update( await UsbCamera.start() )
    } )().catch( ( err ) => {
      _starting = null
      // eslint-disable-next-line no-console
      console.warn( 'USB camera service failed to start:', err )
    } )
  }

  return _starting
}

export function getUsbCameraState(): UsbCameraState | null {
  return _state
}

/** Hear about device and camera-choice changes (for useSyncExternalStore). */
export function subscribeUsbCamera( cb: () => void ): () => void {
  _listeners.add( cb )
  window.addEventListener( CAMERA_CHOICE_EVENT, cb )

  return () => {
    _listeners.delete( cb )
    window.removeEventListener( CAMERA_CHOICE_EVENT, cb )
  }
}

/**
 * Base URL of the in-app camera service when the booth should film through it:
 * a capture device is streaming and the operator has not pinned a built-in
 * camera instead.
 */
export function activeUsbCameraBase(): string | null {
  if ( !_state?.connected ) return null
  const choice = getDeviceCameraChoice()
  if ( choice !== 'auto' && choice !== USB_DRIVER_CHOICE ) return null

  return USB_CAMERA_BASE
}

// ── Shot ────────────────────────────────────────────────────────────

/**
 * A shot from the capture device: its newest frame, cropped to the 3:2 window
 * the preview shows and mirrored when the preview is — the same as a
 * device-camera shot.
 */
export async function captureUsbStill( base: string, mirror: boolean ): Promise<Blob> {
  const res = await fetch( `${base}/snapshot`, { cache : 'no-store' } )
  if ( !res.ok ) throw new Error( 'The USB capture device sent no picture' )

  const bitmap = await createImageBitmap( await res.blob() )
  try {
    const { width : w, height : h } = bitmap
    const sw = w / h > DEVICE_CAPTURE_ASPECT ? Math.round( h * DEVICE_CAPTURE_ASPECT ) : w
    const sh = w / h > DEVICE_CAPTURE_ASPECT ? h : Math.round( w / DEVICE_CAPTURE_ASPECT )
    const canvas = document.createElement( 'canvas' )
    canvas.width = sw
    canvas.height = sh
    const context = canvas.getContext( '2d' )
    if ( !context ) throw new Error( 'Canvas unavailable' )
    if ( mirror ) {
      context.translate( sw, 0 )
      context.scale( -1, 1 )
    }
    context.drawImage( bitmap, ( w - sw ) / 2, ( h - sh ) / 2, sw, sh, 0, 0, sw, sh )

    return await new Promise<Blob>( ( resolve, reject ) => {
      canvas.toBlob(
        ( blob ) => ( blob ? resolve( blob ) : reject( new Error( 'Could not encode the shot' ) ) ),
        'image/jpeg',
        0.92,
      )
    } )
  } finally {
    bitmap.close()
  }
}

// ── Live frames (for the countdown clip) ────────────────────────────

/**
 * The capture device's MJPEG preview as decoded frames, until `signal` aborts.
 * The app sends a Content-Length with every part, so parts are cut by length
 * rather than by scanning for the boundary — and the stream is read here
 * instead of by an <img>, which needs the boundary from a Content-Type header
 * that an in-WebView response may not carry through.
 */
export async function* usbFrames(
  base: string,
  signal: AbortSignal,
): AsyncGenerator<{ bitmap: ImageBitmap; at: number }> {
  const res = await fetch( `${base}/preview`, { cache : 'no-store', signal } )
  if ( !res.ok || !res.body ) throw new Error( 'The USB capture device is not streaming' )

  const reader = res.body.getReader()
  let buffer = new Uint8Array( 0 )
  const decoder = new TextDecoder( 'latin1' )

  const append = ( chunk: Uint8Array ) => {
    const next = new Uint8Array( buffer.length + chunk.length )
    next.set( buffer )
    next.set( chunk, buffer.length )
    buffer = next
  }

  try {
    while ( !signal.aborted ) {
      // Headers end at the first blank line.
      let headerEnd = -1
      while ( headerEnd < 0 ) {
        headerEnd = findHeaderEnd( buffer )
        if ( headerEnd >= 0 ) break
        const { value, done } = await reader.read()
        if ( done ) return
        append( value )
      }
      const headers = decoder.decode( buffer.subarray( 0, headerEnd ) )
      const length = Number( /content-length:\s*(\d+)/i.exec( headers )?.[1] )
      buffer = buffer.subarray( headerEnd + 4 )
      if ( !Number.isFinite( length ) ) continue

      while ( buffer.length < length ) {
        const { value, done } = await reader.read()
        if ( done ) return
        append( value )
      }
      const jpeg = buffer.slice( 0, length )
      buffer = buffer.subarray( length )
      const at = performance.now()
      yield { bitmap : await createImageBitmap( new Blob( [jpeg], { type : 'image/jpeg' } ) ), at }
    }
  } finally {
    reader.cancel().catch( () => {} )
  }
}

function findHeaderEnd( bytes: Uint8Array ): number {
  for ( let i = 0; i + 3 < bytes.length; i++ ) {
    if ( bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10 ) return i
  }

  return -1
}
