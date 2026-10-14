import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  canEncodeVideo,
} from 'mediabunny'

import type { ClientFrame } from './frames.client'
import {
  type SlotAdjustment,
  context2d,
  drawSlot,
  loadFrameArt,
  makeCanvas,
} from './canvasMedia'
import { DEVICE_CAPTURE_ASPECT } from './deviceCamera'
import { usbFrames } from './usbCamera'

// ── On-device video (standalone build) ──────────────────────────────
//
// WebCodecs ports of the server's ffmpeg jobs, via Mediabunny: normalising a
// recorded countdown clip, the countdown mashup, and the photo loop / slideshow.
// Every output is MP4/H.264 — the only video the booth API accepts (it rejects
// WebM) and what guests' phones play. The encoder is the device's own, usually
// hardware, so a few seconds of 1080p takes seconds rather than minutes.

/** Output cadence of clips and the mashup (media.ts `CLIP_FPS` / `OUT_FPS`). */
const CLIP_FPS = 25
/** A clip needs at least two frames to be worth keeping (media.ts). */
const MIN_CLIP_FRAMES = 2
/** Longest mashup — the countdown route caps a clip at 15s too. */
const MAX_MASHUP_SECS = 15

const even = ( n: number ) => Math.max( 2, Math.floor( n / 2 ) * 2 )

function mp4Output() {
  const target = new BufferTarget()
  const output = new Output( {
    format : new Mp4OutputFormat( { fastStart : 'in-memory' } ),
    target,
  } )

  return { output, target }
}

function mp4Blob( target: BufferTarget ): Blob {
  if ( !target.buffer ) throw new Error( 'Encoder produced no output' )

  return new Blob( [target.buffer], { type : 'video/mp4' } )
}

/** H.264 levels by frame size in macroblocks (from 3.0 up — anything smaller fits). */
const AVC_LEVELS = [
  { maxMacroblocks : 1620, level : 0x1e }, // 3.0
  { maxMacroblocks : 3600, level : 0x1f }, // 3.1
  { maxMacroblocks : 5120, level : 0x20 }, // 3.2
  { maxMacroblocks : 8192, level : 0x28 }, // 4.0
  { maxMacroblocks : 8704, level : 0x2a }, // 4.2
  { maxMacroblocks : 22080, level : 0x32 }, // 5.0
  { maxMacroblocks : 36864, level : 0x33 }, // 5.1
]

/**
 * H.264 profiles to try, best first. Mediabunny always asks for High, which a
 * good share of phone encoders (and the emulator's) turn down while happily
 * encoding Main or Baseline — so the codec string is built here instead.
 */
const AVC_PROFILES = [0x64 /* High */, 0x4d /* Main */, 0x42 /* Baseline */]

function avcCodecString( profile: number, width: number, height: number ): string | null {
  const macroblocks = Math.ceil( width / 16 ) * Math.ceil( height / 16 )
  const level = AVC_LEVELS.find( ( l ) => macroblocks <= l.maxMacroblocks )?.level
  if ( !level ) return null
  const hex = ( n: number ) => n.toString( 16 ).padStart( 2, '0' )

  return `avc1.${hex( profile )}00${hex( level )}`
}

type EncodeSize = { width: number; height: number; fullCodecString: string }

/**
 * The largest even size, at most `width`×`height` and the same shape, that this
 * device can encode as H.264, with the codec string to ask for. Phone encoders
 * also have size limits — a full 1332×1998 portrait frame is past some — so the
 * size steps down until something fits.
 */
async function encodableSize( width: number, height: number ): Promise<EncodeSize | null> {
  for ( const scale of [1, 0.85, 0.72, 0.6, 0.5, 0.4] ) {
    const size = { width : even( width * scale ), height : even( height * scale ) }
    for ( const profile of AVC_PROFILES ) {
      const fullCodecString = avcCodecString( profile, size.width, size.height )
      if ( !fullCodecString ) continue
      const ok = await canEncodeVideo( 'avc', {
        ...size,
        quality   : QUALITY_HIGH,
        frameRate : CLIP_FPS,
        fullCodecString,
      } )
      if ( ok ) return { ...size, fullCodecString }
    }
  }

  return null
}

/**
 * Encode `frameCount` frames, each painted by `draw` onto a `width`×`height`
 * canvas, to MP4/H.264. Returns null when the device cannot encode H.264.
 */
async function encodeFrames( {
  width,
  height,
  fps,
  frameCount,
  draw,
}: {
  width: number
  height: number
  fps: number
  frameCount: number
  draw: ( context: CanvasRenderingContext2D, index: number ) => Promise<void> | void
} ): Promise<Blob | null> {
  if ( frameCount < MIN_CLIP_FRAMES ) return null

  const size = await encodableSize( width, height )
  if ( !size ) return null

  // Paint at full size, encode at what the device supports.
  const paint = makeCanvas( even( width ), even( height ) )
  const paintContext = context2d( paint )
  const encodeCanvas = size.width === paint.width ? paint : makeCanvas( size.width, size.height )
  const encodeContext = encodeCanvas === paint ? null : context2d( encodeCanvas )

  const { output, target } = mp4Output()
  const source = new CanvasSource( encodeCanvas, {
    codec            : 'avc',
    fullCodecString  : size.fullCodecString,
    quality          : QUALITY_HIGH,
    keyFrameInterval : 2,
  } )
  output.addVideoTrack( source, { frameRate : fps } )
  await output.start()

  for ( let i = 0; i < frameCount; i++ ) {
    await draw( paintContext, i )
    if ( encodeContext ) {
      encodeContext.imageSmoothingQuality = 'high'
      encodeContext.drawImage( paint, 0, 0, encodeCanvas.width, encodeCanvas.height )
    }
    await source.add( i / fps, 1 / fps )
  }

  source.close()
  await output.finalize()

  return mp4Blob( target )
}

// ── Countdown clip ──────────────────────────────────────────────────

/** Longest countdown clip kept (the countdown route's cap). */
const MAX_CLIP_SECS = 15

/**
 * Turn a raw MediaRecorder clip (WebM, or fragmented MP4 on newer WebViews,
 * with irregular frame timing) into what the server's countdown import makes:
 * constant 25 fps H.264, cropped to the 3:2 capture window, mirrored when the
 * preview was. Frames are resampled onto the 25 fps grid by decoding at each
 * grid timestamp. Returns null when the recording holds no usable video or the
 * device cannot encode H.264.
 */
export async function normalizeClipLocal( raw: Blob, mirror: boolean ): Promise<Blob | null> {
  const input = new Input( { source : new BlobSource( raw ), formats : ALL_FORMATS } )
  try {
    const track = await input.getPrimaryVideoTrack()
    if ( !track ) return null

    const w = await track.getDisplayWidth()
    const h = await track.getDisplayHeight()
    const cropW = even( Math.min( w, h * DEVICE_CAPTURE_ASPECT ) )
    const cropH = even( Math.min( h, w / DEVICE_CAPTURE_ASPECT ) )

    const start = await track.getFirstTimestamp()
    const length = Math.min( MAX_CLIP_SECS, ( await track.computeDuration() ) - start )
    const frameCount = Math.floor( length * CLIP_FPS )

    const sink = new CanvasSink( track, {
      crop : {
        left   : Math.floor( ( w - cropW ) / 2 ),
        top    : Math.floor( ( h - cropH ) / 2 ),
        width  : cropW,
        height : cropH,
      },
      flip     : mirror,
      poolSize : 2,
    } )
    const frames = sink.canvasesAtTimestamps(
      Array.from( { length : frameCount }, ( _, k ) => start + k / CLIP_FPS ),
    )

    return await encodeFrames( {
      width  : cropW,
      height : cropH,
      fps    : CLIP_FPS,
      frameCount,
      draw   : async ( context ) => {
        const next = await frames.next()
        const canvas = next.done ? null : next.value?.canvas
        if ( canvas ) context.drawImage( canvas, 0, 0, context.canvas.width, context.canvas.height )
      },
    } )
  } finally {
    input.dispose()
  }
}

/**
 * Record `durationSec` of a USB capture device straight off the in-app camera
 * service's MJPEG stream, encoding each frame as it arrives (with its arrival
 * time) — the device version of the server recording a clip off the camera
 * service's preview with ffmpeg. Cropped to the 3:2 capture window and mirrored
 * like a shot. Returns null when nothing usable arrived or H.264 is unavailable.
 */
export async function recordUsbClipLocal(
  base: string,
  durationSec: number,
  mirror: boolean,
): Promise<Blob | null> {
  const controller = new AbortController()
  // Backstop for a stream that stalls: the loop below ends on time otherwise.
  const backstop = setTimeout( () => controller.abort(), durationSec * 1000 + 4_000 )

  let output: Output | null = null
  let target: BufferTarget | null = null
  let source: CanvasSource | null = null
  let frames = 0

  try {
    let start: number | null = null
    let canvas: HTMLCanvasElement | null = null
    let context: CanvasRenderingContext2D | null = null
    let crop = { sx : 0, sy : 0, sw : 0, sh : 0 }

    for await ( const { bitmap, at } of usbFrames( base, controller.signal ) ) {
      try {
        if ( start === null ) {
          start = at
          const { width : w, height : h } = bitmap
          const sw = even( Math.min( w, h * DEVICE_CAPTURE_ASPECT ) )
          const sh = even( Math.min( h, w / DEVICE_CAPTURE_ASPECT ) )
          crop = { sx : ( w - sw ) / 2, sy : ( h - sh ) / 2, sw, sh }
          const size = await encodableSize( sw, sh )
          if ( !size ) return null

          canvas = makeCanvas( size.width, size.height )
          context = context2d( canvas )
          if ( mirror ) {
            context.translate( canvas.width, 0 )
            context.scale( -1, 1 )
          }
          ;( { output, target } = mp4Output() )
          source = new CanvasSource( canvas, {
            codec            : 'avc',
            fullCodecString  : size.fullCodecString,
            quality          : QUALITY_HIGH,
            keyFrameInterval : 2,
          } )
          output.addVideoTrack( source, { frameRate : CLIP_FPS } )
          await output.start()
        }

        const t = ( at - start ) / 1000
        if ( t >= durationSec ) break
        if ( !context || !canvas || !source ) break

        context.drawImage( bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height )
        await source.add( t, 1 / CLIP_FPS )
        frames++
      } finally {
        bitmap.close()
      }
    }
  } catch ( err ) {
    // An abort is the backstop firing; keep whatever was recorded.
    if ( !( err instanceof DOMException && err.name === 'AbortError' ) ) throw err
  } finally {
    clearTimeout( backstop )
    controller.abort()
  }

  if ( !output || !target || !source || frames < MIN_CLIP_FRAMES ) return null
  ;( source as CanvasSource ).close()
  await ( output as Output ).finalize()

  return mp4Blob( target )
}

// ── Countdown mashup ────────────────────────────────────────────────

/**
 * Overlay each slot's countdown clip into the frame, under the keyed artwork —
 * the device version of generateCountdownMashup. `clips` is indexed by slot (a
 * missing clip leaves that window white). The video runs as long as the
 * shortest clip, like ffmpeg's `overlay=shortest=1`.
 */
export async function buildMashupLocal(
  frame: ClientFrame,
  clips: Array<Blob | null>,
  adjustments?: SlotAdjustment[],
): Promise<Blob | null> {
  const { overlay } = await loadFrameArt( frame )

  const inputs: Input[] = []
  try {
    const sources: Array<{
      frames: AsyncGenerator<{ canvas: HTMLCanvasElement | OffscreenCanvas } | null>
      width: number
      height: number
    } | null> = []
    let duration = MAX_MASHUP_SECS

    for ( let i = 0; i < frame.slots.length; i++ ) {
      const clip = clips[i]
      if ( !clip ) {
        sources.push( null )
        continue
      }
      const input = new Input( { source : new BlobSource( clip ), formats : ALL_FORMATS } )
      inputs.push( input )
      const track = await input.getPrimaryVideoTrack()
      if ( !track ) {
        sources.push( null )
        continue
      }

      const start = await track.getFirstTimestamp()
      const length = ( await track.computeDuration() ) - start
      duration = Math.min( duration, length )
      const sink = new CanvasSink( track, { poolSize : 2 } )

      // Every clip is sampled on the same 25 fps grid, so frame k of the
      // mashup shows frame k of every clip.
      const total = Math.floor( MAX_MASHUP_SECS * CLIP_FPS )
      const timestamps = Array.from( { length : total }, ( _, k ) => start + k / CLIP_FPS )
      sources.push( {
        frames : sink.canvasesAtTimestamps( timestamps ) as AsyncGenerator<
          { canvas: HTMLCanvasElement | OffscreenCanvas } | null
        >,
        width  : await track.getDisplayWidth(),
        height : await track.getDisplayHeight(),
      } )
    }

    if ( sources.every( ( s ) => s === null ) ) return null

    const scratch = makeCanvas( 1, 1 )

    return await encodeFrames( {
      width      : overlay.width,
      height     : overlay.height,
      fps        : CLIP_FPS,
      frameCount : Math.floor( duration * CLIP_FPS ),
      draw       : async ( context ) => {
        context.fillStyle = '#ffffff'
        context.fillRect( 0, 0, context.canvas.width, context.canvas.height )

        for ( let i = 0; i < sources.length; i++ ) {
          const source = sources[i]
          if ( !source ) continue
          const next = await source.frames.next()
          const canvas = next.done ? null : next.value?.canvas
          if ( !canvas ) continue
          drawSlot(
            context,
            canvas,
            source.width,
            source.height,
            frame.slots[i],
            adjustments?.[i],
            scratch,
          )
        }

        context.drawImage( overlay, 0, 0 )
      },
    } )
  } finally {
    inputs.forEach( ( input ) => input.dispose() )
  }
}

// ── Photo loop / slideshow ──────────────────────────────────────────

/**
 * Show each photo for `secsPerPhoto`, contained on white in a canvas shaped
 * like the first photo — buildLoopVideo / generateSlideshowVideo on the server.
 */
async function photoSequence(
  photos: Blob[],
  width: number,
  secsPerPhoto: number,
  fps: number,
): Promise<Blob | null> {
  if ( photos.length === 0 ) return null

  const bitmaps = await Promise.all( photos.map( ( p ) => createImageBitmap( p ) ) )
  try {
    const first = bitmaps[0]
    const height = even( ( width * first.height ) / first.width )
    const perPhoto = Math.max( 1, Math.round( secsPerPhoto * fps ) )

    return await encodeFrames( {
      width,
      height,
      fps,
      frameCount : perPhoto * bitmaps.length,
      draw       : ( context, index ) => {
        const bitmap = bitmaps[Math.floor( index / perPhoto )]
        const scale = Math.min( width / bitmap.width, height / bitmap.height )
        const w = bitmap.width * scale
        const h = bitmap.height * scale
        context.fillStyle = '#ffffff'
        context.fillRect( 0, 0, width, height )
        context.imageSmoothingQuality = 'high'
        context.drawImage( bitmap, ( width - w ) / 2, ( height - h ) / 2, w, h )
      },
    } )
  } finally {
    bitmaps.forEach( ( b ) => b.close() )
  }
}

/** The short loop of every photo (0.7s each, 720 wide, 24 fps). */
export function buildLoopVideoLocal( photos: Blob[] ): Promise<Blob | null> {
  return photoSequence( photos, 720, 0.7, 24 )
}

/** Fallback result video when no countdown clip exists (1.5s each, 1080 wide). */
export function buildSlideshowLocal( photos: Blob[] ): Promise<Blob | null> {
  return photoSequence( photos, 1080, 1.5, 24 )
}
