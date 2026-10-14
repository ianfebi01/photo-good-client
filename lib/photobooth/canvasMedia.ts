import type { ClientFrame } from './frames.client'
import { fetchBinary } from './boothApi'
import { clearGreenPixels } from './greenKey'

// ── On-device image work (standalone build) ─────────────────────────
//
// Canvas ports of what sharp does on the server: keying a frame's green photo
// windows, the numbered frame previews, the per-slot colour filters, and
// composing the final strip. The geometry and filter numbers are copied from
// compose.ts / the preview route so a strip made on the device matches one made
// by the server.

export type SlotAdjustment = { x: number; y: number; zoom: number; filter: string }

/** Bleed drawn around each slot, under the frame artwork (compose.ts). */
export const SLOT_PADDING = 8

type Canvas = HTMLCanvasElement

function makeCanvas( width: number, height: number ): Canvas {
  const canvas = document.createElement( 'canvas' )
  canvas.width = width
  canvas.height = height

  return canvas
}

function context2d( canvas: Canvas, readback = false ): CanvasRenderingContext2D {
  const context = canvas.getContext( '2d', readback ? { willReadFrequently : true } : undefined )
  if ( !context ) throw new Error( 'Canvas unavailable' )

  return context
}

function canvasToBlob( canvas: Canvas, type: string, quality?: number ): Promise<Blob> {
  return new Promise( ( resolve, reject ) => {
    canvas.toBlob(
      ( blob ) => ( blob ? resolve( blob ) : reject( new Error( 'Could not encode image' ) ) ),
      type,
      quality,
    )
  } )
}

// ── Frame artwork ───────────────────────────────────────────────────

type FrameArt = {
  /** Artwork with its green windows cleared, at the frame's own size. */
  overlay: Canvas
  overlayUrl: string
  previewUrl: string
}

const artCache = new Map<string, Promise<FrameArt>>()

/**
 * The frame's keyed overlay plus its preview images, built once per frame and
 * artwork URL. A failed load is not cached, so the next caller retries.
 */
export function loadFrameArt( frame: ClientFrame ): Promise<FrameArt> {
  const cacheKey = `${frame.key}|${frame.publicUrl}`
  let job = artCache.get( cacheKey )
  if ( !job ) {
    job = buildFrameArt( frame ).catch( ( err ) => {
      artCache.delete( cacheKey )
      throw err
    } )
    artCache.set( cacheKey, job )
  }

  return job
}

async function buildFrameArt( frame: ClientFrame ): Promise<FrameArt> {
  const bitmap = await createImageBitmap( await fetchBinary( frame.publicUrl ) )
  const overlay = makeCanvas( bitmap.width, bitmap.height )
  const context = context2d( overlay, true )
  context.drawImage( bitmap, 0, 0 )
  bitmap.close()

  const pixels = context.getImageData( 0, 0, overlay.width, overlay.height )
  clearGreenPixels( pixels.data, pixels.width, pixels.height, 4 )
  context.putImageData( pixels, 0, 0 )

  const overlayUrl = URL.createObjectURL( await canvasToBlob( overlay, 'image/png' ) )
  const previewUrl = URL.createObjectURL( await canvasToBlob( drawPreview( frame, overlay ), 'image/png' ) )

  return { overlay, overlayUrl, previewUrl }
}

/** Swatches for the numbered slot previews (the preview route's palette). */
const PREVIEW_SWATCHES = [
  { bg : '#EB4C4C', text : '#ffffff' },
  { bg : '#FF7070', text : '#ffffff' },
  { bg : '#FFA6A6', text : '#3b1515' },
  { bg : '#FFEDC7', text : '#3b1515' },
]

/** The frame with each window filled by a numbered colour block. */
function drawPreview( frame: ClientFrame, overlay: Canvas ): Canvas {
  const canvas = makeCanvas( overlay.width, overlay.height )
  const context = context2d( canvas )
  context.fillStyle = '#ffffff'
  context.fillRect( 0, 0, canvas.width, canvas.height )

  frame.slots.forEach( ( slot, i ) => {
    const swatch = PREVIEW_SWATCHES[i % PREVIEW_SWATCHES.length]
    const x = slot.left - SLOT_PADDING
    const y = slot.top - SLOT_PADDING
    const w = slot.width + SLOT_PADDING * 2
    const h = slot.height + SLOT_PADDING * 2
    context.fillStyle = swatch.bg
    context.fillRect( x, y, w, h )

    const fontSize = Math.max( 12, Math.floor( Math.min( slot.width, slot.height ) * 0.4 ) )
    context.fillStyle = swatch.text
    context.font = `bold ${fontSize}px sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText( String( i + 1 ), x + w / 2, y + h * 0.54 )
  } )

  context.drawImage( overlay, 0, 0 )

  return canvas
}

// ── Slot colour filters ─────────────────────────────────────────────

/** compose.ts's sharp `recomb` matrices, row-major RGB. */
const FILTER_MATRICES: Record<string, number[]> = {
  sepia   : [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131],
  warm    : [1.1, 0, 0, 0, 1.0, 0, 0, 0, 0.9],
  cool    : [0.9, 0, 0, 0, 1.0, 0, 0, 0, 1.15],
  vintage : [0.95, 0.05, 0, 0, 0.9, 0.1, 0.05, 0, 0.85],
}

const clamp = ( v: number ) => ( v < 0 ? 0 : v > 255 ? 255 : v )

/** Apply a slot's colour filter to pixels in place (no-op for `none`). */
export function applySlotFilter( data: Uint8ClampedArray, filter: string ): void {
  if ( filter === 'grayscale' ) {
    for ( let i = 0; i < data.length; i += 4 ) {
      const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
      data[i] = data[i + 1] = data[i + 2] = y
    }

    return
  }

  const m = FILTER_MATRICES[filter]
  if ( !m ) return
  // `vintage` also gets sharp's modulate (brightness ×1.05, saturation ×0.85).
  const vintage = filter === 'vintage'

  for ( let i = 0; i < data.length; i += 4 ) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    let nr = m[0] * r + m[1] * g + m[2] * b
    let ng = m[3] * r + m[4] * g + m[5] * b
    let nb = m[6] * r + m[7] * g + m[8] * b
    if ( vintage ) {
      const y = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb
      nr = ( y + ( nr - y ) * 0.85 ) * 1.05
      ng = ( y + ( ng - y ) * 0.85 ) * 1.05
      nb = ( y + ( nb - y ) * 0.85 ) * 1.05
    }
    data[i] = clamp( nr )
    data[i + 1] = clamp( ng )
    data[i + 2] = clamp( nb )
  }
}

// ── Slot drawing (shared by the strip and the mashup) ──────────────

/**
 * Draw `source` into one slot of `target`, framed exactly as compose.ts does:
 * cover-fit the padded slot box, apply the guest's zoom, crop the box out at
 * their pan offset (frame pixels; white past the edges), then colour-filter.
 * `scratch` is a reusable canvas so a video loop does not allocate per frame.
 */
export function drawSlot(
  target: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  slot: { left: number; top: number; width: number; height: number },
  adjustment: SlotAdjustment | undefined,
  scratch: Canvas,
): void {
  const w = slot.width + SLOT_PADDING * 2
  const h = slot.height + SLOT_PADDING * 2
  const zoom = adjustment?.zoom || 1
  const dx = adjustment?.x || 0
  const dy = adjustment?.y || 0
  const filter = adjustment?.filter || 'none'

  const cover = Math.max( w / sourceWidth, h / sourceHeight )
  const scaledW = Math.round( sourceWidth * cover * zoom )
  const scaledH = Math.round( sourceHeight * cover * zoom )
  const left = ( scaledW - w ) / 2 - dx
  const top = ( scaledH - h ) / 2 - dy

  if ( scratch.width !== w || scratch.height !== h ) {
    scratch.width = w
    scratch.height = h
  }
  const box = context2d( scratch, true )
  box.fillStyle = '#ffffff'
  box.fillRect( 0, 0, w, h )
  box.imageSmoothingQuality = 'high'
  box.drawImage( source, -left, -top, scaledW, scaledH )

  if ( filter !== 'none' ) {
    const pixels = box.getImageData( 0, 0, w, h )
    applySlotFilter( pixels.data, filter )
    box.putImageData( pixels, 0, 0 )
  }

  target.drawImage( scratch, slot.left - SLOT_PADDING, slot.top - SLOT_PADDING )
}

// ── Strip ───────────────────────────────────────────────────────────

/** Compose the photos into the frame — the device version of composeStrip. */
export async function composeStripLocal(
  frame: ClientFrame,
  photos: Blob[],
  adjustments?: SlotAdjustment[],
): Promise<Blob> {
  const { overlay } = await loadFrameArt( frame )
  const canvas = makeCanvas( overlay.width, overlay.height )
  const context = context2d( canvas )
  context.fillStyle = '#ffffff'
  context.fillRect( 0, 0, canvas.width, canvas.height )

  const scratch = makeCanvas( 1, 1 )
  for ( let i = 0; i < Math.min( photos.length, frame.slots.length ); i++ ) {
    const bitmap = await createImageBitmap( photos[i] )
    drawSlot( context, bitmap, bitmap.width, bitmap.height, frame.slots[i], adjustments?.[i], scratch )
    bitmap.close()
  }

  context.drawImage( overlay, 0, 0 )

  return canvasToBlob( canvas, 'image/jpeg', 0.92 )
}

export { canvasToBlob, context2d, makeCanvas }
