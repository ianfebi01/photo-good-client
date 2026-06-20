import "server-only";

import sharp from "sharp";

import type { FrameSlot } from "./config";

// Slot marker color: #00bf63
const SLOT_R = 0;
const SLOT_G = 191;
const SLOT_B = 99;
// Squared Euclidean threshold — distance from the marker color counted as a slot
const SLOT_THRESHOLD_SQ = 60 * 60;
// How many pixels to expand the cleared region by — raise to eat more green fringe
const DILATE_PX = 1;

export function isGreen( r: number, g: number, b: number ): boolean {
  const dr = r - SLOT_R;
  const dg = g - SLOT_G;
  const db = b - SLOT_B;

  return ( dr * dr + dg * dg + db * db ) < SLOT_THRESHOLD_SQ;
}

/**
 * Make every slot-marker pixel transparent (alpha=0), then dilate the cleared
 * region by `DILATE_PX` so anti-aliased green fringe along slot edges is also
 * removed. Uses a separable box-dilation (horizontal then vertical pass) so the
 * cost stays O(width*height*radius). Mutates `pixels` in place. PNG only.
 */
export function clearGreenPixels(
  pixels: Buffer,
  width: number,
  height: number,
  channels: number,
): void {
  const mask = new Uint8Array( width * height );
  for ( let p = 0; p < width * height; p++ ) {
    const i = p * channels;
    if ( isGreen( pixels[i], pixels[i + 1], pixels[i + 2] ) ) mask[p] = 1;
  }

  const r = DILATE_PX;
  if ( r > 0 ) {
    // Horizontal pass: a pixel is set if any pixel within r columns is set
    const hPass = new Uint8Array( width * height );
    for ( let y = 0; y < height; y++ ) {
      const row = y * width;
      for ( let x = 0; x < width; x++ ) {
        const lo = Math.max( 0, x - r );
        const hi = Math.min( width - 1, x + r );
        let hit = 0;
        for ( let xx = lo; xx <= hi; xx++ ) {
          if ( mask[row + xx] === 1 ) {
            hit = 1;
            break;
          }
        }
        hPass[row + x] = hit;
      }
    }

    // Vertical pass over the horizontal result → full box dilation
    for ( let y = 0; y < height; y++ ) {
      for ( let x = 0; x < width; x++ ) {
        const lo = Math.max( 0, y - r );
        const hi = Math.min( height - 1, y + r );
        let hit = 0;
        for ( let yy = lo; yy <= hi; yy++ ) {
          if ( hPass[yy * width + x] === 1 ) {
            hit = 1;
            break;
          }
        }
        if ( hit ) mask[y * width + x] = 1;
      }
    }
  }

  for ( let p = 0; p < width * height; p++ ) {
    if ( mask[p] === 1 ) pixels[p * channels + 3] = 0;
  }
}

export type DetectResult = {
  width: number;
  height: number;
  slots: FrameSlot[];
};

/**
 * Scan an image for vertically-stacked green panels and return each one's
 * pixel bounding box (left/top/width/height). Bands are found by counting
 * green pixels per row, then per column within each band. `rowMinPixels` and
 * `colMinPixels` filter out noise from anti-aliased edges and stray pixels.
 */
export async function detectGreenSlots(
  imageBuffer: Buffer,
  opts: { rowMinPixels?: number; colMinPixels?: number } = {},
): Promise<DetectResult> {
  const { data, info } = await sharp( imageBuffer )
    .ensureAlpha()
    .raw()
    .toBuffer( { resolveWithObject : true } );

  const { width, height, channels } = info;
  const rowMin = opts.rowMinPixels ?? Math.max( 30, Math.floor( width * 0.08 ) );
  const colMin = opts.colMinPixels ?? Math.max( 5, Math.floor( height * 0.01 ) );

  const rowCount = new Array<number>( height ).fill( 0 );
  for ( let y = 0; y < height; y++ ) {
    let count = 0;
    const rowStart = y * width * channels;
    for ( let x = 0; x < width; x++ ) {
      const i = rowStart + x * channels;
      if ( isGreen( data[i], data[i + 1], data[i + 2] ) ) count++;
    }
    rowCount[y] = count;
  }

  const bands: Array<[number, number]> = [];
  let start = -1;
  for ( let y = 0; y < height; y++ ) {
    if ( rowCount[y] > rowMin ) {
      if ( start === -1 ) start = y;
    } else if ( start !== -1 ) {
      bands.push( [start, y - 1] );
      start = -1;
    }
  }
  if ( start !== -1 ) bands.push( [start, height - 1] );

  const slots: FrameSlot[] = [];

  for ( const [top, bottom] of bands ) {
    const colCount = new Array<number>( width ).fill( 0 );
    for ( let x = 0; x < width; x++ ) {
      let count = 0;
      for ( let y = top; y <= bottom; y++ ) {
        const i = ( y * width + x ) * channels;
        if ( isGreen( data[i], data[i + 1], data[i + 2] ) ) count++;
      }
      colCount[x] = count;
    }

    let left = -1;
    for ( let x = 0; x < width; x++ ) {
      if ( colCount[x] > colMin ) {
        if ( left === -1 ) left = x;
      } else if ( left !== -1 ) {
        slots.push( {
          left,
          top,
          width  : x - left,
          height : bottom - top + 1,
        } );
        left = -1;
      }
    }
    if ( left !== -1 ) {
      slots.push( {
        left,
        top,
        width  : width - left,
        height : bottom - top + 1,
      } );
    }
  }

  const validSlots = slots.filter( ( s ) => s.left >= 0 && s.width > 10 && s.height > 10 );

  // Sort slots vertically (column-major order)
  // If difference in 'left' is significant (> 5% of width), they belong to different columns
  validSlots.sort( ( a, b ) => {
    if ( Math.abs( a.left - b.left ) > width * 0.05 ) {
      return a.left - b.left;
    }
    
    return a.top - b.top;
  } );

  return { width, height, slots : validSlots };
}
